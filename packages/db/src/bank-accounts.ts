/**
 * bank-accounts.ts — saved payout bank accounts and Paystack transfer records
 * (20261118100100, owner decisions 2026-11-18).
 *
 * Two kinds of caller, kept apart on purpose:
 *
 *   · signed-in user (`withCallerContext`): list own accounts (masked), set the
 *     default, remove one. The database checks ownership with auth.uid().
 *   · server / worker (`PaymentDb`, the operator connection): register an
 *     account the server resolved with Paystack, record its recipient, and
 *     every transfer step. These functions refuse every client role.
 *
 * Kobo arrives as decimal strings and is handed on as `bigint`. Nothing here
 * logs. Full account numbers are returned only by `claimWithdrawalTransfers`
 * (operator), because recipient creation needs them.
 */

import type { TransactionSql } from "postgres";

import { type CallerContext, runWrite, withCallerContext } from "./client.ts";
import type { PaymentDb } from "./payments.ts";

function asUser<T>(caller: CallerContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => withCallerContext(caller, fn));
}
function asServer<T>(db: PaymentDb, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => db(fn));
}
const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

// ── Signed-in user ───────────────────────────────────────────────────────────

export type BankAccountStatus = "verified" | "needs_review" | "rejected";

export interface SavedBankAccount {
  id: string;
  bankCode: string;
  bankName: string;
  accountLast4: string;
  /** The name the bank reported (Paystack resolution). */
  accountName: string;
  status: BankAccountStatus;
  nameMatched: boolean;
  isDefault: boolean;
  /** D-08: a withdrawal can go to this account from this moment. */
  usableFrom: string;
  verifiedAt: string | null;
  /** Only for a rejected account: why. */
  reviewNote: string | null;
  createdAt: string;
}

interface SavedBankAccountRow {
  id: string;
  bank_code: string;
  bank_name: string;
  account_last4: string;
  account_name: string;
  status: BankAccountStatus;
  name_matched: boolean;
  is_default: boolean;
  usable_from: Date;
  verified_at: Date | null;
  review_note: string | null;
  created_at: Date;
}

export async function listMyBankAccounts(caller: CallerContext): Promise<SavedBankAccount[]> {
  const rows = await asUser(caller, (tx) => tx<SavedBankAccountRow[]>`select * from app.my_bank_accounts()`);
  return rows.map((r) => ({
    id: r.id,
    bankCode: r.bank_code,
    bankName: r.bank_name,
    accountLast4: r.account_last4,
    accountName: r.account_name,
    status: r.status,
    nameMatched: r.name_matched,
    isDefault: r.is_default,
    usableFrom: r.usable_from.toISOString(),
    verifiedAt: iso(r.verified_at),
    reviewNote: r.review_note,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function setDefaultBankAccount(caller: CallerContext, bankAccountId: string): Promise<void> {
  await asUser(caller, (tx) => tx`select app.set_default_bank_account(${bankAccountId})`);
}

export async function disableBankAccount(caller: CallerContext, bankAccountId: string): Promise<void> {
  await asUser(caller, (tx) => tx`select app.disable_bank_account(${bankAccountId})`);
}

// ── Server: registration ─────────────────────────────────────────────────────

export interface RegisterBankAccountInput {
  /** From the signed-in session on the server. Never from the browser. */
  userId: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  /** From Paystack account resolution. */
  resolvedName: string;
  /** The profile name the comparison used. */
  profileName: string;
  nameMatched: boolean;
}

export interface RegisterBankAccountResult {
  bankAccountId: string;
  status: BankAccountStatus;
  outcome: "verified" | "needs_review" | "reused";
  usableFrom: string;
}

export async function registerBankAccount(db: PaymentDb, input: RegisterBankAccountInput): Promise<RegisterBankAccountResult> {
  const [row] = await asServer(db, (tx) =>
    tx<{ bank_account_id: string; status: BankAccountStatus; outcome: RegisterBankAccountResult["outcome"]; usable_from: Date }[]>`
      select * from app.register_bank_account(
        ${input.userId}, ${input.bankCode}, ${input.bankName}, ${input.accountNumber},
        ${input.resolvedName}, ${input.profileName}, ${input.nameMatched}
      )
    `,
  );
  if (!row) throw new Error("register_bank_account returned no row");
  return { bankAccountId: row.bank_account_id, status: row.status, outcome: row.outcome, usableFrom: row.usable_from.toISOString() };
}

export async function setBankAccountRecipient(db: PaymentDb, bankAccountId: string, recipientCode: string): Promise<void> {
  await asServer(db, (tx) => tx`select app.set_bank_account_recipient(${bankAccountId}, ${recipientCode})`);
}

/** The signed-in user's profile name, read on the server for the name comparison. */
export async function getProfileName(db: PaymentDb, userId: string): Promise<string | null> {
  const [row] = await asServer(db, (tx) => tx<{ full_name: string }[]>`
    select u.full_name from public.users u where u.id = ${userId} and u.status = 'active'
  `);
  return row?.full_name ?? null;
}

// ── Server: transfers ────────────────────────────────────────────────────────

export interface ClaimedWithdrawalTransfer {
  withdrawalId: string;
  withdrawalReference: string;
  transferReference: string;
  amountKobo: bigint;
  bankAccountId: string;
  recipientCode: string | null;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  /** The dispatching worker holds this lease on the new transfer row (20261119120000). */
  claimToken: string;
}

/**
 * Claims approved withdrawals for transfer. Since 20261119120000 only those
 * with BOTH the member's verified code and a recorded independent approval, to the
 * requester's own still-verified account; the new transfer row is leased.
 */
export async function claimWithdrawalTransfers(db: PaymentDb, limit: number, worker = "dispatch"): Promise<ClaimedWithdrawalTransfer[]> {
  const rows = await asServer(db, (tx) =>
    tx<{
      withdrawal_id: string;
      withdrawal_reference: string;
      transfer_reference: string;
      amount_kobo: string;
      bank_account_id: string;
      recipient_code: string | null;
      bank_code: string;
      account_number: string;
      account_name: string;
      claim_token: string;
    }[]>`select * from app.claim_withdrawal_transfers(${limit}::integer, ${worker})`,
  );
  return rows.map((r) => ({
    withdrawalId: r.withdrawal_id,
    withdrawalReference: r.withdrawal_reference,
    transferReference: r.transfer_reference,
    amountKobo: BigInt(r.amount_kobo),
    bankAccountId: r.bank_account_id,
    recipientCode: r.recipient_code,
    bankCode: r.bank_code,
    accountNumber: r.account_number,
    accountName: r.account_name,
    claimToken: r.claim_token,
  }));
}

export type OpenTransferStatus = "initiating" | "pending" | "otp" | "unknown";

export async function recordWithdrawalTransferState(
  db: PaymentDb,
  input: {
    reference: string;
    status: OpenTransferStatus;
    recipientCode?: string | null;
    transferCode?: string | null;
    providerTransferId?: string | null;
    note?: string | null;
  },
): Promise<string> {
  const [row] = await asServer(db, (tx) => tx<{ status: string }[]>`
    select app.record_withdrawal_transfer_state(
      ${input.reference}, ${input.status}, ${input.recipientCode ?? null}, ${input.transferCode ?? null},
      ${input.providerTransferId ?? null}, ${input.note ?? null}
    ) as status
  `);
  return row?.status ?? input.status;
}

export type SettleTransferOutcome =
  | "paid"
  | "already_paid"
  | "failed"
  | "already_failed"
  | "reversed"
  | "already_reversed"
  | "amount_mismatch"
  | "conflict";

export async function settleWithdrawalTransfer(
  db: PaymentDb,
  input: {
    reference: string;
    outcome: "success" | "failed" | "reversed";
    amountKobo: bigint | null;
    transferCode: string | null;
    feeKobo: bigint | null;
    reason: string | null;
    at: Date | null;
  },
): Promise<SettleTransferOutcome> {
  const [row] = await asServer(db, (tx) => tx<{ outcome: SettleTransferOutcome }[]>`
    select app.settle_withdrawal_transfer(
      ${input.reference}, ${input.outcome},
      ${input.amountKobo === null ? null : input.amountKobo.toString()}::bigint,
      ${input.transferCode},
      ${input.feeKobo === null ? null : input.feeKobo.toString()}::bigint,
      ${input.reason}, ${input.at === null ? null : input.at.toISOString()}::timestamptz
    ) as outcome
  `);
  if (!row) throw new Error("settle_withdrawal_transfer returned no row");
  return row.outcome;
}

export interface OpenWithdrawalTransfer {
  reference: string;
  status: OpenTransferStatus;
  transferCode: string | null;
  amountKobo: bigint;
  recipientCode: string | null;
  bankAccountId: string | null;
  attempts: number;
  createdAt: string;
}

export async function listWithdrawalTransfersToCheck(
  db: PaymentDb,
  olderThanSeconds: number,
  limit: number,
): Promise<OpenWithdrawalTransfer[]> {
  const rows = await asServer(db, (tx) =>
    tx<{
      transfer_reference: string;
      status: OpenTransferStatus;
      transfer_code: string | null;
      amount_kobo: string;
      recipient_code: string | null;
      bank_account_id: string | null;
      attempts: number;
      created_at: Date;
    }[]>`
      select * from app.withdrawal_transfers_to_check(make_interval(secs => ${olderThanSeconds}), ${limit}::integer)
    `,
  );
  return rows.map((r) => ({
    reference: r.transfer_reference,
    status: r.status,
    transferCode: r.transfer_code,
    amountKobo: BigInt(r.amount_kobo),
    recipientCode: r.recipient_code,
    bankAccountId: r.bank_account_id,
    attempts: r.attempts,
    createdAt: r.created_at.toISOString(),
  }));
}
