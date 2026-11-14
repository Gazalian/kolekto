/**
 * notification-backoff.ts — retry schedule and failure classification (M13.2 P5).
 *
 * Pure and deterministic: a clock (`nowMs`) and a jitter source (`rng`) are
 * injected, so every decision is reproducible from its inputs and testable
 * offline. Nothing here touches the database or a provider; it only turns an
 * EmailProviderError plus the attempt number into the resolve action the sender
 * then applies through app.resolve_notification_claim.
 *
 * The rules are the decision record's §10.6.2:
 *   · Permanent failure → dead with that code. Never retried, however many
 *     attempts remain.
 *   · Transient failure → retry with bounded backoff while attempts remain;
 *     the attempt-cap failure is dead / retries_exhausted.
 *   · Ambiguous outcome (the provider may have accepted the message):
 *       - provider WITH idempotency → retry as a transient failure; the same
 *         idempotency key (the delivery id) is reused, so the provider
 *         de-duplicates. At the cap it is dead / retries_exhausted.
 *       - provider WITHOUT idempotency → dead / outcome_unknown, never retried.
 *         Reporting a possibly-delivered message as unresolved beats risking a
 *         second copy (Q-DUP).
 *   · adapter_misconfigured → halt. The startup guards make it unreachable in
 *     practice; if it happens the sender stops rather than consuming
 *     deliveries, and the claimed row's lease simply expires and is recovered.
 *
 * Backoff (§10.6.2): after attempt 1 wait 5 minutes, after attempt 2 wait 30
 * minutes, each with ±20 % jitter so a mass failure does not retry in lockstep.
 * A 3rd attempt never schedules a 4th.
 */

import { EmailProviderError, type EmailErrorCode, type EmailIdempotency } from "@kolekto/adapters";

/** Base delay before the next attempt, keyed by the attempt that just failed. */
export const RETRY_BACKOFF_MS: Readonly<Record<number, number>> = Object.freeze({
  1: 5 * 60_000,
  2: 30 * 60_000,
});

/** ±20 % jitter, per the decision record. */
export const BACKOFF_JITTER = 0.2;

/** A jitter source returning a value in [0, 1). `Math.random` in production. */
export type Rng = () => number;

/**
 * Jittered delay in ms before retrying after `attemptCount`. Defined only for
 * attempts that can be retried (1 and 2); a 3rd failure is terminal and never
 * asks for a delay.
 */
export function backoffDelayMs(attemptCount: number, rng: Rng): number {
  const base = RETRY_BACKOFF_MS[attemptCount];
  if (base === undefined) {
    throw new Error(`no backoff schedule for attempt ${attemptCount}; only attempts 1 and 2 retry`);
  }
  // rng() in [0,1) → factor in [1 - jitter, 1 + jitter).
  const factor = 1 + (rng() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(base * factor);
}

/** The next-retry timestamp (ISO 8601) for a retryable attempt. */
export function nextRetryAt(attemptCount: number, nowMs: number, rng: Rng): string {
  return new Date(nowMs + backoffDelayMs(attemptCount, rng)).toISOString();
}

/** Stable terminal codes the sender synthesises (not provider codes). */
export type SenderDeadCode = "retries_exhausted" | "outcome_unknown";

/** What the sender should do with a failed attempt. */
export type ResolveAction =
  | { readonly kind: "dead"; readonly errorCode: EmailErrorCode | SenderDeadCode }
  | { readonly kind: "retry"; readonly errorCode: EmailErrorCode; readonly nextRetryAt: string }
  | { readonly kind: "halt"; readonly errorCode: EmailErrorCode };

/**
 * Classify a provider failure into a resolve action. `attemptCount` is the
 * attempt that just failed (the value the claim reserved, 1..max). The same
 * delivery id is always reused as the idempotency key, so a retry against a
 * provider with idempotency is de-duplicated by the provider.
 */
export function classifyFailure(
  error: EmailProviderError,
  attemptCount: number,
  maxAttempts: number,
  providerIdempotency: EmailIdempotency,
  nowMs: number,
  rng: Rng,
): ResolveAction {
  // Defensive: the startup guards keep this from the provider path at all.
  if (error.code === "adapter_misconfigured") {
    return { kind: "halt", errorCode: error.code };
  }

  // Permanent: one call, then dead. Never retried.
  if (error.kind === "permanent") {
    return { kind: "dead", errorCode: error.code };
  }

  // Ambiguous against a provider that cannot de-duplicate: never retry, report
  // the message as unresolved rather than risk a second copy.
  if (error.ambiguous && providerIdempotency === "none") {
    return { kind: "dead", errorCode: "outcome_unknown" };
  }

  // Ordinary transient, or ambiguous against a provider WITH idempotency: retry
  // while attempts remain, otherwise the cap failure is terminal.
  if (attemptCount < maxAttempts) {
    return { kind: "retry", errorCode: error.code, nextRetryAt: nextRetryAt(attemptCount, nowMs, rng) };
  }
  return { kind: "dead", errorCode: "retries_exhausted" };
}
