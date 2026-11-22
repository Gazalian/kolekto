/**
 * transfers.test.ts — the transfer orchestration's decisions, without a
 * database: what is sent, when, what is believed, and when a hold may be
 * released (PA-08 / PA-09, 20261119120000).
 *
 * The money rules themselves (journals, holds, release eligibility, leases,
 * backoff, escalation) are proved against the real functions in pgTAP
 * (supabase/tests/63, 69). Here a scripted database records every function
 * the orchestration calls and answers what the test says the database would
 * answer; the offline FakeTransferProvider plays Paystack.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeTransferProvider, type InitiateTransferRequest, type TransferProvider } from "@kolekto/adapters";
import type { PaymentDb } from "@kolekto/db";

import {
  checkWithdrawalTransfers,
  confirmWithdrawalTransfer,
  dispatchWithdrawalTransfers,
  isDuplicateReferenceRefusal,
  isTransientRefusal,
} from "../src/transfers.ts";

const REF1 = "ktr_000000000000000000000001";
const TOKEN = "01900000-0000-7000-8000-000000000001";

interface ClaimRow {
  withdrawal_id: string;
  withdrawal_reference: string;
  transfer_reference: string;
  amount_kobo: string;
  bank_account_id: string;
  recipient_code: string | null;
  bank_code: string;
  account_number: string;
  account_name: string;
  claim_token: string;
}
interface DueRow {
  transfer_reference: string;
  status: "initiating" | "pending" | "otp" | "unknown";
  transfer_code: string | null;
  amount_kobo: string;
  recipient_code: string | null;
  bank_account_id: string | null;
  check_count: number;
  not_found_count: number;
  initiate_requested_at: Date | null;
  refused_at: Date | null;
  refusal_code: string | null;
  escalated_at: Date | null;
  created_at: Date;
  claim_token: string;
  withdrawal_reference: string | null;
}
interface CheckAnswer {
  resend_allowed?: boolean;
  release_eligible?: boolean;
  stale?: boolean;
  escalated?: boolean;
}

const claimRow = (accountNumber: string, recipient: string | null = null, amount = 8_000_000n): ClaimRow => ({
  withdrawal_id: "w-1",
  withdrawal_reference: "KWD-01",
  transfer_reference: REF1,
  amount_kobo: amount.toString(),
  bank_account_id: "b-1",
  recipient_code: recipient,
  bank_code: "058",
  account_number: accountNumber,
  account_name: "OKAFOR ADAEZE",
  claim_token: TOKEN,
});
const dueRow = (over: Partial<DueRow> = {}): DueRow => ({
  transfer_reference: REF1,
  status: "unknown",
  transfer_code: null,
  amount_kobo: "8000000",
  recipient_code: "RCP_fake0580123456781",
  bank_account_id: "b-1",
  check_count: 1,
  not_found_count: 0,
  initiate_requested_at: new Date("2026-11-19T10:00:00Z"),
  refused_at: null,
  refusal_code: null,
  escalated_at: null,
  created_at: new Date("2026-11-19T10:00:00Z"),
  claim_token: TOKEN,
  withdrawal_reference: "KWD-01",
  ...over,
});

/**
 * A PaymentDb that recognises which function was called, records it, and
 * answers from the script. `checkAnswers` answers successive
 * record_withdrawal_transfer_check calls that report not_found.
 */
function scriptedDb(script: {
  claims?: ClaimRow[];
  due?: DueRow[];
  markOk?: boolean;
  notFoundAnswers?: CheckAnswer[];
  staleOnFirstCheck?: boolean;
  releaseOutcome?: string;
} = {}) {
  const calls: string[] = [];
  const notFoundAnswers = [...(script.notFoundAnswers ?? [])];
  let checks = 0;
  const db: PaymentDb = async (fn) => {
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      const v = values.map((x) => (x === null || x === undefined ? "null" : String(x)));
      if (text.includes("app.claim_withdrawal_transfers_to_check")) return Promise.resolve(script.due ?? []);
      if (text.includes("app.claim_withdrawal_transfers(")) return Promise.resolve(script.claims ?? []);
      if (text.includes("app.set_bank_account_recipient")) {
        calls.push(`recipient:${v[0]}:${v[1]}`);
        return Promise.resolve([{}]);
      }
      if (text.includes("app.mark_withdrawal_transfer_initiating")) {
        calls.push(`mark:${v[0]}`);
        return Promise.resolve([{ ok: script.markOk ?? true }]);
      }
      if (text.includes("app.record_withdrawal_transfer_check")) {
        // ref, token, source, worker, result, pstatus, pcode, newStatus, recipient, code, id, outcome, note, release
        calls.push(`check:${v[4]}:${v[11]}:status=${v[7]}:code=${v[6]}:keep=${v[13] === "false"}`);
        checks += 1;
        const answer: CheckAnswer = v[4] === "not_found" ? (notFoundAnswers.shift() ?? {}) : {};
        return Promise.resolve([
          {
            status: v[7] === "null" ? "unknown" : v[7],
            check_count: checks,
            not_found_count: 0,
            next_check_at: null,
            escalated: answer.escalated ?? false,
            resend_allowed: answer.resend_allowed ?? false,
            release_eligible: answer.release_eligible ?? false,
            stale: script.staleOnFirstCheck === true && checks === 1 ? true : (answer.stale ?? false),
          },
        ]);
      }
      if (text.includes("app.release_withdrawal_transfer_claim")) {
        calls.push(`unclaim:${v[0]}`);
        return Promise.resolve([{ ok: true }]);
      }
      if (text.includes("app.release_withdrawal_transfer_never_sent")) {
        calls.push(`release_never_sent:${v[0]}`);
        return Promise.resolve([{ outcome: script.releaseOutcome ?? "failed" }]);
      }
      if (text.includes("app.settle_withdrawal_transfer")) {
        calls.push(`settle:${v[0]}:${v[1]}:amount=${v[2]}:code=${v[3]}:fee=${v[4]}`);
        const outcome = v[1] === "success" ? "paid" : v[1] === "failed" ? "failed" : "reversed";
        return Promise.resolve([{ outcome }]);
      }
      return Promise.reject(new Error(`unexpected SQL: ${text}`));
    };
    return fn(tx as never);
  };
  return { db, calls };
}

/** Wraps a provider and counts initiations, so "never sent twice" is checkable. */
function counting(inner: TransferProvider, overrides: Partial<TransferProvider> = {}) {
  const sent: string[] = [];
  const provider: TransferProvider = {
    name: inner.name,
    testMode: inner.testMode,
    listBanks: () => inner.listBanks(),
    resolveAccount: (n, b) => inner.resolveAccount(n, b),
    createRecipient: (r) => inner.createRecipient(r),
    getBalance: () => inner.getBalance(),
    initiateTransfer: (r: InitiateTransferRequest) => {
      sent.push(r.reference);
      return inner.initiateTransfer(r);
    },
    verifyTransfer: (ref: string) => inner.verifyTransfer(ref),
    listTransfers: (q) => inner.listTransfers(q),
    authenticateApprovalRequest: (b, h) => inner.authenticateApprovalRequest(b, h),
    ...overrides,
  };
  return { provider, sent };
}

const refusing = (providerCode: string | null, message: string): Partial<TransferProvider> => ({
  initiateTransfer: async () => ({ outcome: "refused", providerCode, message }),
});

describe("dispatchWithdrawalTransfers", () => {
  it("creates the recipient, pins it, marks the send before calling Paystack, sends once, does not settle on the initiate response", async () => {
    const fake = new FakeTransferProvider();
    const { provider, sent } = counting(fake);
    const { db, calls } = scriptedDb({ claims: [claimRow("0123456781")] });

    const report = await dispatchWithdrawalTransfers({ db, provider });

    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "initiated" }]);
    assert.deepEqual(sent, [REF1]);
    assert.deepEqual(calls, [
      `recipient:b-1:RCP_fake0580123456781`,
      `check:not_called:recipient_pinned:status=null:code=null:keep=true`,
      `mark:${REF1}`,
      `check:ok:initiated:status=pending:code=null:keep=false`,
    ]);
    assert.equal(calls.filter((c) => c.startsWith("settle")).length, 0);
  });

  it("does not call Paystack when the database refuses the 'initiate requested' mark (claim lost)", async () => {
    const { provider, sent } = counting(new FakeTransferProvider());
    const { db } = scriptedDb({ claims: [claimRow("0123456781", "RCP_x1234")], markOk: false });
    const report = await dispatchWithdrawalTransfers({ db, provider });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "stale_claim" }]);
    assert.deepEqual(sent, []);
  });

  it("waits (no send, no mark) while the Paystack balance does not cover the amount", async () => {
    const fake = new FakeTransferProvider({ balance: 100n as never });
    await fake.createRecipient({ accountName: "X", accountNumber: "0123456781", bankCode: "058" });
    const { provider, sent } = counting(fake);
    const { db, calls } = scriptedDb({ claims: [claimRow("0123456781", "RCP_fake0580123456781")] });
    const report = await dispatchWithdrawalTransfers({ db, provider });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "insufficient_provider_balance" }]);
    assert.deepEqual(sent, []);
    assert.equal(calls.some((c) => c.startsWith("mark:")), false);
  });

  it("P8-1: a timeout is verified at once; NOT FOUND keeps the money reserved and sends nothing else", async () => {
    const { provider, sent } = counting(new FakeTransferProvider(), {
      initiateTransfer: async (r) => {
        sent.push(r.reference);
        return { outcome: "unknown", reason: "paystack_request_timeout", safeToRetry: false };
      },
    });
    const { db, calls } = scriptedDb({ claims: [claimRow("0123456781", "RCP_x1234")] });
    const report = await dispatchWithdrawalTransfers({ db, provider });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "not_found" }]);
    assert.deepEqual(sent, [REF1]);
    assert.ok(calls.includes(`check:unavailable:initiate_ambiguous:status=unknown:code=null:keep=true`));
    assert.ok(calls.includes(`check:not_found:not_found:status=unknown:code=null:keep=true`));
    assert.equal(calls.some((c) => c.startsWith("settle") || c.startsWith("release_never_sent")), false);
    assert.equal(calls.at(-1), `unclaim:${REF1}`);
  });

  it("P8-1: a refusal followed by one NOT FOUND does not release the hold", async () => {
    const { provider } = counting(new FakeTransferProvider(), refusing("invalid_params", "Invalid recipient"));
    const { db, calls } = scriptedDb({ claims: [claimRow("0123456781", "RCP_x1234")] });
    await dispatchWithdrawalTransfers({ db, provider });
    assert.ok(calls.includes(`check:refused:initiate_refused:status=unknown:code=invalid_params:keep=true`));
    assert.equal(calls.some((c) => c.startsWith("settle") || c.startsWith("release_never_sent")), false);
  });

  it("a duplicate-reference refusal is recorded as such and never releases", async () => {
    const { provider } = counting(new FakeTransferProvider(), refusing(null, "Duplicate Transfer Reference"));
    const { db, calls } = scriptedDb({ claims: [claimRow("0123456781", "RCP_x1234")] });
    await dispatchWithdrawalTransfers({ db, provider });
    assert.ok(calls.includes(`check:refused:initiate_duplicate_reference:status=unknown:code=duplicate_transfer_reference:keep=true`));
    assert.equal(calls.some((c) => c.startsWith("release_never_sent")), false);
  });

  it("a rate-limit refusal is recorded as 'unavailable' (it can never count towards a release)", async () => {
    const { provider } = counting(new FakeTransferProvider(), refusing("http_429", "Too many requests"));
    const { db, calls } = scriptedDb({ claims: [claimRow("0123456781", "RCP_x1234")] });
    await dispatchWithdrawalTransfers({ db, provider });
    assert.ok(calls.includes(`check:unavailable:initiate_refused_transient:status=unknown:code=http_429:keep=true`));
  });

  it("does not re-send immediately after an ambiguous send even when the database would allow a resend", async () => {
    const { provider, sent } = counting(new FakeTransferProvider(), {
      initiateTransfer: async (r) => {
        sent.push(r.reference);
        return { outcome: "unknown", reason: "paystack_http_502", safeToRetry: false };
      },
    });
    const { db } = scriptedDb({ claims: [claimRow("0123456781", "RCP_x1234")], notFoundAnswers: [{ resend_allowed: true }] });
    await dispatchWithdrawalTransfers({ db, provider });
    assert.deepEqual(sent, [REF1]);
  });
});

describe("checkWithdrawalTransfers", () => {
  it("settles a success Paystack confirms, with the reported fee, and logs the check", async () => {
    const fake = new FakeTransferProvider();
    await fake.createRecipient({ accountName: "X", accountNumber: "0123456781", bankCode: "058" });
    await fake.initiateTransfer({ reference: REF1, amount: 8_000_000n as never, recipientCode: "RCP_fake0580123456781", reason: "t" });
    const { db, calls } = scriptedDb({ due: [dueRow({ status: "pending" })] });
    const report = await checkWithdrawalTransfers({ db, provider: fake }, { limit: 10, mayInitiate: true });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "paid" }]);
    assert.ok(calls.includes(`settle:${REF1}:success:amount=8000000:code=TRF_fake000001:fee=2500`));
    assert.ok(calls.includes(`check:ok:paid:status=null:code=null:keep=false`));
  });

  it("releases only when the DATABASE says the transfer is release-eligible", async () => {
    const { provider, sent } = counting(new FakeTransferProvider());
    const { db, calls } = scriptedDb({
      due: [dueRow({ refused_at: new Date("2026-11-19T10:00:00Z"), refusal_code: "invalid_params", not_found_count: 2 })],
      notFoundAnswers: [{ release_eligible: true }],
    });
    const report = await checkWithdrawalTransfers({ db, provider }, { limit: 10, mayInitiate: true });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "released_never_sent" }]);
    assert.ok(calls.includes(`release_never_sent:${REF1}`));
    assert.deepEqual(sent, []);
  });

  it("NOT FOUND while not release-eligible keeps the hold and ends the claim", async () => {
    const { provider } = counting(new FakeTransferProvider());
    const { db, calls } = scriptedDb({ due: [dueRow()], notFoundAnswers: [{}] });
    const report = await checkWithdrawalTransfers({ db, provider }, { limit: 10, mayInitiate: true });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "not_found" }]);
    assert.equal(calls.some((c) => c.startsWith("release_never_sent") || c.startsWith("settle")), false);
    assert.equal(calls.at(-1), `unclaim:${REF1}`);
  });

  it("reports escalation without releasing", async () => {
    const { provider } = counting(new FakeTransferProvider());
    const { db, calls } = scriptedDb({ due: [dueRow()], notFoundAnswers: [{ escalated: true }] });
    const report = await checkWithdrawalTransfers({ db, provider }, { limit: 10, mayInitiate: true });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "escalated" }]);
    assert.equal(calls.some((c) => c.startsWith("release_never_sent") || c.startsWith("settle")), false);
  });

  it("re-sends under the SAME reference only when the database allows it and sending is on", async () => {
    const fake = new FakeTransferProvider();
    await fake.createRecipient({ accountName: "X", accountNumber: "0123456781", bankCode: "058" });
    const a = counting(fake);
    const run = scriptedDb({ due: [dueRow({ recipient_code: "RCP_fake0580123456781", not_found_count: 1 })], notFoundAnswers: [{ resend_allowed: true }] });
    await checkWithdrawalTransfers({ db: run.db, provider: a.provider }, { limit: 10, mayInitiate: true });
    assert.deepEqual(a.sent, [REF1]);

    const b = counting(new FakeTransferProvider());
    const off = scriptedDb({ due: [dueRow({ not_found_count: 1 })], notFoundAnswers: [{ resend_allowed: true }] });
    await checkWithdrawalTransfers({ db: off.db, provider: b.provider }, { limit: 10, mayInitiate: false });
    assert.deepEqual(b.sent, []);
  });

  it("a transfer never sent and without a recipient is released (nothing can have moved)", async () => {
    const { provider, sent } = counting(new FakeTransferProvider());
    const { db, calls } = scriptedDb({ due: [dueRow({ status: "initiating", recipient_code: null, initiate_requested_at: null })] });
    const report = await checkWithdrawalTransfers({ db, provider }, { limit: 10, mayInitiate: true });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "released_never_sent" }]);
    assert.ok(calls.includes(`release_never_sent:${REF1}`));
    assert.deepEqual(sent, []);
  });

  it("a transfer never sent is not sent while transfers are switched off", async () => {
    const { provider, sent } = counting(new FakeTransferProvider());
    const { db, calls } = scriptedDb({ due: [dueRow({ status: "initiating", initiate_requested_at: null })] });
    const report = await checkWithdrawalTransfers({ db, provider }, { limit: 10, mayInitiate: false });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "not_sent" }]);
    assert.ok(calls.includes(`check:not_called:transfers_disabled:status=null:code=null:keep=false`));
    assert.deepEqual(sent, []);
  });

  it("a stale claim stops all further action", async () => {
    const { provider, sent } = counting(new FakeTransferProvider());
    const { db, calls } = scriptedDb({ due: [dueRow()], staleOnFirstCheck: true, notFoundAnswers: [{ release_eligible: true, resend_allowed: true }] });
    const report = await checkWithdrawalTransfers({ db, provider }, { limit: 10, mayInitiate: true });
    assert.deepEqual(report.outcomes, [{ reference: REF1, outcome: "stale_claim" }]);
    assert.equal(calls.some((c) => c.startsWith("release_never_sent") || c.startsWith("unclaim")), false);
    assert.deepEqual(sent, []);
  });
});

describe("confirmWithdrawalTransfer (webhook)", () => {
  it("a NOT FOUND from a webhook writes nothing (it must not count towards a release)", async () => {
    const { db, calls } = scriptedDb();
    assert.equal(await confirmWithdrawalTransfer({ db, provider: new FakeTransferProvider() }, REF1), "not_found");
    assert.deepEqual(calls, []);
  });

  it("settles what verify reports, logged without a claim", async () => {
    const fake = new FakeTransferProvider();
    await fake.createRecipient({ accountName: "X", accountNumber: "0123456789", bankCode: "058" });
    await fake.initiateTransfer({ reference: REF1, amount: 500n as never, recipientCode: "RCP_fake0580123456789", reason: "t" });
    const { db, calls } = scriptedDb();
    assert.equal(await confirmWithdrawalTransfer({ db, provider: fake }, REF1), "failed");
    assert.ok(calls.includes(`settle:${REF1}:failed:amount=500:code=TRF_fake000001:fee=null`));
  });
});

describe("refusal classification", () => {
  it("recognises duplicate references", () => {
    assert.equal(isDuplicateReferenceRefusal("duplicate_reference", "x"), true);
    assert.equal(isDuplicateReferenceRefusal(null, "Duplicate Transfer Reference"), true);
    assert.equal(isDuplicateReferenceRefusal("invalid_params", "Invalid recipient"), false);
  });
  it("treats rate limits, auth and balance as transient", () => {
    for (const code of ["http_429", "http_401", "http_403", "insufficient_balance"]) assert.equal(isTransientRefusal(code, "x"), true);
    assert.equal(isTransientRefusal(null, "Your balance is not enough to fulfil this request"), true);
    assert.equal(isTransientRefusal("invalid_params", "Invalid recipient"), false);
  });
});
