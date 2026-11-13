/**
 * paystack-payment-provider.test.ts — the sandbox test matrix as unit tests.
 *
 * The matrix from the audit (§9) is:
 *
 *   initialize:    ok / refused / 5xx / timeout → unknown
 *   verify:        success / failed / abandoned / ongoing / reversed / not found
 *   signature:     Paystack-Signature valid, wrong secret, stale t, future t,
 *                  two v1 values (rotation), malformed; legacy header valid
 *                  and invalid; body re-serialised → fails
 *
 * Each row below is one scenario from that matrix, run against a stubbed
 * `fetch` so there is no network call. The signature tests use the real
 * HMAC arithmetic: faking the HMAC in a test would test only itself.
 *
 * Secrets in this file are obviously synthetic (`sk_test_…stub`,
 * `whsec_stub…`): they are never a real Paystack value, and the adapter's
 * prefix check at config load would refuse anything that is not.
 */

import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { fromNaira } from "@kolekto/domain";

import {
  createPaystackPaymentProvider,
  type PaystackConfig,
  tryLoadPaystackConfigFromEnv,
} from "../src/paystack-payment-provider.ts";
import { fixtureInitializationRequest } from "../src/fixtures.ts";

const SECRET_KEY = "sk_test_stub_0000000000000000000000000000";
const WEBHOOK_SECRET = "whsec_stub_0000000000000000000000000000";
const API_BASE = "https://sandbox.paystack.test";

const BASE_CONFIG: PaystackConfig = {
  secretKey: SECRET_KEY,
  webhookSecret: WEBHOOK_SECRET,
  apiBase: API_BASE,
  requestTimeoutMs: 500,
  legacyWebhookFallback: true,
};

type FetchArgs = { url: string; init: RequestInit };
type FetchStub = (args: FetchArgs) => Promise<Response> | Response;

const originalFetch = globalThis.fetch;
let seenCalls: FetchArgs[] = [];

function stubFetch(fn: FetchStub): void {
  // `RequestInfo` is a DOM type and `packages/adapters/tsconfig.json` does
  // not include the DOM lib (ES2023 only). Node's built-in `fetch` types
  // declare `RequestInit` as a global but not `RequestInfo`, so the
  // first-argument type is written structurally here.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const args = { url, init: init ?? {} };
    seenCalls.push(args);
    return fn(args);
  }) as typeof fetch;
}

beforeEach(() => {
  seenCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Config loader ───────────────────────────────────────────────────────────

describe("tryLoadPaystackConfigFromEnv", () => {
  it("returns null when either required var is missing", () => {
    assert.equal(tryLoadPaystackConfigFromEnv({}), null);
    assert.equal(
      tryLoadPaystackConfigFromEnv({ PAYSTACK_SECRET_KEY: SECRET_KEY }),
      null,
    );
    assert.equal(
      tryLoadPaystackConfigFromEnv({ PAYSTACK_WEBHOOK_SECRET: WEBHOOK_SECRET }),
      null,
    );
  });

  it("treats blank strings as missing", () => {
    assert.equal(
      tryLoadPaystackConfigFromEnv({
        PAYSTACK_SECRET_KEY: "   ",
        PAYSTACK_WEBHOOK_SECRET: WEBHOOK_SECRET,
      }),
      null,
    );
  });

  it("refuses a key that does not look like a Paystack secret", () => {
    // A publishable key in the secret slot was the previous system's
    // most dangerous misconfiguration; the loader must catch it at
    // startup.
    assert.throws(
      () =>
        tryLoadPaystackConfigFromEnv({
          PAYSTACK_SECRET_KEY: "pk_test_whatever",
          PAYSTACK_WEBHOOK_SECRET: WEBHOOK_SECRET,
        }),
      /PAYSTACK_SECRET_KEY/,
    );
  });

  it("refuses a webhook secret without the whsec_ prefix", () => {
    assert.throws(
      () =>
        tryLoadPaystackConfigFromEnv({
          PAYSTACK_SECRET_KEY: SECRET_KEY,
          PAYSTACK_WEBHOOK_SECRET: "something_not_whsec",
        }),
      /PAYSTACK_WEBHOOK_SECRET/,
    );
  });

  it("returns a complete config when both keys are valid", () => {
    const config = tryLoadPaystackConfigFromEnv({
      PAYSTACK_SECRET_KEY: SECRET_KEY,
      PAYSTACK_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PAYSTACK_API_BASE: API_BASE,
      PAYSTACK_LEGACY_WEBHOOK_FALLBACK: "false",
    });
    assert.ok(config);
    assert.equal(config.secretKey, SECRET_KEY);
    assert.equal(config.webhookSecret, WEBHOOK_SECRET);
    assert.equal(config.apiBase, API_BASE);
    assert.equal(config.legacyWebhookFallback, false);
  });
});

// ── initialize ──────────────────────────────────────────────────────────────

describe("initialize", () => {
  it("returns ok with the checkout url when Paystack accepts the request", async () => {
    stubFetch(() =>
      jsonResponse(200, {
        status: true,
        message: "Authorization URL created",
        data: {
          authorization_url: "https://checkout.paystack.com/abc123",
          access_code: "AC_abc123",
          reference: "KLK-TEST-0000000001",
        },
      }),
    );
    const provider = createPaystackPaymentProvider(BASE_CONFIG);
    const result = await provider.initialize(fixtureInitializationRequest());
    assert.equal(result.outcome, "ok");
    if (result.outcome !== "ok") return;
    assert.equal(result.value.provider, "paystack");
    assert.equal(result.value.reference, "KLK-TEST-0000000001");
    assert.equal(result.value.checkoutUrl, "https://checkout.paystack.com/abc123");
    assert.equal(result.value.providerAccessCode, "AC_abc123");

    assert.equal(seenCalls.length, 1);
    const call = seenCalls[0]!;
    assert.ok(call.url.endsWith("/transaction/initialize"));
    assert.equal(call.init.method, "POST");
    const body = JSON.parse(String(call.init.body ?? "{}"));
    // The amount travels as a string — bigint-safe through JSON.
    assert.equal(body.amount, String(fromNaira("10000")));
    assert.equal(body.reference, "KLK-TEST-0000000001");
    assert.equal(body.currency, "NGN");
  });

  it("maps a 400 refusal with an error body to `refused`", async () => {
    stubFetch(() =>
      jsonResponse(400, { status: false, message: "Reference already used", code: "duplicate_reference" }),
    );
    const provider = createPaystackPaymentProvider(BASE_CONFIG);
    const result = await provider.initialize(fixtureInitializationRequest());
    assert.equal(result.outcome, "refused");
    if (result.outcome !== "refused") return;
    assert.equal(result.providerCode, "duplicate_reference");
    assert.match(result.message, /already used/i);
  });

  it("maps a 5xx to `unknown` with safeToRetry=false (a checkout may exist)", async () => {
    stubFetch(() => new Response("gateway down", { status: 502 }));
    const provider = createPaystackPaymentProvider(BASE_CONFIG);
    const result = await provider.initialize(fixtureInitializationRequest());
    assert.equal(result.outcome, "unknown");
    if (result.outcome !== "unknown") return;
    assert.equal(result.safeToRetry, false);
    assert.match(result.reason, /paystack_http_502/);
  });

  it("maps a timeout to `unknown` with safeToRetry=false", async () => {
    // A faithful stub honours the AbortSignal — real `fetch` throws an
    // AbortError when the controller fires — otherwise the stub would
    // silently race past the adapter's timer.
    stubFetch(
      async ({ init }) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }
          setTimeout(() => resolve(new Response("too late")), 2_000);
        }),
    );
    const provider = createPaystackPaymentProvider({ ...BASE_CONFIG, requestTimeoutMs: 20 });
    const result = await provider.initialize(fixtureInitializationRequest());
    assert.equal(result.outcome, "unknown");
    if (result.outcome !== "unknown") return;
    assert.equal(result.safeToRetry, false);
    assert.match(result.reason, /timeout/i);
  });

  it("returns `unknown` when Paystack echoes a different reference", async () => {
    // An unlikely race, but the type contract requires reference equality
    // downstream; surfacing it as unknown stops downstream from marking
    // the attempt initialized under the wrong reference.
    stubFetch(() =>
      jsonResponse(200, {
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/abc123",
          access_code: "AC_abc123",
          reference: "KLK-DIFFERENT",
        },
      }),
    );
    const provider = createPaystackPaymentProvider(BASE_CONFIG);
    const result = await provider.initialize(fixtureInitializationRequest());
    assert.equal(result.outcome, "unknown");
    if (result.outcome !== "unknown") return;
    assert.equal(result.safeToRetry, false);
  });

  it("returns `unknown` on a 2xx body that is not JSON", async () => {
    stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const provider = createPaystackPaymentProvider(BASE_CONFIG);
    const result = await provider.initialize(fixtureInitializationRequest());
    assert.equal(result.outcome, "unknown");
  });

  it("propagates `status:false` on a 2xx as `refused`", async () => {
    stubFetch(() =>
      jsonResponse(200, { status: false, message: "Something is wrong" }),
    );
    const provider = createPaystackPaymentProvider(BASE_CONFIG);
    const result = await provider.initialize(fixtureInitializationRequest());
    assert.equal(result.outcome, "refused");
  });
});

// ── verify ──────────────────────────────────────────────────────────────────

describe("verify", () => {
  const reference = "KLK-TEST-0000000001";
  const BASE_VERIFY_BODY = {
    id: 123456789,
    reference,
    amount: 10_000_00, // ₦10,000 in kobo
    currency: "NGN",
    fees: 150_00, // ₦150 in kobo
    paid_at: "2026-11-13T12:34:56.000Z",
    created_at: "2026-11-13T12:34:50.000Z",
    channel: "card",
    authorization: { authorization_code: "AUTH_abcdef123" },
  };

  it("maps status=success to `succeeded` and exposes the fees field", async () => {
    stubFetch(() => jsonResponse(200, { status: true, data: { ...BASE_VERIFY_BODY, status: "success" } }));
    const provider = createPaystackPaymentProvider(BASE_CONFIG);
    const result = await provider.verify(reference);
    assert.equal(result.outcome, "ok");
    if (result.outcome !== "ok") return;
    assert.equal(result.value.status, "succeeded");
    assert.equal(result.value.providerStatusRaw, "success");
    assert.equal(result.value.providerReference, reference);
    assert.equal(result.value.providerTransactionId, "123456789");
    assert.equal(result.value.providerFee, fromNaira("150"));
    assert.equal(result.value.amount, fromNaira("10000"));
    assert.equal(result.value.currency, "NGN");
    assert.equal(result.value.channel, "card");
    assert.equal(result.value.authorizationReference, "AUTH_abcdef123");
    assert.ok(result.value.paidAt instanceof Date);
  });

  it("maps status=failed to `failed`", async () => {
    stubFetch(() => jsonResponse(200, { status: true, data: { ...BASE_VERIFY_BODY, status: "failed" } }));
    const result = await createPaystackPaymentProvider(BASE_CONFIG).verify(reference);
    assert.equal(result.outcome, "ok");
    if (result.outcome !== "ok") return;
    assert.equal(result.value.status, "failed");
  });

  it("maps status=abandoned to `abandoned`", async () => {
    stubFetch(() => jsonResponse(200, { status: true, data: { ...BASE_VERIFY_BODY, status: "abandoned" } }));
    const result = await createPaystackPaymentProvider(BASE_CONFIG).verify(reference);
    assert.equal(result.outcome, "ok");
    if (result.outcome !== "ok") return;
    assert.equal(result.value.status, "abandoned");
  });

  it("maps status=ongoing / processing / queued / pending to `pending`", async () => {
    for (const status of ["ongoing", "processing", "queued", "pending"] as const) {
      stubFetch(() => jsonResponse(200, { status: true, data: { ...BASE_VERIFY_BODY, status } }));
      const result = await createPaystackPaymentProvider(BASE_CONFIG).verify(reference);
      assert.equal(result.outcome, "ok");
      if (result.outcome !== "ok") continue;
      assert.equal(result.value.status, "pending", `expected pending for status=${status}`);
      assert.equal(result.value.providerStatusRaw, status);
    }
  });

  it("maps status=reversed to `unrecognised` (capture routes to needs_review)", async () => {
    stubFetch(() => jsonResponse(200, { status: true, data: { ...BASE_VERIFY_BODY, status: "reversed" } }));
    const result = await createPaystackPaymentProvider(BASE_CONFIG).verify(reference);
    assert.equal(result.outcome, "ok");
    if (result.outcome !== "ok") return;
    assert.equal(result.value.status, "unrecognised");
  });

  it("returns `not_found` on Paystack's 404 for an unknown reference", async () => {
    stubFetch(() =>
      jsonResponse(404, { status: false, message: "Transaction not found" }),
    );
    const result = await createPaystackPaymentProvider(BASE_CONFIG).verify(reference);
    assert.equal(result.outcome, "not_found");
  });

  it("returns `unknown` with safeToRetry=true on a 5xx (a read; retrying cannot move money)", async () => {
    stubFetch(() => new Response("bad gateway", { status: 503 }));
    const result = await createPaystackPaymentProvider(BASE_CONFIG).verify(reference);
    assert.equal(result.outcome, "unknown");
    if (result.outcome !== "unknown") return;
    assert.equal(result.safeToRetry, true);
  });

  it("preserves a null fees field as null (never silently 0)", async () => {
    // D-11 / PA-05: a null means Paystack did not report, which is NOT
    // the same as zero. The capture path uses the modelled estimate in
    // that case rather than banking a zero fee.
    stubFetch(() =>
      jsonResponse(200, {
        status: true,
        data: { ...BASE_VERIFY_BODY, status: "success", fees: null },
      }),
    );
    const result = await createPaystackPaymentProvider(BASE_CONFIG).verify(reference);
    assert.equal(result.outcome, "ok");
    if (result.outcome !== "ok") return;
    assert.equal(result.value.providerFee, null);
  });
});

// ── authenticateWebhook — modern header ─────────────────────────────────────

describe("authenticateWebhook (modern Paystack-Signature)", () => {
  function sign(body: Uint8Array, secret: string, t: number): string {
    const prefix = Buffer.from(`${t}.`, "utf8");
    return createHmac("sha512", secret).update(prefix).update(Buffer.from(body)).digest("hex");
  }

  const body = new TextEncoder().encode(
    JSON.stringify({ id: "evt_abc", event: "charge.success", data: { reference: "KLK-TEST-0000000001" } }),
  );

  it("accepts a well-formed signature within the 300-second window", () => {
    const t = Math.floor(Date.now() / 1000);
    const hex = sign(body, WEBHOOK_SECRET, t);
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(body, {
      "paystack-signature": `t=${t},v1=kid1:${hex}`,
    });
    assert.equal(result.outcome, "authentic");
    if (result.outcome !== "authentic") return;
    assert.equal(result.identity.providerEventId, "evt_abc");
    assert.equal(result.identity.providerEventType, "charge.success");
  });

  it("accepts a bare v1=<hex> (no kid), as a tolerant parser must", () => {
    const t = Math.floor(Date.now() / 1000);
    const hex = sign(body, WEBHOOK_SECRET, t);
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(body, {
      "Paystack-Signature": `t=${t},v1=${hex}`,
    });
    assert.equal(result.outcome, "authentic");
  });

  it("accepts a header with two v1 values (rotation window) — one correct", () => {
    const t = Math.floor(Date.now() / 1000);
    const wrong = createHmac("sha512", "whsec_other").update(Buffer.from(body)).digest("hex");
    const right = sign(body, WEBHOOK_SECRET, t);
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(body, {
      "paystack-signature": `t=${t},v1=old:${wrong},v1=new:${right}`,
    });
    assert.equal(result.outcome, "authentic");
  });

  it("rejects a signature produced with the wrong secret", () => {
    const t = Math.floor(Date.now() / 1000);
    const hex = sign(body, "whsec_wrong_secret", t);
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(body, {
      "paystack-signature": `t=${t},v1=${hex}`,
    });
    assert.equal(result.outcome, "rejected");
    if (result.outcome !== "rejected") return;
    assert.equal(result.rejection.reason, "bad_signature");
  });

  it("rejects a stale timestamp (> 300s in the past)", () => {
    const t = Math.floor(Date.now() / 1000) - 400;
    const hex = sign(body, WEBHOOK_SECRET, t);
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(body, {
      "paystack-signature": `t=${t},v1=${hex}`,
    });
    assert.equal(result.outcome, "rejected");
    if (result.outcome !== "rejected") return;
    assert.equal(result.rejection.reason, "bad_signature");
  });

  it("rejects a future timestamp (> 300s ahead)", () => {
    const t = Math.floor(Date.now() / 1000) + 400;
    const hex = sign(body, WEBHOOK_SECRET, t);
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(body, {
      "paystack-signature": `t=${t},v1=${hex}`,
    });
    assert.equal(result.outcome, "rejected");
  });

  it("rejects a malformed signature header", () => {
    for (const header of ["", "garbage", "v1=onlyhex", "t=nope,v1=hex"]) {
      const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(body, {
        "paystack-signature": header,
      });
      assert.equal(result.outcome, "rejected", `header: ${header}`);
    }
  });

  it("rejects a body that was re-serialised (one byte different, signature breaks)", () => {
    const t = Math.floor(Date.now() / 1000);
    const hex = sign(body, WEBHOOK_SECRET, t);
    // The server might trim a space or re-order keys; any byte change
    // breaks the HMAC. This is why the raw bytes have to reach the
    // adapter unchanged.
    const reserialized = new TextEncoder().encode(
      JSON.stringify({ event: "charge.success", data: { reference: "KLK-TEST-0000000001" }, id: "evt_abc" }),
    );
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(reserialized, {
      "paystack-signature": `t=${t},v1=${hex}`,
    });
    assert.equal(result.outcome, "rejected");
  });

  it("rejects when the body is valid JSON but carries no event id", () => {
    const t = Math.floor(Date.now() / 1000);
    const noIdBody = new TextEncoder().encode(
      JSON.stringify({ event: "charge.success", data: { reference: "KLK-TEST-0000000001" } }),
    );
    const hex = sign(noIdBody, WEBHOOK_SECRET, t);
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(noIdBody, {
      "paystack-signature": `t=${t},v1=${hex}`,
    });
    assert.equal(result.outcome, "rejected");
    if (result.outcome !== "rejected") return;
    assert.equal(result.rejection.reason, "missing_event_id");
  });
});

// ── authenticateWebhook — legacy header ─────────────────────────────────────

describe("authenticateWebhook (legacy x-paystack-signature)", () => {
  const body = new TextEncoder().encode(
    JSON.stringify({ id: "evt_legacy", event: "charge.success", data: { reference: "KLK-TEST-0000000001" } }),
  );

  it("accepts a valid legacy signature while the fallback is on", () => {
    const hex = createHmac("sha512", SECRET_KEY).update(Buffer.from(body)).digest("hex");
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(body, {
      "x-paystack-signature": hex,
    });
    assert.equal(result.outcome, "authentic");
  });

  it("rejects a legacy signature produced with the wrong key", () => {
    const hex = createHmac("sha512", "sk_test_other").update(Buffer.from(body)).digest("hex");
    const result = createPaystackPaymentProvider(BASE_CONFIG).authenticateWebhook(body, {
      "x-paystack-signature": hex,
    });
    assert.equal(result.outcome, "rejected");
  });

  it("refuses the legacy header when the fallback is turned off", () => {
    const hex = createHmac("sha512", SECRET_KEY).update(Buffer.from(body)).digest("hex");
    const result = createPaystackPaymentProvider({ ...BASE_CONFIG, legacyWebhookFallback: false }).authenticateWebhook(
      body,
      { "x-paystack-signature": hex },
    );
    assert.equal(result.outcome, "rejected");
    if (result.outcome !== "rejected") return;
    assert.equal(result.rejection.reason, "missing_signature");
  });
});

// ── parseWebhookSubject ─────────────────────────────────────────────────────

describe("parseWebhookSubject", () => {
  it("reads the reference out of a charge.* event", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ id: "x", event: "charge.success", data: { reference: "KLK-TEST-0000000001" } }),
    );
    const subject = createPaystackPaymentProvider(BASE_CONFIG).parseWebhookSubject(body);
    assert.equal(subject.kind, "transaction");
    if (subject.kind !== "transaction") return;
    assert.equal(subject.providerReference, "KLK-TEST-0000000001");
  });

  it("reads the transfer code out of a transfer.* event", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ id: "x", event: "transfer.success", data: { transfer_code: "TRF_abc" } }),
    );
    const subject = createPaystackPaymentProvider(BASE_CONFIG).parseWebhookSubject(body);
    assert.equal(subject.kind, "transfer");
    if (subject.kind !== "transfer") return;
    assert.equal(subject.transferReference, "TRF_abc");
  });

  it("marks an unknown event type as unsupported, carrying the raw name", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ id: "x", event: "dispute.resolve", data: {} }),
    );
    const subject = createPaystackPaymentProvider(BASE_CONFIG).parseWebhookSubject(body);
    assert.equal(subject.kind, "unsupported");
    if (subject.kind !== "unsupported") return;
    assert.equal(subject.providerEventType, "dispute.resolve");
  });

  it("handles unparseable JSON as unsupported", () => {
    const body = new TextEncoder().encode("{ not json");
    const subject = createPaystackPaymentProvider(BASE_CONFIG).parseWebhookSubject(body);
    assert.equal(subject.kind, "unsupported");
  });
});
