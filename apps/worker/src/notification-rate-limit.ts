/**
 * notification-rate-limit.ts — the worker-side half of P5-2 rate limits.
 *
 * M13.2 P5-2. Companion to migration 20261013200000, which owns the
 * guarantees: the advisory-lock ordering, the ledger insert, the backlog
 * cap, the address-erasure and the attempt rollback all happen inside the
 * database function. Nothing here enforces anything — this module only
 * gives the future sender a typed, narrow way to call those functions.
 *
 * ── TRANSACTION DISCIPLINE ─────────────────────────────────────────────────
 * reserveEmailAttempt MUST be called inside the same transaction that
 * claimed the delivery (P5-1). The advisory locks taken by the reserve
 * function are transaction-scoped: they prevent concurrent bypass and are
 * released when the transaction commits. The caller's transaction flow is:
 *
 *   BEGIN → claim → reserve → COMMIT → (provider call if granted)
 *
 * getSendLimits and purgeStaleSendAttempts are standalone calls; neither
 * requires a surrounding transaction.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 * No provider call, no sender loop, no retry scheduling, no backoff
 * computation. The reserve function decides the outcome; the caller acts
 * on it. Ids only — never addresses, names or error text.
 */

import type postgres from "postgres";

type Db = postgres.Sql<Record<string, never>> | postgres.TransactionSql<Record<string, never>>;

/**
 * P9-1 adds `address_suppressed`: the delivery was skipped BEFORE any rate
 * limit was consulted because `app.is_address_suppressed` returned true for
 * the recipient. The database function has already set the delivery to
 * skipped/`address_suppressed`, erased the recipient address and undone the
 * attempt counter. The sender treats it exactly like `address_limited` from
 * the outside — a terminal skip, no retry — and surfaces the stable code so
 * the health snapshot can report it separately.
 *
 * P9-3 adds `provider_daily_limited` and `provider_rate_limited`: the
 * delivery was deferred because the per-class daily (L4) or per-second (L5)
 * cap had no room. Both keep the address, undo the attempt and set
 * `next_retry_at` on the delivery row, matching the `community_deferred`
 * pattern. They are deferrals, not retries — `attempt_count` is unchanged.
 */
export type ReservationOutcome =
  | "granted"
  | "address_suppressed"
  | "address_limited"
  | "community_deferred"
  | "provider_daily_limited"
  | "provider_rate_limited"
  | "backlog_full";

export interface EmailReservation {
  readonly reservation: ReservationOutcome;
  readonly retryAt: string | null;
}

export interface SendLimits {
  readonly l1Address: number;
  readonly l1WindowHours: number;
  readonly l2Community: number;
  readonly l2WindowHours: number;
  readonly l3Platform: number;
  readonly l3WindowHours: number;
  readonly l4Daily: number;
  readonly l4WindowHours: number;
  readonly l5PerSecond: number;
  readonly l5WindowSeconds: number;
  readonly backlogMax: number;
  readonly maxAttempts: number;
}

/** The send classes the limits function understands. P9-3. */
export type SendClass = "transactional" | "bulk";

/**
 * Reserve an email attempt inside the claim transaction. The database
 * function checks L1 (per-address), L2 (per-community), L3 (platform)
 * and the backlog cap, takes advisory locks in a fixed order to prevent
 * concurrent bypass, and either inserts a ledger row (granted) or updates
 * the delivery row with the appropriate outcome.
 *
 * MUST be called on a TransactionSql inside the claim transaction.
 */
export async function reserveEmailAttempt(
  sql: Db,
  deliveryId: string,
): Promise<EmailReservation> {
  const [row] = await sql<{ reservation: string; retry_at: string | Date | null }[]>`
    select reservation, retry_at
    from app.reserve_email_attempt(${deliveryId}::uuid)
  `;
  if (!row) throw new Error(`reserve_email_attempt returned no row for ${deliveryId}`);
  return {
    reservation: row.reservation as ReservationOutcome,
    retryAt: row.retry_at instanceof Date ? row.retry_at.toISOString() : row.retry_at,
  };
}

/**
 * Read the configured rate-limit, quota and backlog values for one send
 * class. Standalone call; does not require a surrounding transaction.
 * P9-3 added the required `sendClass` argument.
 */
export async function getSendLimits(sql: Db, sendClass: SendClass): Promise<SendLimits> {
  const [row] = await sql<{
    l1_address: number;
    l1_window_hours: number;
    l2_community: number;
    l2_window_hours: number;
    l3_platform: number;
    l3_window_hours: number;
    l4_daily: number;
    l4_window_hours: number;
    l5_per_second: number;
    l5_window_seconds: number;
    backlog_max: number;
    max_attempts: number;
  }[]>`
    select l1_address, l1_window_hours, l2_community, l2_window_hours,
           l3_platform, l3_window_hours, l4_daily, l4_window_hours,
           l5_per_second, l5_window_seconds, backlog_max, max_attempts
    from app.notification_send_limits(${sendClass})
  `;
  if (!row) throw new Error("notification_send_limits returned no row");
  return {
    l1Address: row.l1_address,
    l1WindowHours: row.l1_window_hours,
    l2Community: row.l2_community,
    l2WindowHours: row.l2_window_hours,
    l3Platform: row.l3_platform,
    l3WindowHours: row.l3_window_hours,
    l4Daily: row.l4_daily,
    l4WindowHours: row.l4_window_hours,
    l5PerSecond: row.l5_per_second,
    l5WindowSeconds: row.l5_window_seconds,
    backlogMax: row.backlog_max,
    maxAttempts: row.max_attempts,
  };
}

/**
 * Delete ledger rows older than 48 hours. Standalone call; called by the
 * sender loop or a scheduled task. Returns the number of purged rows.
 */
export async function purgeStaleSendAttempts(sql: Db): Promise<number> {
  const [row] = await sql<{ purge_stale_send_attempts: string | number }[]>`
    select app.purge_stale_send_attempts()
  `;
  return Number(row?.purge_stale_send_attempts ?? 0);
}
