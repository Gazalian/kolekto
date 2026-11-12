/**
 * orchestrator.ts — the single coordinator for all payment flows.
 *
 * One orchestrator for all seven collection types (§4.3, Q1). It calls the
 * domain for fee calculation, the DB for attempt creation and capture, and the
 * provider for initialization and verification. Nothing else in the app talks
 * to the payment DB functions directly.
 *
 * Lives in its own package so the web app (checkout, callback) and the worker
 * (the sweep) run the same code. Nothing here reads process.env or opens a
 * connection: the caller passes the database executor, the environment and
 * the app origin, so a test can run it inside a rolled-back transaction.
 *
 * SERVER ONLY. Every value here is server-derived.
 */

import { createHash } from "node:crypto";

import type { PaymentProvider, ProviderTransaction } from "@kolekto/adapters";
import type { KolektoEnvironment } from "@kolekto/config";
import {
  completePaymentCapture,
  createPaymentAttempt,
  DatabaseError,
  markPaymentAttemptFailed,
  markPaymentAttemptInitialized,
  type PaymentDb,
  recordProviderTransaction,
  type RecordProviderTransactionInput,
} from "@kolekto/db";
import {
  type AmountModel,
  calculateFees,
  type FeeBearer,
  type FeeBreakdown,
  generatePaymentReference,
  type ResolvedContribution,
} from "@kolekto/domain";

// ── Types ───────────────────────────────────────────────────────────────────

/** Where and how the orchestrator runs. Passed in, never read from the environment. */
export interface PaymentContext {
  db: PaymentDb;
  provider: PaymentProvider;
}

export interface StartCheckoutInput {
  /** From `loadConfig().environment`. The fake provider is refused in production. */
  environment: KolektoEnvironment;
  /** From `resolveAppOrigin`. Null refuses the checkout: no callback URL can be built. */
  appOrigin: string | null;
  collectionId: string;
  collectionCategory: string;
  collectionSlug: string;
  communitySlug: string;
  amountModel: AmountModel;
  feeBearer: FeeBearer;
  resolved: ResolvedContribution;
  memberId: string | null;
  contributorName: string;
  contributorEmail: string;
  contributorPhone: string;
  answers: Record<string, unknown>;
  attendeeNames: string[];
  checkoutIdempotencyKey: string;
}

export type StartCheckoutResult =
  | { outcome: "ok"; attemptId: string; reference: string; checkoutUrl: string; fees: FeeBreakdown }
  /** The checkout key belongs to an attempt that failed or expired. The client must start a new checkout. */
  | { outcome: "checkout_ended" }
  /** The checkout key belongs to an attempt the provider already took money for. */
  | { outcome: "already_paid" }
  | { outcome: "db_error"; code: string }
  | { outcome: "provider_refused" }
  /** The provider did not answer. The attempt stays `created`; retrying with the same key resumes it (D-27). */
  | { outcome: "provider_unavailable"; reason: string }
  | { outcome: "misconfigured"; reason: string };

export type ConfirmPaymentResult =
  | { outcome: "completed"; contributionId: string }
  | { outcome: "needs_review"; attemptId: string; reason: string | null }
  | { outcome: "pending" }
  | { outcome: "failed"; failureCode: string }
  | { outcome: "not_found" }
  | { outcome: "provider_unavailable"; reason: string }
  /** Something Kolekto did not expect. Nothing was marked failed; the sweep will check again. */
  | { outcome: "error"; code: string };

// ── Checkout ────────────────────────────────────────────────────────────────

/**
 * The `p_lines` argument. Only tier and item collections take lines; every
 * other model must send null or the database refuses with LINES_NOT_EXPECTED.
 * The database re-derives prices from these ids, so only id and quantity go.
 */
function buildLines(amountModel: AmountModel, resolved: ResolvedContribution): unknown[] | null {
  if (amountModel === "tiers") {
    if (resolved.lines) return resolved.lines.map((line) => ({ tier_id: line.tierId, quantity: line.quantity }));
    if (resolved.tierId) return [{ tier_id: resolved.tierId, quantity: 1 }];
    return null;
  }
  if (amountModel === "items") {
    if (resolved.itemLines) return resolved.itemLines.map((line) => ({ item_id: line.itemId, quantity: line.quantity }));
    if (resolved.itemId) return [{ item_id: resolved.itemId, quantity: resolved.quantity ?? 1 }];
    return null;
  }
  return null;
}

/**
 * The origin the provider sends the contributor back to, from APP_BASE_URL.
 * Never guessed outside local, and https outside local.
 */
export function resolveAppOrigin(environment: KolektoEnvironment, raw: string | undefined): string | null {
  if (!raw) return environment === "local" ? "http://localhost:3000" : null;
  try {
    const url = new URL(raw);
    if (environment !== "local" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function startCheckout(ctx: PaymentContext, input: StartCheckoutInput): Promise<StartCheckoutResult> {
  if (ctx.provider.name === "fake" && input.environment === "production") {
    return { outcome: "misconfigured", reason: "fake_provider_in_production" };
  }
  const origin = input.appOrigin;
  if (!origin) return { outcome: "misconfigured", reason: "app_base_url_missing_or_invalid" };

  const fees = calculateFees({
    amount: input.resolved.amountKobo,
    category: input.collectionCategory,
    bearer: input.feeBearer,
  });

  let attempt;
  try {
    attempt = await createPaymentAttempt(ctx.db, {
      collectionId: input.collectionId,
      checkoutIdempotencyKey: input.checkoutIdempotencyKey,
      reference: generatePaymentReference(),
      provider: ctx.provider.name,
      memberId: input.memberId,
      contributorName: input.contributorName,
      contributorEmail: input.contributorEmail,
      contributorPhone: input.contributorPhone,
      answers: input.answers,
      attendeeNames: input.attendeeNames,
      lines: buildLines(input.amountModel, input.resolved),
      openAmountKobo: input.amountModel === "open_amount" ? input.resolved.amountKobo : null,
      contributionKobo: fees.contribution,
      platformFeeKobo: fees.platformFee,
      gatewayFeeKobo: fees.gatewayFee,
      vatKobo: fees.vat,
      totalFeesKobo: fees.totalFees,
      totalPayableKobo: fees.totalPayable,
      netKobo: fees.net,
      providerCostEstimateKobo: fees.providerCostEstimate,
      feeBearer: fees.bearer === "contributor" ? "contributor_pays" : "community_absorbs",
      feeScheduleVersion: fees.scheduleVersion,
    });
  } catch (error) {
    if (error instanceof DatabaseError) return { outcome: "db_error", code: error.code };
    throw error;
  }

  // A reused key returns the earlier attempt with its own reference. The
  // database has already checked that its contribution, total and member equal
  // this request's, so `fees` here equals the frozen breakdown (D-16).
  if (attempt.status === "failed" || attempt.status === "expired") return { outcome: "checkout_ended" };
  if (attempt.status !== "created" && attempt.status !== "initialized") return { outcome: "already_paid" };

  // Initialization is idempotent on the reference, so a reused attempt gets
  // the same checkout back rather than a second charge.
  const providerResult = await ctx.provider.initialize({
    reference: attempt.reference,
    amount: fees.totalPayable,
    currency: "NGN",
    callbackUrl: `${origin}/${encodeURIComponent(input.communitySlug)}/${encodeURIComponent(input.collectionSlug)}/payment/callback?reference=${encodeURIComponent(attempt.reference)}`,
    contributorEmail: input.contributorEmail,
    metadata: { collection_id: input.collectionId },
    subaccountCode: null,
  });

  if (providerResult.outcome === "ok") {
    await markPaymentAttemptInitialized(ctx.db, attempt.attempt_id, providerResult.value.providerAccessCode);
    return {
      outcome: "ok",
      attemptId: attempt.attempt_id,
      reference: attempt.reference,
      checkoutUrl: providerResult.value.checkoutUrl,
      fees,
    };
  }

  if (providerResult.outcome === "refused") {
    await markPaymentAttemptFailed(ctx.db, attempt.attempt_id, providerResult.providerCode ?? "initialization_refused");
    return { outcome: "provider_refused" };
  }

  // unknown, or not_found on an initialize: we do not know whether a checkout
  // exists, so the attempt is left `created` for a retry or the sweep (D-27).
  return {
    outcome: "provider_unavailable",
    reason: providerResult.outcome === "unknown" ? providerResult.reason : "initialize_not_found",
  };
}

// ── Verification + capture ──────────────────────────────────────────────────

export async function confirmPayment(ctx: PaymentContext, reference: string): Promise<ConfirmPaymentResult> {
  const verifyResult = await ctx.provider.verify(reference);

  if (verifyResult.outcome === "not_found") return { outcome: "not_found" };
  if (verifyResult.outcome === "unknown") return { outcome: "provider_unavailable", reason: verifyResult.reason };
  // A refused verify says nothing about the money; nothing is marked.
  if (verifyResult.outcome === "refused") return { outcome: "error", code: "verify_refused" };

  return recordAndCapture(ctx.db, verifyResult.value);
}

/**
 * What the provider said, as T1 stores it. The one place this mapping lives,
 * so no caller can store the card authorization itself: it is a reusable
 * charge token, and only its SHA-256 is kept (O-12).
 */
export function providerStatement(tx: ProviderTransaction): RecordProviderTransactionInput {
  return {
    reference: tx.providerReference,
    provider: tx.provider,
    providerTransactionId: tx.providerTransactionId,
    providerReference: tx.providerReference,
    statusMapped: tx.status,
    statusRaw: tx.providerStatusRaw,
    amountKobo: tx.amount,
    currency: tx.currency,
    providerFeeKobo: tx.providerFee,
    paidAt: tx.paidAt,
    channel: tx.channel,
    authorizationHash:
      tx.authorizationReference !== null ? createHash("sha256").update(tx.authorizationReference, "utf8").digest("hex") : null,
    payload: tx.rawPayload,
  };
}

export async function recordAndCapture(db: PaymentDb, tx: ProviderTransaction): Promise<ConfirmPaymentResult> {
  // T1: record what the provider said. The database moves the attempt
  // (captured / failed / needs_review) or, for pending, keeps it as evidence only.
  let recorded;
  try {
    recorded = await recordProviderTransaction(db, providerStatement(tx));
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (error.code === "UNKNOWN_PAYMENT_REFERENCE") return { outcome: "not_found" };
      return { outcome: "error", code: error.code };
    }
    throw error;
  }

  if (recorded.status === "needs_review") {
    return { outcome: "needs_review", attemptId: recorded.attempt_id, reason: recorded.review_reason };
  }
  if (recorded.status === "captured" || recorded.status === "completed") {
    return capture(db, recorded.attempt_id);
  }
  if (tx.status === "pending") return { outcome: "pending" };
  if (recorded.status === "failed" || recorded.status === "expired") {
    return { outcome: "failed", failureCode: tx.status };
  }
  // Still created/initialized after a non-success statement: nothing is known yet.
  return { outcome: "pending" };
}

/** T2. Idempotent: a completed attempt returns the contribution it already produced. */
export async function capture(db: PaymentDb, attemptId: string): Promise<ConfirmPaymentResult> {
  let captured;
  try {
    captured = await completePaymentCapture(db, attemptId);
  } catch (error) {
    if (error instanceof DatabaseError) return { outcome: "error", code: error.code };
    throw error;
  }

  if (captured.status === "completed" && captured.contribution_id) {
    return { outcome: "completed", contributionId: captured.contribution_id };
  }
  if (captured.status === "needs_review") {
    return { outcome: "needs_review", attemptId, reason: captured.review_reason };
  }
  return { outcome: "error", code: `capture_left_${captured.status}` };
}
