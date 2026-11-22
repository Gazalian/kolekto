/**
 * The transfer reconciliation report (P8-4) and the approval-URL answer
 * (owner decision 2026-11-19), without a database: a scripted PaymentDb
 * answers the two or three functions each calls. The decision rules
 * themselves are proved against the real functions in pgTAP (70).
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeTransferProvider, type TransferProvider, type TransferState } from "@kolekto/adapters";
import type { KolektoTransferRow, PaymentDb } from "@kolekto/db";
import { kobo } from "@kolekto/domain";

import { answerTransferApproval } from "../src/transfer-approval.ts";
import { compareTransfers, nextReconciliationDelayMs, runTransferReconciliation, statusMismatchSeverity } from "../src/transfer-reconciliation.ts";

const REF = (n: number) => `ktr_${n.toString(16).padStart(24, "0")}`;
const FROM = new Date("2026-11-12T00:00:00.000Z");
const TO = new Date("2026-11-19T12:00:00.000Z");
const NOW = TO;

const k = (n: number, over: Partial<KolektoTransferRow> = {}): KolektoTransferRow => ({
  transferId: `t-${n}`,
  reference: REF(n),
  transferCode: `TRF_k${n}0000`,
  amountKobo: 100000n,
  recipientCode: "RCP_owner0001",
  status: "success",
  withdrawalStatus: "paid",
  withdrawalAmountKobo: 100000n,
  payoutJournal: true,
  initiateRequestedAt: "2026-11-19T06:00:00.000Z",
  createdAt: "2026-11-19T06:00:00.000Z",
  updatedAt: "2026-11-19T06:05:00.000Z",
  escalated: false,
  approvalRequests: 1,
  ...over,
});
const p = (n: number | string, over: Partial<TransferState> = {}): TransferState => ({
  reference: typeof n === "string" ? n : REF(n),
  transferCode: typeof n === "string" ? null : `TRF_k${n}0000`,
  providerTransferId: "1",
  status: "success",
  providerStatusRaw: "success",
  amount: kobo(100000n),
  fee: null,
  reason: null,
  recipientCode: "RCP_owner0001",
  createdAt: "2026-11-18T10:00:00.000Z",
  ...over,
});
const opts = { windowFrom: FROM, windowTo: TO, now: NOW, staleAfterMs: 24 * 3600 * 1000, providerComplete: true };
const kinds = (ds: readonly ReturnType<typeof compareTransfers>[number][]) => ds.map((d) => `${d.kind}:${d.severity}:${d.reference}`).sort();

describe("compareTransfers", () => {
  it("agreeing records produce no discrepancy", () => {
    assert.deepEqual(compareTransfers([k(1)], [p(1)], opts), []);
  });

  it("finds every discrepancy kind", () => {
    const ds = compareTransfers(
      [
        k(1, { status: "success", payoutJournal: false }), // success not in ledger
        k(2, { amountKobo: 100000n, withdrawalAmountKobo: 90000n }), // transfer ≠ withdrawal
        k(3), // amount differs at provider
        k(4), // transfer code differs
        k(5), // recipient differs
        k(6, { status: "pending", withdrawalStatus: "processing", payoutJournal: false }), // final at provider
        k(7, { status: "unknown", withdrawalStatus: "processing", payoutJournal: false, transferCode: null,
               createdAt: "2026-11-17T00:00:00.000Z", escalated: true }), // stale + missing at provider
        k(8, { approvalRequests: 3 }), // duplicate approval requests
      ],
      [
        p(1), p(2, { amount: kobo(100000n) }), p(3, { amount: kobo(100001n) }), p(4, { transferCode: "TRF_other0000" }),
        p(5, { recipientCode: "RCP_someone99" }), p(6, { status: "failed", providerStatusRaw: "failed" }), p(8),
        p(9), p(9), // missing in Kolekto, and twice at the provider
        p("kprobe_seq_1795094234", { status: "otp", providerStatusRaw: "otp", amount: kobo(10000n) }),
      ],
      opts,
    );
    assert.deepEqual(kinds(ds), [
      `amount_mismatch:critical:${REF(2)}`,
      `amount_mismatch:critical:${REF(3)}`,
      `duplicate_approval_requests:info:${REF(8)}`,
      `duplicate_provider_record:critical:${REF(9)}`,
      "foreign_reference:info:kprobe_seq_1795094234",
      `missing_at_provider:warning:${REF(7)}`,
      `missing_in_kolekto:critical:${REF(9)}`,
      `recipient_mismatch:critical:${REF(5)}`,
      `reference_mismatch:critical:${REF(4)}`,
      `stale_open:warning:${REF(7)}`,
      `status_mismatch:warning:${REF(6)}`,
      `success_not_in_ledger:critical:${REF(1)}`,
    ]);
    assert.ok(ds.find((d) => d.kind === "stale_open")!.kolektoDetail!.endsWith(" escalated"));
  });

  it("does not report missing transfers when the provider list was incomplete", () => {
    assert.deepEqual(compareTransfers([k(7, { status: "unknown" })], [], { ...opts, providerComplete: false }), []);
  });

  it("does not report a never-sent transfer as missing at the provider", () => {
    const ds = compareTransfers([k(1, { status: "initiating", initiateRequestedAt: null, transferCode: null, createdAt: "2026-11-19T11:00:00.000Z" })], [], opts);
    assert.deepEqual(ds, []);
  });

  it("a missing success is critical", () => {
    assert.deepEqual(kinds(compareTransfers([k(1)], [], opts)), [`missing_at_provider:critical:${REF(1)}`]);
  });
});

describe("statusMismatchSeverity", () => {
  it("open in Kolekto and still open at Paystack is fine; pending vs otp is noted", () => {
    assert.equal(statusMismatchSeverity("unknown", "pending"), null);
    assert.equal(statusMismatchSeverity("pending", "unrecognised"), null);
    assert.equal(statusMismatchSeverity("pending", "otp"), "info");
  });
  it("final at Paystack, open in Kolekto: warning (the checker will settle it)", () => {
    assert.equal(statusMismatchSeverity("pending", "success"), "warning");
    assert.equal(statusMismatchSeverity("otp", "failed"), "warning");
  });
  it("Kolekto final and Paystack disagrees: critical, except a reversal not yet applied", () => {
    assert.equal(statusMismatchSeverity("success", "success"), null);
    assert.equal(statusMismatchSeverity("success", "reversed"), "warning");
    assert.equal(statusMismatchSeverity("failed", "success"), "critical");
    assert.equal(statusMismatchSeverity("success", "pending"), "critical");
  });
});

function scriptedDb(script: { kolekto?: unknown[]; decide?: { decision: string; reason_code: string } | Error }) {
  const calls: { text: string; values: unknown[] }[] = [];
  const db: PaymentDb = async (fn) => {
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      calls.push({ text, values });
      if (text.includes("app.transfer_reconciliation_kolekto_rows")) return Promise.resolve(script.kolekto ?? []);
      if (text.includes("app.record_transfer_reconciliation_run")) return Promise.resolve([{ id: "run-1" }]);
      if (text.includes("app.decide_transfer_approval")) {
        if (script.decide instanceof Error) return Promise.reject(script.decide);
        return Promise.resolve([script.decide ?? { decision: "reject", reason_code: "unknown_reference" }]);
      }
      return Promise.reject(new Error(`unexpected SQL: ${text}`));
    };
    return fn(tx as never);
  };
  return { db, calls };
}

const providerWith = (list: TransferProvider["listTransfers"]): TransferProvider => {
  const fake = new FakeTransferProvider();
  return {
    name: "fake",
    testMode: true,
    listBanks: () => fake.listBanks(),
    resolveAccount: (n, b) => fake.resolveAccount(n, b),
    createRecipient: (r) => fake.createRecipient(r),
    getBalance: () => fake.getBalance(),
    initiateTransfer: () => Promise.reject(new Error("reconciliation must never initiate a transfer")),
    verifyTransfer: (r) => fake.verifyTransfer(r),
    listTransfers: list,
    authenticateApprovalRequest: (b, h) => fake.authenticateApprovalRequest(b, h),
  };
};

describe("runTransferReconciliation", () => {
  const kolektoRow = {
    transfer_id: "t-1", reference: REF(1), transfer_code: "TRF_k10000", amount_kobo: "100000", recipient_code: "RCP_owner0001",
    status: "success", withdrawal_status: "paid", withdrawal_amount_kobo: "100000", payout_journal: true,
    initiate_requested_at: new Date("2026-11-18T10:00:00.000Z"), created_at: new Date("2026-11-18T10:00:00.000Z"),
    updated_at: new Date("2026-11-18T10:05:00.000Z"), escalated: false, approval_requests: 1,
  };

  it("records nothing when Paystack's list cannot be read at all", async () => {
    const { db, calls } = scriptedDb({ kolekto: [kolektoRow] });
    const r = await runTransferReconciliation(
      { db, provider: providerWith(async () => ({ outcome: "unknown", reason: "paystack_http_503", safeToRetry: true })) },
      { windowFrom: FROM, windowTo: TO, now: NOW },
    );
    assert.equal(r.outcome, "provider_unavailable");
    assert.equal(calls.length, 0);
  });

  it("reads every page, compares, and records one run (read-only)", async () => {
    const { db, calls } = scriptedDb({ kolekto: [kolektoRow] });
    const pages: number[] = [];
    const r = await runTransferReconciliation(
      {
        db,
        provider: providerWith(async (q) => {
          pages.push(q.page);
          return { outcome: "ok", value: { items: q.page === 1 ? [p(1)] : [p("kprobe_con_1795094234", { status: "otp", providerStatusRaw: "otp" })], pageCount: 2, unparseable: 0 } };
        }),
      },
      { windowFrom: FROM, windowTo: TO, now: NOW, perPage: 50 },
    );
    assert.deepEqual(pages, [1, 2]);
    assert.equal(r.outcome, "recorded");
    assert.equal(r.runId, "run-1");
    assert.equal(r.providerComplete, true);
    assert.deepEqual(kinds(r.discrepancies), ["foreign_reference:info:kprobe_con_1795094234"]);
    const record = calls.find((c) => c.text.includes("record_transfer_reconciliation_run"))!;
    assert.equal(JSON.parse(String(record.values[0])).provider_mode, "fake");
    assert.equal(JSON.parse(String(record.values[1])).length, 1);
  });

  it("an unreadable later page or unparseable items mark the run incomplete, suppressing 'missing' findings", async () => {
    const { db } = scriptedDb({ kolekto: [kolektoRow] });
    const r = await runTransferReconciliation(
      {
        db,
        provider: providerWith(async (q) =>
          q.page === 1
            ? { outcome: "ok", value: { items: [], pageCount: 2, unparseable: 1 } }
            : { outcome: "unknown", reason: "timeout", safeToRetry: true }),
      },
      { windowFrom: FROM, windowTo: TO, now: NOW },
    );
    assert.equal(r.outcome, "recorded");
    assert.equal(r.providerComplete, false);
    assert.deepEqual(r.discrepancies, []);
  });
});

describe("answerTransferApproval", () => {
  // The real Paystack approval request (TEST, 2026-11-20), redacted.
  const fixture = JSON.parse(readFileSync(new URL("../../adapters/test/fixtures/paystack-transfer-approval-request.redacted.json", import.meta.url), "utf8"));
  const raw = new TextEncoder().encode(JSON.stringify(fixture));
  const FREF = "ktr_000000000000000000000f17";

  it("HTTP 200 only for the database's explicit approval, with every parsed fact passed", async () => {
    const { db, calls } = scriptedDb({ decide: { decision: "approve", reason_code: "authorised" } });
    assert.deepEqual(await answerTransferApproval(db, raw, "valid"), { httpStatus: 200, decision: "approve", reasonCode: "authorised" });
    assert.deepEqual(calls[0]!.values, [FREF, "10000", "RCP_fixture0000001", "valid", "NGN", "TRF_fixture00000001", null]);
  });

  it("HTTP 400 for any rejection", async () => {
    const { db } = scriptedDb({ decide: { decision: "reject", reason_code: "owner_not_approved" } });
    assert.deepEqual(await answerTransferApproval(db, raw, "absent"), { httpStatus: 400, decision: "reject", reasonCode: "owner_not_approved" });
  });

  it("an unreadable body still asks the database once, which logs it as payload_malformed", async () => {
    const { db, calls } = scriptedDb({ decide: { decision: "reject", reason_code: "payload_malformed" } });
    const r = await answerTransferApproval(db, new TextEncoder().encode("not json"), "absent");
    assert.equal(r.httpStatus, 400);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.values, [null, null, null, "absent", null, null, "payload_malformed"]);
  });

  it("a mismatched body is refused with its reference, so the refusal is linked to the transfer", async () => {
    const bad = structuredClone(fixture);
    bad.data.details.body.amount = "10001";
    const { db, calls } = scriptedDb({ decide: { decision: "reject", reason_code: "payload_mismatch" } });
    const r = await answerTransferApproval(db, new TextEncoder().encode(JSON.stringify(bad)), "valid");
    assert.deepEqual(r, { httpStatus: 400, decision: "reject", reasonCode: "payload_mismatch" });
    assert.deepEqual(calls[0]!.values, [FREF, null, null, "valid", null, null, "payload_mismatch"]);
  });

  it("a refused payload is never a 200, even if the database were to say approve", async () => {
    const { db } = scriptedDb({ decide: { decision: "approve", reason_code: "authorised" } });
    const r = await answerTransferApproval(db, new TextEncoder().encode("{}"), "valid");
    assert.equal(r.httpStatus, 400);
    assert.equal(r.decision, "reject");
  });

  it("fails closed: a database error is a 400", async () => {
    const { db } = scriptedDb({ decide: new Error("connection reset") });
    assert.deepEqual(await answerTransferApproval(db, raw, "valid"), { httpStatus: 400, decision: "reject", reasonCode: "error" });
  });
});

/*
 * Provider-verification grace period (20261122100000). Paystack's transfer
 * list can lag a just-created transfer; within the grace period an absent
 * transfer is "provider_verification_pending" (never missing, failed or paid),
 * after it Paystack is asked by reference before anything is called missing.
 */
describe("provider-verification grace period", () => {
  const MIN = 60 * 1000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const graceOpts = { ...opts, providerGraceMs: 5 * MIN };

  const dbRow = (n: number, sentMsAgo: number, over: Record<string, unknown> = {}) => ({
    transfer_id: `t-${n}`, reference: REF(n), transfer_code: `TRF_k${n}0000`, amount_kobo: "100000", recipient_code: "RCP_owner0001",
    status: "pending", withdrawal_status: "processing", withdrawal_amount_kobo: "100000", payout_journal: false,
    initiate_requested_at: new Date(NOW.getTime() - sentMsAgo), created_at: new Date(NOW.getTime() - sentMsAgo),
    updated_at: new Date(NOW.getTime() - sentMsAgo), escalated: false, approval_requests: 1,
    ...over,
  });

  /** A provider whose list and verify are scripted; counts every call and refuses to initiate. */
  function scriptedProvider(
    listed: TransferState[],
    verify: (reference: string) => ReturnType<TransferProvider["verifyTransfer"]> = async () => ({ outcome: "not_found" }),
  ) {
    const counts = { list: 0, verify: 0, initiate: 0, verified: [] as string[] };
    const base = providerWith(async () => {
      counts.list += 1;
      return { outcome: "ok", value: { items: listed, pageCount: 1, unparseable: 0 } };
    });
    const provider: TransferProvider = {
      ...base,
      initiateTransfer: () => {
        counts.initiate += 1;
        return Promise.reject(new Error("reconciliation must never initiate a transfer"));
      },
      verifyTransfer: (reference) => {
        counts.verify += 1;
        counts.verified.push(reference);
        return verify(reference);
      },
    };
    return { provider, counts };
  }
  const recorded = (calls: { text: string; values: unknown[] }[]) =>
    calls.filter((c) => c.text.includes("record_transfer_reconciliation_run")).map((c) => ({
      run: JSON.parse(String(c.values[0])) as Record<string, unknown>,
      discrepancies: JSON.parse(String(c.values[1])) as { kind: string; severity: string; reference: string }[],
    }));
  const pendingK = (n: number, sentMsAgo: number) =>
    k(n, { status: "pending", withdrawalStatus: "processing", payoutJournal: false, initiateRequestedAt: ago(sentMsAgo) });

  describe("compareTransfers", () => {
    it("a transfer sent under 5 minutes ago and absent from the list is pending verification, not missing", () => {
      const ds = compareTransfers([pendingK(1, 30 * 1000)], [], graceOpts);
      assert.deepEqual(kinds(ds), [`provider_verification_pending:info:${REF(1)}`]);
      assert.match(ds[0]!.kolektoDetail!, /sent 30s ago$/);
      assert.match(ds[0]!.providerDetail!, /within the 300s grace period/);
    });

    it("the boundary: 4m59s is still pending; exactly 5 minutes is past the grace period", () => {
      assert.deepEqual(kinds(compareTransfers([pendingK(1, 5 * MIN - 1000)], [], graceOpts)), [`provider_verification_pending:info:${REF(1)}`]);
      assert.deepEqual(kinds(compareTransfers([pendingK(1, 5 * MIN)], [], graceOpts)), [`missing_at_provider:warning:${REF(1)}`]);
    });

    it("past the grace period, a verify that found the transfer is compared like a listed one", () => {
      const k1 = k(1, { initiateRequestedAt: ago(10 * MIN) });
      const found = new Map([[REF(1), { outcome: "found" as const, state: p(1) }]]);
      assert.deepEqual(compareTransfers([k1], [], { ...graceOpts, verifications: found }), []);
      const disagrees = new Map([[REF(1), { outcome: "found" as const, state: p(1, { amount: kobo(99999n) }) }]]);
      assert.deepEqual(kinds(compareTransfers([k1], [], { ...graceOpts, verifications: disagrees })), [`amount_mismatch:critical:${REF(1)}`]);
    });

    it("past the grace period, not found / unavailable is still missing, with the reason in the detail", () => {
      const k1 = k(1, { initiateRequestedAt: ago(10 * MIN) });
      const notFound = compareTransfers([k1], [], { ...graceOpts, verifications: new Map([[REF(1), { outcome: "not_found" as const }]]) });
      assert.deepEqual(kinds(notFound), [`missing_at_provider:critical:${REF(1)}`]);
      assert.match(notFound[0]!.providerDetail!, /verify by reference: not found$/);
      const unavailable = compareTransfers([k1], [], {
        ...graceOpts,
        verifications: new Map([[REF(1), { outcome: "unavailable" as const, reason: "paystack_http_503" }]]),
      });
      assert.deepEqual(kinds(unavailable), [`missing_at_provider:critical:${REF(1)}`]);
      assert.match(unavailable[0]!.providerDetail!, /unavailable \(paystack_http_503\)$/);
    });

    it("the grace period never hides other findings about the same transfer", () => {
      const ds = compareTransfers([k(1, { payoutJournal: false, withdrawalAmountKobo: 90000n, initiateRequestedAt: ago(MIN) })], [], graceOpts);
      assert.deepEqual(kinds(ds), [
        `amount_mismatch:critical:${REF(1)}`,
        `provider_verification_pending:info:${REF(1)}`,
        `success_not_in_ledger:critical:${REF(1)}`,
      ]);
    });

    it("an incomplete list still reports nothing about absent transfers, inside or outside the grace period", () => {
      const ds = compareTransfers([pendingK(1, MIN), pendingK(2, 10 * MIN)], [], { ...graceOpts, providerComplete: false });
      assert.deepEqual(ds, []);
    });
  });

  describe("runTransferReconciliation", () => {
    const window = { windowFrom: FROM, windowTo: TO, now: NOW };
    const later = new Date(NOW.getTime() + 6 * MIN);
    const laterWindow = { windowFrom: FROM, windowTo: later, now: later };

    it("under 5 minutes and absent: pending verification; Paystack is not asked yet; nothing is initiated", async () => {
      const { db, calls } = scriptedDb({ kolekto: [dbRow(1, 30 * 1000)] });
      const { provider, counts } = scriptedProvider([]);
      const r = await runTransferReconciliation({ db, provider }, { ...window, providerGraceMs: 5 * MIN });
      assert.deepEqual(kinds(r.discrepancies), [`provider_verification_pending:info:${REF(1)}`]);
      assert.equal(r.pendingVerification, 1);
      assert.equal(r.providerVerifications, 0);
      assert.deepEqual([counts.verify, counts.initiate], [0, 0]);
      const [run] = recorded(calls);
      assert.equal(run!.run["provider_grace_seconds"], 300);
      assert.deepEqual(run!.discrepancies.map((d) => d.kind), ["provider_verification_pending"]);
    });

    it("older than 5 minutes and still absent: verified by reference once, then missing_at_provider", async () => {
      const { db } = scriptedDb({ kolekto: [dbRow(1, 6 * MIN)] });
      const { provider, counts } = scriptedProvider([]);
      const r = await runTransferReconciliation({ db, provider }, window);
      assert.deepEqual(kinds(r.discrepancies), [`missing_at_provider:warning:${REF(1)}`]);
      assert.deepEqual(counts.verified, [REF(1)]);
      assert.equal(r.providerVerifications, 1);
      assert.equal(r.pendingVerification, 0);
      assert.equal(counts.initiate, 0);
    });

    it("appears after the initial check: pending on the first run, clean once Paystack lists it", async () => {
      const first = scriptedDb({ kolekto: [dbRow(1, 30 * 1000)] });
      const r1 = await runTransferReconciliation({ db: first.db, provider: scriptedProvider([]).provider }, window);
      assert.deepEqual(kinds(r1.discrepancies), [`provider_verification_pending:info:${REF(1)}`]);

      const second = scriptedDb({ kolekto: [dbRow(1, 30 * 1000)] });
      const listedNow = scriptedProvider([p(1, { status: "pending", providerStatusRaw: "pending" })]);
      const r2 = await runTransferReconciliation({ db: second.db, provider: listedNow.provider }, laterWindow);
      assert.deepEqual(r2.discrepancies, []);
      assert.equal(listedNow.counts.verify, 0, "a listed transfer needs no verify");
    });

    it("past the grace period but the list still lags: verify finds it, so no missing warning", async () => {
      const { db } = scriptedDb({ kolekto: [dbRow(1, 6 * MIN)] });
      const { provider, counts } = scriptedProvider([], async (reference) => ({
        outcome: "ok",
        value: p(1, { reference, status: "pending", providerStatusRaw: "pending" }),
      }));
      const r = await runTransferReconciliation({ db, provider }, window);
      assert.deepEqual(r.discrepancies, []);
      assert.equal(counts.verify, 1);
    });

    it("a verify answer for a different reference is not trusted", async () => {
      const { db } = scriptedDb({ kolekto: [dbRow(1, 6 * MIN)] });
      const { provider } = scriptedProvider([], async () => ({ outcome: "ok", value: p(2) }));
      const r = await runTransferReconciliation({ db, provider }, window);
      assert.deepEqual(kinds(r.discrepancies), [`missing_at_provider:warning:${REF(1)}`]);
      assert.match(r.discrepancies[0]!.providerDetail!, /unavailable \(ok\)/);
    });

    it("successful webhook during the grace period: settled normally; no stale missing warning before or after", async () => {
      const settled = { status: "success", withdrawal_status: "paid", payout_journal: true };
      const during = scriptedDb({ kolekto: [dbRow(1, 2 * MIN, settled)] });
      const r1 = await runTransferReconciliation({ db: during.db, provider: scriptedProvider([]).provider }, window);
      assert.deepEqual(kinds(r1.discrepancies), [`provider_verification_pending:info:${REF(1)}`]);

      const after = scriptedDb({ kolekto: [dbRow(1, 2 * MIN, settled)] });
      const { provider } = scriptedProvider([], async (reference) => ({ outcome: "ok", value: p(1, { reference }) }));
      const r2 = await runTransferReconciliation({ db: after.db, provider }, laterWindow);
      assert.deepEqual(r2.discrepancies, []);
    });

    it("failed webhook during the grace period: released normally; no stale missing warning before or after", async () => {
      const failed = { status: "failed", withdrawal_status: "failed", payout_journal: false };
      const during = scriptedDb({ kolekto: [dbRow(1, 2 * MIN, failed)] });
      const r1 = await runTransferReconciliation({ db: during.db, provider: scriptedProvider([]).provider }, window);
      assert.deepEqual(kinds(r1.discrepancies), [`provider_verification_pending:info:${REF(1)}`]);

      const after = scriptedDb({ kolekto: [dbRow(1, 2 * MIN, failed)] });
      const { provider } = scriptedProvider([], async (reference) => ({
        outcome: "ok",
        value: p(1, { reference, status: "failed", providerStatusRaw: "failed" }),
      }));
      const r2 = await runTransferReconciliation({ db: after.db, provider }, laterWindow);
      assert.deepEqual(r2.discrepancies, []);
    });

    it("duplicate runs: identical findings, one recorded run each, never an initiate", async () => {
      const rows = [dbRow(1, 30 * 1000), dbRow(2, 3 * 3600 * 1000, { status: "success", withdrawal_status: "paid", payout_journal: true })];
      const { db, calls } = scriptedDb({ kolekto: rows });
      const { provider, counts } = scriptedProvider([]);
      const a = await runTransferReconciliation({ db, provider }, window);
      const b = await runTransferReconciliation({ db, provider }, window);
      assert.deepEqual(kinds(a.discrepancies), [`missing_at_provider:critical:${REF(2)}`, `provider_verification_pending:info:${REF(1)}`]);
      assert.deepEqual(a.discrepancies, b.discrepancies);
      const runs = recorded(calls);
      assert.equal(runs.length, 2);
      assert.deepEqual(runs[0]!.discrepancies, runs[1]!.discrepancies);
      assert.equal(counts.initiate, 0);
      assert.deepEqual(counts.verified, [REF(2), REF(2)], "only the older transfer is asked about, once per run");
      assert.equal(calls.some((c) => /settle|release|initiat|claim/i.test(c.text)), false, "the run calls no transfer or ledger function");
    });

    it("an existing older missing transfer (sent days ago) is still reported missing", async () => {
      const { db } = scriptedDb({ kolekto: [dbRow(1, 2 * 24 * 3600 * 1000, { status: "success", withdrawal_status: "paid", payout_journal: true })] });
      const r = await runTransferReconciliation({ db, provider: scriptedProvider([]).provider }, window);
      assert.deepEqual(kinds(r.discrepancies), [`missing_at_provider:critical:${REF(1)}`]);
      assert.match(r.discrepancies[0]!.providerDetail!, /verify by reference: not found$/);
    });

    it("a verify that throws or says unknown leaves the transfer missing (fails toward a warning)", async () => {
      const { db } = scriptedDb({ kolekto: [dbRow(1, 6 * MIN), dbRow(2, 6 * MIN)] });
      const { provider } = scriptedProvider([], async (reference) => {
        if (reference === REF(1)) throw new Error("socket hang up");
        return { outcome: "unknown", reason: "timeout", safeToRetry: true };
      });
      const r = await runTransferReconciliation({ db, provider }, window);
      assert.deepEqual(kinds(r.discrepancies), [`missing_at_provider:warning:${REF(1)}`, `missing_at_provider:warning:${REF(2)}`]);
      assert.match(r.discrepancies.find((d) => d.reference === REF(1))!.providerDetail!, /verify call failed/);
      assert.match(r.discrepancies.find((d) => d.reference === REF(2))!.providerDetail!, /unavailable \(timeout\)/);
    });

    it("caps verify calls per run; the rest are reported missing as not re-verified", async () => {
      const { db } = scriptedDb({ kolekto: [dbRow(1, 6 * MIN), dbRow(2, 6 * MIN), dbRow(3, 6 * MIN)] });
      const { provider, counts } = scriptedProvider([]);
      const r = await runTransferReconciliation({ db, provider }, { ...window, maxVerifications: 2 });
      assert.equal(counts.verify, 2);
      assert.equal(r.providerVerifications, 2);
      assert.equal(r.discrepancies.filter((d) => d.kind === "missing_at_provider").length, 3);
      assert.match(r.discrepancies.find((d) => d.reference === REF(3))!.providerDetail!, /per-run verification limit reached/);
    });

    it("the grace period is configurable and validated", async () => {
      const { db, calls } = scriptedDb({ kolekto: [dbRow(1, 6 * MIN)] });
      const r = await runTransferReconciliation({ db, provider: scriptedProvider([]).provider }, { ...window, providerGraceMs: 10 * MIN });
      assert.deepEqual(kinds(r.discrepancies), [`provider_verification_pending:info:${REF(1)}`]);
      assert.equal(recorded(calls)[0]!.run["provider_grace_seconds"], 600);
      for (const bad of [-1, Number.NaN, 24 * 3600 * 1000 + 1]) {
        await assert.rejects(runTransferReconciliation({ db, provider: scriptedProvider([]).provider }, { ...window, providerGraceMs: bad }), RangeError);
      }
    });
  });

  describe("nextReconciliationDelayMs", () => {
    it("re-checks a minute after the grace period while anything is pending; otherwise the regular interval", () => {
      const sixHours = 6 * 3600 * 1000;
      assert.equal(nextReconciliationDelayMs({ pendingVerification: 0 }, sixHours), sixHours);
      assert.equal(nextReconciliationDelayMs({ pendingVerification: 2 }, sixHours), 6 * MIN);
      assert.equal(nextReconciliationDelayMs({ pendingVerification: 1 }, sixHours, 10 * MIN), 11 * MIN);
      assert.equal(nextReconciliationDelayMs({ pendingVerification: 1 }, 2 * MIN), 2 * MIN, "never later than the regular interval");
    });
  });
});
