/**
 * notification-payment.ts — payment lifecycle events → the payer's email.
 *
 * Plan §4.7 step 8 ("contributor receipt via the outbox, dedupe key
 * receipt:<…>"). The payment functions write an audit row for each step the
 * payer should hear about; the notification trigger queues it; this module
 * turns it into one notification event and ONE email delivery to the address
 * the payer typed for that payment:
 *
 *   payment.initialized  — "you started a payment" (checkout reached Paystack)
 *   payment.captured     — the receipt
 *   payment.needs_review — "we received it; the organiser is checking it"
 *   payment.failed       — "this payment was not completed"
 *
 * All four are ESSENTIAL (communication-policy.ts): a transaction message
 * about the recipient's own payment, never a reminder. No in-app delivery:
 * a payer usually has no account, and the payment belongs to the payer, not
 * to a member inbox.
 *
 * What goes into the event payload: names, slugs, the reference, amounts as
 * digit strings, the payer's name. NEVER the address (the database strips
 * contact keys anyway): the address lives only on the delivery row, as for
 * every other email.
 *
 * The facts come from app.payment_notification_context — one SECURITY
 * DEFINER read, because the least-privilege worker role reads no payment
 * table. Feature-detected: without the function or the grant the event is
 * still recorded and no email row is written (the same degradation as
 * member announcements), so a worker deployed before the grant keeps working.
 */

import type postgres from "postgres";

import { isValidEmailAddress } from "@kolekto/adapters";

import type { EmailOutcome } from "./notification-eligibility.ts";
import { eventKey, redactEmails, type AuditMessage, type Payload } from "./notification-rules.ts";

type Db = postgres.Sql<Record<string, never>> | postgres.TransactionSql<Record<string, never>>;

export const PAYMENT_ACTIONS = [
  "payment.initialized",
  "payment.captured",
  "payment.needs_review",
  "payment.failed",
] as const;
export type PaymentAction = (typeof PAYMENT_ACTIONS)[number];

export function isPaymentAction(action: string): action is PaymentAction {
  return (PAYMENT_ACTIONS as readonly string[]).includes(action);
}

/** One email per payment and kind. The key format is the delivery table's (`^[a-z][a-z_]{2,40}:[A-Za-z0-9-]{1,100}$`). */
const DEDUPE_PREFIX: Readonly<Record<PaymentAction, string>> = Object.freeze({
  "payment.initialized": "payment_started",
  "payment.captured": "receipt",
  "payment.needs_review": "payment_review",
  "payment.failed": "payment_failed",
});

export function paymentDedupeKey(action: PaymentAction, attemptId: string): string {
  return `${DEDUPE_PREFIX[action]}:${attemptId}`;
}

/** The row app.payment_notification_context returns. bigint columns arrive as strings. */
export interface PaymentContextRow {
  readonly attempt_id: string;
  readonly community_id: string;
  readonly community_name: string | null;
  readonly community_slug: string | null;
  readonly collection_name: string | null;
  readonly collection_slug: string | null;
  readonly reference: string;
  readonly status: string;
  readonly contributor_name: string | null;
  readonly contributor_email: string | null;
  readonly amount_kobo: string;
  readonly contribution_kobo: string;
  readonly platform_fee_kobo: string;
  readonly gateway_fee_kobo: string;
  readonly vat_kobo: string;
  readonly total_fees_kobo: string;
  readonly fee_bearer: string;
  readonly paid_at: Date | string | null;
  readonly channel: string | null;
  readonly failure_code: string | null;
  readonly review_reason: string | null;
  readonly provider: string | null;
  readonly provider_access_code: string | null;
}

const PAYSTACK_CHECKOUT_BASE = "https://checkout.paystack.com/";

function paystackCheckoutUrl(provider: string | null, accessCode: string | null): string | null {
  if (provider !== "paystack" || !accessCode || !/^[A-Za-z0-9_-]{4,80}$/.test(accessCode)) return null;
  return `${PAYSTACK_CHECKOUT_BASE}${accessCode}`;
}

function clamp(value: string | null | undefined, max: number): string | null {
  return typeof value === "string" ? redactEmails(value).slice(0, max) : null;
}

function digits(value: string | number | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return /^\d{1,18}$/.test(s) ? s : null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The event payload for a payment email. A fixed key set; no address, no
 * phone, no internal id other than the community's. `failure_kind` is a
 * coarse word, never the provider's message.
 */
export function buildPaymentPayload(action: PaymentAction, msg: AuditMessage, ctx: PaymentContextRow): Payload {
  const payload: Payload = {
    actor_name: clamp(msg.actor_name, 120) ?? "",
    community_id: msg.community_id,
    community_name: clamp(ctx.community_name, 120),
    community_slug: clamp(ctx.community_slug, 80),
    collection_name: clamp(ctx.collection_name, 160),
    collection_slug: clamp(ctx.collection_slug, 80),
    payment_reference: /^KLK-[0-9A-HJKMNP-TV-Z]{26}$/.test(ctx.reference) ? ctx.reference : null,
    payer_name: clamp(ctx.contributor_name, 120),
    amount_kobo: digits(ctx.amount_kobo),
    contribution_kobo: digits(ctx.contribution_kobo),
    total_fees_kobo: digits(ctx.total_fees_kobo),
    fee_bearer: ctx.fee_bearer === "contributor_pays" || ctx.fee_bearer === "community_absorbs" ? ctx.fee_bearer : null,
  };
  if (action === "payment.captured") {
    payload["platform_fee_kobo"] = digits(ctx.platform_fee_kobo);
    payload["gateway_fee_kobo"] = digits(ctx.gateway_fee_kobo);
    payload["vat_kobo"] = digits(ctx.vat_kobo);
    payload["paid_at"] = iso(ctx.paid_at);
    payload["channel"] = ctx.channel !== null && /^[a-z_]{2,30}$/.test(ctx.channel) ? ctx.channel : null;
  }
  if (action === "payment.failed") {
    payload["failure_kind"] = ctx.failure_code === "provider_abandoned" || ctx.status === "expired" ? "not_completed" : "declined";
  }
  if (action === "payment.initialized") {
    payload["checkout_url"] = paystackCheckoutUrl(ctx.provider, ctx.provider_access_code);
  }
  return payload;
}

/** Whether app.payment_notification_context is installed and this connection may run it. */
async function contextAvailable(sql: Db): Promise<boolean> {
  const [row] = await sql<{ ok: boolean | null }[]>`
    select coalesce(has_function_privilege(
      to_regprocedure('app.payment_notification_context(uuid)'), 'execute'), false) as ok
  `;
  return row?.ok === true;
}

export type PaymentProcessResult =
  | { readonly kind: "processed"; readonly email: EmailOutcome }
  | { readonly kind: "attempt_unavailable" };

/**
 * Record the event and the payer's email delivery. Runs inside the caller's
 * transaction; idempotent on the event key and on the delivery dedupe key, so
 * a redelivered message writes nothing new.
 */
export async function processPaymentEvent(tx: Db, msg: AuditMessage, action: PaymentAction): Promise<PaymentProcessResult> {
  if (msg.object_type !== "payment_attempt") return { kind: "attempt_unavailable" };

  const available = await contextAvailable(tx);
  let ctx: PaymentContextRow | undefined;
  if (available) {
    [ctx] = await tx<PaymentContextRow[]>`
      select attempt_id, community_id, community_name, community_slug, collection_name, collection_slug,
             reference, status, contributor_name, contributor_email,
             amount_kobo::text as amount_kobo, contribution_kobo::text as contribution_kobo,
             platform_fee_kobo::text as platform_fee_kobo, gateway_fee_kobo::text as gateway_fee_kobo,
             vat_kobo::text as vat_kobo, total_fees_kobo::text as total_fees_kobo,
             fee_bearer, paid_at, channel, failure_code, review_reason,
             provider, provider_access_code
      from app.payment_notification_context(${msg.object_id}::uuid)
    `;
    if (!ctx || ctx.community_id !== msg.community_id) return { kind: "attempt_unavailable" };
  }

  // Without the context the event is still recorded (names only from the
  // message), so the trail is complete once the grant lands; no email row.
  const payload: Payload = ctx
    ? buildPaymentPayload(action, msg, ctx)
    : { actor_name: clamp(msg.actor_name, 120) ?? "", community_id: msg.community_id };
  const key = eventKey(action, msg.object_id, msg.audit_log_id);

  await tx`
    insert into public.notification_events (
      community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload
    ) values (
      ${msg.community_id}::uuid, ${action}, ${key}, ${msg.actor_type}::public.audit_actor_type,
      ${msg.actor_user_id}::uuid, ${msg.object_type}, ${msg.object_id}::uuid, ${tx.json(payload)}
    )
    on conflict (event_key) do nothing
  `;
  const [event] = await tx<{ id: string }[]>`select id from public.notification_events where event_key = ${key}`;
  if (!event) return { kind: "processed", email: { kind: "no_row" } };
  if (!ctx) return { kind: "processed", email: { kind: "no_row" } };

  const address = (ctx.contributor_email ?? "").trim();
  if (!isValidEmailAddress(address)) {
    await tx`
      insert into public.notification_deliveries (
        notification_event_id, community_id, channel, status, error_code, send_class, communication_category
      ) values (
        ${event.id}::uuid, ${msg.community_id}::uuid, 'email', 'skipped', 'invalid_recipient_address',
        'transactional', 'essential'
      )
      on conflict do nothing
    `;
    return { kind: "processed", email: { kind: "skipped", reason: "invalid_recipient_address" } };
  }

  // The address the payer typed for this payment: unverified, but it is
  // where they asked for their receipt (owner decision 2026-11-11).
  await tx`
    insert into public.notification_deliveries (
      notification_event_id, community_id, recipient_address, recipient_address_assurance,
      channel, status, dedupe_key, send_class, communication_category
    ) values (
      ${event.id}::uuid, ${msg.community_id}::uuid, ${address}, 'unverified_supplied',
      'email', 'pending', ${paymentDedupeKey(action, ctx.attempt_id)}, 'transactional', 'essential'
    )
    on conflict do nothing
  `;
  return { kind: "processed", email: { kind: "pending" } };
}
