/**
 * PaystackTransferProvider against a stubbed fetch: request shapes (kobo as a
 * number, source balance, our reference), D-27 timeout semantics, status
 * mapping, pagination and the env switch. Plus the fake.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { kobo } from "@kolekto/domain";

import {
  createPaystackTransferProvider,
  mapPaystackTransferStatus,
  paystackTransfersEnabled,
} from "../src/paystack-transfer-provider.ts";
import { FakeTransferProvider } from "../src/fake-transfer-provider.ts";
import { isTransferReference, parseTransferWebhook } from "../src/transfer-provider.ts";

const API = "https://sandbox.paystack.test";
const provider = createPaystackTransferProvider({ secretKey: "sk_test_stub_0000", apiBase: API, requestTimeoutMs: 200 });
const REF = "ktr_0123456789abcdef01234567";

const originalFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];
function stub(fn: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return fn(url, init ?? {});
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("PaystackTransferProvider", () => {
  it("lists active banks across cursor pages, de-duplicated and sorted", async () => {
    stub((url) =>
      url.includes("next=")
        ? json(200, { status: true, data: [{ name: "Zenith Bank", code: "057", active: true }], meta: { next: null } })
        : json(200, {
            status: true,
            data: [
              { name: "Access Bank", code: "044", active: true },
              { name: "Dead Bank", code: "000", active: false },
              { name: "Access Bank", code: "044", active: true },
            ],
            meta: { next: "cursor1" },
          }),
    );
    const result = await provider.listBanks();
    assert.equal(result.outcome, "ok");
    if (result.outcome === "ok") assert.deepEqual(result.value.map((b) => b.code), ["044", "057"]);
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /country=nigeria&currency=NGN/);
    assert.equal((calls[0]!.init.headers as Record<string, string>)["Authorization"], "Bearer sk_test_stub_0000");
  });

  it("resolves an account; a 422 is not_found; a 429 stays a refusal", async () => {
    stub(() => json(200, { status: true, data: { account_number: "0123456789", account_name: "OKAFOR ADAEZE " } }));
    assert.deepEqual(await provider.resolveAccount("0123456789", "058"), {
      outcome: "ok",
      value: { accountNumber: "0123456789", accountName: "OKAFOR ADAEZE" },
    });

    stub(() => json(422, { status: false, message: "Could not resolve account name. Check parameters or try again." }));
    assert.deepEqual(await provider.resolveAccount("0123456789", "058"), { outcome: "not_found" });

    stub(() => json(429, { status: false, message: "Too many requests" }));
    assert.equal((await provider.resolveAccount("0123456789", "058")).outcome, "refused");
  });

  it("refuses a resolution that echoes another account number", async () => {
    stub(() => json(200, { status: true, data: { account_number: "9999999999", account_name: "SOMEONE" } }));
    assert.equal((await provider.resolveAccount("0123456789", "058")).outcome, "unknown");
  });

  it("creates a nuban recipient", async () => {
    stub(() => json(201, { status: true, data: { recipient_code: "RCP_abc123", active: true } }));
    const result = await provider.createRecipient({ accountName: "OKAFOR ADAEZE", accountNumber: "0123456789", bankCode: "058" });
    assert.deepEqual(result, { outcome: "ok", value: { recipientCode: "RCP_abc123" } });
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      type: "nuban",
      name: "OKAFOR ADAEZE",
      account_number: "0123456789",
      bank_code: "058",
      currency: "NGN",
    });
  });

  it("reads the NGN balance in kobo", async () => {
    stub(() => json(200, { status: true, data: [{ currency: "USD", balance: 5 }, { currency: "NGN", balance: 12345600 }] }));
    assert.deepEqual(await provider.getBalance(), { outcome: "ok", value: { available: kobo(12_345_600n) } });
  });

  it("initiates from the balance with kobo as a string and our reference", async () => {
    stub(() =>
      json(200, { status: true, data: { reference: REF, transfer_code: "TRF_xyz789", status: "pending", amount: 8000000, id: 42 } }),
    );
    const result = await provider.initiateTransfer({
      reference: REF,
      amount: kobo(8_000_000n),
      recipientCode: "RCP_abc123",
      reason: "Kolekto payout KWD-1",
    });
    assert.equal(result.outcome, "ok");
    if (result.outcome === "ok") {
      assert.equal(result.value.status, "pending");
      assert.equal(result.value.transferCode, "TRF_xyz789");
      assert.equal(result.value.amount, 8_000_000n);
    }
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      source: "balance",
      amount: "8000000",
      recipient: "RCP_abc123",
      reference: REF,
      reason: "Kolekto payout KWD-1",
      currency: "NGN",
    });
  });

  it("a timed-out or 5xx initiation is unknown and NOT safe to retry (D-27)", async () => {
    stub(
      () =>
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 10),
        ),
    );
    assert.deepEqual(
      await provider.initiateTransfer({ reference: REF, amount: kobo(1n), recipientCode: "RCP_abc123", reason: "r" }),
      { outcome: "unknown", reason: "paystack_request_timeout", safeToRetry: false },
    );
    stub(() => json(502, {}));
    const r = await provider.initiateTransfer({ reference: REF, amount: kobo(1n), recipientCode: "RCP_abc123", reason: "r" });
    assert.equal(r.outcome, "unknown");
    assert.equal(r.outcome === "unknown" && r.safeToRetry, false);
  });

  it("a 400 initiation is a refusal", async () => {
    stub(() => json(400, { status: false, message: "Your balance is not enough to fulfil this request" }));
    const r = await provider.initiateTransfer({ reference: REF, amount: kobo(1n), recipientCode: "RCP_abc123", reason: "r" });
    assert.equal(r.outcome, "refused");
  });

  it("verifies a transfer with its fee; a 404 is not_found", async () => {
    stub(() =>
      json(200, {
        status: true,
        data: { reference: REF, transfer_code: "TRF_xyz789", status: "success", amount: 8000000, fee_charged: 5000 },
      }),
    );
    const r = await provider.verifyTransfer(REF);
    assert.equal(r.outcome, "ok");
    if (r.outcome === "ok") {
      assert.equal(r.value.status, "success");
      assert.equal(r.value.fee, 5000n);
    }
    stub(() => json(404, { status: false, message: "Transfer not found" }));
    assert.deepEqual(await provider.verifyTransfer(REF), { outcome: "not_found" });
  });

  it("maps Paystack transfer statuses conservatively", () => {
    assert.equal(mapPaystackTransferStatus("success"), "success");
    assert.equal(mapPaystackTransferStatus("reversed"), "reversed");
    assert.equal(mapPaystackTransferStatus("abandoned"), "failed");
    assert.equal(mapPaystackTransferStatus("received"), "pending");
    assert.equal(mapPaystackTransferStatus("otp"), "otp");
    assert.equal(mapPaystackTransferStatus("something_new"), "unrecognised");
  });
});

describe("transfer webhook parsing and references", () => {
  it("routes by our reference and ignores non-transfer events", () => {
    const body = (o: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(o)));
    assert.deepEqual(parseTransferWebhook(body({ event: "transfer.success", data: { reference: REF, transfer_code: "TRF_1" } })), {
      event: "transfer.success",
      reference: REF,
    });
    assert.equal(parseTransferWebhook(body({ event: "charge.success", data: { reference: REF } })), null);
    assert.equal(parseTransferWebhook(new Uint8Array([1, 2, 3])), null);
    assert.equal(isTransferReference(REF), true);
    assert.equal(isTransferReference("KLK-ABC"), false);
  });
});

describe("paystackTransfersEnabled", () => {
  it("is off unless switched on; a live key needs a second approval", () => {
    assert.equal(paystackTransfersEnabled({ PAYSTACK_SECRET_KEY: "sk_test_x" }), false);
    assert.equal(paystackTransfersEnabled({ PAYSTACK_SECRET_KEY: "sk_test_x", PAYSTACK_TRANSFERS_ENABLED: "true" }), true);
    assert.equal(paystackTransfersEnabled({ PAYSTACK_SECRET_KEY: "sk_live_x", PAYSTACK_TRANSFERS_ENABLED: "true" }), false);
    assert.equal(
      paystackTransfersEnabled({
        PAYSTACK_SECRET_KEY: "sk_live_x",
        PAYSTACK_TRANSFERS_ENABLED: "true",
        PAYSTACK_LIVE_TRANSFERS_APPROVED: "true",
      }),
      true,
    );
  });
});

describe("FakeTransferProvider", () => {
  it("resolves, pays, reverses and refuses a duplicate reference", async () => {
    const fake = new FakeTransferProvider({ defaultAccountName: "OKAFOR ADAEZE" });
    assert.equal((await fake.resolveAccount("0123456780", "058")).outcome, "not_found");
    const recipient = await fake.createRecipient({ accountName: "X", accountNumber: "0123456788", bankCode: "058" });
    assert.equal(recipient.outcome, "ok");
    if (recipient.outcome !== "ok") return;
    const request = { reference: REF, amount: kobo(100n), recipientCode: recipient.value.recipientCode, reason: "r" };
    const started = await fake.initiateTransfer(request);
    assert.equal(started.outcome === "ok" && started.value.status, "pending");
    const first = await fake.verifyTransfer(REF);
    assert.equal(first.outcome === "ok" && first.value.status, "success");
    const second = await fake.verifyTransfer(REF);
    assert.equal(second.outcome === "ok" && second.value.status, "reversed");
    assert.equal((await fake.initiateTransfer(request)).outcome, "refused");
  });
});
