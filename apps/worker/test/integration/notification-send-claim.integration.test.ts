/**
 * notification-send-claim.integration.test.ts — claims against the real database.
 *
 * Proves what pgTAP cannot: two workers on REAL connections racing one
 * delivery produce exactly one owner. Everything else (lock-and-recheck
 * semantics, token gating, recovery, the attempt cap) is proved in
 * supabase/tests/37 and re-asserted here end to end through the worker
 * module under test.
 *
 * Integration lane only — `npm run test:integration --workspace apps/worker`, against
 * the dedicated kolekto-itest stack, never the developer database. Without a verified
 * test-stack environment the gate refuses and every test fails (test/integration/README.md).
 *
 * M13.2 Phase 4 isolation (test/support/itest-isolation.ts):
 *   - every id, slug, event key and address is run-unique (createRunScope); nothing is deleted;
 *   - the race test commits (concurrent sessions cannot see uncommitted rows); the other two
 *     run inside one rolled-back transaction (inRollback), the claim rollback in a savepoint;
 *   - the unscoped claim_next assertions ("only RACE is due, then empty") hold because the
 *     file holds the suite mutex and every test starts with no pending or sending email row
 *     anywhere in the test database; afterEach quarantines this run's open rows.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  claimDeliveryById,
  claimNextDelivery,
  recoverExpiredLease,
  settleDelivery,
} from "../../src/notification-send-claim.ts";

import { connectVerified, liveGateDeps, type ItestTx } from "../support/itest-db.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import { addEmailDelivery, createCommunityFixture, createFileHarness, inRollback, type Db } from "../support/itest-isolation.ts";

// Fail-closed gate (test/support/itest-gate.ts): verify() refuses — and every test in
// this file fails, none skips — unless the run came through `npm run test:integration`
// and the live identity of the dedicated kolekto-itest stack checked out. Every
// connection below is opened with connectVerified(gate.verified(), …).
const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "send-claim");
const { scope } = harness;

/** Cleanup must never strand an open pool (a stranded pool hangs the runner). */
async function endQuietly(end: () => Promise<void>): Promise<void> {
  try {
    await end();
  } catch {
    // Teardown is best-effort; the assertions already ran.
  }
}

interface ClaimFixtures {
  readonly RACE: string;
  readonly SINGLE: string;
  readonly SPENT: string;
  readonly TERMINAL: string;
}

// One event per delivery: the per-event recipient index treats two email
// rows with no recipient ids on the same event as the same delivery.
async function fixtures(db: Db): Promise<ClaimFixtures> {
  const community = await createCommunityFixture(db, harness, { ownerName: "Claim Owner", communityName: "Claim ITest" });
  const address = scope.address();
  const add = async (opts: { status: string; attempts: number; code: string | null }) =>
    (await addEmailDelivery(db, scope, community, {
      status: opts.status,
      attemptCount: opts.attempts,
      errorCode: opts.code,
      // A skipped email row carries no address (P2 constraint).
      address: opts.status === "skipped" ? null : address,
    })).deliveryId;
  return {
    RACE: await add({ status: "pending", attempts: 0, code: null }),
    SINGLE: await add({ status: "pending", attempts: 0, code: null }),
    SPENT: await add({ status: "pending", attempts: 3, code: null }),
    TERMINAL: await add({ status: "skipped", attempts: 0, code: "no_recipient" }),
  };
}

describe("send claims against the real database", () => {
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

  it("races two workers: exactly one owns the delivery", async () => {
    const sql = connectVerified(gate.verified(), { max: 6 });
    try {
      const { RACE } = await fixtures(sql);
      const a = connectVerified(gate.verified(), { max: 1 });
      const b = connectVerified(gate.verified(), { max: 1 });
      try {
        // Both promises are issued before either is awaited, so the two
        // sessions genuinely overlap inside the database.
        const [ra, rb] = await Promise.all([claimDeliveryById(a, RACE), claimDeliveryById(b, RACE)]);
        assert.equal([ra.claimed, rb.claimed].filter(Boolean).length, 1);
        const winner = ra.claimed ? ra : rb;
        assert.match(winner.leaseToken ?? "", /^[0-9a-f]{64}$/);
        assert.equal(winner.attemptCount, 1);

        // The loser sees the row as already claimed and reserves nothing.
        const loser = ra.claimed ? rb : ra;
        assert.equal(loser.reason, "already_claimed");
        const [row] = await sql<{ attempt_count: number }[]>`
          select attempt_count from public.notification_deliveries where id = ${RACE}::uuid`;
        assert.equal(row!.attempt_count, 1);

        // The winner's token settles; the loser's (null) token cannot.
        const settled = await settleDelivery(sql, RACE, winner.leaseToken!, "sent", {
          providerMessageId: "FAKE_EMAIL_RACE",
        });
        assert.deepEqual(settled, { settled: true, reason: "sent" });
        const replay = await settleDelivery(sql, RACE, winner.leaseToken!, "sent", {
          providerMessageId: "FAKE_EMAIL_RACE",
        });
        assert.deepEqual(replay, { settled: false, reason: "invalid_or_expired_lease" });
      } finally {
        await endQuietly(() => a.end());
        await endQuietly(() => b.end());
      }
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("gates settle and recover on the live token, caps attempts, refuses terminal rows", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx: ItestTx) => {
        const { RACE, SINGLE, SPENT, TERMINAL } = await fixtures(tx);

        const claim = await claimDeliveryById(tx, SINGLE);
        assert.equal(claim.claimed, true);

        // Recovery refuses a live lease; a wrong token settles nothing.
        assert.deepEqual(await recoverExpiredLease(tx, SINGLE), {
          recovered: false,
          reason: "lease_still_valid",
        });
        assert.deepEqual(await settleDelivery(tx, SINGLE, "wrong", "sent"), {
          settled: false,
          reason: "invalid_or_expired_lease",
        });

        // Let the lease lapse, then race recovery against the old worker: the
        // old token must lose and the row must end pending, ownable again.
        await tx`update public.notification_deliveries set send_lease_expires_at = now() - interval '1 second'
          where id = ${SINGLE}::uuid`;
        assert.deepEqual(await settleDelivery(tx, SINGLE, claim.leaseToken!, "sent"), {
          settled: false,
          reason: "invalid_or_expired_lease",
        });
        assert.deepEqual(await recoverExpiredLease(tx, SINGLE), { recovered: true, reason: "pending" });
        assert.deepEqual(await settleDelivery(tx, SINGLE, claim.leaseToken!, "sent"), {
          settled: false,
          reason: "invalid_or_expired_lease",
        });
        const again = await claimDeliveryById(tx, SINGLE);
        assert.equal(again.claimed, true);
        assert.equal(again.attemptCount, 2);
        assert.notEqual(again.leaseToken, claim.leaseToken);

        // Exhausted and terminal rows are never claimable.
        assert.equal((await claimDeliveryById(tx, SPENT)).reason, "exhausted");
        assert.equal((await claimDeliveryById(tx, TERMINAL)).reason, "terminal");

        // claim_next skips the exhausted, terminal and sending rows: only
        // RACE is due, then the queue is empty. (The unscoped claim sees no other
        // row: the harness checked that none is pending or sending before this test.)
        const next = await claimNextDelivery(tx);
        assert.equal(next.claimed, true);
        assert.equal(next.deliveryId, RACE);
        const drained = await claimNextDelivery(tx);
        assert.equal(drained.claimed, false);
        assert.equal(drained.reason, "empty");
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("rolls a claim and its attempt reservation back together", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx: ItestTx) => {
        const { SINGLE } = await fixtures(tx);
        await tx
          .savepoint(async (sp) => {
            await claimDeliveryById(sp, SINGLE);
            throw new Rollback();
          })
          .catch((err: unknown) => {
            if (!(err instanceof Rollback)) throw err;
          });
        const [row] = await tx<{ status: string; attempt_count: number }[]>`
          select status::text as status, attempt_count from public.notification_deliveries where id = ${SINGLE}::uuid`;
        assert.equal(row!.status, "pending");
        assert.equal(row!.attempt_count, 0);
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });
});

class Rollback extends Error {}
