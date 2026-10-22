/**
 * notification-sender-state.ts — worker-side wrappers for the P5-5 controls.
 *
 * Companion to migration 20261019140000, which owns the guarantees: the pause
 * switch, the heartbeat, the race-safe 72-hour expiry and the health snapshot
 * all live in the database functions. Nothing here enforces anything — this
 * module only gives the sender a typed, narrow way to call them. Every call is
 * a standalone statement and commits before it returns.
 *
 * Ids, counts, codes and timestamps only — never an address, name or error
 * text. The health snapshot the database returns is already redacted; the
 * worker logs it verbatim.
 */

import type postgres from "postgres";

// Helpers run on the base connection or inside a transaction, so accept either.
type Db = postgres.Sql<Record<string, never>> | postgres.TransactionSql<Record<string, never>>;

/** Read the pause switch. False when the state row is missing (fail closed). */
export async function isEmailSendingEnabled(sql: Db): Promise<boolean> {
  const [row] = await sql<{ enabled: boolean }[]>`select app.email_sending_enabled() as enabled`;
  return row?.enabled ?? false;
}

/** Flip the pause switch (the emergency control). Returns the new value. */
export async function setEmailSendingEnabled(sql: Db, enabled: boolean): Promise<boolean> {
  const [row] = await sql<{ enabled: boolean }[]>`
    select app.set_email_sending_enabled(${enabled}) as enabled
  `;
  return row?.enabled ?? enabled;
}

/**
 * Stamp the sender heartbeat. `claimed` advances last_claim_at too, so an idle
 * but healthy sender shows a fresh heartbeat with a stale last-claim time.
 */
export async function recordSenderHeartbeat(sql: Db, claimed: boolean): Promise<void> {
  await sql`select app.record_sender_heartbeat(${claimed})`;
}

/**
 * Turn pending email deliveries past their 72-hour life into dead /
 * event_too_old. Race-safe against concurrent claims in the database. Returns
 * the number expired.
 */
export async function expireStaleDeliveries(sql: Db, maxAgeHours = 72): Promise<number> {
  const [row] = await sql<{ expired: string | number }[]>`
    select app.expire_stale_notification_deliveries(${maxAgeHours}::integer) as expired
  `;
  return Number(row?.expired ?? 0);
}

/** The operational send-health snapshot. All fields are safe to log. */
export interface SendHealth {
  readonly emailSendingEnabled: boolean;
  readonly lastHeartbeatAt: string | null;
  readonly lastClaimAt: string | null;
  readonly pendingTotal: number;
  readonly pendingDue: number;
  readonly oldestPendingAgeS: number;
  readonly deferredBacklog: number;
  readonly oldestDeferredAgeS: number;
  readonly sendingCount: number;
  readonly expiredLeaseCount: number;
  readonly l2BusiestLastHour: number;
  readonly l2UtilisationPct: number;
  readonly l3LastHour: number;
  readonly l3UtilisationPct: number;
  readonly sent24h: number;
  readonly dead24h: number;
  readonly skipped24h: number;
  readonly deadByCode: Record<string, number>;
  readonly skippedByCode: Record<string, number>;
}

interface SendHealthRow {
  email_sending_enabled: boolean;
  last_heartbeat_at: string | Date | null;
  last_claim_at: string | Date | null;
  pending_total: string | number;
  pending_due: string | number;
  oldest_pending_age_s: string | number;
  deferred_backlog: string | number;
  oldest_deferred_age_s: string | number;
  sending_count: string | number;
  expired_lease_count: string | number;
  l2_busiest_last_hour: string | number;
  l2_utilisation_pct: string | number | null;
  l3_last_hour: string | number;
  l3_utilisation_pct: string | number | null;
  sent_24h: string | number;
  dead_24h: string | number;
  skipped_24h: string | number;
  dead_by_code: Record<string, number>;
  skipped_by_code: Record<string, number>;
}

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/** Read the single-row health snapshot from app.notification_send_health(). */
export async function readSendHealth(sql: Db): Promise<SendHealth> {
  const [row] = await sql<SendHealthRow[]>`select * from app.notification_send_health()`;
  if (!row) throw new Error("notification_send_health returned no row");
  return {
    emailSendingEnabled: row.email_sending_enabled,
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    lastClaimAt: iso(row.last_claim_at),
    pendingTotal: Number(row.pending_total), // invariant-allow: a delivery count, not a money value
    pendingDue: Number(row.pending_due),
    oldestPendingAgeS: Number(row.oldest_pending_age_s),
    deferredBacklog: Number(row.deferred_backlog),
    oldestDeferredAgeS: Number(row.oldest_deferred_age_s),
    sendingCount: Number(row.sending_count),
    expiredLeaseCount: Number(row.expired_lease_count),
    l2BusiestLastHour: Number(row.l2_busiest_last_hour),
    l2UtilisationPct: Number(row.l2_utilisation_pct ?? 0),
    l3LastHour: Number(row.l3_last_hour),
    l3UtilisationPct: Number(row.l3_utilisation_pct ?? 0),
    sent24h: Number(row.sent_24h),
    dead24h: Number(row.dead_24h),
    skipped24h: Number(row.skipped_24h),
    deadByCode: row.dead_by_code ?? {},
    skippedByCode: row.skipped_by_code ?? {},
  };
}

/**
 * Read the recipient address of a delivery this worker holds in `sending`.
 * Used only to build the envelope; never logged. Returns null if the row is
 * no longer sending (e.g. recovered) or carries no address.
 */
export async function loadSendAddress(sql: Db, deliveryId: string): Promise<string | null> {
  const [row] = await sql<{ recipient_address: string | null }[]>`
    select recipient_address
    from public.notification_deliveries
    where id = ${deliveryId}::uuid and status = 'sending'
  `;
  return row?.recipient_address ?? null;
}
