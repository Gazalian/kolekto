/**
 * server-log.ts — one structured JSON log line, redacted (session 39).
 *
 * Every field passes through `redactLogFields` (@kolekto/domain): a field
 * named like a secret (code hash, OTP, password, token, key, cookie,
 * signature, account number…) is replaced by "[redacted]", and secret-shaped
 * text inside any other string (a 6-digit code, a hash, a Paystack key, a
 * bearer token, a full account number) is scrubbed. Use this, not
 * `console.*` with raw values, for any server-side log that touches a
 * member, a withdrawal or a provider.
 */

import { redactLogFields } from "@kolekto/domain";

export type LogLevel = "info" | "warn" | "error";

export function logEvent(level: LogLevel, msg: string, fields: Readonly<Record<string, unknown>> = {}): void {
  const line = JSON.stringify({ ...redactLogFields(fields), msg });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
