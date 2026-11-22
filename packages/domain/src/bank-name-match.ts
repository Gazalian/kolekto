/**
 * bank-name-match.ts — does a bank account belong to the person on the profile?
 *
 * Owner decision 2026-11-18 (Q3): a saved bank account whose Paystack-resolved
 * name matches the Kolekto profile name may receive withdrawals. A mismatch is
 * never silently accepted and never silently rejected: it goes to an operator
 * (`needs_review`), because Nigerian bank names legitimately differ from what
 * people type (order, middle names, initials, titles).
 *
 * The rule, after normalising both names (case, accents, punctuation, titles,
 * single-letter initials removed):
 *
 *   matched  ⇔  at least two names are shared
 *               AND (every profile name is on the bank account
 *                    OR every bank-account name is on the profile)
 *
 * So "Adaeze Okafor" matches "OKAFOR ADAEZE NKECHI" and "Adaeze Nkechi
 * Okafor" matches "OKAFOR ADAEZE"; "Ada Okafor" vs "OKAFOR ADAEZE" (a short
 * form) and any one-word profile name go to review. Pure; no I/O.
 */

/** Titles and honorifics that appear on Nigerian bank names and profiles but are not names. */
const TITLES: ReadonlySet<string> = new Set([
  "MR", "MRS", "MS", "MISS", "MASTER", "DR", "DOCTOR", "PROF", "PROFESSOR", "ENGR", "ENG", "ARC", "ARCH",
  "CHIEF", "HON", "HONOURABLE", "HONORABLE", "SIR", "LADY", "DAME", "REV", "REVEREND", "PASTOR", "BISHOP",
  "EVANG", "PST", "ALHAJI", "ALHAJA", "ALH", "HAJIA", "HAJIYA", "MALLAM", "MALAM", "BARR", "BARRISTER",
  "PRINCE", "PRINCESS", "OBA", "ESQ", "JNR", "JR", "SNR", "SR",
]);

export type BankNameMatchReason =
  | "profile_names_on_account"
  | "account_names_on_profile"
  | "too_few_profile_names"
  | "names_differ";

export interface BankNameMatch {
  readonly matched: boolean;
  readonly reason: BankNameMatchReason;
  /** How many normalised names the two share. */
  readonly sharedNames: number;
}

/** Upper-case name tokens with accents, punctuation, titles and single-letter initials removed. */
export function nameTokens(name: string): string[] {
  const plain = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    // An apostrophe joins a name (O'Kafor), it does not split it.
    .replace(/['’‘`]/g, "")
    .replace(/[^A-Z]+/g, " ")
    .trim();
  if (plain === "") return [];
  const out: string[] = [];
  for (const token of plain.split(/\s+/)) {
    if (token.length < 2 || TITLES.has(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

export function matchBankAccountName(profileName: string, resolvedAccountName: string): BankNameMatch {
  const profile = nameTokens(profileName);
  const account = nameTokens(resolvedAccountName);
  const shared = profile.filter((t) => account.includes(t)).length;

  if (profile.length < 2) {
    return { matched: false, reason: "too_few_profile_names", sharedNames: shared };
  }
  if (shared >= 2 && shared === profile.length) {
    return { matched: true, reason: "profile_names_on_account", sharedNames: shared };
  }
  if (shared >= 2 && shared === account.length) {
    return { matched: true, reason: "account_names_on_profile", sharedNames: shared };
  }
  return { matched: false, reason: "names_differ", sharedNames: shared };
}
