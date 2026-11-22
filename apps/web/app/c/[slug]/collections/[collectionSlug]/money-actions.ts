"use server";

import {
  DatabaseError,
  decideWithdrawal,
  getWithdrawalOtpState,
  requestWithdrawalOtp,
  verifyWithdrawalOtp,
  type WithdrawalOtpVerifyOutcome,
  type WithdrawalStage,
  getCollectionReconciliation,
  getCollectionSettlementSummary,
  getPaymentReminderSummary,
  listCollectionLedger,
  listCollectionPaymentActivity,
  listCollectionWithdrawals,
  type ActivityEligibility,
  type ActivityFilter,
  type ActivityPaymentStatus,
  listPaymentReminderRoster,
  requestWithdrawal,
  sendPaymentReminders,
  type ReminderBlockedReason,
  type ReminderFilter,
  type LedgerKind,
  type ReminderUnsupportedReason,
  type WithdrawalStatus,
} from "@kolekto/db";
import { ConfigError, loadWithdrawalOtpSecret } from "@kolekto/config";
import { fromNaira, hashWithdrawalOtp, MoneyError, normaliseWithdrawalOtpInput } from "@kolekto/domain";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../../lib/caller.ts";
import { logEvent } from "../../../../../lib/server-log.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";

/**
 * The Money and Reminders tabs' server side (design:
 * docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md).
 *
 * SECURITY. The collection is resolved from the slugs through RLS (SEC-18);
 * every read and write after that is an `app.*` function running as the
 * signed-in officer, which decides permission against the collection itself —
 * balance.view for money, withdrawal.request / community owner for
 * withdrawals, transaction.view and reminder.send for reminders. Amounts are
 * parsed here only to reach the database as integer kobo; every balance check,
 * lock and hold happens there. Kobo leaves this file as decimal strings.
 */

const LEDGER_PAGE_SIZE = 25;
/** The Activity tab's filters. Anything else from the browser is treated as "all". */
const LEDGER_KINDS: readonly LedgerKind[] = ["all", "contributions", "fees", "settlement", "withdrawals", "refunds", "adjustments"];
const REMINDER_PAGE_SIZE = 50;

async function resolve(slug: string, collectionSlug: string) {
  const supabase = await createClient();
  const { data: community } = await supabase.from("communities").select("id").eq("slug", slug).maybeSingle();
  if (!community) return { error: "That community could not be found" as const };
  const { data: collection } = await supabase
    .from("collections")
    .select("id")
    .eq("community_id", community.id)
    .eq("slug", collectionSlug)
    .maybeSingle();
  if (!collection) return { error: "That collection could not be found" as const };
  return { collectionId: collection.id as string };
}

/** A sentence the organiser can act on, for each refusal the database can give. */
function messageFor(error: unknown, fallback: string): string {
  if (!(error instanceof DatabaseError)) return fallback;
  switch (error.code) {
    case "FORBIDDEN":
      return "You do not have permission to do that on this collection.";
    case "INSUFFICIENT_AVAILABLE_BALANCE":
      return "That is more than your available balance. Payments still in the pending balance become available automatically after the T+1 period.";
    case "BANK_ACCOUNT_NOT_FOUND":
      return "Choose one of your saved bank accounts.";
    case "BANK_ACCOUNT_NOT_VERIFIED":
      return "That bank account is not verified for payouts. Choose another, or check it under Account settings.";
    case "BANK_ACCOUNT_COOLING_OFF":
      return "That bank account was added recently. For your security it can receive withdrawals 48 hours after it was added.";
    case "DAILY_WITHDRAWAL_LIMIT":
      return "This would pass the ₦1,000,000 daily withdrawal limit for unverified communities. Try a smaller amount or wait until tomorrow.";
    case "INVALID_AMOUNT":
    case "INVALID_ACCOUNT_NUMBER":
    case "INVALID_ACCOUNT_NAME":
    case "INVALID_BANK":
    case "INVALID_REASON":
      return error.message;
    case "WITHDRAWAL_NOT_PENDING":
    case "WITHDRAWAL_NOT_CANCELLABLE":
    case "WITHDRAWAL_NOT_AWAITING_VERIFICATION":
      return "That withdrawal has already moved on. Reload to see where it is.";
    case "EMAIL_NOT_VERIFIED":
      return "Confirm your email address first: the withdrawal code is sent there.";
    case "WITHDRAWAL_AWAITING_MEMBER_VERIFICATION":
      return "The member who requested this withdrawal has not confirmed it with their emailed code yet. You can approve it once they have.";
    case "WITHDRAWAL_BANK_ACCOUNT_CHANGED":
      return "The destination bank account is no longer a verified account of the requester. Reject this request; they can request again to a verified account.";
    case "WITHDRAWAL_ALREADY_VERIFIED":
      return "This request is already verified. It is waiting for review by an authorised community administrator.";
    case "OTP_RESEND_TOO_SOON":
      return "A new code can be requested one minute after the last one.";
    case "OTP_TOO_MANY_CODES":
      return "Too many codes were requested for this withdrawal. Cancel it and request again.";
    case "OTP_RATE_LIMITED":
      return "Too many codes requested. Try again later.";
    case "OTP_CHALLENGE_MISMATCH":
      return "That code does not belong to this withdrawal. Request a new code.";
    case "REMINDERS_NOT_SUPPORTED":
      return error.message;
    case "COLLECTION_NOT_ACTIVE":
      return "Reminders can only be sent while the collection is taking payments.";
    case "NO_MEMBERS":
      return "Choose at least one member.";
    case "TOO_MANY_MEMBERS":
      return "Send to at most 500 members at a time.";
    case "NOT_FOUND":
      return error.message;
    default:
      return fallback;
  }
}

// ── Money ────────────────────────────────────────────────────────────────────

export interface SettlementView {
  scheduledKobo: string;
  scheduledCount: number;
  awaitingProviderKobo: string;
  awaitingProviderCount: number;
  discrepancyKobo: string;
  discrepancyCount: number;
  releasedKobo: string;
  nextReleaseAt: string | null;
  lastReleaseAt: string | null;
  rule: string;
  reconciled: boolean;
}

export interface LedgerEntryView {
  journalId: string;
  occurredAt: string;
  sourceType: string;
  reason: string;
  reference: string | null;
  pendingChangeKobo: string;
  availableChangeKobo: string;
  withdrawingChangeKobo: string;
  withdrawnChangeKobo: string;
  isReversal: boolean;
}

export interface WithdrawalView {
  id: string;
  reference: string;
  amountKobo: string;
  feeKobo: string;
  status: WithdrawalStatus;
  isFirst: boolean;
  requiresManualReview: boolean;
  accountName: string;
  accountLast4: string;
  bankName: string;
  requestedByName: string | null;
  requestedAt: string;
  decisionReason: string | null;
  paidAt: string | null;
  payoutReference: string | null;
  failureReason: string | null;
  canDecide: boolean;
  canCancel: boolean;
  payoutMethod: "paystack_transfer" | "manual";
  transferReference: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  stage: WithdrawalStage;
  memberVerifiedAt: string | null;
  isMine: boolean;
  canReject: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  ownerSelfApproved: boolean;
  availableBeforeKobo: string | null;
  accountStatus: string | null;
  accountCoolingOff: boolean;
  transferEscalated: boolean;
}

export interface MoneyView {
  settlement: SettlementView;
  reconciliationFailures: string[];
  withdrawals: WithdrawalView[];
  ledger: LedgerEntryView[];
  ledgerTotal: number;
}

function ruleText(s: { scheduleDayOffset: number; scheduleReleaseTime: string; scheduleTimezone: string; requiresProviderConfirmation: boolean }): string {
  const time = s.scheduleReleaseTime.slice(0, 5);
  const day = s.scheduleDayOffset === 1 ? "the next calendar day" : `${s.scheduleDayOffset} calendar days later`;
  const zone = s.scheduleTimezone === "Africa/Lagos" ? "Lagos time" : s.scheduleTimezone;
  return `A payment becomes available at ${time} ${zone} on ${day}${s.requiresProviderConfirmation ? ", once the payment provider has settled it" : ""}.`;
}

async function ledgerPage(collectionId: string, offset: number, kind?: string) {
  const page = await listCollectionLedger(await requireCallerContext(), {
    collectionId,
    limit: LEDGER_PAGE_SIZE,
    offset: Math.max(0, Math.floor(offset)),
    ...(kind && kind !== "all" && (LEDGER_KINDS as readonly string[]).includes(kind) ? { kind: kind as LedgerKind } : {}),
  });
  return {
    total: page.total,
    rows: page.rows.map(
      (r): LedgerEntryView => ({
        journalId: r.journalId,
        occurredAt: r.occurredAt,
        sourceType: r.sourceType,
        reason: r.reason,
        reference: r.reference,
        pendingChangeKobo: r.pendingChangeKobo.toString(),
        availableChangeKobo: r.availableChangeKobo.toString(),
        withdrawingChangeKobo: r.withdrawingChangeKobo.toString(),
        withdrawnChangeKobo: r.withdrawnChangeKobo.toString(),
        isReversal: r.reversesJournalId !== null,
      }),
    ),
  };
}

export async function loadMoneyAction(slug: string, collectionSlug: string): Promise<{ error?: string; money?: MoneyView }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  try {
    const caller = await requireCallerContext();
    const [s, checks, withdrawals, ledger] = await Promise.all([
      getCollectionSettlementSummary(caller, resolved.collectionId),
      getCollectionReconciliation(caller, resolved.collectionId),
      listCollectionWithdrawals(caller, resolved.collectionId),
      ledgerPage(resolved.collectionId, 0),
    ]);
    return {
      money: {
        settlement: {
          scheduledKobo: s.scheduledKobo.toString(),
          scheduledCount: s.scheduledCount,
          awaitingProviderKobo: s.awaitingProviderKobo.toString(),
          awaitingProviderCount: s.awaitingProviderCount,
          discrepancyKobo: s.discrepancyKobo.toString(),
          discrepancyCount: s.discrepancyCount,
          releasedKobo: s.releasedKobo.toString(),
          nextReleaseAt: s.nextReleaseAt,
          lastReleaseAt: s.lastReleaseAt,
          rule: ruleText(s),
          reconciled: s.reconciled,
        },
        reconciliationFailures: checks.filter((c) => !c.ok).map((c) => c.checkName),
        withdrawals: withdrawals.map((w) => ({
          id: w.id,
          reference: w.reference,
          amountKobo: w.amountKobo.toString(),
          feeKobo: w.feeKobo.toString(),
          status: w.status,
          isFirst: w.isFirst,
          requiresManualReview: w.requiresManualReview,
          accountName: w.accountName,
          accountLast4: w.accountLast4,
          bankName: w.bankName,
          requestedByName: w.requestedByName,
          requestedAt: w.requestedAt,
          decisionReason: w.decisionReason,
          paidAt: w.paidAt,
          payoutReference: w.payoutReference,
          failureReason: w.failureReason,
          canDecide: w.canDecide,
          canCancel: w.canCancel,
          payoutMethod: w.payoutMethod,
          transferReference: w.transferReference,
          reversedAt: w.reversedAt,
          reversalReason: w.reversalReason,
          stage: w.stage,
          memberVerifiedAt: w.memberVerifiedAt,
          isMine: w.isMine,
          canReject: w.canReject,
          approvedByName: w.approvedByName,
          approvedAt: w.approvedAt,
          ownerSelfApproved: w.ownerSelfApproved,
          availableBeforeKobo: w.availableBeforeKobo === null ? null : w.availableBeforeKobo.toString(),
          accountStatus: w.accountStatus,
          accountCoolingOff: w.accountCoolingOff,
          transferEscalated: w.transferEscalated,
        })),
        ledger: ledger.rows,
        ledgerTotal: ledger.total,
      },
    };
  } catch (error) {
    return { error: messageFor(error, "The money for this collection could not be loaded.") };
  }
}

export async function ledgerPageAction(
  slug: string,
  collectionSlug: string,
  offset: number,
  kind?: string,
): Promise<{ error?: string; rows?: LedgerEntryView[]; total?: number }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  try {
    return await ledgerPage(resolved.collectionId, offset, kind);
  } catch (error) {
    return { error: messageFor(error, "The ledger could not be loaded.") };
  }
}

export async function requestWithdrawalAction(
  slug: string,
  collectionSlug: string,
  input: { amount: string; bankAccountId: string; idempotencyKey: string },
): Promise<{ error?: string; withdrawalId?: string; reference?: string; status?: WithdrawalStatus }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  let amountKobo: bigint;
  try {
    amountKobo = BigInt(fromNaira(input.amount));
  } catch (error) {
    if (error instanceof MoneyError) return { error: "Enter an amount in naira, e.g. 25,000 or 25000.50." };
    throw error;
  }
  if (amountKobo <= 0n) return { error: "Enter an amount above zero." };
  if (typeof input.bankAccountId !== "string" || input.bankAccountId.length === 0) return { error: "Choose a bank account." };
  try {
    const result = await requestWithdrawal(await requireCallerContext(), {
      collectionId: resolved.collectionId,
      amountKobo,
      // Ownership, verification and cooling-off are checked by the database
      // against the signed-in officer; an id from the browser grants nothing.
      bankAccountId: input.bankAccountId,
      idempotencyKey: input.idempotencyKey.slice(0, 120),
    });
    revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
    return { withdrawalId: result.withdrawalId, reference: result.reference, status: result.status };
  } catch (error) {
    return { error: messageFor(error, "The withdrawal could not be requested.") };
  }
}

export async function decideWithdrawalAction(
  slug: string,
  collectionSlug: string,
  input: { withdrawalId: string; decision: "approve" | "reject" | "cancel"; reason?: string },
): Promise<{ error?: string; status?: WithdrawalStatus }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  try {
    const status = await decideWithdrawal(await requireCallerContext(), {
      withdrawalId: input.withdrawalId,
      decision: input.decision,
      reason: input.reason?.trim().slice(0, 500) || null,
    });
    revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
    return { status };
  } catch (error) {
    return { error: messageFor(error, "That could not be saved.") };
  }
}

// ── Member one-time code (owner decision 2026-11-19) ─────────────────────────
//
// The requesting member confirms their request with the 6-digit code the
// worker emailed. The code is hashed HERE (HMAC with a server secret, bound to
// the challenge id the database reports for this withdrawal) and only the hash
// reaches the database, which checks requester, expiry, attempts and single
// use atomically. Verifying is NOT approval and NOT payment.

export interface WithdrawalOtpView {
  status: string | null;
  sentAt: string | null;
  expiresAt: string | null;
  attemptsRemaining: number | null;
  resendAvailableAt: string;
  emailHint: string | null;
  memberVerified: boolean;
  stage: string;
}

export async function withdrawalOtpStateAction(withdrawalId: string): Promise<{ error?: string; otp?: WithdrawalOtpView }> {
  try {
    const s = await getWithdrawalOtpState(await requireCallerContext(), withdrawalId);
    return {
      otp: {
        status: s.challengeStatus,
        sentAt: s.sentAt,
        expiresAt: s.expiresAt,
        attemptsRemaining: s.attemptsRemaining,
        resendAvailableAt: s.resendAvailableAt,
        emailHint: s.emailHint,
        memberVerified: s.memberVerified,
        stage: s.stage,
      },
    };
  } catch (error) {
    return { error: messageFor(error, "The code status could not be loaded.") };
  }
}

// Log lines for the member's code (session 39): identifiers, outcome and
// counts only, through the redacting logger. Never the code, its hash or the
// secret. The code is also not logged by Next's dev-mode Server Function
// logging any more (next.config.ts `logging.serverFunctions: false`).
function otpFailureReason(error: unknown): string {
  if (error instanceof DatabaseError) return error.code;
  if (error instanceof ConfigError) return "unconfigured";
  return error instanceof Error ? error.name : "unknown";
}

export async function resendWithdrawalOtpAction(withdrawalId: string): Promise<{ error?: string; resendAvailableAt?: string }> {
  try {
    const r = await requestWithdrawalOtp(await requireCallerContext(), withdrawalId);
    logEvent("info", "withdrawal_otp_resend", { withdrawalId, challengeId: r.challengeId, result: "requested" });
    return { resendAvailableAt: r.resendAvailableAt };
  } catch (error) {
    logEvent("warn", "withdrawal_otp_resend", { withdrawalId, result: "refused", reason: otpFailureReason(error) });
    return { error: messageFor(error, "A new code could not be requested.") };
  }
}

export async function verifyWithdrawalOtpAction(
  slug: string,
  collectionSlug: string,
  input: { withdrawalId: string; code: string },
): Promise<{ error?: string; outcome?: WithdrawalOtpVerifyOutcome; attemptsRemaining?: number | null }> {
  const withdrawalId = String(input.withdrawalId ?? "");
  const code = normaliseWithdrawalOtpInput(String(input.code ?? ""));
  if (code === null) {
    logEvent("info", "withdrawal_otp_verify", { withdrawalId, outcome: "invalid_format" });
    return { error: "Enter the 6-digit code from the email." };
  }
  let challengeId: string | null = null;
  try {
    const caller = await requireCallerContext();
    const state = await getWithdrawalOtpState(caller, withdrawalId);
    challengeId = state.challengeId;
    if (state.challengeId === null) {
      logEvent("info", "withdrawal_otp_verify", { withdrawalId, outcome: "no_challenge" });
      return { error: "No code has been sent for this withdrawal yet. Request a new code." };
    }
    const result = await verifyWithdrawalOtp(caller, {
      withdrawalId,
      challengeId: state.challengeId,
      codeHash: hashWithdrawalOtp(loadWithdrawalOtpSecret(), state.challengeId, code),
    });
    logEvent(result.outcome === "verified" ? "info" : "warn", "withdrawal_otp_verify", {
      withdrawalId,
      challengeId: state.challengeId,
      outcome: result.outcome,
      attemptsRemaining: result.attemptsRemaining,
    });
    if (result.outcome === "verified") revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
    return { outcome: result.outcome, attemptsRemaining: result.attemptsRemaining };
  } catch (error) {
    if (error instanceof ConfigError) {
      // Operational, not the member's fault: say so in the server log (the
      // reason category only — never the variable's value) and nothing is counted.
      logEvent("error", "withdrawal_otp_verify", { withdrawalId, challengeId, outcome: "error", reason: "unconfigured" });
      return { error: "Codes cannot be checked right now. Nothing was counted against your attempts. Try again later." };
    }
    logEvent("warn", "withdrawal_otp_verify", { withdrawalId, challengeId, outcome: "error", reason: otpFailureReason(error) });
    return { error: messageFor(error, "The code could not be checked.") };
  }
}

// ── Payment activity ─────────────────────────────────────────────────────────

const ACTIVITY_PAGE_SIZE = 25;
/** Anything else from the browser is treated as "all". */
const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "successful", "pending", "failed", "withdrawals"];

/** One payment or withdrawal, kobo as decimal strings (null where it does not apply). */
export interface ActivityRowView {
  kind: "payment" | "withdrawal";
  id: string;
  occurredAt: string;
  name: string;
  isMember: boolean;
  reference: string;
  paymentStatus: ActivityPaymentStatus | null;
  verifiedAt: string | null;
  amountKobo: string;
  chargedKobo: string | null;
  processingFeeKobo: string | null;
  kolektoFeeKobo: string | null;
  totalFeesKobo: string | null;
  netKobo: string | null;
  feeBearer: "contributor_pays" | "community_absorbs" | null;
  eligibility: ActivityEligibility | null;
  eligibleAt: string | null;
  releasedAt: string | null;
  withdrawalStatus: WithdrawalStatus | null;
  destination: string | null;
  completedAt: string | null;
  detail: string | null;
}

const str = (value: bigint | null): string | null => (value === null ? null : value.toString());

/**
 * Who paid, how much, the payment's status and — separately — when its money
 * can be withdrawn. Needs transaction.view; withdrawals only with balance.view
 * (app.collection_payment_activity decides both).
 */
export async function activityPageAction(
  slug: string,
  collectionSlug: string,
  input: { filter: string; offset: number; limit?: number },
): Promise<{ error?: string; rows?: ActivityRowView[]; total?: number }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  const filter = (ACTIVITY_FILTERS as readonly string[]).includes(input.filter) ? (input.filter as ActivityFilter) : "all";
  const limit = Math.min(Math.max(Math.floor(input.limit ?? ACTIVITY_PAGE_SIZE), 1), 50);
  try {
    const page = await listCollectionPaymentActivity(await requireCallerContext(), {
      collectionId: resolved.collectionId,
      filter,
      limit,
      offset: Math.max(0, Math.floor(input.offset)),
    });
    return {
      total: page.total,
      rows: page.rows.map((r) => ({
        kind: r.kind,
        id: r.id,
        occurredAt: r.occurredAt,
        name: r.name,
        isMember: r.isMember,
        reference: r.reference,
        paymentStatus: r.paymentStatus,
        verifiedAt: r.verifiedAt,
        amountKobo: r.amountKobo.toString(),
        chargedKobo: str(r.chargedKobo),
        processingFeeKobo: str(r.processingFeeKobo),
        kolektoFeeKobo: str(r.kolektoFeeKobo),
        totalFeesKobo: str(r.totalFeesKobo),
        netKobo: str(r.netKobo),
        feeBearer: r.feeBearer,
        eligibility: r.eligibility,
        eligibleAt: r.eligibleAt,
        releasedAt: r.releasedAt,
        withdrawalStatus: r.withdrawalStatus,
        destination: r.destination,
        completedAt: r.completedAt,
        detail: r.detail,
      })),
    };
  } catch (error) {
    return { error: messageFor(error, "The activity for this collection could not be loaded.") };
  }
}

// ── Payment reminders ────────────────────────────────────────────────────────

export interface ReminderSummaryView {
  supported: boolean;
  unsupportedReason: ReminderUnsupportedReason | null;
  collectionActive: boolean;
  canSend: boolean;
  eligibleCount: number;
  paidCount: number;
  unpaidCount: number;
  exemptCount: number;
  remindedCount: number;
  remindableNowCount: number;
  remindersSent: number;
  lastSentAt: string | null;
}

export interface ReminderRowView {
  memberId: string;
  fullName: string;
  memberCode: string | null;
  paid: boolean;
  exempt: boolean;
  lastRemindedAt: string | null;
  reminderCount: number;
  lastEmailStatus: string | null;
  canRemind: boolean;
  blockedReason: ReminderBlockedReason | null;
}

export async function loadRemindersAction(
  slug: string,
  collectionSlug: string,
  input: { filter: ReminderFilter; search?: string; offset: number },
): Promise<{ error?: string; summary?: ReminderSummaryView; rows?: ReminderRowView[]; total?: number }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  try {
    const caller = await requireCallerContext();
    const [s, page] = await Promise.all([
      getPaymentReminderSummary(caller, resolved.collectionId),
      listPaymentReminderRoster(caller, {
        collectionId: resolved.collectionId,
        filter: input.filter,
        search: input.search?.slice(0, 100),
        limit: REMINDER_PAGE_SIZE,
        offset: Math.max(0, Math.floor(input.offset)),
      }),
    ]);
    return {
      summary: {
        supported: s.supported,
        unsupportedReason: s.unsupportedReason,
        collectionActive: s.collectionActive,
        canSend: s.canSend,
        eligibleCount: s.eligibleCount,
        paidCount: s.paidCount,
        unpaidCount: s.unpaidCount,
        exemptCount: s.exemptCount,
        remindedCount: s.remindedCount,
        remindableNowCount: s.remindableNowCount,
        remindersSent: s.remindersSent,
        lastSentAt: s.lastSentAt,
      },
      rows: page.rows.map((r) => ({
        memberId: r.memberId,
        fullName: r.fullName,
        memberCode: r.memberCode,
        paid: r.paid,
        exempt: r.exempt,
        lastRemindedAt: r.lastRemindedAt,
        reminderCount: r.reminderCount,
        lastEmailStatus: r.lastEmailStatus,
        canRemind: r.canRemind,
        blockedReason: r.blockedReason,
      })),
      total: page.total,
    };
  } catch (error) {
    return { error: messageFor(error, "Reminders could not be loaded.") };
  }
}

export async function sendRemindersAction(
  slug: string,
  collectionSlug: string,
  input: { memberIds: string[]; idempotencyKey: string },
): Promise<{
  error?: string;
  sent?: number;
  skipped?: { paid: number; cooldown: number; ineligible: number; unreachable: number };
}> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  if (input.memberIds.length === 0) return { error: "Choose at least one member." };
  try {
    const r = await sendPaymentReminders(await requireCallerContext(), {
      collectionId: resolved.collectionId,
      memberIds: input.memberIds.slice(0, 500),
      idempotencyKey: input.idempotencyKey.slice(0, 120),
    });
    return {
      sent: r.sentCount,
      skipped: { paid: r.skippedPaid, cooldown: r.skippedCooldown, ineligible: r.skippedIneligible, unreachable: r.skippedUnreachable },
    };
  } catch (error) {
    return { error: messageFor(error, "The reminders could not be sent.") };
  }
}
