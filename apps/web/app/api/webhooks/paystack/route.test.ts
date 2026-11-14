import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  createPaystackPaymentProvider,
  type PaystackPaymentProvider,
} from "@kolekto/adapters";
import { createHmac } from "node:crypto";

// Vitest runs this module in a plain Node environment where the Next.js
// virtual `"server-only"` marker is not resolvable. The marker's sole job is
// to fail client-side bundling of a module; in tests it is a no-op.
vi.mock("server-only", () => ({}));

/**
 * route.test.ts — vitest route-handler tests for /api/webhooks/paystack.
 *
 * The HMAC signing path runs against real arithmetic — the adapter is a
 * real `PaystackPaymentProvider` instance built with a test secret, not
 * a mock. The orchestrator's `confirmPayment` is mocked at module level so
 * these tests exercise the route's branching, status codes and signature
 * boundary without reaching a live Postgres or a live Paystack.
 */

const SECRET_KEY = "sk_test_webhook_route_stub_000000000000000000";
const WEBHOOK_SECRET = "whsec_webhook_route_stub_00000000000000000";

let injectedProvider: PaystackPaymentProvider | null = null;
const confirmPayment = vi.fn();

vi.mock("../../../../lib/payments/paystack.ts", () => ({
  getPaystackPaymentProvider: () => injectedProvider,
}));

vi.mock("../../../../lib/payments/provider-factory.ts", () => ({
  getPaymentContext: () => ({
    db: (fn: unknown) => fn,
    provider: injectedProvider,
    environment: "staging",
    appOrigin: "https://app.example.test",
  }),
}));

vi.mock("@kolekto/payments", async () => {
  // Keep the real module's types; only override `confirmPayment`.
  const actual = await vi.importActual<typeof import("@kolekto/payments")>("@kolekto/payments");
  return {
    ...actual,
    confirmPayment: (...args: unknown[]) => confirmPayment(...args),
  };
});

// `KLK-` + 26 Crockford base32 chars, per packages/domain/payment-reference.ts.
const REFERENCE = "KLK-00000000000000000000000001";

function makeProvider(overrides: Partial<ConstructorParameters<typeof import("@kolekto/adapters").PaystackPaymentProvider>[0]> = {}): PaystackPaymentProvider {
  return createPaystackPaymentProvider({
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    apiBase: "https://sandbox.paystack.test",
    requestTimeoutMs: 500,
    legacyWebhookFallback: true,
    ...overrides,
  });
}

function signModern(body: Uint8Array, secret = WEBHOOK_SECRET): { header: string } {
  const t = Math.floor(Date.now() / 1000);
  const hex = createHmac("sha512", secret)
    .update(Buffer.from(`${t}.`, "utf8"))
    .update(Buffer.from(body))
    .digest("hex");
  return { header: `t=${t},v1=${hex}` };
}

function makeBody(overrides: Record<string, unknown> = {}): { raw: Uint8Array; text: string } {
  const body = {
    id: "evt_webhook_1",
    event: "charge.success",
    data: { reference: REFERENCE },
    ...overrides,
  };
  const text = JSON.stringify(body);
  return { raw: new TextEncoder().encode(text), text };
}

async function POST(request: Request): Promise<Response> {
  const { POST } = await import("./route.ts");
  return POST(request);
}

function routeRequest(
  body: string,
  headers: Record<string, string>,
  method: "POST" | "GET" = "POST",
): Request {
  return new Request("https://app.example.test/api/webhooks/paystack", {
    method,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body: method === "POST" ? body : null,
  });
}

beforeEach(() => {
  injectedProvider = makeProvider();
  confirmPayment.mockReset();
});

afterEach(() => {
  injectedProvider = null;
});

describe("GET / PUT / HEAD etc.", () => {
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD"] as const) {
    it(`refuses ${method} with 405 and sets Allow: POST`, async () => {
      const route = await import("./route.ts");
      const handler = (route as unknown as Record<string, (r: Request) => Promise<Response>>)[method]!;
      const response = await handler(new Request("https://app.example.test/api/webhooks/paystack", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
    });
  }
});

describe("configuration", () => {
  it("returns 503 when Paystack is not configured for this process", async () => {
    injectedProvider = null;
    const { raw, text } = makeBody();
    const { header } = signModern(raw);
    const response = await POST(
      routeRequest(text, { "Paystack-Signature": header }),
    );
    expect(response.status).toBe(503);
    const json = (await response.json()) as { code: string };
    expect(json.code).toBe("paystack_not_configured");
  });
});

describe("content-type and body-size gates", () => {
  it("refuses a wrong content-type with 415", async () => {
    const response = await POST(
      new Request("https://app.example.test/api/webhooks/paystack", {
        method: "POST",
        headers: new Headers({ "content-type": "text/plain" }),
        body: "{}",
      }),
    );
    expect(response.status).toBe(415);
  });

  it("refuses an oversized declared length with 413", async () => {
    const response = await POST(
      new Request("https://app.example.test/api/webhooks/paystack", {
        method: "POST",
        headers: new Headers({
          "content-type": "application/json",
          "content-length": String(1_000_000),
        }),
        body: JSON.stringify({ id: "x", event: "charge.success", data: { reference: REFERENCE } }),
      }),
    );
    expect(response.status).toBe(413);
  });
});

describe("signature verification", () => {
  it("rejects a missing signature header with 401", async () => {
    const { text } = makeBody();
    const response = await POST(routeRequest(text, {}));
    expect(response.status).toBe(401);
    const json = (await response.json()) as { code: string };
    expect(json.code).toBe("missing_signature");
  });

  it("rejects a bad signature with 401 and reveals no body content", async () => {
    const { text } = makeBody();
    const response = await POST(routeRequest(text, { "Paystack-Signature": "t=0,v1=garbage" }));
    expect(response.status).toBe(401);
    const json = (await response.json()) as { code: string; ok: boolean };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("bad_signature");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("accepts a well-signed charge.success and calls confirmPayment", async () => {
    confirmPayment.mockResolvedValueOnce({ outcome: "completed", contributionId: "c_1" });
    const { raw, text } = makeBody();
    const { header } = signModern(raw);
    const response = await POST(routeRequest(text, { "Paystack-Signature": header }));
    expect(response.status).toBe(200);
    expect(confirmPayment).toHaveBeenCalledTimes(1);
    expect(confirmPayment.mock.calls[0]?.[1]).toBe(REFERENCE);
    const json = (await response.json()) as { outcome: string };
    expect(json.outcome).toBe("captured");
  });
});

describe("outcome mapping", () => {
  async function send(result: unknown): Promise<Response> {
    confirmPayment.mockResolvedValueOnce(result);
    const { raw, text } = makeBody();
    const { header } = signModern(raw);
    return POST(routeRequest(text, { "Paystack-Signature": header }));
  }

  it("needs_review → 200 so Paystack stops retrying", async () => {
    const response = await send({ outcome: "needs_review", attemptId: "a", reason: "amount_mismatch" });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { outcome: string };
    expect(json.outcome).toBe("needs_review");
  });

  it("pending → 200", async () => {
    const response = await send({ outcome: "pending" });
    expect(response.status).toBe(200);
  });

  it("failed → 200 (no retry)", async () => {
    const response = await send({ outcome: "failed", failureCode: "failed" });
    expect(response.status).toBe(200);
  });

  it("not_found → 200 so Paystack does not retry an orphan forever", async () => {
    const response = await send({ outcome: "not_found" });
    expect(response.status).toBe(200);
  });

  it("provider_unavailable → 503 (Paystack retries, sweep covers)", async () => {
    const response = await send({ outcome: "provider_unavailable", reason: "x" });
    expect(response.status).toBe(503);
  });

  it("error → 500 (Paystack retries, sweep covers)", async () => {
    const response = await send({ outcome: "error", code: "e" });
    expect(response.status).toBe(500);
  });
});

describe("non-charge events", () => {
  it("transfer events are acknowledged without acting (subsystem deferred)", async () => {
    const { raw, text } = makeBody({ event: "transfer.success", data: { transfer_code: "TRF_abc" } });
    const { header } = signModern(raw);
    const response = await POST(routeRequest(text, { "Paystack-Signature": header }));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { outcome: string };
    expect(json.outcome).toBe("transfer_ignored");
    expect(confirmPayment).not.toHaveBeenCalled();
  });

  it("unsupported events are acknowledged (never 5xx so Paystack does not loop)", async () => {
    const { raw, text } = makeBody({ event: "dispute.create", data: {} });
    const { header } = signModern(raw);
    const response = await POST(routeRequest(text, { "Paystack-Signature": header }));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { outcome: string };
    expect(json.outcome).toBe("unsupported_event");
  });

  it("a charge event with a reference that is not Kolekto's → 400 (unknown format)", async () => {
    const { raw, text } = makeBody({ data: { reference: "someone_elses_ref" } });
    const { header } = signModern(raw);
    const response = await POST(routeRequest(text, { "Paystack-Signature": header }));
    expect(response.status).toBe(400);
    const json = (await response.json()) as { code: string };
    expect(json.code).toBe("unknown_reference_format");
  });
});
