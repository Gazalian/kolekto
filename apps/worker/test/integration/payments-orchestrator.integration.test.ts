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

import { processNotificationMessage } from "../../src/notification-processor.ts";
import { renderTemplate } from "../../src/notification-email-templates.ts";
import { connectVerified, liveGateDeps } from "../support/itest-db.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import { createFileHarness, inRollback } from "../support/itest-isolation.ts";
import { FLOW_NAMES, type FlowFixture, issueMembershipPass, type PaymentCommunity, seedFlow, seedPaymentCommunity } from "../support/itest-payment-flows.ts";

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

// M10: a managed flow needs a live membership pass, as the web reads it from its cookie.
async function passFor(tx: Tx, flow: FlowFixture): Promise<string | null> {
  return flow.memberId ? issueMembershipPass(tx, flow.collectionId, flow.memberId) : null;
}

async function checkout(tx: Tx, ctx: PaymentContext, community: PaymentCommunity, flow: FlowFixture, key: string): Promise<StartCheckoutResult> {
  const accessToken = await passFor(tx, flow);
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
    accessToken,
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

          const started = expectOk(await checkout(tx, ctx, community, flow, scope.uuid()));
          assert.equal(ctx.provider.initializeCalls.length, 1);
          assert.equal(ctx.provider.initializeCalls[0]!.amount, started.fees.totalPayable, "the provider is asked for the frozen total");
          // Since c046c41 the callback URL carries no query: the provider appends trxref/reference on redirect.
          assert.equal(
            ctx.provider.initializeCalls[0]!.callbackUrl,
            `${APP_ORIGIN}/${community.communitySlug}/${flow.collectionSlug}/payment/callback`,
          );
          assert.equal(ctx.provider.initializeCalls[0]!.reference, started.reference, "the provider is given this attempt's reference");

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

        const declined = expectOk(await checkout(tx, ctx, community, flow, scope.uuid()));
        ctx.provider.completeCheckout(declined.reference, "payment_failed");
        assert.deepEqual(await confirmPayment(ctx, declined.reference), { outcome: "failed", failureCode: "failed" });
        assert.equal((await attemptRow(tx, declined.attemptId)).status, "failed");
        assert.deepEqual(await stockByStatus(tx, declined.attemptId), { released: 2 }, "a failed payment gives its stock back");

        const abandoned = expectOk(await checkout(tx, ctx, community, flow, scope.uuid()));
        ctx.provider.completeCheckout(abandoned.reference, "abandoned");
        // Inside the 30-minute hold an abandoned checkout is still pending (20261114110000):
        // the payer may come back and pay. The sweep fails it once the hold has ended.
        assert.deepEqual(await confirmPayment(ctx, abandoned.reference), { outcome: "pending" });
        assert.equal((await attemptRow(tx, abandoned.attemptId)).status, "initialized");
        assert.deepEqual(await stockByStatus(tx, abandoned.attemptId), { reserved: 2 }, "an abandoned checkout keeps its stock during the hold");

        const mismatchKey = scope.uuid();
        const mismatch = expectOk(await checkout(tx, ctx, community, flow, mismatchKey));
        const mismatchCtx = { ...ctx, provider: createFakePaymentProvider({ webhookSecret: FAKE_SECRET, scenarios: { [mismatch.reference]: "amount_mismatch" } }) };
        // The mismatch fake must know what was asked, so it initializes the same reference first.
        await mismatchCtx.provider.initialize(ctx.provider.initializeCalls.at(-1)!);
        const parked = await confirmPayment(mismatchCtx, mismatch.reference);
        assert.equal(parked.outcome, "needs_review");
        assert.equal(parked.outcome === "needs_review" ? parked.reason : null, "amount_mismatch");
        assert.equal((await attemptRow(tx, mismatch.attemptId)).status, "needs_review");

        const timeout = expectOk(await checkout(tx, ctx, community, flow, scope.uuid()));
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

        const firstTry = expectOk(await checkout(tx, ctx, community, flow, key));
        const retry = expectOk(await checkout(tx, ctx, community, flow, key));
        assert.equal(retry.attemptId, firstTry.attemptId, "a double-click resumes the same attempt");
        assert.equal(retry.reference, firstTry.reference);
        assert.equal(first(await tx<{ n: number }[]>`select count(*)::int as n from public.payment_attempts where collection_id = ${flow.collectionId}`).n, 1);

        const changed = await checkout(tx, ctx, community, { ...flow, resolved: { ...flow.resolved, amountKobo: (flow.resolved.amountKobo + 100n) as typeof flow.resolved.amountKobo } }, key);
        assert.deepEqual(changed, { outcome: "db_error", code: "CHECKOUT_KEY_REUSED" });

        ctx.provider.completeCheckout(firstTry.reference, "payment_failed");
        assert.equal((await confirmPayment(ctx, firstTry.reference)).outcome, "failed");
        assert.deepEqual(await checkout(tx, ctx, community, flow, key), { outcome: "checkout_ended" }, "a spent key cannot start a second payment");
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
        const paid = expectOk(await checkout(tx, ctx, community, flow, scope.uuid()));
        ctx.provider.completeCheckout(paid.reference, "success");
        const verified = await ctx.provider.verify(paid.reference);
        if (verified.outcome !== "ok") assert.fail("fake verify failed");
        const t1 = await recordProviderTransaction(ctx.db, providerStatement(verified.value));
        assert.equal(t1.status, "captured");

        // Still inside its 30-minute hold: not the sweep's business yet.
        const held = expectOk(await checkout(tx, ctx, community, ticketing, scope.uuid()));

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

  it("the payer is emailed when the payment starts and gets a receipt when it completes (20261116100000)", async () => {
    const sql = connectVerified(gate.verified(), { max: 1 });
    try {
      await inRollback(sql, async (tx: Tx) => {
        const community = await seedPaymentCommunity(tx, scope);
        const flow = await seedFlow(tx, scope, community, "tiered");
        const ctx = contextFor(tx);
        const payer = scope.address();
        const started = expectOk(
          await startCheckout(ctx, {
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
            accessToken: await passFor(tx, flow),
            contributorName: "ITest Payer",
            contributorEmail: payer,
            contributorPhone: "+2348097771999",
            answers: {},
            attendeeNames: flow.attendeeNames,
            checkoutIdempotencyKey: scope.uuid(),
          }),
        );
        ctx.provider.completeCheckout(started.reference, "success");
        assert.equal((await confirmPayment(ctx, started.reference)).outcome, "completed");

        // What the notification trigger queued, rebuilt from the audit rows it reads.
        const audits = await tx<{ message: Record<string, unknown> }[]>`
          select jsonb_build_object(
                   'audit_log_id', id, 'community_id', community_id, 'action', action, 'actor_type', actor_type::text,
                   'actor_user_id', actor_user_id, 'actor_name', actor_name_snapshot, 'object_type', object_type,
                   'object_id', object_id, 'after_state', after_state, 'created_at', created_at) as message
          from public.audit_logs where object_id = ${started.attemptId} and action like 'payment.%'
          order by created_at, action`;
        assert.deepEqual(audits.map((a) => a.message["action"]).sort(), ["payment.captured", "payment.initialized"]);

        for (let round = 0; round < 2; round += 1) {
          for (const a of audits) {
            const out = await processNotificationMessage(tx as unknown as postgres.TransactionSql, a.message);
            assert.equal(out.outcome, "processed", JSON.stringify(out));
          }
        }

        const deliveries = await tx<{ event_type: string; status: string; recipient_address: string | null; assurance: string | null; dedupe_key: string | null; category: string | null; send_class: string; payload: Record<string, unknown> }[]>`
          select e.event_type, d.status::text as status, d.recipient_address, d.recipient_address_assurance as assurance,
                 d.dedupe_key, d.communication_category as category, d.send_class::text as send_class, e.payload
          from public.notification_deliveries d join public.notification_events e on e.id = d.notification_event_id
          where e.object_id = ${started.attemptId} order by e.event_type`;
        assert.equal(deliveries.length, 2, "one email per event, even after a redelivery");
        for (const d of deliveries) {
          assert.equal(d.status, "pending");
          assert.equal(d.recipient_address, payer);
          assert.equal(d.assurance, "unverified_supplied");
          assert.equal(d.category, "essential");
          assert.equal(d.send_class, "transactional");
          assert.ok(!JSON.stringify(d.payload).includes(payer), "the address never enters the event payload");
        }
        assert.deepEqual(deliveries.map((d) => d.dedupe_key), [`receipt:${started.attemptId}`, `payment_started:${started.attemptId}`]);

        const receipt = deliveries.find((d) => d.event_type === "payment.captured")!;
        const rendered = renderTemplate({ eventType: receipt.event_type, payload: receipt.payload, appBaseUrl: APP_ORIGIN })!;
        assert.ok(rendered.text.includes(`Reference: ${started.reference}`));
        assert.ok(rendered.text.includes(`/payment/receipt?reference=${started.reference}`));

        const read = first(await tx<{ receipt: Record<string, unknown> | null }[]>`select app.payment_receipt(${started.reference}) as receipt`);
        assert.equal(read.receipt?.["reference"], started.reference);
      });
    } finally {
      await sql.end();
    }
  });
});
