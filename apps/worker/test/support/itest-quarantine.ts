/**
 * itest-quarantine.ts — per-test quarantine SQL, built but never executed here (M13.2 Phase 1c).
 *
 * Pure: no database, no driver import. Implements checklist R7 / review §5.8:
 * leftover rows are made inert, never deleted. A test's `finally` (Phase 4–5)
 * runs the returned statement on its verified connection after its assertions:
 *
 *   update public.notification_deliveries
 *      set status = 'dead', error_code = 'itest_quarantined',
 *          send_lease_token = null, send_lease_expires_at = null
 *    where channel = 'email' and status in ('pending', 'sending')
 *      and community_id in ($1::uuid, …)
 *   returning id
 *
 * Why this is not a protection bypass: notification_deliveries is not
 * append-only (review F9). `dead` with a stable code matching
 * `^[a-z][a-z0-9_]{2,63}$` and both lease columns null satisfies its
 * constraints. The statement deletes nothing, toggles no trigger, sets no
 * configuration, and never touches the ledger, the events or the pause switch.
 *
 * Safety properties:
 *   - The SQL text is a constant except for the number of `$n::uuid`
 *     placeholders. No caller value is ever interpolated into the text; table,
 *     column, status and error-code identifiers are fixed.
 *   - Every community id must be a lowercase v4 UUID **issued by the caller's
 *     RunScope** (itest-fixtures.ts), so a quarantine can only name rows the
 *     current run created. Reserved P8 residue ids are refused by the scope.
 *   - Bounded: 1–50 distinct ids per statement.
 *   - Only email rows are touched: only they are claimable by the sender
 *     (review F3), and the in-app status constraints are not asserted here.
 */

import { refuse } from "./itest-environment.ts";
import type { RunScope } from "./itest-fixtures.ts";

export const QUARANTINE_ERROR_CODE = "itest_quarantined";
export const MAX_QUARANTINE_SCOPE = 50;

/** A parameterised statement: run as `sql.unsafe(text, [...values])`. */
export interface SqlStatement {
  readonly text: string;
  readonly values: readonly string[];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function scopedIds(scope: RunScope, communityIds: unknown): string[] {
  if (!Array.isArray(communityIds) || communityIds.length === 0 || communityIds.length > MAX_QUARANTINE_SCOPE) {
    throw refuse("QUARANTINE_INPUT_INVALID", `A quarantine names 1-${MAX_QUARANTINE_SCOPE} community ids.`);
  }
  const ids: string[] = [];
  for (const id of communityIds) {
    if (typeof id !== "string" || !UUID_V4.test(id)) {
      throw refuse("QUARANTINE_INPUT_INVALID", "A quarantine community id is not a lowercase random (version 4) UUID.");
    }
    if (!scope.owns(id)) {
      throw refuse("QUARANTINE_INPUT_INVALID", "A quarantine community id was not issued by this run's scope; only the current run's rows may be quarantined.");
    }
    if (ids.includes(id)) {
      throw refuse("QUARANTINE_INPUT_INVALID", "A quarantine names the same community id twice.");
    }
    ids.push(id);
  }
  return ids;
}

const placeholders = (n: number) => Array.from({ length: n }, (_, i) => `$${i + 1}::uuid`).join(", ");

/** UPDATE the run's own non-terminal email deliveries to `dead / itest_quarantined`. */
export function buildQuarantineStatement(scope: RunScope, communityIds: readonly string[]): SqlStatement {
  const ids = scopedIds(scope, communityIds);
  return Object.freeze({
    text:
      `update public.notification_deliveries ` +
      `set status = 'dead', error_code = '${QUARANTINE_ERROR_CODE}', send_lease_token = null, send_lease_expires_at = null ` +
      `where channel = 'email' and status in ('pending', 'sending') and community_id in (${placeholders(ids.length)}) ` +
      `returning id`,
    values: Object.freeze(ids),
  });
}

/** Read-only postflight (checklist §7.7): the run's scope must hold no pending or sending email row. */
export function buildScopeResidueCheck(scope: RunScope, communityIds: readonly string[]): SqlStatement {
  const ids = scopedIds(scope, communityIds);
  return Object.freeze({
    text:
      `select count(*)::int as open_rows from public.notification_deliveries ` +
      `where channel = 'email' and status in ('pending', 'sending') and community_id in (${placeholders(ids.length)})`,
    values: Object.freeze(ids),
  });
}
