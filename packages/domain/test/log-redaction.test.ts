/**
 * Structured-log redaction (session 39): secret material never reaches a log
 * line, while identifiers, counts and outcomes stay readable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { isSensitiveLogKey, REDACTED, redactLogFields, scrubLogText } from "../src/log-redaction.ts";

const OTP = "482913";
const HASH = createHmac("sha256", "x".repeat(32)).update(`01900000-0000-7000-8000-0000000000aa:${OTP}`).digest("hex");
const WITHDRAWAL_ID = "01a1f94d-f434-75ca-9863-8d1466f3e711";
const CHALLENGE_ID = "01a1f94d-f4eb-7000-8000-123456789012";

describe("redactLogFields — by field name", () => {
  it("redacts OTPs, hashes, passwords, tokens, keys, cookies, signatures and account numbers", () => {
    const line = redactLogFields({
      code: OTP,
      otp: OTP,
      otpCode: OTP,
      codeHash: HASH,
      code_hash: HASH,
      password: "hunter2-but-longer",
      accessToken: "abc",
      refresh_token: "abc",
      apiKey: "abc",
      PAYSTACK_SECRET_KEY: "sk_test_abc",
      withdrawalOtpSecret: "s".repeat(64),
      authorization: "Bearer abc",
      cookie: "sb-access-token=abc",
      "x-paystack-signature": "f".repeat(128),
      accountNumber: "8012344796",
      destination_account_number: "8012344796",
      rawBody: "{}",
    });
    for (const [key, value] of Object.entries(line)) {
      if (key === "code") continue; // checked below: "code" is redacted by value, not name
      assert.equal(value, REDACTED, key);
    }
    assert.ok(!JSON.stringify(line).includes(OTP));
    assert.ok(!JSON.stringify(line).includes(HASH));
  });

  it("keeps the identifiers, counts and outcomes an OTP log line may carry", () => {
    const fields = {
      msg: "withdrawal_otp_verify",
      withdrawalId: WITHDRAWAL_ID,
      challengeId: CHALLENGE_ID,
      otpChallengeId: CHALLENGE_ID,
      outcome: "incorrect",
      attemptsRemaining: 3,
      at: "2026-11-20T14:14:07.893Z",
      reason: "OTP_CHALLENGE_MISMATCH",
    };
    assert.deepEqual(redactLogFields(fields), fields);
  });

  it("walks nested objects and arrays", () => {
    const line = redactLogFields({ input: { withdrawalId: WITHDRAWAL_ID, code: OTP }, list: [{ token: "t" }] });
    assert.deepEqual(line, { input: { withdrawalId: WITHDRAWAL_ID, code: "[digits]" }, list: [{ token: REDACTED }] });
  });

  it("reduces errors to name and scrubbed message", () => {
    const err = new Error(`verify failed for code ${OTP} hash ${HASH} key sk_live_abcdef`);
    const line = redactLogFields({ error: err });
    assert.deepEqual(Object.keys(line["error"] as object), ["name", "message"]);
    const text = JSON.stringify(line);
    assert.ok(!text.includes(OTP) && !text.includes(HASH) && !text.includes("sk_live_abcdef"));
    assert.ok(!text.includes("at "), "no stack");
  });

  it("survives circular structures", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    assert.deepEqual(redactLogFields({ a }), { a: { name: "a", self: "[circular]" } });
  });
});

describe("scrubLogText — by value", () => {
  it("removes a standalone 6-digit code", () => {
    assert.equal(scrubLogText(`verifyWithdrawalOtpAction({"code":"${OTP}"})`), 'verifyWithdrawalOtpAction({"code":"[digits]"})');
    assert.equal(scrubLogText(OTP), "[digits]");
  });

  it("masks account-number length digit runs to the last four", () => {
    assert.equal(scrubLogText("to 8012344796"), "to [number…4796]");
  });

  it("removes hashes, Paystack keys, bearer tokens and JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const out = scrubLogText(`h=${HASH} k=sk_test_123abc p=pk_live_9 a=Bearer abc.def j=${jwt}`);
    assert.equal(out, "h=[hex] k=[paystack-key] p=[paystack-key] a=Bearer [redacted] j=[jwt]");
  });

  it("leaves UUIDs, timestamps, references and kobo amounts readable", () => {
    const s = `${WITHDRAWAL_ID} ${CHALLENGE_ID} 2026-11-20T14:13:17.929Z KWD-F78DB08FF0E40945 ktr_4f407d1b9c82e8dad677be72 107390000`;
    assert.equal(scrubLogText(s), s);
  });
});

describe("isSensitiveLogKey", () => {
  it("is case and punctuation insensitive", () => {
    for (const k of ["OTP", "otp_code", "Code-Hash", "SESSION_TOKEN", "PaystackSecretKey", "Set-Cookie", "account_number"]) {
      assert.equal(isSensitiveLogKey(k), true, k);
    }
    for (const k of ["withdrawalId", "otpChallengeId", "challenge_id", "outcome", "attemptsRemaining", "reference"]) {
      assert.equal(isSensitiveLogKey(k), false, k);
    }
  });
});
