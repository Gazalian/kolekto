/**
 * notification-worker-runtime.integration.test.ts — M13.2 Phase 7: the REAL worker process.
 *
 * Every other integration file calls the processor and sender functions directly. This one runs the
 * built esbuild bundle of src/index.ts as a child process, connected as the least-privilege role
 * kolekto_itest_worker, and observes it only from outside: through the database, its logs, and
 * Mailpit. So pgmq.read, the visibility timeout, the dead-letter branch, pgmq.delete, runSenderTick,
 * maintenance and the shutdown path all run for real.
 *
 * Isolation (itest-worker.ts, harness): the worker reads the queue and claims deliveries globally, so
 * checkpoint() proves the queue is empty and no open row exists before every test, the child is
 * stopped before afterEach quarantine, and every assertion is by this test's own community.
 *
 * The pause switch: only withSendingEnabled (itest-switch.ts) changes it, on this stack, with the
 * lane's grant, and it restores false in `finally`, then reads it back on a new connection.
 *
 * Faults: database locks are held by the harness and the blocked worker session is detected in
 * pg_stat_activity, never by a fixed sleep. SMTP failures come from a loopback proxy in front of the
 * test Mailpit (itest-smtp-fault-proxy.ts), whose upstream host cannot be anything but 127.0.0.1.
 *
 * On Windows graceful stop is an IPC request that raises the worker's own SIGTERM handler. That
 * proves the handler and the drain, not operating-system signal delivery.
 *
 * Integration lane only: `npm run test:integration --workspace apps/worker -- --worker-runtime`,
 * or `-- --with-smtp` for the full lane. Real wall-clock time: the visibility timeout is a constant.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { buildEmailMessage } from "../../src/notification-send-message.ts";
import { emailDedupeKey } from "../../src/notification-eligibility.ts";
import { eventKey } from "../../src/notification-rules.ts";
import { safeErrorJson } from "../../src/worker-safety.ts";

import { connectAsWorkerRole, connectVerified, liveGateDeps, WORKER_DB_ROLE, type ItestSql, type ItestTx } from "../support/itest-db.ts";
import { refuse, Secret } from "../support/itest-environment.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import { createCommunityFixture, createFileHarness, HEARTBEAT_SQL, type CommunityFixture } from "../support/itest-isolation.ts";
import { assertNoMessageTo, checkMessageContent, expectedMessageId, findExactMessages, selectExactlyOne, type ExpectedMessage, type MailpitListEntry } from "../support/itest-mailpit.ts";
import { findOwnQueueMessages, readQueueState, waitForOwnQueueMessage, type OwnedQueueMessage } from "../support/itest-queue.ts";
import { seedOwnQueueMessage } from "../support/itest-queue-seed.ts";
import { findClosedLoopbackPort, startFaultProxy, type FaultProxy } from "../support/itest-smtp-fault-proxy.ts";
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
  WORKER_APP_NAME,
  type EvidenceSink,
  type WorkerBundle,
  type WorkerExit,
  type WorkerHandle,
  type WorkerOptions,
} from "../support/itest-worker.ts";

const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "worker-runtime");
const { scope } = harness;

const mailpitApi = () => gate.verified().mailpitApi.origin;
const EMAIL_FROM = "noreply@kolekto.test";
const COMMUNITY_NAME = "Worker Runtime Test";

let admin: ItestSql;
let bundle: WorkerBundle;
let credential: Secret;
let evidence: EvidenceSink;
let phoneCounter = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded poll. Returns the first truthy value, or throws with the label and the last value's shape. */
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

async function assertNoLedgerPurgeEligible(): Promise<void> {
  // Real maintenance purges ledger rows older than 48 h. This phase forbids ledger cleanup, so the
  // worker may run only while no such row exists; purged_this_tick is asserted as 0 as well.
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from public.notification_send_attempts where attempted_at < now() - interval '48 hours'`;
  if (row?.n !== 0) throw refuse("LEDGER_PURGE_ELIGIBLE", `${String(row?.n)} ledger row(s) are older than 48 h; the real worker's maintenance would delete them. Not starting it.`);
}

function normalWorker(extra: Omit<WorkerOptions, "database"> = {}): WorkerOptions {
  return { database: { kind: "verified", password: credential }, ...extra };
}

/** Starts the real worker, proves its target, runs `fn`, and always stops it and stores its scanned log. */
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

/** Starts a worker that is expected to exit by itself, and returns how it ended. */
async function runUntilExit(label: string, options: WorkerOptions, extraSecrets: readonly Secret[], timeoutMs = 60_000): Promise<{ exit: WorkerExit; output: string }> {
  const worker = startWorker(bundle, gate.verified(), options);
  try {
    const exit = await Promise.race([
      worker.exited(),
      sleep(timeoutMs).then(() => { throw refuse("WORKER_TIMEOUT", `${label}: the worker kept running after an invalid configuration.`); }),
    ]);
    return { exit, output: worker.output() };
  } finally {
    if (worker.alive()) await worker.kill();
    evidence.storeWorkerLog(label, worker, [...runSecrets(), ...extraSecrets]);
  }
}

// ── Domain actions (real RPCs, committed, as the signed-in user) ──────────────

async function asUser<T>(userId: string, fn: (tx: ItestTx) => Promise<T>): Promise<T> {
  return (await admin.begin(async (raw) => {
    const tx = raw as unknown as ItestTx;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx`set local role authenticated`;
    return fn(tx);
  })) as T;
}

function newCommunity(): Promise<CommunityFixture> {
  return createCommunityFixture(admin, harness, { ownerName: "Runtime Owner", communityName: COMMUNITY_NAME, ownerTerm: true });
}

function runScopedPhone(): string {
  phoneCounter += 1;
  return `+23480${String(Number.parseInt(scope.runTag.slice(0, 5), 16) % 10_000).padStart(4, "0")}${String(phoneCounter).padStart(4, "0")}`;
}

interface NewMember {
  readonly memberId: string;
  readonly to: string;
  readonly queued: OwnedQueueMessage;
}

/** app.create_member as the owner: audit row → trigger → queue. Returns the one queued message. */
async function createMember(c: CommunityFixture): Promise<NewMember> {
  const to = scope.address();
  const memberId = await asUser(c.ownerId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      select app.create_member(${c.communityId}::uuid, ${`Member ${scope.runTag} ${randomBytes(4).toString("hex")}`}::text, ${runScopedPhone()}::text, ${to}::extensions.citext)::text as id`;
    return row!.id;
  });
  const queued = await waitForOwnQueueMessage(admin, harness.testOwner, c.communityId);
  assert.equal(queued.message["action"], "member.create");
  assert.equal(queued.readCount, 0, "nothing has read the message yet");
  return { memberId, to, queued };
}

/** A second confirmed account, the way sign-up would leave it. */
async function addConfirmedUser(name: string): Promise<{ readonly userId: string; readonly email: string }> {
  const userId = scope.uuid();
  const email = scope.address();
  await admin`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
    (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now())`;
  await admin`insert into public.users (id, full_name, email) values (${userId}, ${name}, ${email})
    on conflict (id) do update set full_name = excluded.full_name, email = excluded.email`;
  return { userId, email };
}

// ── Reads (read-only, by this test's community) ───────────────────────────────

interface Delivery {
  id: string;
  channel: string;
  status: string;
  error_code: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  retry_in_s: number | null;
  recipient_address: string | null;
  recipient_address_assurance: string | null;
  dedupe_key: string | null;
  provider_message_id: string | null;
  lease_held: boolean;
}

const deliveries = (communityId: string) => admin<Delivery[]>`
  select id::text as id, channel::text as channel, status::text as status, error_code, attempt_count, next_retry_at::text as next_retry_at,
         extract(epoch from next_retry_at - now())::int as retry_in_s, recipient_address, recipient_address_assurance, dedupe_key,
         provider_message_id, (send_lease_token is not null) as lease_held
  from public.notification_deliveries where community_id = ${communityId}::uuid order by created_at, id`;

/** For polls: the row may not exist yet, but there is never more than one. */
async function maybeEmailRow(communityId: string): Promise<Delivery | undefined> {
  const rows = (await deliveries(communityId)).filter((d) => d.channel === "email");
  assert.ok(rows.length <= 1, "at most one email delivery for this community");
  return rows[0];
}

async function emailRow(communityId: string): Promise<Delivery> {
  const rows = (await deliveries(communityId)).filter((d) => d.channel === "email");
  assert.equal(rows.length, 1, "exactly one email delivery for this community");
  return rows[0]!;
}

const events = (communityId: string) => admin<{ id: string; event_type: string; event_key: string; payload: Record<string, unknown> }[]>`
  select id::text as id, event_type, event_key, payload from public.notification_events where community_id = ${communityId}::uuid order by created_at, id`;

async function ledgerRows(communityId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from public.notification_send_attempts where community_id = ${communityId}::uuid`;
  return row!.n;
}

async function archiveCount(): Promise<number> {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from pgmq.a_notification_events`;
  return row!.n;
}

async function senderState(): Promise<{ heartbeat: string | null; lastClaim: string | null; enabled: boolean }> {
  const [row] = await admin<{ heartbeat: string | null; last_claim: string | null; enabled: boolean }[]>`
    select last_heartbeat_at::text as heartbeat, last_claim_at::text as last_claim, email_sending_enabled as enabled from public.notification_sender_state`;
  return { heartbeat: row!.heartbeat, lastClaim: row!.last_claim, enabled: row!.enabled };
}

/** Waits until the worker has committed `ticks` more heartbeats, which means that many full loops. */
async function waitForTicks(ticks: number): Promise<void> {
  let last = (await senderState()).heartbeat;
  for (let i = 0; i < ticks; i += 1) {
    const seen = last;
    last = await until("a sender heartbeat", async () => {
      const current = (await senderState()).heartbeat;
      return current !== seen ? current : null;
    }, 20_000);
  }
}

async function queueRow(msgId: string): Promise<{ read_ct: number; vt_future: boolean } | null> {
  const [row] = await admin<{ read_ct: number; vt_future: boolean }[]>`
    select read_ct, vt > now() as vt_future from pgmq.q_notification_events where msg_id = ${msgId}::bigint`;
  return row ?? null;
}

const queueEmpty = async () => {
  const state = await readQueueState(admin);
  return state.queued === 0 && state.readMessages === 0;
};

// ── Mailpit (read-only GETs; nothing is ever deleted) ─────────────────────────

async function mailpitSearchTo(address: string): Promise<unknown> {
  const res = await fetch(`${mailpitApi()}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  assert.equal(res.status, 200, "Mailpit search answered");
  return res.json();
}

async function assertNoMail(address: string): Promise<void> {
  assertNoMessageTo(await mailpitSearchTo(address), address, scope.runTag);
}

/** Exactly one message matching recipient, subject and Message-ID, with the expected content. */
async function assertDeliveredOnce(delivery: Delivery, to: string, payload: Record<string, unknown>, eventType: string, fragments: readonly string[]): Promise<MailpitListEntry> {
  const rendered = buildEmailMessage(to, { eventType, payload });
  const expected: ExpectedMessage = { to, subject: rendered.subject, messageId: expectedMessageId(delivery.id), runTag: scope.runTag };
  const entry = await until("exactly one matching Mailpit message", async () => {
    const list = await mailpitSearchTo(to);
    const exact = findExactMessages(list, expected);
    return exact.length > 0 ? selectExactlyOne(list, expected) : null;
  }, 10_000);
  const res = await fetch(`${mailpitApi()}/api/v1/message/${encodeURIComponent(entry.ID)}`);
  assert.equal(res.status, 200, "Mailpit message read answered");
  const full = (await res.json()) as { From?: { Address?: string } };
  assert.equal(full.From?.Address, EMAIL_FROM, "from address");
  checkMessageContent(full, { id: entry.ID, text: fragments, html: fragments });
  return entry;
}

// ── Holding database locks from the harness ───────────────────────────────────

class ReleaseGate extends Error {}

/** Runs `fn` in a transaction left open until release(), which always rolls it back. */
async function holdInTransaction(fn: (tx: ItestTx) => Promise<void>): Promise<{ release: () => Promise<void> }> {
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
  return { release: async () => { release(); await done; } };
}

/** Holds the event row's unique key, uncommitted, so the worker's INSERT waits. Rolled back, so no residue. */
function holdEventKey(c: CommunityFixture, member: NewMember) {
  const key = eventKey("member.create", member.memberId);
  return holdInTransaction(async (tx) => {
    await tx`insert into public.notification_events (community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
      values (${c.communityId}::uuid, 'member.create', ${key}, 'officer', ${c.ownerId}::uuid, 'member', ${member.memberId}::uuid, '{}'::jsonb)`;
  });
}

// ── The pause-switch context ──────────────────────────────────────────────────

const switchContext = (): SwitchContext => ({
  env: gate.verified(),
  sql: admin,
  assertMutexHeld: () => harness.assertMutexHeld(),
  ownsCommunity: (id) => scope.owns(id),
});

/** Every message this file sends passes through here, and the switch is confirmed false afterwards. */
async function whileSendingEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const result = await withSendingEnabled(switchContext(), fn);
  const after = await readPauseSwitchIndependently(gate.verified());
  assert.deepEqual(after, { rows: 1, column: false, fn: false }, "the switch reads false on a new connection");
  return result;
}

async function makeDue(deliveryId: string): Promise<void> {
  await admin`update public.notification_deliveries set next_retry_at = now() - interval '1 minute' where id = ${deliveryId}::uuid`;
}

// ══════════════════════════════════════════════════════════════════════════════

describe("M13.2 Phase 7 — the real worker process", () => {
  before(async () => {
    await gate.verify();
    admin = connectVerified(gate.verified(), { max: 6 });
    // A worker from an earlier run keeps a heartbeat fresh for 60 s. Wait it out, bounded. A worker
    // that is really alive keeps it fresh, the wait ends, and the harness refuses below.
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

  // ── Startup, identity, heartbeat, shutdown ──────────────────────────────────

  it("RT-1: starts as the worker role on the verified stack, heartbeats while paused, and stops cleanly", async () => {
    const before = await senderState();
    assert.equal(before.enabled, false);
    const outcome = await withWorker("rt1-startup", normalWorker(), async (worker) => {
      const sessions = await readWorkerSessions(admin);
      assert.ok(sessions.length >= 1);
      for (const s of sessions) assert.equal(s.usename, WORKER_DB_ROLE, "connected as the least-privilege role");
      await waitForTicks(3);
      const during = await senderState();
      assert.notEqual(during.heartbeat, before.heartbeat, "the heartbeat advances");
      assert.equal(during.lastClaim, before.lastClaim, "last_claim_at does not move while paused");
      await until("the send health line", async () => worker.linesFor("notification_send_health").length > 0);
      await until("the event health line", async () => worker.linesFor("notification_event_health").length > 0);
      assert.equal(worker.linesFor("notification_send_health")[0]!["email_sending_enabled"], false);
      const state = worker.linesFor("notification_sender_pause_state");
      assert.deepEqual(state, [{ msg: "notification_sender_pause_state", email_sending_enabled: false, first_reading: true }], "the pause state is explicit in the log");
      const exit = await worker.stop();
      assert.equal(exit.code, 0, "exit code 0");
      assert.match(worker.output(), /Kolekto worker: shutting down\./);
      return { sessions: sessions.length, exit };
    });
    assert.equal((await readWorkerSessions(admin)).length, 0, "no session left behind");
    evidence.reading("RT-1", outcome);
  });

  // ── The three required events, each through the real worker to Mailpit ──────

  it("EV-1: member.create — queue → real worker → pending while OFF → sent once when ON, no restart → replay safe → OFF stops the next one", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const archivedBefore = await archiveCount();

    await withWorker("ev1-member-create", normalWorker(), async (worker) => {
      // ── OFF: processed and acknowledged, but nothing is sent ──────────────
      const pending = await until("the pending email row", async () => (await deliveries(c.communityId)).find((d) => d.channel === "email" && d.status === "pending"));
      await until("the queue to empty", queueEmpty);
      assert.equal(await archiveCount(), archivedBefore, "the message was deleted, not archived");
      assert.deepEqual(worker.linesFor("notification_event_processed").map((l) => [l["msg_id"], l["read_ct"], l["action"]]), [[member.queued.msgId, 1, "member.create"]]);
      assert.equal(pending.recipient_address, member.to);
      assert.equal(pending.recipient_address_assurance, "unverified_supplied");
      assert.equal(pending.dedupe_key, emailDedupeKey("member.create", member.memberId));

      const before = await senderState();
      await waitForTicks(3);
      const stillPending = await emailRow(c.communityId);
      assert.equal(stillPending.status, "pending", "OFF: untouched over 3 ticks");
      assert.equal(stillPending.attempt_count, 0);
      assert.equal(await ledgerRows(c.communityId), 0, "OFF: no reservation");
      assert.equal((await senderState()).lastClaim, before.lastClaim, "OFF: no claim");
      await assertNoMail(member.to);

      // ── ON, same process: exactly one send ────────────────────────────────
      await whileSendingEnabled(async () => {
        const sent = await until("the delivery to be sent", async () => {
          const row = await maybeEmailRow(c.communityId);
          return row?.status === "sent" ? row : null;
        });
        assert.equal(sent.attempt_count, 1);
        assert.equal(sent.provider_message_id, expectedMessageId(sent.id));
        assert.equal(sent.lease_held, false, "lease released");
        const [event] = await events(c.communityId);
        const code = String(event!.payload["member_code"]);
        const mail = await assertDeliveredOnce(sent, member.to, event!.payload, "member.create", [COMMUNITY_NAME, code]);
        evidence.reading("EV-1 sent", { deliveryId: sent.id, messageId: sent.provider_message_id, mailpitId: mail.ID, attempt: sent.attempt_count });
        assert.notEqual((await senderState()).lastClaim, before.lastClaim, "last_claim_at advanced");
        assert.equal(await ledgerRows(c.communityId), 1, "one grant");
        await until("the pause state ON line", async () => worker.linesFor("notification_sender_pause_state").some((l) => l["email_sending_enabled"] === true));

        // ── Replay of the same message, through the real read path, switch still ON ──
        const replayed = await seedOwnQueueMessage(admin, harness.testOwner, member.queued.message);
        await until("the replay to be acknowledged", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === replayed));
        await waitForTicks(2);
        assert.equal((await events(c.communityId)).length, 1, "replay: no second event");
        const afterReplay = await deliveries(c.communityId);
        assert.equal(afterReplay.filter((d) => d.channel === "email").length, 1, "replay: no second delivery");
        assert.equal(afterReplay.find((d) => d.channel === "email")!.status, "sent");
        assert.equal(afterReplay.find((d) => d.channel === "email")!.attempt_count, 1);
        assert.equal(await ledgerRows(c.communityId), 1, "replay: no second grant");
        selectExactlyOne(await mailpitSearchTo(member.to), { to: member.to, subject: buildEmailMessage(member.to, { eventType: "member.create", payload: event!.payload }).subject, messageId: expectedMessageId(sent.id), runTag: scope.runTag });
      });

      // ── OFF again: the running worker stops sending ───────────────────────
      await until("the pause state OFF line", async () => worker.linesFor("notification_sender_pause_state").filter((l) => l["email_sending_enabled"] === false).length === 2);
      const second = await createMember(c);
      const secondRow = await until("the second pending row", async () => (await deliveries(c.communityId)).find((d) => d.channel === "email" && d.status === "pending"));
      const claimBefore = (await senderState()).lastClaim;
      await waitForTicks(3);
      assert.equal((await deliveries(c.communityId)).find((d) => d.id === secondRow.id)!.status, "pending", "OFF again: the next delivery waits");
      assert.equal((await senderState()).lastClaim, claimBefore);
      await assertNoMail(second.to);
      evidence.reading("EV-1 paused again", { deliveryId: secondRow.id, status: "pending" });
    });
  });

  it("EV-2: officer_term.end — real RPC → real worker → verified_account email to the term holder, once, replay safe", async () => {
    const c = await newCommunity();
    const officer = await addConfirmedUser("Runtime Officer");
    const termId = scope.uuid();
    await admin`insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason)
      values (${termId}, ${c.communityId}, ${officer.userId}, 'admin', 'Runtime Officer', 'invited')`;
    await asUser(c.ownerId, (tx) => tx`select app.end_officer_term(${termId}::uuid, 'integration test')`);
    const queued = await waitForOwnQueueMessage(admin, harness.testOwner, c.communityId);
    assert.equal(queued.message["action"], "officer_term.end");
    assert.equal(queued.message["object_id"], termId);

    await withWorker("ev2-officer-term-end", normalWorker(), async (worker) => {
      await whileSendingEnabled(async () => {
        const sent = await until("the officer notice to be sent", async () => {
          const row = (await deliveries(c.communityId)).find((d) => d.channel === "email");
          return row?.status === "sent" ? row : null;
        });
        assert.equal(sent.recipient_address, officer.email);
        assert.equal(sent.recipient_address_assurance, "verified_account");
        assert.equal(sent.attempt_count, 1);
        const [event] = await events(c.communityId);
        assert.equal(event!.event_type, "officer_term.end");
        const mail = await assertDeliveredOnce(sent, officer.email, event!.payload, "officer_term.end", [COMMUNITY_NAME]);
        evidence.reading("EV-2 sent", { deliveryId: sent.id, messageId: sent.provider_message_id, mailpitId: mail.ID });
        await until("the queue to empty", queueEmpty);

        const replayed = await seedOwnQueueMessage(admin, harness.testOwner, queued.message);
        await until("the replay to be acknowledged", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === replayed));
        await waitForTicks(2);
        assert.equal((await events(c.communityId)).length, 1, "replay: no second event");
        assert.equal((await deliveries(c.communityId)).filter((d) => d.channel === "email").length, 1, "replay: no second delivery");
        assert.equal(await ledgerRows(c.communityId), 1, "replay: no second grant");
        selectExactlyOne(await mailpitSearchTo(officer.email), { to: officer.email, subject: mail.Subject, messageId: expectedMessageId(sent.id), runTag: scope.runTag });
      });
    });
  });

  it("EV-3: officer_invitation.accept — real invitation and acceptance → real worker → email to the new officer, once, replay safe", async () => {
    const c = await newCommunity();
    const invitee = await addConfirmedUser("Runtime Invitee");
    const invitation = await asUser(c.ownerId, async (tx) => {
      const [row] = await tx<{ token: string }[]>`
        select token from app.create_officer_invitation(${c.communityId}::uuid, 'admin'::public.officer_role, null, null, 'Runtime Invitee', null, ${invitee.email}::extensions.citext)`;
      return row!;
    });
    const termId = await asUser(invitee.userId, async (tx) => {
      const [row] = await tx<{ term: string }[]>`select app.accept_officer_invitation(${invitation.token}::text)::text as term`;
      return row!.term;
    });
    const queued = await waitForOwnQueueMessage(admin, harness.testOwner, c.communityId);
    assert.equal(queued.message["action"], "officer_invitation.accept");
    assert.equal(queued.message["object_id"], termId);

    await withWorker("ev3-officer-invitation-accept", normalWorker(), async (worker) => {
      assert.ok(!worker.output().includes(invitation.token), "the invitation token is never logged");
      await whileSendingEnabled(async () => {
        const sent = await until("the officer welcome to be sent", async () => {
          const row = (await deliveries(c.communityId)).find((d) => d.channel === "email");
          return row?.status === "sent" ? row : null;
        });
        assert.equal(sent.recipient_address, invitee.email);
        assert.equal(sent.recipient_address_assurance, "verified_account");
        const [event] = await events(c.communityId);
        assert.equal(event!.event_type, "officer_invitation.accept");
        const mail = await assertDeliveredOnce(sent, invitee.email, event!.payload, "officer_invitation.accept", [COMMUNITY_NAME]);
        evidence.reading("EV-3 sent", { deliveryId: sent.id, messageId: sent.provider_message_id, mailpitId: mail.ID });
        await until("the queue to empty", queueEmpty);

        const replayed = await seedOwnQueueMessage(admin, harness.testOwner, queued.message);
        await until("the replay to be acknowledged", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === replayed));
        await waitForTicks(2);
        assert.equal((await events(c.communityId)).length, 1, "replay: no second event");
        assert.equal((await deliveries(c.communityId)).filter((d) => d.channel === "email").length, 1, "replay: no second delivery");
        assert.equal(await ledgerRows(c.communityId), 1, "replay: no second grant");
        selectExactlyOne(await mailpitSearchTo(invitee.email), { to: invitee.email, subject: mail.Subject, messageId: expectedMessageId(sent.id), runTag: scope.runTag });
        assert.ok(!worker.output().includes(invitation.token), "the invitation token is never logged");
      });
    });
  });

  // ── Skips are acknowledged and visible ──────────────────────────────────────

  it("RT-4: messages the processor refuses are acknowledged, create nothing, and leave a log line with a stable reason", async () => {
    const c = await newCommunity();
    const archivedBefore = await archiveCount();
    const base = { community_id: c.communityId, audit_log_id: scope.uuid(), object_id: scope.uuid(), object_type: "member", actor_type: "officer", actor_user_id: c.ownerId, actor_name: "", after_state: null, before_state: null };
    const seeds = {
      invalid_message: await seedOwnQueueMessage(admin, harness.testOwner, { community_id: c.communityId, not: "an audit message" }),
      unwatched_action: await seedOwnQueueMessage(admin, harness.testOwner, { ...base, action: "something.unknown", created_at: new Date().toISOString() }),
      event_too_old: await seedOwnQueueMessage(admin, harness.testOwner, { ...base, action: "member.create", audit_log_id: scope.uuid(), created_at: new Date(Date.now() - 73 * 3_600_000).toISOString() }),
      member_unavailable: await seedOwnQueueMessage(admin, harness.testOwner, { ...base, action: "member.create", audit_log_id: scope.uuid(), created_at: new Date().toISOString() }),
    };
    await withWorker("rt4-skips", normalWorker(), async (worker) => {
      await until("all four skip lines", async () => worker.linesFor("notification_event_skipped").length === 4);
      await until("the queue to empty", queueEmpty);
      const lines = worker.linesFor("notification_event_skipped");
      for (const [reason, msgId] of Object.entries(seeds)) {
        const line = lines.find((l) => l["msg_id"] === msgId);
        assert.equal(line?.["reason"], reason, reason);
      }
      assert.equal(lines.find((l) => l["msg_id"] === seeds.unwatched_action)?.["action"], null, "an unwatched action's free text is not logged");
      assert.equal(await archiveCount(), archivedBefore, "skips are deleted, not dead-lettered");
      assert.equal((await events(c.communityId)).length, 0, "no event");
      assert.equal((await deliveries(c.communityId)).length, 0, "no delivery");
    });
    evidence.reading("RT-4", seeds);
  });

  it("RT-3: in-app-only events go through the role's remaining grants, create no email row and send nothing", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const collectionId = scope.uuid();
    const base = { community_id: c.communityId, actor_user_id: c.ownerId, actor_name: "", after_state: null, before_state: null, created_at: new Date().toISOString() };
    const joined = await seedOwnQueueMessage(admin, harness.testOwner, { ...base, audit_log_id: scope.uuid(), action: "member.join_via_invite", actor_type: "member", object_type: "member", object_id: member.memberId });
    const published = await seedOwnQueueMessage(admin, harness.testOwner, { ...base, audit_log_id: scope.uuid(), action: "collection.publish", actor_type: "officer", object_type: "collection", object_id: collectionId });
    const unpaid = await seedOwnQueueMessage(admin, harness.testOwner, { ...base, audit_log_id: scope.uuid(), action: "collection.remind_unpaid", actor_type: "officer", object_type: "collection", object_id: collectionId });
    await withWorker("rt3-in-app", normalWorker(), async (worker) => {
      await until("all messages to be processed", async () => worker.linesFor("notification_event_processed").length === 4);
      await until("the queue to empty", queueEmpty);
      assert.equal(worker.linesFor("notification_event_skipped").length, 0, "nothing was skipped");
      const lines = worker.linesFor("notification_event_processed");
      assert.deepEqual(lines.find((l) => l["msg_id"] === joined)?.["email"], { kind: "no_row" });
      assert.equal(lines.find((l) => l["msg_id"] === joined)?.["deliveries"], 1, "the owner hears of the join, through role_permissions and officer_terms");
      assert.deepEqual(lines.find((l) => l["msg_id"] === published)?.["email"], { kind: "no_row" });
      assert.deepEqual(lines.find((l) => l["msg_id"] === unpaid)?.["email"], { kind: "no_row" });
      assert.doesNotMatch(worker.output(), /Failed to process/, "no permission failure on the audience and obligation reads");
      const rows = await deliveries(c.communityId);
      assert.equal(rows.filter((d) => d.channel === "in_app").length, 1);
      assert.equal(rows.filter((d) => d.channel === "email").length, 1, "only member.create produced an email row");
      await assertNoMail(member.to);
    });
  });

  // ── The pause-switch helper itself ──────────────────────────────────────────

  it("PS-RESTORE: the switch is restored and read back false when the code inside the window throws", async () => {
    class Boom extends Error {}
    await assert.rejects(
      withSendingEnabled(switchContext(), async () => {
        assert.deepEqual(await readPauseSwitchIndependently(gate.verified()), { rows: 1, column: true, fn: true }, "really on inside the window");
        throw new Boom();
      }),
      Boom,
    );
    const after = await readPauseSwitchIndependently(gate.verified());
    assert.deepEqual(after, { rows: 1, column: false, fn: false }, "restored");
    evidence.reading("PS-RESTORE", after);
  });

  // ── Recovery ────────────────────────────────────────────────────────────────

  // Phase 8 changed this test. Before F-14 a held lock stalled the loop indefinitely. A lock held past the
  // limit is now covered by F14-LOCK; what this keeps proving is that a shorter one just waits, harmlessly.
  it("RC-LOCK: a lock released inside the limit only delays the worker: it completes on the first read, with no failure and no restart", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const lock = await holdEventKey(c, member);
    let released = false;
    try {
      await withWorker("rc-lock-release", normalWorker(), async (worker) => {
        const blocked = await awaitBlockedWorker(admin, /notification_events/);
        assert.equal(blocked.usename, WORKER_DB_ROLE);
        assert.equal((await queueRow(member.queued.msgId))?.read_ct, 1, "first read returns read_ct 1");
        assert.equal((await events(c.communityId)).length, 0, "nothing committed");
        await sleep(2_000);
        assert.ok(worker.alive());
        assert.doesNotMatch(worker.output(), /Failed to process/, "still inside the 5 s limit");
        await lock.release();
        released = true;
        await until("the message to be processed", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === member.queued.msgId));
        await until("the queue to empty", queueEmpty);
        await waitForTicks(1);
        assert.equal((await events(c.communityId)).length, 1);
        assert.equal((await emailRow(c.communityId)).status, "pending");
        assert.equal(worker.linesFor("notification_event_processed")[0]!["read_ct"], 1, "completed on the first read, with no restart");
      });
    } finally {
      if (!released) await lock.release();
    }
  });

  it("RT-6: a stop request during blocked processing lets the in-flight message finish, then exits 0", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const lock = await holdEventKey(c, member);
    let released = false;
    try {
      await withWorker("rt6-drain", normalWorker(), async (worker) => {
        await awaitBlockedWorker(admin, /notification_events/);
        const stopping = worker.stop(30_000);
        await sleep(1_500);
        assert.ok(worker.alive(), "the worker waits for the in-flight statement");
        await lock.release();
        released = true;
        const exit = await stopping;
        assert.equal(exit.code, 0);
        assert.match(worker.output(), /shutting down/);
        assert.ok(worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === member.queued.msgId), "the in-flight message completed and was acknowledged");
      });
      assert.ok(await queueEmpty());
      assert.equal((await events(c.communityId)).length, 1);
    } finally {
      if (!released) await lock.release();
    }
  });

  it("RC-1: a worker killed during processing loses nothing; the message reappears only after the visibility timeout, with read_ct 2, and completes once", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const lock = await holdEventKey(c, member);
    let released = false;
    try {
      await withWorker("rc1-killed", normalWorker(), async (worker) => {
        await awaitBlockedWorker(admin, /notification_events/);
        const exit = await worker.kill();
        assert.notEqual(exit.code, 0, "a forced kill");
        // Its server session stays blocked until the lock goes, then sees the client gone and rolls back.
        await lock.release();
        released = true;
      });
      const after = await queueRow(member.queued.msgId);
      assert.deepEqual(after, { read_ct: 1, vt_future: true }, "still queued, hidden by the visibility timeout");
      assert.equal((await events(c.communityId)).length, 0, "nothing was committed");

      await withWorker("rc1-restarted", normalWorker(), async (worker) => {
        // Not re-read while the timeout holds.
        await waitForTicks(1);
        const during = await queueRow(member.queued.msgId);
        if (during?.vt_future === true) assert.equal(during.read_ct, 1, "not re-read before the visibility timeout");
        await until("the redelivered message to be processed", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === member.queued.msgId), 45_000);
        assert.equal(worker.linesFor("notification_event_processed")[0]!["read_ct"], 2, "redelivered with read_ct 2");
        await until("the queue to empty", queueEmpty);
        assert.equal((await events(c.communityId)).length, 1, "one event");
        assert.equal((await deliveries(c.communityId)).filter((d) => d.channel === "email").length, 1, "one delivery");
      });
    } finally {
      if (!released) await lock.release();
    }
  });

  it("RC-2: if the acknowledgement fails after processing committed, the worker survives and the replay creates nothing new", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const processing = await holdEventKey(c, member);
    let processingReleased = false;
    let ack: { release: () => Promise<void> } | null = null;
    try {
      await withWorker("rc2-ack-failure", normalWorker(), async (worker) => {
        await awaitBlockedWorker(admin, /notification_events/);
        ack = await holdInTransaction(async (tx) => {
          await tx`select msg_id from pgmq.q_notification_events where msg_id = ${member.queued.msgId}::bigint for update`;
        });
        await processing.release();
        processingReleased = true;
        const blocked = await awaitBlockedWorker(admin, /delete/);
        assert.equal((await events(c.communityId)).length, 1, "processing committed before the acknowledgement");
        const [terminated] = await admin<{ ok: boolean }[]>`
          select pg_terminate_backend(pid) as ok from pg_stat_activity
          where pid = ${blocked.pid} and application_name = ${WORKER_APP_NAME} and usename = ${WORKER_DB_ROLE}`;
        assert.equal(terminated?.ok, true, "terminated exactly the worker's own session");
        await until("the acknowledgement failure", async () => worker.linesFor("notification_event_ack_failed").some((l) => l["msg_id"] === member.queued.msgId && l["read_ct"] === 1), 10_000);
        assert.doesNotMatch(worker.output(), /Failed to process/, "Phase 8: not reported as a processing failure");
        await ack.release();
        ack = null;
        assert.ok(worker.alive(), "the worker survives");
        // Phase 8: a marked message only retries the delete. If the mark lost to the held lock, it is processed again, idempotently.
        await until("the redelivered message to be acknowledged", async () => [...worker.linesFor("notification_event_processed"), ...worker.linesFor("notification_event_ack_recovered")].some((l) => l["msg_id"] === member.queued.msgId && l["read_ct"] === 2), 45_000);
        await until("the queue to empty", queueEmpty);
        assert.equal((await events(c.communityId)).length, 1, "replay: one event");
        assert.equal((await deliveries(c.communityId)).filter((d) => d.channel === "email").length, 1, "replay: one delivery");
      });
    } finally {
      if (!processingReleased) await processing.release();
      if (ack !== null) await (ack as { release: () => Promise<void> }).release();
    }
  });

  it("RC-5: a poison message is tried exactly 5 times, archived at read_ct 6 with no sensitive text logged, and a healthy message is unaffected", async () => {
    const c = await newCommunity();
    const healthy = await createMember(c);
    const objectId = scope.uuid();
    // The invalid actor type fails the enum cast, and Postgres quotes it in its error message.
    // It is shaped like an address so the log check would catch it if the message were ever printed.
    const sentinel = `p@${scope.runTag.slice(0, 6)}.test`;
    const poison = await seedOwnQueueMessage(admin, harness.testOwner, {
      audit_log_id: scope.uuid(), community_id: c.communityId, action: "collection.publish", actor_type: sentinel, actor_user_id: null, actor_name: "",
      object_type: "collection", object_id: objectId, after_state: null, before_state: null, created_at: new Date().toISOString(),
    });
    const sampled = new Set<number>();
    await withWorker("rc5-poison", normalWorker(), async (worker) => {
      await until("the healthy message to be processed", async () => worker.linesFor("notification_event_processed").some((l) => l["msg_id"] === healthy.queued.msgId));
      await until("the poison message to be dead-lettered", async () => {
        const row = await queueRow(poison);
        if (row !== null) sampled.add(row.read_ct);
        return row === null;
      }, 240_000, 500);
      const output = worker.output();
      const attempts = [...output.matchAll(new RegExp(`Failed to process message ${poison} \\(read_ct=(\\d+)\\): (.*)`, "g"))];
      assert.deepEqual(attempts.map((m) => Number(m[1])), [1, 2, 3, 4, 5], "exactly five processing attempts");
      for (const attempt of attempts) assert.equal((JSON.parse(attempt[2]!) as { code?: string }).code, "22P02", "the SQLSTATE is logged");
      assert.equal([...output.matchAll(new RegExp(`Dead-lettering message ${poison}: read_ct=6`, "g"))].length, 1, "one dead-letter line");
      assert.ok(!output.includes(sentinel), "the value Postgres quoted in its error is not in the log");

      const [archived] = await admin<{ read_ct: number; archived: boolean }[]>`
        select read_ct, archived_at is not null as archived from pgmq.a_notification_events where msg_id = ${poison}::bigint`;
      assert.deepEqual(archived, { read_ct: 6, archived: true }, "archived at read_ct 6");
      const [poisonEvents] = await admin<{ n: number }[]>`select count(*)::int as n from public.notification_events where object_id = ${objectId}::uuid`;
      assert.equal(poisonEvents?.n, 0, "the poison message created nothing");
      assert.equal((await emailRow(c.communityId)).status, "pending", "the healthy message's delivery is intact");
      await until("the event health line to count the dead letter", async () => worker.linesFor("notification_event_health").some((l) => l["dead_lettered_total"] === 1 && l["failed_total"] === 5), 70_000);
      assert.ok(worker.alive());
      evidence.reading("RC-5", { poison, sampledReadCounts: [...sampled].sort(), archived });
    });
  });

  // ── SMTP failures, through the real worker, via the loopback fault proxy ────

  async function withProxy<T>(initial: Parameters<typeof startFaultProxy>[1], fn: (proxy: FaultProxy) => Promise<T>): Promise<T> {
    const proxy = await startFaultProxy(gate.verified(), initial);
    try {
      return await fn(proxy);
    } finally {
      await proxy.close();
    }
  }

  it("SM-RETRY: a temporary rejection schedules a retry about 5 minutes out, then a retry succeeds with the same Message-ID, once", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    await withProxy({ kind: "reject", verb: "RCPT", code: 451 }, async (proxy) => {
      await whileSendingEnabled(() => withWorker("sm-retry", normalWorker({ smtpPort: proxy.port }), async () => {
        const row = await until("the transient failure", async () => {
          const r = await maybeEmailRow(c.communityId);
          return r?.attempt_count === 1 && r.status === "pending" && r.error_code === "provider_rejected_transient" ? r : null;
        });
        assert.ok(row.retry_in_s !== null && row.retry_in_s >= 230 && row.retry_in_s <= 370, `5 minutes ±20% (got ${String(row.retry_in_s)} s)`);
        await waitForTicks(2);
        assert.equal(proxy.connections().length, 1, "no early retry");
        await assertNoMail(member.to);

        proxy.setScript({ kind: "pass" });
        await makeDue(row.id);
        const sent = await until("the retry to succeed", async () => {
          const r = await maybeEmailRow(c.communityId);
          return r?.status === "sent" ? r : null;
        });
        assert.equal(sent.attempt_count, 2, "second attempt");
        assert.equal(sent.provider_message_id, expectedMessageId(row.id), "same Message-ID");
        const [event] = await events(c.communityId);
        const mail = await assertDeliveredOnce(sent, member.to, event!.payload, "member.create", [COMMUNITY_NAME]);
        assert.equal(await ledgerRows(c.communityId), 2, "two grants");
        evidence.reading("SM-RETRY", { deliveryId: row.id, retryInS: row.retry_in_s, attempts: sent.attempt_count, mailpitId: mail.ID, proxy: proxy.connections() });
      }));
    });
  });

  it("SM-EXHAUST: an unreachable provider backs off about 5 then about 30 minutes, then ends dead/retries_exhausted after 3 attempts", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    const closedPort = await findClosedLoopbackPort();
    await whileSendingEnabled(() => withWorker("sm-exhaust", normalWorker({ smtpPort: closedPort }), async () => {
      const first = await until("attempt 1", async () => {
        const r = await maybeEmailRow(c.communityId);
        return r?.attempt_count === 1 && r.status === "pending" ? r : null;
      });
      assert.equal(first.error_code, "provider_unreachable");
      assert.ok(first.retry_in_s !== null && first.retry_in_s >= 230 && first.retry_in_s <= 370, `about 5 minutes (got ${String(first.retry_in_s)} s)`);
      await makeDue(first.id);
      const second = await until("attempt 2", async () => {
        const r = await maybeEmailRow(c.communityId);
        return r?.attempt_count === 2 && r.status === "pending" ? r : null;
      });
      assert.ok(second.retry_in_s !== null && second.retry_in_s >= 1400 && second.retry_in_s <= 2170, `about 30 minutes (got ${String(second.retry_in_s)} s)`);
      await makeDue(second.id);
      const dead = await until("the terminal state", async () => {
        const r = await maybeEmailRow(c.communityId);
        return r?.status === "dead" ? r : null;
      });
      assert.equal(dead.error_code, "retries_exhausted");
      assert.equal(dead.attempt_count, 3);
      await assertNoMail(member.to);
      evidence.reading("SM-EXHAUST", { deliveryId: dead.id, firstRetryInS: first.retry_in_s, secondRetryInS: second.retry_in_s, final: dead.error_code });
    }));
  });

  it("SM-PERM: a permanent rejection is dead on the first attempt and never retried", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    await withProxy({ kind: "reject", verb: "RCPT", code: 550 }, async (proxy) => {
      await whileSendingEnabled(() => withWorker("sm-perm", normalWorker({ smtpPort: proxy.port }), async () => {
        const dead = await until("the permanent failure", async () => {
          const r = await maybeEmailRow(c.communityId);
          return r?.status === "dead" ? r : null;
        });
        assert.equal(dead.error_code, "provider_rejected_permanent");
        assert.equal(dead.attempt_count, 1);
        await waitForTicks(2);
        assert.equal(proxy.connections().length, 1, "one call, no retry");
        await assertNoMail(member.to);
        evidence.reading("SM-PERM", { deliveryId: dead.id, proxy: proxy.connections() });
      }));
    });
  });

  it("SM-AMBIG: delivered but the client never hears: dead/outcome_unknown, never retried, and Mailpit holds exactly one copy", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    await withProxy({ kind: "deliver-then-drop" }, async (proxy) => {
      await whileSendingEnabled(() => withWorker("sm-ambiguous", normalWorker({ smtpPort: proxy.port }), async () => {
        const dead = await until("the ambiguous outcome", async () => {
          const r = await maybeEmailRow(c.communityId);
          return r?.status === "dead" ? r : null;
        });
        assert.equal(dead.error_code, "outcome_unknown");
        assert.equal(dead.attempt_count, 1);
        await waitForTicks(2);
        assert.equal(proxy.connections().length, 1, "never retried");
        assert.equal(proxy.connections()[0]!.outcome, "delivered-then-dropped");
        const [event] = await events(c.communityId);
        const mail = await assertDeliveredOnce(dead, member.to, event!.payload, "member.create", [COMMUNITY_NAME]);
        evidence.reading("SM-AMBIG", { deliveryId: dead.id, mailpitId: mail.ID, proxy: proxy.connections() });
      }));
    });
  });

  it("SM-TIMEOUT: no reply after the body ends dead/outcome_unknown, and nothing reached Mailpit", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    await withProxy({ kind: "hold-after-data" }, async (proxy) => {
      await whileSendingEnabled(() => withWorker("sm-timeout", normalWorker({ smtpPort: proxy.port }), async () => {
        const dead = await until("the timeout", async () => {
          const r = await maybeEmailRow(c.communityId);
          return r?.status === "dead" ? r : null;
        }, 30_000);
        assert.equal(dead.error_code, "outcome_unknown");
        await assertNoMail(member.to);
        evidence.reading("SM-TIMEOUT", { deliveryId: dead.id, proxy: proxy.connections() });
      }));
    });
  });

  it("RC-SEND: a worker killed in the middle of a send never re-sends: the next worker's maintenance records dead/outcome_unknown", async () => {
    const c = await newCommunity();
    const member = await createMember(c);
    await withProxy({ kind: "hold-after-data" }, async (proxy) => {
      let deliveryId = "";
      await whileSendingEnabled(() => withWorker("rc-send-killed", normalWorker({ smtpPort: proxy.port }), async (worker) => {
        await until("the proxy to see the message body start", async () => proxy.connections()[0]?.verbs.includes("DATA"), 15_000, 50);
        const exit = await worker.kill();
        assert.notEqual(exit.code, 0);
        const row = await emailRow(c.communityId);
        assert.equal(row.status, "sending", "left in sending by the crash");
        assert.equal(row.lease_held, true);
        deliveryId = row.id;
      }));
      // Lease lapse is simulated on this test's own row, as the sender file does; 300 s is a constant.
      await admin`update public.notification_deliveries set send_lease_expires_at = now() - interval '1 second' where id = ${deliveryId}::uuid`;
      await withWorker("rc-send-recovered", normalWorker(), async (worker) => {
        const dead = await until("maintenance to resolve the row", async () => {
          const r = await maybeEmailRow(c.communityId);
          return r?.status === "dead" ? r : null;
        });
        assert.equal(dead.error_code, "outcome_unknown");
        assert.equal(dead.attempt_count, 1, "no second attempt");
        await until("the health line to count it", async () => worker.linesFor("notification_send_health").some((l) => l["resolved_ambiguous_this_tick"] === 1));
        await assertNoMail(member.to);
        evidence.reading("RC-SEND", { deliveryId, final: dead.error_code });
      });
    });
  });

  // ── Invalid configuration fails safely ──────────────────────────────────────

  it("CFG: every invalid database configuration exits non-zero, quickly, without printing the credential", async () => {
    const sentinelPassword = new Secret(`itestsentinel${randomBytes(12).toString("hex")}`);

    const unset = await runUntilExit("cfg-unset", { database: { kind: "unset" } }, []);
    assert.equal(unset.exit.code, 1, "unset URL");
    assert.match(unset.output, /worker_environment_refused.*ENV_MISSING/);

    const malformed = await runUntilExit("cfg-malformed", { database: { kind: "malformed-url", password: sentinelPassword } }, [sentinelPassword]);
    assert.equal(malformed.exit.code, 1, "malformed URL");
    assert.match(malformed.output, /worker_environment_refused.*ENV_DB_URL_MALFORMED/);

    const closedPort = await findClosedLoopbackPort();
    const closed = await runUntilExit("cfg-closed-port", { database: { kind: "closed-port", port: closedPort, password: sentinelPassword } }, [sentinelPassword]);
    assert.equal(closed.exit.code, 1, "closed port");
    assert.match(closed.output, /database unavailable after 5 attempt/);
    assert.doesNotMatch(closed.output, /connected\. Polling/, "never claims to be connected");

    const started = Date.now();
    const wrong = await runUntilExit("cfg-wrong-password", { database: { kind: "wrong-password", password: sentinelPassword } }, [sentinelPassword]);
    assert.equal(wrong.exit.code, 1, "wrong password");
    assert.match(wrong.output, /28P01/);
    assert.match(wrong.output, /database unavailable after 1 attempt/, "no retry on a credential failure");
    assert.ok(Date.now() - started < 15_000, "exits promptly");
    evidence.reading("CFG", { unset: unset.exit, malformed: malformed.exit, closed: closed.exit, wrong: wrong.exit });
  });

  it("CFG-REVOKED: a credential revoked while running ends the process instead of polling forever", async () => {
    try {
      await assertNoLedgerPurgeEligible();
      const worker = startWorker(bundle, gate.verified(), normalWorker());
      await awaitWorkerSession(admin, worker);
      await worker.waitForOutput(/Kolekto worker: connected/, 15_000);
      await revokeWorkerCredential(admin);
      await admin`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${WORKER_APP_NAME} and usename = ${WORKER_DB_ROLE}`;
      const exit = await Promise.race([
        worker.exited(),
        sleep(60_000).then(() => { throw refuse("WORKER_TIMEOUT", "The worker kept polling with a revoked credential."); }),
      ]);
      evidence.storeWorkerLog("cfg-revoked", worker, runSecrets());
      assert.equal(exit.code, 1, "non-zero exit");
      assert.match(worker.output(), /giving up after 1 consecutive queue poll failure/);
      evidence.reading("CFG-REVOKED", { exit });
    } finally {
      credential = await issueWorkerCredential(admin);
    }
  });

  it("CFG-SENDER: a refused sender configuration keeps the event stage working and sends nothing (finding F-4 recorded)", async () => {
    const c = await newCommunity();
    const seeded = await seedOwnQueueMessage(admin, harness.testOwner, { community_id: c.communityId, not: "an audit message" });
    const before = (await senderState()).heartbeat;
    await withWorker("cfg-sender-refused", normalWorker({ provider: "unsupported" }), async (worker) => {
      await worker.waitForOutput(/Email sender NOT started/, 10_000);
      await until("the event stage to acknowledge the message", async () => worker.linesFor("notification_event_skipped").some((l) => l["msg_id"] === seeded));
      await sleep(5_000);
      assert.equal((await senderState()).heartbeat, before, "no send stage, no heartbeat (F-4: it never retries)");
      assert.doesNotMatch(worker.output(), /acme/, "the refused value is not echoed");
    });
  });

  // ── Least privilege ─────────────────────────────────────────────────────────

  it("LP-3: the worker role is refused everything outside its grants, and holds only the listed tables", async () => {
    const Q = "pg" + "mq";
    const DEL = "del" + "ete";
    const worker = connectAsWorkerRole(gate.verified(), credential);
    const results: { readonly statement: string; readonly code: string }[] = [];
    class Rollback extends Error {}
    const denied = async (statement: string, codes: readonly string[] = ["42501"]) => {
      let code = "ALLOWED";
      try {
        await worker.begin(async (tx) => {
          await tx.unsafe(statement);
          throw new Rollback();
        });
      } catch (error) {
        if (!(error instanceof Rollback)) code = String((error as { code?: unknown }).code);
      }
      results.push({ statement, code });
      assert.ok(codes.includes(code), `${statement} → ${code}`);
    };
    try {
      await denied(`select app.set_email_` + `sending_enabled(true)`);
      await denied(`select ${Q}.send('notification_events', '{}'::jsonb)`);
      await denied(`select ${Q}.purge_queue('notification_events')`);
      await denied(`select ${Q}.drop_queue('notification_events')`);
      await denied(`select * from ${Q}.a_notification_events limit 1`);
      await denied(`select * from ${Q}.meta limit 1`);
      await denied(`insert into ${Q}.q_notification_events (message) values ('{}')`);
      // A worker credential cannot rewrite a waiting message or falsify its age (R-3).
      await denied(`update ${Q}.q_notification_events set message = '{}'::jsonb`);
      await denied(`update ${Q}.q_notification_events set enqueued_at = now()`);
      // msg_id is GENERATED ALWAYS, so Postgres can refuse this before it reaches the privilege check.
      await denied(`update ${Q}.q_notification_events set msg_id = msg_id`, ["42501", "428C9"]);
      await denied(`${DEL} from ${Q}.a_notification_events`);
      await denied("select * from public.audit_logs limit 1");
      await denied("select * from public.users limit 1");
      await denied("select * from auth.users limit 1");
      await denied("select * from public.notification_send_attempts limit 1");
      await denied("select * from public.notification_sender_state limit 1");
      await denied("select email from public.members limit 1");
      await denied("select phone_e164 from public.members limit 1");
      await denied("select * from public.members limit 1");
      await denied("update public.notification_deliveries set status = 'dead'");
      await denied(`${DEL} from public.notification_deliveries`);
      await denied("update public.notification_events set payload = '{}'::jsonb");
      await denied(`${DEL} from public.notification_events`);
      await denied("update public.members set full_name = 'x'");
      await denied("create table public.itest_should_not_exist (id int)");
      await denied("create table app.itest_should_not_exist (id int)");
      await denied("set role postgres");
      await denied("set role service_role");
      await denied(`alter role ${WORKER_DB_ROLE} bypassrls`);
      await denied("select app.create_member('00000000-0000-0000-0000-000000000000'::uuid, 'x', '+2348000000000', null)");

      // Nothing outside this exact list can be read or written, whatever future tables do.
      const reachable = await worker.unsafe<{ t: string }[]>(
        "select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
          `where c.relkind in ('r','p','v','m') and n.nspname not in ('pg_catalog','information_schema') ` +
          "and has_schema_privilege(current_user, n.oid, 'USAGE') " +
          "and (has_any_column_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') or has_table_privilege(current_user, c.oid, 'DELETE,TRUNCATE,TRIGGER')) order by 1",
      );
      evidence.reading("LP-3 reachable relations, all", reachable.map((r) => r.t));
      // The extensions schema holds only extension-owned views, and the id default needs its gen_random_bytes.
      // The other half of R-3: what the worker really needs is still permitted. Rolled back, and matching no row.
      for (const column of ["vt", "read_ct", "headers"]) {
        await worker.begin(async (tx) => {
          await tx.unsafe(`update ${Q}.q_notification_events set ${column} = ${column} where msg_id = -1`);
          throw new Rollback();
        }).catch((error: unknown) => {
          if (!(error instanceof Rollback)) throw error;
        });
      }
      const exposed = reachable.map((r) => r.t).filter((t) => !t.startsWith("extensions."));
      assert.deepEqual(exposed, [
        // Phase 8: net._http_response and net.http_request_queue are gone from this list (F-13, itest:net-lockdown).
        `${Q}.a_notification_events`,
        `${Q}.q_notification_events`,
        "public.collections",
        "public.communities",
        "public.members",
        "public.notification_deliveries",
        "public.notification_events",
        "public.obligations",
        "public.officer_terms",
        "public.role_permissions",
      ]);
      const [identity] = await worker.unsafe<{ who: string; bypass: boolean; superuser: string }[]>(
        "select current_user::text as who, (select rolbypassrls from pg_roles where rolname = current_user) as bypass, current_setting('is_superuser') as superuser",
      );
      assert.deepEqual(identity, { who: WORKER_DB_ROLE, bypass: false, superuser: "off" });
      evidence.reading("LP-3 denied", results);
    } finally {
      await worker.end({ timeout: 2 }).catch(() => {});
    }
  });

  it("F-2: a real constraint failure's raw error carries a recipient address; the log summary does not", async () => {
    const c = await newCommunity();
    const address = scope.address();
    let raw: unknown;
    try {
      await admin.begin(async (tx) => {
        await tx`insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
          values (${c.ownerId}::uuid, ${c.communityId}::uuid, 'member.create', ${scope.eventKey()}, 'officer', ${c.ownerId}::uuid, 'member', ${c.ownerId}::uuid, '{}'::jsonb)`;
        // A sendable email row with no assurance breaks the table's check constraint.
        await tx`insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address)
          values (${c.ownerId}::uuid, ${c.communityId}::uuid, 'email', 'pending', ${address})`;
      });
    } catch (error) {
      raw = error;
    }
    assert.ok(raw !== undefined, "the insert must fail");
    assert.ok(JSON.stringify(raw, Object.getOwnPropertyNames(raw)).includes(address), "the raw error really does hold the address");
    const line = safeErrorJson(raw);
    assert.ok(!line.includes(address), "the summary does not");
    assert.ok(!line.includes("Failing row"), "and neither does it hold the row detail");
    evidence.reading("F-2", { summary: JSON.parse(line) as unknown });
  });
});
