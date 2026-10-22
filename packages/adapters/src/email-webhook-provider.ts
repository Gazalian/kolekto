/**
 * email-webhook-provider.ts — the seam for inbound email-delivery feedback.
 *
 * M13.2 / P9-2. docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md
 * §9.3 (webhook idempotency), §10.4 (delivered status, previously reserved
 * for webhooks), §13 (D-SUPPRESS).
 *
 * ── STATUS: ONE IMPLEMENTATION (SES/SNS) + ONE DETERMINISTIC FAKE ──────────
 *
 * This milestone adds the receiving half of the delivery-feedback loop. It
 * does NOT enable real email sending — that is P9-4 (register the SES
 * sending adapter) and is gated separately on the pause switch and provider
 * registration. Nothing in this file imports an AWS SDK; the only outbound
 * HTTP call made by any implementation here is the signing-certificate fetch
 * during SNS signature verification, which goes through a strict allowlist
 * and a short timeout.
 *
 * ── THE RULE THIS INTERFACE EXISTS TO ENFORCE ──────────────────────────────
 *
 * **A webhook is a TRIGGER TO BELIEVE, not evidence on its own.** Authenticate
 * the raw bytes first; parse them second; apply any side effect third. Every
 * failure in that sequence is a VALUE returned by this interface, never a
 * thrown exception, because a public endpoint rejects a wrongly signed body
 * as part of its normal operation and an exception invites a catch that
 * treats it as a server error.
 *
 * The signature is checked against the body as received. Nothing is
 * re-serialised, re-parsed into a canonical form, or trusted before the
 * check passes. Nothing is logged from an unauthenticated body — a forged
 * payload must not reach any sink that persists it as fact (same philosophy
 * as the payment-provider seam, which never trusts an identity before the
 * signature establishes it).
 *
 * ── UNCERTAINTY IS PART OF THE CONTRACT ────────────────────────────────────
 *
 * `classifyEvent` returns a Kolekto vocabulary for the event type, but an
 * SES/SNS shape outside the known categories collapses to `other` rather
 * than being thrown away or guessed into one of the known ones. The route
 * then records the row (so the event ledger has it) but applies no side
 * effect. This is the "unrecognised_status" discipline the payment seam
 * uses for provider statuses — misclassifying as success is worse than
 * recording an outcome whose meaning is open.
 */

/** Which webhook provider. 'fake_ses' is the deterministic test adapter. */
export type EmailWebhookProviderName = "ses" | "fake_ses";

/** The SNS envelope shapes we accept. UnsubscribeConfirmation is accepted but logged, never auto-visited. */
export type SnsMessageType =
  | "Notification"
  | "SubscriptionConfirmation"
  | "UnsubscribeConfirmation";

/**
 * The event vocabulary Kolekto branches on. Append-only: once shipped, a
 * value is never renamed or reused, because every row in
 * public.email_delivery_events stores one of these.
 */
export type SesNormalizedEventType =
  | "delivery"
  | "bounce_permanent"
  | "bounce_transient"
  | "complaint"
  | "rejection"
  | "rendering_failure"
  /** An authenticated SES/SNS event whose type does not map onto one of the above. Stored; no side effect fires. */
  | "other";

/**
 * The provider's event identity, established by signature verification.
 * Returned BEFORE anything downstream reads the payload.
 */
export interface SnsEventIdentity {
  readonly provider: EmailWebhookProviderName;
  /** The SNS MessageId. THIS is the webhook idempotency key — public.email_delivery_events uses it as the UNIQUE row id. */
  readonly providerEventId: string;
  /** The SNS Topic ARN as named inside the authenticated envelope. The route refuses any value that is not the configured expected ARN. */
  readonly snsTopicArn: string;
}

/** Why a webhook body was rejected. A rejected body is never stored and never produces a side effect. */
export type EmailWebhookRejection =
  | { readonly reason: "missing_signature" }
  | { readonly reason: "bad_signature" }
  | { readonly reason: "unsupported_signature_version"; readonly version: string }
  | { readonly reason: "untrusted_cert_url" }
  | { readonly reason: "cert_fetch_failed"; readonly detail: string }
  | { readonly reason: "unparseable"; readonly detail: string }
  | { readonly reason: "missing_event_id" }
  | { readonly reason: "unexpected_topic_arn" }
  | { readonly reason: "unexpected_message_type"; readonly type: string }
  | { readonly reason: "stale_timestamp"; readonly skewSeconds: number };

/**
 * An SNS envelope whose signature has verified. Contains only what downstream
 * code needs; the raw bytes travel through `rawEnvelope` for ledger storage.
 */
export interface AuthenticatedSnsEnvelope {
  readonly identity: SnsEventIdentity;
  readonly type: SnsMessageType;
  /** The SNS Message field, parsed from JSON when it looked like JSON. Null otherwise. */
  readonly sesMessage: unknown | null;
  /** Only populated for SubscriptionConfirmation / UnsubscribeConfirmation. */
  readonly subscribeUrl: string | null;
  /** The authenticated envelope as parsed from the raw body. Carried for storage, never for business decisions. */
  readonly rawEnvelope: Readonly<Record<string, unknown>>;
}

export type EmailWebhookAuthentication =
  | { readonly outcome: "authentic"; readonly envelope: AuthenticatedSnsEnvelope }
  | { readonly outcome: "rejected"; readonly rejection: EmailWebhookRejection };

/**
 * The classified event the route acts on. All recipient addresses are
 * lower-cased here so correlation with the suppression and attempts tables
 * is a direct equality.
 */
export interface ClassifiedSesEvent {
  /** The provider's own event type verbatim (e.g. "Delivery", "Bounce"). */
  readonly providerEventType: string;
  readonly normalizedEventType: SesNormalizedEventType;
  /** The SES Message-Id the event is reporting on. Null when the event has none (e.g. a Reject may lack one). */
  readonly providerMessageId: string | null;
  /** The SES feedbackId. Null when the SES shape does not carry one. */
  readonly feedbackId: string | null;
  /** Lower-cased recipient addresses the event concerns. Empty for events with none. */
  readonly recipientAddresses: readonly string[];
  /** The SES-reported delivery timestamp (ISO 8601), or null when the event does not carry one. */
  readonly deliveredAt: string | null;
}

/** Result of visiting a SubscriptionConfirmation's SubscribeURL. Never thrown — a public handler expects both. */
export type SubscriptionConfirmationResult =
  | { readonly outcome: "confirmed" }
  | { readonly outcome: "rejected"; readonly reason: string };

export interface EmailWebhookAuthenticateInput {
  readonly rawBody: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The seam. Every inbound SES/SNS call in Kolekto goes through an
 * implementation of this. The real adapter (ses-sns-webhook-provider.ts)
 * fetches the signing certificate on first sight and caches it; the fake
 * (fake-ses-webhook-provider.ts) implements the whole protocol over an
 * injectable HMAC so tests exercise real signing arithmetic.
 */
export interface EmailWebhookProvider {
  readonly name: EmailWebhookProviderName;

  /**
   * Verify a webhook body's signature against the bytes as received, return
   * the authenticated envelope on success and a rejection with a stable
   * reason on failure. Never throws for an expected rejection — those are
   * values. Thrown errors are reserved for *programming* mistakes (adapter
   * misconfiguration).
   */
  authenticate(input: EmailWebhookAuthenticateInput): Promise<EmailWebhookAuthentication>;

  /**
   * Map an authenticated envelope's SES payload to Kolekto's vocabulary.
   * Pure: no I/O. Must only be called with an envelope that
   * `authenticate` returned as `authentic`.
   */
  classifyEvent(envelope: AuthenticatedSnsEnvelope): ClassifiedSesEvent;

  /**
   * Visit a SubscriptionConfirmation's SubscribeURL safely. The URL has
   * already been authenticated by `authenticate`; this call also enforces
   * the same hostname allowlist and HTTPS the signing-cert fetch does, so
   * a URL inside an authentic payload that points at anything other than
   * the configured SNS region is refused.
   */
  confirmSubscription(subscribeUrl: string): Promise<SubscriptionConfirmationResult>;
}

/**
 * The seam exists to prove *at the type level* that no email webhook caller
 * can bypass authentication: a `ClassifiedSesEvent` is only reachable through
 * `classifyEvent`, which only accepts an `AuthenticatedSnsEnvelope`, which is
 * only returned by `authenticate` on the `authentic` branch.
 */
