/**
 * transfers.ts — automatic withdrawal payouts through Paystack Transfers
 * (owner decision 2026-11-17 §18; built 2026-11-18; reliability rework
 * 2026-11-19 for PA-08 / PA-09). Shared by the worker (dispatch + check) and
 * the webhook route (confirm).
 *
 * Every money rule is in the database (20261118100100, 20261119120000). This
 * module only moves facts between Paystack and those functions, and it is
 * careful about exactly two things: never sending a transfer twice and never
 * believing an outcome Paystack has not confirmed.
 *
 *   dispatch   claim withdrawals that have BOTH the member's verified code and
 *              the owner's approval (→ processing, transfer row `initiating`,
 *              leased to this worker), make sure the account has a Paystack
 *              recipient, check the Paystack balance covers the amount, commit
 *              "initiate requested", then initiate under Kolekto's reference.
 *   check      claim due open transfers (lease, backoff schedule from the
 *              policy row), verify each by reference, settle what Paystack
 *              confirms. Every look is logged (withdrawal_transfer_checks).
 *   confirm    webhook: the body only names the reference; the outcome is
 *              re-read from Paystack's verify endpoint before anything moves.
 *
 * P8-1 — a NOT FOUND never releases a hold by itself. The worker asks the
 * database to release only when app.transfer_release_eligible says so:
 * provably never sent (initiate_requested_at is null), or refused
 * synchronously (not as a duplicate), never asked about at the approval URL,
 * and NOT FOUND repeatedly over the policy window. An ambiguous initiation
 * (timeout, 5xx) is verified immediately and then on the backoff schedule; it
 * is re-sent only under the SAME reference and only after repeated NOT FOUND.
 * Escalation (policy) stops automatic re-sends and never releases funds.
 *
 * The initiate response is never treated as final; only verify results settle.
 * Logs nothing itself; returns per-reference outcomes for the caller to count.
 */

import type { TransferProvider, TransferState } from "@kolekto/adapters";
import {
  type ClaimedOpenTransfer,
  claimWithdrawalTransfers,
  claimWithdrawalTransfersToCheck,
  DatabaseError,
  markWithdrawalTransferInitiating,
  type OpenTransferStatus,
  type PaymentDb,
  recordWithdrawalTransferCheck,
  type RecordTransferCheckResult,
  releaseWithdrawalTransferClaim,
  releaseWithdrawalTransferNeverSent,
  setBankAccountRecipient,
  settleWithdrawalTransfer,
  type SettleTransferOutcome,
  type TransferCheckSource,
} from "@kolekto/db";
import { kobo } from "@kolekto/domain";

export interface TransferContext {
  db: PaymentDb;
  provider: TransferProvider;
  /** Names this process in leases and the check log. */
  worker?: string;
}

export type TransferStepOutcome =
  | SettleTransferOutcome
  | "initiated"
  | "awaiting_otp"
  | "pending"
  | "unknown"
  | "insufficient_provider_balance"
  | "no_recipient"
  | "provider_unavailable"
  | "not_found"
  | "not_sent"
  | "released_never_sent"
  | "escalated"
  | "stale_claim"
  | "unknown_reference"
  | "error";

export interface TransferStepReport {
  readonly outcomes: ReadonlyArray<{ reference: string; outcome: TransferStepOutcome }>;
}

const REASON_PREFIX = "Kolekto payout";

/** Paystack refused because the reference already exists: the first send may be live. */
export function isDuplicateReferenceRefusal(code: string | null, message: string): boolean {
  return /duplicate/i.test(code ?? "") || /duplicate/i.test(message);
}

/**
 * A refusal that says nothing about the transfer itself (rate limit, auth,
 * balance): treated as ambiguous (verify, never release on it).
 */
export function isTransientRefusal(code: string | null, message: string): boolean {
  if (code !== null && ["http_429", "http_401", "http_403", "insufficient_balance"].includes(code)) return true;
  return /balance is not enough|insufficient balance|too many requests|rate limit/i.test(message);
}

function workerName(ctx: TransferContext): string {
  return (ctx.worker ?? "worker").slice(0, 80);
}

function openStatusFor(state: TransferState): OpenTransferStatus {
  return state.status === "otp" ? "otp" : state.status === "pending" ? "pending" : "unknown";
}

interface Claim {
  reference: string;
  claimToken: string | null;
}

/** Apply a state Paystack's verify endpoint reported, then log it (and end the claim, if any). */
async function applyVerified(ctx: TransferContext, state: TransferState, claim: Claim, source: TransferCheckSource): Promise<TransferStepOutcome> {
  if (state.status === "success" || state.status === "failed" || state.status === "reversed") {
    const settled = await settleWithdrawalTransfer(ctx.db, {
      reference: state.reference,
      outcome: state.status,
      amountKobo: BigInt(state.amount),
      transferCode: state.transferCode,
      feeKobo: state.fee === null ? null : BigInt(state.fee),
      reason: state.reason,
      at: null,
    });
    await recordWithdrawalTransferCheck(ctx.db, {
      reference: claim.reference,
      claimToken: claim.claimToken,
      source,
      worker: workerName(ctx),
      providerResult: "ok",
      providerStatus: state.providerStatusRaw,
      transferCode: state.transferCode,
      providerTransferId: state.providerTransferId,
      outcome: settled,
      note: settled === "amount_mismatch" || settled === "conflict" ? "Paystack's answer contradicts Kolekto's record; nothing changed" : null,
    });
    return settled;
  }
  const result = await recordWithdrawalTransferCheck(ctx.db, {
    reference: claim.reference,
    claimToken: claim.claimToken,
    source,
    worker: workerName(ctx),
    providerResult: "ok",
    providerStatus: state.providerStatusRaw,
    newStatus: openStatusFor(state),
    transferCode: state.transferCode,
    providerTransferId: state.providerTransferId,
    outcome: state.status === "otp" ? "awaiting_otp" : state.status === "pending" ? "pending" : "unrecognised_status",
    note: state.status === "unrecognised" ? `unrecognised provider status: ${state.providerStatusRaw}` : null,
  });
  if (result.stale) return "stale_claim";
  return state.status === "otp" ? "awaiting_otp" : state.status === "pending" ? "pending" : "unknown";
}

interface SendTarget {
  reference: string;
  claimToken: string;
  amountKobo: bigint;
  recipientCode: string;
  withdrawalReference: string | null;
}

/**
 * Send one transfer under its own reference. The row is marked "initiate
 * requested" (committed) before the call, so a crash in between can never be
 * mistaken for "never sent".
 */
async function send(ctx: TransferContext, t: SendTarget, source: TransferCheckSource): Promise<TransferStepOutcome> {
  const base = { reference: t.reference, claimToken: t.claimToken, source, worker: workerName(ctx) };

  const balance = await ctx.provider.getBalance();
  if (balance.outcome !== "ok") {
    await recordWithdrawalTransferCheck(ctx.db, { ...base, providerResult: "not_called", outcome: "balance_unavailable" });
    return "provider_unavailable";
  }
  if (BigInt(balance.value.available) < t.amountKobo) {
    await recordWithdrawalTransferCheck(ctx.db, {
      ...base,
      providerResult: "not_called",
      outcome: "insufficient_provider_balance",
      note: "Paystack balance does not cover this transfer yet; it will be retried",
    });
    return "insufficient_provider_balance";
  }

  if (!(await markWithdrawalTransferInitiating(ctx.db, t.reference, t.claimToken))) return "stale_claim";

  const result = await ctx.provider.initiateTransfer({
    reference: t.reference,
    amount: kobo(t.amountKobo),
    recipientCode: t.recipientCode,
    reason: t.withdrawalReference === null ? REASON_PREFIX : `${REASON_PREFIX} ${t.withdrawalReference}`,
  });

  if (result.outcome === "ok") {
    const status: OpenTransferStatus = result.value.status === "otp" ? "otp" : "pending";
    const recorded = await recordWithdrawalTransferCheck(ctx.db, {
      ...base,
      providerResult: "ok",
      providerStatus: result.value.providerStatusRaw,
      newStatus: status,
      recipientCode: t.recipientCode,
      transferCode: result.value.transferCode,
      providerTransferId: result.value.providerTransferId,
      outcome: status === "otp" ? "awaiting_otp" : "initiated",
    });
    if (recorded.stale) return "stale_claim";
    return status === "otp" ? "awaiting_otp" : "initiated";
  }

  // Not a clean acceptance. Log what Paystack said (keeping the claim), then
  // verify by reference immediately: the transfer may exist.
  if (result.outcome === "refused") {
    const duplicate = isDuplicateReferenceRefusal(result.providerCode, result.message);
    const transient = !duplicate && isTransientRefusal(result.providerCode, result.message);
    await recordWithdrawalTransferCheck(ctx.db, {
      ...base,
      // A transient refusal is recorded as "unavailable": it never counts
      // towards releasing the hold.
      providerResult: transient ? "unavailable" : "refused",
      providerCode: duplicate ? "duplicate_transfer_reference" : (result.providerCode ?? "refused"),
      newStatus: "unknown",
      outcome: duplicate ? "initiate_duplicate_reference" : transient ? "initiate_refused_transient" : "initiate_refused",
      note: `Paystack refused the transfer: ${result.message}`.slice(0, 500),
      releaseClaim: false,
    });
  } else {
    await recordWithdrawalTransferCheck(ctx.db, {
      ...base,
      providerResult: "unavailable",
      newStatus: "unknown",
      outcome: "initiate_ambiguous",
      note: result.outcome === "unknown" ? result.reason : "initiation answered not_found",
      releaseClaim: false,
    });
  }
  return verifyClaimed(ctx, { ...t, status: "unknown" }, source, false);
}

/** Verify a claimed transfer by reference and act on the answer; always ends the claim. */
async function verifyClaimed(
  ctx: TransferContext,
  t: { reference: string; claimToken: string; amountKobo: bigint; recipientCode: string | null; withdrawalReference: string | null; status: OpenTransferStatus },
  source: TransferCheckSource,
  mayInitiate: boolean,
): Promise<TransferStepOutcome> {
  const claim = { reference: t.reference, claimToken: t.claimToken };
  const verified = await ctx.provider.verifyTransfer(t.reference);
  if (verified.outcome === "ok") return applyVerified(ctx, verified.value, claim, source);
  if (verified.outcome !== "not_found") {
    await recordWithdrawalTransferCheck(ctx.db, {
      ...claim,
      source,
      worker: workerName(ctx),
      providerResult: "unavailable",
      providerCode: verified.outcome === "refused" ? verified.providerCode : null,
      outcome: "provider_unavailable",
      note: verified.outcome === "unknown" ? verified.reason : verified.message,
    });
    return "provider_unavailable";
  }

  // Paystack has no transfer under this reference (right now).
  const recorded: RecordTransferCheckResult = await recordWithdrawalTransferCheck(ctx.db, {
    ...claim,
    source,
    worker: workerName(ctx),
    providerResult: "not_found",
    newStatus: t.status === "initiating" ? "unknown" : t.status,
    outcome: "not_found",
    releaseClaim: false,
  });
  if (recorded.stale) return "stale_claim";

  if (recorded.releaseEligible) {
    const released = await releaseWithdrawalTransferNeverSent(ctx.db, { reference: t.reference, claimToken: t.claimToken, reason: null });
    await recordWithdrawalTransferCheck(ctx.db, {
      ...claim,
      source,
      worker: workerName(ctx),
      providerResult: "not_called",
      outcome: `release_${released}`.slice(0, 60),
    });
    return released === "failed" ? "released_never_sent" : "not_found";
  }
  if (recorded.resendAllowed && mayInitiate && t.recipientCode !== null) {
    return send(ctx, { reference: t.reference, claimToken: t.claimToken, amountKobo: t.amountKobo, recipientCode: t.recipientCode, withdrawalReference: t.withdrawalReference }, source);
  }
  await releaseWithdrawalTransferClaim(ctx.db, t.reference, t.claimToken);
  return recorded.escalated ? "escalated" : "not_found";
}

/** Claim fully authorised withdrawals and send their transfers. Only where transfers are switched on. */
export async function dispatchWithdrawalTransfers(ctx: TransferContext, limit = 10): Promise<TransferStepReport> {
  const outcomes: { reference: string; outcome: TransferStepOutcome }[] = [];
  const claimed = await claimWithdrawalTransfers(ctx.db, limit, workerName(ctx));
  for (const claim of claimed) {
    const base = { reference: claim.transferReference, claimToken: claim.claimToken, source: "dispatch" as const, worker: workerName(ctx) };
    try {
      let recipientCode = claim.recipientCode;
      if (recipientCode === null) {
        const created = await ctx.provider.createRecipient({
          accountName: claim.accountName,
          accountNumber: claim.accountNumber,
          bankCode: claim.bankCode,
        });
        if (created.outcome !== "ok") {
          await recordWithdrawalTransferCheck(ctx.db, {
            ...base,
            providerResult: "not_called",
            providerCode: "recipient_not_created",
            outcome: "no_recipient",
            note: "could not create the Paystack recipient; nothing was sent",
          });
          outcomes.push({ reference: claim.transferReference, outcome: "no_recipient" });
          continue;
        }
        recipientCode = created.value.recipientCode;
        await setBankAccountRecipient(ctx.db, claim.bankAccountId, recipientCode);
      }
      // Pin the recipient on the transfer row before any call that could move
      // money, so the check stage can always finish it.
      const pinned = await recordWithdrawalTransferCheck(ctx.db, {
        ...base,
        providerResult: "not_called",
        recipientCode,
        outcome: "recipient_pinned",
        releaseClaim: false,
      });
      if (pinned.stale) {
        outcomes.push({ reference: claim.transferReference, outcome: "stale_claim" });
        continue;
      }
      outcomes.push({
        reference: claim.transferReference,
        outcome: await send(
          ctx,
          {
            reference: claim.transferReference,
            claimToken: claim.claimToken,
            amountKobo: claim.amountKobo,
            recipientCode,
            withdrawalReference: claim.withdrawalReference,
          },
          "dispatch",
        ),
      });
    } catch (error) {
      outcomes.push({ reference: claim.transferReference, outcome: "error" });
      if (!(error instanceof DatabaseError)) throw error;
    }
  }
  return { outcomes };
}

async function checkOne(ctx: TransferContext, t: ClaimedOpenTransfer, mayInitiate: boolean): Promise<TransferStepOutcome> {
  const base = { reference: t.reference, claimToken: t.claimToken, source: "check" as const, worker: workerName(ctx) };

  if (t.initiateRequestedAt === null) {
    // Kolekto provably never asked Paystack to send this transfer.
    if (t.recipientCode === null) {
      // Recipient creation never succeeded: nothing can have moved.
      const released = await releaseWithdrawalTransferNeverSent(ctx.db, {
        reference: t.reference,
        claimToken: t.claimToken,
        reason: "Could not register the bank account with Paystack. Nothing was sent; please try again.",
      });
      await recordWithdrawalTransferCheck(ctx.db, { ...base, providerResult: "not_called", outcome: `release_${released}`.slice(0, 60) });
      return released === "failed" ? "released_never_sent" : "no_recipient";
    }
    if (!mayInitiate) {
      await recordWithdrawalTransferCheck(ctx.db, { ...base, providerResult: "not_called", outcome: "transfers_disabled" });
      return "not_sent";
    }
    return send(
      ctx,
      { reference: t.reference, claimToken: t.claimToken, amountKobo: t.amountKobo, recipientCode: t.recipientCode, withdrawalReference: t.withdrawalReference },
      "check",
    );
  }

  return verifyClaimed(
    ctx,
    {
      reference: t.reference,
      claimToken: t.claimToken,
      amountKobo: t.amountKobo,
      recipientCode: t.recipientCode,
      withdrawalReference: t.withdrawalReference,
      status: t.status,
    },
    "check",
    mayInitiate,
  );
}

/**
 * Resolve due open transfers against Paystack (leased, backoff from the
 * policy row). `mayInitiate` is false when the flag is off: in-flight
 * transfers are still finished, nothing new is sent.
 */
export async function checkWithdrawalTransfers(
  ctx: TransferContext,
  options: { limit: number; mayInitiate: boolean },
): Promise<TransferStepReport> {
  const outcomes: { reference: string; outcome: TransferStepOutcome }[] = [];
  const due = await claimWithdrawalTransfersToCheck(ctx.db, workerName(ctx), options.limit);
  for (const t of due) {
    try {
      outcomes.push({ reference: t.reference, outcome: await checkOne(ctx, t, options.mayInitiate) });
    } catch (error) {
      outcomes.push({ reference: t.reference, outcome: "error" });
      // The lease expires on its own; the row is picked up again.
      if (!(error instanceof DatabaseError)) throw error;
    }
  }
  return { outcomes };
}

/** Webhook: the body named a transfer; re-read it from Paystack and apply what Paystack says. */
export async function confirmWithdrawalTransfer(ctx: TransferContext, reference: string): Promise<TransferStepOutcome> {
  const verified = await ctx.provider.verifyTransfer(reference);
  // A webhook's NOT FOUND is never recorded: it must not count towards a release.
  if (verified.outcome === "not_found") return "not_found";
  if (verified.outcome !== "ok") return "provider_unavailable";
  try {
    return await applyVerified(ctx, verified.value, { reference, claimToken: null }, "webhook");
  } catch (error) {
    if (error instanceof DatabaseError && /UNKNOWN_TRANSFER_REFERENCE/.test(error.message)) return "unknown_reference";
    throw error;
  }
}
