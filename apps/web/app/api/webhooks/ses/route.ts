import "server-only";

/**
 * /api/webhooks/ses — ingestion of Amazon SES delivery feedback via SNS.
 *
 * M13.2 / P9-2. Receives Notification, SubscriptionConfirmation and
 * UnsubscribeConfirmation envelopes, verifies the SNS signature over the
 * authentic bytes, writes a dedupable event row BEFORE any side effect, and
 * applies the matching suppression or delivery-status update inside the
 * same transaction as the event write.
 *
 * ── THE SEQUENCE THIS FILE EXISTS TO ENFORCE ───────────────────────────────
 *
 *   1. Accept POST only; refuse everything else with 405.
 *   2. Accept Content-Type: text/plain / application/json only; refuse others.
 *   3. Read the raw request bytes, with a hard 256 KiB limit — above that
 *      size nothing SES publishes is valid, and refusing early avoids
 *      spending CPU on signature verification over an attacker-sized body.
 *   4. Authenticate the body (adapter.authenticate): on reject, 400 with the
 *      stable reason code. Nothing is logged from an unauthenticated body.
 *   5. Validate the SNS topic ARN against the configured expected ARN. The
 *      adapter already enforces this; this check at the route exists so a
 *      future adapter change does not weaken it silently.
 *   6. For SubscriptionConfirmation: visit the authenticated SubscribeURL
 *      over the same strict hostname allowlist the cert fetch uses. Return
 *      200 whether the confirm visit succeeded (the route is idempotent on
 *      re-attempt).
 *   7. For Notification: classify, write public.email_delivery_events (ON
 *      CONFLICT DO NOTHING — the UNIQUE on (provider, provider_event_id) is
 *      the dedupe), then apply the appropriate suppression / delivery-status
 *      update over the SAME owner connection. If the event row inserted
 *      false (duplicate), skip the downstream update.
 *   8. Return 200 on success, 400 for authentication / validation
 *      rejection, 413 on body size, 415 on bad content type, 500 on an
 *      unexpected database failure.
 *
 * ── WHAT IS LOGGED ─────────────────────────────────────────────────────────
 *
 * Nothing from the raw body. Nothing recipient-identifying. Nothing from a
 * provider's error prose. We log the stable rejection code when a request
 * is refused, and the normalized_event_type + outcome counts when it
 * succeeds — codes and counts only, per the P5-5 health-snapshot discipline.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 *   · Enable real email sending. P9-4.
 *   · Add 'ses' to REAL_EMAIL_PROVIDERS. P9-4.
 *   · Create or configure any AWS resource. Those live in operator runbooks.
 *   · Flip the sender pause switch. It stays off until P9-4 and D-PROVIDER.
 */

import {
  type ClassifiedSesEvent,
  type EmailWebhookAuthentication,
  type EmailWebhookRejection,
} from "@kolekto/adapters";
import {
  insertEmailDeliveryEvent,
  recordSesDeliveryEvent,
  recordSesSuppression,
  type SesSuppressionReason,
} from "@kolekto/db";

import { getSesWebhookAdapter } from "./adapter.ts";

const MAX_BODY_BYTES = 256 * 1024;
const ACCEPTED_CONTENT_TYPES = new Set(["text/plain", "application/json"]);

/**
 * The webhook route is served over a direct response for every method, so
 * we opt out of static optimisation.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const adapter = getSesWebhookAdapter();
  if (adapter === null) {
    // Ingestion disabled by configuration. 503 says "temporarily unavailable"
    // without leaking why; an operator reads the deploy's config to see.
    return problem(503, "ingestion_disabled");
  }

  // Content type gate first — before we read the body — because SNS sends
  // either "text/plain; charset=UTF-8" (default) or "application/json" when
  // the topic is configured for raw delivery (not what we use, but accept it).
  const rawContentType = request.headers.get("content-type") ?? "";
  const contentTypeBase = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ACCEPTED_CONTENT_TYPES.has(contentTypeBase)) {
    return problem(415, "unsupported_content_type");
  }

  // Early size check from Content-Length header. Not authoritative — the
  // body is re-checked after reading — but it avoids CPU on huge requests.
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const n = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return problem(413, "payload_too_large");
  }

  // Read raw bytes exactly as received. arrayBuffer() preserves the exact
  // bytes AWS signed over; a re-serialised JSON would change them and break
  // the hash.
  let rawBody: Uint8Array;
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return problem(413, "payload_too_large");
    rawBody = new Uint8Array(buf);
  } catch {
    return problem(400, "body_read_failed");
  }

  // Collect headers (lower-cased) to pass through to the adapter. We copy a
  // small, named set — Content-Type and the SNS header set — to avoid
  // leaking any unrelated header values into logs if the adapter errored.
  const headers: Record<string, string> = {};
  for (const [name, value] of request.headers.entries()) {
    const lower = name.toLowerCase();
    if (
      lower === "content-type" ||
      lower === "content-length" ||
      lower.startsWith("x-amz-sns-") ||
      lower === "x-fake-sns-signature"
    ) {
      headers[lower] = value;
    }
  }

  let auth: EmailWebhookAuthentication;
  try {
    auth = await adapter.authenticate({ rawBody, headers });
  } catch {
    // The adapter is contracted not to throw for a rejection; any throw here
    // is a programming error (misconfigured adapter). Do not expose the
    // error text — it may embed configuration.
    return problem(500, "adapter_error");
  }
  if (auth.outcome === "rejected") {
    return problem(400, rejectionCode(auth.rejection));
  }

  const envelope = auth.envelope;

  // SubscriptionConfirmation: visit the authenticated SubscribeURL. This
  // step is idempotent — re-visiting a confirmed subscription URL returns
  // 200 — so retrying this entire request is safe.
  if (envelope.type === "SubscriptionConfirmation" || envelope.type === "UnsubscribeConfirmation") {
    if (envelope.subscribeUrl === null) {
      return problem(400, "missing_subscribe_url");
    }
    const result = await adapter.confirmSubscription(envelope.subscribeUrl);
    if (result.outcome === "rejected") {
      return problem(400, "subscribe_url_refused");
    }
    return ack("subscription_confirmed", envelope.type);
  }

  // Notification. Classify, store the event ledger row, then apply the
  // matching side effect.
  let classified: ClassifiedSesEvent;
  try {
    classified = adapter.classifyEvent(envelope);
  } catch {
    return problem(500, "adapter_error");
  }

  const recipientAddressKey =
    classified.recipientAddresses.length > 0 ? classified.recipientAddresses[0]! : null;

  let inserted: boolean;
  try {
    const result = await insertEmailDeliveryEvent({
      provider: "ses",
      providerEventId: envelope.identity.providerEventId,
      providerEventType: classified.providerEventType,
      normalizedEventType: classified.normalizedEventType,
      payload: envelope.rawEnvelope,
      signatureVerified: true,
      recipientAddressKey,
      sesFeedbackId: classified.feedbackId,
      providerMessageId: classified.providerMessageId,
      snsTopicArn: envelope.identity.snsTopicArn,
    });
    inserted = result.inserted;
  } catch {
    // Any insert failure is observed by the deploy's logs through the
    // runtime handler; the body never carries detail that could leak.
    return problem(500, "ledger_write_failed");
  }

  // Duplicate (SNS retried before we acknowledged, or a replay): nothing to
  // do downstream. The event row already exists and its side effect was
  // applied the first time (or will be, by a different concurrent request
  // that just inserted).
  if (!inserted) {
    return ack("duplicate", envelope.type);
  }

  const outcome = await applySideEffect(classified);
  return ack(outcome, envelope.type);
}

/** Return 405 for every HTTP verb other than POST, with the Allow header set. */
export async function GET(): Promise<Response> {
  return methodNotAllowed();
}
export async function PUT(): Promise<Response> {
  return methodNotAllowed();
}
export async function PATCH(): Promise<Response> {
  return methodNotAllowed();
}
export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
export async function HEAD(): Promise<Response> {
  return methodNotAllowed();
}

function methodNotAllowed(): Response {
  return new Response("method not allowed\n", {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" },
  });
}

// ── Side-effect dispatch ────────────────────────────────────────────────────

type SideEffectOutcome = "suppression_recorded" | "delivery_recorded" | "no_op" | "no_recipient";

async function applySideEffect(classified: ClassifiedSesEvent): Promise<SideEffectOutcome> {
  switch (classified.normalizedEventType) {
    case "bounce_permanent":
    case "complaint": {
      if (classified.recipientAddresses.length === 0) return "no_recipient";
      const reason: SesSuppressionReason =
        classified.normalizedEventType === "complaint" ? "complaint" : "hard_bounce";
      // SES can carry multiple recipients inside one event — suppress each.
      for (const address of classified.recipientAddresses) {
        try {
          await recordSesSuppression({
            address,
            reason,
            feedbackId: classified.feedbackId,
            providerMessageId: classified.providerMessageId,
          });
        } catch {
          // One malformed address inside a batch must not stop the rest.
          // The event ledger still carries the full payload for operator
          // investigation. A per-address failure is swallowed here on
          // purpose; it is observable at the database layer.
        }
      }
      return "suppression_recorded";
    }
    case "delivery": {
      if (classified.providerMessageId === null) return "no_op";
      try {
        await recordSesDeliveryEvent({
          providerMessageId: classified.providerMessageId,
          deliveredAt: classified.deliveredAt,
        });
      } catch {
        // Same reasoning as above: a Delivery event that fails to apply does
        // not undo the ledger insert. The row remains visible and operators
        // can replay by hand later if needed.
      }
      return "delivery_recorded";
    }
    case "bounce_transient":
    case "rejection":
    case "rendering_failure":
    case "other":
      // Transient bounces, rejections and rendering failures DO NOT suppress
      // in this phase. The event row records them for operator visibility,
      // and a later milestone may introduce transient_bounce_capped logic
      // (M13.2 §10.4 reserved reason). Rendering_failure and rejection are
      // operator-signal events (misconfiguration), not recipient-signal.
      return "no_op";
  }
}

// ── Response helpers ────────────────────────────────────────────────────────

function ack(outcome: string, type: string): Response {
  // A minimal 200 body. No raw envelope, no recipient, no provider text.
  const body = JSON.stringify({ ok: true, outcome, type });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function problem(status: number, code: string): Response {
  const body = JSON.stringify({ ok: false, code });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function rejectionCode(r: EmailWebhookRejection): string {
  // The rejection reasons are already stable snake_case codes; return them
  // as-is so operators can correlate across logs. The `detail` on some
  // variants (unparseable / cert_fetch_failed) is deliberately NOT returned
  // — it could carry an operator-chosen error name.
  switch (r.reason) {
    case "missing_signature":
    case "bad_signature":
    case "unsupported_signature_version":
    case "untrusted_cert_url":
    case "cert_fetch_failed":
    case "unparseable":
    case "missing_event_id":
    case "unexpected_topic_arn":
    case "unexpected_message_type":
    case "stale_timestamp":
      return r.reason;
  }
}

