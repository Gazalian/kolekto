/**
 * withdrawal-transfers.ts — the worker side of automatic payouts
 * (owner decision 2026-11-17 §18; built 2026-11-18).
 *
 * The orchestration lives in @kolekto/payments (transfers.ts) and every money
 * rule in the database (20261118100100). This file only decides what may run
 * on this worker and summarises what happened.
 *
 * Two parts, gated separately and never fatal:
 *
 *   · check  — finish transfers already in flight (verify by reference,
 *     settle what Paystack confirms). Runs wherever the transfer functions
 *     are executable by this role and a Paystack key is configured, EVEN when
 *     the flag is off: switching payouts off must never strand a withdrawal
 *     whose money may already have left. With the flag off it never sends.
 *   · dispatch — claim approved withdrawals and send new transfers. Only when
 *     `paystackTransfersEnabled` (PAYSTACK_TRANSFERS_ENABLED=true, plus
 *     PAYSTACK_LIVE_TRANSFERS_APPROVED=true for a live key).
 *
 * The least-privilege worker role is not granted these functions (they post
 * ledger journals); the operator runs payouts on the server connection, as
 * with the settlement release. There is no fake provider here: a fake in this
 * process has never seen the recipients the web app created, so the stage is
 * simply off without a Paystack key.
 *
 * Environment variable names are read inside @kolekto/adapters only
 * (source-tree invariant 4); this file hands it `process.env`.
 *
 * Logs carry outcome counts only — no reference, name, account or amount.
 */

import { paystackTransfersEnabled, type TransferProvider, tryLoadPaystackTransferProviderFromEnv } from "@kolekto/adapters";
import { listWithdrawalTransfersNeedingAttention, type PaymentDb, type TransferNeedingAttention } from "@kolekto/db";
import {
  checkWithdrawalTransfers,
  dispatchWithdrawalTransfers,
  nextReconciliationDelayMs,
  runTransferReconciliation,
  type TransferContext,
  type TransferReconciliationResult,
  type TransferStepReport,
} from "@kolekto/payments";
import type postgres from "postgres";

export const TRANSFER_DISPATCH_INTERVAL_MS = 60_000;
/**
 * How often the worker looks for DUE transfers. When each one is due comes
 * from the database (next_check_at, the backoff policy row, PA-09); this is
 * only the polling granularity.
 */
export const TRANSFER_CHECK_INTERVAL_MS = 30_000;
export const TRANSFER_DISPATCH_BATCH = 10;
export const TRANSFER_CHECK_BATCH = 50;
/** Escalated transfers are reported (error log = alert) this often while any remain. */
export const TRANSFER_ATTENTION_INTERVAL_MS = 15 * 60_000;
/** Read-only reconciliation against Paystack's transfer list (P8-4). */
export const TRANSFER_RECONCILIATION_INTERVAL_MS = 6 * 60 * 60_000;
export const TRANSFER_RECONCILIATION_WINDOW_MS = 7 * 24 * 60 * 60_000;
/**
 * Provider-verification grace period (2026-11-22): a transfer sent less than
 * this long ago and not yet in Paystack's list is "pending verification", not
 * "missing". Change it here; each run records the value it used
 * (transfer_reconciliation_runs.provider_grace_seconds).
 */
export const TRANSFER_RECONCILIATION_PROVIDER_GRACE_MS = 5 * 60_000;

/** What the stage needs from the database, by exact signature. */
export const WITHDRAWAL_TRANSFER_FUNCTIONS: readonly string[] = Object.freeze([
  "app.claim_withdrawal_transfers(integer, text)",
  "app.claim_withdrawal_transfers_to_check(text, integer)",
  "app.mark_withdrawal_transfer_initiating(text, uuid)",
  "app.record_withdrawal_transfer_check(text, uuid, text, text, text, text, text, text, text, text, text, text, text, boolean)",
  "app.release_withdrawal_transfer_claim(text, uuid)",
  "app.release_withdrawal_transfer_never_sent(text, uuid, text)",
  "app.settle_withdrawal_transfer(text, text, bigint, text, bigint, text, timestamptz)",
  "app.set_bank_account_recipient(uuid, text)",
  "app.withdrawal_transfers_needing_attention()",
]);

export type WithdrawalTransferDecision =
  | { enabled: true; dispatch: boolean; testMode: boolean }
  | { enabled: false; reason: string };

/** Pure: what may run, given the probe and the environment. */
export function decideWithdrawalTransfers(input: {
  functionsOk: boolean;
  provider: TransferProvider | null;
  transfersEnabled: boolean;
}): WithdrawalTransferDecision {
  if (!input.functionsOk) return { enabled: false, reason: "transfer_functions_missing_or_not_executable" };
  if (input.provider === null) return { enabled: false, reason: "no_paystack_key" };
  return { enabled: true, dispatch: input.transfersEnabled, testMode: input.provider.testMode };
}

export async function withdrawalTransfersAllowed(
  sql: postgres.Sql<Record<string, never>>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ decision: WithdrawalTransferDecision; context: TransferContext | null }> {
  const [row] = await sql<{ ok: boolean | null }[]>`
    select bool_and(to_regprocedure(f) is not null and has_function_privilege(current_user, to_regprocedure(f), 'EXECUTE')) as ok
    from unnest(${WITHDRAWAL_TRANSFER_FUNCTIONS as string[]}::text[]) as f
  `;
  const provider = tryLoadPaystackTransferProviderFromEnv(env);
  const decision = decideWithdrawalTransfers({
    functionsOk: row?.ok === true,
    provider,
    transfersEnabled: paystackTransfersEnabled(env),
  });
  if (!decision.enabled || provider === null) return { decision, context: null };
  const db: PaymentDb = (fn) => sql.begin(fn) as ReturnType<typeof fn>;
  return { decision, context: { db, provider, worker: `worker:${process.pid}` } };
}

/** One log line per run that did something; null when nothing happened. */
export function transferLogLine(stage: "dispatch" | "check", report: TransferStepReport): Record<string, unknown> | null {
  if (report.outcomes.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const { outcome } of report.outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return { msg: "withdrawal_transfers", stage, examined: report.outcomes.length, ...counts };
}

/** Alert line for transfers that need a person (escalated by the policy). Counts only. */
export function transferAttentionLogLine(items: readonly TransferNeedingAttention[]): Record<string, unknown> | null {
  if (items.length === 0) return null;
  const byStatus: Record<string, number> = {};
  for (const t of items) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  return { msg: "withdrawal_transfers_need_attention", severity: "critical", count: items.length, ...byStatus, action: "manual reconciliation: funds stay reserved" };
}

/** Summary line for a reconciliation run. Counts by kind and severity only. */
export function reconciliationLogLine(result: TransferReconciliationResult): Record<string, unknown> {
  const bySeverity: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const d of result.discrepancies) {
    bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1;
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  }
  return {
    msg: "withdrawal_transfer_reconciliation",
    outcome: result.outcome,
    provider_count: result.providerCount,
    kolekto_count: result.kolektoCount,
    provider_complete: result.providerComplete,
    provider_verifications: result.providerVerifications,
    pending_verification: result.pendingVerification,
    severity: (bySeverity["critical"] ?? 0) > 0 ? "critical" : (bySeverity["warning"] ?? 0) > 0 ? "warning" : "info",
    by_severity: bySeverity,
    by_kind: byKind,
  };
}

export { checkWithdrawalTransfers, dispatchWithdrawalTransfers, listWithdrawalTransfersNeedingAttention, nextReconciliationDelayMs, runTransferReconciliation };
