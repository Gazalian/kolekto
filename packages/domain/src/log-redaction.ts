/**
 * log-redaction.ts — the structured-log redaction policy (session 39,
 * 2026-11-20).
 *
 * Anything an application log line carries passes through
 * `redactLogFields` first. Two layers:
 *
 *   1. By field name: a key that names secret material (an OTP or code
 *      hash, password, token, secret, API key, cookie, authorization header,
 *      raw signature, raw body, full account number, BVN/NIN) is replaced by
 *      "[redacted]" whatever its value.
 *   2. By value: inside every remaining string, anything shaped like a
 *      secret is replaced — Paystack keys (sk_/pk_ test or live), bearer
 *      tokens, JWTs, long hex (an HMAC or hash), a standalone 6-digit number
 *      (an OTP), and a 10+ digit number (a NUBAN account number) masked to
 *      its last four digits.
 *
 * Numbers and booleans are kept: counts, attempt numbers and kobo amounts are
 * what make a log line useful. Error objects become `{ name, message }` with
 * the message scrubbed — never the stack, cause or driver parameters.
 *
 * Pure; no I/O.
 */

export const REDACTED = "[redacted]";

const MAX_DEPTH = 6;
const MAX_STRING = 500;

/** Normalised (lower-case, letters and digits only) field names that always hold secret material. */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "otp",
  "otpcode",
  "code_hash",
  "codehash",
  "hash",
  "hmac",
  "password",
  "passcode",
  "pin",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "secretkey",
  "authorization",
  "cookie",
  "setcookie",
  "signature",
  "xpaystacksignature",
  "rawbody",
  "body",
  "accountnumber",
  "destinationaccountnumber",
  "bvn",
  "nin",
  "cardnumber",
  "cvv",
].map((k) => k.replace(/[^a-z0-9]/g, "")));

/** Substrings that make any field name sensitive (e.g. `paystackSecretKey`, `sessionToken`, `withdrawalOtpSecret`). */
const SENSITIVE_KEY_PARTS: readonly string[] = ["secret", "password", "token", "otp", "hmac", "cookie", "authorization", "apikey", "accountnumber", "codehash"];

/** Field names that look sensitive by substring but carry no secret (identifiers and states). */
const SAFE_KEYS: ReadonlySet<string> = new Set(["otpchallengeid", "challengeid", "otpstatus", "otpoutcome", "signaturestate", "tokenscount"]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveLogKey(key: string): boolean {
  const k = normaliseKey(key);
  if (SAFE_KEYS.has(k)) return false;
  if (SENSITIVE_KEYS.has(k)) return true;
  return SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}

/** Replaces secret-shaped substrings in free text. */
export function scrubLogText(value: string): string {
  const scrubbed = value
    .replace(/\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+/g, "[paystack-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[hex]")
    // 10+ digit runs (account numbers, BVN): keep the last four.
    .replace(/(?<![\d.:-])\d{6,}(\d{4})(?![\d.:-])/g, (_m, last4: string) => `[number…${last4}]`)
    // A standalone 6-digit number: the shape of a withdrawal OTP.
    .replace(/(?<![\w.:/-])\d{6}(?![\w.:/-])/g, "[digits]");
  return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}…` : scrubbed;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubLogText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return typeof value;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[invalid-date]" : value.toISOString();
  if (value instanceof Error) {
    return { name: scrubLogText(value.name), message: scrubLogText(value.message) };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return "[binary]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveLogKey(key) ? REDACTED : redactValue(v, depth + 1, seen);
  }
  return out;
}

/** The only form of structured fields that may reach a log line. */
export function redactLogFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return redactValue(fields, 0, new WeakSet()) as Record<string, unknown>;
}
