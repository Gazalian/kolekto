import "server-only";

/**
 * /api/webhooks/paystack/transfer-approval — Paystack's transfer approval URL
 * ("server approval", owner decision 2026-11-19).
 *
 * Paystack calls this for each transfer request and waits a few seconds:
 *   200 → approved (the transfer proceeds)
 *   400 → rejected (Paystack marks it `rejected`; no money moves)
 *   no answer in time → `blocked` (no money moves)
 *
 * FAIL CLOSED. Only an explicit "approve" from app.decide_transfer_approval
 * is a 200. That function approves only a Kolekto transfer that is still
 * open, whose amount and recipient match, whose destination is the
 * requester's own verified account, whose requester verified their code,
 * that someone other than the requester approved on a valid basis (an
 * owner, or a designated second approver for an owner's request), that is not under manual review and
 * whose funds are still reserved. Everything else — wrong method or content
 * type, oversized or unreadable body, a signature header that does not
 * verify, no provider or database, any error — is a 400.
 *
 * Signature: Paystack does not document a signature on approval requests.
 * When `x-paystack-signature` is present it must verify (HMAC-SHA512 of the
 * raw body with the secret key, as for webhooks); any other signature header
 * cannot be checked and is rejected; when none is present the request is decided on its merits
 * and recorded as `signature: absent`. Approving costs an attacker nothing
 * useful: the answer goes back to the caller, and only Paystack's own
 * request for Kolekto's own transfer can make money move.
 *
 * Nothing from the body or headers is logged. Every decision is stored by
 * the database (withdrawal_transfer_approval_requests).
 */

import { isInboundCreditRequest } from "@kolekto/adapters";
import { answerTransferApproval } from "@kolekto/payments";

import { getTransferContext } from "../../../../../lib/payments/transfers.ts";

const MAX_BODY_BYTES = 64 * 1024;
/** Well past Paystack's documented 5-second inbound deadline. */
const inboundHoldMs = 12_000;

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const contentTypeBase = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentTypeBase !== "application/json") return reject("unsupported_content_type");

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const n = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return reject("payload_too_large");
  }
  const rawBody = await readLimitedBody(request, MAX_BODY_BYTES);
  if (rawBody === null) return reject("body_unreadable");

  // An INBOUND credit request (a customer paying in) is not ours to decide:
  // Kolekto has no inbound-approval integration. Paystack documents only one
  // inbound outcome — no answer within 5 seconds is accepted — and not what
  // a 400 does, so the payment is left to that documented default by not
  // answering in time. Nothing is decided, logged with payment details, or
  // written. Interim protection until the LIVE dashboard no longer sends
  // inbound requests here (owner decision 2026-11-20).
  if (isInboundCreditRequest(rawBody)) {
    console.warn(JSON.stringify({ msg: "transfer_approval_inbound_credit_ignored", holdMs: inboundHoldMs }));
    await new Promise((resolve) => setTimeout(resolve, inboundHoldMs));
    return reject("inbound_credit_not_handled");
  }

  // Fail closed: anything that throws before the database decides is a 400,
  // never a 500 (whose meaning to Paystack is not documented).
  let transfers: ReturnType<typeof getTransferContext>;
  let signature: ReturnType<NonNullable<ReturnType<typeof getTransferContext>>["provider"]["authenticateApprovalRequest"]>;
  try {
    transfers = getTransferContext();
    if (transfers === null) return reject("transfers_unavailable");

    const signatureHeaders: Record<string, string> = {};
    for (const [name, value] of request.headers.entries()) {
      const lower = name.toLowerCase();
      if (lower === "paystack-signature" || lower === "x-paystack-signature") signatureHeaders[lower] = value;
    }
    signature = transfers.provider.authenticateApprovalRequest(rawBody, signatureHeaders);
  } catch (err) {
    // Error name only: no body, header or key material.
    console.error(JSON.stringify({ msg: "transfer_approval_error", stage: "provider", error: err instanceof Error ? err.name : "unknown" }));
    return reject("error");
  }
  if (signature === "invalid") return reject("signature_invalid");

  let answer: Awaited<ReturnType<typeof answerTransferApproval>>;
  try {
    answer = await answerTransferApproval(transfers.db, rawBody, signature);
  } catch {
    return reject("error");
  }
  return Response.json({ decision: answer.decision, reason: answer.reasonCode }, { status: answer.httpStatus, headers: { "Cache-Control": "no-store" } });
}

function reject(reason: string): Response {
  return Response.json({ decision: "reject", reason }, { status: 400, headers: { "Cache-Control": "no-store" } });
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

function methodNotAllowed(): Response {
  return new Response("method not allowed\n", {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const stream = request.body;
  if (stream === null) return null;
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
          // decided already
        }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
