/**
 * Transfer approval URL parsing and signature check, and the transfer list
 * used by the reconciliation report (owner decisions 2026-11-19; P8-4).
 * Paystack is stubbed: nothing here calls the network.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { kobo } from "@kolekto/domain";

import { createPaystackTransferProvider } from "../src/paystack-transfer-provider.ts";
import { FakeTransferProvider } from "../src/fake-transfer-provider.ts";
import { isInboundCreditRequest, parseTransferApprovalRequest } from "../src/transfer-provider.ts";

const SECRET = "sk_test_stub_0000";
const API = "https://sandbox.paystack.test";
const provider = createPaystackTransferProvider({ secretKey: SECRET, apiBase: API, requestTimeoutMs: 200 });
const REF = "ktr_0123456789abcdef01234567";
const body = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

const originalFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];
function stub(fn: (url: string, init: RequestInit) => Response): void {
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
const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

describe("authenticateApprovalRequest", () => {
  const raw = body({ reference: REF, amount: 1000000, recipient: "RCP_abc12345" });
  const good = createHmac("sha512", SECRET).update(Buffer.from(raw)).digest("hex");

  it("accepts Paystack's webhook signature computed with the secret key", () => {
    assert.equal(provider.authenticateApprovalRequest(raw, { "x-paystack-signature": good }), "valid");
    assert.equal(provider.authenticateApprovalRequest(raw, { "x-paystack-signature": ` ${good.toUpperCase()} ` }), "valid");
  });

  it("rejects a wrong, truncated or other-body signature", () => {
    assert.equal(provider.authenticateApprovalRequest(raw, { "x-paystack-signature": "0".repeat(128) }), "invalid");
    assert.equal(provider.authenticateApprovalRequest(raw, { "x-paystack-signature": good.slice(0, 64) }), "invalid");
    assert.equal(provider.authenticateApprovalRequest(body({ reference: REF, amount: 1 }), { "x-paystack-signature": good }), "invalid");
  });

  it("treats a signature header it cannot check as invalid (fail closed)", () => {
    assert.equal(provider.authenticateApprovalRequest(raw, { "paystack-signature": "t=1,v1=abc" }), "invalid");
  });

  it("reports no signature as absent (Paystack documents none)", () => {
    assert.equal(provider.authenticateApprovalRequest(raw, {}), "absent");
  });

  it("the fake signs nothing: any signature header is invalid", () => {
    const fake = new FakeTransferProvider();
    assert.equal(fake.authenticateApprovalRequest(raw, {}), "absent");
    assert.equal(fake.authenticateApprovalRequest(raw, { "x-paystack-signature": good }), "invalid");
    assert.equal(fake.authenticateApprovalRequest(raw, { "paystack-signature": "x" }), "invalid");
  });
});

describe("listTransfers", () => {
  const from = new Date("2026-11-12T00:00:00.000Z");
  const to = new Date("2026-11-19T00:00:00.000Z");

  it("pages Paystack's transfer list read-only, counting what it cannot parse", async () => {
    stub(() =>
      json(200, {
        status: true,
        data: [
          { reference: REF, amount: 1000000, status: "otp", transfer_code: "TRF_abcd1234", id: 77,
            recipient: { recipient_code: "RCP_abc12345" }, createdAt: "2026-11-18T10:00:00.000Z" },
          { reference: "kprobe_seq_1795094234", amount: 10000, status: "otp", recipient: "RCP_probe0001", created_at: "2026-11-18T11:00:00.000Z" },
          { amount: 5, status: "success" },
          "garbage",
        ],
        meta: { pageCount: 3 },
      }),
    );
    const r = await provider.listTransfers({ from, to, page: 2, perPage: 500 });
    assert.equal(r.outcome, "ok");
    if (r.outcome !== "ok") return;
    assert.equal(r.value.pageCount, 3);
    assert.equal(r.value.unparseable, 2);
    assert.deepEqual(
      r.value.items.map((t) => [t.reference, t.status, t.amount, t.recipientCode, t.createdAt]),
      [
        [REF, "otp", 1000000n, "RCP_abc12345", "2026-11-18T10:00:00.000Z"],
        ["kprobe_seq_1795094234", "otp", 10000n, "RCP_probe0001", "2026-11-18T11:00:00.000Z"],
      ],
    );
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(calls[0]!.init.method, "GET");
    assert.equal(url.pathname, "/transfer");
    assert.equal(url.searchParams.get("perPage"), "100", "page size is capped at 100");
    assert.equal(url.searchParams.get("page"), "2");
    assert.equal(url.searchParams.get("from"), from.toISOString());
    assert.equal(url.searchParams.get("to"), to.toISOString());
  });

  it("an unreadable list or a 5xx is unknown, never an empty list", async () => {
    stub(() => json(200, { status: true, data: { not: "a list" } }));
    assert.equal((await provider.listTransfers({ from, to, page: 1, perPage: 50 })).outcome, "unknown");
    stub(() => json(503, { status: false }));
    assert.equal((await provider.listTransfers({ from, to, page: 1, perPage: 50 })).outcome, "unknown");
  });

  it("the fake lists stored transfers in the window, paged", async () => {
    let now = Date.parse("2026-11-15T00:00:00.000Z");
    const fake = new FakeTransferProvider({ clock: () => now });
    const { value: rcp } = (await fake.createRecipient({ bankCode: "058", accountNumber: "0123456781", accountName: "A B" })) as {
      value: { recipientCode: string };
    };
    for (let i = 0; i < 3; i += 1) {
      await fake.initiateTransfer({ reference: `ktr_${String(i).padStart(24, "0")}`, amount: kobo(100n), recipientCode: rcp.recipientCode, reason: "r" });
      now += 24 * 3600 * 1000;
    }
    const r = await fake.listTransfers({ from, to: new Date("2026-11-16T12:00:00.000Z"), page: 1, perPage: 1 });
    assert.equal(r.outcome, "ok");
    if (r.outcome !== "ok") return;
    assert.equal(r.value.pageCount, 2, "two of the three fall in the window");
    assert.equal(r.value.items.length, 1);
    assert.equal(r.value.items[0]!.recipientCode, rcp.recipientCode);
  });
});

// 2026-11-20: Paystack's INBOUND credit request (a customer paying in) reached
// the outgoing transfer approval URL. It must be recognised, never parsed as an
// outgoing approval, and an outgoing approval must never look like it.
describe("isInboundCreditRequest", () => {
  const inbound = {
    payer_account_number: "0000000000",
    payer_account_name: "SYNTHETIC",
    payer_bank_code: "000",
    payer_bank_name: "Synthetic",
    receiver_account_number: "0000000000",
    receiver_account_name: "SYNTHETIC",
    receiver_account_type: "bank_transfer",
    session_id: "SYNTHETIC-SESSION",
    sent_at: "2026-11-20T08:54:30.872Z",
    provider: "titan-paystack",
    amount: 51000,
    narration: "synthetic",
  };

  it("recognises the inbound credit request shape, which has no transfer reference", () => {
    assert.equal(isInboundCreditRequest(body(inbound)), true);
    assert.deepEqual(parseTransferApprovalRequest(body(inbound)), { ok: false, rejection: "payload_malformed", reference: null });
  });

  it("never treats an outgoing approval request as inbound", () => {
    assert.equal(isInboundCreditRequest(body({ reference: REF, amount: 10000, recipient: "RCP_abcd1234" })), false);
    assert.equal(isInboundCreditRequest(body({ data: { reference: REF, amount: 10000 } })), false);
    // Even with inbound-looking fields, a transfer reference makes it outgoing.
    assert.equal(isInboundCreditRequest(body({ ...inbound, reference: REF })), false);
  });

  it("is false for malformed or unrelated bodies", () => {
    assert.equal(isInboundCreditRequest(body("{not json")), false);
    assert.equal(isInboundCreditRequest(body([inbound])), false);
    assert.equal(isInboundCreditRequest(body({ session_id: "x" })), false);
    assert.equal(isInboundCreditRequest(body({ amount: 1 })), false);
  });
});


// ── The real Paystack approval request ──────────────────────────────────────
// The fixture is the body Paystack TEST sent on 2026-11-20 10:45:09 UTC,
// with personal and account values replaced (structure, field names, types and
// relationships unchanged). Kolekto's previous parser answered it 400
// `unknown_reference`, because it read the reference only at the top level or
// under `data`, while Paystack sends it under data.details.body and
// data.transfers[].
describe("parseTransferApprovalRequest — Paystack's transferrequest.approval-required request", () => {
  const fixtureText = readFileSync(new URL("./fixtures/paystack-transfer-approval-request.redacted.json", import.meta.url), "utf8");
  const FIX_REF = "ktr_000000000000000000000f17";
  const FIX_RCP = "RCP_fixture0000001";
  type Fixture = {
    event: string;
    data: { details: { body: Record<string, unknown>; endpoint: string }; transfers: Record<string, unknown>[] } & Record<string, unknown>;
  };
  const real = (): Fixture => JSON.parse(fixtureText) as Fixture;
  const parse = (value: unknown) => parseTransferApprovalRequest(body(value));
  const rejection = (value: unknown): string => {
    const r = parse(value);
    return r.ok ? "ok" : `${r.rejection}:${r.reference ?? "-"}`;
  };

  it("regression: the exact body that was answered unknown_reference now parses", () => {
    assert.deepEqual(parseTransferApprovalRequest(new TextEncoder().encode(fixtureText)), {
      ok: true,
      request: { reference: FIX_REF, amountKobo: 10000n, currency: "NGN", recipientCode: FIX_RCP, transferCode: "TRF_fixture00000001" },
    });
  });

  it("the fixture keeps the observed structure and carries no unredacted account data", () => {
    const f = real();
    assert.equal(f.event, "transferrequest.approval-required");
    assert.equal(f.data.details.endpoint, "/transfer");
    assert.equal(typeof f.data.details.body["amount"], "string", "the request body carries the amount as a string");
    assert.equal(typeof f.data.transfers[0]!["amount"], "number", "the record carries it as a number");
    assert.equal(f.data.details.body["reference"], f.data.transfers[0]!["reference"]);
    assert.doesNotMatch(fixtureText, /\b(?!0{10})\d{10}\b/, "no real 10-digit account number");
    assert.doesNotMatch(fixtureText, /sk_(test|live)_/);
  });

  it("is not mistaken for an inbound credit request", () => {
    assert.equal(isInboundCreditRequest(new TextEncoder().encode(fixtureText)), false);
  });

  it("malformed JSON and other shapes are payload_malformed (never guessed)", () => {
    assert.equal(rejection("not json"), "payload_malformed:-");
    assert.equal(rejection([real()]), "payload_malformed:-");
    assert.equal(rejection({ ...real(), event: "transfer.success" }), "payload_malformed:-");
    assert.equal(rejection({ event: "transferrequest.approval-required" }), "payload_malformed:-");
    // The old guessed shapes are no longer accepted.
    assert.equal(rejection({ reference: FIX_REF, amount: 10000, recipient: FIX_RCP }), "payload_malformed:-");
    assert.equal(rejection({ data: { reference: FIX_REF, amount: 10000, recipient: FIX_RCP } }), "payload_malformed:-");
  });

  it("missing details.body, or a body for another endpoint, is payload_body_missing", () => {
    const noBody = real();
    delete (noBody.data.details as Record<string, unknown>)["body"];
    assert.equal(rejection(noBody), "payload_body_missing:-");
    const noDetails = real();
    delete (noDetails.data as Record<string, unknown>)["details"];
    assert.equal(rejection(noDetails), "payload_body_missing:-");
    const bulk = real();
    bulk.data.details.endpoint = "/transfer/bulk";
    assert.equal(rejection(bulk), "payload_body_missing:-");
  });

  it("missing or empty transfers[] is payload_transfers_missing (with the body's reference)", () => {
    const none = real();
    delete (none.data as Record<string, unknown>)["transfers"];
    assert.equal(rejection(none), `payload_transfers_missing:${FIX_REF}`);
    const empty = real();
    empty.data.transfers = [];
    assert.equal(rejection(empty), `payload_transfers_missing:${FIX_REF}`);
    const keyed = real();
    (keyed.data as Record<string, unknown>)["transfers"] = { 0: keyed.data.transfers[0] };
    assert.equal(rejection(keyed), `payload_transfers_missing:${FIX_REF}`, "an index-keyed object was never observed");
  });

  it("several transfers are refused even when one matches (a 200 would approve them all)", () => {
    const two = real();
    two.data.transfers = [two.data.transfers[0]!, { ...two.data.transfers[0]!, reference: "ktr_ffffffffffffffffffffffff" }];
    assert.equal(rejection(two), `payload_multiple_transfers:${FIX_REF}`);
    const dup = real();
    dup.data.transfers = [dup.data.transfers[0]!, dup.data.transfers[0]!];
    assert.equal(rejection(dup), `payload_multiple_transfers:${FIX_REF}`);
  });

  it("a missing or unreadable required field is payload_field_invalid", () => {
    const recipientOf = (f: Fixture) => f.data.transfers[0]!["recipient"] as Record<string, unknown>;
    const cases: [string, (f: Fixture) => void][] = [
      ["body reference missing", (f) => { delete f.data.details.body["reference"]; }],
      ["body reference not ktr_", (f) => { f.data.details.body["reference"] = "kolekto-123"; }],
      ["body amount missing", (f) => { delete f.data.details.body["amount"]; }],
      ["body amount fractional", (f) => { f.data.details.body["amount"] = "100.5"; }],
      ["body amount zero", (f) => { f.data.details.body["amount"] = "0"; }],
      ["body amount negative", (f) => { f.data.details.body["amount"] = -10000; }],
      ["body currency missing", (f) => { delete f.data.details.body["currency"]; }],
      ["body currency lower-case", (f) => { f.data.details.body["currency"] = "ngn"; }],
      ["body recipient missing", (f) => { delete f.data.details.body["recipient"]; }],
      ["body recipient as object", (f) => { f.data.details.body["recipient"] = { recipientCode: FIX_RCP }; }],
      ["record reference missing", (f) => { delete f.data.transfers[0]!["reference"]; }],
      ["record amount as float", (f) => { f.data.transfers[0]!["amount"] = 10000.5; }],
      ["record currency missing", (f) => { delete f.data.transfers[0]!["currency"]; }],
      ["record recipient code missing", (f) => { delete recipientOf(f)["recipientCode"]; }],
      ["record recipient not an object", (f) => { f.data.transfers[0]!["recipient"] = FIX_RCP; }],
      ["record transfer code missing", (f) => { delete f.data.transfers[0]!["transfer_code"]; }],
      ["record status not received", (f) => { f.data.transfers[0]!["status"] = "success"; }],
      ["record not an object", (f) => { (f.data.transfers as unknown[])[0] = "x"; }],
    ];
    for (const [label, mutate] of cases) {
      const f = real();
      mutate(f);
      const r = parse(f);
      assert.equal(r.ok, false, label);
      if (!r.ok) assert.equal(r.rejection, "payload_field_invalid", label);
    }
    const noRef = real();
    delete noRef.data.details.body["reference"];
    assert.equal(rejection(noRef), "payload_field_invalid:-", "no reference: nothing to link");
  });

  it("details.body and transfers[] must describe the same transfer (payload_mismatch)", () => {
    const recipientOf = (f: Fixture) => f.data.transfers[0]!["recipient"] as Record<string, unknown>;
    const cases: [string, (f: Fixture) => void][] = [
      ["reference", (f) => { f.data.transfers[0]!["reference"] = "ktr_ffffffffffffffffffffffff"; }],
      ["amount", (f) => { f.data.details.body["amount"] = "10001"; }],
      ["amount (record)", (f) => { f.data.transfers[0]!["amount"] = 9999; }],
      ["currency", (f) => { f.data.transfers[0]!["currency"] = "USD"; }],
      ["recipient", (f) => { f.data.details.body["recipient"] = "RCP_someoneelse01"; }],
      ["recipient (record)", (f) => { recipientOf(f)["recipientCode"] = "RCP_someoneelse01"; }],
    ];
    for (const [label, mutate] of cases) {
      const f = real();
      mutate(f);
      assert.equal(rejection(f), `payload_mismatch:${FIX_REF}`, label);
    }
  });

  it("a consistent non-NGN currency parses; the database refuses it (currency_mismatch)", () => {
    const usd = real();
    usd.data.details.body["currency"] = "USD";
    usd.data.transfers[0]!["currency"] = "USD";
    const r = parse(usd);
    assert.equal(r.ok && r.request.currency, "USD");
  });

  it("a valid signature over the real body verifies; any change to it does not", () => {
    const raw = new TextEncoder().encode(fixtureText);
    const sig = createHmac("sha512", SECRET).update(Buffer.from(raw)).digest("hex");
    assert.equal(provider.authenticateApprovalRequest(raw, { "x-paystack-signature": sig }), "valid");
    const tamperedText = fixtureText.replace('"amount": "10000"', '"amount": "90000"');
    assert.notEqual(tamperedText, fixtureText);
    assert.equal(provider.authenticateApprovalRequest(new TextEncoder().encode(tamperedText), { "x-paystack-signature": sig }), "invalid");
  });
});
