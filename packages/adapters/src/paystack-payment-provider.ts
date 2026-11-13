/**
 * paystack-payment-provider.ts — the real `PaymentProvider` for Paystack.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ───────────────────────────────────
 *
 * This is the ONLY place in Kolekto that may speak Paystack's HTTP (ADR 0001,
 * ADR 0002, invariant 4). It implements the `PaymentProvider` seam defined in
 * `payment-provider.ts`; nothing in `@kolekto/domain`, `@kolekto/db`,
 * `apps/web` or `apps/worker` may import `api.paystack.co` or interpret a
 * field of Paystack's JSON. Those packages see Kolekto-owned types only.
 *
 * It implements initialize, verify, dual-header webhook verification (the new
 * `Paystack-Signature` HMAC-SHA512 over `t.body` with a 300-second replay
 * window and rotation-safe v1 handling, plus a fallback for the legacy
 * `x-paystack-signature` while a secret-key signature is still delivered)
 * and webhook-subject parsing. It does NOT implement transfers, refunds or
 * settlements — those land as separate adapters when their respective
 * subsystems are built (see M8.10+ in the roadmap).
 *
 * ── UNCERTAINTY IS A VALUE, NEVER AN EXCEPTION ──────────────────────────────
 *
 * `payment-provider.ts` is clear on this: every outcome that leaves Kolekto
 * not knowing what happened is a `ProviderResult` variant, not a thrown
 * error. A timeout is not a failure (D-27); a 5xx is not a failure; a parse
 * error on a response is not a failure. Each becomes `unknown` with
 * `safeToRetry` set correctly. A `refused` is the provider answering with a
 * recognisable error (a 4xx carrying a `status:false` body). An `ok` means
 * the provider answered and the answer parsed cleanly into Kolekto's types.
 *
 * ── WHAT IS LOGGED ──────────────────────────────────────────────────────────
 *
 * Nothing. No request bodies, no response bodies, no reference values, no
 * header values, no secrets, no customer email. The raw response payload is
 * returned up the stack through `ProviderTransaction.rawPayload`, where it
 * is written only to the deny-all `provider_transactions.payload` column
 * (SEC-12). The adapter itself does not use `console.*`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { kobo, type Kobo } from "@kolekto/domain";

import type {
  PaymentInitialization,
  PaymentInitializationRequest,
  PaymentProvider,
  ProviderEventIdentity,
  ProviderEventSubject,
  ProviderPaymentStatus,
  ProviderResult,
  ProviderTransaction,
  WebhookAuthentication,
} from "./payment-provider.ts";

// ── Config ──────────────────────────────────────────────────────────────────

export interface PaystackConfig {
  /**
   * Paystack API secret key (`sk_test_…` or `sk_live_…`). Used as the Bearer
   * token on `api.paystack.co` and, when `legacyWebhookFallback` is on, as
   * the HMAC key for the legacy `x-paystack-signature` header.
   *
   * Never logged. Never returned from this adapter. Server-only.
   */
  readonly secretKey: string;
  /**
   * `whsec_…`, generated on Paystack's dashboard for the webhook. Used as
   * the HMAC key for the modern `Paystack-Signature` header (PA-01). A
   * distinct secret from `secretKey` so the signing authority is rotatable
   * independently of the API key.
   */
  readonly webhookSecret: string;
  /** Default `https://api.paystack.co`. Overridable for sandbox mocks and tests. */
  readonly apiBase?: string;
  /** Per-request timeout in ms. Default 15_000. */
  readonly requestTimeoutMs?: number;
  /**
   * While Paystack still delivers the legacy `x-paystack-signature`
   * alongside `Paystack-Signature` (the dashboard turns the legacy one off
   * when the modern one is confirmed), accept it as a fallback. Set to
   * `false` once the modern header has been confirmed on delivered events
   * — doing so narrows the signing surface.
   */
  readonly legacyWebhookFallback?: boolean;
}

const DEFAULT_API_BASE = "https://api.paystack.co";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Paystack's documented replay window for `Paystack-Signature`. */
const SIGNATURE_WINDOW_SECONDS = 300;

// ── Loader ──────────────────────────────────────────────────────────────────

/**
 * Build a config from `process.env`, or return null when any required var is
 * missing or blank. Lives here (inside `packages/adapters`) so `apps/web`
 * never names `PAYSTACK_SECRET_KEY` as a string — invariant 4 forbids it
 * outside this package, and that invariant exists because the previous
 * estate had five call sites across three runtimes (ADR 0002).
 */
export function tryLoadPaystackConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PaystackConfig | null {
  const secretKey = env["PAYSTACK_SECRET_KEY"]?.trim();
  const webhookSecret = env["PAYSTACK_WEBHOOK_SECRET"]?.trim();
  if (!secretKey || !webhookSecret) return null;

  // A copy of the publishable key in the secret slot was the previous
  // system's single most dangerous misconfiguration. Paystack's live secret
  // keys start with `sk_`; refuse anything else so a `pk_` paste is caught
  // at startup rather than on the first checkout.
  if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("sk_live_")) {
    throw new Error(
      "PAYSTACK_SECRET_KEY does not look like a Paystack secret key (expected a sk_test_ or sk_live_ prefix).",
    );
  }
  if (!webhookSecret.startsWith("whsec_")) {
    throw new Error("PAYSTACK_WEBHOOK_SECRET does not look like a Paystack webhook signing secret (expected whsec_).");
  }

  const apiBase = env["PAYSTACK_API_BASE"]?.trim();
  const legacyFallbackRaw = env["PAYSTACK_LEGACY_WEBHOOK_FALLBACK"]?.trim().toLowerCase();
  const legacyWebhookFallback = legacyFallbackRaw === undefined ? true : legacyFallbackRaw === "true";

  return {
    secretKey,
    webhookSecret,
    ...(apiBase ? { apiBase } : {}),
    legacyWebhookFallback,
  };
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/**
 * The Paystack adapter.
 *
 * Stateless beyond its configuration — every request is a one-shot `fetch`
 * with a per-request `AbortController`. The adapter owns nothing about the
 * lifecycle of a payment; that is `payment_attempts` plus the orchestrator.
 */
export class PaystackPaymentProvider implements PaymentProvider {
  readonly name = "paystack" as const;

  readonly #config: Required<Omit<PaystackConfig, "legacyWebhookFallback">> & {
    readonly legacyWebhookFallback: boolean;
  };

  constructor(config: PaystackConfig) {
    if (config.secretKey.trim() === "") {
      throw new Error("PaystackPaymentProvider needs a secret key.");
    }
    if (config.webhookSecret.trim() === "") {
      throw new Error("PaystackPaymentProvider needs a webhook signing secret.");
    }
    this.#config = {
      secretKey: config.secretKey,
      webhookSecret: config.webhookSecret,
      apiBase: config.apiBase ?? DEFAULT_API_BASE,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      legacyWebhookFallback: config.legacyWebhookFallback ?? true,
    };
  }

  // ── initialize ────────────────────────────────────────────────────────────

  async initialize(
    request: PaymentInitializationRequest,
  ): Promise<ProviderResult<PaymentInitialization>> {
    // Paystack's initialize is idempotent on `reference` — a repeat init with
    // the same reference returns the same checkout rather than a second
    // charge — which is exactly the contract the orchestrator relies on.
    const body = {
      email: request.contributorEmail ?? "receipt-not-required@kolekto.app",
      amount: String(request.amount), // kobo, as a string so the bigint survives JSON
      currency: request.currency,
      reference: request.reference,
      callback_url: request.callbackUrl,
      metadata: request.metadata,
      ...(request.subaccountCode !== null ? { subaccount: request.subaccountCode } : {}),
    };

    const response = await this.#request(
      "POST",
      "/transaction/initialize",
      body,
      // An init timeout is DANGEROUS: a checkout may have been created at
      // the provider, so the caller must not retry blindly with the same
      // reference (that's `safeToRetry: false`, handled by `#request`).
      { safeToRetryOnTimeout: false },
    );
    if (response.outcome !== "ok") return response;

    const parsed = parseInitializationBody(response.value.body);
    if (parsed === null) {
      // The HTTP call succeeded but the shape is not what we expect. Treat
      // as `unknown` with no safe retry: a checkout may exist.
      return {
        outcome: "unknown",
        reason: "paystack_initialize_response_unparseable",
        safeToRetry: false,
      };
    }

    // Paystack is expected to echo our reference. If it doesn't, something
    // is very wrong — route it as unknown rather than ok, because
    // downstream code relies on reference equality.
    if (parsed.reference !== request.reference) {
      return {
        outcome: "unknown",
        reason: "paystack_initialize_echoed_wrong_reference",
        safeToRetry: false,
      };
    }

    return {
      outcome: "ok",
      value: {
        provider: this.name,
        reference: parsed.reference,
        checkoutUrl: parsed.checkoutUrl,
        providerAccessCode: parsed.accessCode,
      },
    };
  }

  // ── verify ────────────────────────────────────────────────────────────────

  async verify(reference: string): Promise<ProviderResult<ProviderTransaction>> {
    const response = await this.#request(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
      null,
      // A verify is a READ. Retrying it cannot move money, so a timeout on
      // verify is `safeToRetry: true` — unlike a transfer or an init.
      { safeToRetryOnTimeout: true },
    );

    // Paystack returns 404 { status:false, message:"Transaction not found" }
    // for an unknown reference. That is a `not_found`, not a refusal.
    if (response.outcome === "refused" && response.providerCode === "transaction_not_found") {
      return { outcome: "not_found" };
    }
    if (response.outcome !== "ok") return response;

    const tx = parseVerifyBody(response.value.body, reference);
    if (tx === null) {
      return {
        outcome: "unknown",
        reason: "paystack_verify_response_unparseable",
        safeToRetry: true,
      };
    }
    return { outcome: "ok", value: tx };
  }

  // ── webhook ───────────────────────────────────────────────────────────────

  authenticateWebhook(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): WebhookAuthentication {
    // Prefer the modern signature. The scheme is
    //   Paystack-Signature: t=<unix>,v1=<kid>:<hex>[,v1=<kid>:<hex>…]
    // where <hex> = hex(HMAC_SHA512(whsec, `${t}.${rawBody}`)), compared in
    // constant time against EVERY v1 to tolerate signing-key rotation. The
    // timestamp is validated against a 300-second window (both directions),
    // which is Paystack's documented replay guard.
    const modern = headerValue(headers, "paystack-signature");
    if (modern !== null) {
      return this.#authenticateModernSignature(rawBody, modern);
    }
    // Fall back to the legacy header only while config permits — Paystack
    // keeps delivering it until the dashboard confirms the modern header on
    // delivered events, after which operators flip
    // PAYSTACK_LEGACY_WEBHOOK_FALLBACK=false.
    if (this.#config.legacyWebhookFallback) {
      const legacy = headerValue(headers, "x-paystack-signature");
      if (legacy !== null) {
        return this.#authenticateLegacySignature(rawBody, legacy);
      }
    }
    return { outcome: "rejected", rejection: { reason: "missing_signature" } };
  }

  parseWebhookSubject(rawBody: Uint8Array): ProviderEventSubject {
    const parsed = tryParseJson(rawBody);
    if (parsed === null) return { kind: "unsupported", providerEventType: "unparseable" };
    const body = parsed as {
      event?: unknown;
      data?: { reference?: unknown; transfer_code?: unknown };
    };
    const eventType = typeof body.event === "string" ? body.event : "unknown";
    if (eventType.startsWith("charge.") && typeof body.data?.reference === "string") {
      return { kind: "transaction", providerReference: body.data.reference };
    }
    if (eventType.startsWith("transfer.") && typeof body.data?.transfer_code === "string") {
      return { kind: "transfer", transferReference: body.data.transfer_code };
    }
    return { kind: "unsupported", providerEventType: eventType };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #authenticateModernSignature(rawBody: Uint8Array, header: string): WebhookAuthentication {
    // Format: `t=<unix>,v1=<kid>:<hex>[,v1=<kid>:<hex>…]`. Anything
    // malformed is a `bad_signature`, not an exception — the route is
    // public, so a thrown error here would be a rejection routed through
    // the 500 path by mistake.
    const parts = header.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    let timestampRaw: string | null = null;
    const v1Hexes: string[] = [];
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq <= 0) return { outcome: "rejected", rejection: { reason: "bad_signature" } };
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (name === "t") timestampRaw = value;
      else if (name === "v1") {
        // `v1=<kid>:<hex>`; the kid is advisory (rotation hint), and the
        // hex alone is what we verify against. Accept bare `v1=<hex>` too.
        const colon = value.indexOf(":");
        v1Hexes.push(colon >= 0 ? value.slice(colon + 1) : value);
      }
      // Unknown fields (e.g. v2 in a future scheme) are ignored, never
      // rejected: Paystack may add fields, and refusing on a strict schema
      // would turn an additive protocol change into an outage.
    }
    if (timestampRaw === null || v1Hexes.length === 0) {
      return { outcome: "rejected", rejection: { reason: "bad_signature" } };
    }
    const t = Number.parseInt(timestampRaw, 10);
    if (!Number.isFinite(t)) {
      return { outcome: "rejected", rejection: { reason: "bad_signature" } };
    }
    // ±300 seconds. This covers clock drift on either side; outside this,
    // a forwarded or stored body is refused regardless of HMAC validity.
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - t) > SIGNATURE_WINDOW_SECONDS) {
      return { outcome: "rejected", rejection: { reason: "bad_signature" } };
    }
    // The signed message is `${t}.${rawBody}`. Build the HMAC input as a
    // single Buffer so no intermediate string conversion changes the bytes
    // that Paystack signed.
    const prefix = Buffer.from(`${timestampRaw}.`, "utf8");
    const bodyBuf = Buffer.from(rawBody);
    const hmac = createHmac("sha512", this.#config.webhookSecret);
    hmac.update(prefix);
    hmac.update(bodyBuf);
    const expectedHex = hmac.digest("hex");
    const expectedBytes = Buffer.from(expectedHex, "utf8");

    const matched = v1Hexes.some((candidate) => safeEqual(candidate, expectedBytes));
    if (!matched) return { outcome: "rejected", rejection: { reason: "bad_signature" } };

    return this.#finaliseAuthentic(rawBody);
  }

  #authenticateLegacySignature(rawBody: Uint8Array, header: string): WebhookAuthentication {
    const expectedHex = createHmac("sha512", this.#config.secretKey)
      .update(Buffer.from(rawBody))
      .digest("hex");
    const expectedBytes = Buffer.from(expectedHex, "utf8");
    if (!safeEqual(header, expectedBytes)) {
      return { outcome: "rejected", rejection: { reason: "bad_signature" } };
    }
    return this.#finaliseAuthentic(rawBody);
  }

  #finaliseAuthentic(rawBody: Uint8Array): WebhookAuthentication {
    const parsed = tryParseJson(rawBody);
    if (parsed === null) {
      return {
        outcome: "rejected",
        rejection: { reason: "unparseable", detail: "body is not valid JSON" },
      };
    }
    const identity = identityFrom(parsed);
    if (identity === null) {
      return { outcome: "rejected", rejection: { reason: "missing_event_id" } };
    }
    return { outcome: "authentic", identity };
  }

  /**
   * One HTTP call to Paystack, with a per-request abort timeout. Every
   * outcome Paystack can produce — a network error, a 5xx, a 4xx with a
   * recognised body, a 2xx — maps to a `ProviderResult` variant here, so
   * callers never see an exception.
   */
  async #request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: { safeToRetryOnTimeout: boolean },
  ): Promise<ProviderResult<{ body: unknown; status: number }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);
    const url = `${this.#config.apiBase}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#config.secretKey}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      // AbortError (timeout) and any transport failure both read as unknown:
      // Kolekto does not know what Paystack did.
      const name = error instanceof Error ? error.name : "";
      const reason =
        name === "AbortError"
          ? "paystack_request_timeout"
          : `paystack_transport_error:${name || "unknown"}`;
      return { outcome: "unknown", reason, safeToRetry: options.safeToRetryOnTimeout };
    } finally {
      clearTimeout(timer);
    }

    // Any 5xx is unknown: the server may or may not have acted. For a POST
    // init this is `safeToRetry: false`; for a GET verify it is true. The
    // caller decided that via `safeToRetryOnTimeout`.
    if (response.status >= 500 && response.status < 600) {
      return {
        outcome: "unknown",
        reason: `paystack_http_${response.status}`,
        safeToRetry: options.safeToRetryOnTimeout,
      };
    }

    // Parse the body. A non-JSON 2xx is unknown with safe retry false for
    // init (identity not confirmed), true for verify.
    const bodyText = await safeReadText(response);
    const parsed = bodyText === null ? null : tryParseJsonFromString(bodyText);

    if (response.status >= 200 && response.status < 300) {
      if (parsed === null) {
        return {
          outcome: "unknown",
          reason: "paystack_2xx_body_unparseable",
          safeToRetry: options.safeToRetryOnTimeout,
        };
      }
      // Paystack's 2xx responses carry `{ status: true, data: {...} }`. A
      // 2xx with `status:false` is a refusal: the API answered and said no.
      const envelope = parsed as { status?: unknown; data?: unknown; message?: unknown };
      if (envelope.status === false) {
        return {
          outcome: "refused",
          providerCode: null,
          message: typeof envelope.message === "string" ? envelope.message : "paystack_refused",
        };
      }
      return { outcome: "ok", value: { body: envelope.data ?? envelope, status: response.status } };
    }

    // 4xx: Paystack returns `{ status:false, message, code? }`. Map it to
    // `refused` with the stable code where we have one.
    const envelope =
      parsed === null ? null : (parsed as { status?: unknown; message?: unknown; code?: unknown });
    const message = typeof envelope?.message === "string" ? envelope.message : null;
    const code = extractRefusalCode(response.status, message, envelope?.code);
    return {
      outcome: "refused",
      providerCode: code,
      message: message ?? `paystack_http_${response.status}`,
    };
  }
}

/** Construct the adapter. Named so `grep createPaymentProvider` finds only the real seam. */
export function createPaystackPaymentProvider(config: PaystackConfig): PaystackPaymentProvider {
  return new PaystackPaymentProvider(config);
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/** `data` shape of a successful `/transaction/initialize` response. */
function parseInitializationBody(
  body: unknown,
): { reference: string; checkoutUrl: string; accessCode: string | null } | null {
  if (!isRecord(body)) return null;
  const reference = typeof body["reference"] === "string" ? body["reference"] : null;
  const checkoutUrl =
    typeof body["authorization_url"] === "string" ? body["authorization_url"] : null;
  const accessCode = typeof body["access_code"] === "string" ? body["access_code"] : null;
  if (reference === null || checkoutUrl === null) return null;
  return { reference, checkoutUrl, accessCode };
}

/**
 * `data` shape of a successful `/transaction/verify/:reference` response.
 *
 * Paystack's status vocabulary for a verify:
 *   success    → succeeded
 *   failed     → failed
 *   abandoned  → abandoned
 *   ongoing | processing | queued | pending → pending (the money is still in flight)
 *   reversed   → unrecognised (needs_review in Kolekto's capture function)
 *   anything else → unrecognised
 */
function parseVerifyBody(body: unknown, expectedReference: string): ProviderTransaction | null {
  if (!isRecord(body)) return null;
  const reference = typeof body["reference"] === "string" ? body["reference"] : null;
  if (reference === null) return null;
  // The provider may echo a different reference under certain race
  // conditions; downstream code compares by field, so surface it rather
  // than overriding it with ours.
  const providerReference = reference;
  const rawStatus = typeof body["status"] === "string" ? body["status"] : null;
  if (rawStatus === null) return null;

  const status = mapPaystackStatus(rawStatus);
  const amountRaw = body["amount"];
  const amountKobo = typeof amountRaw === "number" ? toBigInt(amountRaw) : typeof amountRaw === "string" ? toBigInt(amountRaw) : null;
  if (amountKobo === null) return null;

  const currency = typeof body["currency"] === "string" ? body["currency"] : "NGN";
  const feesRaw = body["fees"];
  const providerFee =
    feesRaw === null || feesRaw === undefined
      ? null
      : typeof feesRaw === "number"
        ? kobo(toBigInt(feesRaw) ?? 0n)
        : typeof feesRaw === "string"
          ? kobo(toBigInt(feesRaw) ?? 0n)
          : null;

  const paidAtRaw = body["paid_at"];
  const paidAt =
    typeof paidAtRaw === "string" && paidAtRaw.trim() !== "" ? safeParseDate(paidAtRaw) : null;
  const createdAtRaw = body["created_at"] ?? body["createdAt"];
  const createdAt =
    typeof createdAtRaw === "string" && createdAtRaw.trim() !== ""
      ? (safeParseDate(createdAtRaw) ?? new Date(0))
      : new Date(0);

  const channel = typeof body["channel"] === "string" ? body["channel"] : null;

  // Paystack's `authorization` block carries a reusable charge token. Only
  // its SHA-256 is ever stored (O-12), which the orchestrator does — we
  // pass through the raw reference so one place computes the hash.
  const authBlock = isRecord(body["authorization"]) ? (body["authorization"] as Record<string, unknown>) : null;
  const authorizationReference =
    authBlock && typeof authBlock["authorization_code"] === "string"
      ? (authBlock["authorization_code"] as string)
      : null;

  void expectedReference; // retained for callers that want to assert; kept out of the type to keep mapping pure

  return {
    provider: "paystack",
    providerTransactionId: body["id"] !== undefined && body["id"] !== null ? String(body["id"]) : providerReference,
    providerReference,
    status,
    providerStatusRaw: rawStatus,
    amount: kobo(amountKobo),
    currency,
    providerFee,
    paidAt,
    createdAt,
    channel,
    authorizationReference,
    // Verbatim payload for evidence. Written only to the deny-all column.
    rawPayload: body,
  };
}

function mapPaystackStatus(raw: string): ProviderPaymentStatus {
  switch (raw.toLowerCase()) {
    case "success":
      return "succeeded";
    case "failed":
      return "failed";
    case "abandoned":
      return "abandoned";
    case "ongoing":
    case "processing":
    case "queued":
    case "pending":
      return "pending";
    // `reversed` (and anything the provider adds later) becomes
    // `unrecognised` here; the DB capture function maps that to
    // `needs_review` so a human looks at money rather than code deciding.
    default:
      return "unrecognised";
  }
}

// ── Webhook helpers ─────────────────────────────────────────────────────────

function identityFrom(parsed: unknown): ProviderEventIdentity | null {
  if (!isRecord(parsed)) return null;
  const id =
    typeof parsed["id"] === "string"
      ? parsed["id"]
      : typeof parsed["id"] === "number"
        ? String(parsed["id"])
        : null;
  if (id === null || id.trim() === "") return null;
  return {
    provider: "paystack",
    providerEventId: id,
    providerEventType: typeof parsed["event"] === "string" ? parsed["event"] : "unknown",
  };
}

// ── Low-level helpers ───────────────────────────────────────────────────────

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

function safeEqual(candidate: string, expectedBytes: Buffer): boolean {
  // Compare in constant time. `timingSafeEqual` throws on unequal lengths
  // — a thrown error here would be a rejection routed through the wrong
  // path — so pad-length-check first.
  const candidateBytes = Buffer.from(candidate, "utf8");
  if (candidateBytes.length !== expectedBytes.length) return false;
  try {
    return timingSafeEqual(candidateBytes, expectedBytes);
  } catch {
    return false;
  }
}

function tryParseJson(rawBody: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return null;
  }
}

function tryParseJsonFromString(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBigInt(value: number | string): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (!Number.isInteger(value)) return null;
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

function safeParseDate(raw: string): Date | null {
  const value = new Date(raw);
  return Number.isFinite(value.getTime()) ? value : null;
}

/**
 * Map Paystack's 4xx responses to a stable refusal code. The most important
 * mapping is `transaction_not_found`, because `verify()` needs to return
 * `not_found` rather than a generic refusal when a reference is unknown.
 */
function extractRefusalCode(httpStatus: number, message: string | null, rawCode: unknown): string {
  if (typeof rawCode === "string" && rawCode.trim() !== "") return rawCode.trim();
  if (httpStatus === 404) {
    // Paystack's messages for a missing reference tend to include
    // "transaction" and "not found"; keep it narrow so a different 404
    // (an unknown endpoint, say) does not get swallowed as not_found.
    if (message !== null && /transaction/i.test(message) && /not\s*found/i.test(message)) {
      return "transaction_not_found";
    }
  }
  return `paystack_http_${httpStatus}`;
}
