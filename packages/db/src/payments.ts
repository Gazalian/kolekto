/**
 * payments.ts — typed callers for the payment functions in
 * 20261111100100_payment_functions.sql.
 *
 * Every function here uses `withOwnerConnection`: the payment functions are
 * SECURITY DEFINER with EXECUTE revoked from public/anon/authenticated, so
 * they can only run as the connection's owner role. This is the operator-
 * session idiom described in that migration's header.
 *
 * Pattern differs from write.ts (which uses `withCallerContext`). Payment
 * functions are server-only, never caller-impersonated — they guard internally
 * via `app.assert_payment_operator_session()`.
 *
 * bigint values are passed as strings to postgres.js templates: the driver
 * maps JS strings to SQL text which Postgres then coerces to bigint via the
 * function's parameter type. Passing a JS bigint directly is not supported
 * by the driver's tagged-template type.
 *
 * jsonb values go in as `${JSON.stringify(x)}::text::jsonb`. A bare `::jsonb`
 * cast makes the driver serialise the already-serialised string again, and
 * Postgres stores a JSON string instead of the object or array.
 */

import { DatabaseError, runWrite, withOwnerConnection } from "./client.ts";

export { DatabaseError };

export type PaymentAttemptStatus =
  | "created"
  | "initialized"
  | "failed"
  | "expired"
  | "captured"
  | "needs_review"
  | "completed";

// ── Create attempt ──────────────────────────────────────────────────────────

export interface CreatePaymentAttemptInput {
  collectionId: string;
  checkoutIdempotencyKey: string;
  reference: string;
  provider: string;
  memberId: string | null;
  contributorName: string;
  contributorEmail: string;
  contributorPhone: string;
  answers: Record<string, unknown>;
  attendeeNames: string[];
  /** Tier and item collections only; null for every other amount model. */
  lines: unknown[] | null;
  openAmountKobo: bigint | null;
  contributionKobo: bigint;
  platformFeeKobo: bigint;
  gatewayFeeKobo: bigint;
  vatKobo: bigint;
  totalFeesKobo: bigint;
  totalPayableKobo: bigint;
  netKobo: bigint;
  providerCostEstimateKobo: bigint;
  feeBearer: string;
  feeScheduleVersion: string;
}

export interface CreatePaymentAttemptResult {
  attempt_id: string;
  reference: string;
  status: PaymentAttemptStatus;
  amount_kobo: string;
  provider_access_code: string | null;
  reused: boolean;
}

export async function createPaymentAttempt(
  input: CreatePaymentAttemptInput,
): Promise<CreatePaymentAttemptResult> {
  const openAmount = input.openAmountKobo !== null ? input.openAmountKobo.toString() : null;
  // SQL NULL, not the jsonb value 'null'.
  const lines = input.lines !== null ? JSON.stringify(input.lines) : null;
  const rows = await runWrite(() =>
    withOwnerConnection(async (tx) => {
      return tx<CreatePaymentAttemptResult[]>`
        select * from app.create_payment_attempt(
          ${input.collectionId},
          ${input.checkoutIdempotencyKey},
          ${input.reference},
          ${input.provider},
          ${input.memberId},
          ${input.contributorName},
          ${input.contributorEmail},
          ${input.contributorPhone},
          ${JSON.stringify(input.answers)}::text::jsonb,
          ${input.attendeeNames}::text[],
          ${lines}::text::jsonb,
          ${openAmount}::bigint,
          ${input.contributionKobo.toString()}::bigint,
          ${input.platformFeeKobo.toString()}::bigint,
          ${input.gatewayFeeKobo.toString()}::bigint,
          ${input.vatKobo.toString()}::bigint,
          ${input.totalFeesKobo.toString()}::bigint,
          ${input.totalPayableKobo.toString()}::bigint,
          ${input.netKobo.toString()}::bigint,
          ${input.providerCostEstimateKobo.toString()}::bigint,
          ${input.feeBearer}::fee_mode,
          ${input.feeScheduleVersion}
        )
      ` as Promise<CreatePaymentAttemptResult[]>;
    }),
  );
  return rows[0]!;
}

// ── Mark initialized ────────────────────────────────────────────────────────

export async function markPaymentAttemptInitialized(
  attemptId: string,
  accessCode: string | null,
): Promise<PaymentAttemptStatus> {
  const rows = await runWrite(() =>
    withOwnerConnection(async (tx) => {
      return tx<{ mark_payment_attempt_initialized: PaymentAttemptStatus }[]>`
        select app.mark_payment_attempt_initialized(${attemptId}, ${accessCode})
      ` as Promise<{ mark_payment_attempt_initialized: PaymentAttemptStatus }[]>;
    }),
  );
  return rows[0]!.mark_payment_attempt_initialized;
}

// ── Mark failed ─────────────────────────────────────────────────────────────

export async function markPaymentAttemptFailed(
  attemptId: string,
  failureCode: string,
): Promise<PaymentAttemptStatus> {
  const rows = await runWrite(() =>
    withOwnerConnection(async (tx) => {
      return tx<{ mark_payment_attempt_failed: PaymentAttemptStatus }[]>`
        select app.mark_payment_attempt_failed(${attemptId}, ${failureCode})
      ` as Promise<{ mark_payment_attempt_failed: PaymentAttemptStatus }[]>;
    }),
  );
  return rows[0]!.mark_payment_attempt_failed;
}

// ── Expire ──────────────────────────────────────────────────────────────────

export async function expirePaymentAttempt(
  attemptId: string,
): Promise<PaymentAttemptStatus> {
  const rows = await runWrite(() =>
    withOwnerConnection(async (tx) => {
      return tx<{ expire_payment_attempt: PaymentAttemptStatus }[]>`
        select app.expire_payment_attempt(${attemptId})
      ` as Promise<{ expire_payment_attempt: PaymentAttemptStatus }[]>;
    }),
  );
  return rows[0]!.expire_payment_attempt;
}

// ── Record provider transaction (T1) ────────────────────────────────────────

export interface RecordProviderTransactionInput {
  reference: string;
  provider: string;
  providerTransactionId: string;
  providerReference: string;
  statusMapped: string;
  statusRaw: string;
  amountKobo: bigint;
  currency: string;
  providerFeeKobo: bigint | null;
  paidAt: Date | null;
  channel: string | null;
  authorizationHash: string | null;
  payload: unknown;
}

export interface RecordProviderTransactionResult {
  attempt_id: string;
  status: PaymentAttemptStatus;
  review_reason: string | null;
}

export async function recordProviderTransaction(
  input: RecordProviderTransactionInput,
): Promise<RecordProviderTransactionResult> {
  const providerFee = input.providerFeeKobo !== null ? input.providerFeeKobo.toString() : null;
  const rows = await runWrite(() =>
    withOwnerConnection(async (tx) => {
      return tx<RecordProviderTransactionResult[]>`
        select * from app.record_provider_transaction(
          ${input.reference},
          ${input.provider},
          ${input.providerTransactionId},
          ${input.providerReference},
          ${input.statusMapped},
          ${input.statusRaw},
          ${input.amountKobo.toString()}::bigint,
          ${input.currency},
          ${providerFee}::bigint,
          ${input.paidAt},
          ${input.channel},
          ${input.authorizationHash},
          ${JSON.stringify(input.payload)}::text::jsonb
        )
      ` as Promise<RecordProviderTransactionResult[]>;
    }),
  );
  return rows[0]!;
}

// ── Complete capture (T2) ───────────────────────────────────────────────────

export interface CompleteCaptureResult {
  contribution_id: string;
  status: PaymentAttemptStatus;
  review_reason: string | null;
}

export async function completePaymentCapture(
  attemptId: string,
): Promise<CompleteCaptureResult> {
  const rows = await runWrite(() =>
    withOwnerConnection(async (tx) => {
      return tx<CompleteCaptureResult[]>`
        select * from app.complete_payment_capture(${attemptId})
      ` as Promise<CompleteCaptureResult[]>;
    }),
  );
  return rows[0]!;
}
