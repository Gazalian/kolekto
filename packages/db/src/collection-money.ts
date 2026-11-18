/**
 * collection-money.ts — typed callers for the collection's settlement,
 * ledger, reconciliation, withdrawals, payment reminders and contributor
 * reference lock (20261117100100 … 20261117100500).
 *
 * Every call runs as the signed-in officer (`withCallerContext`), so the
 * database decides permission against the collection: balance.view for money
 * reads, withdrawal.request / owner for withdrawals, transaction.view and
 * reminder.send for reminders. Nothing here computes money: kobo arrives as
 * decimal strings and is handed on as `bigint`. Operator steps (recording a
 * provider settlement, marking a payout paid or failed) are deliberately NOT
 * here: they refuse every client role and are run by operations (runbook in
 * docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md).
 */

import type { TransactionSql } from "postgres";
import { type CallerContext, runWrite, withCallerContext } from "./client.ts";

function call<T>(caller: CallerContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => withCallerContext(caller, fn));
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

// ── Settlement ───────────────────────────────────────────────────────────────

export interface CollectionSettlementSummary {
  /** Confirmed by the provider, waiting for its release time. */
  scheduledKobo: bigint;
  scheduledCount: number;
  /** Release time passed; the provider's settlement is not recorded yet. */
  awaitingProviderKobo: bigint;
  awaitingProviderCount: number;
  /** The provider settled a different amount: held for Kolekto to resolve. */
  discrepancyKobo: bigint;
  discrepancyCount: number;
  releasedKobo: bigint;
  releasedCount: number;
  nextReleaseAt: string | null;
  lastReleaseAt: string | null;
  scheduleTimezone: string;
  /** "05:00:00" */
  scheduleReleaseTime: string;
  scheduleDayOffset: number;
  requiresProviderConfirmation: boolean;
  /** Every reconciliation identity for this collection holds. */
  reconciled: boolean;
}

interface SettlementRow {
  scheduled_kobo: string;
  scheduled_count: number;
  awaiting_provider_kobo: string;
  awaiting_provider_count: number;
  discrepancy_kobo: string;
  discrepancy_count: number;
  released_kobo: string;
  released_count: number;
  next_release_at: Date | null;
  last_release_at: Date | null;
  schedule_timezone: string;
  schedule_release_time: string;
  schedule_day_offset: number;
  requires_provider_confirmation: boolean;
  reconciled: boolean;
}

export async function getCollectionSettlementSummary(
  caller: CallerContext,
  collectionId: string,
): Promise<CollectionSettlementSummary> {
  const [row] = await call(caller, (tx) =>
    tx<SettlementRow[]>`select * from app.collection_settlement_summary(${collectionId})`,
  );
  if (!row) throw new Error("collection_settlement_summary returned no row");
  return {
    scheduledKobo: BigInt(row.scheduled_kobo),
    scheduledCount: row.scheduled_count,
    awaitingProviderKobo: BigInt(row.awaiting_provider_kobo),
    awaitingProviderCount: row.awaiting_provider_count,
    discrepancyKobo: BigInt(row.discrepancy_kobo),
    discrepancyCount: row.discrepancy_count,
    releasedKobo: BigInt(row.released_kobo),
    releasedCount: row.released_count,
    nextReleaseAt: iso(row.next_release_at),
    lastReleaseAt: iso(row.last_release_at),
    scheduleTimezone: row.schedule_timezone,
    scheduleReleaseTime: String(row.schedule_release_time),
    scheduleDayOffset: Number(row.schedule_day_offset),
    requiresProviderConfirmation: row.requires_provider_confirmation,
    reconciled: row.reconciled,
  };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export interface ReconciliationCheck {
  checkName: string;
  expectedKobo: bigint;
  ledgerKobo: bigint;
  differenceKobo: bigint;
  ok: boolean;
}

export async function getCollectionReconciliation(caller: CallerContext, collectionId: string): Promise<ReconciliationCheck[]> {
  const rows = await call(caller, (tx) =>
    tx<{ check_name: string; expected_kobo: string; ledger_kobo: string; difference_kobo: string; ok: boolean }[]>`
      select * from app.collection_reconciliation(${collectionId})
    `,
  );
  return rows.map((r) => ({
    checkName: r.check_name,
    expectedKobo: BigInt(r.expected_kobo),
    ledgerKobo: BigInt(r.ledger_kobo),
    differenceKobo: BigInt(r.difference_kobo),
    ok: r.ok,
  }));
}

// ── Ledger activity ──────────────────────────────────────────────────────────

export interface CollectionLedgerEntry {
  journalId: string;
  occurredAt: string;
  postedAt: string;
  /** capture, fee, balance_release, withdrawal, payout, … */
  sourceType: string;
  reason: string;
  /** KLK payment reference or KWD withdrawal reference, when there is one. */
  reference: string | null;
  /** Signed changes to this collection's accounts (positive = the balance grew). */
  pendingChangeKobo: bigint;
  availableChangeKobo: bigint;
  withdrawingChangeKobo: bigint;
  withdrawnChangeKobo: bigint;
  otherChangeKobo: bigint;
  /** This journal reverses another (a released hold). */
  reversesJournalId: string | null;
}

export interface CollectionLedgerPage {
  rows: CollectionLedgerEntry[];
  total: number;
}

interface LedgerRow {
  journal_id: string;
  occurred_at: Date;
  posted_at: Date;
  source_type: string;
  reason: string;
  reference: string | null;
  pending_change: string;
  available_change: string;
  withdrawing_change: string;
  withdrawn_change: string;
  other_change: string;
  reverses_journal_id: string | null;
  total_count: string;
}

/** A kind-of-movement filter, applied by the database before paging (20261117120100). */
export type LedgerKind = "all" | "contributions" | "fees" | "settlement" | "withdrawals" | "refunds" | "adjustments";

export async function listCollectionLedger(
  caller: CallerContext,
  input: { collectionId: string; limit: number; offset: number; kind?: LedgerKind },
): Promise<CollectionLedgerPage> {
  const rows = await call(caller, (tx) =>
    input.kind
      ? tx<LedgerRow[]>`
          select journal_id, occurred_at, posted_at, source_type, reason, reference,
                 pending_change, available_change, withdrawing_change, withdrawn_change, other_change,
                 reverses_journal_id, total_count
          from app.collection_ledger_by_kind(${input.collectionId}, ${input.kind}, ${input.limit}, ${input.offset})
        `
      : tx<LedgerRow[]>`
          select journal_id, occurred_at, posted_at, source_type, reason, reference,
                 pending_change, available_change, withdrawing_change, withdrawn_change, other_change,
                 reverses_journal_id, total_count
          from app.collection_ledger(${input.collectionId}, ${input.limit}, ${input.offset})
        `,
  );
  return {
    rows: rows.map((r) => ({
      journalId: r.journal_id,
      occurredAt: r.occurred_at.toISOString(),
      postedAt: r.posted_at.toISOString(),
      sourceType: r.source_type,
      reason: r.reason,
      reference: r.reference,
      pendingChangeKobo: BigInt(r.pending_change),
      availableChangeKobo: BigInt(r.available_change),
      withdrawingChangeKobo: BigInt(r.withdrawing_change),
      withdrawnChangeKobo: BigInt(r.withdrawn_change),
      otherChangeKobo: BigInt(r.other_change),
      reversesJournalId: r.reverses_journal_id,
    })),
    total: rows[0] ? Number(rows[0].total_count) : 0, // invariant-allow: total_count is a row count (bigint from count(*) over ()), not money
  };
}

// ── Withdrawals ──────────────────────────────────────────────────────────────

export type WithdrawalStatus = "requested" | "approved" | "processing" | "paid" | "failed" | "rejected" | "cancelled";

export interface CollectionWithdrawal {
  id: string;
  reference: string;
  amountKobo: bigint;
  feeKobo: bigint;
  status: WithdrawalStatus;
  isFirst: boolean;
  requiresManualReview: boolean;
  accountName: string;
  /** Only the last four digits ever leave the database. */
  accountLast4: string;
  bankName: string;
  requestedByName: string | null;
  requestedAt: string;
  approvedAt: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  paidAt: string | null;
  payoutReference: string | null;
  failedAt: string | null;
  failureReason: string | null;
  canDecide: boolean;
  canCancel: boolean;
}

interface WithdrawalRow {
  id: string;
  reference: string;
  amount_kobo: string;
  fee_kobo: string;
  status: WithdrawalStatus;
  is_first: boolean;
  requires_manual_review: boolean;
  account_name: string;
  account_last4: string;
  bank_name: string;
  requested_by_name: string | null;
  requested_at: Date;
  approved_at: Date | null;
  decided_at: Date | null;
  decision_reason: string | null;
  paid_at: Date | null;
  payout_reference: string | null;
  failed_at: Date | null;
  failure_reason: string | null;
  can_decide: boolean;
  can_cancel: boolean;
}

export async function listCollectionWithdrawals(caller: CallerContext, collectionId: string): Promise<CollectionWithdrawal[]> {
  const rows = await call(caller, (tx) => tx<WithdrawalRow[]>`select * from app.collection_withdrawals(${collectionId})`);
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    amountKobo: BigInt(r.amount_kobo),
    feeKobo: BigInt(r.fee_kobo),
    status: r.status,
    isFirst: r.is_first,
    requiresManualReview: r.requires_manual_review,
    accountName: r.account_name,
    accountLast4: r.account_last4,
    bankName: r.bank_name,
    requestedByName: r.requested_by_name,
    requestedAt: r.requested_at.toISOString(),
    approvedAt: iso(r.approved_at),
    decidedAt: iso(r.decided_at),
    decisionReason: r.decision_reason,
    paidAt: iso(r.paid_at),
    payoutReference: r.payout_reference,
    failedAt: iso(r.failed_at),
    failureReason: r.failure_reason,
    canDecide: r.can_decide,
    canCancel: r.can_cancel,
  }));
}

export interface WithdrawalRequestResult {
  withdrawalId: string;
  reference: string;
  status: WithdrawalStatus;
  feeKobo: bigint;
  /** True when this idempotency key was already used: the first request is returned. */
  reused: boolean;
}

/**
 * Request a withdrawal. The database locks the collection's available
 * balance, re-reads it, applies every rule (identity, first-free, fee
 * schedule, daily limit) and holds the money in the same transaction.
 */
export async function requestWithdrawal(
  caller: CallerContext,
  input: {
    collectionId: string;
    amountKobo: bigint;
    accountName: string;
    accountNumber: string;
    bankName: string;
    idempotencyKey: string;
  },
): Promise<WithdrawalRequestResult> {
  const [row] = await call(caller, (tx) =>
    tx<{ withdrawal_id: string; reference: string; status: WithdrawalStatus; fee_kobo: string; reused: boolean }[]>`
      select * from app.request_withdrawal(
        ${input.collectionId}, ${input.amountKobo.toString()}::bigint,
        ${input.accountName}, ${input.accountNumber}, ${input.bankName}, ${input.idempotencyKey}
      )
    `,
  );
  if (!row) throw new Error("request_withdrawal returned no row");
  return {
    withdrawalId: row.withdrawal_id,
    reference: row.reference,
    status: row.status,
    feeKobo: BigInt(row.fee_kobo),
    reused: row.reused,
  };
}

export async function decideWithdrawal(
  caller: CallerContext,
  input: { withdrawalId: string; decision: "approve" | "reject" | "cancel"; reason?: string | null },
): Promise<WithdrawalStatus> {
  const [row] = await call(caller, (tx) =>
    tx<{ status: WithdrawalStatus }[]>`
      select app.decide_withdrawal(${input.withdrawalId}, ${input.decision}, ${input.reason ?? null}) as status
    `,
  );
  if (!row) throw new Error("decide_withdrawal returned no row");
  return row.status;
}

// ── Payment reminders ────────────────────────────────────────────────────────

export type ReminderUnsupportedReason = "public_collection" | "recurring_collection";

export interface PaymentReminderSummary {
  supported: boolean;
  unsupportedReason: ReminderUnsupportedReason | null;
  collectionActive: boolean;
  collectionReachable: boolean;
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

export async function getPaymentReminderSummary(caller: CallerContext, collectionId: string): Promise<PaymentReminderSummary> {
  const [r] = await call(caller, (tx) =>
    tx<{
      supported: boolean;
      unsupported_reason: ReminderUnsupportedReason | null;
      collection_active: boolean;
      collection_reachable: boolean;
      can_send: boolean;
      eligible_count: number;
      paid_count: number;
      unpaid_count: number;
      exempt_count: number;
      reminded_count: number;
      remindable_now_count: number;
      reminders_sent: number;
      last_sent_at: Date | null;
    }[]>`select * from app.payment_reminder_summary(${collectionId})`,
  );
  if (!r) throw new Error("payment_reminder_summary returned no row");
  return {
    supported: r.supported,
    unsupportedReason: r.unsupported_reason,
    collectionActive: r.collection_active,
    collectionReachable: r.collection_reachable,
    canSend: r.can_send,
    eligibleCount: r.eligible_count,
    paidCount: r.paid_count,
    unpaidCount: r.unpaid_count,
    exemptCount: r.exempt_count,
    remindedCount: r.reminded_count,
    remindableNowCount: r.remindable_now_count,
    remindersSent: r.reminders_sent,
    lastSentAt: iso(r.last_sent_at),
  };
}

export type ReminderFilter = "all" | "unpaid" | "paid" | "reminded";
export type ReminderBlockedReason = "paid" | "exempt" | "opted_out" | "no_contact" | "cooldown";

export interface PaymentReminderRosterRow {
  memberId: string;
  fullName: string;
  memberCode: string | null;
  paid: boolean;
  paymentCount: number;
  exempt: boolean;
  lastRemindedAt: string | null;
  reminderCount: number;
  /** The last reminder email's delivery status (pending, sent, skipped, …), when there was one. */
  lastEmailStatus: string | null;
  canRemind: boolean;
  blockedReason: ReminderBlockedReason | null;
}

export async function listPaymentReminderRoster(
  caller: CallerContext,
  input: { collectionId: string; filter: ReminderFilter; search?: string | undefined; limit: number; offset: number },
): Promise<{ rows: PaymentReminderRosterRow[]; total: number }> {
  const rows = await call(caller, (tx) =>
    tx<{
      member_id: string;
      full_name: string;
      member_code: string | null;
      paid: boolean;
      payment_count: number;
      exempt: boolean;
      last_reminded_at: Date | null;
      reminder_count: number;
      last_email_status: string | null;
      can_remind: boolean;
      blocked_reason: ReminderBlockedReason | null;
      total_count: string;
    }[]>`
      select * from app.payment_reminder_roster(
        ${input.collectionId}, ${input.filter}, ${input.search ?? null}, ${input.limit}, ${input.offset}
      )
    `,
  );
  return {
    rows: rows.map((r) => ({
      memberId: r.member_id,
      fullName: r.full_name,
      memberCode: r.member_code,
      paid: r.paid,
      paymentCount: r.payment_count,
      exempt: r.exempt,
      lastRemindedAt: iso(r.last_reminded_at),
      reminderCount: r.reminder_count,
      lastEmailStatus: r.last_email_status,
      canRemind: r.can_remind,
      blockedReason: r.blocked_reason,
    })),
    total: rows[0] ? Number(rows[0].total_count) : 0, // invariant-allow: total_count is a row count (bigint from count(*) over ()), not money
  };
}

export interface SendPaymentRemindersResult {
  /** Null when nobody in the selection could be reminded (nothing recorded). */
  batchId: string | null;
  sentCount: number;
  skippedPaid: number;
  skippedCooldown: number;
  skippedIneligible: number;
  skippedUnreachable: number;
  reused: boolean;
}

export async function sendPaymentReminders(
  caller: CallerContext,
  input: { collectionId: string; memberIds: readonly string[]; idempotencyKey: string },
): Promise<SendPaymentRemindersResult> {
  const [r] = await call(caller, (tx) =>
    tx<{
      batch_id: string | null;
      sent_count: number;
      skipped_paid: number;
      skipped_cooldown: number;
      skipped_ineligible: number;
      skipped_unreachable: number;
      reused: boolean;
    }[]>`
      select * from app.send_payment_reminders(${input.collectionId}, ${[...input.memberIds]}::uuid[], ${input.idempotencyKey})
    `,
  );
  if (!r) throw new Error("send_payment_reminders returned no row");
  return {
    batchId: r.batch_id,
    sentCount: r.sent_count,
    skippedPaid: r.skipped_paid,
    skippedCooldown: r.skipped_cooldown,
    skippedIneligible: r.skipped_ineligible,
    skippedUnreachable: r.skipped_unreachable,
    reused: r.reused,
  };
}

// ── Contributor references ───────────────────────────────────────────────────

/** True once the provider has confirmed money for this collection: reference settings can no longer gain anything new. */
export async function collectionHasContributorActivity(caller: CallerContext, collectionId: string): Promise<boolean> {
  const [row] = await call(caller, (tx) =>
    tx<{ active: boolean }[]>`select app.collection_has_contributor_activity(${collectionId}) as active`,
  );
  return row?.active === true;
}

// ── Who is expected to pay (20261117120000) ──────────────────────────────────

export type ExpectedUnsupportedReason = "no_member_list" | "recurring_collection";

/**
 * Expected payers and the amount members are still EXPECTED to pay. Not money
 * received and never part of a balance: shown beside the ledger figures.
 */
export interface CollectionExpectedSummary {
  supported: boolean;
  unsupportedReason: ExpectedUnsupportedReason | null;
  expectedCount: number;
  paidCount: number;
  partlyPaidCount: number;
  unpaidCount: number;
  exemptCount: number;
  expectedKobo: bigint;
  receivedKobo: bigint;
  outstandingKobo: bigint;
  /** False when some expected members' amounts are unknown: outstanding is then a floor. */
  outstandingComplete: boolean;
}

export async function getCollectionExpectedSummary(
  caller: CallerContext,
  collectionId: string,
): Promise<CollectionExpectedSummary> {
  const [r] = await call(caller, (tx) =>
    tx<{
      supported: boolean;
      unsupported_reason: ExpectedUnsupportedReason | null;
      expected_count: number;
      paid_count: number;
      partly_paid_count: number;
      unpaid_count: number;
      exempt_count: number;
      expected_kobo: string;
      received_kobo: string;
      outstanding_kobo: string;
      outstanding_complete: boolean;
    }[]>`
      select supported, unsupported_reason, expected_count, paid_count, partly_paid_count, unpaid_count,
             exempt_count, expected_kobo::text, received_kobo::text, outstanding_kobo::text, outstanding_complete
      from app.collection_expected_summary(${collectionId})
    `,
  );
  if (!r) throw new Error("collection_expected_summary returned no row");
  return {
    supported: r.supported,
    unsupportedReason: r.unsupported_reason,
    expectedCount: r.expected_count,
    paidCount: r.paid_count,
    partlyPaidCount: r.partly_paid_count,
    unpaidCount: r.unpaid_count,
    exemptCount: r.exempt_count,
    expectedKobo: BigInt(r.expected_kobo),
    receivedKobo: BigInt(r.received_kobo),
    outstandingKobo: BigInt(r.outstanding_kobo),
    outstandingComplete: r.outstanding_complete,
  };
}

// ── Payment activity (20261117130000) ────────────────────────────────────────

/** What happened to the payment itself. Never changed by T+1. */
export type ActivityPaymentStatus = "successful" | "pending" | "under_review" | "failed";
/** When a successful payment's net can be withdrawn. Null for anything else. */
export type ActivityEligibility = "scheduled" | "awaiting_provider" | "held" | "released";
export type ActivityFilter = "all" | "successful" | "pending" | "failed" | "withdrawals";

/**
 * One payment attempt or one withdrawal. Fees are the frozen lines of a
 * successful payment (D-16); null for anything that did not succeed. The
 * provider's own cost to Kolekto is never here (D-28).
 */
export interface CollectionActivityRow {
  kind: "payment" | "withdrawal";
  id: string;
  occurredAt: string;
  name: string;
  isMember: boolean;
  reference: string;
  paymentStatus: ActivityPaymentStatus | null;
  verifiedAt: string | null;
  amountKobo: bigint;
  chargedKobo: bigint | null;
  processingFeeKobo: bigint | null;
  kolektoFeeKobo: bigint | null;
  totalFeesKobo: bigint | null;
  netKobo: bigint | null;
  feeBearer: "contributor_pays" | "community_absorbs" | null;
  eligibility: ActivityEligibility | null;
  eligibleAt: string | null;
  releasedAt: string | null;
  withdrawalStatus: WithdrawalStatus | null;
  destination: string | null;
  completedAt: string | null;
  detail: string | null;
}

export async function listCollectionPaymentActivity(
  caller: CallerContext,
  input: { collectionId: string; filter: ActivityFilter; limit: number; offset: number },
): Promise<{ rows: CollectionActivityRow[]; total: number }> {
  const rows = await call(caller, (tx) =>
    tx<{
      kind: "payment" | "withdrawal";
      id: string;
      occurred_at: Date;
      name: string;
      is_member: boolean;
      reference: string;
      payment_status: ActivityPaymentStatus | null;
      verified_at: Date | null;
      amount_kobo: string;
      charged_kobo: string | null;
      processing_fee_kobo: string | null;
      kolekto_fee_kobo: string | null;
      total_fees_kobo: string | null;
      net_kobo: string | null;
      fee_bearer: "contributor_pays" | "community_absorbs" | null;
      eligibility: ActivityEligibility | null;
      eligible_at: Date | null;
      released_at: Date | null;
      withdrawal_status: WithdrawalStatus | null;
      destination: string | null;
      completed_at: Date | null;
      detail: string | null;
      total_count: string;
    }[]>`
      select kind, id, occurred_at, name, is_member, reference, payment_status, verified_at,
             amount_kobo::text, charged_kobo::text, processing_fee_kobo::text, kolekto_fee_kobo::text,
             total_fees_kobo::text, net_kobo::text, fee_bearer, eligibility, eligible_at, released_at,
             withdrawal_status, destination, completed_at, detail, total_count::text
      from app.collection_payment_activity(${input.collectionId}, ${input.filter}, ${input.limit}, ${input.offset})
    `,
  );
  const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));
  return {
    total: rows[0] ? Number(rows[0].total_count) : 0, // invariant-allow: total_count is a row count (bigint from count(*) over ()), not money
    rows: rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      occurredAt: r.occurred_at.toISOString(),
      name: r.name,
      isMember: r.is_member,
      reference: r.reference,
      paymentStatus: r.payment_status,
      verifiedAt: iso(r.verified_at),
      amountKobo: BigInt(r.amount_kobo),
      chargedKobo: big(r.charged_kobo),
      processingFeeKobo: big(r.processing_fee_kobo),
      kolektoFeeKobo: big(r.kolekto_fee_kobo),
      totalFeesKobo: big(r.total_fees_kobo),
      netKobo: big(r.net_kobo),
      feeBearer: r.fee_bearer,
      eligibility: r.eligibility,
      eligibleAt: iso(r.eligible_at),
      releasedAt: iso(r.released_at),
      withdrawalStatus: r.withdrawal_status,
      destination: r.destination,
      completedAt: iso(r.completed_at),
      detail: r.detail,
    })),
  };
}
