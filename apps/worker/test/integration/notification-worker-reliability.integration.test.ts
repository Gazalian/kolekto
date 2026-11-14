/**
 * notification-worker-reliability.integration.test.ts — M13.2 Phase 8: F-13, F-14 and F-15, against the
 * REAL worker process (the esbuild bundle of src/index.ts, as the least-privilege role), observed only
 * from outside: the database, its logs and Mailpit.
 *
 *   F-13  Read from the catalog and proved by refusal. EXPLAIN is used for the refusals because it plans
 *         a statement without running it, so no HTTP request can result even if a privilege were present.
 *   F-14  Real locks held by this test: a queue-message lock, an event key, the reservation's advisory
 *         lock, and a delivery row after the provider call.
 *   F-15  Real, persistent failures: the worker role really loses DELETE on the queue, or INSERT on the
 *         archive, for the length of the test (withWorkerPrivilegeRevoked), and gets it back.
 *   R-1   The same for what processing itself needs: the role loses INSERT on notification_events.
 *
 * Wall-clock time is real, because the 30 s visibility timeout is a constant: about 14 minutes. Two tests
 * send, one message each, so the file costs 2 grants. Everything else leaves the pause switch off.
 *
 * Integration lane only: `npm run test:integration -- --worker-reliability`. See README.md.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { buildEmailMessage } from "../../src/notification-send-message.ts";
import { eventKey } from "../../src/notification-rules.ts";
import { MAX_READ_CT } from "../../src/dead-letter.ts";
import { FAULT_CODE_HEADER, FAULT_READS_HEADER, PARK_READ_CT, PARKED_REASON_HEADER, PROCESSED_HEADER } from "../../src/queue-disposition.ts";

import { connectAsWorkerRole, connectVerified, liveGateDeps, WORKER_DB_ROLE, type ItestSql, type ItestTx } from "../support/itest-db.ts";
import { refuse, type Secret } from "../support/itest-environment.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import { createCommunityFixture, createFileHarness, HEARTBEAT_SQL, type CommunityFixture } from "../support/itest-isolation.ts";
import { assertNoMessageTo, expectedMessageId, findExactMessages, selectExactlyOne } from "../support/itest-mailpit.ts";
import { releaseParkedOwnMessage } from "../support/itest-queue-release.ts";
import { seedOwnQueueMessage } from "../support/itest-queue-seed.ts";
import { findOwnQueueMessages, readQueueState, waitForOwnQueueMessage, type OwnedQueueMessage } from "../support/itest-queue.ts";
import { startFaultProxy } from "../support/itest-smtp-fault-proxy.ts";
import { readPauseSwitchIndependently, withSendingEnabled, type SwitchContext } from "../support/itest-switch.ts";
import {
  assertWorkerRole,
  awaitBlockedWorker,
  awaitWorkerSession,
  buildWorkerBundle,
  createEvidenceSink,
  issueWorkerCredential,
  killLeftoverWorkers,
  readWorkerSessions,
  revokeWorkerCredential,
  startWorker,
  withWorkerPrivilegeRevoked,
  type EvidenceSink,
  type WorkerBundle,
  type WorkerHandle,
  type WorkerOptions,
} from "../support/itest-worker.ts";

const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "worker-reliability");
const { scope } = harness;

const mailpitApi = () => gate.verified().mailpitApi.origin;

let admin: ItestSql;
let bundle: WorkerBundle;
let credential: Secret;
let evidence: EvidenceSink;
let phoneCounter = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(label: string, read: () => Promise<T | null | false | undefined>, timeoutMs = 30_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw refuse("WORKER_TIMEOUT", `Timed out after ${timeoutMs} ms waiting for: ${label}.`);
    await sleep(intervalMs);
  }
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

const runSecrets = () => [credential, gate.verified().db.password, gate.verified().stackId];

/** The Phase 7 guard, unchanged: the real worker's maintenance would delete these rows. */
async function assertNoLedgerPurgeEligible(): Promise<void> {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from public.notification_send_attempts where attempted_at < now() - interval '48 hours'`;
  if (row?.n !== 0) throw refuse("LEDGER_PURGE_ELIGIBLE", `${String(row?.n)} ledger row(s) are older than 48 h; the real worker's maintenance would delete them. Not starting it.`);
}

function normalWorker(extra: Omit<WorkerOptions, "database"> = {}): WorkerOptions {
  return { database: { kind: "verified", password: credential }, ...extra };
}

async function withWorker<T>(label: string, options: WorkerOptions, fn: (worker: WorkerHandle) => Promise<T>): Promise<T> {
  await assertNoLedgerPurgeEligible();
  const worker = startWorker(bundle, gate.verified(), options);
  let failed = true;
  try {
    await awaitWorkerSession(admin, worker);
    await worker.waitForOutput(/Kolekto worker: connected/, 15_000);
    const result = await fn(worker);
    failed = false;
    return result;
  } finally {
    if (worker.alive()) {
      if (failed) await worker.kill();
      else {
        const exit = await worker.stop();
        assert.equal(exit.code, 0, `${label}: the worker exits 0 on a graceful stop`);
      }
    }
    evidence.storeWorkerLog(label, worker, runSecrets());
    const remotes = worker.remoteAddresses();
    evidence.reading(`${label} remote addresses`, remotes);
    if (remotes !== null) for (const remote of remotes) assert.equal(remote, "127.0.0.1", `${label}: the worker connected only to loopback`);
    await until("no worker session left", async () => (await readWorkerSessions(admin)).length === 0, 10_000);
    for (const line of worker.linesFor("notification_send_health")) assert.equal(line["purged_this_tick"], 0, "maintenance purged no ledger row");
  }
}

// ── Domain action, reads ──────────────────────────────────────────────────────

async function asUser<T>(userId: string, fn: (tx: ItestTx) => Promise<T>): Promise<T> {
  return (await admin.begin(async (raw) => {
    const tx = raw as unknown as ItestTx;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx`set local role authenticated`;
    return fn(tx);
  })) as T;
}

const newCommunity = (): Promise<CommunityFixture> => createCommunityFixture(admin, harness, { ownerName: "Reliability Owner", communityName: "Worker Reliability Test", ownerTerm: true });

function runScopedPhone(): string {
  phoneCounter += 1;
  return `+23481${String(Number.parseInt(scope.runTag.slice(0, 5), 16) % 10_000).padStart(4, "0")}${String(phoneCounter).padStart(4, "0")}`;
}

interface NewMember {
  readonly memberId: string;
  readonly to: string;
  readonly queued: OwnedQueueMessage;
}

async function createMember(c: CommunityFixture): Promise<NewMember> {
  const to = scope.address();
  const memberId = await asUser(c.ownerId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      select app.create_member(${c.communityId}::uuid, ${`Member ${scope.runTag} ${randomBytes(4).toString("hex")}`}::text, ${runScopedPhone()}::text, ${to}::extensions.citext)::text as id`;
    return row!.id;
  });
  const queued = await waitForOwnQueueMessage(admin, harness.testOwner, c.communityId);
  return { memberId, to, queued };
}

async function emailRows(communityId: string) {
  return admin<{ id: string; status: string; attempt_count: number; provider_message_id: string | null; lease_held: boolean }[]>`
    select id::text as id, status::text as status, attempt_count, provider_message_id, (send_lease_token is not null) as lease_held
    from public.notification_deliveries where community_id = ${communityId}::uuid and channel = 'email'`;
}

async function eventCount(communityId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from public.notification_events where community_id = ${communityId}::uuid`;
  return row!.n;
}

async function ledgerCount(communityId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from public.notification_send_attempts where community_id = ${communityId}::uuid`;
  return row!.n;
}

async function archiveCount(): Promise<number> {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from pgmq.a_notification_events`;
  return row!.n;
}

interface QueueRow {
  read_ct: number;
  visible_in_s: number;
  message: Record<string, unknown>;
  headers: Record<string, unknown> | null;
}

async function queueRow(msgId: string): Promise<QueueRow | null> {
  const [row] = await admin<QueueRow[]>`
    select read_ct, extract(epoch from vt - clock_timestamp())::float8 as visible_in_s, message, headers
    from pgmq.q_notification_events where msg_id = ${msgId}::bigint`;
  return row ?? null;
}

const queueEmpty = async () => {
  const state = await readQueueState(admin);
  return state.queued === 0 && state.readMessages === 0;
};

const heartbeat = async () => (await admin<{ at: string | null }[]>`select last_heartbeat_at::text as at from public.notification_sender_state`)[0]?.at ?? null;

const failedLine = (msgId: string, readCt: number) => new RegExp(`Failed to process message ${msgId} \\(read_ct=${readCt}\\): (.*)`);

/** Only the safe summary reaches the log: a name, a code and a severity. */
function assertSanitised(summary: unknown, code: string): void {
  assert.deepEqual(summary, { name: "PostgresError", code, severity: "ERROR" }, "the failure is reported with these fields and no others");
}

/** A message is parked when a read cannot reach it for years. */
function assertParked(row: QueueRow | null, reason: string): void {
  assert.ok(row !== null, "the message is still in the queue table: nothing was deleted");
  assert.ok(row.visible_in_s > 365 * 86_400, `not visible for at least a year (got ${row.visible_in_s} s)`);
  assert.equal(row.headers?.[PARKED_REASON_HEADER], reason, "the reason is durable, in the row itself");
}

// ── Locks, held by this test, always rolled back ──────────────────────────────

class ReleaseGate extends Error {}

async function holdInTransaction(fn: (tx: ItestTx) => Promise<unknown>): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  const isReady = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const done = admin
    .begin(async (raw) => {
      await fn(raw as unknown as ItestTx);
      ready();
      await released;
      throw new ReleaseGate();
    })
    .catch((error: unknown) => {
      if (!(error instanceof ReleaseGate)) failed(error);
    });
  await isReady;
  let open = true;
  return {
    release: async () => {
      if (!open) return;
      open = false;
      release();
      await done;
    },
  };
}

/** Holds the event row's unique key, uncommitted, so the worker's insert waits. */
function holdEventKey(c: CommunityFixture, member: NewMember) {
  const key = eventKey("member.create", member.memberId);
  return holdInTransaction((tx) => tx`insert into public.notification_events (community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
    values (${c.communityId}::uuid, 'member.create', ${key}, 'officer', ${c.ownerId}::uuid, 'member', ${member.memberId}::uuid, '{}'::jsonb)`);
}

// ── Sending ───────────────────────────────────────────────────────────────────

const switchContext = (): SwitchContext => ({
  env: gate.verified(),
  sql: admin,
  assertMutexHeld: () => harness.assertMutexHeld(),
  ownsCommunity: (id) => scope.owns(id),
});

async function whileSendingEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const result = await withSendingEnabled(switchContext(), fn);
  assert.deepEqual(await readPauseSwitchIndependently(gate.verified()), { rows: 1, column: false, fn: false }, "the switch reads false on a new connection");
  return result;
}

async function mailpitSearchTo(address: string): Promise<unknown> {
  const res = await fetch(`${mailpitApi()}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  assert.equal(res.status, 200, "Mailpit search answered");
  return res.json();
}

async function assertOneCopy(deliveryId: string, to: string, communityId: string): Promise<void> {
  const [event] = await admin<{ payload: Record<string, unknown> }[]>`select payload from public.notification_events where community_id = ${communityId}::uuid`;
  const expected = { to, subject: buildEmailMessage(to, { eventType: "member.create", payload: event!.payload }).subject, messageId: expectedMessageId(deliveryId), runTag: scope.runTag };
  await until("the matching Mailpit message", async () => findExactMessages(await mailpitSearchTo(to), expected).length > 0, 10_000);
  selectExactlyOne(await mailpitSearchTo(to), expected);
}

// ══════════════════════════════════════════════════════════════════════════════

describe("M13.2 Phase 8 — worker reliability", () => {
  before(async () => {
    await gate.verify();
    admin = connectVerified(gate.verified(), { max: 6 });
    // A worker from an earlier run keeps a heartbeat fresh for 60 s. Wait it out, bounded.
    const end = Date.now() + 80_000;
    while (Date.now() < end) {
      const rows = await admin.unsafe<{ fresh: unknown }[]>(HEARTBEAT_SQL);
      if (rows[0]?.fresh !== true) break;
      await sleep(2_000);
    }
    await harness.start();
    await assertWorkerRole(admin);
    assert.equal((await readWorkerSessions(admin)).length, 0, "no worker session exists before the file");
    credential = await issueWorkerCredential(admin);
    bundle = buildWorkerBundle();
    evidence = createEvidenceSink(scope.runTag);
    evidence.reading("bundle", { sha256: bundle.sha256 });
  });

  beforeEach(() => harness.checkpoint());

  afterEach(async () => {
    await killLeftoverWorkers();
    await harness.recoverOwnQueue();
    await harness.quarantineOwn();
  });

  after(async () => {
    try {
      await killLeftoverWorkers();
      if (admin !== undefined) await revokeWorkerCredential(admin);
      await harness.finish();
    } finally {
      await admin?.end({ timeout: 2 }).catch(() => {});
      await gate.postflight();
    }
  });

  // ── F-13 ────────────────────────────────────────────────────────────────────

  it("F-13: nothing broad can reach pg_net's outbound HTTP: the catalog says so, and the worker role is refused", async () => {
    const NET = "(select oid from pg_namespace where nspname = 'net')";
    const matrix = await admin.unsafe<{ rolname: string; schema_usage: boolean; http_functions: boolean; queue_insert: boolean; queue_select: boolean; response_select: boolean; sequence_use: boolean }[]>(
      `select r.rolname, has_schema_privilege(r.oid, ${NET}, 'USAGE') as schema_usage,
              bool_or(has_function_privilege(r.oid, p.oid, 'EXECUTE')) as http_functions,
              has_table_privilege(r.oid, (select oid from pg_class where relnamespace = ${NET} and relname = 'http_request_queue'), 'INSERT') as queue_insert,
              has_table_privilege(r.oid, (select oid from pg_class where relnamespace = ${NET} and relname = 'http_request_queue'), 'SELECT') as queue_select,
              has_table_privilege(r.oid, (select oid from pg_class where relnamespace = ${NET} and relname = '_http_response'), 'SELECT') as response_select,
              has_sequence_privilege(r.oid, (select oid from pg_class where relnamespace = ${NET} and relname = 'http_request_queue_id_seq'), 'USAGE') as sequence_use
       from pg_roles r cross join pg_proc p
       where p.pronamespace = ${NET} and p.proname in ('http_get', 'http_post', 'http_delete')
         and r.rolname in ('${WORKER_DB_ROLE}', 'anon', 'authenticated', 'service_role', 'authenticator', 'kolekto_importer', 'postgres', 'supabase_functions_admin')
       group by r.oid, r.rolname order by r.rolname`,
    );
    evidence.reading("F-13 privilege matrix", matrix);
    assert.equal(matrix.length, 8, "every role was read");
    for (const row of matrix) {
      const { rolname, ...flags } = row;
      if (rolname === "postgres" || rolname === "supabase_functions_admin") {
        assert.equal(flags.schema_usage, true, `${rolname} keeps access: ADR 0005's pg_cron design would run as postgres`);
        assert.equal(flags.http_functions, true, rolname);
        continue;
      }
      assert.deepEqual(Object.values(flags), [false, false, false, false, false, false], `${rolname} has no path at all: ${JSON.stringify(flags)}`);
    }

    const [acl] = await admin.unsafe<{ public_grants: number }[]>(
      `select count(*)::int as public_grants from (
         select nspacl as acl from pg_namespace where oid = ${NET}
         union all select relacl from pg_class where relnamespace = ${NET}
         union all select coalesce(proacl, acldefault('f', proowner)) from pg_proc where pronamespace = ${NET}
       ) a cross join lateral aclexplode(a.acl) x where x.grantee = 0`,
    );
    assert.equal(acl?.public_grants, 0, "no PUBLIC grant remains on the schema, its relations or its functions");

    // EXPLAIN plans without running, so even a missing refusal could not send anything.
    const worker = connectAsWorkerRole(gate.verified(), credential);
    const refused: { statement: string; code: string }[] = [];
    try {
      for (const statement of [
        "explain select net.http_get('http://127.0.0.1:9/')",
        "explain select net.http_post('http://127.0.0.1:9/', '{}'::jsonb)",
        "explain select net.http_delete('http://127.0.0.1:9/')",
        "explain insert into net.http_request_queue (method, url, headers, timeout_milliseconds) values ('GET', 'http://127.0.0.1:9/', '{}', 1)",
        "explain select * from net._http_response",
        "explain select * from net.http_request_queue",
      ]) {
        let code = "ALLOWED";
        try {
          await worker.unsafe(statement);
        } catch (error) {
          code = String((error as { code?: unknown }).code);
        }
        refused.push({ statement, code });
        assert.equal(code, "42501", `${statement} → ${code}`);
      }
    } finally {
      await worker.end({ timeout: 2 }).catch(() => {});
    }
    evidence.reading("F-13 refused", refused);
  });

  // ── F-14 ────────────────────────────────────────────────────────────────────

  it("F14-LOCK: a held lock times out within the limit, is reported safely, leaves the message recoverable and the loop running, and recovery creates no duplicate", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const id = member.queued.msgId;
    const archivedBefore = await archiveCount();
    const lock = await holdEventKey(c, member);
    try {
      await withWorker("f14-lock", normalWorker(), async (worker) => {
        assert.deepEqual(worker.linesFor("worker_database_timeouts"), [{ msg: "worker_database_timeouts", lock_timeout: "5s", statement_timeout: "15s", idle_in_transaction_session_timeout: "30s" }], "the bounds are really applied on the server");

        await awaitBlockedWorker(admin, /notification_events/);
        const blockedAt = Date.now();
        const heartbeatBefore = await heartbeat();

        await worker.waitForOutput(failedLine(id, 1), 9_000);
        const firstMs = Date.now() - blockedAt;
        assert.ok(firstMs <= 7_000, `timed out within the 5 s limit, allowing for log delivery (took ${firstMs} ms)`);
        assert.ok(firstMs >= 3_000, `and not much earlier than it (took ${firstMs} ms)`);
        assertSanitised(JSON.parse(failedLine(id, 1).exec(worker.output())![1]!) as unknown, "55P03");
        assert.ok(worker.alive(), "the worker survives");
        assert.equal((await readWorkerSessions(admin)).filter((s) => s.wait_event_type === "Lock").length, 0, "no session is left waiting");

        const first = await queueRow(id);
        assert.equal(first?.read_ct, 1, "the message remains, with its one read");
        assert.ok(first!.visible_in_s > 20 && first!.visible_in_s <= 30, `hidden for the 30 s backoff (${first!.visible_in_s} s)`);
        assert.equal(await eventCount(c.communityId), 0, "the transaction rolled back: nothing committed");
        assert.equal((await emailRows(c.communityId)).length, 0);

        // The loop is no longer stalled: this is the difference F-14 makes.
        await until("a heartbeat while the lock is still held", async () => (await heartbeat()) !== heartbeatBefore, 10_000);

        // Still held on the next read: it fails again, and the wait doubles rather than using up attempts.
        await worker.waitForOutput(failedLine(id, 2), 45_000);
        const second = await queueRow(id);
        assert.equal(second?.read_ct, 2);
        assert.ok(second!.visible_in_s > 40 && second!.visible_in_s <= 60, `hidden for the 60 s backoff (${second!.visible_in_s} s)`);
        assert.deepEqual(worker.linesFor("notification_event_retry_delayed").map((l) => [l["read_ct"], l["delay_s"]]), [[1, 30], [2, 60]]);

        await lock.release();

        // Recovery, with no restart.
        await until("the message to be processed", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === id), 75_000);
        assert.equal(worker.linesFor("notification_event_processed")[0]!["read_ct"], 3);
        await until("the queue to empty", queueEmpty);
        assert.equal(await eventCount(c.communityId), 1, "one event");
        const rows = await emailRows(c.communityId);
        assert.equal(rows.length, 1, "one delivery");
        assert.equal(rows[0]!.status, "pending");
        assert.equal(await archiveCount(), archivedBefore, "not treated as poison");
        evidence.reading("F14-LOCK", { firstTimeoutMs: firstMs, backoffs: worker.linesFor("notification_event_retry_delayed") });
      });
    } finally {
      await lock.release();
    }
  });

  it("F14-ACK: a lock on the queue row times out the acknowledgement; processing stays committed and the replay creates nothing new", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const id = member.queued.msgId;
    const processing = await holdEventKey(c, member);
    let ack: { release: () => Promise<void> } | null = null;
    try {
      await withWorker("f14-ack", normalWorker(), async (worker) => {
        await awaitBlockedWorker(admin, /notification_events/);
        ack = await holdInTransaction((tx) => tx`select msg_id from pgmq.q_notification_events where msg_id = ${id}::bigint for update`);
        await processing.release();
        await awaitBlockedWorker(admin, /delete/);
        const blockedAt = Date.now();
        assert.equal(await eventCount(c.communityId), 1, "processing committed before the acknowledgement");

        await until("the acknowledgement failure", async () => worker.linesFor("notification_event_ack_failed").some((l) => l["msg_id"] === id), 9_000, 100);
        const ms = Date.now() - blockedAt;
        assert.ok(ms <= 7_000, `within the limit (took ${ms} ms)`);
        const line = worker.linesFor("notification_event_ack_failed")[0]!;
        assert.equal(line["processing"], "committed", "the log says processing is not what failed");
        assertSanitised(line["error"], "55P03");
        assert.doesNotMatch(worker.output(), /Failed to process/, "not reported as a processing failure");

        // The mark needs the same row, so it times out too. That is the path where only idempotency protects us.
        await until("the mark failure", async () => worker.linesFor("notification_event_mark_failed").some((l) => l["msg_id"] === id), 9_000, 100);
        await ack.release();
        ack = null;

        await until("the replay to be acknowledged", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === id), 45_000);
        assert.equal(worker.linesFor("notification_event_processed")[0]!["read_ct"], 2, "completed on the next read");
        await until("the queue to empty", queueEmpty);
        assert.equal(await eventCount(c.communityId), 1, "replay: one event");
        assert.equal((await emailRows(c.communityId)).length, 1, "replay: one delivery");
        evidence.reading("F14-ACK", { ackTimeoutMs: ms });
      });
    } finally {
      await processing.release();
      if (ack !== null) await (ack as { release: () => Promise<void> }).release();
    }
  });

  it("F14-SEND: a lock during reservation times out and rolls back the claim: no attempt used, no grant, no mail; then exactly one send", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    // The platform-wide reservation lock (app.reserve_email_attempt's third key). Held by this session only.
    const lock = await holdInTransaction((tx) => tx`select pg_advisory_xact_lock(3, 0)`);
    try {
      await whileSendingEnabled(() => withWorker("f14-send", normalWorker(), async (worker) => {
        await awaitBlockedWorker(admin, /reserve_email_attempt/);
        const blockedAt = Date.now();
        await worker.waitForOutput(/Sender tick error: .*"55P03"/, 9_000);
        const ms = Date.now() - blockedAt;
        assert.ok(ms <= 7_000, `within the limit (took ${ms} ms)`);

        const [held] = await emailRows(c.communityId);
        assert.deepEqual({ status: held!.status, attempts: held!.attempt_count, lease: held!.lease_held }, { status: "pending", attempts: 0, lease: false }, "the claim rolled back with the reservation");
        assert.equal(await ledgerCount(c.communityId), 0, "no grant was consumed");
        assertNoMessageTo(await mailpitSearchTo(member.to), member.to, scope.runTag);
        assert.ok(worker.alive());

        await lock.release();

        const sent = await until("the delivery to be sent", async () => {
          const [row] = await emailRows(c.communityId);
          return row?.status === "sent" ? row : null;
        }, 30_000);
        assert.equal(sent.attempt_count, 1, "the timed-out attempts cost nothing");
        assert.equal(await ledgerCount(c.communityId), 1, "one grant");
        await assertOneCopy(sent.id, member.to, c.communityId);
        evidence.reading("F14-SEND", { lockTimeoutMs: ms, deliveryId: sent.id, attempts: sent.attempt_count });
      }));
    } finally {
      await lock.release();
    }
  });

  it("F14-SETTLE: a lock on the delivery after the provider accepted is retried, so a known outcome is recorded and nothing is sent twice", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const proxy = await startFaultProxy(gate.verified(), { kind: "hold-until-released" });
    let lock: { release: () => Promise<void> } | null = null;
    try {
      await whileSendingEnabled(() => withWorker("f14-settle", normalWorker({ smtpPort: proxy.port }), async (worker) => {
        await until("the provider call to be in progress", async () => proxy.connections()[0]?.verbs.includes("DATA"), 30_000, 50);
        const [sending] = await emailRows(c.communityId);
        assert.equal(sending?.status, "sending");
        lock = await holdInTransaction((tx) => tx`select id from public.notification_deliveries where id = ${sending!.id}::uuid for update`);
        proxy.release();

        await awaitBlockedWorker(admin, /resolve_notification_claim/);
        await until("the settle retry", async () => worker.linesFor("notification_delivery_settle_retry").length > 0, 9_000, 100);
        const retry = worker.linesFor("notification_delivery_settle_retry")[0]!;
        assert.equal(retry["attempt"], 1);
        assertSanitised(retry["error"], "55P03");

        await (lock as { release: () => Promise<void> }).release();
        lock = null;

        const sent = await until("the outcome to be recorded", async () => {
          const [row] = await emailRows(c.communityId);
          return row?.status === "sent" ? row : null;
        }, 20_000);
        assert.equal(sent.attempt_count, 1, "no second attempt");
        assert.equal(sent.provider_message_id, expectedMessageId(sent.id));
        assert.equal(proxy.connections().length, 1, "one connection to the provider");
        assert.equal(await ledgerCount(c.communityId), 1, "one grant");
        await assertOneCopy(sent.id, member.to, c.communityId);
        evidence.reading("F14-SETTLE", { deliveryId: sent.id, retries: worker.linesFor("notification_delivery_settle_retry").length });
      }));
    } finally {
      if (lock !== null) await (lock as { release: () => Promise<void> }).release();
      await proxy.close();
    }
  });

  // ── F-15 ────────────────────────────────────────────────────────────────────

  it("F15-ACK: a delete that keeps failing is not poison: never reprocessed, even after a restart, parked at the bound, then released and acknowledged once", async () => {
    const c = await newCommunity();
    const archivedBefore = await archiveCount();
    const { member } = await withWorkerPrivilegeRevoked(admin, "queue-delete", async () => {
      const created = await createMember(c);
      const id = created.queued.msgId;

      await withWorker("f15-ack-first", normalWorker(), async (worker) => {
        await until("the first acknowledgement failure", async () => worker.linesFor("notification_event_ack_failed").some((l) => l["read_ct"] === 1), 30_000);
        const first = worker.linesFor("notification_event_ack_failed")[0]!;
        assert.equal(first["processing"], "committed");
        assertSanitised(first["error"], "42501");
        await until("the durable mark", async () => typeof (await queueRow(id))?.headers?.[PROCESSED_HEADER] === "string", 5_000);
        assert.equal(await eventCount(c.communityId), 1);
        assert.equal((await emailRows(c.communityId)).length, 1);
        await until("the next read to only retry the delete", async () => worker.linesFor("notification_event_ack_failed").some((l) => l["read_ct"] === 2 && l["processing"] === "committed_earlier"), 45_000);
        assert.doesNotMatch(worker.output(), /Failed to process/, "not a processing failure");
        assert.equal(worker.linesFor("notification_event_processed").length, 0, "a processed line would mean the message is gone");
      });

      // The mark lives in the row, so a new process does not reprocess or dead-letter the message.
      await withWorker("f15-ack-restarted", normalWorker(), async (worker) => {
        await until("the message to be parked", async () => worker.linesFor("notification_event_parked").some((l) => l["msg_id"] === id), 240_000, 500);
        const parked = worker.linesFor("notification_event_parked")[0]!;
        assert.deepEqual([parked["reason"], parked["read_ct"]], ["ack_failed", PARK_READ_CT]);
        const row = await queueRow(id);
        assertParked(row, "ack_failed");
        assert.equal(row!.read_ct, PARK_READ_CT);
        assert.doesNotMatch(worker.output(), /Dead-lettering/, "past the poison threshold, and still not treated as poison");
        assert.doesNotMatch(worker.output(), /Failed to process/);
        assert.equal(worker.linesFor("notification_event_processed").length, 0, "never reprocessed");
        assert.equal(await archiveCount(), archivedBefore, "not archived");

        // Bounded: no more reads, past a whole visibility timeout.
        await sleep(35_000);
        assert.equal((await queueRow(id))?.read_ct, PARK_READ_CT, "not read again");
        assert.ok(worker.alive());
        await until("the health line to show it", async () => worker.linesFor("notification_event_health").some((l) => l["queue_parked"] === 1 && l["parked_total"] === 1), 70_000);
      });
      return { member: created };
    });

    // The privilege is back. The operator releases the message; a running worker finishes it.
    await withWorker("f15-ack-released", normalWorker(), async (worker) => {
      const [own] = await findOwnQueueMessages(admin, harness.testOwner, [c.communityId]);
      assert.equal(own?.msgId, member.queued.msgId);
      await releaseParkedOwnMessage(admin, harness.testOwner, own!);
      await until("the acknowledgement to complete", async () => worker.linesFor("notification_event_ack_recovered").some((l) => l["msg_id"] === member.queued.msgId), 15_000);
      await until("the queue to empty", queueEmpty);
      assert.equal(worker.linesFor("notification_event_processed").length, 0, "still not reprocessed");
      assert.equal(await eventCount(c.communityId), 1, "one event");
      const rows = await emailRows(c.communityId);
      assert.deepEqual(rows.map((r) => r.status), ["pending"], "one delivery");
      assert.equal(await archiveCount(), archivedBefore, "deleted as acknowledged: this message was never poison");
      evidence.reading("F15-ACK", { msgId: member.queued.msgId, recovered: worker.linesFor("notification_event_ack_recovered") });
    });
  });

  it("F15-ARCHIVE: a poison message whose archive keeps failing is parked at the bound, kept intact, not counted as dead-lettered, then released and archived", async () => {
    const c = await newCommunity();
    const healthy = await createMember(c);
    const objectId = scope.uuid();
    // The invalid actor type fails the enum cast, and Postgres quotes it in its error message.
    const sentinel = `p@${scope.runTag.slice(0, 6)}.test`;
    const poisonBody = {
      audit_log_id: scope.uuid(), community_id: c.communityId, action: "collection.publish", actor_type: sentinel, actor_user_id: null, actor_name: "",
      object_type: "collection", object_id: objectId, after_state: null, before_state: null, created_at: new Date().toISOString(),
    };
    const archivedBefore = await archiveCount();
    const poison = await seedOwnQueueMessage(admin, harness.testOwner, poisonBody);

    await withWorkerPrivilegeRevoked(admin, "archive-insert", () => withWorker("f15-archive", normalWorker(), async (worker) => {
      assert.ok(((worker.linesFor("worker_privileges_degraded")[0]?.["degraded"] ?? []) as string[]).includes("INSERT on pgmq.a_notification_events"), "the start reports the gap and carries on");
      await until("the healthy message to be processed", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === healthy.queued.msgId));
      await until("the poison message to be parked", async () => worker.linesFor("notification_event_parked").some((l) => l["msg_id"] === poison), 330_000, 500);

      const output = worker.output();
      const attempts = [...output.matchAll(new RegExp(`Failed to process message ${poison} \\(read_ct=(\\d+)\\)`, "g"))].map((m) => Number(m[1]));
      assert.deepEqual(attempts, [1, 2, 3, 4, 5], "ordinary poison handling is unchanged: five processing attempts");
      const moves = [...output.matchAll(new RegExp(`Dead-lettering message ${poison}: read_ct=(\\d+)`, "g"))].map((m) => Number(m[1]));
      assert.deepEqual(moves, [MAX_READ_CT + 1, MAX_READ_CT + 2, PARK_READ_CT], "three attempts to move it");
      const failures = worker.linesFor("notification_event_archive_failed").filter((l) => l["msg_id"] === poison);
      assert.deepEqual(failures.map((l) => l["read_ct"]), moves);
      for (const failure of failures) assertSanitised(failure["error"], "42501");
      assert.ok(!output.includes(sentinel), "the value Postgres quoted in its error is not in the log");

      const parked = worker.linesFor("notification_event_parked")[0]!;
      assert.deepEqual([parked["reason"], parked["read_ct"]], ["archive_failed", PARK_READ_CT]);
      const row = await queueRow(poison);
      assertParked(row, "archive_failed");
      assert.deepEqual(row!.message, poisonBody, "the message is intact: recoverable, not hidden by a delete");
      assert.equal(await archiveCount(), archivedBefore, "the archive really did not receive it");

      await sleep(35_000);
      assert.equal((await queueRow(poison))?.read_ct, PARK_READ_CT, "no retry past the bound");
      assert.ok(worker.alive(), "the worker keeps serving other messages");

      const line = await until("the health line to show it", async () => worker.linesFor("notification_event_health").find((l) => l["queue_parked"] === 1 && l["parked_total"] === 1), 70_000);
      assert.equal(line["dead_lettered_total"], 0, "a failed move is never reported as dead-lettered");
      assert.equal(line["archive_failures_total"], 3);
      assert.equal(line["failed_total"], 5);
    }));

    await withWorker("f15-archive-released", normalWorker(), async (worker) => {
      const owned = await findOwnQueueMessages(admin, harness.testOwner, [c.communityId]);
      const own = owned.find((m) => m.msgId === poison);
      assert.ok(own !== undefined);
      await releaseParkedOwnMessage(admin, harness.testOwner, own);
      await until("the archive to succeed", async () => (await queueRow(poison)) === null, 15_000);
      await until("the queue to empty", queueEmpty);
      const [archived] = await admin<{ read_ct: number; headers: Record<string, unknown> | null }[]>`
        select read_ct, headers from pgmq.a_notification_events where msg_id = ${poison}::bigint`;
      assert.equal(archived?.read_ct, PARK_READ_CT + 1, "one more attempt, on release");
      assert.equal(archived?.headers?.[PARKED_REASON_HEADER], "archive_failed", "its history moves with it");
      assert.equal(await archiveCount(), archivedBefore + 1, "archived exactly once");
      const [created] = await admin<{ n: number }[]>`select count(*)::int as n from public.notification_events where object_id = ${objectId}::uuid`;
      assert.equal(created?.n, 0, "the poison message created nothing");
      assert.deepEqual((await emailRows(c.communityId)).map((r) => r.status), ["pending"], "the healthy message's delivery is intact");
      const line = await until("the health line to count the dead letter", async () => worker.linesFor("notification_event_health").find((l) => l["dead_lettered_total"] === 1), 70_000);
      evidence.reading("F15-ARCHIVE", { poison, archivedReadCt: archived?.read_ct, deadLettered: line["dead_lettered_total"] });
    });
  });

  // ── R-1 ─────────────────────────────────────────────────────────────────────

  it("R1-FAULT: a privilege lost while running stops the worker non-zero; the healthy message is not dead-lettered; a restart reads nothing; once fixed it is processed exactly once", async () => {
    const c = await newCommunity();
    const archivedBefore = await archiveCount();
    await assertNoLedgerPurgeEligible();

    // Started with every privilege, so it gets past the preflight. The privilege goes before there is anything to read.
    const running = startWorker(bundle, gate.verified(), normalWorker());
    await awaitWorkerSession(admin, running);
    await running.waitForOutput(/Kolekto worker: connected/, 15_000);

    const member = await withWorkerPrivilegeRevoked(admin, "events-insert", async () => {
      const created = await createMember(c);
      const id = created.queued.msgId;

      const exit = await Promise.race([
        running.exited(),
        sleep(30_000).then(() => { throw refuse("WORKER_TIMEOUT", "The worker kept running without the privilege to process."); }),
      ]);
      evidence.storeWorkerLog("r1-fault-first", running, runSecrets());
      assert.equal(exit.code, 1, "non-zero exit, so a supervisor's crash-loop limit can fire");

      const fault = running.linesFor("notification_event_worker_fault");
      assert.equal(fault.length, 1);
      assert.deepEqual([fault[0]!["msg_id"], fault[0]!["read_ct"], fault[0]!["stage"]], [id, 1, "process"]);
      assertSanitised(fault[0]!["error"], "42501");
      assert.doesNotMatch(running.output(), /Dead-lettering/);
      assert.doesNotMatch(running.output(), /Failed to process/, "not reported as the message's failure");

      const row = await queueRow(id);
      assert.equal(row?.read_ct, 1, "the message is still in the queue");
      assert.equal(row?.headers?.[FAULT_READS_HEADER], 1, "the read is recorded durably, in the row");
      assert.equal(row?.headers?.[FAULT_CODE_HEADER], "42501", "and so is the cause");
      assert.equal(await eventCount(c.communityId), 0);
      assert.equal(await archiveCount(), archivedBefore, "not archived");

      // A supervisor restarts it. The preflight refuses before the first read, so read_ct cannot climb.
      const restarted = startWorker(bundle, gate.verified(), normalWorker());
      const second = await Promise.race([
        restarted.exited(),
        sleep(30_000).then(() => { throw refuse("WORKER_TIMEOUT", "The restarted worker did not refuse."); }),
      ]);
      evidence.storeWorkerLog("r1-fault-restart", restarted, runSecrets());
      assert.equal(second.code, 1);
      const [refusal] = restarted.linesFor("worker_privileges_refused");
      assert.ok(refusal !== undefined, "the refusal is explicit");
      assert.equal(refusal["queue_read"], false);
      assert.ok((refusal["missing"] as string[]).includes("INSERT on public.notification_events"), "and says which privilege");
      assert.doesNotMatch(restarted.output(), /connected\. Polling/);
      assert.equal((await queueRow(id))?.read_ct, 1, "the restart did not read the message");
      return created;
    });

    // The privilege is back. No release, no replay: the same message comes back at its visibility timeout.
    await withWorker("r1-fault-recovered", normalWorker(), async (worker) => {
      await until("the message to be processed", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === member.queued.msgId), 45_000);
      await until("the queue to empty", queueEmpty);
      assert.equal(worker.linesFor("notification_event_processed")[0]!["read_ct"], 2);
      assert.equal(await eventCount(c.communityId), 1, "one event");
      assert.deepEqual((await emailRows(c.communityId)).map((r) => r.status), ["pending"], "one delivery, and the switch stayed off");
      assert.equal(await archiveCount(), archivedBefore, "deleted as processed: this message was never poison");
      assert.doesNotMatch(worker.output(), /Dead-lettering/);
      evidence.reading("R1-FAULT", { msgId: member.queued.msgId });
    });
  });
});
