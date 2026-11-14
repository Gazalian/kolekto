/**
 * ses-sns-webhook-provider.ts — the real SES/SNS webhook adapter.
 *
 * M13.2 / P9-2. Verifies SNS message signatures per AWS's documented
 * protocol[1], fetches the signing certificate only over a strict hostname
 * allowlist, and classifies SES notification types into Kolekto's own
 * vocabulary. No AWS SDK: an SDK would pull a provider's whole credential
 * handling into a verification path, and nothing we do here needs anything
 * beyond `fetch` and `node:crypto`.
 *
 * ── WHAT THIS FILE DOES, AND WHAT IT REFUSES TO DO ─────────────────────────
 *
 *   authenticate     verifies the SNS envelope's signature over the fields
 *                    AWS canonicalises, returns a value — never a thrown
 *                    exception — for every rejection reason. The signing
 *                    cert URL MUST sit on `sns.<expected-region>.amazonaws.com`
 *                    (HTTPS, default port, no credentials); any other URL is
 *                    `untrusted_cert_url` and no fetch happens. The cert is
 *                    parsed with `node:crypto.X509Certificate` and the
 *                    signature verified with `crypto.verify`.
 *   classifyEvent    maps SES's own event type (inside the authenticated
 *                    SNS Message field) to Kolekto's vocabulary. An SES
 *                    shape outside the known categories collapses to
 *                    `other`; it is NEVER guessed into a known one. All
 *                    recipient addresses are lower-cased here so correlation
 *                    with the suppression and attempts tables is direct
 *                    equality.
 *   confirmSubscription  visits a SubscriptionConfirmation's SubscribeURL
 *                        over HTTPS, after enforcing the same hostname
 *                        allowlist as the cert URL. The URL inside the
 *                        envelope is authenticated by the signature; this
 *                        step adds the hostname check so a URL on a trusted
 *                        envelope that pointed at an unexpected host is
 *                        still refused.
 *
 * No PII, no credentials, no raw payload text appears in any error message
 * this adapter produces. Rejection reasons are stable, prose-free codes;
 * the one `cert_fetch_failed` carries a trimmed detail so operators can tell
 * a timeout from a 404, and the detail never includes response bodies or
 * header values.
 *
 * ── CERT CACHE ─────────────────────────────────────────────────────────────
 *
 * The signing cert for a given SNS region rotates infrequently. Fetching it
 * on every notification would be a DOS vector (an authentic topic can send a
 * burst, and we'd fetch N times). It is cached in-memory by URL with a bound
 * on entry count and a bound on age; a cache miss triggers one fetch under a
 * short timeout.
 *
 * ── CERT TRUST MODEL (issue #16, M13.2 P9-2.1) ─────────────────────────────
 *
 * AWS's verify-signature guidance says to "check that the certificate is
 * issued by Amazon SNS" and "confirm that the certificate's chain of trust
 * is valid." AWS does NOT publish a stable root CA bundle for SNS signing
 * certs, a stable subject CN, or a stable issuer. Every AWS SDK validator
 * we checked (aws-sns-validator, boto3's internal verifier) stops at the
 * two gates below and does NOT walk an offline X.509 chain. We therefore
 * deliberately refuse to invent a chain walk against unspecified roots.
 * The task's "stop and report" rule applies to that specific sub-check:
 * see docs/product/M13.2-P9-2.1-SES-INGESTION-HARDENING.md §C for the
 * explicit decision record.
 *
 * The adapter's chain of trust is therefore the composition of:
 *
 *   1. HOSTNAME PIN. The SigningCertURL must sit on
 *      `sns.<EMAIL_AWS_REGION>.amazonaws.com[.cn]`, HTTPS, default port,
 *      no credentials, no fragment. No redirects (fetch is called with
 *      `redirect: "error"`).
 *   2. TLS CHAIN AT FETCH. The HTTPS fetch validates the server's own TLS
 *      certificate chain against Node's bundled trust store (default
 *      `fetch` behaviour; we do NOT disable this). Whatever cert that
 *      trusted server serves is then the signing cert for this envelope.
 *   3. VALIDITY WINDOW ON THE SIGNING CERT. We parse the PEM with
 *      `node:crypto.X509Certificate` and refuse the message if the signing
 *      cert's validFrom/validTo bracket does not include `now()`. An
 *      expired, not-yet-valid or date-unparseable cert is `cert_fetch_failed`.
 *   4. SIGNATURE VERIFICATION. The signature is verified with the cert's
 *      public key against the AWS canonical message.
 *
 * ── NO LIVE AWS CALL IS MADE AT MODULE LOAD ────────────────────────────────
 *
 * Nothing fetched or validated at import. The adapter is a plain class that
 * holds options; the first fetch happens on the first notification that
 * clears the hostname check. This matters because the surrounding codebase
 * refuses outbound credentials next to any non-production provider
 * (`packages/config/src/email.ts`), and the ingestion endpoint must be
 * startable in environments that have no AWS reachability (local, CI).
 *
 * [1] https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */

import { createVerify, X509Certificate } from "node:crypto";

import {
  type AuthenticatedSnsEnvelope,
  type ClassifiedSesEvent,
  type EmailWebhookAuthentication,
  type EmailWebhookAuthenticateInput,
  type EmailWebhookProvider,
  type EmailWebhookRejection,
  type SesNormalizedEventType,
  type SnsEventIdentity,
  type SnsMessageType,
  type SubscriptionConfirmationResult,
} from "./email-webhook-provider.ts";

/** Options the ingestion route passes in from validated configuration. */
export interface SesSnsWebhookOptions {
  /** AWS region string (e.g. "eu-west-1"). Lower-case; letters, digits and hyphens only. */
  readonly region: string;
  /** The exact SNS Topic ARN the handler expects. A different ARN inside a signed envelope is still rejected. */
  readonly expectedTopicArn: string;
  /**
   * SNS SignatureVersion values this adapter will accept. The route-side
   * configuration decides whether that is `["2"]` (recommended default,
   * M13.2 P9-2.1 / issue #17) or `["1", "2"]` (operator opt-in for a
   * legacy topic). Must be non-empty; every value must be either "1" or
   * "2". An unexpected set at construction time refuses to start.
   */
  readonly acceptedSignatureVersions: readonly string[];
  /** Injectable network boundary for tests. The default uses `fetch` with a short timeout; nothing else uses the network. */
  readonly fetchCertificate?: (url: string) => Promise<string>;
  /** Injectable GET for the SubscribeURL step. Same reason — testable without a real network. */
  readonly confirmSubscription?: (url: string) => Promise<SubscriptionConfirmationResult>;
  /** How long an envelope may claim to have been produced before we refuse it. Default 15 minutes. */
  readonly maxTimestampSkewMs?: number;
  /** Milliseconds budget for the certificate fetch. Default 3000. */
  readonly certificateFetchTimeoutMs?: number;
  /** Maximum PEM bytes the cert fetch may return. Default 32 KiB — a PEM over this is almost certainly not a signing cert. */
  readonly maxCertificateBytes?: number;
  /** Maximum entries the cert cache may hold. Default 32 — one SNS region has a very small set of cert URLs in flight at a time. */
  readonly certificateCacheMax?: number;
  /** Maximum age of a cached cert PEM. Default 24 hours. */
  readonly certificateCacheMaxAgeMs?: number;
  /** Clock source. Tests only. */
  readonly now?: () => number;
}

const DEFAULT_MAX_SKEW_MS = 15 * 60 * 1000;
const DEFAULT_CERT_TIMEOUT_MS = 3_000;
const DEFAULT_CERT_MAX_BYTES = 32 * 1024;
const DEFAULT_CERT_CACHE_MAX = 32;
const DEFAULT_CERT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The two SignatureVersion values AWS documents today. "1" is RSA-SHA1 (legacy); "2" is RSA-SHA256 (recommended). */
const AWS_KNOWN_SIGNATURE_VERSIONS = new Set(["1", "2"]);

// Letters, digits, hyphens; starts and ends with alphanumeric. Mirrors AWS's own region naming.
const REGION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

// AWS SNS Topic ARN shape, deliberately conservative:
//   arn:aws:sns:<region>:<account-id>:<topic-name>
// The topic-name allows A-Z, a-z, 0-9, hyphen and underscore (SNS's own rule).
const TOPIC_ARN_PATTERN = /^arn:aws(?:-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/;

/** How keys line up in the canonical SNS message, per message type. */
const CANONICAL_KEYS: Readonly<Record<SnsMessageType, readonly string[]>> = {
  // Alphabetical order is the SNS rule. Subject is optional on Notification.
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

interface CachedCertificate {
  readonly pem: string;
  readonly fetchedAt: number;
}

/**
 * The real adapter. One instance per worker process is fine; the cert cache
 * is local to the instance.
 */
export class SesSnsWebhookProvider implements EmailWebhookProvider {
  readonly name = "ses" as const;

  readonly #region: string;
  readonly #expectedTopicArn: string;
  readonly #acceptedSignatureVersions: ReadonlySet<string>;
  readonly #fetchCertificate: (url: string) => Promise<string>;
  readonly #confirmSubscription: (url: string) => Promise<SubscriptionConfirmationResult>;
  readonly #maxTimestampSkewMs: number;
  readonly #certificateFetchTimeoutMs: number;
  readonly #maxCertificateBytes: number;
  readonly #certificateCacheMax: number;
  readonly #certificateCacheMaxAgeMs: number;
  readonly #now: () => number;
  readonly #certCache = new Map<string, CachedCertificate>();

  constructor(options: SesSnsWebhookOptions) {
    if (!REGION_PATTERN.test(options.region)) {
      throw new Error(`SesSnsWebhookProvider: region ${JSON.stringify(options.region)} is not a valid AWS region string`);
    }
    if (!TOPIC_ARN_PATTERN.test(options.expectedTopicArn)) {
      throw new Error("SesSnsWebhookProvider: expectedTopicArn is not a well-formed AWS SNS Topic ARN");
    }
    // Cross-check: the ARN's region segment must match the configured region.
    const arnRegion = options.expectedTopicArn.split(":")[3];
    if (arnRegion !== options.region) {
      throw new Error("SesSnsWebhookProvider: expectedTopicArn region does not match configured region");
    }
    if (options.acceptedSignatureVersions.length === 0) {
      throw new Error("SesSnsWebhookProvider: acceptedSignatureVersions must not be empty");
    }
    for (const v of options.acceptedSignatureVersions) {
      if (!AWS_KNOWN_SIGNATURE_VERSIONS.has(v)) {
        throw new Error(`SesSnsWebhookProvider: acceptedSignatureVersions contains ${JSON.stringify(v)} which is not an AWS-published SignatureVersion`);
      }
    }
    this.#region = options.region;
    this.#expectedTopicArn = options.expectedTopicArn;
    this.#acceptedSignatureVersions = new Set(options.acceptedSignatureVersions);
    this.#maxTimestampSkewMs = options.maxTimestampSkewMs ?? DEFAULT_MAX_SKEW_MS;
    this.#certificateFetchTimeoutMs = options.certificateFetchTimeoutMs ?? DEFAULT_CERT_TIMEOUT_MS;
    this.#maxCertificateBytes = options.maxCertificateBytes ?? DEFAULT_CERT_MAX_BYTES;
    this.#certificateCacheMax = options.certificateCacheMax ?? DEFAULT_CERT_CACHE_MAX;
    this.#certificateCacheMaxAgeMs = options.certificateCacheMaxAgeMs ?? DEFAULT_CERT_CACHE_MAX_AGE_MS;
    this.#now = options.now ?? Date.now;
    this.#fetchCertificate = options.fetchCertificate ?? ((url) => defaultFetchCertificate(url, this.#certificateFetchTimeoutMs, this.#maxCertificateBytes));
    this.#confirmSubscription = options.confirmSubscription ?? ((url) => defaultConfirmSubscription(url, this.#certificateFetchTimeoutMs));
  }

  async authenticate(input: EmailWebhookAuthenticateInput): Promise<EmailWebhookAuthentication> {
    // 1. Parse the raw body. Must happen BEFORE signature check so we can
    //    see which SignatureVersion / SigningCertURL to use — but every
    //    field we read is validated against SNS's documented shape, and
    //    nothing is logged or trusted until the signature verifies below.
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
    if (typeField !== "Notification" && typeField !== "SubscriptionConfirmation" && typeField !== "UnsubscribeConfirmation") {
      return reject({ reason: "unexpected_message_type", type: typeField });
    }
    const messageType = typeField;

    const signature = stringField(envelope, "Signature");
    if (signature === null) return reject({ reason: "missing_signature" });

    const signatureVersion = stringField(envelope, "SignatureVersion");
    if (signatureVersion === null || !this.#acceptedSignatureVersions.has(signatureVersion)) {
      return reject({ reason: "unsupported_signature_version", version: signatureVersion ?? "" });
    }

    const signingCertUrl = stringField(envelope, "SigningCertURL");
    if (signingCertUrl === null || !this.#isTrustedSnsUrl(signingCertUrl)) {
      return reject({ reason: "untrusted_cert_url" });
    }

    const messageId = stringField(envelope, "MessageId");
    if (messageId === null) return reject({ reason: "missing_event_id" });

    const topicArn = stringField(envelope, "TopicArn");
    if (topicArn === null || topicArn !== this.#expectedTopicArn) {
      return reject({ reason: "unexpected_topic_arn" });
    }

    const timestamp = stringField(envelope, "Timestamp");
    if (timestamp === null) return reject({ reason: "unparseable", detail: "missing_timestamp" });
    const parsedTs = Date.parse(timestamp);
    if (Number.isNaN(parsedTs)) return reject({ reason: "unparseable", detail: "bad_timestamp" });
    const skewMs = Math.abs(this.#now() - parsedTs);
    if (skewMs > this.#maxTimestampSkewMs) {
      return reject({ reason: "stale_timestamp", skewSeconds: Math.floor(skewMs / 1000) });
    }

    const canonicalKeys = CANONICAL_KEYS[messageType];
    const canonicalString = canonicalise(envelope, canonicalKeys);
    if (canonicalString === null) {
      return reject({ reason: "unparseable", detail: "missing_signed_field" });
    }

    // Fetch (or reuse) the signing cert. Hostname was validated above.
    let pem: string;
    try {
      pem = await this.#getCertificate(signingCertUrl);
    } catch (error) {
      return reject({ reason: "cert_fetch_failed", detail: error instanceof Error ? error.name : "fetch_error" });
    }

    // Parse the cert and verify.
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch (error) {
      return reject({ reason: "cert_fetch_failed", detail: error instanceof Error ? error.name : "bad_cert" });
    }

    // Validity window. A cert outside its validity dates is an invalid chain
    // of trust regardless of HTTPS-at-fetch — AWS could serve one by mistake,
    // or we could pull a stale cached entry whose issuer rotated. On Node 22
    // X509Certificate exposes validFrom/validTo as strings; we parse them with
    // the standard Date constructor.
    const nowMs = this.#now();
    const notBefore = Date.parse(cert.validFrom);
    const notAfter = Date.parse(cert.validTo);
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
      return reject({ reason: "cert_fetch_failed", detail: "cert_dates_unparseable" });
    }
    if (nowMs < notBefore) {
      // Clock skew — our clock is behind the cert's validFrom. The cert may
      // be legitimate; refusing is still correct because the signature would
      // be computed by a cert the verifier should not yet trust.
      return reject({ reason: "cert_fetch_failed", detail: "cert_not_yet_valid" });
    }
    if (nowMs > notAfter) {
      return reject({ reason: "cert_fetch_failed", detail: "cert_expired" });
    }

    const algorithm = signatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256";
    const verifier = createVerify(algorithm);
    verifier.update(canonicalString, "utf8");
    verifier.end();

    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(signature, "base64");
    } catch {
      return reject({ reason: "bad_signature" });
    }

    const matches = verifier.verify(cert.publicKey, signatureBytes);
    if (!matches) return reject({ reason: "bad_signature" });

    // Signature verified. Now the envelope is believable.
    const identity: SnsEventIdentity = {
      provider: this.name,
      providerEventId: messageId,
      snsTopicArn: topicArn,
    };

    // Parse the SNS Message field (SES puts a JSON string there). Not
    // required for signature verification; required for classification.
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

    // If SubscribeURL exists but points at an unexpected host, that's still
    // a reject — a signed envelope should never carry one, but if a future
    // SNS feature changed the shape we would never follow a URL whose host
    // we don't trust.
    if (subscribeUrl !== null && !this.#isTrustedSnsUrl(subscribeUrl)) {
      return reject({ reason: "untrusted_cert_url" });
    }

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
    return classifySesPayload(envelope.sesMessage);
  }

  async confirmSubscription(subscribeUrl: string): Promise<SubscriptionConfirmationResult> {
    if (!this.#isTrustedSnsUrl(subscribeUrl)) {
      return { outcome: "rejected", reason: "untrusted_url" };
    }
    return this.#confirmSubscription(subscribeUrl);
  }

  #isTrustedSnsUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (parsed.port !== "" && parsed.port !== "443") return false;
    const expectedHost = `sns.${this.#region}.amazonaws.com`;
    const expectedHostCn = `sns.${this.#region}.amazonaws.com.cn`;
    const host = parsed.hostname.toLowerCase();
    if (host !== expectedHost && host !== expectedHostCn) return false;
    // The cert URL ends in .pem; the SubscribeURL is a long query-string URL.
    // We refuse hash fragments on either (never present in AWS's own URLs).
    if (parsed.hash !== "") return false;
    return true;
  }

  async #getCertificate(url: string): Promise<string> {
    const cached = this.#certCache.get(url);
    const now = this.#now();
    if (cached && now - cached.fetchedAt < this.#certificateCacheMaxAgeMs) {
      return cached.pem;
    }
    const pem = await this.#fetchCertificate(url);
    if (!pem.includes("BEGIN CERTIFICATE")) {
      throw new Error("invalid_pem");
    }
    // Evict the oldest entry when at capacity. A tiny map; Map preserves
    // insertion order so the first key is the oldest.
    if (!this.#certCache.has(url) && this.#certCache.size >= this.#certificateCacheMax) {
      const firstKey = this.#certCache.keys().next().value;
      if (firstKey !== undefined) this.#certCache.delete(firstKey);
    }
    this.#certCache.set(url, { pem, fetchedAt: now });
    return pem;
  }
}

// ── Canonicalisation ────────────────────────────────────────────────────────

function canonicalise(envelope: Record<string, unknown>, keys: readonly string[]): string | null {
  let out = "";
  for (const key of keys) {
    const raw = envelope[key];
    // Optional field (Subject on Notification). Skip when absent.
    if (raw === undefined || raw === null) {
      if (key === "Subject") continue;
      return null;
    }
    if (typeof raw !== "string") return null;
    out += key + "\n" + raw + "\n";
  }
  return out;
}

// ── SES classification ──────────────────────────────────────────────────────

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

  // SES supports two event-note formats. Both have an identifying field:
  //   · "eventType": the newer Event Publishing format (e.g. "Delivery", "Bounce").
  //   · "notificationType": the older Feedback Notification format.
  // We accept either; the vocabulary is the same across the two formats.
  const rawType =
    (typeof obj.eventType === "string" && obj.eventType) ||
    (typeof obj.notificationType === "string" && obj.notificationType) ||
    "unknown";

  const providerMessageId = extractProviderMessageId(obj);
  const normalized = normaliseEventType(rawType, obj);
  const feedbackId = extractFeedbackId(obj, normalized);
  const recipientAddresses = extractRecipientAddresses(obj, normalized);
  const deliveredAt = extractDeliveredAt(obj, normalized);

  return {
    providerEventType: rawType,
    normalizedEventType: normalized,
    providerMessageId,
    feedbackId,
    recipientAddresses,
    deliveredAt,
  };
}

function normaliseEventType(raw: string, obj: Record<string, unknown>): SesNormalizedEventType {
  switch (raw) {
    case "Delivery":
      return "delivery";
    case "Bounce": {
      const bounce = obj.bounce as { bounceType?: unknown } | undefined;
      // SES documents three top-level bounceType values: "Permanent",
      // "Transient", "Undetermined". We treat Undetermined as transient
      // because treating it as permanent would suppress a mailbox that may
      // still be deliverable.
      return bounce?.bounceType === "Permanent" ? "bounce_permanent" : "bounce_transient";
    }
    case "Complaint":
      return "complaint";
    case "Reject":
      return "rejection";
    case "Rendering Failure":
    case "RenderingFailure":
      return "rendering_failure";
    default:
      return "other";
  }
}

function extractProviderMessageId(obj: Record<string, unknown>): string | null {
  // SES's Event Publishing format puts the identifier under "mail.messageId".
  // The older Feedback Notification format also uses "mail.messageId", so one
  // path covers both.
  const mail = obj.mail as { messageId?: unknown } | undefined;
  if (mail && typeof mail.messageId === "string" && mail.messageId.length > 0) return mail.messageId;
  return null;
}

function extractFeedbackId(obj: Record<string, unknown>, normalized: SesNormalizedEventType): string | null {
  if (normalized === "bounce_permanent" || normalized === "bounce_transient") {
    const bounce = obj.bounce as { feedbackId?: unknown } | undefined;
    if (bounce && typeof bounce.feedbackId === "string" && bounce.feedbackId.length > 0) return bounce.feedbackId;
  }
  if (normalized === "complaint") {
    const complaint = obj.complaint as { feedbackId?: unknown } | undefined;
    if (complaint && typeof complaint.feedbackId === "string" && complaint.feedbackId.length > 0) return complaint.feedbackId;
  }
  return null;
}

function extractRecipientAddresses(obj: Record<string, unknown>, normalized: SesNormalizedEventType): readonly string[] {
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
      // Delivery.recipients is a flat string[]; bounce/complaint buckets are
      // arrays of { emailAddress }.
      const raw =
        typeof entry === "string"
          ? entry
          : entry !== null && typeof entry === "object" && typeof (entry as { emailAddress?: unknown }).emailAddress === "string"
          ? (entry as { emailAddress: string }).emailAddress
          : null;
      if (raw === null) continue;
      const normalisedAddr = raw.trim().toLowerCase();
      if (normalisedAddr.length === 0 || normalisedAddr.length > 254) continue;
      // Same conservative single-mailbox check the sender uses.
      if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalisedAddr)) {
        continue;
      }
      addresses.push(normalisedAddr);
    }
  }
  return addresses;
}

function extractDeliveredAt(obj: Record<string, unknown>, normalized: SesNormalizedEventType): string | null {
  if (normalized !== "delivery") return null;
  const delivery = obj.delivery as { timestamp?: unknown } | undefined;
  if (delivery && typeof delivery.timestamp === "string" && delivery.timestamp.length > 0) return delivery.timestamp;
  return null;
}

// ── Field helpers ───────────────────────────────────────────────────────────

function stringField(envelope: Record<string, unknown>, key: string): string | null {
  const raw = envelope[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function reject(rejection: EmailWebhookRejection): EmailWebhookAuthentication {
  return { outcome: "rejected", rejection };
}

// ── Default network boundary ────────────────────────────────────────────────

async function defaultFetchCertificate(url: string, timeoutMs: number, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/x-pem-file, text/plain" },
    });
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number.parseInt(contentLength, 10) > maxBytes) {
      throw new Error("cert_too_large");
    }
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error("cert_too_large");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultConfirmSubscription(url: string, timeoutMs: number): Promise<SubscriptionConfirmationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", redirect: "error", signal: controller.signal });
    if (!response.ok) {
      return { outcome: "rejected", reason: `http_${response.status}` };
    }
    return { outcome: "confirmed" };
  } catch (error) {
    return { outcome: "rejected", reason: error instanceof Error ? error.name : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
