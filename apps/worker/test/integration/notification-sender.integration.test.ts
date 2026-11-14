/**
 * notification-sender.integration.test.ts — the sender runtime end to end.
 *
 * Drives the sender module against the REAL database with the deterministic
 * FakeEmailProvider, proving the whole claim → reserve → commit → send →
 * resolve path, the retry policy, crash recovery, the pause switch and the
 * 72-hour expiry — the things a unit test with a fake database cannot.
 * No SMTP: the provider is always FakeEmailProvider.
 *
 * Integration lane only — `npm run test:integration --workspace apps/worker`, against
 * the dedicated kolekto-itest stack, never the developer database. Without a verified
 * test-stack environment the gate refuses and every test fails (test/integration/README.md).
 *
 * M13.2 Phase 4 isolation (test/support/itest-isolation.ts):
 *   - Every id, slug, event key and address is run-unique (createRunScope). Nothing is
 *     deleted: no trigger is touched, no ledger or event row is removed.
 *   - Committed tests (the sender commits the claim before every provider call by design)
 *     use the REAL, unscoped claim. They cannot take another test's row because the file
 *     holds the suite mutex, every test starts only when no pending or sending email row
 *     exists anywhere in the test database, and afterEach quarantines this run's open rows
 *     (dead / itest_quarantined). Each asserts the claimed delivery id is its own.
 *   - L5 (1 transactional reservation per second, platform-wide) is respected, not
 *     bypassed: before every reservation that must be granted, waitForL5Headroom polls the
 *     server clock until the per-second window is empty. The former ledger wipe is gone.
 *   - Deferral (L2/L4/L5), pause, expiry and maintenance tests run inside one rolled-back
 *     transaction (inRollback); their ledger fillers go through insertLedgerFillers, which
 *     refuses any handle that could commit. There they prove the reservation outcome and
 *     the row state; the sender's mapping of a deferral to `outcome: "deferred"` with no
 *     provider call is covered by notification-sender.test.ts with a fake connection.
 *   - A paused tick and maintenance run on the rolled-back handle, so their heartbeat
 *     write never lands.
 *
 * The pause switch is never written (approval checklist R11′): the gate asserts it reads
 * exactly `false` before and after this file. The "switch ON → tick drains" path therefore
 * has no database test; notification-sender.test.ts covers it with a fake connection
 * (accepted coverage gap, checklist §8).
 *
 * D3, E6 and E7 (claim eligibility, no provider call) moved here from the sender-to-Mailpit
 * file in Phase 4, so that file holds only tests that open SMTP connections.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { FakeEmailProvider } from "@kolekto/adapters";

import { claimDeliveryById, claimNextDelivery } from "../../src/notification-send-claim.ts";
import { reserveEmailAttempt } from "../../src/notification-rate-limit.ts";
import { buildEmailMessage } from "../../src/notification-send-message.ts";
import {
  healthLogLine,
  recoverExpiredLeases,
  runSenderTick,
  sendOneClaimed,
  type SenderOptions,
  type TickOptions,
} from "../../src/notification-sender.ts";
import {
  expireStaleDeliveries,
  isEmailSendingEnabled,
  loadSendContext,
  readSendHealth,
} from "../../src/notification-sender-state.ts";

import { connectVerified, liveGateDeps, type ItestSql, type ItestTx } from "../support/itest-db.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import {
  addEmailDelivery,
  createCommunityFixture,
  createFileHarness,
  inRollback,
  insertLedgerFillers,
  readDelivery,
  waitForL5Headroom,
  type CommunityFixture,
  type Db,
  type DeliveryOpts,
} from "../support/itest-isolation.ts";

// Fail-closed gate (test/support/itest-gate.ts): verify() refuses — and every test in
// this file fails, none skips — unless the run came through `npm run test:integration`
// and the live identity of the dedicated kolekto-itest stack checked out. Every
// connection below is opened with connectVerified(gate.verified(), …).
const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "sender");
const { scope } = harness;

type Sql = ItestSql;

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

/** The sender runtime functions take a base connection; on a rolled-back handle they behave the same. */
const asBase = (tx: ItestTx) => tx as unknown as Sql;

/** One run-unique owner and community. Committed when `db` is the pool, rolled back when it is a transaction. */
function base(db: Db): Promise<CommunityFixture> {
  return createCommunityFixture(db, harness, { ownerName: "Sender Owner", communityName: "Sender ITest" });
}

/** Insert one event + one email delivery (created 6 h ago unless stated), returning the delivery id. */
async function addDelivery(db: Db, community: CommunityFixture, opts: DeliveryOpts = {}): Promise<string> {
  return (await addEmailDelivery(db, scope, community, { ageHours: 6, ...opts })).deliveryId;
}

/** Make a deferred/retrying delivery due now, so the next claim picks it up. */
async function makeDue(sql: Sql, id: string): Promise<void> {
  await sql`update public.notification_deliveries
    set next_retry_at = now() - interval '1 minute' where id = ${id}::uuid`;
}

/** Real L5 pacing: wait for the per-second window to empty, then send. Never deletes ledger rows. */
async function pacedSend(sql: Sql, provider: FakeEmailProvider) {
  await waitForL5Headroom(sql);
  return sendOneClaimed(sql, senderOpts(provider));
}

/**
 * What an `outcome: "empty"` cannot say on its own: WHY nothing was claimed.
 *
 * sendOneClaimed reports "empty" for a row whose state rules it out and, once the claim enforces the pause
 * switch (docs/database/proposals/M13.2-FINAL-pause-switch-enforcement.proposed.sql), for any row at all
 * while sending is paused. A test asserting only "empty" would then pass while proving nothing. These two
 * make the cause explicit, on a rolled-back handle, so no lease or attempt survives.
 */
async function assertClaimableNow(sql: Sql, id: string): Promise<void> {
  await inRollback(sql, async (tx) => {
    const control = await claimNextDelivery(tx);
    assert.equal(control.reason, "claimed", "control: while pending, this row IS claimable under the same switch state");
    assert.equal(control.deliveryId, id);
  });
}

async function assertNothingDue(sql: Sql): Promise<void> {
  await inRollback(sql, async (tx) => {
    const claim = await claimNextDelivery(tx);
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "empty", "the row's state ruled it out, not the pause switch");
  });
}

async function withSql<T>(fn: (sql: Sql) => Promise<T>, maxConns = 2): Promise<T> {
  const sql = connectVerified(gate.verified(), { max: maxConns });
  try {
    return await fn(sql);
  } finally {
    try { await sql.end(); } catch { /* best-effort */ }
  }
}

describe("email sender runtime against the real database", () => {
  before(async () => {
    await gate.verify();
    await harness.start();
  });
  beforeEach(() => harness.checkpoint());
  afterEach(() => harness.quarantineOwn());
  after(async () => {
    try {
      await harness.finish();
    } finally {
      await gate.postflight();
    }
  });

  it("sends a pending delivery and records it as sent", async () => {
    await withSql(async (sql) => {
      const c = await base(sql);
      const id = await addDelivery(sql, c);
      const provider = new FakeEmailProvider();

      const step = await pacedSend(sql, provider);
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
      const c = await base(sql);
      const id = await addDelivery(sql, c);
      const provider = new FakeEmailProvider();

      const first = await pacedSend(sql, provider);
      assert.equal(first.outcome, "sent");
      assert.equal(first.outcome === "sent" && first.deliveryId, id);

      // No ledger clearing: a sent row is terminal, so the replay's claim finds
      // nothing and sendOneClaimed returns before it reserves.
      const replay = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(replay.outcome, "empty", "a sent row is terminal and never re-claimed");
      assert.equal(provider.outbox.length, 1, "exactly one message delivered");
      assert.equal((await readDelivery(sql, id)).status, "sent");
    });
  });

  it("permanent failure → dead with that code, one call only", async () => {
    await withSql(async (sql) => {
      const c = await base(sql);
      const id = await addDelivery(sql, c);
      const provider = new FakeEmailProvider();
      provider.enqueue({ type: "permanent", code: "provider_rejected_permanent" });

      const step = await pacedSend(sql, provider);
      assert.equal(step.outcome, "dead");
      assert.equal(step.outcome === "dead" && step.deliveryId, id);
      assert.equal(step.outcome === "dead" && step.errorCode, "provider_rejected_permanent");
      assert.equal(provider.attempts, 1);

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "dead");
      assert.equal(row.error_code, "provider_rejected_permanent");
    });
  });

  it("transient failure retries with a ~5-minute next_retry_at, then succeeds", async () => {
    await withSql(async (sql) => {
      const c = await base(sql);
      const id = await addDelivery(sql, c);
      const provider = new FakeEmailProvider();
      provider.enqueue({ type: "transient", code: "provider_unreachable" });

      await waitForL5Headroom(sql);
      const beforeMs = Date.now();
      const first = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(first.outcome, "retry");
      assert.equal(first.outcome === "retry" && first.deliveryId, id);

      const afterRetry = await readDelivery(sql, id);
      assert.equal(afterRetry.status, "pending");
      assert.equal(afterRetry.error_code, "provider_unreachable");
      assert.equal(afterRetry.attempt_count, 1, "a consumed attempt is never refunded");
      assert.ok(afterRetry.next_retry_at, "next_retry_at is set");
      const delayMs = Date.parse(afterRetry.next_retry_at!) - beforeMs;
      // 5 minutes ±20%, with slack for test execution time.
      assert.ok(delayMs >= 4 * 60_000 && delayMs <= 6 * 60_000 + 30_000, `delay ${delayMs}ms`);

      await makeDue(sql, id);
      const second = await pacedSend(sql, provider);
      assert.equal(second.outcome, "sent");
      const sent = await readDelivery(sql, id);
      assert.equal(sent.status, "sent");
      assert.equal(sent.attempt_count, 2);
      assert.equal(provider.outbox.length, 1);
    });
  });

  it("retry exhaustion → dead/retries_exhausted after exactly 3 calls, never a 4th", async () => {
    await withSql(async (sql) => {
      const c = await base(sql);
      const id = await addDelivery(sql, c);
      const provider = new FakeEmailProvider();
      provider.enqueue(
        { type: "transient", code: "provider_rejected_transient" },
        { type: "transient", code: "provider_rejected_transient" },
        { type: "transient", code: "provider_rejected_transient" },
      );

      const s1 = await pacedSend(sql, provider);
      assert.equal(s1.outcome, "retry");
      assert.equal(s1.outcome === "retry" && s1.deliveryId, id);
      await makeDue(sql, id);

      const s2 = await pacedSend(sql, provider);
      assert.equal(s2.outcome, "retry");
      await makeDue(sql, id);

      const s3 = await pacedSend(sql, provider);
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
      const c = await base(sql);
      const id = await addDelivery(sql, c);
      const provider = new FakeEmailProvider({ idempotency: "provider" });
      provider.enqueue({ type: "transient", code: "provider_timeout" }); // ambiguous by default

      const s1 = await pacedSend(sql, provider);
      assert.equal(s1.outcome, "retry", "ambiguous + provider idempotency is retried");
      assert.equal(s1.outcome === "retry" && s1.deliveryId, id);
      await makeDue(sql, id);

      const s2 = await pacedSend(sql, provider);
      assert.equal(s2.outcome, "sent");
      assert.equal(provider.attempts, 2, "two calls, same key");
      assert.equal(provider.outbox.length, 1, "provider de-duplicates to one message");
      assert.equal(provider.outbox[0]!.idempotencyKey, id);
    });
  });

  it("ambiguous outcome WITHOUT idempotency → dead/outcome_unknown, never retried", async () => {
    await withSql(async (sql) => {
      const c = await base(sql);
      const id = await addDelivery(sql, c);
      const provider = new FakeEmailProvider({ idempotency: "none" });
      provider.enqueue({ type: "transient", code: "provider_timeout" }); // ambiguous

      const step = await pacedSend(sql, provider);
      assert.equal(step.outcome, "dead");
      assert.equal(step.outcome === "dead" && step.deliveryId, id);
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

  it("rate-limit deferral: a community over L2 defers at reservation, consuming no attempt", async () => {
    await withSql(async (sql) => {
      await inRollback(sql, async (tx) => {
        const c = await base(tx);
        const id = await addDelivery(tx, c);

        // Fill the community's rolling hour to the L2 cap (100) with a different address,
        // inside this rolled-back transaction only.
        const filler = scope.address();
        await insertLedgerFillers(tx, scope, { deliveryId: id, communityId: c.communityId },
          Array.from({ length: 100 }, (_, i) => ({ addressKey: filler, secondsAgo: i + 1 })));

        const claim = await claimDeliveryById(tx, id);
        assert.equal(claim.claimed, true);
        const r = await reserveEmailAttempt(tx, id);
        assert.equal(r.reservation, "community_deferred");
        assert.ok(r.retryAt, "a retry time is set");

        const row = await readDelivery(tx, id);
        assert.equal(row.status, "pending");
        assert.ok(row.next_retry_at, "deferred rows carry a next_retry_at");
        assert.equal(row.attempt_count, 0, "a deferral consumes no attempt");
        assert.equal(row.send_lease_token, null, "the lease is released");
      });
    });
  });

  it("L5 defers a per-second-cap breach with a short retry, consuming no attempt (P9-3)", async () => {
    await withSql(async (sql) => {
      await inRollback(sql, async (tx) => {
        const c = await base(tx);
        const id = await addDelivery(tx, c);

        // One recent transactional reservation fills L5 (cap 1/s/class), inside this
        // rolled-back transaction only.
        await insertLedgerFillers(tx, scope, { deliveryId: id, communityId: c.communityId },
          [{ addressKey: scope.address(), secondsAgo: 0 }]);

        const before = Date.now();
        const claim = await claimDeliveryById(tx, id);
        assert.equal(claim.claimed, true);
        const r = await reserveEmailAttempt(tx, id);
        assert.equal(r.reservation, "provider_rate_limited");
        assert.ok(r.retryAt, "L5 defer sets a retry time");

        const row = await readDelivery(tx, id);
        assert.equal(row.status, "pending");
        assert.equal(row.attempt_count, 0, "L5 defer consumes no attempt");
        // The reservation uses the Postgres server's now() (the transaction start),
        // which can drift from the JS Date.now() captured in `before` (observed
        // skew: hundreds of ms in either direction on a loaded local stack).
        // 1 s + random 0–200 ms (SQL side) therefore lands anywhere in
        // [-500, 3000] ms from JS's point of view. We still prove it is a
        // bounded, short defer and not an open-ended one.
        const delayMs = Date.parse(row.next_retry_at!) - before;
        assert.ok(delayMs <= 3000, `L5 schedule within ~1s + jitter (${delayMs}ms)`);
        assert.ok(
          Date.parse(row.next_retry_at!) > Date.parse(new Date(before - 60_000).toISOString()),
          `L5 schedule is not an ancient time (${row.next_retry_at})`,
        );
      });
    });
  });

  it("L4 defers a per-class daily-cap breach to the oldest counted attempt + 24 h, keeping the address (P9-3)", async () => {
    await withSql(async (sql) => {
      await inRollback(sql, async (tx) => {
        const c = await base(tx);
        const address = scope.address();
        const id = await addDelivery(tx, c, { address });

        // Fill L4 (cap 180/24h/transactional), inside this rolled-back transaction only.
        // Spread across 23h so L2 (same community, 1h window) and L3 (platform, 1h
        // window) stay well under their own caps.
        await insertLedgerFillers(tx, scope, { deliveryId: id, communityId: c.communityId },
          Array.from({ length: 180 }, (_, i) => ({ addressKey: scope.address(), secondsAgo: Math.floor(((i + 1) * 23 * 60) / 180) * 60 })));

        const before = Date.now();
        const claim = await claimDeliveryById(tx, id);
        assert.equal(claim.claimed, true);
        const r = await reserveEmailAttempt(tx, id);
        assert.equal(r.reservation, "provider_daily_limited");

        const row = await readDelivery(tx, id);
        assert.equal(row.status, "pending");
        assert.equal(row.attempt_count, 0, "L4 defer consumes no attempt");
        assert.equal(row.recipient_address, address, "L4 defer keeps the recipient address (it is only waiting its turn)");

        // next_retry_at is exactly the oldest counted transactional attempt + 24 h. The
        // oldest filler is 23 h old, so it lands at most ~1 h away; committed attempts
        // left by earlier runs on the test stack can only be older, moving it closer.
        const [expected] = await tx<{ at: string }[]>`
          select min(attempted_at) + interval '24 hours' as at from public.notification_send_attempts
          where send_class = 'transactional' and attempted_at > now() - interval '24 hours'`;
        assert.equal(Date.parse(row.next_retry_at!), Date.parse(expected!.at), "deferred to the oldest counted attempt + 24 h");
        const delayMs = Date.parse(row.next_retry_at!) - before;
        assert.ok(delayMs > 0 && delayMs <= 90 * 60_000, `L4 schedules in the future, within ~1h (${delayMs}ms)`);
      });
    });
  });

  it("recovers a crashed worker's expired lease back to pending", async () => {
    await withSql(async (sql) => {
      const c = await base(sql);
      const id = await addDelivery(sql, c);

      // Simulate a worker that claimed the row and then died: claim it, then
      // push its lease into the past (a crash leaves the lease to lapse).
      const claim = await claimDeliveryById(sql, id);
      assert.equal(claim.claimed, true);
      await sql`update public.notification_deliveries
        set send_lease_expires_at = now() - interval '1 second' where id = ${id}::uuid`;

      const counts = await recoverExpiredLeases(sql, "provider");
      assert.ok(counts.recovered >= 1);

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "pending", "expired lease returns to pending");
      assert.equal(row.send_lease_token, null, "the old token is cleared so it can never settle");
      assert.equal(row.attempt_count, 1, "the attempt stays consumed");

      // The recovered row is claimable again and sends cleanly (safe replay).
      const provider = new FakeEmailProvider();
      const step = await pacedSend(sql, provider);
      assert.equal(step.outcome, "sent");
      assert.equal(step.outcome === "sent" && step.deliveryId, id);
      assert.equal((await readDelivery(sql, id)).attempt_count, 2);
      assert.equal(provider.outbox.length, 1);
    });
  });

  it("P9-4: non-idempotent provider sends an expired lease to dead/outcome_unknown instead of pending", async () => {
    await withSql(async (sql) => {
      const c = await base(sql);
      const id = await addDelivery(sql, c);

      // Simulate the crash-after-accept window: claim the row and lapse
      // its lease without ever recording an outcome.
      const claim = await claimDeliveryById(sql, id);
      assert.equal(claim.claimed, true);
      await sql`update public.notification_deliveries
        set send_lease_expires_at = now() - interval '1 second' where id = ${id}::uuid`;

      // Recovery under a non-idempotent provider must NOT return the row
      // to pending (that would risk a second send against a provider that
      // cannot dedupe); it marks it dead/outcome_unknown for an operator.
      const counts = await recoverExpiredLeases(sql, "none");
      assert.equal(counts.recovered, 0, "nothing routed back to pending");
      assert.ok(counts.resolvedAmbiguous >= 1, "the row resolved as ambiguous");

      const row = await readDelivery(sql, id);
      assert.equal(row.status, "dead");
      assert.equal(row.error_code, "outcome_unknown");
      assert.equal(row.send_lease_token, null, "the old token is cleared (old holder cannot settle)");
      assert.equal(row.attempt_count, 1, "the attempt stays consumed");
      assert.equal(row.provider_message_id, null, "no provider id was recorded (crash before accept)");

      // No subsequent claim can pick the row up — a dead row is terminal.
      await assertNothingDue(sql);
      const provider = new FakeEmailProvider();
      const step = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(step.outcome, "empty");
      assert.equal(provider.attempts, 0, "no provider call ever happens for a resolved-ambiguous row");
    });
  });

  // R11′: only the paused half runs against the database. The switch is already
  // off (the gate refused otherwise); the enabled half ("switch ON → the tick
  // drains the row") is covered by notification-sender.test.ts with a fake
  // connection, never by turning the switch on. The tick runs on a rolled-back
  // handle, so its heartbeat write never lands.
  it("paused: runSenderTick claims nothing and preserves the queued row", async () => {
    await withSql(async (sql) => {
      await inRollback(sql, async (tx) => {
        const c = await base(tx);
        const id = await addDelivery(tx, c);
        const provider = new FakeEmailProvider();

        assert.equal(await isEmailSendingEnabled(tx), false);

        const paused = await runSenderTick(asBase(tx), tickOpts(provider));
        assert.equal(paused.paused, true);
        assert.equal(paused.steps.length, 0, "nothing claimed while paused");
        assert.equal(provider.attempts, 0);
        assert.equal((await readDelivery(tx, id)).status, "pending", "the queued row is preserved");
      });
    });
  });

  it("72-hour expiry turns a stale pending row into dead/event_too_old; a sending row is untouched", async () => {
    await withSql(async (sql) => {
      await inRollback(sql, async (tx) => {
        const c = await base(tx);
        const fresh = await addDelivery(tx, c, { ageHours: 71 });
        const stale = await addDelivery(tx, c, { ageHours: 73 });

        // A sending row older than 72h must NOT be expired (only pending ages out).
        const sendingStale = await addDelivery(tx, c, { ageHours: 1 });
        const claim = await claimDeliveryById(tx, sendingStale);
        assert.equal(claim.claimed, true);
        await tx`update public.notification_deliveries
          set created_at = now() - interval '100 hours' where id = ${sendingStale}::uuid`;

        const expired = await expireStaleDeliveries(tx, 72);
        assert.ok(expired >= 1);

        assert.equal((await readDelivery(tx, stale)).status, "dead");
        assert.equal((await readDelivery(tx, stale)).error_code, "event_too_old");
        assert.equal((await readDelivery(tx, fresh)).status, "pending", "a 71h row is still within its life");
        assert.equal((await readDelivery(tx, sendingStale)).status, "sending", "an in-flight row is never expired by age");
      });
    });
  });

  it("maintenance (lease recovery, expiry) runs even while paused", async () => {
    await withSql(async (sql) => {
      await inRollback(sql, async (tx) => {
        const c = await base(tx);
        const stale = await addDelivery(tx, c, { ageHours: 80 });
        const provider = new FakeEmailProvider();

        assert.equal(await isEmailSendingEnabled(tx), false, "precondition: sending is paused");
        const tick = await runSenderTick(asBase(tx), tickOpts(provider, { runMaintenance: true }));

        assert.equal(tick.paused, true);
        assert.ok(tick.expired >= 1, "expiry ran while paused");
        assert.equal(provider.attempts, 0, "no sends while paused");
        assert.equal((await readDelivery(tx, stale)).status, "dead");
        assert.equal((await readDelivery(tx, stale)).error_code, "event_too_old");
      });
    });
  });

  it("health output reflects outcomes and leaks no recipient address", async () => {
    await withSql(async (sql) => {
      const c = await base(sql);
      const sentId = await addDelivery(sql, c);
      const deadId = await addDelivery(sql, c);
      const provider = new FakeEmailProvider();
      provider.enqueue({ type: "permanent", code: "provider_rejected_permanent" });

      // The permanent-failure row is the older one, so it is claimed first.
      await sql`update public.notification_deliveries set created_at = now() - interval '10 hours' where id = ${deadId}::uuid`;
      const dead = await pacedSend(sql, provider);
      assert.equal(dead.outcome, "dead");
      assert.equal(dead.outcome === "dead" && dead.deliveryId, deadId);
      const sent = await pacedSend(sql, provider);
      assert.equal(sent.outcome, "sent");
      assert.equal(sent.outcome === "sent" && sent.deliveryId, sentId);

      const health = await readSendHealth(sql);
      assert.ok(health.sent24h >= 1);
      assert.ok(health.dead24h >= 1);
      assert.ok((health.deadByCode["provider_rejected_permanent"] ?? 0) >= 1);
      assert.ok(health.lastHeartbeatAt === null || typeof health.lastHeartbeatAt === "string");

      // Redaction: the serialised health line contains no recipient address.
      const line = JSON.stringify(healthLogLine(health, { recovered: 0, resolvedAmbiguous: 0, expired: 0, purged: 0 }));
      assert.ok(!line.includes("@sender.example.test"), "health log must not contain an address");
    });
  });

  // ── Moved from the sender-to-Mailpit file (Phase 4): no SMTP, no provider call ──
  describe("claim eligibility (no provider call)", () => {
    it("D3: loadSendContext returns event type and payload for a row in the sending state (lease simulated)", async () => {
      await withSql(async (sql) => {
        await inRollback(sql, async (tx) => {
          const c = await base(tx);
          const address = scope.address();
          const id = await addDelivery(tx, c, {
            address,
            ageHours: 0,
            eventType: "member.approve_join",
            payload: {
              actor_name: "P8 Owner",
              community_id: c.communityId,
              member_name: "Approved Person",
              member_code: "P8/042",
              community_name: "P8 Integration Test",
              community_slug: c.slug,
            },
          });

          // Simulate claim: set to sending so loadSendContext can read it
          const fakeLeaseToken = "a".repeat(64);
          await tx`update public.notification_deliveries
            set status = 'sending', send_lease_token = ${fakeLeaseToken}, send_lease_expires_at = now() + interval '5 minutes'
            where id = ${id}::uuid`;

          const ctx = await loadSendContext(tx, id);
          assert.ok(ctx, "loadSendContext returned a context");
          assert.equal(ctx.address, address, "address matches");
          assert.equal(ctx.eventType, "member.approve_join", "event type is correct");
          assert.ok(ctx.payload, "payload is present");
          assert.equal(ctx.payload["member_code"], "P8/042", "payload member_code is correct");
          assert.equal(ctx.payload["community_name"], "P8 Integration Test", "payload community_name is correct");

          // Verify the correct template is selected
          const message = buildEmailMessage(ctx.address, { eventType: ctx.eventType, payload: ctx.payload });
          assert.ok(message.subject.includes("approved to join"), "template selected member.approve_join verb");
          assert.ok(message.html, "HTML body generated");
          assert.ok(message.html!.includes("P8/042"), "HTML includes member code");
        });
      });
    });

    it("E6: a skipped row is never claimed and the provider is never called", async () => {
      await withSql(async (sql) => {
        const c = await base(sql);

        // Create a pending delivery, then update to skipped with no address
        // (the skipped constraint requires address IS NULL for skipped email deliveries)
        const id = await addDelivery(sql, c, { ageHours: 0 });
        await assertClaimableNow(sql, id);
        await sql`update public.notification_deliveries
          set status = 'skipped', recipient_address = null, recipient_address_assurance = null, error_code = 'address_suppressed'
          where id = ${id}::uuid`;
        await assertNothingDue(sql);

        // A fake provider proves "no provider call" directly (review §4.2).
        const provider = new FakeEmailProvider();
        const step = await sendOneClaimed(sql, senderOpts(provider));
        assert.equal(step.outcome, "empty", "skipped deliveries are not claimed");
        assert.equal(provider.attempts, 0, "the provider was never called");

        const row = await readDelivery(sql, id);
        assert.equal(row.status, "skipped", "the row stays skipped");
        assert.equal(row.attempt_count, 0, "no attempt was consumed");
      });
    });

    it("E7: a dead row is never claimed", async () => {
      await withSql(async (sql) => {
        const c = await base(sql);

        // Create as pending, then update to dead with required error_code
        const id = await addDelivery(sql, c, { ageHours: 0 });
        await assertClaimableNow(sql, id);
        await sql`update public.notification_deliveries
          set status = 'dead', error_code = 'max_attempts_exceeded'
          where id = ${id}::uuid`;
        await assertNothingDue(sql);

        const provider = new FakeEmailProvider();
        const step = await sendOneClaimed(sql, senderOpts(provider));
        assert.equal(step.outcome, "empty", "dead deliveries are terminal");
        assert.equal(provider.attempts, 0, "the provider was never called");
        assert.equal((await readDelivery(sql, id)).status, "dead");
      });
    });
  });
});
