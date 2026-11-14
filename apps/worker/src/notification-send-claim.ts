/**
 * notification-send-claim.ts — the worker-side half of P5-1 atomic claims.
 *
 * M13.2 P5-1. Companion to migration 20261013100000, which owns the
 * guarantees: the row lock, the lease token, the attempt reservation and the
 * token-gated settle/recover transitions all happen inside the database
 * functions. Nothing here enforces anything — this module only gives the
 * future sender a typed, narrow way to call those functions.
 *
 * ── TRANSACTION DISCIPLINE ─────────────────────────────────────────────────
 * Every call below runs in its own short transaction and commits before it
 * returns. The sender (a later phase) MUST commit the claim before any
 * provider call executes and MUST NEVER hold the claim transaction open
 * across a provider call: the row lock is held for the life of the
 * transaction, and holding it across a network call would defeat
 * SKIP LOCKED for every other worker.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 * No provider call, no sender loop, no retry scheduling, no backoff, no
 * rate-limit accounting. A 'retry' settle takes its next_retry_at from the
 * caller; computing that value is a later phase. Tokens are opaque strings
 * passed through: they are never logged, never stored outside the delivery
 * row, and these functions take ids only — never addresses, names or error
 * text.
 */

import type postgres from "postgres";

// Helpers run both on the base connection and inside a transaction, so accept either.
type Db = postgres.Sql<Record<string, never>> | postgres.TransactionSql<Record<string, never>>;

/** Lease duration the sender requests, in seconds (decision record §10.6.2). */
export const SEND_LEASE_SECONDS = 300;

/** At most three attempts per delivery; reserved by a successful claim. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** Delivery states after which a row must never be claimed again. */
const TERMINAL_DELIVERY_STATUSES: readonly string[] = ["sent", "dead", "skipped"];

export function isTerminalDeliveryStatus(status: string): boolean {
  return TERMINAL_DELIVERY_STATUSES.includes(status);
}

/** True once the lease timestamp has passed at the given moment. */
export function isLeaseExpired(leaseExpiresAt: string | Date, nowMs: number): boolean {
  return Date.parse(leaseExpiresAt instanceof Date ? leaseExpiresAt.toISOString() : leaseExpiresAt) <= nowMs;
}

export interface DeliveryClaim {
  readonly claimed: boolean;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly attemptCount: number | null;
  readonly reason: string;
}

export interface NextDeliveryClaim extends DeliveryClaim {
  readonly deliveryId: string | null;
}

export interface SettleOutcome {
  readonly settled: boolean;
  readonly reason: string;
}

export interface RecoverOutcome {
  readonly recovered: boolean;
  readonly reason: string;
}

interface ClaimRow {
  claimed: boolean;
  lease_token: string | null;
  lease_expires_at: string | Date | null;
  attempt_count: number | null;
  reason: string;
}

function toClaim(row: ClaimRow | undefined, fallback: string): DeliveryClaim {
  if (!row) return { claimed: false, leaseToken: null, leaseExpiresAt: null, attemptCount: null, reason: fallback };
  return {
    claimed: row.claimed,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at instanceof Date ? row.lease_expires_at.toISOString() : row.lease_expires_at,
    attemptCount: row.attempt_count,
    reason: row.reason,
  };
}

/**
 * Claim one delivery by id. Commits before returning; the caller must not
 * make a provider call inside this transaction (there is none — the function
 * only calls the database and returns the lease).
 */
export async function claimDeliveryById(
  sql: Db,
  deliveryId: string,
  leaseSeconds: number = SEND_LEASE_SECONDS,
): Promise<DeliveryClaim> {
  const [row] = await sql<ClaimRow[]>`
    select claimed, lease_token, lease_expires_at, attempt_count, reason
    from app.claim_notification_delivery(${deliveryId}::uuid, ${leaseSeconds}::integer)
  `;
  return toClaim(row, "not_found");
}

/**
 * Claim the oldest due pending email delivery (SKIP LOCKED). Returns
 * claimed = false with reason 'empty' when no delivery is due.
 */
export async function claimNextDelivery(
  sql: Db,
  leaseSeconds: number = SEND_LEASE_SECONDS,
): Promise<NextDeliveryClaim> {
  const [row] = await sql<(ClaimRow & { delivery_id: string | null })[]>`
    select delivery_id, claimed, lease_token, lease_expires_at, attempt_count, reason
    from app.claim_next_notification_delivery(${leaseSeconds}::integer)
  `;
  return { ...toClaim(row, "empty"), deliveryId: row?.delivery_id ?? null };
}

export type SettleOutcomeKind = "sent" | "retry" | "dead";

export interface SettleOptions {
  /** Stable Kolekto code. Required for 'retry' and 'dead', forbidden for 'sent'. */
  readonly errorCode?: string;
  /** Provider's id for the accepted message. Stored on 'sent'. */
  readonly providerMessageId?: string;
  /** When a 'retry' becomes due. Null means due immediately. */
  readonly nextRetryAt?: string | null;
}

/**
 * Leave `sending` with the current unexpired lease token. A stale, replaced
 * or expired token changes nothing (settled = false). Misuse — an unknown
 * outcome, a code where none belongs — raises from the database: that is a
 * worker bug, not a race.
 */
export async function settleDelivery(
  sql: Db,
  deliveryId: string,
  leaseToken: string,
  outcome: SettleOutcomeKind,
  options: SettleOptions = {},
): Promise<SettleOutcome> {
  const [row] = await sql<{ settled: boolean; reason: string }[]>`
    select settled, reason
    from app.resolve_notification_claim(
      ${deliveryId}::uuid,
      ${leaseToken},
      ${outcome},
      ${options.errorCode ?? null},
      ${options.providerMessageId ?? null},
      ${options.nextRetryAt ?? null}::timestamptz
    )
  `;
  if (!row) return { settled: false, reason: "not_found" };
  return { settled: row.settled, reason: row.reason };
}

/**
 * Return an expired-lease `sending` row to `pending` and clear its lease,
 * so the old token can never settle afterwards. A live lease is refused.
 */
export async function recoverExpiredLease(sql: Db, deliveryId: string): Promise<RecoverOutcome> {
  const [row] = await sql<{ recovered: boolean; reason: string }[]>`
    select recovered, reason
    from app.recover_expired_notification_lease(${deliveryId}::uuid)
  `;
  if (!row) return { recovered: false, reason: "not_leased" };
  return { recovered: row.recovered, reason: row.reason };
}

/**
 * P9-4. Resolve an expired-lease `sending` row as ambiguous (dead /
 * outcome_unknown) rather than returning it to pending. Used by the sender
 * when the provider's idempotency is `"none"` — a retry would risk a double
 * send, so the row is surfaced for an operator to decide. Live-lease rows
 * are refused; a terminal row returns `not_leased`.
 */
export interface ResolveAmbiguousOutcome {
  readonly resolved: boolean;
  readonly reason: string;
}

export async function resolveLeaseAmbiguous(sql: Db, deliveryId: string): Promise<ResolveAmbiguousOutcome> {
  const [row] = await sql<{ resolved: boolean; reason: string }[]>`
    select resolved, reason
    from app.resolve_lease_ambiguous(${deliveryId}::uuid)
  `;
  if (!row) return { resolved: false, reason: "not_leased" };
  return { resolved: row.resolved, reason: row.reason };
}
