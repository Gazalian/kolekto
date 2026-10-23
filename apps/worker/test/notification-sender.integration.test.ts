/**
 * notification-sender.integration.test.ts — the sender runtime end to end.
 *
 * Drives the sender module against the REAL database with the deterministic
 * FakeEmailProvider, proving the whole claim → reserve → commit → send →
 * resolve path, the retry policy, crash recovery, the pause switch and the
 * 72-hour expiry — the things a unit test with a fake database cannot.
 *
 * OPT-IN, local only — the same gate as the other worker integration suites.
 * Fixtures use fixed ids in one dedicated community and are removed afterwards,
 * so a crashed run is cleaned up by the next one. Committed (not rolled back):
 * the sender commits the claim before every provider call by design.
 *
 *   KOLEKTO_WORKER_INTEGRATION=1 SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test --workspace apps/worker
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeEmailProvider } from "@kolekto/adapters";
import postgres from "postgres";

import { claimDeliveryById } from "../src/notification-send-claim.ts";
import {
  healthLogLine,
  recoverExpiredLeases,
  runSenderTick,
  sendOneClaimed,
  type SenderOptions,
  type TickOptions,
} from "../src/notification-sender.ts";
import {
  expireStaleDeliveries,
  isEmailSendingEnabled,
  readSendHealth,
  setEmailSendingEnabled,
} from "../src/notification-sender-state.ts";

const URL_ENV = process.env["SUPABASE_DB_URL"] ?? "";
const IS_LOOPBACK = (() => {
  try {
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(URL_ENV).hostname);
  } catch {
    return false;
  }
})();
const ENABLED = process.env["KOLEKTO_WORKER_INTEGRATION"] === "1" && IS_LOOPBACK;
const SKIP = ENABLED ? false : "set KOLEKTO_WORKER_INTEGRATION=1 and a loopback SUPABASE_DB_URL to run";

const OWNER = "f9000000-0000-4000-8000-000000000001";
const COMMUNITY = "f9100000-0000-4000-8000-00000000000a";

type Sql = postgres.Sql<Record<string, never>>;

// Deterministic jitter and a fixed clock-free rng for reproducible backoff.
const halfRng = () => 0.5;
const senderOpts = (provider: FakeEmailProvider): SenderOptions => ({ provider, now: () => Date.now(), rng: halfRng });
const tickOpts = (provider: FakeEmailProvider, over: Partial<TickOptions> = {}): TickOptions => ({
  provider,
  now: () => Date.now(),
  rng: halfRng,
  maxBatch: 10,
  runMaintenance: false,
  allowSend: true,
  log: () => {},
  ...over,
});

interface DeliveryRow {
  status: string;
  error_code: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  provider_message_id: string | null;
  send_lease_token: string | null;
  send_lease_expires_at: string | null;
}

async function readDelivery(sql: Sql, id: string): Promise<DeliveryRow> {
  const [row] = await sql<DeliveryRow[]>`
    select status::text as status, error_code, attempt_count,
           next_retry_at, provider_message_id, send_lease_token, send_lease_expires_at
    from public.notification_deliveries where id = ${id}::uuid
  `;
  if (!row) throw new Error(`delivery ${id} not found`);
  return row;
}

async function cleanup(sql: Sql): Promise<void> {
  await sql`alter table public.notification_send_attempts disable trigger notification_send_attempts_no_delete`;
  try {
    await sql`delete from public.notification_send_attempts where community_id = ${COMMUNITY}::uuid`;
  } finally {
    await sql`alter table public.notification_send_attempts enable trigger notification_send_attempts_no_delete`;
  }
  await sql`delete from public.notification_deliveries where community_id = ${COMMUNITY}::uuid`;
  await sql`alter table public.notification_events disable trigger notification_events_no_delete`;
  try {
    await sql`delete from public.notification_events where community_id = ${COMMUNITY}::uuid`;
  } finally {
    await sql`alter table public.notification_events enable trigger notification_events_no_delete`;
  }
  await sql`delete from public.communities where id = ${COMMUNITY}::uuid`;
  await sql`delete from public.users where id = ${OWNER}::uuid`;
  await sql`delete from auth.users where id = ${OWNER}::uuid`;
  // Leave the pause switch as the sender runtime expects to find it: off.
  await setEmailSendingEnabled(sql, false);
}

async function base(sql: Sql): Promise<void> {
  await cleanup(sql);
  await sql`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
    (${OWNER}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@sender.example.test', now())`;
  await sql`insert into public.users (id, full_name, email) values (${OWNER}, 'Sender Owner', 'owner@sender.example.test')
    on conflict (id) do update set full_name = excluded.full_name, email = excluded.email`;
  await sql`insert into public.communities (id, slug, name, type, is_personal, created_by)
    values (${COMMUNITY}, 'sender-itest', 'Sender ITest', 'social_group', false, ${OWNER})`;
}

interface SeedOpts {
  readonly address?: string;
  readonly ageHours?: number;
  readonly status?: string;
  readonly nextRetryAt?: string | null;
  readonly attemptCount?: number;
}

let seq = 0;

/** Insert one event + one email delivery, returning the delivery id. */
async function addDelivery(sql: Sql, opts: SeedOpts = {}): Promise<string> {
  seq += 1;
  const suffix = seq.toString(16).padStart(12, "0");
  const deliveryId = `f9300000-0000-4000-8000-${suffix}`;
  const eventId = `f9200000-0000-4000-8000-${suffix}`;
  const ageHours = opts.ageHours ?? 6;
  const status = opts.status ?? "pending";
  const address = opts.address ?? `member+${suffix}@sender.example.test`;

  await sql`insert into public.notification_events
    (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
    values (${eventId}::uuid, ${COMMUNITY}::uuid, 'member.create', ${"sender-itest-" + suffix},
            'officer', ${OWNER}::uuid, 'member', ${deliveryId}::uuid, '{}')`;

  await sql`insert into public.notification_deliveries
    (id, notification_event_id, community_id, channel, status,
     recipient_address, recipient_address_assurance, attempt_count, next_retry_at, created_at)
    values (${deliveryId}::uuid, ${eventId}::uuid, ${COMMUNITY}::uuid, 'email', ${status}::public.notification_delivery_status,
            ${address}, 'unverified_supplied', ${opts.attemptCount ?? 0},
            ${opts.nextRetryAt ?? null}::timestamptz, now() - make_interval(hours => ${ageHours}::int))`;

  return deliveryId;
}

/** Make a deferred/retrying delivery due now, so the next claim picks it up. */
async function makeDue(sql: Sql, id: string): Promise<void> {
  await sql`update public.notification_deliveries
    set next_retry_at = now() - interval '1 minute' where id = ${id}::uuid`;
}

function withSql<T>(fn: (sql: Sql) => Promise<T>, maxConns = 2): Promise<T> {
  const sql = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: maxConns });
  return (async () => {
    try {
      return await fn(sql);
    } finally {
      await cleanup(sql).catch(() => {});
      try { await sql.end(); } catch { /* best-effort */ }
    }
  })();
}

describe("email sender runtime against the real database", { skip: SKIP }, () => {
  it("sends a pending delivery and records it as sent", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql);
      const provider = new FakeEmailProvider();

      const step = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(step.outcome, "sent");
      assert.equal(step.outcome === "sent" && step.deliveryId, id);
      assert.equal(provider.outbox.length, 1);
      assert.equal(provider.outbox[0]!.idempotencyKey, id);

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "sent");
      assert.equal(row.error_code, null);
      assert.ok(row.provider_message_id);
      assert.equal(row.send_lease_token, null);
      assert.equal(row.attempt_count, 1);
    });
  });

  it("does not re-send a sent row on replay (no duplicate send)", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql);
      const provider = new FakeEmailProvider();

      const first = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(first.outcome, "sent");

      const replay = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(replay.outcome, "empty", "a sent row is terminal and never re-claimed");
      assert.equal(provider.outbox.length, 1, "exactly one message delivered");
      assert.equal((await readDelivery(sql, id)).status, "sent");
    });
  });

  it("permanent failure → dead with that code, one call only", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql);
      const provider = new FakeEmailProvider();
      provider.enqueue({ type: "permanent", code: "provider_rejected_permanent" });

      const step = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(step.outcome, "dead");
      assert.equal(step.outcome === "dead" && step.errorCode, "provider_rejected_permanent");
      assert.equal(provider.attempts, 1);

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "dead");
      assert.equal(row.error_code, "provider_rejected_permanent");
    });
  });

  it("transient failure retries with a ~5-minute next_retry_at, then succeeds", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql);
      const provider = new FakeEmailProvider();
      provider.enqueue({ type: "transient", code: "provider_unreachable" });

      const beforeMs = Date.now();
      const first = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(first.outcome, "retry");

      const afterRetry = await readDelivery(sql, id);
      assert.equal(afterRetry.status, "pending");
      assert.equal(afterRetry.error_code, "provider_unreachable");
      assert.equal(afterRetry.attempt_count, 1, "a consumed attempt is never refunded");
      assert.ok(afterRetry.next_retry_at, "next_retry_at is set");
      const delayMs = Date.parse(afterRetry.next_retry_at!) - beforeMs;
      // 5 minutes ±20%, with slack for test execution time.
      assert.ok(delayMs >= 4 * 60_000 && delayMs <= 6 * 60_000 + 30_000, `delay ${delayMs}ms`);

      await makeDue(sql, id);
      const second = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(second.outcome, "sent");
      const sent = await readDelivery(sql, id);
      assert.equal(sent.status, "sent");
      assert.equal(sent.attempt_count, 2);
      assert.equal(provider.outbox.length, 1);
    });
  });

  it("retry exhaustion → dead/retries_exhausted after exactly 3 calls, never a 4th", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql);
      const provider = new FakeEmailProvider();
      provider.enqueue(
        { type: "transient", code: "provider_rejected_transient" },
        { type: "transient", code: "provider_rejected_transient" },
        { type: "transient", code: "provider_rejected_transient" },
      );

      const s1 = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(s1.outcome, "retry");
      await makeDue(sql, id);

      const s2 = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(s2.outcome, "retry");
      await makeDue(sql, id);

      const s3 = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(s3.outcome, "dead");
      assert.equal(s3.outcome === "dead" && s3.errorCode, "retries_exhausted");

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "dead");
      assert.equal(row.error_code, "retries_exhausted");
      assert.equal(row.attempt_count, 3);
      assert.equal(provider.attempts, 3, "exactly three provider calls");

      // A 4th claim attempt finds nothing: the row is terminal.
      const s4 = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(s4.outcome, "empty");
      assert.equal(provider.attempts, 3, "no 4th call ever");
    });
  });

  it("ambiguous outcome with provider idempotency retries with the same key (one message)", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql);
      const provider = new FakeEmailProvider({ idempotency: "provider" });
      provider.enqueue({ type: "transient", code: "provider_timeout" }); // ambiguous by default

      const s1 = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(s1.outcome, "retry", "ambiguous + provider idempotency is retried");
      await makeDue(sql, id);

      const s2 = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(s2.outcome, "sent");
      assert.equal(provider.attempts, 2, "two calls, same key");
      assert.equal(provider.outbox.length, 1, "provider de-duplicates to one message");
      assert.equal(provider.outbox[0]!.idempotencyKey, id);
    });
  });

  it("ambiguous outcome WITHOUT idempotency → dead/outcome_unknown, never retried", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql);
      const provider = new FakeEmailProvider({ idempotency: "none" });
      provider.enqueue({ type: "transient", code: "provider_timeout" }); // ambiguous

      const step = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(step.outcome, "dead");
      assert.equal(step.outcome === "dead" && step.errorCode, "outcome_unknown");

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "dead");
      assert.equal(row.error_code, "outcome_unknown");
      assert.equal(row.attempt_count, 1);
      assert.equal(provider.attempts, 1);
      assert.equal(provider.outbox.length, 0);

      const again = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(again.outcome, "empty", "no retry");
    });
  });

  it("rate-limit deferral: a community over L2 defers, makes no provider call", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql, { address: "ratelimited@sender.example.test" });

      // Fill the community's rolling hour to the L2 cap (100) with a different address.
      await sql`insert into public.notification_send_attempts (delivery_id, community_id, address_key, attempted_at)
        select ${id}::uuid, ${COMMUNITY}::uuid, 'filler@sender.example.test', now() - (g || ' seconds')::interval
        from generate_series(1, 100) as g`;

      const provider = new FakeEmailProvider();
      const step = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(step.outcome, "deferred");
      assert.equal(step.outcome === "deferred" && step.reservation, "community_deferred");
      assert.ok(step.outcome === "deferred" && step.retryAt, "a retry time is set");
      assert.equal(provider.attempts, 0, "no provider call on a deferral");

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "pending");
      assert.ok(row.next_retry_at, "deferred rows carry a next_retry_at");
      assert.equal(row.attempt_count, 0, "a deferral consumes no attempt");
    });
  });

  it("L5 defers a per-second-cap breach with a short retry and no provider call (P9-3)", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql, { address: "l5@sender.example.test" });

      // One recent transactional reservation fills L5 (cap 1/s/class).
      await sql`insert into public.notification_send_attempts
        (delivery_id, community_id, address_key, send_class, attempted_at)
        values (${id}::uuid, ${COMMUNITY}::uuid, 'l5-filler@sender.example.test',
                'transactional', now())`;

      const provider = new FakeEmailProvider();
      const before = Date.now();
      const step = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(step.outcome, "deferred");
      assert.equal(step.outcome === "deferred" && step.reservation, "provider_rate_limited");
      assert.ok(step.outcome === "deferred" && step.retryAt, "L5 defer sets a retry time");
      assert.equal(provider.attempts, 0, "no provider call on L5 defer");

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "pending");
      assert.equal(row.attempt_count, 0, "L5 defer consumes no attempt");
      const delayMs = Date.parse(row.next_retry_at!) - before;
      assert.ok(delayMs >= 500 && delayMs <= 3000, `L5 schedule within ~1s + jitter (${delayMs}ms)`);
    });
  });

  it("L4 defers a per-class daily-cap breach, keeping the address (P9-3)", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql, { address: "l4@sender.example.test" });

      // Fill L4 (cap 180/24h/transactional). Spread across 23h so L2 (same
      // community, 1h window) and L3 (platform, 1h window) stay well under
      // their own caps.
      await sql`insert into public.notification_send_attempts
        (delivery_id, community_id, address_key, send_class, attempted_at)
        select ${id}::uuid, ${COMMUNITY}::uuid, 'l4-filler-' || g || '@sender.example.test',
               'transactional', now() - make_interval(mins => (g * 23 * 60 / 180))
        from generate_series(1, 180) as g`;

      const provider = new FakeEmailProvider();
      const before = Date.now();
      const step = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(step.outcome, "deferred");
      assert.equal(step.outcome === "deferred" && step.reservation, "provider_daily_limited");

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "pending");
      assert.equal(row.attempt_count, 0, "L4 defer consumes no attempt");
      const [addr] = await sql<{ recipient_address: string | null }[]>`
        select recipient_address from public.notification_deliveries where id = ${id}::uuid`;
      assert.equal(addr!.recipient_address, "l4@sender.example.test",
        "L4 defer keeps the recipient address (it is only waiting its turn)");
      const delayMs = Date.parse(row.next_retry_at!) - before;
      // next_retry_at should be approximately oldest_counted + 24h. The oldest
      // attempt was inserted at now() - 23h, so the deferral lands about 1h away.
      assert.ok(delayMs >= 30 * 60_000 && delayMs <= 90 * 60_000,
        `L4 schedules in ~1h (${delayMs}ms)`);
      assert.equal(provider.attempts, 0, "no provider call on L4 defer");
    });
  });

  it("recovers a crashed worker's expired lease back to pending", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql);

      // Simulate a worker that claimed the row and then died: claim it, then
      // push its lease into the past (a crash leaves the lease to lapse).
      const claim = await claimDeliveryById(sql, id);
      assert.equal(claim.claimed, true);
      await sql`update public.notification_deliveries
        set send_lease_expires_at = now() - interval '1 second' where id = ${id}::uuid`;

      const recovered = await recoverExpiredLeases(sql);
      assert.ok(recovered >= 1);

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "pending", "expired lease returns to pending");
      assert.equal(row.send_lease_token, null, "the old token is cleared so it can never settle");
      assert.equal(row.attempt_count, 1, "the attempt stays consumed");

      // The recovered row is claimable again and sends cleanly (safe replay).
      const provider = new FakeEmailProvider();
      const step = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(step.outcome, "sent");
      assert.equal((await readDelivery(sql, id)).attempt_count, 2);
      assert.equal(provider.outbox.length, 1);
    });
  });

  it("the pause switch stops new claims but preserves queued rows", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const id = await addDelivery(sql);
      const provider = new FakeEmailProvider();

      await setEmailSendingEnabled(sql, false);
      assert.equal(await isEmailSendingEnabled(sql), false);

      const paused = await runSenderTick(sql, tickOpts(provider));
      assert.equal(paused.paused, true);
      assert.equal(paused.steps.length, 0, "nothing claimed while paused");
      assert.equal(provider.attempts, 0);
      assert.equal((await readDelivery(sql, id)).status, "pending", "the queued row is preserved");

      await setEmailSendingEnabled(sql, true);
      const live = await runSenderTick(sql, tickOpts(provider));
      assert.equal(live.paused, false);
      assert.ok(live.steps.some((s) => s.outcome === "sent"));
      assert.equal((await readDelivery(sql, id)).status, "sent");
    });
  });

  it("72-hour expiry turns a stale pending row into dead/event_too_old; a sending row is untouched", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const fresh = await addDelivery(sql, { ageHours: 71 });
      const stale = await addDelivery(sql, { ageHours: 73 });

      // A sending row older than 72h must NOT be expired (only pending ages out).
      const sendingStale = await addDelivery(sql, { ageHours: 1 });
      const claim = await claimDeliveryById(sql, sendingStale);
      assert.equal(claim.claimed, true);
      await sql`update public.notification_deliveries
        set created_at = now() - interval '100 hours' where id = ${sendingStale}::uuid`;

      const expired = await expireStaleDeliveries(sql, 72);
      assert.ok(expired >= 1);

      assert.equal((await readDelivery(sql, stale)).status, "dead");
      assert.equal((await readDelivery(sql, stale)).error_code, "event_too_old");
      assert.equal((await readDelivery(sql, fresh)).status, "pending", "a 71h row is still within its life");
      assert.equal((await readDelivery(sql, sendingStale)).status, "sending", "an in-flight row is never expired by age");
    });
  });

  it("maintenance (lease recovery, expiry) runs even while paused", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const stale = await addDelivery(sql, { ageHours: 80 });
      const provider = new FakeEmailProvider();

      await setEmailSendingEnabled(sql, false);
      const tick = await runSenderTick(sql, tickOpts(provider, { runMaintenance: true }));

      assert.equal(tick.paused, true);
      assert.ok(tick.expired >= 1, "expiry ran while paused");
      assert.equal(provider.attempts, 0, "no sends while paused");
      assert.equal((await readDelivery(sql, stale)).status, "dead");
      assert.equal((await readDelivery(sql, stale)).error_code, "event_too_old");
    });
  });

  it("health output reflects outcomes and leaks no recipient address", async () => {
    await withSql(async (sql) => {
      await base(sql);
      const sentId = await addDelivery(sql, { address: "health-sent@sender.example.test" });
      const deadId = await addDelivery(sql, { address: "health-dead@sender.example.test" });
      const provider = new FakeEmailProvider();
      provider.enqueue({ type: "permanent", code: "provider_rejected_permanent" });

      // The permanent-failure row is the older one, so it is claimed first.
      await sql`update public.notification_deliveries set created_at = now() - interval '10 hours' where id = ${deadId}::uuid`;
      const dead = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(dead.outcome, "dead");
      const sent = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(sent.outcome, "sent");
      void sentId;

      const health = await readSendHealth(sql);
      assert.ok(health.sent24h >= 1);
      assert.ok(health.dead24h >= 1);
      assert.ok((health.deadByCode["provider_rejected_permanent"] ?? 0) >= 1);
      assert.ok(health.lastHeartbeatAt === null || typeof health.lastHeartbeatAt === "string");

      // Redaction: the serialised health line contains no recipient address.
      const line = JSON.stringify(healthLogLine(health, { recovered: 0, expired: 0, purged: 0 }));
      assert.ok(!line.includes("@sender.example.test"), "health log must not contain an address");
    });
  });
});
