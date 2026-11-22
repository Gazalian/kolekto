/**
 * Pure helpers for the collection's money on the Overview and Activity tabs.
 *
 * Nothing here computes a balance. Every amount arrives from the database as a
 * decimal kobo string and is only compared with "0" or shown. The withdraw
 * rules below decide which EXPLANATION to show; the database re-checks every
 * one of them (and more) when a withdrawal is actually requested.
 */

/** Who is expected to pay, as `app.collection_expected_summary` reports it. Kobo as strings. */
export interface ExpectedView {
  supported: boolean;
  expectedCount: number;
  paidCount: number;
  partlyPaidCount: number;
  unpaidCount: number;
  exemptCount: number;
  outstandingKobo: string;
  /** False when some members' amounts are unknown: outstanding is then a floor. */
  outstandingComplete: boolean;
}

/** A saved, verified payout account (masked) the withdraw dialog may offer. */
export interface PayoutAccountView {
  id: string;
  bankName: string;
  accountLast4: string;
  accountName: string;
  isDefault: boolean;
  /** D-08 cooling-off: withdrawals can go to it from this moment. */
  usableFrom: string;
}

/** Whether any account can receive a withdrawal now. Display only: the database re-checks. */
export function hasUsablePayoutAccount(accounts: PayoutAccountView[] | null, nowMs: number): boolean | null {
  if (accounts === null) return null;
  return accounts.some((a) => Date.parse(a.usableFrom) <= nowMs);
}

/** Why the officer's saved accounts cannot receive a withdrawal yet, when they have some. */
export type PayoutAccountWaiting = { kind: "under_review" } | { kind: "cooling_off"; usableFrom: string };

/**
 * Display only: a verified account still inside its D-08 cooling-off (earliest first) or, failing that,
 * an account Kolekto is reviewing. Undefined when there is nothing to wait for.
 */
export function payoutAccountWaiting(
  accounts: PayoutAccountView[] | null,
  anyUnderReview: boolean,
  nowMs: number,
): PayoutAccountWaiting | undefined {
  const cooling = (accounts ?? [])
    .filter((a) => Date.parse(a.usableFrom) > nowMs)
    .sort((a, b) => Date.parse(a.usableFrom) - Date.parse(b.usableFrom))[0];
  if (cooling) return { kind: "cooling_off", usableFrom: cooling.usableFrom };
  return anyUnderReview ? { kind: "under_review" } : undefined;
}

export type WithdrawBlock =
  /** No saved bank account that is verified and past its cooling-off (owner decision Q3, 2026-11-18). */
  | { kind: "no_payout_account"; waiting?: PayoutAccountWaiting }
  | { kind: "in_progress"; amountKobo: string }
  /** Successful payments still inside T+1, or past it but not yet settled by the provider. */
  | { kind: "settling"; nextReleaseAt: string | null; awaitingProvider: boolean }
  | { kind: "nothing_received" }
  | { kind: "empty" };

export interface WithdrawInputs {
  availableKobo: string;
  pendingKobo: string;
  totalRaisedKobo: string;
  /** Whether this officer has a verified, usable payout account. Null when it could not be read: the database still decides. */
  hasPayoutAccount: boolean | null;
  /** Saved accounts that will become usable (review or cooling-off), to explain the wait. */
  payoutAccountWaiting?: PayoutAccountWaiting | undefined;
  withdrawals: { status: string; amountKobo: string }[];
  nextReleaseAt: string | null;
  /** Pending money still before its T+1 time ("0" when none). */
  scheduledKobo?: string;
  /** Pending money past T+1 whose provider settlement is not yet recorded ("0" when none). */
  awaitingProviderKobo?: string;
}

const ACTIVE = new Set(["requested", "approved", "processing"]);

/** Why this officer cannot withdraw right now, or null when the form may open. First reason wins. */
export function withdrawBlock(input: WithdrawInputs): WithdrawBlock | null {
  const active = input.withdrawals.find((w) => ACTIVE.has(w.status));
  if (active) return { kind: "in_progress", amountKobo: active.amountKobo };
  if (input.availableKobo === "0") {
    if (input.pendingKobo !== "0") {
      // Only "waiting for the provider" when nothing is simply inside T+1:
      // then the honest reason is funding, not the clock.
      const awaitingProvider = (input.scheduledKobo ?? "0") === "0" && (input.awaitingProviderKobo ?? "0") !== "0";
      return { kind: "settling", nextReleaseAt: awaitingProvider ? null : input.nextReleaseAt, awaitingProvider };
    }
    if (input.totalRaisedKobo === "0") return { kind: "nothing_received" };
    return { kind: "empty" };
  }
  // Last: with money to withdraw, the one thing left to do is add an account.
  if (input.hasPayoutAccount === false) {
    return input.payoutAccountWaiting
      ? { kind: "no_payout_account", waiting: input.payoutAccountWaiting }
      : { kind: "no_payout_account" };
  }
  return null;
}

/** The balance ledger's filters (Activity tab, collapsed). Values match the server's allowlist. */
export const LEDGER_FILTERS = [
  { key: "all", label: "All" },
  { key: "contributions", label: "Payments" },
  { key: "settlement", label: "Became available" },
  { key: "withdrawals", label: "Withdrawals" },
  { key: "fees", label: "Fees" },
  { key: "refunds", label: "Refunds & disputes" },
  { key: "adjustments", label: "Adjustments" },
] as const;

export type LedgerFilterKey = (typeof LEDGER_FILTERS)[number]["key"];

/** A plain-language name for each kind of ledger movement. */
export const LEDGER_SOURCE_LABEL: Record<string, string> = {
  capture: "Successful payment",
  fee: "Fees",
  balance_release: "Now available to withdraw",
  provider_settlement: "Funds received from the payment provider",
  withdrawal: "Withdrawal started (amount held)",
  payout: "Withdrawal paid out",
  refund: "Refund",
  dispute_hold: "Held for a dispute",
  chargeback: "Chargeback",
  reversal: "Correction",
  adjustment: "Adjustment",
};

/**
 * The one amount a person cares about for a ledger row: how much the
 * collection's money changed, and in which bucket. Picks the first non-zero
 * bucket in the order a person reads them; never adds amounts together.
 */
export function headlineChange(entry: {
  availableChangeKobo: string;
  pendingChangeKobo: string;
  withdrawingChangeKobo: string;
  withdrawnChangeKobo: string;
  sourceType: string;
}): { bucket: string; kobo: string } | null {
  // A payout moves money from "being withdrawn" to "withdrawn"; the person
  // wants to see what left, which is the withdrawn side.
  const order: [string, string][] =
    entry.sourceType === "payout"
      ? [["Total withdrawn", entry.withdrawnChangeKobo]]
      : [
          // Named as BALANCES, never as a payment status: a successful
          // payment's net lands in the pending balance, but the payment is
          // not "pending".
          ["Available balance", entry.availableChangeKobo],
          ["Pending balance", entry.pendingChangeKobo],
          ["Being withdrawn", entry.withdrawingChangeKobo],
          ["Total withdrawn", entry.withdrawnChangeKobo],
        ];
  const hit = order.find(([, value]) => value !== "0");
  return hit ? { bucket: hit[0], kobo: hit[1] } : null;
}

// ── Payment activity (20261117130000) ─────────────────────────────────────────

/** The Activity filters, in the order shown. Values match app.collection_payment_activity. */
export const ACTIVITY_FILTERS = [
  { key: "all", label: "All" },
  { key: "successful", label: "Successful" },
  { key: "pending", label: "Pending" },
  { key: "failed", label: "Failed" },
  { key: "withdrawals", label: "Withdrawals" },
] as const;
export type ActivityFilterKey = (typeof ACTIVITY_FILTERS)[number]["key"];

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** The payment's own status. "Successful" is final the moment the payment is verified. */
export const PAYMENT_STATUS_LABEL: Record<string, { label: string; tone: Tone }> = {
  successful: { label: "Successful", tone: "success" },
  pending: { label: "Pending", tone: "warning" },
  under_review: { label: "Being checked", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
};

/** A withdrawal's status in the words the organiser uses. Successful only after the payout is confirmed. */
export const WITHDRAWAL_STATUS_LABEL: Record<
  "requested" | "approved" | "processing" | "paid" | "failed" | "rejected" | "cancelled" | "reversed",
  { label: string; tone: Tone }
> = {
  requested: { label: "Awaiting approval", tone: "warning" },
  approved: { label: "Processing", tone: "info" },
  processing: { label: "Processing", tone: "info" },
  paid: { label: "Successful", tone: "success" },
  failed: { label: "Failed — returned to balance", tone: "danger" },
  rejected: { label: "Rejected", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  reversed: { label: "Reversed — returned to balance", tone: "danger" },
};

/**
 * The two-approval stage of a withdrawal (owner decision 2026-11-19), as the
 * badge shows it. Past `ready_for_transfer` the status label applies.
 */
export function withdrawalStageLabel(
  stage: string,
  status: keyof typeof WITHDRAWAL_STATUS_LABEL,
): { label: string; tone: Tone } {
  switch (stage) {
    case "awaiting_member_verification":
      return { label: "Waiting for the requester's code", tone: "warning" };
    case "awaiting_owner_approval":
      return { label: "Waiting for administrator review", tone: "warning" };
    case "ready_for_transfer":
      return { label: "Approved — queued for transfer", tone: "info" };
    default:
      return WITHDRAWAL_STATUS_LABEL[status];
  }
}

/** Same as app.request_withdrawal_otp's cooldown; the state's resend time is the latest challenge's creation + this. */
export const WITHDRAWAL_OTP_RESEND_COOLDOWN_MS = 60_000;
/** The worker polls every 2 s; a code not handed to the email provider within this is reported as not sent (yet). */
export const WITHDRAWAL_OTP_SEND_STALL_MS = 60_000;
/** An unsent code lapses in the database after 10 minutes; past that, looking again is pointless. */
const WITHDRAWAL_OTP_VALIDITY_MS = 10 * 60_000;

export type WithdrawalCodePhase =
  | "loading"
  | "sending" // challenge open, email provider has not accepted the message yet
  | "stalled" // still not accepted after WITHDRAWAL_OTP_SEND_STALL_MS: worker or email down
  | "sent" // provider accepted the message: enter the code
  | "delivery_failed"
  | "expired"
  | "locked"
  | "closed"; // superseded / cancelled / verified challenge

/**
 * Which state the member's code screen is in. "sent" only once the email
 * provider has accepted the message (challenge status `sent`), never while the
 * worker is still sending, so the screen never claims a code was sent before
 * it was. A send that does not finish within a minute stops the spinner and
 * offers a new code instead of waiting for ever.
 */
export function withdrawalCodePhase(
  otp: { status: string | null; expiresAt: string | null; resendAvailableAt: string } | null,
  nowMs: number,
): { phase: WithdrawalCodePhase; canEnterCode: boolean; keepPolling: boolean } {
  if (otp === null || otp.status === null) return { phase: "loading", canEnterCode: false, keepPolling: false };
  const ageMs = nowMs - (Date.parse(otp.resendAvailableAt) - WITHDRAWAL_OTP_RESEND_COOLDOWN_MS);
  const expired = otp.expiresAt !== null && Date.parse(otp.expiresAt) <= nowMs;
  switch (otp.status) {
    case "pending_delivery":
    case "sending": {
      if (expired) return { phase: "expired", canEnterCode: false, keepPolling: false };
      const keepPolling = ageMs < WITHDRAWAL_OTP_VALIDITY_MS;
      if (ageMs < WITHDRAWAL_OTP_SEND_STALL_MS) return { phase: "sending", canEnterCode: false, keepPolling };
      // A code was issued (expiresAt set) but its delivery was never confirmed:
      // the email may still have gone out, so entering it stays possible.
      return { phase: "stalled", canEnterCode: otp.expiresAt !== null, keepPolling };
    }
    case "sent":
      return expired
        ? { phase: "expired", canEnterCode: false, keepPolling: false }
        : { phase: "sent", canEnterCode: true, keepPolling: false };
    case "delivery_failed":
      return { phase: "delivery_failed", canEnterCode: false, keepPolling: false };
    case "expired":
      return { phase: "expired", canEnterCode: false, keepPolling: false };
    case "locked":
      return { phase: "locked", canEnterCode: false, keepPolling: false };
    default:
      return { phase: "closed", canEnterCode: false, keepPolling: false };
  }
}

/**
 * When a SUCCESSFUL payment's money can be withdrawn — a separate fact from
 * the payment's status. `at` is the T+1 time, shown when it is still ahead.
 */
export function eligibilityText(eligibility: string | null, at: string | null, format: (iso: string) => string): string | null {
  switch (eligibility) {
    case "scheduled":
      return at ? `Available to withdraw from ${format(at)}` : "Available to withdraw after T+1";
    case "awaiting_provider":
      return "Past T+1 — waiting for a Kolekto check before it becomes available";
    case "held":
      return "Held while Kolekto checks the amount with the payment provider";
    case "released":
      return "In your available balance";
    default:
      return null;
  }
}

export const FEE_BEARER_LABEL: Record<string, string> = {
  community_absorbs: "Collection (you absorb the fee)",
  contributor_pays: "Contributor (added to what they paid)",
};
