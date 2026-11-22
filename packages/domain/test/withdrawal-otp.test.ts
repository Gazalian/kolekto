/**
 * The withdrawal one-time code helpers (owner decision 2026-11-19, Option A):
 * generation, input normalisation, and the keyed hash bound to one challenge.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  generateWithdrawalOtp,
  hashWithdrawalOtp,
  normaliseWithdrawalOtpInput,
  WITHDRAWAL_OTP_LENGTH,
  WITHDRAWAL_OTP_MAX_ATTEMPTS,
  WITHDRAWAL_OTP_VALIDITY_MINUTES,
} from "../src/withdrawal-otp.ts";

const SECRET = "x".repeat(32);
const CHALLENGE = "01900000-0000-7000-8000-0000000000aa";

describe("withdrawal OTP policy", () => {
  it("is 6 digits, 10 minutes, 5 attempts", () => {
    assert.equal(WITHDRAWAL_OTP_LENGTH, 6);
    assert.equal(WITHDRAWAL_OTP_VALIDITY_MINUTES, 10);
    assert.equal(WITHDRAWAL_OTP_MAX_ATTEMPTS, 5);
  });
});

describe("generateWithdrawalOtp", () => {
  it("draws from 0..999999 and keeps leading zeros", () => {
    let asked = 0;
    assert.equal(generateWithdrawalOtp((max) => ((asked = max), 42)), "000042");
    assert.equal(asked, 1_000_000);
    assert.equal(generateWithdrawalOtp(() => 999_999), "999999");
    assert.equal(generateWithdrawalOtp(() => 0), "000000");
  });

  it("refuses a random source out of range rather than producing a weak code", () => {
    for (const bad of [-1, 1_000_000, 1.5, Number.NaN]) {
      assert.throws(() => generateWithdrawalOtp(() => bad), /out of range/);
    }
  });

  it("uses a secure source by default: 6 digits, and not all the same over many draws", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const c = generateWithdrawalOtp();
      assert.match(c, /^\d{6}$/);
      codes.add(c);
    }
    assert.ok(codes.size > 190, `only ${codes.size} distinct codes in 200 draws`);
  });
});

describe("normaliseWithdrawalOtpInput", () => {
  it("accepts 6 digits with spaces or dashes", () => {
    assert.equal(normaliseWithdrawalOtpInput("123456"), "123456");
    assert.equal(normaliseWithdrawalOtpInput(" 123 456 "), "123456");
    assert.equal(normaliseWithdrawalOtpInput("123-456"), "123456");
  });
  it("rejects anything else", () => {
    for (const raw of ["", "12345", "1234567", "12345a", "١٢٣٤٥٦", "123.456"]) {
      assert.equal(normaliseWithdrawalOtpInput(raw), null, raw);
    }
  });
});

describe("hashWithdrawalOtp", () => {
  it("is HMAC-SHA256(secret, challengeId:code) in hex", () => {
    const expected = createHmac("sha256", SECRET).update(`${CHALLENGE}:123456`).digest("hex");
    assert.equal(hashWithdrawalOtp(SECRET, CHALLENGE, "123456"), expected);
    assert.match(expected, /^[0-9a-f]{64}$/);
  });

  it("binds the code to its challenge and to the secret", () => {
    const h = hashWithdrawalOtp(SECRET, CHALLENGE, "123456");
    assert.notEqual(hashWithdrawalOtp(SECRET, "01900000-0000-7000-8000-0000000000ab", "123456"), h);
    assert.notEqual(hashWithdrawalOtp("y".repeat(32), CHALLENGE, "123456"), h);
    assert.notEqual(hashWithdrawalOtp(SECRET, CHALLENGE, "123457"), h);
  });

  it("is case-insensitive in the challenge id", () => {
    assert.equal(hashWithdrawalOtp(SECRET, CHALLENGE.toUpperCase(), "000001"), hashWithdrawalOtp(SECRET, CHALLENGE, "000001"));
  });

  it("refuses a short secret, a non-UUID challenge or a malformed code", () => {
    assert.throws(() => hashWithdrawalOtp("short", CHALLENGE, "123456"), /too short/);
    assert.throws(() => hashWithdrawalOtp(SECRET, "not-a-uuid", "123456"), /UUID/);
    assert.throws(() => hashWithdrawalOtp(SECRET, CHALLENGE, "12345"), /6 digits/);
  });
});
