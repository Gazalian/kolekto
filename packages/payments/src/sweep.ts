/**
 * sweep.ts — settles payment attempts nobody came back for (plan §4.3, O-14).
 *
 * A contributor who closes the tab after paying never reaches the callback,
 * and one who never pays leaves an attempt holding stock. The sweep picks up
 * both:
 *
 *   · captured attempts whose T2 did not finish  → run T2 again (idempotent)
 *   · created/initialized attempts past their hold → ask the provider:
 *       succeeded / failed / abandoned / reversed  → record it (T1), capture on success
 *       pending, inside the 24 h check window      → leave it; look again next run
 *       pending, past the check window             → expire (releases stock)
 *       provider has no such payment               → expire
 *       provider did not answer                    → leave it (D-27: timeout ≠ failure)
 *
 * Expiring never loses money: a success the provider reports later for an
 * expired attempt is parked as needs_review by record_provider_transaction.
 *
 * One attempt's error never stops the run; it is counted and the next one
 * goes. Pending verifies are not recorded as evidence on every run, so a
 * slow payment does not write a row per sweep.
 */

import { DatabaseError, expirePaymentAttempt, listDuePaymentAttempts } from "@kolekto/db";

import { capture, type PaymentContext, recordAndCapture } from "./orchestrator.ts";

export type SweepOutcome =
  | "completed"
  | "failed"
  | "expired"
  | "needs_review"
  | "still_pending"
  | "provider_unavailable"
  | "error";

export interface SweepReport {
  examined: number;
  outcomes: { reference: string; outcome: SweepOutcome; code?: string }[];
}

export const DEFAULT_SWEEP_LIMIT = 50;

export async function sweepPaymentAttempts(
  ctx: PaymentContext,
  options: { limit?: number } = {},
): Promise<SweepReport> {
  const due = await listDuePaymentAttempts(ctx.db, ctx.provider.name, options.limit ?? DEFAULT_SWEEP_LIMIT);
  const report: SweepReport = { examined: due.length, outcomes: [] };

  for (const attempt of due) {
    let outcome: SweepOutcome;
    let code: string | undefined;
    try {
      if (attempt.status === "captured") {
        const result = await capture(ctx.db, attempt.attempt_id);
        outcome = result.outcome === "completed" || result.outcome === "needs_review" ? result.outcome : "error";
        if (result.outcome === "error") code = result.code;
      } else {
        const verified = await ctx.provider.verify(attempt.reference);
        if (verified.outcome === "not_found") {
          outcome = await expire(ctx, attempt.attempt_id);
        } else if (verified.outcome === "unknown") {
          outcome = "provider_unavailable";
        } else if (verified.outcome === "refused") {
          outcome = "error";
          code = "verify_refused";
        } else if (verified.value.status === "pending") {
          outcome = attempt.past_check_window ? await expire(ctx, attempt.attempt_id) : "still_pending";
        } else {
          const result = await recordAndCapture(ctx.db, verified.value);
          switch (result.outcome) {
            case "completed":
            case "needs_review":
            case "failed":
              outcome = result.outcome;
              break;
            case "pending":
              outcome = "still_pending";
              break;
            case "not_found":
              outcome = "error";
              code = "UNKNOWN_PAYMENT_REFERENCE";
              break;
            case "provider_unavailable":
              outcome = "provider_unavailable";
              break;
            case "error":
              outcome = "error";
              code = result.code;
              break;
          }
        }
      }
    } catch (error) {
      outcome = "error";
      code = error instanceof DatabaseError ? error.code : "unexpected";
    }
    report.outcomes.push(code === undefined ? { reference: attempt.reference, outcome } : { reference: attempt.reference, outcome, code });
  }

  return report;
}

async function expire(ctx: PaymentContext, attemptId: string): Promise<SweepOutcome> {
  const status = await expirePaymentAttempt(ctx.db, attemptId);
  // Something else moved it first (a webhook, the callback): report what it is now.
  if (status === "expired") return "expired";
  if (status === "completed") return "completed";
  if (status === "needs_review") return "needs_review";
  if (status === "failed") return "failed";
  return "still_pending";
}
