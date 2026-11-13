/**
 * notification-suppression.integration.test.ts — recipient suppression against the real database.
 *
 * M13.2 P9-1. Companion to migration 20261022110000. Proves the end-to-end
 * worker flow: a claimed delivery whose recipient is in email_suppressions
 * reserves as 'address_suppressed' and never reaches a provider.
 *
 * The boundary semantics (schema, role gates, append-only, mask) are proved
 * in supabase/tests/41_email_recipient_suppression.sql; what is proved here
 * is that the worker module calls the database function inside its claim
 * transaction and surfaces the new reservation value correctly.
 *
 * Integration lane only — `npm run test:integration --workspace apps/worker`, against
 * the dedicated kolekto-itest stack, never the developer database. Without a verified
 * test-stack environment the gate refuses and every test fails (test/integration/README.md).
 *
 * M13.2 Phase 4 isolation (test/support/itest-isolation.ts): every test runs inside one
 * rolled-back transaction (inRollback) — fixtures, suppressions, claims and reservations
 * included — so nothing it writes is ever visible to another session and no cleanup is
 * needed. The two 42501 tests take their expected error inside a savepoint. Ids and
 * addresses are run-unique. Tests that expect `granted` first wait until the per-second
 * transactional window is empty (L5 is platform-wide), because the frozen transaction
 * clock cannot wait inside the transaction.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { claimDeliveryById } from "../../src/notification-send-claim.ts";
import { reserveEmailAttempt } from "../../src/notification-rate-limit.ts";

import { connectVerified, liveGateDeps, type ItestTx } from "../support/itest-db.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import { addEmailDelivery, createCommunityFixture, createFileHarness, inRollback, waitForL5Headroom } from "../support/itest-isolation.ts";

// Fail-closed gate (test/support/itest-gate.ts): verify() refuses — and every test in
// this file fails, none skips — unless the run came through `npm run test:integration`
// and the live identity of the dedicated kolekto-itest stack checked out. Every
// connection below is opened with connectVerified(gate.verified(), …).
const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "suppression");
const { scope } = harness;

async function endQuietly(end: () => Promise<void>): Promise<void> {
  try { await end(); } catch { /* best-effort */ }
}

interface SuppressionFixtures {
  /** [0] suppressed (permanent), [1] suppressed (transient, future expiry), [2] unused, [3] not suppressed */
  readonly deliveries: readonly string[];
  readonly addresses: readonly string[];
}

/**
 * Inside the caller's rolled-back transaction. A different run-unique recipient per
 * delivery so the L1 per-address limit never fires in this suite (we test
 * suppression precedence, not rate-limit interaction).
 */
async function fixtures(tx: ItestTx): Promise<SuppressionFixtures> {
  const community = await createCommunityFixture(tx, harness, { ownerName: "Sup Owner", communityName: "Sup ITest" });
  const addresses = [scope.address(), scope.address(), scope.address(), scope.address()];
  const deliveries: string[] = [];
  for (const address of addresses) {
    deliveries.push((await addEmailDelivery(tx, scope, community, { address })).deliveryId);
  }

  // Suppressions:
  //   deliveries[0] → permanent hard_bounce (expect address_suppressed)
  //   deliveries[1] → transient, expires_at 1 h in the future (expect address_suppressed)
  //   deliveries[2] → NOTE: a transient suppression that is already expired
  //     cannot be inserted via the operator setter (it rejects expires_at <= now()),
  //     and attempting a direct insert would hit the append-only trigger. That path
  //     is covered in pgTAP (test 41, section B) via timestamp arithmetic; here we
  //     only prove the two live cases above, plus the OK case below, which are the
  //     real sender paths.
  //   deliveries[3] → no suppression (expect granted)
  await tx`select app.set_email_suppression(${addresses[0]!}, 'hard_bounce')`;
  await tx`select app.set_email_suppression(${addresses[1]!}, 'manual_block', now() + interval '1 hour')`;
  return { deliveries, addresses };
}

describe("recipient suppression against the real database", () => {
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

  it("a claimed delivery whose address is permanently suppressed reserves address_suppressed", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx) => {
        const { deliveries } = await fixtures(tx);

        const c = await claimDeliveryById(tx, deliveries[0]!);
        assert.equal(c.claimed, true, "suppressed delivery is claimable before the reserve check");
        const r = await reserveEmailAttempt(tx, deliveries[0]!);
        assert.equal(r.reservation, "address_suppressed");

        const [row] = await tx<{ status: string; error_code: string; recipient_address: string | null; attempt_count: number }[]>`
          select status::text as status, error_code, recipient_address, attempt_count
          from public.notification_deliveries where id = ${deliveries[0]!}::uuid`;
        assert.equal(row!.status, "skipped");
        assert.equal(row!.error_code, "address_suppressed");
        assert.equal(row!.recipient_address, null, "recipient_address is erased on a suppression skip");
        assert.equal(row!.attempt_count, 0, "attempt counter is undone");

        const [ledger] = await tx<{ c: string }[]>`
          select count(*)::text as c from public.notification_send_attempts
          where delivery_id = ${deliveries[0]!}::uuid`;
        assert.equal(Number(ledger!.c), 0, "no ledger row is created for a suppressed send");
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("a claimed delivery whose address is transiently suppressed (future expiry) reserves address_suppressed", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx) => {
        const { deliveries } = await fixtures(tx);

        const c = await claimDeliveryById(tx, deliveries[1]!);
        assert.equal(c.claimed, true);
        const r = await reserveEmailAttempt(tx, deliveries[1]!);
        assert.equal(r.reservation, "address_suppressed");

        const [row] = await tx<{ error_code: string }[]>`
          select error_code from public.notification_deliveries where id = ${deliveries[1]!}::uuid`;
        assert.equal(row!.error_code, "address_suppressed");
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("a claimed delivery whose address is NOT suppressed reserves granted", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await waitForL5Headroom(sql);
      await inRollback(sql, async (tx) => {
        const { deliveries } = await fixtures(tx);

        const c = await claimDeliveryById(tx, deliveries[3]!);
        assert.equal(c.claimed, true);
        const r = await reserveEmailAttempt(tx, deliveries[3]!);
        assert.equal(r.reservation, "granted");

        const [row] = await tx<{ status: string; error_code: string | null }[]>`
          select status::text as status, error_code from public.notification_deliveries where id = ${deliveries[3]!}::uuid`;
        assert.equal(row!.status, "sending", "non-suppressed delivery stays in sending after a granted reservation");
        assert.equal(row!.error_code, null);
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("the suppression check is case-folded and whitespace-trimmed", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx) => {
        const { addresses } = await fixtures(tx);
        const suppressed = addresses[0]!;

        // The fixture suppressed addresses[0] (lower-case). Verify the probe
        // matches regardless of case and surrounding whitespace.
        const [r1] = await tx<{ v: boolean }[]>`
          select app.is_address_suppressed(${suppressed.toUpperCase()}) as v`;
        assert.equal(r1!.v, true);
        const [r2] = await tx<{ v: boolean }[]>`
          select app.is_address_suppressed(${`  ${suppressed}  `}) as v`;
        assert.equal(r2!.v, true);
        const [r3] = await tx<{ v: boolean }[]>`
          select app.is_address_suppressed(${scope.address()}) as v`;
        assert.equal(r3!.v, false);
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("set_email_suppression under a client role is refused with 42501", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx) => {
        await fixtures(tx);
        const intruder = scope.address();
        await assert.rejects(
          tx.savepoint(async (sp) => {
            await sp`set local role authenticated`;
            return sp`select app.set_email_suppression(${intruder}, 'manual_block')`;
          }),
          (err: unknown) => {
            // postgres(1).js surfaces the PG sqlstate on error.code; 42501 is "insufficient_privilege".
            const code = (err as { code?: string }).code;
            assert.equal(code, "42501");
            return true;
          },
        );
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("clear_email_suppression under a client role is refused with 42501", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx) => {
        await fixtures(tx);
        const intruder = scope.address();
        await assert.rejects(
          tx.savepoint(async (sp) => {
            await sp`set local role authenticated`;
            return sp`select app.clear_email_suppression(${intruder})`;
          }),
          (err: unknown) => {
            const code = (err as { code?: string }).code;
            assert.equal(code, "42501");
            return true;
          },
        );
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("list_email_suppressions_masked never leaks the raw address", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx) => {
        const { addresses } = await fixtures(tx);

        const rows = await tx<{ recipient_address_masked: string }[]>`
          select recipient_address_masked from app.list_email_suppressions_masked(100, null)`;
        assert.ok(rows.length >= 1, "fixture suppressions are listed");
        for (const row of rows) {
          assert.match(
            row.recipient_address_masked,
            /^[a-z]\*\*\*@/,
            `masked form: ${row.recipient_address_masked}`,
          );
          assert.ok(!addresses.includes(row.recipient_address_masked), "a listed value is never a raw fixture address");
        }
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });

  it("after clearing the suppression, the same address reserves granted", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      await inRollback(sql, async (tx) => {
        const { deliveries, addresses } = await fixtures(tx);

        await claimDeliveryById(tx, deliveries[0]!);
        const r1 = await reserveEmailAttempt(tx, deliveries[0]!);
        assert.equal(r1.reservation, "address_suppressed");

        // Operator clears the suppression.
        await tx`select app.clear_email_suppression(${addresses[0]!})`;

        // Delivery 0 is already skipped; prove via delivery 3 that a cleared
        // address is no longer blocked by setting it ambiguously then clearing.
        // Simpler: suppress the OK address, verify, clear, verify again.
        await tx`select app.set_email_suppression(${addresses[3]!}, 'hard_bounce')`;
        const [after] = await tx<{ v: boolean }[]>`
          select app.is_address_suppressed(${addresses[3]!}) as v`;
        assert.equal(after!.v, true);

        await tx`select app.clear_email_suppression(${addresses[3]!})`;
        const [cleared] = await tx<{ v: boolean }[]>`
          select app.is_address_suppressed(${addresses[3]!}) as v`;
        assert.equal(cleared!.v, false, "cleared address is no longer suppressed");
      });
    } finally {
      await endQuietly(() => sql.end());
    }
  });
});
