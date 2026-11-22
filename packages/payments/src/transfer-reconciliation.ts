/**
 * transfer-reconciliation.ts — read-only comparison of Kolekto's transfer
 * records with Paystack's transfer list (P8-4).
 *
 * It never initiates, retries, settles or releases anything and changes no
 * balance. It reads both sides, lists every discrepancy with a severity, and
 * stores the run (app.record_transfer_reconciliation_run) so operations can
 * work through it and mark each item acknowledged / resolved.
 *
 * `compareTransfers` is pure (tests drive it directly).
 *
 * Provider-verification grace period (20261122100000, 2026-11-22). Paystack's
 * transfer LIST can lag a transfer that was just created: a run seconds after
 * dispatch once reported a paid transfer as `missing_at_provider`. So a
 * transfer absent from the list is:
 *   · sent less than `providerGraceMs` ago (default 5 min) →
 *     `provider_verification_pending` (info). Never missing, failed or paid;
 *     the transfer's own state is untouched (this report changes nothing).
 *   · sent longer ago → asked about by reference (read-only verify) first:
 *     found → compared like a listed transfer; not found → `missing_at_provider`;
 *     verify unavailable or not attempted → `missing_at_provider`, as before
 *     this change, with the reason in the detail.
 * A webhook that settles the transfer in the meantime goes through the normal
 * verified settlement path; the next run then sees Paystack's record.
 */

import type { TransferProvider, TransferState } from "@kolekto/adapters";
import {
  type KolektoTransferRow,
  listKolektoTransfersForReconciliation,
  type PaymentDb,
  recordTransferReconciliationRun,
  type TransferDiscrepancy,
} from "@kolekto/db";

const OPEN = new Set(["initiating", "pending", "otp", "unknown"]);
const KOLEKTO_REFERENCE = /^ktr_[0-9a-f]{24}$/;

/** How long after dispatch a transfer may be absent from Paystack's list before it can be "missing". */
export const DEFAULT_PROVIDER_VERIFICATION_GRACE_MS = 5 * 60 * 1000;
/** At most this many verify-by-reference calls per run; the rest are reported as not re-verified. */
export const DEFAULT_MAX_PROVIDER_VERIFICATIONS = 25;

/** What a read-only verify by reference said about a transfer absent from the list. */
export type ProviderVerification =
  | { readonly outcome: "found"; readonly state: TransferState }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable"; readonly reason: string };

export interface CompareOptions {
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly now: Date;
  /** An open Kolekto transfer older than this is reported as stale. */
  readonly staleAfterMs: number;
  /** False when the provider list could not be read completely: "missing" findings are suppressed. */
  readonly providerComplete: boolean;
  /** Absent from the list and sent less than this long ago → pending verification. Default 5 minutes. */
  readonly providerGraceMs?: number;
  /** Verify-by-reference answers for transfers absent from the list past the grace period. */
  readonly verifications?: ReadonlyMap<string, ProviderVerification>;
}

/** The absent-from-list rule shared by the comparison and the run: sent in the window, list complete. */
function absentAndSent(k: KolektoTransferRow, listed: ReadonlySet<string>, options: CompareOptions): boolean {
  if (listed.has(k.reference) || !options.providerComplete || k.initiateRequestedAt === null) return false;
  const sentAt = Date.parse(k.initiateRequestedAt);
  return sentAt >= options.windowFrom.getTime() && sentAt <= options.windowTo.getTime();
}

function withinGrace(k: KolektoTransferRow, options: CompareOptions): boolean {
  const grace = options.providerGraceMs ?? DEFAULT_PROVIDER_VERIFICATION_GRACE_MS;
  return options.now.getTime() - Date.parse(k.initiateRequestedAt!) < grace;
}

/**
 * Pure: the references a run must verify by reference before it may call them
 * missing — absent from a complete list, sent in the window, past the grace period.
 */
export function referencesNeedingProviderVerification(
  kolekto: readonly KolektoTransferRow[],
  provider: readonly TransferState[],
  options: CompareOptions,
): string[] {
  const listed = new Set(provider.map((p) => p.reference));
  return kolekto.filter((k) => absentAndSent(k, listed, options) && !withinGrace(k, options)).map((k) => k.reference);
}

function kolektoDetail(k: KolektoTransferRow): string {
  return `status=${k.status} withdrawal=${k.withdrawalStatus} amount=${k.amountKobo} code=${k.transferCode ?? "-"} recipient=${k.recipientCode ?? "-"}`;
}
function providerDetail(p: TransferState): string {
  return `status=${p.providerStatusRaw} amount=${p.amount} code=${p.transferCode ?? "-"} recipient=${p.recipientCode ?? "-"}`;
}

export function compareTransfers(
  kolekto: readonly KolektoTransferRow[],
  provider: readonly TransferState[],
  options: CompareOptions,
): TransferDiscrepancy[] {
  const out: TransferDiscrepancy[] = [];
  const byRef = new Map<string, TransferState[]>();
  for (const p of provider) byRef.set(p.reference, [...(byRef.get(p.reference) ?? []), p]);
  const kolektoRefs = new Set(kolekto.map((k) => k.reference));

  for (const [reference, items] of byRef) {
    if (items.length > 1) {
      out.push({ kind: "duplicate_provider_record", severity: "critical", reference, kolektoDetail: null, providerDetail: `${items.length} provider transfers share this reference` });
    }
    if (!KOLEKTO_REFERENCE.test(reference)) {
      out.push({ kind: "foreign_reference", severity: "info", reference, kolektoDetail: null, providerDetail: providerDetail(items[0]!) });
    } else if (!kolektoRefs.has(reference)) {
      out.push({ kind: "missing_in_kolekto", severity: "critical", reference, kolektoDetail: null, providerDetail: providerDetail(items[0]!) });
    }
  }

  const listed = new Set(byRef.keys());
  for (const k of kolekto) {
    const open = OPEN.has(k.status);
    if (k.status === "success" && !k.payoutJournal) {
      out.push({ kind: "success_not_in_ledger", severity: "critical", reference: k.reference, kolektoDetail: kolektoDetail(k), providerDetail: null });
    }
    if (k.amountKobo !== k.withdrawalAmountKobo) {
      out.push({ kind: "amount_mismatch", severity: "critical", reference: k.reference, kolektoDetail: `transfer ${k.amountKobo} ≠ withdrawal ${k.withdrawalAmountKobo}`, providerDetail: null });
    }
    if (k.approvalRequests > 1) {
      out.push({ kind: "duplicate_approval_requests", severity: "info", reference: k.reference, kolektoDetail: `${k.approvalRequests} approval requests`, providerDetail: null });
    }
    if (open && options.now.getTime() - Date.parse(k.createdAt) > options.staleAfterMs) {
      out.push({ kind: "stale_open", severity: "warning", reference: k.reference, kolektoDetail: `${kolektoDetail(k)}${k.escalated ? " escalated" : ""}`, providerDetail: null });
    }

    let p = byRef.get(k.reference)?.[0];
    if (p === undefined) {
      if (!absentAndSent(k, listed, options)) continue;
      if (withinGrace(k, options)) {
        const graceS = Math.round((options.providerGraceMs ?? DEFAULT_PROVIDER_VERIFICATION_GRACE_MS) / 1000);
        const ageS = Math.max(0, Math.round((options.now.getTime() - Date.parse(k.initiateRequestedAt!)) / 1000));
        out.push({
          kind: "provider_verification_pending",
          severity: "info",
          reference: k.reference,
          kolektoDetail: `${kolektoDetail(k)} sent ${ageS}s ago`,
          providerDetail: `not yet in the provider list; within the ${graceS}s grace period, re-checked by a later run`,
        });
        continue;
      }
      const v = options.verifications?.get(k.reference);
      if (v?.outcome === "found") {
        p = v.state; // Paystack has it; the list lagged. Compare it like a listed transfer.
      } else {
        out.push({
          kind: "missing_at_provider",
          severity: k.status === "success" ? "critical" : "warning",
          reference: k.reference,
          kolektoDetail: kolektoDetail(k),
          providerDetail:
            v === undefined
              ? "no transfer with this reference in the provider list"
              : v.outcome === "not_found"
                ? "no transfer with this reference in the provider list; verify by reference: not found"
                : `no transfer with this reference in the provider list; verify by reference unavailable (${v.reason})`,
        });
        continue;
      }
    }
    if (BigInt(p.amount) !== k.amountKobo) {
      out.push({ kind: "amount_mismatch", severity: "critical", reference: k.reference, kolektoDetail: kolektoDetail(k), providerDetail: providerDetail(p) });
    }
    if (p.transferCode !== null && k.transferCode !== null && p.transferCode !== k.transferCode) {
      out.push({ kind: "reference_mismatch", severity: "critical", reference: k.reference, kolektoDetail: kolektoDetail(k), providerDetail: providerDetail(p) });
    }
    if (p.recipientCode !== null && k.recipientCode !== null && p.recipientCode !== k.recipientCode) {
      out.push({ kind: "recipient_mismatch", severity: "critical", reference: k.reference, kolektoDetail: kolektoDetail(k), providerDetail: providerDetail(p) });
    }
    const severity = statusMismatchSeverity(k.status, p.status);
    if (severity !== null) {
      out.push({ kind: "status_mismatch", severity, reference: k.reference, kolektoDetail: kolektoDetail(k), providerDetail: providerDetail(p) });
    }
  }
  return out;
}

/** Null when the two statuses agree (or Kolekto is simply still waiting on an in-flight provider state). */
export function statusMismatchSeverity(kolekto: string, provider: TransferState["status"]): TransferDiscrepancy["severity"] | null {
  const providerOpen = provider === "pending" || provider === "otp" || provider === "unrecognised";
  if (OPEN.has(kolekto)) {
    if (providerOpen) return kolekto === "pending" && provider === "otp" ? "info" : null;
    return "warning"; // final at Paystack, not yet settled in Kolekto
  }
  if (kolekto === provider) return null;
  if (kolekto === "success" && provider === "reversed") return "warning"; // reversal not yet applied
  return "critical"; // Kolekto final and Paystack disagrees (or still open)
}

export interface TransferReconciliationResult {
  readonly outcome: "recorded" | "provider_unavailable";
  readonly runId: string | null;
  readonly providerCount: number;
  readonly kolektoCount: number;
  readonly discrepancies: readonly TransferDiscrepancy[];
  readonly providerComplete: boolean;
  /** Read-only verify-by-reference calls made for transfers absent from the list past the grace period. */
  readonly providerVerifications: number;
  /** Transfers recorded as provider_verification_pending (absent, still within the grace period). */
  readonly pendingVerification: number;
}

export async function runTransferReconciliation(
  ctx: { db: PaymentDb; provider: TransferProvider },
  options: {
    windowFrom: Date;
    windowTo: Date;
    now: Date;
    staleAfterMs?: number;
    maxPages?: number;
    perPage?: number;
    /** Default DEFAULT_PROVIDER_VERIFICATION_GRACE_MS (5 minutes). */
    providerGraceMs?: number;
    /** Default DEFAULT_MAX_PROVIDER_VERIFICATIONS. */
    maxVerifications?: number;
  },
): Promise<TransferReconciliationResult> {
  const providerGraceMs = options.providerGraceMs ?? DEFAULT_PROVIDER_VERIFICATION_GRACE_MS;
  if (!Number.isFinite(providerGraceMs) || providerGraceMs < 0 || providerGraceMs > 24 * 60 * 60 * 1000) {
    throw new RangeError("providerGraceMs must be between 0 and 24 hours");
  }
  const startedAt = options.now;
  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? 50;
  const items: TransferState[] = [];
  let providerComplete = true;
  let unparseable = 0;
  for (let page = 1; page <= maxPages; page++) {
    const result = await ctx.provider.listTransfers({ from: options.windowFrom, to: options.windowTo, page, perPage });
    if (result.outcome !== "ok") {
      if (page === 1) {
        return {
          outcome: "provider_unavailable", runId: null, providerCount: 0, kolektoCount: 0, discrepancies: [],
          providerComplete: false, providerVerifications: 0, pendingVerification: 0,
        };
      }
      providerComplete = false;
      break;
    }
    items.push(...result.value.items);
    unparseable += result.value.unparseable;
    if (page >= result.value.pageCount) break;
    if (page === maxPages) providerComplete = false;
  }
  if (unparseable > 0) providerComplete = false;

  const kolekto = await listKolektoTransfersForReconciliation(ctx.db, options.windowFrom, options.windowTo);
  const compareOptions: CompareOptions = {
    windowFrom: options.windowFrom,
    windowTo: options.windowTo,
    now: options.now,
    staleAfterMs: options.staleAfterMs ?? 24 * 60 * 60 * 1000,
    providerComplete,
    providerGraceMs,
  };

  // Before calling anything missing, ask Paystack about it by reference. GET only:
  // this never initiates, retries, settles or releases a transfer.
  const verifications = new Map<string, ProviderVerification>();
  const maxVerifications = options.maxVerifications ?? DEFAULT_MAX_PROVIDER_VERIFICATIONS;
  let providerVerifications = 0;
  for (const reference of referencesNeedingProviderVerification(kolekto, items, compareOptions)) {
    if (providerVerifications >= maxVerifications) {
      verifications.set(reference, { outcome: "unavailable", reason: "not re-verified: per-run verification limit reached" });
      continue;
    }
    providerVerifications += 1;
    let answer: Awaited<ReturnType<TransferProvider["verifyTransfer"]>>;
    try {
      answer = await ctx.provider.verifyTransfer(reference);
    } catch {
      verifications.set(reference, { outcome: "unavailable", reason: "verify call failed" });
      continue;
    }
    if (answer.outcome === "ok" && answer.value.reference === reference) verifications.set(reference, { outcome: "found", state: answer.value });
    else if (answer.outcome === "not_found") verifications.set(reference, { outcome: "not_found" });
    else verifications.set(reference, { outcome: "unavailable", reason: answer.outcome === "unknown" ? answer.reason : answer.outcome });
  }

  const discrepancies = compareTransfers(kolekto, items, { ...compareOptions, verifications });
  const runId = await recordTransferReconciliationRun(
    ctx.db,
    {
      startedAt,
      windowFrom: options.windowFrom,
      windowTo: options.windowTo,
      providerMode: ctx.provider.name === "fake" ? "fake" : ctx.provider.testMode ? "test" : "live",
      providerCount: items.length,
      kolektoCount: kolekto.length,
      providerGraceSeconds: Math.round(providerGraceMs / 1000),
    },
    discrepancies,
  );
  return {
    outcome: "recorded",
    runId,
    providerCount: items.length,
    kolektoCount: kolekto.length,
    discrepancies,
    providerComplete,
    providerVerifications,
    pendingVerification: discrepancies.filter((d) => d.kind === "provider_verification_pending").length,
  };
}

/**
 * When the worker should run reconciliation next: the regular interval, or —
 * when this run left transfers pending verification — shortly after their
 * grace period ends, so Paystack is asked again then rather than hours later.
 */
export function nextReconciliationDelayMs(
  result: Pick<TransferReconciliationResult, "pendingVerification">,
  intervalMs: number,
  providerGraceMs: number = DEFAULT_PROVIDER_VERIFICATION_GRACE_MS,
): number {
  const recheckMs = providerGraceMs + 60 * 1000;
  return result.pendingVerification > 0 ? Math.min(intervalMs, recheckMs) : intervalMs;
}
