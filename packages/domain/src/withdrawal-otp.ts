/**
 * withdrawal-otp.ts — the requesting member's one-time code for a withdrawal
 * (owner decision 2026-11-19, Option A).
 *
 *   · 6 digits from a cryptographically secure source (`crypto.randomInt`).
 *   · Stored only as HMAC-SHA256(server secret, challengeId + ":" + code), hex.
 *     Binding the challenge id into the MAC means a code is only ever valid
 *     for the one challenge (one withdrawal, one member) it was issued for,
 *     and the secret keeps a database reader from brute-forcing 10^6 codes.
 *   · Validity (10 minutes), attempts (5), single use and rate limits are
 *     enforced by the database (20261119120000), not here.
 *
 * Pure apart from the random source; nothing here logs or stores a code.
 */

import { createHmac, randomInt } from "node:crypto";

export const WITHDRAWAL_OTP_LENGTH = 6;
export const WITHDRAWAL_OTP_VALIDITY_MINUTES = 10;
export const WITHDRAWAL_OTP_MAX_ATTEMPTS = 5;
const MIN_SECRET_LENGTH = 32;

/** A fresh 6-digit code, uniformly distributed, leading zeros kept. */
export function generateWithdrawalOtp(random: (max: number) => number = (max) => randomInt(0, max)): string {
  const n = random(10 ** WITHDRAWAL_OTP_LENGTH);
  if (!Number.isInteger(n) || n < 0 || n >= 10 ** WITHDRAWAL_OTP_LENGTH) {
    throw new Error("withdrawal OTP random source out of range");
  }
  return String(n).padStart(WITHDRAWAL_OTP_LENGTH, "0");
}

/** What the member typed → the 6 digits, or null. Spaces and dashes are ignored. */
export function normaliseWithdrawalOtpInput(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${WITHDRAWAL_OTP_LENGTH}}$`).test(digits) ? digits : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** HMAC-SHA256(secret, challengeId + ":" + code) as 64 lowercase hex characters. */
export function hashWithdrawalOtp(secret: string, challengeId: string, code: string): string {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error("withdrawal OTP secret is too short");
  if (!UUID.test(challengeId)) throw new Error("withdrawal OTP challenge id must be a UUID");
  if (!new RegExp(`^\\d{${WITHDRAWAL_OTP_LENGTH}}$`).test(code)) throw new Error("withdrawal OTP must be 6 digits");
  return createHmac("sha256", secret).update(`${challengeId.toLowerCase()}:${code}`).digest("hex");
}
