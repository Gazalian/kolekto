/**
 * The membership-ID identification flow (A2.5), as plain functions.
 *
 * The component (FindYourself.tsx) owns rendering; this module owns what each
 * step does with the A2.4 server actions and which screen comes next. It has no
 * React, no "use server" and no node imports, so it is safe in the browser and
 * testable in node with the actions injected.
 *
 * What this module never handles: the membership access token or the member's
 * UUID. Both live in httpOnly cookies set by the server actions. The browser
 * only ever sees a yes/no, a masked summary, and — after confirmation — the
 * member context the server chose to describe.
 */

import type { MemberContextResult, MembershipPassSummaryResult, MembershipPassValidationResult } from "./actions.ts";

/** One message for every invalid ID: unknown, revoked, suspended, archived or outside the audience all look the same. */
export const INVALID_MEMBERSHIP_ID_MESSAGE = "We couldn't find a member with this ID. Please check and try again.";
/** The pass cookie is missing, tampered with, or older than 30 minutes. */
export const PASS_EXPIRED_MESSAGE = "That identification has expired. Enter your membership ID again.";
/** A server action threw (network, server error). Says nothing about why. */
export const TRY_AGAIN_MESSAGE = "Something went wrong. Please try again.";

/**
 * Shortest canonical ID worth sending: a 2-character prefix plus a 5-character
 * suffix (see lib/membership-id.ts). Shorter input cannot match, so the button
 * stays disabled rather than spending a rate-limited attempt.
 */
export const MIN_CANONICAL_MEMBERSHIP_ID_LENGTH = 7;
/** Longest format: 10-character prefix, a separator, 8-character suffix — with room for stray spaces. */
export const MAX_MEMBERSHIP_ID_INPUT_LENGTH = 32;

/**
 * What the input shows and submits: upper-case, outer whitespace trimmed and
 * inner runs of whitespace collapsed. Every step here is one the database's
 * app.canonical_membership_id also performs, so it never changes which member
 * an ID resolves to — the database remains the only place IDs are compared.
 */
export function normaliseMembershipIdInput(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, " ").trimStart();
}

/** The value actually sent to the server. */
export function membershipIdForSubmission(raw: string): string {
  return normaliseMembershipIdInput(raw).trim();
}

/**
 * The comparison form, mirroring canonicalMembershipId() in lib/membership-id.ts
 * and app.canonical_membership_id in SQL. Used only to decide whether the input
 * is long enough to submit. That module imports node:crypto, so it cannot be
 * imported here; a test pins the two together.
 */
export function canonicalMembershipIdLength(raw: string): number {
  return raw
    .toUpperCase()
    .replace(/[\s/\-_.]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1").length;
}

export function canSubmitMembershipId(raw: string): boolean {
  return canonicalMembershipIdLength(raw) >= MIN_CANONICAL_MEMBERSHIP_ID_LENGTH;
}

/** Exactly what the confirmation screen may show. Built field by field so nothing else the server sends is rendered. */
export interface MaskedMemberSummary {
  fullName: string;
  emailMasked: string | null;
  phoneMasked: string | null;
}

export type IdentifyScreen =
  | { step: "enter"; error: string | null }
  | { step: "confirm"; summary: MaskedMemberSummary };

export type IdentifiedMember = NonNullable<MemberContextResult["member"]>;

export interface IdentifyActions {
  validate(typedId: string): Promise<MembershipPassValidationResult>;
  summary(): Promise<MembershipPassSummaryResult>;
  confirm(): Promise<MemberContextResult>;
  reject(): Promise<void>;
}

export const ENTER_SCREEN: IdentifyScreen = { step: "enter", error: null };

function toMaskedSummary(summary: MaskedMemberSummary): MaskedMemberSummary {
  return {
    fullName: summary.fullName,
    emailMasked: summary.emailMasked ?? null,
    phoneMasked: summary.phoneMasked ?? null,
  };
}

/**
 * Screen 1 → Screen 2. Validates the ID (the server sets the pass cookie on
 * success), then loads the masked summary for that pass.
 */
export async function submitMembershipId(actions: IdentifyActions, raw: string): Promise<IdentifyScreen> {
  const typedId = membershipIdForSubmission(raw);
  if (!canSubmitMembershipId(typedId)) return { step: "enter", error: INVALID_MEMBERSHIP_ID_MESSAGE };

  let validation: MembershipPassValidationResult;
  try {
    validation = await actions.validate(typedId);
  } catch {
    return { step: "enter", error: TRY_AGAIN_MESSAGE };
  }
  // Whatever the server's reason, the contributor sees the same sentence.
  if (!validation.valid) return { step: "enter", error: INVALID_MEMBERSHIP_ID_MESSAGE };

  let loaded: MembershipPassSummaryResult;
  try {
    loaded = await actions.summary();
  } catch {
    return { step: "enter", error: TRY_AGAIN_MESSAGE };
  }
  if (loaded.error || !loaded.summary) return { step: "enter", error: PASS_EXPIRED_MESSAGE };

  return { step: "confirm", summary: toMaskedSummary(loaded.summary) };
}

export type ConfirmOutcome = { member: IdentifiedMember } | { screen: IdentifyScreen };

/**
 * Screen 2 → Screen 3. Only a member returned by the server counts: the
 * confirmation re-checks the pass and eligibility, writes the audit row and
 * swaps the pass cookie for the contributor-session cookie.
 */
export async function confirmIdentity(actions: IdentifyActions): Promise<ConfirmOutcome> {
  let confirmed: MemberContextResult;
  try {
    confirmed = await actions.confirm();
  } catch {
    return { screen: { step: "enter", error: TRY_AGAIN_MESSAGE } };
  }
  if (confirmed.error || !confirmed.member) {
    return { screen: { step: "enter", error: confirmed.error ?? PASS_EXPIRED_MESSAGE } };
  }
  return { member: confirmed.member };
}

/**
 * Screen 2 → Screen 1, "No, that's not me". The client forgets the summary
 * whatever the server says: a failed cookie clear leaves only a pass that
 * expires in 30 minutes and is overwritten by the next ID typed.
 */
export async function rejectIdentity(actions: IdentifyActions): Promise<IdentifyScreen> {
  try {
    await actions.reject();
  } catch {
    // Nothing to show: the screen resets either way.
  }
  return ENTER_SCREEN;
}

/**
 * Drops a call made while the previous one is still running. The component
 * wraps every server round trip in this, so a double tap or a second Enter
 * before React re-renders with the loading state sends one request, not two.
 */
export function createSingleFlight(): (task: () => Promise<void>) => boolean {
  let running = false;
  return (task) => {
    if (running) return false;
    running = true;
    const release = (): void => {
      running = false;
    };
    // Released on failure too, so one failed request never locks the screen.
    void task().then(release, release);
    return true;
  };
}

/**
 * The payer's details once a member is confirmed: the member's name is
 * prefilled, email and phone start empty. The person paying supplies their own
 * contact details; the membership ID only decides whose contribution it is.
 */
export function payerDetailsAfterIdentification(member: Pick<IdentifiedMember, "fullName">): {
  fullName: string;
  email: string;
  phone: string;
} {
  return { fullName: member.fullName, email: "", phone: "" };
}
