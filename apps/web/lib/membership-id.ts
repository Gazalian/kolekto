/**
 * Membership IDs (product doc Part F §F4; owner decision A1 of 2026-11-23:
 * the original ID is stored as plaintext — not hashed, not encrypted).
 *
 *   IDS/K7P9Q   = PREFIX + separator + random suffix
 *
 * · The suffix is Crockford base32 (no I, L, O, U), generated with
 *   crypto.randomInt, and always contains at least one letter — so it can never
 *   be the same string as a sequential member number such as KWASU/0021.
 * · What a person types is canonicalised before comparison: upper-case, spaces
 *   and separators removed, O→0 and I/L→1. "ids/k7p9o", "IDS K7P90" and
 *   "IDS-K7P90" all mean IDS/K7P90. The database applies the same rule
 *   (app.canonical_membership_id) and compares it with membership_ids.canonical_id.
 * · The server secret is still used for two things only:
 *     hashClientAddress   a keyed hash of the caller's IP for rate limiting
 *                         (an unkeyed hash of an IPv4 address is reversible);
 *     hashMembershipId    the LEGACY fingerprint check: two revoked itest IDs
 *                         from the encrypted design survive only as an HMAC and
 *                         must never be reissued (owner decision D1).
 *
 * Pure functions over node:crypto. The caller passes the secret (the server
 * reads it with loadMembershipIdSecret()); tests pass a fixed one.
 */

import { createHmac, hkdfSync, randomInt } from "node:crypto";

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MEMBERSHIP_ID_SEPARATORS = ["/", "-"] as const;
export type MembershipIdSeparator = (typeof MEMBERSHIP_ID_SEPARATORS)[number];
export const MIN_SUFFIX_LENGTH = 5;
export const MAX_SUFFIX_LENGTH = 8;
/** Mirrors the database's reserved list (20261123100100). The database is authoritative. */
export const RESERVED_PREFIXES = ["KM", "KLK", "KOLEKTO", "KTR", "KPAY", "ADMIN", "ROOT", "SYS", "SYSTEM", "TEST", "NULL"];
/** Key-derivation label version. Fixed: the legacy fingerprints and the IP hashes depend on it. */
const KEY_VERSION = 1;

export interface MembershipIdFormat {
  prefix: string;
  separator: MembershipIdSeparator;
  suffixLength: number;
}

/** Upper-cases and strips whitespace, as the database does. */
export function normalisePrefix(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** A user-facing problem with a prefix, or null. The database re-checks. */
export function prefixProblem(raw: string): string | null {
  const prefix = normalisePrefix(raw);
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) return "Use 2 to 10 letters or numbers, starting with a letter.";
  if (RESERVED_PREFIXES.includes(prefix)) return `${prefix} is reserved by Kolekto. Choose another.`;
  return null;
}

function randomSuffix(length: number, pick: (max: number) => number): string {
  let suffix = "";
  for (let i = 0; i < length; i += 1) suffix += CROCKFORD_ALPHABET[pick(CROCKFORD_ALPHABET.length)];
  return suffix;
}

/**
 * A new random suffix with at least one letter. `pick` is injectable for tests;
 * production uses crypto.randomInt (uniform, cryptographically secure).
 */
export function generateSuffix(length: number, pick: (max: number) => number = randomInt): string {
  if (!Number.isInteger(length) || length < MIN_SUFFIX_LENGTH || length > MAX_SUFFIX_LENGTH) {
    throw new Error(`Suffix length must be ${MIN_SUFFIX_LENGTH}–${MAX_SUFFIX_LENGTH}`);
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = randomSuffix(length, pick);
    if (/[A-Z]/.test(suffix)) return suffix;
  }
  throw new Error("Could not generate a suffix containing a letter");
}

export function formatMembershipId(format: MembershipIdFormat, suffix: string): string {
  return `${format.prefix}${format.separator}${suffix}`;
}

/** A display-only sample for the settings preview (never issued). */
export function previewMembershipId(format: MembershipIdFormat): string {
  return formatMembershipId(format, generateSuffix(format.suffixLength));
}

/** A new random ID in the given format, for storage (plaintext, A1) and display to the issuing officer. */
export function newMembershipId(format: MembershipIdFormat): string {
  return formatMembershipId(format, generateSuffix(format.suffixLength));
}

/** The comparison form: upper-case, no spaces or separators, O→0, I/L→1. Same rule as app.canonical_membership_id. */
export function canonicalMembershipId(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s/\-_.]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function maskMembershipId(prefix: string, separator: string, last2: string): string {
  return `${prefix}${separator}•••${last2}`;
}

function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), `kolekto-membership-id:${purpose}:v${KEY_VERSION}`, 32));
}

/**
 * LEGACY fingerprint (owner decision D1): HMAC-SHA256 of the canonical ID,
 * scoped to the community — the form the 20261123100100 design stored. Used
 * only so the two unrecoverable revoked itest IDs stay reserved. 32 bytes.
 */
export function hashMembershipId(secret: string, communityId: string, rawId: string): Buffer {
  return createHmac("sha256", deriveKey(secret, "lookup"))
    .update(`${communityId}:${canonicalMembershipId(rawId)}`)
    .digest();
}

/** Keyed hash of the caller's IP for rate limiting; the IP itself is never stored. 32 bytes. */
export function hashClientAddress(secret: string, address: string): Buffer {
  return createHmac("sha256", deriveKey(secret, "client-address")).update(address).digest();
}
