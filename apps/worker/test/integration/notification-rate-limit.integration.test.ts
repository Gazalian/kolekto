/**
 * notification-rate-limit.integration.test.ts — rate limits against the real database.
 *
 * Proves what pgTAP cannot: two workers on REAL connections racing one
 * address produce exactly one grant. The boundary semantics themselves
 * (L1/L2/L3, backlog, purge, append-only) are proved in
 * supabase/tests/38; what is proved here is that the worker module calls
 * the database functions inside a transaction, and that advisory locks
 * serialise concurrent workers end to end.
 *
 * Integration lane only — `npm run test:integration --workspace apps/worker`, against
 * the dedicated kolekto-itest stack, never the developer database. Without a verified
 * test-stack environment the gate refuses and every test fails (test/integration/README.md).
 *
 * M13.2 Phase 4 isolation (test/support/itest-isolation.ts):
 *   - every id and address is run-unique (createRunScope); nothing is deleted;
 *   - tests 1 and 3 run inside one rolled-back transaction (inRollback); their ledger
 *     fillers go through insertLedgerFillers, which refuses any handle that could commit;
 *   - test 2 needs two committed sessions. Its two earlier attempts on the address are
 *     REAL paced reservations (claim + reserve + settle), not inserted ledger rows, and
 *     the race starts only once the per-second window is empty (waitForL5Headroom);
 *   - the file holds the suite mutex, each test starts with no open email row anywhere,
 *     and afterEach quarantines this run's open rows (dead / itest_quarantined).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { claimDeliveryById, settleDelivery } from "../../src/notification-send-claim.ts";
import { reserveEmailAttempt } from "../../src/notification-rate-limit.ts";

import { connectVerified, liveGateDeps, type ItestSql, type ItestTx } from "../support/itest-db.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import {
  addEmailDelivery,
  createCommunityFixture,
  createFileHarness,
  inRollback,
  insertLedgerFillers,
  waitForL5Headroom,
  type Db,
} from "../support/itest-isolation.ts";

// Fail-closed gate (test/support/itest-gate.ts): verify() refuses — and every test in
// this file fails, none skips — unless the run came through `npm run test:integration`
// and the live identity of the dedicated kolekto-itest stack checked out. Every
// connection below is opened with connectVerified(gate.verified(), …).
const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "rate-limit");
const { scope } = harness;

class Rollback extends Error {}

async function endQuietly(end: () => Promise<void>): Promise<void> {
  try { await end(); } catch { /* best-effort */ }
}

/** One owner, one community, four pending deliveries to one run-unique address. */
async function fixtures(db: Db) {
  const community = await createCommunityFixture(db, harness, { ownerName: "RL Owner", communityName: "RL ITest" });
  const address = scope.address();
  const deliveries: string[] = [];
  for (let i = 0; i < 4; i++) {
    deliveries.push((await addEmailDelivery(db, scope, community, { address })).deliveryId);
  }
  return { communityId: community.communityId, address, deliveries };
}

describe("rate limits against the real database", () => {
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

  it("claim+reserve in a transaction grants, then skips at L1", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx: ItestTx) => {
        const { communityId, address, deliveries } = await fixtures(tx);

        // P9-3 added L5 (1 transactional reservation per second, platform-wide).
        // Three real claim+reserves back-to-back would trip L5 on the 2nd, so
        // this test seeds the first three attempts as historical ledger rows
        // (outside the 1-s L5 window but inside the 24-h L1 window) — inside this
        // rolled-back transaction only — marks their deliveries terminal, and only
        // drives the 4th through claim+reserve for real. L1 should refuse it.
        const ages = [30, 20, 10];
        for (let i = 0; i < 3; i++) {
          await insertLedgerFillers(tx, scope, { deliveryId: deliveries[i]!, communityId }, [{ addressKey: address, secondsAgo: ages[i]! }]);
        }
        await tx`update public.notification_deliveries
          set status = 'sent', attempt_count = 1
          where id in (${deliveries[0]!}::uuid, ${deliveries[1]!}::uuid, ${deliveries[2]!}::uuid)`;

        const c = await claimDeliveryById(tx, deliveries[3]!);
        assert.equal(c.claimed, true);
        const r4 = await reserveEmailAttempt(tx, deliveries[3]!);
        assert.equal(r4.reservation, "address_limited");

        const [row] = await tx<{ status: string; error_code: string }[]>`
          select status::text as status, error_code
          from public.notification_deliveries where id = ${deliveries[3]!}::uuid`;
        assert.equal(row!.status, "skipped");
        assert.equal(row!.error_code, "recipient_rate_limited");
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("two concurrent workers serialize on the advisory lock", async () => {
    const sql = connectVerified(gate.verified(), { max: 6 });
    try {
      const { address, deliveries } = await fixtures(sql);
      assert.ok(address);

      // Two REAL earlier attempts on the address (L1 cap 3 per 24 h → one slot left),
      // each paced past the per-second window. No ledger row is inserted by hand.
      for (const id of [deliveries[2]!, deliveries[3]!]) {
        await waitForL5Headroom(sql);
        const prior = await sql.begin(async (raw) => {
          const tx = raw as unknown as ItestTx;
          const claim = await claimDeliveryById(tx, id);
          assert.equal(claim.claimed, true);
          return { claim, reservation: await reserveEmailAttempt(tx, id) };
        });
        assert.equal(prior.reservation.reservation, "granted", "an earlier attempt on the address is granted");
        const settled = await settleDelivery(sql, id, prior.claim.leaseToken!, "sent", { providerMessageId: "FAKE_EMAIL_RL_PRIOR" });
        assert.equal(settled.settled, true);
      }
      await waitForL5Headroom(sql);

      const a = connectVerified(gate.verified(), { max: 1 });
      const b = connectVerified(gate.verified(), { max: 1 });
      try {
        const [ra, rb] = await Promise.all([
          a.begin(async (raw) => {
            const tx = raw as unknown as ItestTx;
            await claimDeliveryById(tx, deliveries[0]!);
            return reserveEmailAttempt(tx, deliveries[0]!);
          }),
          b.begin(async (raw) => {
            const tx = raw as unknown as ItestTx;
            await claimDeliveryById(tx, deliveries[1]!);
            return reserveEmailAttempt(tx, deliveries[1]!);
          }),
        ]);
        const granted = [ra, rb].filter((r) => r.reservation === "granted").length;
        const limited = [ra, rb].filter((r) => r.reservation === "address_limited").length;
        assert.equal(granted, 1, "exactly one worker gets the last slot");
        assert.equal(limited, 1, "exactly one worker is rate-limited");
      } finally {
        await endQuietly(() => a.end());
        await endQuietly(() => b.end());
      }
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("a rolled-back reservation leaves no ledger row", async () => {
    const sql: ItestSql = connectVerified(gate.verified(), { max: 2 });
    try {
      // The reservation below must be granted, so the per-second window must be empty first.
      await waitForL5Headroom(sql);
      await inRollback(sql, async (tx: ItestTx) => {
        const { deliveries } = await fixtures(tx);
        // A savepoint stands in for the reservation's own transaction: it is rolled
        // back, and the outer (also rolled-back) transaction then inspects the result.
        await tx
          .savepoint(async (sp) => {
            await claimDeliveryById(sp, deliveries[0]!);
            const r = await reserveEmailAttempt(sp, deliveries[0]!);
            assert.equal(r.reservation, "granted");
            throw new Rollback();
          })
          .catch((err: unknown) => {
            if (!(err instanceof Rollback)) throw err;
          });

        const [ledger] = await tx<{ c: number }[]>`
          select count(*)::int as c from public.notification_send_attempts
          where delivery_id = ${deliveries[0]!}::uuid`;
        assert.equal(ledger!.c, 0, "no ledger row after rollback");

        const [row] = await tx<{ status: string; attempt_count: number }[]>`
          select status::text as status, attempt_count
          from public.notification_deliveries where id = ${deliveries[0]!}::uuid`;
        assert.equal(row!.status, "pending", "delivery still pending after rollback");
        assert.equal(row!.attempt_count, 0, "attempt not consumed after rollback");
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });
});
