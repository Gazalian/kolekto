"use server";

import {
  DatabaseError,
  decideWithdrawal,
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
import { fromNaira, MoneyError } from "@kolekto/domain";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../../lib/caller.ts";
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
    case "IDENTITY_VERIFICATION_REQUIRED":
      return "Withdrawals need an identity-verified officer. Complete identity verification first.";
    case "WITHDRAWAL_FEE_NOT_CONFIGURED":
      return "This collection's free first withdrawal has been used, and further withdrawals are not available yet.";
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
      return "That withdrawal has already moved on. Reload to see where it is.";
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
  input: { amount: string; accountName: string; accountNumber: string; bankName: string; idempotencyKey: string },
): Promise<{ error?: string; reference?: string; status?: WithdrawalStatus }> {
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
  if (!/^[0-9]{10}$/.test(input.accountNumber.trim())) return { error: "Enter the 10-digit account number." };
  try {
    const result = await requestWithdrawal(await requireCallerContext(), {
      collectionId: resolved.collectionId,
      amountKobo,
      accountName: input.accountName.trim().slice(0, 120),
      accountNumber: input.accountNumber.trim(),
      bankName: input.bankName.trim().slice(0, 80),
      idempotencyKey: input.idempotencyKey.slice(0, 120),
    });
    revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
    return { reference: result.reference, status: result.status };
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
