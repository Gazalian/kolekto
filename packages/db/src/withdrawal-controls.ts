/**
 * withdrawal-controls.ts — typed callers for 20261119120000: the requesting
 * member's one-time code, transfer leases / checks / escalation (PA-08,
 * PA-09), Paystack server approval and the read-only transfer reconciliation
 * report (P8-4).
 *
 *   · signed-in member (`withCallerContext`): resend a code, read its state,
 *     verify it. The database checks the caller is the requester.
 *   · server / worker (`PaymentDb`, operator connection): deliver codes,
 *     claim and record transfer checks, release a never-sent hold, answer
 *     Paystack's approval request, store a reconciliation run.
 *
 * The one-time code itself never reaches the database: callers pass
 * HMAC(server secret, challenge id + ":" + code). Nothing here logs.
 */

import type { TransactionSql } from "postgres";

import { type CallerContext, runWrite, withCallerContext } from "./client.ts";
import type { OpenTransferStatus } from "./bank-accounts.ts";
import type { PaymentDb } from "./payments.ts";

function asUser<T>(caller: CallerContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => withCallerContext(caller, fn));
}
function asServer<T>(db: PaymentDb, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => db(fn));
}
const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

// ── Member one-time code (signed-in requester) ───────────────────────────────

export type WithdrawalOtpChallengeStatus =
  | "pending_delivery"
  | "sending"
  | "sent"
  | "delivery_failed"
  | "verified"
  | "locked"
  | "expired"
  | "superseded"
  | "cancelled";

export interface WithdrawalOtpState {
  challengeId: string | null;
  challengeStatus: WithdrawalOtpChallengeStatus | null;
  sentAt: string | null;
  expiresAt: string | null;
  attemptsRemaining: number | null;
  resendAvailableAt: string;
  /** e.g. "a•••@example.com". Null when the sign-in email is not confirmed. */
  emailHint: string | null;
  memberVerified: boolean;
  stage: string;
}

export async function getWithdrawalOtpState(caller: CallerContext, withdrawalId: string): Promise<WithdrawalOtpState> {
  const [row] = await asUser(caller, (tx) =>
    tx<{
      challenge_id: string | null;
      challenge_status: WithdrawalOtpChallengeStatus | null;
      sent_at: Date | null;
      expires_at: Date | null;
      attempts_remaining: number | null;
      resend_available_at: Date;
      email_hint: string | null;
      member_verified: boolean;
      stage: string;
    }[]>`select * from app.withdrawal_otp_state(${withdrawalId})`,
  );
  if (!row) throw new Error("withdrawal_otp_state returned no row");
  return {
    challengeId: row.challenge_id,
    challengeStatus: row.challenge_status,
    sentAt: iso(row.sent_at),
    expiresAt: iso(row.expires_at),
    attemptsRemaining: row.attempts_remaining,
    resendAvailableAt: row.resend_available_at.toISOString(),
    emailHint: row.email_hint,
    memberVerified: row.member_verified,
    stage: row.stage,
  };
}

/** A new code (supersedes the open one). Rate limited by the database. */
export async function requestWithdrawalOtp(
  caller: CallerContext,
  withdrawalId: string,
): Promise<{ challengeId: string; resendAvailableAt: string }> {
  const [row] = await asUser(caller, (tx) =>
    tx<{ challenge_id: string; resend_available_at: Date }[]>`select * from app.request_withdrawal_otp(${withdrawalId})`,
  );
  if (!row) throw new Error("request_withdrawal_otp returned no row");
  return { challengeId: row.challenge_id, resendAvailableAt: row.resend_available_at.toISOString() };
}

export type WithdrawalOtpVerifyOutcome =
  | "verified"
  | "already_verified"
  | "incorrect"
  | "locked"
  | "expired"
  | "superseded"
  | "not_sent"
  | "withdrawal_closed";

export async function verifyWithdrawalOtp(
  caller: CallerContext,
  input: { withdrawalId: string; challengeId: string; codeHash: string },
): Promise<{ outcome: WithdrawalOtpVerifyOutcome; attemptsRemaining: number | null }> {
  const [row] = await asUser(caller, (tx) =>
    tx<{ outcome: WithdrawalOtpVerifyOutcome; attempts_remaining: number | null }[]>`
      select * from app.verify_withdrawal_otp(${input.withdrawalId}, ${input.challengeId}, ${input.codeHash})
    `,
  );
  if (!row) throw new Error("verify_withdrawal_otp returned no row");
  return { outcome: row.outcome, attemptsRemaining: row.attempts_remaining };
}

// ── Designated second approvers (20261120100000, 20261120140000) ─────────────
// Owner only (the database checks): who may approve a withdrawal requested by
// a community owner. Several designations may be active at once.

export interface WithdrawalApproverCandidate {
  userId: string;
  fullName: string;
  officerRole: "owner" | "admin";
  officerTitle: string | null;
  officerSince: string;
  designated: boolean;
}

export interface WithdrawalApproverDesignation {
  designationId: string;
  userId: string;
  fullName: string;
  designatedByName: string;
  startedAt: string;
  endedByName: string | null;
  endedAt: string | null;
  /** Not ended. */
  active: boolean;
  /** Active, and the person still holds an admin/owner term with an active account. */
  eligible: boolean;
  /** Their current admin/owner role, or null when they no longer hold one. */
  officerRole: "owner" | "admin" | null;
}

export async function listWithdrawalApproverCandidates(caller: CallerContext, communityId: string): Promise<WithdrawalApproverCandidate[]> {
  const rows = await asUser(caller, (tx) =>
    tx<{
      user_id: string;
      full_name: string;
      officer_role: "owner" | "admin";
      officer_title: string | null;
      officer_since: Date;
      designated: boolean;
    }[]>`select * from app.withdrawal_approver_candidates(${communityId})`,
  );
  return rows
    .map((r) => ({
      userId: r.user_id,
      fullName: r.full_name,
      officerRole: r.officer_role,
      officerTitle: r.officer_title,
      officerSince: r.officer_since.toISOString(),
      designated: r.designated,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function listWithdrawalApproverHistory(caller: CallerContext, communityId: string): Promise<WithdrawalApproverDesignation[]> {
  const rows = await asUser(caller, (tx) =>
    tx<{
      designation_id: string;
      user_id: string;
      full_name: string;
      designated_by_name: string;
      started_at: Date;
      ended_by_name: string | null;
      ended_at: Date | null;
      active: boolean;
      eligible: boolean;
      officer_role: "owner" | "admin" | null;
    }[]>`select * from app.withdrawal_approver_history(${communityId})`,
  );
  return rows.map((r) => ({
    designationId: r.designation_id,
    userId: r.user_id,
    fullName: r.full_name,
    designatedByName: r.designated_by_name,
    startedAt: r.started_at.toISOString(),
    endedByName: r.ended_by_name,
    endedAt: iso(r.ended_at),
    active: r.active,
    eligible: r.eligible,
    officerRole: r.officer_role,
  }));
}

/** Designate (active = true) or end (false). False: nothing changed (already so). */
export async function setWithdrawalApprover(
  caller: CallerContext,
  input: { communityId: string; userId: string; active: boolean },
): Promise<boolean> {
  const [row] = await asUser(caller, (tx) =>
    tx<{ changed: boolean }[]>`select app.set_withdrawal_approver(${input.communityId}, ${input.userId}, ${input.active}) as changed`,
  );
  return row?.changed === true;
}

/** Ends one designation and starts another in one transaction. Returns the new designation id. */
export async function replaceWithdrawalApprover(
  caller: CallerContext,
  input: { communityId: string; fromUserId: string; toUserId: string },
): Promise<string> {
  const [row] = await asUser(caller, (tx) =>
    tx<{ id: string }[]>`select app.replace_withdrawal_approver(${input.communityId}, ${input.fromUserId}, ${input.toUserId}) as id`,
  );
  if (!row) throw new Error("replace_withdrawal_approver returned no row");
  return row.id;
}

// ── Member one-time code (worker delivery) ───────────────────────────────────

export interface WithdrawalOtpDelivery {
  challengeId: string;
  withdrawalId: string;
  /** The requester's confirmed sign-in email; null when it is no longer confirmed. */
  email: string | null;
  recipientName: string | null;
  withdrawalReference: string;
  amountKobo: bigint;
  collectionName: string;
  communityName: string;
  bankName: string;
  accountLast4: string;
}

export async function claimWithdrawalOtpDeliveries(db: PaymentDb, limit: number): Promise<WithdrawalOtpDelivery[]> {
  const rows = await asServer(db, (tx) =>
    tx<{
      challenge_id: string;
      withdrawal_id: string;
      email: string | null;
      recipient_name: string | null;
      withdrawal_reference: string;
      amount_kobo: string;
      collection_name: string;
      community_name: string;
      bank_name: string;
      account_last4: string;
    }[]>`select * from app.claim_withdrawal_otp_deliveries(${limit}::integer)`,
  );
  return rows.map((r) => ({
    challengeId: r.challenge_id,
    withdrawalId: r.withdrawal_id,
    email: r.email,
    recipientName: r.recipient_name,
    withdrawalReference: r.withdrawal_reference,
    amountKobo: BigInt(r.amount_kobo),
    collectionName: r.collection_name,
    communityName: r.community_name,
    bankName: r.bank_name,
    accountLast4: r.account_last4,
  }));
}

/** Stores the code's keyed hash before sending. False: do not send (superseded or already issued). */
export async function recordWithdrawalOtpIssued(db: PaymentDb, challengeId: string, codeHash: string): Promise<boolean> {
  const [row] = await asServer(db, (tx) =>
    tx<{ ok: boolean }[]>`select app.record_withdrawal_otp_issued(${challengeId}, ${codeHash}) as ok`,
  );
  return row?.ok === true;
}

export async function recordWithdrawalOtpDelivery(
  db: PaymentDb,
  challengeId: string,
  delivered: boolean,
  error: string | null,
): Promise<string> {
  const [row] = await asServer(db, (tx) =>
    tx<{ status: string }[]>`select app.record_withdrawal_otp_delivery(${challengeId}, ${delivered}, ${error}) as status`,
  );
  return row?.status ?? "unknown";
}

// ── Transfers: leases, checks, release (PA-08 / PA-09) ───────────────────────

export interface ClaimedOpenTransfer {
  reference: string;
  status: OpenTransferStatus;
  transferCode: string | null;
  amountKobo: bigint;
  recipientCode: string | null;
  bankAccountId: string | null;
  checkCount: number;
  notFoundCount: number;
  /** Null: Kolekto provably never asked Paystack to send it. */
  initiateRequestedAt: string | null;
  refusedAt: string | null;
  refusalCode: string | null;
  escalatedAt: string | null;
  createdAt: string;
  claimToken: string;
  withdrawalReference: string | null;
}

export async function claimWithdrawalTransfersToCheck(db: PaymentDb, worker: string, limit: number): Promise<ClaimedOpenTransfer[]> {
  const rows = await asServer(db, (tx) =>
    tx<{
      transfer_reference: string;
      status: OpenTransferStatus;
      transfer_code: string | null;
      amount_kobo: string;
      recipient_code: string | null;
      bank_account_id: string | null;
      check_count: number;
      not_found_count: number;
      initiate_requested_at: Date | null;
      refused_at: Date | null;
      refusal_code: string | null;
      escalated_at: Date | null;
      created_at: Date;
      claim_token: string;
      withdrawal_reference: string | null;
    }[]>`select * from app.claim_withdrawal_transfers_to_check(${worker}, ${limit}::integer)`,
  );
  return rows.map((r) => ({
    reference: r.transfer_reference,
    status: r.status,
    transferCode: r.transfer_code,
    amountKobo: BigInt(r.amount_kobo),
    recipientCode: r.recipient_code,
    bankAccountId: r.bank_account_id,
    checkCount: r.check_count,
    notFoundCount: r.not_found_count,
    initiateRequestedAt: iso(r.initiate_requested_at),
    refusedAt: iso(r.refused_at),
    refusalCode: r.refusal_code,
    escalatedAt: iso(r.escalated_at),
    createdAt: r.created_at.toISOString(),
    claimToken: r.claim_token,
    withdrawalReference: r.withdrawal_reference,
  }));
}

/** Committed immediately before POST /transfer. False: the claim is gone or the row cannot be sent. */
export async function markWithdrawalTransferInitiating(db: PaymentDb, reference: string, claimToken: string): Promise<boolean> {
  const [row] = await asServer(db, (tx) =>
    tx<{ ok: boolean }[]>`select app.mark_withdrawal_transfer_initiating(${reference}, ${claimToken}) as ok`,
  );
  return row?.ok === true;
}

export type TransferCheckSource = "dispatch" | "check" | "webhook" | "approval" | "reconciliation" | "operator";
export type TransferProviderResult = "ok" | "not_found" | "unavailable" | "refused" | "not_called";

export interface RecordTransferCheckInput {
  reference: string;
  /** Null for a writer without a claim (webhook): never touches another worker's claim. */
  claimToken: string | null;
  source: TransferCheckSource;
  worker: string;
  providerResult: TransferProviderResult;
  providerStatus?: string | null;
  providerCode?: string | null;
  /** Only a non-final state. Final outcomes go through settleWithdrawalTransfer first. */
  newStatus?: OpenTransferStatus | null;
  recipientCode?: string | null;
  transferCode?: string | null;
  providerTransferId?: string | null;
  /** What Kolekto did, e.g. "initiated", "not_found", "paid". */
  outcome: string;
  note?: string | null;
  /** False: keep the claim because the caller acts next. */
  releaseClaim?: boolean;
}

export interface RecordTransferCheckResult {
  status: string;
  checkCount: number;
  notFoundCount: number;
  nextCheckAt: string | null;
  escalated: boolean;
  /** The SAME reference may be sent again (repeated NOT FOUND, never approved, not escalated). */
  resendAllowed: boolean;
  /** P8-1: the hold may be released without a provider-confirmed failure. */
  releaseEligible: boolean;
  /** The caller's claim was taken over; nothing but the log changed. */
  stale: boolean;
}

export async function recordWithdrawalTransferCheck(db: PaymentDb, input: RecordTransferCheckInput): Promise<RecordTransferCheckResult> {
  const [row] = await asServer(db, (tx) =>
    tx<{
      status: string;
      check_count: number;
      not_found_count: number;
      next_check_at: Date | null;
      escalated: boolean;
      resend_allowed: boolean;
      release_eligible: boolean;
      stale: boolean;
    }[]>`
      select * from app.record_withdrawal_transfer_check(
        ${input.reference}, ${input.claimToken}::uuid, ${input.source}, ${input.worker}, ${input.providerResult},
        ${input.providerStatus ?? null}, ${input.providerCode ?? null}, ${input.newStatus ?? null},
        ${input.recipientCode ?? null}, ${input.transferCode ?? null}, ${input.providerTransferId ?? null},
        ${input.outcome}, ${input.note ?? null}, ${input.releaseClaim ?? true}
      )
    `,
  );
  if (!row) throw new Error("record_withdrawal_transfer_check returned no row");
  return {
    status: row.status,
    checkCount: row.check_count,
    notFoundCount: row.not_found_count,
    nextCheckAt: iso(row.next_check_at),
    escalated: row.escalated,
    resendAllowed: row.resend_allowed,
    releaseEligible: row.release_eligible,
    stale: row.stale,
  };
}

export async function releaseWithdrawalTransferClaim(db: PaymentDb, reference: string, claimToken: string): Promise<boolean> {
  const [row] = await asServer(db, (tx) =>
    tx<{ ok: boolean }[]>`select app.release_withdrawal_transfer_claim(${reference}, ${claimToken}) as ok`,
  );
  return row?.ok === true;
}

/**
 * P8-1: releases the hold of a transfer Paystack provably never accepted.
 * The database decides eligibility; "not_eligible" and "stale_claim" change nothing.
 */
export async function releaseWithdrawalTransferNeverSent(
  db: PaymentDb,
  input: { reference: string; claimToken: string; reason: string | null },
): Promise<string> {
  const [row] = await asServer(db, (tx) =>
    tx<{ outcome: string }[]>`
      select app.release_withdrawal_transfer_never_sent(${input.reference}, ${input.claimToken}, ${input.reason}) as outcome
    `,
  );
  return row?.outcome ?? "not_eligible";
}

export interface TransferNeedingAttention {
  transferReference: string;
  withdrawalReference: string;
  status: OpenTransferStatus;
  amountKobo: bigint;
  checkCount: number;
  notFoundCount: number;
  escalatedAt: string | null;
  escalationReason: string | null;
  initiateRequestedAt: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
}

export async function listWithdrawalTransfersNeedingAttention(db: PaymentDb): Promise<TransferNeedingAttention[]> {
  const rows = await asServer(db, (tx) =>
    tx<{
      transfer_reference: string;
      withdrawal_reference: string;
      status: OpenTransferStatus;
      amount_kobo: string;
      check_count: number;
      not_found_count: number;
      escalated_at: Date | null;
      escalation_reason: string | null;
      initiate_requested_at: Date | null;
      last_checked_at: Date | null;
      next_check_at: Date | null;
    }[]>`select * from app.withdrawal_transfers_needing_attention()`,
  );
  return rows.map((r) => ({
    transferReference: r.transfer_reference,
    withdrawalReference: r.withdrawal_reference,
    status: r.status,
    amountKobo: BigInt(r.amount_kobo),
    checkCount: r.check_count,
    notFoundCount: r.not_found_count,
    escalatedAt: iso(r.escalated_at),
    escalationReason: r.escalation_reason,
    initiateRequestedAt: iso(r.initiate_requested_at),
    lastCheckedAt: iso(r.last_checked_at),
    nextCheckAt: iso(r.next_check_at),
  }));
}

// ── Paystack server approval ─────────────────────────────────────────────────

export type TransferApprovalDecision = "approve" | "reject";

export async function decideTransferApproval(
  db: PaymentDb,
  input: {
    reference: string | null;
    amountKobo: bigint | null;
    recipientCode: string | null;
    signature: "valid" | "absent";
    currency: string | null;
    transferCode: string | null;
    /** The parser's refusal (`payload_…`); when set the request is rejected with this reason. */
    payloadRejection: string | null;
  },
): Promise<{ decision: TransferApprovalDecision; reasonCode: string }> {
  const [row] = await asServer(db, (tx) =>
    tx<{ decision: TransferApprovalDecision; reason_code: string }[]>`
      select * from app.decide_transfer_approval(
        ${input.reference}, ${input.amountKobo === null ? null : input.amountKobo.toString()}::bigint,
        ${input.recipientCode}, ${input.signature}, ${input.currency}, ${input.transferCode}, ${input.payloadRejection}
      )
    `,
  );
  if (!row) throw new Error("decide_transfer_approval returned no row");
  return { decision: row.decision, reasonCode: row.reason_code };
}

// ── Transfer reconciliation report (P8-4) ────────────────────────────────────

export interface KolektoTransferRow {
  transferId: string;
  reference: string;
  transferCode: string | null;
  amountKobo: bigint;
  recipientCode: string | null;
  status: string;
  withdrawalStatus: string;
  withdrawalAmountKobo: bigint;
  payoutJournal: boolean;
  initiateRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  escalated: boolean;
  approvalRequests: number;
}

export async function listKolektoTransfersForReconciliation(db: PaymentDb, from: Date, to: Date): Promise<KolektoTransferRow[]> {
  const rows = await asServer(db, (tx) =>
    tx<{
      transfer_id: string;
      reference: string;
      transfer_code: string | null;
      amount_kobo: string;
      recipient_code: string | null;
      status: string;
      withdrawal_status: string;
      withdrawal_amount_kobo: string;
      payout_journal: boolean;
      initiate_requested_at: Date | null;
      created_at: Date;
      updated_at: Date;
      escalated: boolean;
      approval_requests: number;
    }[]>`select * from app.transfer_reconciliation_kolekto_rows(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz)`,
  );
  return rows.map((r) => ({
    transferId: r.transfer_id,
    reference: r.reference,
    transferCode: r.transfer_code,
    amountKobo: BigInt(r.amount_kobo),
    recipientCode: r.recipient_code,
    status: r.status,
    withdrawalStatus: r.withdrawal_status,
    withdrawalAmountKobo: BigInt(r.withdrawal_amount_kobo),
    payoutJournal: r.payout_journal,
    initiateRequestedAt: iso(r.initiate_requested_at),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    escalated: r.escalated,
    approvalRequests: r.approval_requests,
  }));
}

export type TransferDiscrepancyKind =
  | "missing_at_provider"
  | "missing_in_kolekto"
  | "foreign_reference"
  | "amount_mismatch"
  | "reference_mismatch"
  | "recipient_mismatch"
  | "status_mismatch"
  | "stale_open"
  | "duplicate_provider_record"
  | "duplicate_approval_requests"
  | "success_not_in_ledger"
  /** Sent less than the run's grace period ago and not yet in the provider list (20261122100000). Info only. */
  | "provider_verification_pending";

export interface TransferDiscrepancy {
  kind: TransferDiscrepancyKind;
  severity: "critical" | "warning" | "info";
  reference: string | null;
  kolektoDetail: string | null;
  providerDetail: string | null;
}

/** Stores one run and its discrepancies. Changes no balance and no transfer. */
export async function recordTransferReconciliationRun(
  db: PaymentDb,
  run: {
    startedAt: Date;
    windowFrom: Date;
    windowTo: Date;
    providerMode: "test" | "live" | "fake";
    providerCount: number;
    kolektoCount: number;
    /** The provider-verification grace period this run used (20261122100000). Omitted → stored as null. */
    providerGraceSeconds?: number;
  },
  discrepancies: readonly TransferDiscrepancy[],
): Promise<string> {
  const runJson = {
    started_at: run.startedAt.toISOString(),
    window_from: run.windowFrom.toISOString(),
    window_to: run.windowTo.toISOString(),
    provider_mode: run.providerMode,
    provider_count: run.providerCount,
    kolekto_count: run.kolektoCount,
    ...(run.providerGraceSeconds === undefined ? {} : { provider_grace_seconds: run.providerGraceSeconds }),
  };
  const discJson = discrepancies.map((d) => ({
    kind: d.kind,
    severity: d.severity,
    reference: d.reference,
    kolekto_detail: d.kolektoDetail,
    provider_detail: d.providerDetail,
  }));
  const [row] = await asServer(db, (tx) =>
    tx<{ id: string }[]>`
      select app.record_transfer_reconciliation_run(${JSON.stringify(runJson)}::text::jsonb, ${JSON.stringify(discJson)}::text::jsonb) as id
    `,
  );
  if (!row) throw new Error("record_transfer_reconciliation_run returned no row");
  return row.id;
}
