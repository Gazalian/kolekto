/**
 * payment-reference.ts — the payment reference Kolekto gives a provider.
 *
 * Format: `KLK-` + 26 characters of Crockford base32 from 128 bits of
 * crypto.randomBytes (§4.4). The reference is the idempotency key shared
 * between Kolekto and the provider (D-25), and the sole key used to look
 * up a payment on either side.
 *
 * Separate from the contributor reference (reference.ts), which is a
 * human-readable sequence number for receipts ("BIO26-0042").
 *
 * Pure aside from the single call to randomBytes.
 */

import { randomBytes } from "node:crypto";

const PREFIX = "KLK-";
const RANDOM_BYTES = 16; // 128 bits
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Encode bytes as Crockford base32.
 *
 * Crockford base32 omits I, L, O, U to avoid visual ambiguity and offensive
 * words. 128 bits → ceil(128/5) = 26 characters.
 */
function crockfordBase32(buf: Uint8Array): string {
  let bits = 0n;
  for (const byte of buf) {
    bits = (bits << 8n) | BigInt(byte);
  }

  const charCount = Math.ceil((buf.length * 8) / 5);
  const chars: string[] = new Array(charCount);
  for (let i = charCount - 1; i >= 0; i--) {
    chars[i] = CROCKFORD[Number(bits & 0x1fn)]!;
    bits >>= 5n;
  }

  return chars.join("");
}

export function generatePaymentReference(): string {
  return PREFIX + crockfordBase32(randomBytes(RANDOM_BYTES));
}

/** Check that a string looks like a payment reference this module would generate. */
export function isPaymentReference(value: string): boolean {
  return value.startsWith(PREFIX) && value.length === PREFIX.length + 26 && /^[0-9A-TV-Z]+$/.test(value.slice(PREFIX.length));
}
