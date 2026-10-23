/**
 * webhook-events.ts — typed callers for the SES/SNS ingestion entry points.
 *
 * Companion to migration 20261023120000 (M13.2 P9-2). Every function here
 * runs on the owner connection (no role switch) because the operator-only
 * `app.*` functions check `current_setting('role', true)` is empty. The
 * ONLY caller is the webhook route handler (apps/web/app/api/webhooks/ses).
 * No call site that acts on behalf of a user should import this file —
 * those go through `withCallerContext`.
 *
 * Nothing here parses, validates or classifies an event: that is the
 * adapter's job. These helpers accept already-validated primitives (an
 * authenticated event id, a classified recipient address, a known reason)
 * and hand them to the database, nothing more.
 */

import type { TransactionSql } from "postgres";

import { runWrite, withOwnerConnection } from "./client.ts";

/** The reason codes app.record_ses_suppression accepts. The database refuses anything else. */
export type SesSuppressionReason = "hard_bounce" | "complaint";

/** The vocabulary stored on public.email_delivery_events.normalized_event_type. */
export type SesNormalizedEventType =
  | "delivery"
  | "bounce_permanent"
  | "bounce_transient"
  | "complaint"
  | "rejection"
  | "rendering_failure"
  | "other";

export interface RecordSesNotificationInput {
  readonly provider: "ses";
  readonly providerEventId: string;
  readonly providerEventType: string;
  readonly normalizedEventType: SesNormalizedEventType;
  readonly payload: unknown;
  readonly signatureVerified: boolean;
  readonly recipientAddressKey: string | null;
  readonly sesFeedbackId: string | null;
  readonly providerMessageId: string | null;
  readonly snsTopicArn: string | null;
}

export interface RecordSesNotificationResult {
  /** The ledger row id. Stable across retries of the same (provider, provider_event_id). */
  readonly eventId: string;
  /** True when this call inserted a new row; false when a prior call already created the row (SNS redelivery or in-process concurrency). */
  readonly inserted: boolean;
  /** True when the existing row has already been marked `succeeded`. The route uses this to short-circuit duplicate deliveries without re-applying side effects. */
  readonly previouslySucceeded: boolean;
  /** How many times the route has attempted the side effect so far. Zero on insert; the counter advances inside the mark-{succeeded,failed} calls. */
  readonly processingAttempts: number;
}

/**
 * Insert the authenticated Notification row, OR return the existing row's
 * identity and processing state so the route can decide whether to retry
 * the side effect (M13.2 P9-2.1).
 *
 * Replaces the earlier `insertEmailDeliveryEvent` helper: the old helper
 * returned only `inserted` and left the "has the side effect run?" question
 * to the application layer, which in practice meant a swallowed exception
 * acknowledged a notification that had never actually been actioned. This
 * helper always surfaces the two facts the route needs to decide: did we
 * insert, and has the row already been marked succeeded?
 *
 * Idempotent on (provider, provider_event_id): a replayed SNS Notification
 * conflicts on the unique index and returns `inserted: false` with the
 * existing row's state.
 */
export async function recordSesNotification(
  input: RecordSesNotificationInput,
): Promise<RecordSesNotificationResult> {
  return runWrite(() =>
    withOwnerConnection(async (tx) => {
      const payloadJson = JSON.stringify(input.payload);
      const rows = await tx<
        {
          event_id: string;
          inserted: boolean;
          previously_succeeded: boolean;
          processing_attempts: number | string;
        }[]
      >`
        select *
        from app.record_ses_notification(
          ${input.providerEventId},
          ${input.providerEventType},
          ${input.normalizedEventType},
          ${payloadJson}::jsonb,
          ${input.signatureVerified},
          ${input.recipientAddressKey},
          ${input.sesFeedbackId},
          ${input.providerMessageId},
          ${input.snsTopicArn}
        )
      `;
      const row = rows[0]!;
      const attempts =
        typeof row.processing_attempts === "number"
          ? row.processing_attempts
          : Number.parseInt(row.processing_attempts, 10);
      return {
        eventId: row.event_id,
        inserted: row.inserted,
        previouslySucceeded: row.previously_succeeded,
        processingAttempts: Number.isFinite(attempts) ? attempts : 0,
      };
    }),
  );
}

/**
 * Mark a notification's ledger row as `succeeded`. Idempotent — a second
 * call for a row already in `succeeded` is a no-op. Returns the number of
 * rows updated (0 or 1).
 */
export async function markSesNotificationSucceeded(eventId: string): Promise<number> {
  const updated = await runWrite(() =>
    withOwnerConnection(async (tx) => {
      const rows = await tx<{ updated: string | number }[]>`
        select app.mark_ses_notification_succeeded(${eventId}::uuid) as updated
      `;
      const raw = rows[0]?.updated ?? 0;
      return typeof raw === "number" ? raw : Number.parseInt(raw, 10);
    }),
  );
  return Number.isFinite(updated) ? updated : 0;
}

/**
 * Mark a notification's ledger row as `failed` with a stable snake_case
 * error_code. Never downgrades a `succeeded` row.
 */
export async function markSesNotificationFailed(input: {
  readonly eventId: string;
  readonly errorCode: string;
}): Promise<number> {
  const updated = await runWrite(() =>
    withOwnerConnection(async (tx) => {
      const rows = await tx<{ updated: string | number }[]>`
        select app.mark_ses_notification_failed(${input.eventId}::uuid, ${input.errorCode}) as updated
      `;
      const raw = rows[0]?.updated ?? 0;
      return typeof raw === "number" ? raw : Number.parseInt(raw, 10);
    }),
  );
  return Number.isFinite(updated) ? updated : 0;
}

/**
 * Record a permanent suppression originating from an authenticated SES
 * Bounce/Complaint event. Delegates to app.record_ses_suppression, which
 * refuses anything other than hard_bounce / complaint and then calls
 * app.set_email_suppression with source = 'ses_event'.
 */
export async function recordSesSuppression(input: {
  readonly address: string;
  readonly reason: SesSuppressionReason;
  readonly feedbackId: string | null;
  readonly providerMessageId: string | null;
}): Promise<void> {
  await runWrite(() =>
    withOwnerConnection(async (tx) => {
      await tx`
        select app.record_ses_suppression(
          ${input.address},
          ${input.reason},
          ${input.feedbackId},
          ${input.providerMessageId}
        )
      `;
    }),
  );
}

/**
 * Transition a notification_deliveries row from `sent` to `delivered`.
 * Returns the number of rows updated (0 or 1). A 0 is NOT an error — the
 * row may have already moved to another terminal state and the Delivery
 * event is dropped on the floor intentionally.
 */
export async function recordSesDeliveryEvent(input: {
  readonly providerMessageId: string;
  readonly deliveredAt: string | null;
}): Promise<number> {
  const updated = await runWrite(() =>
    withOwnerConnection(async (tx: TransactionSql) => {
      const rows = await tx<{ updated: string | number }[]>`
        select app.record_ses_delivery_event(
          ${input.providerMessageId},
          ${input.deliveredAt}::timestamptz
        ) as updated
      `;
      const raw = rows[0]?.updated ?? 0;
      return typeof raw === "number" ? raw : Number.parseInt(raw, 10);
    }),
  );
  return Number.isFinite(updated) ? updated : 0;
}
