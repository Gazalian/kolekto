import "server-only";

/**
 * /api/webhooks/paystack — Paystack's charge, transfer and dispute webhooks.
 *
 * ── THE SEQUENCE THIS FILE EXISTS TO ENFORCE ───────────────────────────────
 *
 *   1. POST only; everything else is 405.
 *   2. Content-Type: application/json only (Paystack sends this). 415 otherwise.
 *   3. Raw body read with a hard 256 KiB cap. The HMAC runs on the exact
 *      bytes the client sent — nothing is re-serialised between here and
 *      `adapter.authenticateWebhook`, because any re-serialisation changes
 *      the bytes and breaks the signature.
 *   4. `adapter.authenticateWebhook` verifies the HMAC-SHA512 signature.
 *      It prefers the modern `Paystack-Signature` header (timestamp +
 *      300-second window, rotation-safe v1 handling) and falls back to the
 *      legacy `x-paystack-signature` while `PAYSTACK_LEGACY_WEBHOOK_FALLBACK`
 *      is not turned off. Rejections become 401, never 5xx, and NOTHING
 *      from an unauthenticated body is logged, stored or acted on.
 *   5. `adapter.parseWebhookSubject` reads the event kind and the
 *      reference out of the body. A charge event dispatches to
 *      `confirmPayment(reference)` — the same code the redirect and the
 *      sweep call, so three triggers converge on one capture path and
 *      capture is idempotent on the attempt.
 *   6. Transfer / unsupported events are acknowledged (200) without acting:
 *      the transfer, refund and dispute subsystems are deferred (M8.10+),
 *      and Paystack retries anything that is not 2xx.
 *
 * ── WHAT IS LOGGED ──────────────────────────────────────────────────────────
 *
 * Nothing from the body. Nothing from the signature header. No reference
 * value, no amount, no email. The only observable outputs are the HTTP
 * status and a short stable code in the JSON body — the same discipline
 * the SES webhook follows (M13.2 P5-5).
 *
 * ── NOTHING ABOUT PAYSTACK'S HTTP LIVES HERE ────────────────────────────────
 *
 * Invariant 4 (ADR 0002) forbids `api.paystack.co` and `PAYSTACK_SECRET_KEY`
 * outside `packages/adapters`. The adapter signs, parses, maps; this file
 * only runs it against raw bytes and routes the outcome.
 */

import { isPaymentReference } from "@kolekto/domain";
import { confirmPayment } from "@kolekto/payments";

import { getPaymentContext } from "../../../../lib/payments/provider-factory.ts";
import { getPaystackPaymentProvider } from "../../../../lib/payments/paystack.ts";

const MAX_BODY_BYTES = 256 * 1024;
const ACCEPTED_CONTENT_TYPES = new Set(["application/json"]);

/** Dynamic for every method — a webhook route is never a static response. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const provider = getPaystackPaymentProvider();
  if (provider === null) {
    // Ingestion disabled by configuration. 503 says "temporarily
    // unavailable" without leaking why. An operator reads the env.
    return problem(503, "paystack_not_configured");
  }

  // Content type gate first — before reading the body — so an attacker
  // sending a wrong mime type pays no CPU on HMAC arithmetic.
  const rawContentType = request.headers.get("content-type") ?? "";
  const contentTypeBase = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ACCEPTED_CONTENT_TYPES.has(contentTypeBase)) {
    return problem(415, "unsupported_content_type");
  }

  // Early size check from Content-Length. Not authoritative on its own (a
  // chunked body may omit it), but short-circuits anything that honestly
  // declares its size.
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const n = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return problem(413, "payload_too_large");
  }

  const bodyRead = await readLimitedBody(request, MAX_BODY_BYTES);
  if (bodyRead === "too_large") return problem(413, "payload_too_large");
  if (bodyRead === "no_body" || bodyRead === "read_error") return problem(400, "body_read_failed");
  const rawBody: Uint8Array = bodyRead;

  // Collect the headers the adapter looks for, lower-cased. A narrow set
  // so an operator error cannot send us logging an unrelated header.
  const headers: Record<string, string> = {};
  for (const [name, value] of request.headers.entries()) {
    const lower = name.toLowerCase();
    if (lower === "paystack-signature" || lower === "x-paystack-signature") {
      headers[lower] = value;
    }
  }

  const auth = provider.authenticateWebhook(rawBody, headers);
  if (auth.outcome === "rejected") {
    // 401 for a bad signature or a missing one. Nothing is persisted, and
    // the only observable output is the stable reason code — no header
    // value, no body excerpt.
    return problem(401, rejectionCode(auth.rejection.reason));
  }

  const subject = provider.parseWebhookSubject(rawBody);

  // Transfer and unsupported events: the transfer, refund and dispute
  // subsystems are deferred. Acknowledge so Paystack stops retrying, but
  // do not act. Once those subsystems land, a financial_events table (per
  // the audit §4.6) stores the body for the worker to process.
  if (subject.kind !== "transaction") {
    return ack(subject.kind === "transfer" ? "transfer_ignored" : "unsupported_event");
  }

  // Our own reference format. Anything else is a webhook for a payment we
  // did not initiate; the DB would refuse it as UNKNOWN_PAYMENT_REFERENCE,
  // but we can reject it earlier and cheaper.
  if (!isPaymentReference(subject.providerReference)) {
    return problem(400, "unknown_reference_format");
  }

  const payments = getPaymentContext();
  if (payments === null) {
    // A webhook arrived but the orchestrator cannot find a provider for
    // this environment — misconfiguration. 503 and let Paystack retry.
    return problem(503, "payments_unavailable");
  }

  // `confirmPayment` is the one capture path. It re-verifies with
  // Paystack rather than trusting the webhook body (A7: a webhook is a
  // trigger to verify, never evidence), and both the T1 write and the T2
  // capture are idempotent on their own keys. Three triggers converge
  // here — redirect, worker, sweep — which is why this call is safe.
  const result = await confirmPayment(payments, subject.providerReference);

  switch (result.outcome) {
    case "completed":
      return ack("captured");
    case "needs_review":
      // A mismatch (amount, currency, unrecognised status). The row is
      // parked for a human; acknowledge so Paystack does not retry.
      return ack("needs_review");
    case "pending":
      // Paystack says the payment is still in flight. Acknowledge and
      // wait for the next webhook or the sweep. Retrying this webhook
      // would not change the provider's state.
      return ack("pending");
    case "failed":
      // The payment is settled as failed on both sides. Nothing more to
      // do; acknowledge so Paystack stops retrying.
      return ack("failed");
    case "not_found":
      // Reference unknown to Kolekto (never started) OR Paystack said it
      // was unknown. Either way, nothing to capture. Acknowledge so
      // Paystack does not retry an orphan forever. Do NOT 404 — Paystack
      // interprets that as a transient error and retries.
      return ack("unknown_reference");
    case "provider_unavailable":
      // We asked Paystack to verify and Paystack did not answer. Signal
      // Paystack to retry by returning 5xx — the sweep also covers this.
      return problem(503, "verify_unavailable");
    case "error":
      // Something Kolekto did not model. 5xx so Paystack retries; the
      // sweep covers it as a backstop. Nothing is marked failed on the
      // attempt by this path.
      return problem(500, `capture_error`);
  }
}

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

// ── Streaming body read ─────────────────────────────────────────────────────

async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | "too_large" | "no_body" | "read_error"> {
  const stream = request.body;
  if (stream === null) return "no_body";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response is already decided; cancel errors are ignored.
        }
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return "read_error";
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ── Response helpers ────────────────────────────────────────────────────────

function ack(outcome: string): Response {
  const body = JSON.stringify({ ok: true, outcome });
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

function rejectionCode(reason: "missing_signature" | "bad_signature" | "unparseable" | "missing_event_id"): string {
  // The vocabulary is already a stable snake_case set; return it
  // unchanged so operators correlate across logs.
  return reason;
}
