/**
 * payments.ts — typed callers for the payment functions in
 * 20261111100100_payment_functions.sql.
 *
 * The functions are SECURITY DEFINER with EXECUTE revoked from public/anon/
 * authenticated, and refuse to run unless the session role is the
 * connection's own (`app.assert_payment_operator_session()`). So every caller
 * takes a `PaymentDb`: something that runs one call in a transaction on a
 * server-side connection with no role switch.
 *
 *   · web      `ownerPaymentDb` — the shared owner pool (`withOwnerConnection`)
 *   · worker   its own connection: `(fn) => sql.begin(fn)`
 *   · tests    a savepoint inside a rolled-back transaction
 *
 * bigint values are passed as strings with an explicit `::bigint` cast: the
 * driver's tagged-template type does not accept a JS bigint.
 *
 * jsonb values go in as `${JSON.stringify(x)}::text::jsonb`. A bare `::jsonb`
 * cast makes the driver serialise the already-serialised string again, and
 * Postgres stores a JSON string instead of the object or array.
 */

import type { TransactionSql } from "postgres";
import { DatabaseError, runWrite, withOwnerConnection } from "./client.ts";

export { DatabaseError };

/** Runs `fn` in its own transaction (or savepoint) on a connection with no role switch. */
export type PaymentDb = <T>(fn: (tx: TransactionSql) => Promise<T>) => Promise<T>;

export const ownerPaymentDb: PaymentDb = (fn) => withOwnerConnection(fn);

function call<T>(db: PaymentDb, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => db(fn));
}

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
  db: PaymentDb,
  input: CreatePaymentAttemptInput,
): Promise<CreatePaymentAttemptResult> {
  const openAmount = input.openAmountKobo !== null ? input.openAmountKobo.toString() : null;
  const lines = input.lines !== null ? JSON.stringify(input.lines) : null;
  const rows = await call(db, (tx) =>
    tx<CreatePaymentAttemptResult[]>`
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
    ` as Promise<CreatePaymentAttemptResult[]>,
  );
  return rows[0]!;
}

// ── Small transitions ───────────────────────────────────────────────────────

export async function markPaymentAttemptInitialized(
  db: PaymentDb,
  attemptId: string,
  accessCode: string | null,
): Promise<PaymentAttemptStatus> {
  const rows = await call(db, (tx) =>
    tx<{ s: PaymentAttemptStatus }[]>`
      select app.mark_payment_attempt_initialized(${attemptId}, ${accessCode}) as s
    ` as Promise<{ s: PaymentAttemptStatus }[]>,
  );
  return rows[0]!.s;
}

export async function markPaymentAttemptFailed(
  db: PaymentDb,
  attemptId: string,
  failureCode: string,
): Promise<PaymentAttemptStatus> {
  const rows = await call(db, (tx) =>
    tx<{ s: PaymentAttemptStatus }[]>`
      select app.mark_payment_attempt_failed(${attemptId}, ${failureCode}) as s
    ` as Promise<{ s: PaymentAttemptStatus }[]>,
  );
  return rows[0]!.s;
}

export async function expirePaymentAttempt(
  db: PaymentDb,
  attemptId: string,
): Promise<PaymentAttemptStatus> {
  const rows = await call(db, (tx) =>
    tx<{ s: PaymentAttemptStatus }[]>`
      select app.expire_payment_attempt(${attemptId}) as s
    ` as Promise<{ s: PaymentAttemptStatus }[]>,
  );
  return rows[0]!.s;
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
  db: PaymentDb,
  input: RecordProviderTransactionInput,
): Promise<RecordProviderTransactionResult> {
  const providerFee = input.providerFeeKobo !== null ? input.providerFeeKobo.toString() : null;
  const rows = await call(db, (tx) =>
    tx<RecordProviderTransactionResult[]>`
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
    ` as Promise<RecordProviderTransactionResult[]>,
  );
  return rows[0]!;
}

// ── Complete capture (T2) ───────────────────────────────────────────────────

export interface CompleteCaptureResult {
  contribution_id: string | null;
  status: PaymentAttemptStatus;
  review_reason: string | null;
}

export async function completePaymentCapture(
  db: PaymentDb,
  attemptId: string,
): Promise<CompleteCaptureResult> {
  const rows = await call(db, (tx) =>
    tx<CompleteCaptureResult[]>`
      select * from app.complete_payment_capture(${attemptId})
    ` as Promise<CompleteCaptureResult[]>,
  );
  return rows[0]!;
}

// ── Sweep read ──────────────────────────────────────────────────────────────

export interface DuePaymentAttempt {
  attempt_id: string;
  reference: string;
  status: PaymentAttemptStatus;
  /** Past `check_until` (24 h): a still-pending payment may now be released. */
  past_check_window: boolean;
}

/**
 * Attempts the sweep should look at: unresolved ones whose stock hold has
 * ended, and captured ones whose T2 has not completed. Read on the owner
 * connection (payment tables force RLS; no client role can read them).
 */
export async function listDuePaymentAttempts(
  db: PaymentDb,
  provider: string,
  limit: number,
): Promise<DuePaymentAttempt[]> {
  const rows = await call(db, (tx) =>
    tx<DuePaymentAttempt[]>`
      select a.id as attempt_id, a.reference, a.status, now() >= a.check_until as past_check_window
      from public.payment_attempts a
      where a.provider = ${provider}
        and ((a.status in ('created', 'initialized') and a.hold_expires_at <= now())
             or a.status = 'captured')
      order by a.hold_expires_at
      limit ${limit}
    ` as Promise<DuePaymentAttempt[]>,
  );
  return [...rows];
}
