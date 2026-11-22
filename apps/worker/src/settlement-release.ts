/**
 * settlement-release.ts — the T+1 release job (20261117100100, D-09).
 *
 * Every few minutes the worker asks the database to release what is due:
 * app.release_due_settlements(limit) moves a contribution's net amount from
 * the collection's pending account to its available account when BOTH hold:
 *
 *   · its scheduled release time has passed (05:00 Africa/Lagos on the
 *     calendar day after capture, computed and stored in the database), and
 *   · the provider's settlement of that payment has been recorded
 *     (owner decision 2026-11-17: no money becomes available on the clock
 *     alone).
 *
 * Every rule lives in the database: the due time, the confirmation check, the
 * row locks (FOR UPDATE SKIP LOCKED, so two workers never release one payment)
 * and the idempotency key of the release journal. Running this twice, or on
 * two workers at once, releases each payment exactly once. This module only
 * decides whether it may run, calls the function, and logs counts.
 *
 * Never fatal, and off unless the function exists and this role may execute
 * it. The least-privilege worker role is not granted it (a release posts
 * ledger journals); the operator runs the worker with the server connection
 * where releases should happen. The function itself also refuses any session
 * that switched to a client role (app.assert_payment_operator_session).
 *
 * Logs carry counts and kobo totals only — no reference, name or collection.
 * `awaiting_provider` > 0 for long is the signal that provider settlements are
 * not being recorded.
 */

import type postgres from "postgres";

export const SETTLEMENT_RELEASE_INTERVAL_MS = 5 * 60_000;
/** Rows released per call. The next tick picks up the rest. */
export const SETTLEMENT_RELEASE_BATCH = 500;

export type SettlementReleaseDecision = { enabled: true } | { enabled: false; reason: string };

/** Whether this connection may run the release. */
export async function settlementReleaseAllowed(sql: postgres.Sql<Record<string, never>>): Promise<SettlementReleaseDecision> {
  const [row] = await sql<{ ok: boolean | null }[]>`
    select coalesce(has_function_privilege(to_regprocedure('app.release_due_settlements(integer)'), 'execute'), false) as ok
  `;
  return row?.ok === true
    ? { enabled: true }
    : { enabled: false, reason: "release_due_settlements_missing_or_not_executable" };
}

/** One call's result, bigint columns as digit strings. */
export interface SettlementReleaseRow {
  readonly released: number;
  readonly released_kobo: string;
  readonly awaiting_provider: number;
  readonly awaiting_provider_kobo: string;
}

export interface SettlementReleaseLine {
  readonly msg: "settlement_release";
  readonly released: number;
  readonly released_kobo: string;
  readonly awaiting_provider: number;
  readonly awaiting_provider_kobo: string;
}

/** Release what is due and confirmed. */
export async function releaseDueSettlements(
  sql: postgres.Sql<Record<string, never>> | postgres.TransactionSql<Record<string, never>>,
  limit: number = SETTLEMENT_RELEASE_BATCH,
): Promise<SettlementReleaseRow> {
  const [row] = await sql<SettlementReleaseRow[]>`
    select released, released_kobo::text as released_kobo,
           awaiting_provider, awaiting_provider_kobo::text as awaiting_provider_kobo
    from app.release_due_settlements(${limit}::integer)
  `;
  return row ?? { released: 0, released_kobo: "0", awaiting_provider: 0, awaiting_provider_kobo: "0" };
}

const DIGITS = /^\d{1,18}$/;

/** Pure: a log line when something was released or is waiting on the provider; null when there is nothing to say. */
export function settlementReleaseLogLine(row: SettlementReleaseRow): SettlementReleaseLine | null {
  const released = Number.isSafeInteger(row.released) && row.released > 0 ? row.released : 0;
  const awaiting = Number.isSafeInteger(row.awaiting_provider) && row.awaiting_provider > 0 ? row.awaiting_provider : 0;
  if (released === 0 && awaiting === 0) return null;
  return {
    msg: "settlement_release",
    released,
    released_kobo: DIGITS.test(row.released_kobo) ? row.released_kobo : "0",
    awaiting_provider: awaiting,
    awaiting_provider_kobo: DIGITS.test(row.awaiting_provider_kobo) ? row.awaiting_provider_kobo : "0",
  };
}
