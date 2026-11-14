/**
 * fake-ses-webhook-provider.ts — a deterministic SES/SNS webhook adapter for
 * tests, and ONLY for tests.
 *
 * Three properties, the same ones the fake payment provider and the fake
 * email sender have for the same reasons:
 *
 * 1. **No network. Ever.** No `fetch`, no socket, no live clock read. The
 *    cert URL and the SubscribeURL never leave the process. SubscribeURL
 *    visits succeed synthetically and record what was visited.
 * 2. **Deterministic.** Signatures are HMAC-SHA256 over the raw bytes with
 *    an injectable shared secret, so a test produces an authentic body
 *    without an RSA key pair, and a replayed byte sequence verifies the
 *    same way on every run.
 * 3. **Obviously not real.** `name` is `"fake_ses"`. The topic ARN scheme is
 *    anything the test chooses. Nothing here can be mistaken for real
 *    AWS reachability.
 *
 * Tests that exercise the REAL signature protocol instantiate
 * SesSnsWebhookProvider with a `fetchCertificate` seam that returns an
 * RSA-SHA256 cert the test produced; this fake is for route tests, where
 * the point is to exercise handler branches, not RSA arithmetic.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  type AuthenticatedSnsEnvelope,
  type ClassifiedSesEvent,
  type EmailWebhookAuthentication,
  type EmailWebhookAuthenticateInput,
  type EmailWebhookProvider,
  type EmailWebhookRejection,
  type SnsEventIdentity,
  type SnsMessageType,
  type SubscriptionConfirmationResult,
} from "./email-webhook-provider.ts";

export interface FakeSesSnsWebhookOptions {
  readonly expectedTopicArn: string;
  /** The HMAC shared secret used to sign test bodies. */
  readonly sharedSecret: string;
  /** Whether confirmSubscription should succeed. Defaults to true. */
  readonly confirmSubscriptionSucceeds?: boolean;
}

const SNS_MESSAGE_TYPES: ReadonlySet<SnsMessageType> = new Set([
  "Notification",
  "SubscriptionConfirmation",
  "UnsubscribeConfirmation",
]);

/**
 * The deterministic fake. See the file header for the three invariants.
 *
 * Signature format (test-only):
 *   header "x-fake-sns-signature" = hex HMAC-SHA256(sharedSecret, rawBody)
 */
export class FakeSesSnsWebhookProvider implements EmailWebhookProvider {
  readonly name = "fake_ses" as const;

  readonly #expectedTopicArn: string;
  readonly #sharedSecret: string;
  readonly #confirmSubscriptionSucceeds: boolean;
  #confirmedSubscriptions: string[] = [];

  constructor(options: FakeSesSnsWebhookOptions) {
    this.#expectedTopicArn = options.expectedTopicArn;
    this.#sharedSecret = options.sharedSecret;
    this.#confirmSubscriptionSucceeds = options.confirmSubscriptionSucceeds ?? true;
  }

  /** URLs the fake was asked to visit, in order. Test introspection. */
  get confirmedSubscriptions(): readonly string[] {
    return [...this.#confirmedSubscriptions];
  }

  /** Produce a deterministic signature a test can place on a body it builds. */
  sign(rawBody: Uint8Array): string {
    return createHmac("sha256", this.#sharedSecret).update(rawBody).digest("hex");
  }

  async authenticate(input: EmailWebhookAuthenticateInput): Promise<EmailWebhookAuthentication> {
    const headers = input.headers ?? {};
    const provided = headerValue(headers, "x-fake-sns-signature");
    if (provided === null) {
      return reject({ reason: "missing_signature" });
    }
    const expected = this.sign(input.rawBody);
    const providedBytes = Buffer.from(provided, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    const matches =
      providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
    if (!matches) return reject({ reason: "bad_signature" });

    // Signature verified. Now parse.
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as Record<string, unknown>;
    } catch (error) {
      return reject({ reason: "unparseable", detail: error instanceof Error ? error.name : "parse_error" });
    }
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      return reject({ reason: "unparseable", detail: "not_an_object" });
    }

    const typeField = stringField(envelope, "Type");
    if (typeField === null) return reject({ reason: "unparseable", detail: "missing_type" });
    if (!SNS_MESSAGE_TYPES.has(typeField as SnsMessageType)) {
      return reject({ reason: "unexpected_message_type", type: typeField });
    }
    const messageType = typeField as SnsMessageType;

    const messageId = stringField(envelope, "MessageId");
    if (messageId === null) return reject({ reason: "missing_event_id" });

    const topicArn = stringField(envelope, "TopicArn");
    if (topicArn === null || topicArn !== this.#expectedTopicArn) {
      return reject({ reason: "unexpected_topic_arn" });
    }

    const identity: SnsEventIdentity = {
      provider: this.name,
      providerEventId: messageId,
      snsTopicArn: topicArn,
    };

    const rawMessage = envelope.Message;
    let sesMessage: unknown | null = null;
    if (typeof rawMessage === "string" && rawMessage.length > 0) {
      try {
        sesMessage = JSON.parse(rawMessage);
      } catch {
        sesMessage = null;
      }
    }

    const subscribeUrl = messageType === "Notification" ? null : stringField(envelope, "SubscribeURL");

    const authEnvelope: AuthenticatedSnsEnvelope = {
      identity,
      type: messageType,
      sesMessage,
      subscribeUrl,
      rawEnvelope: envelope,
    };
    return { outcome: "authentic", envelope: authEnvelope };
  }

  classifyEvent(envelope: AuthenticatedSnsEnvelope): ClassifiedSesEvent {
    // The fake uses the exact same classification as the real adapter — a
    // route test must see the same vocabulary a production run would. We
    // import nothing from the real adapter to keep the fake's dependency
    // graph empty of network code; the implementation below duplicates the
    // classification shape in a few lines.
    return classifySesPayload(envelope.sesMessage);
  }

  async confirmSubscription(subscribeUrl: string): Promise<SubscriptionConfirmationResult> {
    this.#confirmedSubscriptions.push(subscribeUrl);
    if (this.#confirmSubscriptionSucceeds) return { outcome: "confirmed" };
    return { outcome: "rejected", reason: "fake_scripted_rejection" };
  }
}

// ── Fake-local classification (mirrors ses-sns-webhook-provider.ts) ─────────

function classifySesPayload(payload: unknown): ClassifiedSesEvent {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      providerEventType: "unknown",
      normalizedEventType: "other",
      providerMessageId: null,
      feedbackId: null,
      recipientAddresses: [],
      deliveredAt: null,
    };
  }
  const obj = payload as Record<string, unknown>;
  const rawType =
    (typeof obj.eventType === "string" && obj.eventType) ||
    (typeof obj.notificationType === "string" && obj.notificationType) ||
    "unknown";

  const mail = obj.mail as { messageId?: unknown } | undefined;
  const providerMessageId = mail && typeof mail.messageId === "string" && mail.messageId.length > 0 ? mail.messageId : null;

  let normalized: ClassifiedSesEvent["normalizedEventType"] = "other";
  switch (rawType) {
    case "Delivery":
      normalized = "delivery";
      break;
    case "Bounce": {
      const b = obj.bounce as { bounceType?: unknown } | undefined;
      normalized = b?.bounceType === "Permanent" ? "bounce_permanent" : "bounce_transient";
      break;
    }
    case "Complaint":
      normalized = "complaint";
      break;
    case "Reject":
      normalized = "rejection";
      break;
    case "Rendering Failure":
    case "RenderingFailure":
      normalized = "rendering_failure";
      break;
  }

  let feedbackId: string | null = null;
  if (normalized === "bounce_permanent" || normalized === "bounce_transient") {
    const b = obj.bounce as { feedbackId?: unknown } | undefined;
    if (b && typeof b.feedbackId === "string") feedbackId = b.feedbackId;
  } else if (normalized === "complaint") {
    const c = obj.complaint as { feedbackId?: unknown } | undefined;
    if (c && typeof c.feedbackId === "string") feedbackId = c.feedbackId;
  }

  const bucket: unknown =
    normalized === "bounce_permanent" || normalized === "bounce_transient"
      ? (obj.bounce as { bouncedRecipients?: unknown } | undefined)?.bouncedRecipients
      : normalized === "complaint"
      ? (obj.complaint as { complainedRecipients?: unknown } | undefined)?.complainedRecipients
      : normalized === "delivery"
      ? (obj.delivery as { recipients?: unknown } | undefined)?.recipients
      : null;

  const addresses: string[] = [];
  if (Array.isArray(bucket)) {
    for (const entry of bucket) {
      const raw =
        typeof entry === "string"
          ? entry
          : entry !== null && typeof entry === "object" && typeof (entry as { emailAddress?: unknown }).emailAddress === "string"
          ? (entry as { emailAddress: string }).emailAddress
          : null;
      if (raw === null) continue;
      const addr = raw.trim().toLowerCase();
      if (addr.length < 3 || addr.length > 254 || !addr.includes("@")) continue;
      addresses.push(addr);
    }
  }

  let deliveredAt: string | null = null;
  if (normalized === "delivery") {
    const d = obj.delivery as { timestamp?: unknown } | undefined;
    if (d && typeof d.timestamp === "string") deliveredAt = d.timestamp;
  }

  return {
    providerEventType: rawType,
    normalizedEventType: normalized,
    providerMessageId,
    feedbackId,
    recipientAddresses: addresses,
    deliveredAt,
  };
}

function stringField(envelope: Record<string, unknown>, key: string): string | null {
  const raw = envelope[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

function reject(rejection: EmailWebhookRejection): EmailWebhookAuthentication {
  return { outcome: "rejected", rejection };
}
