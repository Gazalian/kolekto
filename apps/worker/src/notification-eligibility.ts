/**
 * notification-eligibility.ts — the worker-side half of P4 recipient eligibility.
 *
 * M13.2 P4. Companion to the database function
 * `app.evaluate_email_eligibility` (20261012100000), which remains the authority
 * for the Auth confirmation state and the supplied address. Nothing here reads
 * an address: this module only decides WHETHER an event is an email-evaluation
 * event, which deduplication key an eligible confirmation carries, and which
 * skip-reason strings the processor may store.
 *
 * Pure, like notification-rules.ts: no database, no clock, no imports. That is
 * what makes it testable without a database.
 *
 * ── EVENT CATEGORIES (the skip-row consistency rule) ─────────────────────────
 * Email-evaluation events always produce an email delivery row: `pending` when
 * eligible, `skipped` with a stable `error_code` when not. All other events
 * produce no email row at all:
 *
 *   evaluation: member.create, member.approve_join (E1/E2 confirmations),
 *               officer_invitation.accept, officer_term.end (E4/E5 notices)
 *   no row:     member.reject_join (rejection mail to an unverified supplied
 *               address is not approved; decision R-E3 stays open),
 *               member.join_via_invite (R1: no joiner mail, ever),
 *               collection.publish (in-app only by default),
 *               anything unwatched
 *
 * ── DEDUPLICATION ────────────────────────────────────────────────────────────
 * Membership confirmations share `membership_confirmation:{member_id}` so
 * creation and approval for one member collapse to a single logical email
 * (the partial unique index from 20261009100100 enforces it). The key is set
 * on eligible (`pending`) rows only: a skipped evaluation must never block a
 * later eligible one. Officer notices need no key — their event key already
 * identifies one term event for one holder.
 */

export const EMAIL_EVALUATION_EVENTS: readonly string[] = [
  "member.create",
  "member.approve_join",
  "officer_invitation.accept",
  "officer_term.end",
];

export function isEmailEvaluationEvent(action: string): boolean {
  return EMAIL_EVALUATION_EVENTS.includes(action);
}

/**
 * Stable skip reasons the processor may store in `error_code`. They satisfy the
 * delivery-table format (`^[a-z][a-z0-9_]{2,63}$`) and the decision-record §7.4
 * vocabulary. A skip is a policy outcome, never a provider failure, and is
 * never retried as one.
 */
export type EligibilitySkipReason =
  | "unverified_account_email"
  | "no_recipient"
  | "invalid_recipient_address"
  | "unsupported_event"
  | "unverified_address_not_allowed"
  | "ambiguous_recipient_relationship"
  | "missing_membership_relationship";

export type EmailOutcome =
  | { readonly kind: "no_row" }
  | { readonly kind: "pending" }
  | { readonly kind: "skipped"; readonly reason: EligibilitySkipReason };

/** The deduplication key for an eligible membership confirmation, or null. */
export function emailDedupeKey(action: string, memberId: string): string | null {
  if (action === "member.create" || action === "member.approve_join") {
    return `membership_confirmation:${memberId}`;
  }
  return null;
}
