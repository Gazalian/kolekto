/**
 * settlement-provider.ts — the seam FIN-02 requires.
 *
 * ── STATUS: INTERFACE ONLY. NEITHER IMPLEMENTATION EXISTS. ──────────────────
 *
 * FIN-02: "Engineering keeps a SettlementProvider interface so that, if counsel
 * rejects this model, Kolekto can switch to the fallback: Paystack subaccounts
 * that settle each community's share directly to its bank on Paystack's T+1
 * schedule (no withdraw button; the Withdrawals screen becomes a read-only
 * settlement history)."
 *
 * This file exists now, before either implementation, because the two models
 * are not variations on a theme — they differ in whether Kolekto ever holds the
 * money, which changes the ledger's chart of accounts, the Money screen, the
 * withdrawal flow, and the regulatory position (DEC-01, DEC-03). Writing the
 * seam first is what keeps that a one-file change instead of a rewrite.
 *
 * The audit found something worth stating plainly here: Kolekto is ALREADY
 * operating the balance model. It pools community funds in its own Paystack
 * balance and releases them through manual bank transfers authorised by staff,
 * across ₦46m and 292 withdrawals. So DEC-01 and DEC-03 are not choosing a
 * future design; they are ruling on a live arrangement.
 */

import type { Kobo } from "@kolekto/domain";

/** Which settlement model is in force. Set once DEC-01 and DEC-03 close. */
export type SettlementModel =
  /** Funds accumulate in Kolekto's Paystack balance; a community withdraws its available balance on T+1. */
  | "balance_and_withdraw"
  /** Paystack subaccounts settle each community's share directly to its bank. Kolekto never holds the money. */
  | "subaccount_auto_settle";

export interface CommunityBalances {
  /** INS-15: money received into installment plans that are not yet complete. Cannot be withdrawn. */
  readonly locked: Kobo;
  /** T1-02: completed payments received today. Available tomorrow. */
  readonly pending: Kobo;
  /** Released and not yet withdrawn. */
  readonly available: Kobo;
  /** TRU-05: held for a dispute or a risk review, with a reason shown to officers. */
  readonly onHold: Kobo;
  /** Transfers sent to the provider, awaiting a result. */
  readonly withdrawing: Kobo;
  /** Total successfully transferred to the community's bank. */
  readonly withdrawn: Kobo;
}

export interface WithdrawalRequest {
  readonly communityId: string;
  readonly amount: Kobo;
  /** WDR-05: idempotent on the Kolekto reference. A retry reuses it, so a bank is never paid twice. */
  readonly reference: string;
  readonly requestedBy: string;
  readonly approvedBy?: string;
}

export interface WithdrawalResult {
  readonly reference: string;
  readonly providerReference: string | null;
  readonly status: "pending" | "processing" | "completed" | "failed" | "reversed";
  readonly failureReason?: string;
}

/**
 * The seam. Every money-out path in the application calls this interface and
 * never a provider SDK directly (ADR 0002, and the reason `api.paystack.co`
 * may appear only in this package).
 */
export interface SettlementProvider {
  readonly model: SettlementModel;

  /**
   * Whether a community can move money at all under this model. Under
   * `subaccount_auto_settle` this is always false: there is no withdraw button,
   * because Paystack has already paid the community directly.
   */
  readonly supportsWithdrawal: boolean;

  getBalances(communityId: string): Promise<CommunityBalances>;

  /** Throws under `subaccount_auto_settle`. The UI must not offer what the model does not support. */
  requestWithdrawal(request: WithdrawalRequest): Promise<WithdrawalResult>;

  getWithdrawal(reference: string): Promise<WithdrawalResult | null>;
}

/**
 * Not implemented, and deliberately so.
 *
 * Do not write either implementation until DEC-01 and DEC-03 are closed and
 * DEC-06 has set the risk limits. An implementation written against a guess
 * about the settlement model is worse than none: it will be trusted.
 */
export function createSettlementProvider(_model: SettlementModel): SettlementProvider {
  throw new Error(
    "SettlementProvider is not implemented. Settlement is gated on DEC-01 (settlement model), " +
      "DEC-03 (licensing) and DEC-06 (risk limits). See docs/adr/0006-ledger-deferred.md.",
  );
}
