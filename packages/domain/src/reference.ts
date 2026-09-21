/**
 * reference.ts — what a contributor reference looks like.
 *
 * "BIO26-0042". The database issues it (app.build_contributor_reference), and
 * this is the same rule in TypeScript, for the one thing the database cannot
 * do: show an organiser what their reference will look like WHILE they are
 * typing the prefix, before anything has been saved.
 *
 * The duplication is deliberate and it is bounded. Two implementations of one
 * format is a risk; a settings screen that shows a made-up example and then
 * issues something different is a certainty. The rule is four lines long, it
 * has a test on this side, and it has a pgTAP test on the other side asserting
 * the same vectors. If they ever disagree, both suites say so.
 *
 * Pure, like everything else here: no clock, no I/O, no kobo.
 */

/** The punctuation allowed between the prefix and the number. */
export type ReferenceSeparator = "-" | "/" | "." | "";

export interface ReferenceFormat {
  /** BIO26. Upper-case letters and digits; what an organiser recognises on a receipt. */
  readonly prefix: string;
  readonly separator: ReferenceSeparator;
  /** How wide the number is padded. 1 to 8. */
  readonly digits: number;
}

export const REFERENCE_SEPARATORS: readonly ReferenceSeparator[] = ["-", "/", ".", ""];

/** A collection prefix: 2 to 10 characters. Longer reads as a sentence, shorter is not recognisable. */
const COLLECTION_PREFIX = /^[A-Z0-9]{2,10}$/;

/** A tier prefix: 1 to 8. Shorter is allowed because "A", "B", "C" are real table names. */
const TIER_PREFIX = /^[A-Z0-9]{1,8}$/;

export function isValidCollectionPrefix(prefix: string): boolean {
  return COLLECTION_PREFIX.test(prefix);
}

export function isValidTierPrefix(prefix: string): boolean {
  return TIER_PREFIX.test(prefix);
}

/**
 * Turns whatever was typed into something the prefix rules accept, or gives
 * back the empty string. Upper-cases and drops what is not a letter or a
 * digit, so "bio 26!" becomes "BIO26" rather than being rejected with a
 * lecture about character classes.
 */
export function normalisePrefix(input: string, { maxLength = 10 }: { maxLength?: number } = {}): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, maxLength);
}

/**
 * The reference for one number.
 *
 * `digits` pads and never truncates. A collection numbering to four digits
 * that reaches 10,000 issues `BIO26-10000`, not `BIO26-0000` — truncation
 * would hand the ten-thousandth person a reference somebody else already
 * holds, which is the one thing a reference may never do.
 */
export function formatReference(format: ReferenceFormat, sequenceNumber: number): string {
  const digits = Math.min(Math.max(Math.trunc(format.digits), 1), 8);
  const number = String(Math.trunc(sequenceNumber));
  const padded = number.length >= digits ? number : number.padStart(digits, "0");
  return `${format.prefix}${format.separator}${padded}`;
}

/**
 * The example a settings screen shows under the fields. Uses the starting
 * number so it reads as the FIRST reference this collection will hand out,
 * which is the question an organiser is actually asking.
 */
export function referenceExample(format: ReferenceFormat, startNumber: number): string {
  if (format.prefix === "") return "";
  return formatReference(format, Math.max(Math.trunc(startNumber), 1));
}
