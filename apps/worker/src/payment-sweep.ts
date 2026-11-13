/**
 * payment-sweep.ts — the worker side of the payment sweep (plan §4.3, O-14).
 *
 * The sweep itself lives in @kolekto/payments and is shared with the web
 * app's orchestrator. This file only decides whether this worker may run it
 * and builds what it needs.
 *
 * Off unless all of these hold, and never fatal (the notification stages
 * must keep running whatever happens here):
 *
 *   · KOLEKTO_ENV is local. Until M8.9 the only provider is the in-memory
 *     fake, and a fake in this process has never seen the web process's
 *     checkouts, so it answers "not found" for every reference and the sweep
 *     expires anything past its hold. That is right for local abandoned
 *     checkouts and wrong anywhere real money could be involved.
 *   · The payment functions exist and this role may execute them, and this
 *     role can read payment_attempts through forced RLS (owner-equivalent:
 *     superuser or BYPASSRLS). The least-privilege worker role has none of
 *     this by design (worker-guards.ts), so there the sweep stays off.
 */

import { createFakePaymentProvider } from "@kolekto/adapters";
import type { KolektoEnvironment } from "@kolekto/config";
import type { PaymentDb } from "@kolekto/db";
import { type PaymentContext, type SweepReport, sweepPaymentAttempts } from "@kolekto/payments";
import type postgres from "postgres";

export const PAYMENT_SWEEP_INTERVAL_MS = 60_000;

/** What the sweep needs from the database, by exact signature. */
export const PAYMENT_SWEEP_FUNCTIONS: readonly string[] = Object.freeze([
  "app.expire_payment_attempt(uuid)",
  "app.complete_payment_capture(uuid)",
  "app.record_provider_transaction(text, text, text, text, text, text, bigint, text, bigint, timestamptz, text, text, jsonb)",
]);

/** A dummy signing secret for the local fake. Not a Paystack key. */
const FAKE_WEBHOOK_SECRET = "test-webhook-secret-m8.5";

export type PaymentSweepDecision = { enabled: true } | { enabled: false; reason: string };

export async function paymentSweepAllowed(
  sql: postgres.Sql<Record<string, never>>,
  environment: KolektoEnvironment,
): Promise<PaymentSweepDecision> {
  if (environment !== "local") return { enabled: false, reason: "no_real_payment_provider_until_m8_9" };
  const [row] = await sql<{ functions_ok: boolean | null; table_ok: boolean | null; rls_ok: boolean | null }[]>`
    select
      bool_and(to_regprocedure(f) is not null and has_function_privilege(current_user, to_regprocedure(f), 'EXECUTE')) as functions_ok,
      to_regclass('public.payment_attempts') is not null
        and has_table_privilege(current_user, 'public.payment_attempts', 'SELECT') as table_ok,
      (select r.rolsuper or r.rolbypassrls from pg_roles r where r.rolname = current_user) as rls_ok
    from unnest(${PAYMENT_SWEEP_FUNCTIONS as string[]}::text[]) as f
  `;
  if (!row?.functions_ok) return { enabled: false, reason: "payment_functions_missing_or_not_executable" };
  if (!row.table_ok) return { enabled: false, reason: "payment_attempts_not_readable" };
  if (!row.rls_ok) return { enabled: false, reason: "role_subject_to_payment_rls" };
  return { enabled: true };
}

/** The sweep's context on this worker's own connection. Each call is its own transaction. */
export function workerPaymentContext(sql: postgres.Sql<Record<string, never>>): PaymentContext {
  const db: PaymentDb = (fn) => sql.begin(fn) as ReturnType<typeof fn>;
  return {
    db,
    provider: createFakePaymentProvider({ webhookSecret: FAKE_WEBHOOK_SECRET, defaultScenario: "not_found" }),
  };
}

/** One log line per run that did something; silence when nothing was due. */
export function sweepLogLine(report: SweepReport): Record<string, unknown> | null {
  if (report.examined === 0) return null;
  const counts: Record<string, number> = {};
  for (const { outcome } of report.outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  const codes = [...new Set(report.outcomes.flatMap((o) => (o.code ? [o.code] : [])))];
  return { msg: "payment_sweep", examined: report.examined, ...counts, ...(codes.length > 0 ? { codes } : {}) };
}

export { sweepPaymentAttempts };
