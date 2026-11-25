#!/usr/bin/env node
/**
 * Redacts credentials from diagnostic output before it is shown anywhere.
 *
 *   curl -s … | node scripts/itest/redact.mjs
 *   docker logs supabase_auth_kolekto-itest 2>&1 | node scripts/itest/redact.mjs
 *
 * Why this exists: a hand-written `sed` masking an Auth signup response once
 * failed to match and printed part of an itest access token (2026-11-24,
 * session 59). Masking by substitution fails OPEN when the pattern is wrong.
 * This filter fails CLOSED instead, like `redactedTail` in itest.mjs:
 *
 *   1. JSON input: every value under a credential-like key is replaced, at
 *      any depth, and the JSON is printed back with its shape intact.
 *   2. Anything else, line by line: known token shapes are masked, and a line
 *      that still looks credential-bearing afterwards is dropped whole.
 *
 * It never prints what it removed, not even a prefix.
 */
import { readFileSync } from "node:fs";

const SECRET_KEY = /(token|secret|password|passwd|apikey|api_key|authorization|cookie|jwt|key)$/i;
const SHAPES = [
  /eyJ[A-Za-z0-9_-]{4,}(\.[A-Za-z0-9_-]*){0,2}/g, // JWTs, whole or truncated
  /\bsb_[a-z]+_[A-Za-z0-9_-]+/g, // Supabase publishable/secret keys
  /\b(sk|pk)_(test|live)_[A-Za-z0-9]+/g, // Paystack keys
  /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /postgres(ql)?:\/\/[^\s"']+/gi,
];
const STILL_SECRETISH = /(eyJ|sb_[a-z]+_|(access|refresh)_token"?\s*[:=]\s*"?[^"\s,]{8,}|secret"?\s*[:=]\s*"?[^"\s,]{8,})/i;

function redactValue(key, value) {
  if (typeof value === "string" && SECRET_KEY.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(k, v)]));
  }
  return typeof value === "string" ? redactLine(value) ?? "[redacted]" : value;
}

/** Masks known shapes; returns null when the line should be dropped. */
export function redactLine(line) {
  let out = line;
  for (const shape of SHAPES) out = out.replace(shape, "[redacted]");
  return STILL_SECRETISH.test(out) ? null : out;
}

export function redact(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactValue("", JSON.parse(trimmed)), null, 2);
    } catch {
      // not one JSON document — fall through to line mode
    }
  }
  return text
    .split(/\r?\n/)
    .map((l) => redactLine(l) ?? "[line dropped: looked like it carried a credential]")
    .join("\n");
}

if (process.argv[1]?.endsWith("redact.mjs")) {
  process.stdout.write(redact(readFileSync(0, "utf8")) + "\n");
}
