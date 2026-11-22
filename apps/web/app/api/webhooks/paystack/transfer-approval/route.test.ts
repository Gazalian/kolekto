import { createHmac } from "node:crypto";

import { createPaystackTransferProvider } from "@kolekto/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * route.test.ts — /api/webhooks/paystack/transfer-approval. The database
 * decision (app.decide_transfer_approval) is proved in pgTAP; here the route's
 * fail-closed boundary: only an explicit approval is a 200.
 */

const SECRET_KEY = "sk_test_approval_route_stub_00000000000000000";
let transferContext: unknown = { db: () => null, provider: {} };
const answerTransferApproval = vi.fn();

vi.mock("../../../../../lib/payments/transfers.ts", () => ({ getTransferContext: () => transferContext }));
vi.mock("@kolekto/payments", () => ({ answerTransferApproval: (...a: unknown[]) => answerTransferApproval(...a) }));

const { POST, GET } = await import("./route.ts");

const BODY = JSON.stringify({ reference: "ktr_000000000000000000000001", amount: 8000000, recipient: "RCP_abcd1234" });
const req = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request("http://localhost/api/webhooks/paystack/transfer-approval", { method: "POST", body, headers });

beforeEach(() => {
  transferContext = { db: () => null, provider: createPaystackTransferProvider({ secretKey: SECRET_KEY }) };
  answerTransferApproval.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("transfer approval URL", () => {
  it("answers 200 only when the decision is approve", async () => {
    answerTransferApproval.mockResolvedValue({ httpStatus: 200, decision: "approve", reasonCode: "authorised" });
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    expect(answerTransferApproval).toHaveBeenCalledWith(expect.anything(), expect.any(Uint8Array), "absent");
  });

  it("answers 400 when the database rejects", async () => {
    answerTransferApproval.mockResolvedValue({ httpStatus: 400, decision: "reject", reasonCode: "member_not_verified" });
    const res = await POST(req(BODY));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ decision: "reject", reason: "member_not_verified" });
  });

  it("fails closed on an error", async () => {
    answerTransferApproval.mockRejectedValue(new Error("db down"));
    expect((await POST(req(BODY))).status).toBe(400);
  });

  // 2026-11-20: a dev server's cached provider predated authenticateApprovalRequest
  // and the route answered 500. It must be a 400, without deciding.
  it("fails closed (400, not 500) when the provider itself throws", async () => {
    transferContext = { db: () => null, provider: {} };
    const res = await POST(req(BODY));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ decision: "reject", reason: "error" });
    expect(answerTransferApproval).not.toHaveBeenCalled();
  });

  // 2026-11-20: a LIVE inbound credit (`Paystack Credit Request`) reached this
  // URL. It must never be decided by the outgoing logic, and must not get an
  // answer inside Paystack's documented 5-second inbound window.
  it("does not decide an inbound credit request and does not answer within 5 seconds", async () => {
    vi.useFakeTimers();
    try {
      const inbound = JSON.stringify({
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
      });
      let settled = false;
      const pending = POST(req(inbound)).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(5_500);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(7_000);
      const res = await pending;
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ decision: "reject", reason: "inbound_credit_not_handled" });
      expect(answerTransferApproval).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("decides a malformed JSON body promptly (rejected by the database decision, not held)", async () => {
    answerTransferApproval.mockResolvedValue({ httpStatus: 400, decision: "reject", reasonCode: "unknown_reference" });
    const res = await POST(req("{not json"));
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body without deciding", async () => {
    expect((await POST(req(BODY, { "content-type": "text/plain" }))).status).toBe(400);
    expect(answerTransferApproval).not.toHaveBeenCalled();
  });

  it("rejects when transfers are not configured", async () => {
    transferContext = null;
    expect((await POST(req(BODY))).status).toBe(400);
    expect(answerTransferApproval).not.toHaveBeenCalled();
  });

  it("rejects a signature header that does not verify, without deciding", async () => {
    const res = await POST(req(BODY, { "content-type": "application/json", "x-paystack-signature": "00".repeat(64) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ decision: "reject", reason: "signature_invalid" });
    expect(answerTransferApproval).not.toHaveBeenCalled();
  });

  it("passes signature 'valid' when the legacy signature verifies", async () => {
    answerTransferApproval.mockResolvedValue({ httpStatus: 200, decision: "approve", reasonCode: "authorised" });
    const sig = createHmac("sha512", SECRET_KEY).update(BODY).digest("hex");
    const res = await POST(req(BODY, { "content-type": "application/json", "x-paystack-signature": sig }));
    expect(res.status).toBe(200);
    expect(answerTransferApproval).toHaveBeenCalledWith(expect.anything(), expect.any(Uint8Array), "valid");
  });

  it("rejects a modern-only signature header it cannot verify", async () => {
    const res = await POST(req(BODY, { "content-type": "application/json", "paystack-signature": "t=1,v1=k:00" }));
    expect(res.status).toBe(400);
    expect(answerTransferApproval).not.toHaveBeenCalled();
  });

  it("rejects an oversized body", async () => {
    expect((await POST(req("x".repeat(70 * 1024)))).status).toBe(400);
  });

  it("405 for GET", async () => {
    expect((await GET()).status).toBe(405);
  });
});
