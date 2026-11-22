/**
 * withdrawal-transfers.test.ts — what the payout stage may do on this worker,
 * and that its log line carries counts only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeTransferProvider } from "@kolekto/adapters";

import { decideWithdrawalTransfers, transferLogLine } from "../src/withdrawal-transfers.ts";

describe("decideWithdrawalTransfers", () => {
  const provider = new FakeTransferProvider();

  it("is off without the operator functions or a Paystack key", () => {
    assert.deepEqual(decideWithdrawalTransfers({ functionsOk: false, provider, transfersEnabled: true }), {
      enabled: false,
      reason: "transfer_functions_missing_or_not_executable",
    });
    assert.deepEqual(decideWithdrawalTransfers({ functionsOk: true, provider: null, transfersEnabled: true }), {
      enabled: false,
      reason: "no_paystack_key",
    });
  });

  it("finishes in-flight transfers with the flag off, but never dispatches", () => {
    assert.deepEqual(decideWithdrawalTransfers({ functionsOk: true, provider, transfersEnabled: false }), {
      enabled: true,
      dispatch: false,
      testMode: true,
    });
    assert.deepEqual(decideWithdrawalTransfers({ functionsOk: true, provider, transfersEnabled: true }), {
      enabled: true,
      dispatch: true,
      testMode: true,
    });
  });
});

describe("transferLogLine", () => {
  it("is silent when nothing happened and counts outcomes without references", () => {
    assert.equal(transferLogLine("check", { outcomes: [] }), null);
    const line = transferLogLine("dispatch", {
      outcomes: [
        { reference: "ktr_000000000000000000000001", outcome: "initiated" },
        { reference: "ktr_000000000000000000000002", outcome: "initiated" },
        { reference: "ktr_000000000000000000000003", outcome: "insufficient_provider_balance" },
      ],
    });
    assert.deepEqual(line, { msg: "withdrawal_transfers", stage: "dispatch", examined: 3, initiated: 2, insufficient_provider_balance: 1 });
    assert.equal(JSON.stringify(line).includes("ktr_"), false);
  });
});
