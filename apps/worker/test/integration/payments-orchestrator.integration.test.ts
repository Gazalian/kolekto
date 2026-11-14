/**
 * payments-orchestrator.integration.test.ts — M8.5 against the real database.
 *
 * The payment orchestrator (@kolekto/payments) driving the real payment
 * functions (20261111100100_payment_functions.sql) with FakePaymentProvider,
 * for all seven collection flows of plan §3.1: fixed dues, open amount,
 * tiered, items, ticketing, fundraiser and recurring dues. Then the failure
 * paths, checkout-key idempotency, and the sweep's capture recovery.
 *
 * Every test runs inside one transaction that is rolled back (inRollback);
 * each orchestrator call runs in its own savepoint, as it runs in its own
 * transaction in production. Run-unique ids come from the harness scope.
 * No SMTP, no pause-switch write, no queue access, no real provider: it runs
 * in `--without-smtp`.
 *
 * Not covered here, by construction: a sweep that EXPIRES an attempt. The
 * hold end is frozen on the attempt and now() does not move inside one
 * transaction, so no attempt can be past its hold in a rolled-back test.
 * Those sweep branches are unit-tested in packages/payments/test/sweep.test.ts,
 * and app.expire_payment_attempt itself in supabase/tests/52_payments.sql.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type postgres from "postgres";

import { createFakePaymentProvider, type FakePaymentProvider, type FakeScenario } from "@kolekto/adapters";
import { type PaymentDb, recordProviderTransaction } from "@kolekto/db";
import { confirmPayment, type PaymentContext, providerStatement, startCheckout, type StartCheckoutResult, sweepPaymentAttempts } from "@kolekto/payments";

import { connectVerified, liveGateDeps } from "../support/itest-db.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import { createFileHarness, inRollback } from "../support/itest-isolation.ts";
import { FLOW_NAMES, type FlowFixture, type PaymentCommunity, seedFlow, seedPaymentCommunity } from "../support/itest-payment-flows.ts";

const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "payments-orchestrator");
const { scope } = harness;

type Tx = postgres.TransactionSql<Record<string, never>>;

/** Never resolves anywhere (RFC 2606). The callback URL is only stored, never fetched. */
const APP_ORIGIN = "https://itest.kolekto.invalid";
const FAKE_SECRET = "itest-fake-webhook-secret";

function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row");
  return row;
}

/** Each orchestrator call in its own savepoint, like its own transaction in production. */
function savepointDb(tx: Tx): PaymentDb {
  return (fn) => tx.savepoint((sp) => fn(sp)) as ReturnType<typeof fn>;
}

function contextFor(tx: Tx, scenarios: Record<string, FakeScenario> = {}): PaymentContext & { provider: FakePaymentProvider } {
  return {
    db: savepointDb(tx),
    // "pending" by default: nothing reads as paid until a test completes the checkout.
    provider: createFakePaymentProvider({ webhookSecret: FAKE_SECRET, defaultScenario: "pending", scenarios }),
  };
}

async function checkout(ctx: PaymentContext, community: PaymentCommunity, flow: FlowFixture, key: string): Promise<StartCheckoutResult> {
  return startCheckout(ctx, {
    environment: "local",
    appOrigin: APP_ORIGIN,
    collectionId: flow.collectionId,
    collectionCategory: flow.category,
    collectionSlug: flow.collectionSlug,
    communitySlug: community.communitySlug,
    amountModel: flow.amountModel,
    feeBearer: flow.feeBearer,
    resolved: flow.resolved,
    memberId: flow.memberId,
    contributorName: "ITest Contributor",
    contributorEmail: scope.address(),
    contributorPhone: "+2348097771999",
    answers: {},
    attendeeNames: flow.attendeeNames,
    checkoutIdempotencyKey: key,
  });
}

function expectOk(result: StartCheckoutResult): Extract<StartCheckoutResult, { outcome: "ok" }> {
  if (result.outcome !== "ok") assert.fail(`checkout did not start: ${JSON.stringify(result)}`);
  return result;
}

interface AttemptRow {
  status: string;
  amount_kobo: string;
  contribution_kobo: string;
  total_fees_kobo: string;
  net_kobo: string;
  fee_bearer: string;
  obligation_id: string | null;
  provider_access_code: string | null;
}

async function attemptRow(tx: Tx, attemptId: string): Promise<AttemptRow> {
  return first(await tx<AttemptRow[]>`
    select status::text as status, amount_kobo::text as amount_kobo, contribution_kobo::text as contribution_kobo,
           total_fees_kobo::text as total_fees_kobo, net_kobo::text as net_kobo, fee_bearer::text as fee_bearer,
           obligation_id::text as obligation_id, provider_access_code
    from public.payment_attempts where id = ${attemptId}`);
}

async function stockByStatus(tx: Tx, attemptId: string): Promise<Record<string, number>> {
  const rows = await tx<{ status: string; units: number }[]>`
    select status::text as status, sum(quantity)::int as units from public.stock_reservations
    where attempt_id = ${attemptId} group by status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.units]));
}

describe("M8.5 payment orchestrator against the real database", () => {
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

  for (const name of FLOW_NAMES) {
    it(`${name}: checkout → fake checkout paid → callback captures exactly once`, async () => {
      const sql = connectVerified(gate.verified(), { max: 1 });
      try {
        await inRollback(sql, async (tx: Tx) => {
          const community = await seedPaymentCommunity(tx, scope);
          const flow = await seedFlow(tx, scope, community, name);
          const ctx = contextFor(tx);

          const started = expectOk(await checkout(ctx, community, flow, scope.uuid()));
          assert.equal(ctx.provider.initializeCalls.length, 1);
          assert.equal(ctx.provider.initializeCalls[0]!.amount, started.fees.totalPayable, "the provider is asked for the frozen total");
          assert.match(
            ctx.provider.initializeCalls[0]!.callbackUrl,
            new RegExp(`^${APP_ORIGIN}/${community.communitySlug}/${flow.collectionSlug}/payment/callback\\?reference=${started.reference}$`),
          );

          // The attempt is the amount lock (D-16): what the database stored equals what the domain computed.
          const attempt = await attemptRow(tx, started.attemptId);
          assert.equal(attempt.status, "initialized");
          assert.equal(attempt.amount_kobo, started.fees.totalPayable.toString());
          assert.equal(attempt.contribution_kobo, flow.resolved.amountKobo.toString());
          assert.equal(attempt.total_fees_kobo, started.fees.totalFees.toString());
          assert.equal(attempt.net_kobo, started.fees.net.toString());
          assert.equal(attempt.fee_bearer, flow.feeBearer === "contributor" ? "contributor_pays" : "community_absorbs");
          assert.equal(attempt.obligation_id, flow.obligationId);
          assert.ok(attempt.provider_access_code, "initialized attempts keep the provider's access code");
          const limitedUnits = flow.limitedLines.reduce((sum, l) => sum + l.quantity, 0);
          assert.deepEqual(await stockByStatus(tx, started.attemptId), limitedUnits > 0 ? { reserved: limitedUnits } : {});

          // The contributor came back before paying: nothing is captured, nothing is failed.
          assert.deepEqual(await confirmPayment(ctx, started.reference), { outcome: "pending" });
          assert.equal((await attemptRow(tx, started.attemptId)).status, "initialized");

          ctx.provider.completeCheckout(started.reference, "success");
          const confirmed = await confirmPayment(ctx, started.reference);
          if (confirmed.outcome !== "completed") assert.fail(`not completed: ${JSON.stringify(confirmed)}`);

          assert.equal((await attemptRow(tx, started.attemptId)).status, "completed");
          const contribution = first(await tx<{ id: string; contribution_kobo: string; total_charged_kobo: string; member_id: string | null }[]>`
            select id, contribution_kobo::text as contribution_kobo, total_charged_kobo::text as total_charged_kobo, member_id::text as member_id
            from public.contributions where attempt_id = ${started.attemptId}`);
          assert.equal(contribution.id, confirmed.contributionId);
          assert.equal(contribution.contribution_kobo, flow.resolved.amountKobo.toString());
          assert.equal(contribution.total_charged_kobo, started.fees.totalPayable.toString());
          assert.equal(contribution.member_id, flow.memberId);

          const lines = first(await tx<{ n: number }[]>`
            select count(*)::int as n from public.contribution_lines where contribution_id = ${contribution.id}`).n;
          const expectedLines = flow.resolved.lines?.length ?? flow.resolved.itemLines?.length ?? (flow.resolved.tierId ? 1 : 0);
          assert.equal(lines, expectedLines);
          assert.deepEqual(await stockByStatus(tx, started.attemptId), limitedUnits > 0 ? { converted: limitedUnits } : {});

          if (flow.obligationId) {
            const obligation = first(await tx<{ status: string }[]>`select status::text as status from public.obligations where id = ${flow.obligationId}`);
            assert.equal(obligation.status, "paid");
          }
          const intent = first(await tx<{ attendee_names: string[] }[]>`
            select i.attendee_names from public.contribution_intents i
            join public.payment_attempts a on a.intent_id = i.id where a.id = ${started.attemptId}`);
          assert.deepEqual(intent.attendee_names, flow.attendeeNames);

          // A second callback (refresh, or a webhook racing it) finds the same contribution.
          assert.deepEqual(await confirmPayment(ctx, started.reference), confirmed);
          assert.equal(first(await tx<{ n: number }[]>`select count(*)::int as n from public.contributions where attempt_id = ${started.attemptId}`).n, 1);
        });
      } finally {
        await sql.end();
      }
    });
  }

  it("declined, abandoned, mismatched and unanswered payments never become contributions", async () => {
    const sql = connectVerified(gate.verified(), { max: 1 });
    try {
      await inRollback(sql, async (tx: Tx) => {
        const community = await seedPaymentCommunity(tx, scope);
        const flow = await seedFlow(tx, scope, community, "items");
        const ctx = contextFor(tx);

        const declined = expectOk(await checkout(ctx, community, flow, scope.uuid()));
        ctx.provider.completeCheckout(declined.reference, "payment_failed");
        assert.deepEqual(await confirmPayment(ctx, declined.reference), { outcome: "failed", failureCode: "failed" });
        assert.equal((await attemptRow(tx, declined.attemptId)).status, "failed");
        assert.deepEqual(await stockByStatus(tx, declined.attemptId), { released: 2 }, "a failed payment gives its stock back");

        const abandoned = expectOk(await checkout(ctx, community, flow, scope.uuid()));
        ctx.provider.completeCheckout(abandoned.reference, "abandoned");
        assert.deepEqual(await confirmPayment(ctx, abandoned.reference), { outcome: "failed", failureCode: "abandoned" });
        assert.equal((await attemptRow(tx, abandoned.attemptId)).status, "failed");

        const mismatchKey = scope.uuid();
        const mismatch = expectOk(await checkout(ctx, community, flow, mismatchKey));
        const mismatchCtx = { ...ctx, provider: createFakePaymentProvider({ webhookSecret: FAKE_SECRET, scenarios: { [mismatch.reference]: "amount_mismatch" } }) };
        // The mismatch fake must know what was asked, so it initializes the same reference first.
        await mismatchCtx.provider.initialize(ctx.provider.initializeCalls.at(-1)!);
        const parked = await confirmPayment(mismatchCtx, mismatch.reference);
        assert.equal(parked.outcome, "needs_review");
        assert.equal(parked.outcome === "needs_review" ? parked.reason : null, "amount_mismatch");
        assert.equal((await attemptRow(tx, mismatch.attemptId)).status, "needs_review");

        const timeout = expectOk(await checkout(ctx, community, flow, scope.uuid()));
        const timeoutCtx = { ...ctx, provider: createFakePaymentProvider({ webhookSecret: FAKE_SECRET, defaultScenario: "verify_timeout" }) };
        const unanswered = await confirmPayment(timeoutCtx, timeout.reference);
        assert.equal(unanswered.outcome, "provider_unavailable", "a timeout is not a failure (D-27)");
        assert.equal((await attemptRow(tx, timeout.attemptId)).status, "initialized");

        const contributions = first(await tx<{ n: number }[]>`
          select count(*)::int as n from public.contributions where collection_id = ${flow.collectionId}`).n;
        assert.equal(contributions, 0);
      });
    } finally {
      await sql.end();
    }
  });

  it("a checkout key resumes its own attempt, and refuses a different order", async () => {
    const sql = connectVerified(gate.verified(), { max: 1 });
    try {
      await inRollback(sql, async (tx: Tx) => {
        const community = await seedPaymentCommunity(tx, scope);
        const flow = await seedFlow(tx, scope, community, "open");
        const ctx = contextFor(tx);
        const key = scope.uuid();

        const firstTry = expectOk(await checkout(ctx, community, flow, key));
        const retry = expectOk(await checkout(ctx, community, flow, key));
        assert.equal(retry.attemptId, firstTry.attemptId, "a double-click resumes the same attempt");
        assert.equal(retry.reference, firstTry.reference);
        assert.equal(first(await tx<{ n: number }[]>`select count(*)::int as n from public.payment_attempts where collection_id = ${flow.collectionId}`).n, 1);

        const changed = await checkout(ctx, community, { ...flow, resolved: { ...flow.resolved, amountKobo: (flow.resolved.amountKobo + 100n) as typeof flow.resolved.amountKobo } }, key);
        assert.deepEqual(changed, { outcome: "db_error", code: "CHECKOUT_KEY_REUSED" });

        ctx.provider.completeCheckout(firstTry.reference, "payment_failed");
        assert.equal((await confirmPayment(ctx, firstTry.reference)).outcome, "failed");
        assert.deepEqual(await checkout(ctx, community, flow, key), { outcome: "checkout_ended" }, "a spent key cannot start a second payment");
      });
    } finally {
      await sql.end();
    }
  });

  it("the sweep finishes a capture whose second step never ran, and leaves held attempts alone", async () => {
    const sql = connectVerified(gate.verified(), { max: 1 });
    try {
      await inRollback(sql, async (tx: Tx) => {
        const community = await seedPaymentCommunity(tx, scope);
        const flow = await seedFlow(tx, scope, community, "fixed");
        const ticketing = await seedFlow(tx, scope, community, "ticketing");
        const ctx = contextFor(tx);

        // T1 recorded the money, then the process died before T2.
        const paid = expectOk(await checkout(ctx, community, flow, scope.uuid()));
        ctx.provider.completeCheckout(paid.reference, "success");
        const verified = await ctx.provider.verify(paid.reference);
        if (verified.outcome !== "ok") assert.fail("fake verify failed");
        const t1 = await recordProviderTransaction(ctx.db, providerStatement(verified.value));
        assert.equal(t1.status, "captured");

        // Still inside its 30-minute hold: not the sweep's business yet.
        const held = expectOk(await checkout(ctx, community, ticketing, scope.uuid()));

        const report = await sweepPaymentAttempts(ctx, { limit: 1000 });
        const mine = report.outcomes.filter((o) => o.reference === paid.reference || o.reference === held.reference);
        assert.deepEqual(mine, [{ reference: paid.reference, outcome: "completed" }]);
        assert.equal((await attemptRow(tx, paid.attemptId)).status, "completed");
        assert.equal(first(await tx<{ status: string }[]>`select status::text as status from public.obligations where id = ${flow.obligationId}`).status, "paid");
        assert.equal((await attemptRow(tx, held.attemptId)).status, "initialized");
        assert.deepEqual(await stockByStatus(tx, held.attemptId), { reserved: 1 });

        // Running it again changes nothing.
        const again = await sweepPaymentAttempts(ctx, { limit: 1000 });
        assert.deepEqual(again.outcomes.filter((o) => o.reference === paid.reference || o.reference === held.reference), []);
      });
    } finally {
      await sql.end();
    }
  });
});
