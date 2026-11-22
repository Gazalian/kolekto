/**
 * withdrawal-otp-delivery.test.ts — the worker stage that emails the
 * requesting member's one-time code (owner decision 2026-11-19): the hash is
 * stored before the email is sent, a superseded challenge is never emailed,
 * the pause switch is honoured, the email says the code is not approval or
 * payment, and nothing logs the code. A scripted database stands in for the
 * real functions (proved in pgTAP 69).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EmailProvider } from "@kolekto/adapters";
import type { PaymentDb, WithdrawalOtpDelivery } from "@kolekto/db";
import { hashWithdrawalOtp } from "@kolekto/domain";

import { transferAttentionLogLine, reconciliationLogLine } from "../src/withdrawal-transfers.ts";
import {
  decideWithdrawalOtpDelivery,
  deliverWithdrawalOtps,
  withdrawalOtpEmail,
  withdrawalOtpLogLine,
} from "../src/withdrawal-otp-delivery.ts";

const SECRET = "s".repeat(40);
const C1 = "01900000-0000-7000-8000-0000000000c1";
const C2 = "01900000-0000-7000-8000-0000000000c2";

const row = (challenge: string, email: string | null = "member@example.test") => ({
  challenge_id: challenge,
  withdrawal_id: "w-1",
  email,
  recipient_name: "Bayo Adeyemi",
  withdrawal_reference: "KWD-0123456789ABCDEF",
  amount_kobo: "1000000",
  collection_name: "Class Dues",
  community_name: "OTP Tests",
  bank_name: "GTBank",
  account_last4: "0002",
});

function scriptedDb(rows: ReturnType<typeof row>[], issued: Record<string, boolean> = {}) {
  const events: string[] = [];
  const db: PaymentDb = async (fn) => {
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("app.claim_withdrawal_otp_deliveries")) {
        events.push("claim");
        return Promise.resolve(rows);
      }
      if (text.includes("app.record_withdrawal_otp_issued")) {
        events.push(`issued:${values[0]}:${values[1]}`);
        return Promise.resolve([{ ok: issued[String(values[0])] ?? true }]);
      }
      if (text.includes("app.record_withdrawal_otp_delivery")) {
        events.push(`delivery:${values[0]}:${values[1]}:${values[2]}`);
        return Promise.resolve([{ status: values[1] ? "sent" : "delivery_failed" }]);
      }
      return Promise.reject(new Error(`unexpected SQL: ${text}`));
    };
    return fn(tx as never);
  };
  return { db, events };
}

function email(fail = false) {
  const sent: { key: string; to: string; text: string; html: string }[] = [];
  const provider = {
    name: "fake",
    idempotency: "native",
    async send(request: { idempotencyKey: string; message: { to: string; text: string; html: string } }) {
      if (fail) throw Object.assign(new Error("smtp down"), { code: "provider_unavailable" });
      sent.push({ key: request.idempotencyKey, to: request.message.to, text: request.message.text, html: request.message.html });
      return { outcome: "sent", providerMessageId: "m-1" };
    },
  } as unknown as EmailProvider;
  return { provider, sent };
}

describe("decideWithdrawalOtpDelivery", () => {
  it("runs only with the functions, an email provider and the secret", () => {
    assert.deepEqual(decideWithdrawalOtpDelivery({ functionsOk: false, hasEmail: true, secret: SECRET }), { enabled: false, reason: "otp_functions_missing_or_not_executable" });
    assert.deepEqual(decideWithdrawalOtpDelivery({ functionsOk: true, hasEmail: false, secret: SECRET }), { enabled: false, reason: "email_provider_not_configured" });
    assert.deepEqual(decideWithdrawalOtpDelivery({ functionsOk: true, hasEmail: true, secret: null }), { enabled: false, reason: "otp_secret_missing" });
    assert.deepEqual(decideWithdrawalOtpDelivery({ functionsOk: true, hasEmail: true, secret: SECRET }), { enabled: true });
  });
});

describe("deliverWithdrawalOtps", () => {
  it("stores the keyed hash, then emails the code, then records it sent", async () => {
    const { db, events } = scriptedDb([row(C1)]);
    const mail = email();
    const report = await deliverWithdrawalOtps({ db, email: mail.provider, secret: SECRET, sendingEnabled: async () => true, generate: () => "042137" });
    assert.deepEqual(report, { paused: false, outcomes: ["sent"] });
    assert.deepEqual(events, ["claim", `issued:${C1}:${hashWithdrawalOtp(SECRET, C1, "042137")}`, `delivery:${C1}:true:null`]);
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0]!.key, `withdrawal-otp:${C1}`);
    assert.equal(mail.sent[0]!.to, "member@example.test");
    assert.ok(mail.sent[0]!.text.includes("042137"));
  });

  it("never emails a challenge the database refused to issue (superseded or cancelled meanwhile)", async () => {
    const { db, events } = scriptedDb([row(C1), row(C2)], { [C1]: false });
    const mail = email();
    const report = await deliverWithdrawalOtps({ db, email: mail.provider, secret: SECRET, sendingEnabled: async () => true, generate: () => "111111" });
    assert.deepEqual(report.outcomes, ["superseded", "sent"]);
    assert.equal(mail.sent.length, 1);
    assert.equal(events.filter((e) => e.startsWith(`delivery:${C1}`)).length, 0);
  });

  it("records a failed send, and a requester whose email is no longer confirmed, without sending", async () => {
    const failing = scriptedDb([row(C1)]);
    const r1 = await deliverWithdrawalOtps({ db: failing.db, email: email(true).provider, secret: SECRET, sendingEnabled: async () => true });
    assert.deepEqual(r1.outcomes, ["delivery_failed"]);
    assert.ok(failing.events.includes(`delivery:${C1}:false:provider_unavailable`));

    const unconfirmed = scriptedDb([row(C2, null)]);
    const mail = email();
    const r2 = await deliverWithdrawalOtps({ db: unconfirmed.db, email: mail.provider, secret: SECRET, sendingEnabled: async () => true });
    assert.deepEqual(r2.outcomes, ["email_not_verified"]);
    assert.equal(mail.sent.length, 0);
    assert.equal(unconfirmed.events.some((e) => e.startsWith("issued:")), false, "no code is issued for an unconfirmed email");
  });

  it("claims nothing while email sending is paused", async () => {
    const { db, events } = scriptedDb([row(C1)]);
    assert.deepEqual(await deliverWithdrawalOtps({ db, email: email().provider, secret: SECRET, sendingEnabled: async () => false }), {
      paused: true,
      outcomes: [],
    });
    assert.deepEqual(events, []);
  });

  it("generates a fresh 6-digit code per challenge by default", async () => {
    const { db } = scriptedDb([row(C1), row(C2)]);
    const mail = email();
    await deliverWithdrawalOtps({ db, email: mail.provider, secret: SECRET, sendingEnabled: async () => true });
    const codes = mail.sent.map((m) => /code is: (\d+)/.exec(m.text)?.[1]);
    assert.ok(codes.every((c) => c !== undefined && /^\d{6}$/.test(c)));
  });
});

describe("withdrawalOtpEmail", () => {
  const d: WithdrawalOtpDelivery = {
    challengeId: C1, withdrawalId: "w-1", email: "member@example.test", recipientName: "Bayo <script>", withdrawalReference: "KWD-1",
    amountKobo: 1000000n, collectionName: "Class Dues", communityName: "OTP Tests", bankName: "GTBank", accountLast4: "0002",
  };
  const m = withdrawalOtpEmail(d, "123456");

  it("says the code is not approval and not payment, and names the request", () => {
    assert.match(m.text, /does not approve or pay the withdrawal/);
    assert.match(m.text, /authorised community administrator \(never you\) must still review and approve/);
    assert.doesNotMatch(m.text, /community owner/);
    assert.match(m.text, /valid for 10 minutes and can be used once/);
    assert.match(m.text, /ending 0002/);
    assert.match(m.text, /₦10,000/);
  });

  it("escapes names in the HTML and shows only the last four digits", () => {
    assert.equal(m.html?.includes("<script>"), false);
    assert.ok(m.html?.includes("Bayo &lt;script&gt;"));
    assert.equal(/\d{10}/.test(m.text), false);
  });
});

describe("log lines carry counts only", () => {
  it("OTP delivery: no code, no email, no reference", () => {
    assert.equal(withdrawalOtpLogLine({ paused: false, outcomes: [] }), null);
    const line = withdrawalOtpLogLine({ paused: false, outcomes: ["sent", "sent", "delivery_failed"] });
    assert.deepEqual(line, { msg: "withdrawal_otp_delivery", examined: 3, sent: 2, delivery_failed: 1 });
  });

  it("transfers needing attention: counts by status, critical", () => {
    assert.equal(transferAttentionLogLine([]), null);
    const line = transferAttentionLogLine([
      { status: "unknown" }, { status: "unknown" }, { status: "otp" },
    ] as never);
    assert.equal(line?.["severity"], "critical");
    assert.equal(line?.["count"], 3);
    assert.equal(line?.["unknown"], 2);
    assert.equal(JSON.stringify(line).includes("ktr_"), false);
  });

  it("reconciliation: severity is the worst finding; no references", () => {
    const line = reconciliationLogLine({
      outcome: "recorded", runId: "r", providerCount: 4, kolektoCount: 3, providerComplete: true,
      providerVerifications: 0, pendingVerification: 0,
      discrepancies: [
        { kind: "foreign_reference", severity: "info", reference: "kprobe_seq_1795094234", kolektoDetail: null, providerDetail: "x" },
        { kind: "missing_in_kolekto", severity: "critical", reference: "ktr_000000000000000000000009", kolektoDetail: null, providerDetail: "x" },
      ],
    });
    assert.equal(line["severity"], "critical");
    assert.deepEqual(line["by_kind"], { foreign_reference: 1, missing_in_kolekto: 1 });
    assert.equal(JSON.stringify(line).includes("ktr_"), false);
    assert.equal(JSON.stringify(line).includes("kprobe"), false);
  });

  it("reconciliation: a pending-verification finding is info and counted, never a warning", () => {
    const line = reconciliationLogLine({
      outcome: "recorded", runId: "r", providerCount: 0, kolektoCount: 1, providerComplete: true,
      providerVerifications: 0, pendingVerification: 1,
      discrepancies: [
        { kind: "provider_verification_pending", severity: "info", reference: "ktr_000000000000000000000001", kolektoDetail: "x", providerDetail: "x" },
      ],
    });
    assert.equal(line["severity"], "info");
    assert.equal(line["pending_verification"], 1);
    assert.equal(line["provider_verifications"], 0);
    assert.equal(JSON.stringify(line).includes("ktr_"), false);
  });
});
