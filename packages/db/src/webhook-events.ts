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

export interface InsertEmailDeliveryEventInput {
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

export interface InsertEmailDeliveryEventResult {
  /** True when this call inserted a new row; false when the (provider, provider_event_id) conflict silently absorbed a duplicate. */
  readonly inserted: boolean;
}

/**
 * Insert a single authenticated event row. Idempotent on
 * (provider, provider_event_id): a repeated event conflicts on the unique
 * index and this function returns `inserted: false` without changing side
 * effects. The route uses that flag to skip the suppression / delivery
 * updates on duplicates (which would otherwise be no-ops anyway, but
 * reasserting "no side effect on duplicate" at the route layer is cheaper
 * than relying on each downstream call to be idempotent).
 */
export async function insertEmailDeliveryEvent(
  input: InsertEmailDeliveryEventInput,
): Promise<InsertEmailDeliveryEventResult> {
  return runWrite(() =>
    withOwnerConnection(async (tx) => {
      const payloadJson = JSON.stringify(input.payload);
      const rows = await tx<{ id: string }[]>`
        insert into public.email_delivery_events (
          provider,
          provider_event_id,
          provider_event_type,
          normalized_event_type,
          payload,
          signature_verified,
          recipient_address_key,
          ses_feedback_id,
          provider_message_id,
          sns_topic_arn
        ) values (
          ${input.provider},
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
        on conflict (provider, provider_event_id) do nothing
        returning id
      `;
      return { inserted: rows.length === 1 };
    }),
  );
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
