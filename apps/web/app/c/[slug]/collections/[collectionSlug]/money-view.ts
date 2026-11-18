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

export type WithdrawBlock =
  | { kind: "identity" }
  | { kind: "in_progress"; amountKobo: string }
  | { kind: "free_used" }
  /** Successful payments still inside T+1, or past it but not yet settled by the provider. */
  | { kind: "settling"; nextReleaseAt: string | null; awaitingProvider: boolean }
  | { kind: "nothing_received" }
  | { kind: "empty" };

export interface WithdrawInputs {
  availableKobo: string;
  pendingKobo: string;
  totalRaisedKobo: string;
  /** Null when it could not be read: the database still decides. */
  identityVerified: boolean | null;
  withdrawals: { status: string; amountKobo: string }[];
  nextReleaseAt: string | null;
  /** Pending money still before its T+1 time ("0" when none). */
  scheduledKobo?: string;
  /** Pending money past T+1 whose provider settlement is not yet recorded ("0" when none). */
  awaitingProviderKobo?: string;
}

const ACTIVE = new Set(["requested", "approved", "processing"]);
const USES_FREE = new Set(["requested", "approved", "processing", "paid"]);

/** Why this officer cannot withdraw right now, or null when the form may open. First reason wins. */
export function withdrawBlock(input: WithdrawInputs): WithdrawBlock | null {
  if (input.identityVerified === false) return { kind: "identity" };
  const active = input.withdrawals.find((w) => ACTIVE.has(w.status));
  if (active) return { kind: "in_progress", amountKobo: active.amountKobo };
  if (input.withdrawals.some((w) => USES_FREE.has(w.status))) return { kind: "free_used" };
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
  "requested" | "approved" | "processing" | "paid" | "failed" | "rejected" | "cancelled",
  { label: string; tone: Tone }
> = {
  requested: { label: "Awaiting approval", tone: "warning" },
  approved: { label: "Processing", tone: "info" },
  processing: { label: "Processing", tone: "info" },
  paid: { label: "Successful", tone: "success" },
  failed: { label: "Failed — returned to balance", tone: "danger" },
  rejected: { label: "Rejected", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/**
 * When a SUCCESSFUL payment's money can be withdrawn — a separate fact from
 * the payment's status. `at` is the T+1 time, shown when it is still ahead.
 */
export function eligibilityText(eligibility: string | null, at: string | null, format: (iso: string) => string): string | null {
  switch (eligibility) {
    case "scheduled":
      return at ? `Available to withdraw from ${format(at)}` : "Available to withdraw after T+1";
    case "awaiting_provider":
      return "Past T+1 — becomes available as soon as the payment provider releases the funds";
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
