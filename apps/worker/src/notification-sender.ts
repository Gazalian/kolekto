/**
 * notification-sender.ts — the email sender runtime (M13.2 P5 / P5-5).
 *
 * The missing piece the earlier P5 migrations prepared for: the loop that
 * claims due pending email deliveries, calls a provider, and records the
 * outcome. Every durable guarantee still lives in the database — this module
 * only sequences the calls and applies the retry policy.
 *
 * ── TRANSACTION DISCIPLINE (the rule the whole design turns on) ──────────────
 * The claim and the rate-limit reservation happen together in one short
 * transaction that COMMITS before any provider call. The provider call then
 * runs with no transaction and no row lock open; the outcome is recorded in a
 * second short transaction. Holding the claim transaction across the provider
 * call would hold the row lock for the length of a network call and defeat
 * SKIP LOCKED for every other worker (migration 20261013100000).
 *
 *   BEGIN → claim → reserve → COMMIT → (if granted) send → resolve
 *
 * When the reservation is not `granted`, app.reserve_email_attempt has already
 * settled the row (skipped or deferred) inside that same transaction, so there
 * is nothing more to do and no provider call is made.
 *
 * ── CRASH / SHUTDOWN SAFETY ──────────────────────────────────────────────────
 * The only window where state can be "lost" is after a successful send but
 * before the resolve commits. There the row stays `sending` until its lease
 * expires and recovery returns it to `pending`; the delivery id is the
 * idempotency key, so a provider with idempotency de-duplicates the re-send and
 * one without yields outcome_unknown rather than a silent double. Nothing is
 * lost — at worst it is retried or surfaced.
 *
 * ── REDACTION ────────────────────────────────────────────────────────────────
 * The recipient address is read only to build the envelope and is never logged.
 * Every log line and the health snapshot carry ids, counts, stable codes and
 * timestamps only.
 */

import type postgres from "postgres";

import { EmailProviderError, type EmailProvider } from "@kolekto/adapters";

import { classifyFailure, type Rng } from "./notification-backoff.ts";
import { reserveEmailAttempt, purgeStaleSendAttempts, type ReservationOutcome } from "./notification-rate-limit.ts";
import {
  claimNextDelivery,
  recoverExpiredLease,
  resolveLeaseAmbiguous,
  settleDelivery,
  MAX_DELIVERY_ATTEMPTS,
  SEND_LEASE_SECONDS,
} from "./notification-send-claim.ts";
import { buildPlaceholderMessage } from "./notification-send-message.ts";
import {
  expireStaleDeliveries,
  isEmailSendingEnabled,
  loadSendAddress,
  readSendHealth,
  recordSenderHeartbeat,
  type SendHealth,
} from "./notification-sender-state.ts";

type BaseSql = postgres.Sql<Record<string, never>>;

/** How many deliveries one tick will try to send before yielding. */
export const DEFAULT_SEND_BATCH = 20;

/** The result of attempting one claimed delivery. Ids, codes and counts only. */
export type SendStep =
  | { readonly outcome: "empty" }
  // community_deferred, provider_daily_limited (L4) and provider_rate_limited
  // (L5) all land here: the row is pending with next_retry_at set, no
  // provider call was made, no attempt consumed.
  | { readonly outcome: "deferred"; readonly deliveryId: string; readonly reservation: ReservationOutcome; readonly retryAt: string | null }
  | { readonly outcome: "skipped"; readonly deliveryId: string; readonly reservation: ReservationOutcome }
  | { readonly outcome: "sent"; readonly deliveryId: string; readonly providerMessageId: string }
  | { readonly outcome: "retry"; readonly deliveryId: string; readonly errorCode: string; readonly nextRetryAt: string }
  | { readonly outcome: "dead"; readonly deliveryId: string; readonly errorCode: string }
  | { readonly outcome: "no_address"; readonly deliveryId: string }
  | { readonly outcome: "halt"; readonly deliveryId: string; readonly errorCode: string };

export interface SenderOptions {
  readonly provider: EmailProvider;
  /** Wall clock, injectable for tests. */
  readonly now: () => number;
  /** Jitter source for backoff, injectable for tests. */
  readonly rng: Rng;
}

/** True once a step means the worker actually claimed a row this tick. */
function stepClaimed(step: SendStep): boolean {
  return step.outcome !== "empty";
}

/**
 * Claim the next due delivery, reserve an attempt (one short committed
 * transaction), then — only if granted — send and resolve. Returns a typed
 * description of what happened; never throws for an ordinary provider failure.
 */
export async function sendOneClaimed(sql: BaseSql, opts: SenderOptions): Promise<SendStep> {
  // ── Phase 1: claim + reserve, committed before any provider call. ──────────
  const claimed = await sql.begin(async (tx) => {
    const claim = await claimNextDelivery(tx, SEND_LEASE_SECONDS);
    if (!claim.claimed || claim.deliveryId === null || claim.leaseToken === null) {
      return { kind: "empty" as const };
    }
    const reservation = await reserveEmailAttempt(tx, claim.deliveryId);
    return {
      kind: "claimed" as const,
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      attemptCount: claim.attemptCount ?? 0,
      reservation: reservation.reservation,
      retryAt: reservation.retryAt,
    };
  });

  if (claimed.kind === "empty") return { outcome: "empty" };

  const { deliveryId, leaseToken, attemptCount, reservation, retryAt } = claimed;

  // ── Non-granted: the reserve function already settled the row in-tx. ───────
  if (reservation !== "granted") {
    // Three deferral outcomes keep the address and set next_retry_at:
    // community_deferred (L2/L3), provider_daily_limited (L4), and
    // provider_rate_limited (L5). All are smoothing, not abuse controls.
    if (
      reservation === "community_deferred" ||
      reservation === "provider_daily_limited" ||
      reservation === "provider_rate_limited"
    ) {
      return { outcome: "deferred", deliveryId, reservation, retryAt };
    }
    // address_suppressed (P9-1) / address_limited / backlog_full: row is
    // skipped with a stable code. The caller surfaces `reservation` so the
    // health snapshot can count each cause separately via skipped_by_code.
    return { outcome: "skipped", deliveryId, reservation };
  }

  // ── Granted: the row is `sending` with our lease. Send, then resolve. ──────
  const address = await loadSendAddress(sql, deliveryId);
  if (address === null) {
    // A sendable email row carries an address (constraint), so this is a
    // defensive branch: resolve dead rather than call the provider with no
    // recipient. invalid_recipient_address is an existing stable code.
    await settleDelivery(sql, deliveryId, leaseToken, "dead", { errorCode: "invalid_recipient_address" });
    return { outcome: "no_address", deliveryId };
  }

  try {
    const result = await opts.provider.send({
      idempotencyKey: deliveryId,
      message: buildPlaceholderMessage(address),
    });
    await settleDelivery(sql, deliveryId, leaseToken, "sent", { providerMessageId: result.providerMessageId });
    return { outcome: "sent", deliveryId, providerMessageId: result.providerMessageId };
  } catch (err) {
    if (!(err instanceof EmailProviderError)) {
      // Unexpected (not a provider error): leave the row `sending`. Its lease
      // expires and recovery returns it to pending. Re-throw so the loop logs it.
      throw err;
    }
    const action = classifyFailure(err, attemptCount, MAX_DELIVERY_ATTEMPTS, opts.provider.idempotency, opts.now(), opts.rng);
    if (action.kind === "halt") {
      // Do not resolve: the lease expires and recovery reclaims the row. The
      // caller stops the sender rather than consuming more deliveries.
      return { outcome: "halt", deliveryId, errorCode: action.errorCode };
    }
    if (action.kind === "retry") {
      await settleDelivery(sql, deliveryId, leaseToken, "retry", { errorCode: action.errorCode, nextRetryAt: action.nextRetryAt });
      return { outcome: "retry", deliveryId, errorCode: action.errorCode, nextRetryAt: action.nextRetryAt };
    }
    await settleDelivery(sql, deliveryId, leaseToken, "dead", { errorCode: action.errorCode });
    return { outcome: "dead", deliveryId, errorCode: action.errorCode };
  }
}

/**
 * The two counts a recovery sweep can produce (P9-4): `recovered` lands a row
 * back in `pending` (safe for idempotent providers that de-dupe on replay);
 * `resolvedAmbiguous` lands a row in `dead/outcome_unknown` (safe for
 * non-idempotent providers like SES, where a retry risks a second send).
 */
export interface RecoveryCounts {
  readonly recovered: number;
  readonly resolvedAmbiguous: number;
}

/**
 * Recover every `sending` row whose lease has expired. Each recovery is its
 * own short transaction (the database re-checks the lease under a row lock),
 * so a row a live worker still holds is refused, not stolen. Bounded per
 * call. The destination state is chosen by `providerIdempotency`:
 *
 *   · `"provider"` → `app.recover_expired_notification_lease` → `pending`.
 *                     The same idempotency key reused on the retry lets the
 *                     provider dedupe (§10.6.2 ambiguous+idempotent).
 *   · `"none"`     → `app.resolve_lease_ambiguous` → `dead/outcome_unknown`.
 *                     A crash-after-accept against a non-idempotent provider
 *                     (SES) must never silently retry (Q-DUP, §10.6.4).
 */
export async function recoverExpiredLeases(
  sql: BaseSql,
  providerIdempotency: "provider" | "none",
  limit = 100,
): Promise<RecoveryCounts> {
  const rows = await sql<{ id: string }[]>`
    select id
    from public.notification_deliveries
    where status = 'sending'
      and send_lease_expires_at is not null
      and send_lease_expires_at <= now()
    order by send_lease_expires_at
    limit ${limit}
  `;
  let recovered = 0;
  let resolvedAmbiguous = 0;
  for (const row of rows) {
    if (providerIdempotency === "provider") {
      const out = await recoverExpiredLease(sql, row.id);
      if (out.recovered) recovered += 1;
    } else {
      const out = await resolveLeaseAmbiguous(sql, row.id);
      if (out.resolved) resolvedAmbiguous += 1;
    }
  }
  return { recovered, resolvedAmbiguous };
}

export interface TickOptions extends SenderOptions {
  /** Max deliveries to attempt this tick. */
  readonly maxBatch: number;
  /**
   * Run the periodic maintenance (lease recovery, 72-hour expiry, ledger
   * purge) and emit the health log line. The caller sets this roughly once a
   * minute; maintenance runs whether or not sending is paused.
   */
  readonly runMaintenance: boolean;
  /**
   * Allow sending this tick. The caller passes false after a halt, to keep
   * maintenance running while no provider calls are made. Sending also requires
   * the database pause switch to be enabled.
   */
  readonly allowSend: boolean;
  /** Structured log sink for the per-minute health line. */
  readonly log: (line: Record<string, unknown>) => void;
  /**
   * Checked before each delivery in the batch; returning false stops the batch
   * cleanly (used on shutdown). An in-flight send already started completes.
   */
  readonly shouldContinue?: () => boolean;
}

export interface TickResult {
  readonly paused: boolean;
  readonly maintenanceRan: boolean;
  readonly recovered: number;
  /** P9-4: expired-lease rows resolved as dead/outcome_unknown. */
  readonly resolvedAmbiguous: number;
  readonly expired: number;
  readonly purged: number;
  readonly steps: readonly SendStep[];
  readonly halted: boolean;
  readonly health: SendHealth | null;
}

/**
 * One sender tick: maintenance (when due), then — if sending is allowed and the
 * pause switch is enabled — drain up to a batch of deliveries, then heartbeat,
 * then (when maintenance ran) emit one redacted health log line.
 */
export async function runSenderTick(sql: BaseSql, opts: TickOptions): Promise<TickResult> {
  let recovered = 0;
  let resolvedAmbiguous = 0;
  let expired = 0;
  let purged = 0;

  // Maintenance is the work the pause switch must NOT stop: recover crashed
  // leases, age out deliveries past 72 hours, purge the stale ledger. The
  // provider's declared idempotency decides whether expired-lease rows go
  // back to pending (idempotent, safe to replay) or terminal as
  // dead/outcome_unknown (non-idempotent, Q-DUP: never silently replay).
  if (opts.runMaintenance) {
    const counts = await recoverExpiredLeases(sql, opts.provider.idempotency);
    recovered = counts.recovered;
    resolvedAmbiguous = counts.resolvedAmbiguous;
    expired = await expireStaleDeliveries(sql);
    purged = await purgeStaleSendAttempts(sql);
  }

  const enabled = await isEmailSendingEnabled(sql);
  const steps: SendStep[] = [];
  let halted = false;
  let claimedAny = false;

  if (opts.allowSend && enabled) {
    for (let i = 0; i < opts.maxBatch; i += 1) {
      if (opts.shouldContinue && !opts.shouldContinue()) break;
      const step = await sendOneClaimed(sql, opts);
      if (step.outcome === "empty") break;
      steps.push(step);
      claimedAny = claimedAny || stepClaimed(step);
      if (step.outcome === "halt") {
        halted = true;
        break;
      }
    }
  }

  await recordSenderHeartbeat(sql, claimedAny);

  let health: SendHealth | null = null;
  if (opts.runMaintenance) {
    health = await readSendHealth(sql);
    opts.log(healthLogLine(health, { recovered, resolvedAmbiguous, expired, purged }));
  }

  return {
    paused: !enabled,
    maintenanceRan: opts.runMaintenance,
    recovered,
    resolvedAmbiguous,
    expired,
    purged,
    steps,
    halted,
    health,
  };
}

/** The once-a-minute structured health line. Ids/counts/codes only, no PII. */
export function healthLogLine(
  health: SendHealth,
  maintenance: { recovered: number; resolvedAmbiguous: number; expired: number; purged: number },
): Record<string, unknown> {
  return {
    msg: "notification_send_health",
    email_sending_enabled: health.emailSendingEnabled,
    last_heartbeat_at: health.lastHeartbeatAt,
    last_claim_at: health.lastClaimAt,
    pending_total: health.pendingTotal,
    pending_due: health.pendingDue,
    oldest_pending_age_s: health.oldestPendingAgeS,
    deferred_backlog: health.deferredBacklog,
    oldest_deferred_age_s: health.oldestDeferredAgeS,
    sending: health.sendingCount,
    expired_leases: health.expiredLeaseCount,
    l2_busiest_last_hour: health.l2BusiestLastHour,
    l2_utilisation_pct: health.l2UtilisationPct,
    l3_last_hour: health.l3LastHour,
    l3_utilisation_pct: health.l3UtilisationPct,
    l4_last_24h_by_class: health.l4Last24hByClass,
    l4_utilisation_pct_by_class: health.l4UtilisationPctByClass,
    l5_last_second_by_class: health.l5LastSecondByClass,
    l5_utilisation_pct_by_class: health.l5UtilisationPctByClass,
    sent_24h: health.sent24h,
    dead_24h: health.dead24h,
    skipped_24h: health.skipped24h,
    dead_by_code: health.deadByCode,
    skipped_by_code: health.skippedByCode,
    recovered_this_tick: maintenance.recovered,
    resolved_ambiguous_this_tick: maintenance.resolvedAmbiguous,
    expired_this_tick: maintenance.expired,
    purged_this_tick: maintenance.purged,
  };
}
