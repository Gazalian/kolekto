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
 * Pure, like notification-rules.ts: no database, no clock, and no imports other
 * than the (equally pure) central communication policy, communication-policy.ts,
 * which owns every category and channel requirement. That is what makes it
 * testable without a database.
 *
 * ── EVENT CATEGORIES (the skip-row consistency rule) ─────────────────────────
 * Email-evaluation events always produce an email delivery row: `pending` when
 * eligible, `skipped` with a stable `error_code` when not. All other events
 * produce no email row at all:
 *
 *   evaluation: member.create, member.approve_join (E1/E2 confirmations),
 *               officer_invitation.accept, officer_term.end (E4/E5 notices)
 *   no row:     member.reject_join (R-E3 final: no rejection mail to an
 *               unverified supplied address),
 *               member.join_via_invite (R1: no joiner mail, ever),
 *               anything unwatched
 *   collection: collection.publish, collection.remind,
 *               collection.announce_update — one row per audience member,
 *               decided by app.evaluate_collection_email_recipients (see the
 *               member-announcements section below)
 *
 * ── DEDUPLICATION ────────────────────────────────────────────────────────────
 * Membership confirmations share `membership_confirmation:{member_id}` so
 * creation and approval for one member collapse to a single logical email
 * (the partial unique index from 20261009100100 enforces it). The key is set
 * on eligible (`pending`) rows only: a skipped evaluation must never block a
 * later eligible one. Officer notices need no key — their event key already
 * identifies one term event for one holder.
 */

import {
  classifiedEvents,
  decide,
  emailSendClass,
  eventChannelRequirement,
  eventPolicy,
  type PolicySkipReason,
} from "./communication-policy.ts";

/**
 * Derived from the central communication policy (communication-policy.ts, M13.3
 * R1): the events whose single recipient is evaluated by
 * app.evaluate_email_eligibility, and whose email requirement is `always`
 * (essential). Today: member.create, member.approve_join,
 * officer_invitation.accept, officer_term.end.
 */
export const EMAIL_EVALUATION_EVENTS: readonly string[] = Object.freeze(
  classifiedEvents().filter(
    (action) =>
      eventPolicy(action)?.emailFanout === "per_event_recipient" &&
      eventChannelRequirement(action, "email")?.kind === "always",
  ),
);

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
  | { readonly kind: "skipped"; readonly reason: EligibilitySkipReason }
  // Member announcements: one email row per audience member.
  | { readonly kind: "collection"; readonly pending: number; readonly skipped: number }
  // The eligibility function is not installed (proposal not yet applied, or
  // the worker role lacks the grant). No email row is written; in-app
  // delivery is unaffected.
  | { readonly kind: "collection_unavailable" };

// ── Member announcements (collection email) ──────────────────────────────────
//
// Collection announcements go to community MEMBERS through the contact on
// their member record. No account is required. Two authorities combine:
//
//   · the database function app.evaluate_collection_email_recipients decides
//     the FACTS — reachability, member availability, the member's stored
//     opt-out, and the address;
//   · the central communication policy (communication-policy.ts) decides what
//     those facts REQUIRE for this category and channel.
//
// M13.3 R1: consent is no longer a requirement for community operational
// email. The database proposal still returns `consent_missing` (its revision
// is R2), so that answer is no longer treated as a policy outcome:
// collectionMemberDecision() reports the policy's own reason instead, and
// `legacy_consent_gate` only when the policy would send but the database still
// withheld the address for consent.
//
// Payment-targeted actions (collection.publish_remind_unpaid,
// collection.remind_unpaid) are classed `payment` and are blocked by the policy
// until payment attribution is reliable, so they produce no email (and no
// in-app) delivery.

export type CollectionEmailCategory = "announcement" | "update" | "reminder";

/**
 * The preference topic (the database function's `p_category`) for a
 * collection email event, or null when the action sends no collection email.
 * Only community operational, per-audience events qualify; payment-targeted
 * events are null while the policy blocks them.
 */
export function collectionEmailCategory(action: string): CollectionEmailCategory | null {
  const p = eventPolicy(action);
  if (!p || p.emailFanout !== "per_audience_member" || p.category !== "community_operational" || !p.topic) return null;
  return eventChannelRequirement(action, "email")?.kind === "disabled" ? null : p.topic;
}

/**
 * Collection email is community operational communication: classed `bulk` by
 * the policy so it never consumes the transactional quota that membership
 * confirmations and officer notices rely on. Bulk caps are zero until an
 * operator raises them in a reviewed migration, so these rows defer (and age
 * out at 72 h) until bulk sending is deliberately opened.
 */
export const COLLECTION_EMAIL_SEND_CLASS = emailSendClass("community_operational") as "bulk";

/**
 * Skip reasons app.evaluate_collection_email_recipients may return. The M13.3
 * R2 proposal returns `community_notice_missing` and never `consent_missing`;
 * `consent_missing` is still accepted from the M13.2 version of the proposal.
 */
export type CollectionDbSkipReason =
  | "collection_not_reachable"
  | "member_unavailable"
  | "consent_missing"
  | "opted_out"
  | "community_notice_missing"
  | "unverified_account_email"
  | "no_recipient"
  | "invalid_recipient_address"
  // The database's own policy matrix (app.communication_requirement) disabled
  // community email outright. Not reachable today; reported as given.
  | "category_not_on_channel"
  | "channel_disabled"
  | "payment_attribution_unavailable";

export const COLLECTION_DB_SKIP_REASONS: readonly string[] = Object.freeze([
  "collection_not_reachable",
  "member_unavailable",
  "consent_missing",
  "opted_out",
  "community_notice_missing",
  "unverified_account_email",
  "no_recipient",
  "invalid_recipient_address",
  "category_not_on_channel",
  "channel_disabled",
  "payment_attribution_unavailable",
]);

/**
 * Stable skip reasons the worker stores on a collection email row. `consent_missing`
 * is not among them: consent is not a requirement for community operational email.
 */
export type CollectionSkipReason =
  | Exclude<CollectionDbSkipReason, "consent_missing">
  | Extract<PolicySkipReason, "community_notice_missing" | "opted_out" | "payment_attribution_unavailable" | "category_not_on_channel" | "channel_disabled">
  | "legacy_consent_gate";

/**
 * Normalise a skip reason from the database. Anything unexpected becomes
 * `no_recipient` — still a skip, never a send.
 */
export function collectionSkipReason(value: string | null | undefined): CollectionDbSkipReason {
  return (value && COLLECTION_DB_SKIP_REASONS.includes(value) ? value : "no_recipient") as CollectionDbSkipReason;
}

/** One row of app.evaluate_collection_email_recipients, as the decision needs it. */
export interface CollectionRecipientFacts {
  readonly eligible: boolean;
  readonly address: string | null;
  readonly assurance: string | null;
  readonly skip_reason: string | null;
}

export type CollectionMemberDecision =
  | { readonly send: true }
  | { readonly send: false; readonly reason: CollectionSkipReason };

/**
 * Database reasons that hold before any per-member policy question: there is
 * nobody to ask about, or the database's own matrix disabled the channel.
 */
const PRE_POLICY_REASONS: readonly CollectionDbSkipReason[] = [
  "collection_not_reachable",
  "member_unavailable",
  "category_not_on_channel",
  "channel_disabled",
  "payment_attribution_unavailable",
];

/**
 * Decide one audience member's collection email from the database facts and
 * the central policy. Order:
 *   collection_not_reachable / member_unavailable (database)
 *   → policy: opted_out, community_notice_missing (communication-policy.decide)
 *   → legacy_consent_gate (database still applies the retired consent gate)
 *   → address reasons (database)
 *   → send.
 * Never sends without an address and assurance from the database.
 */
export function collectionMemberDecision(
  action: string,
  row: CollectionRecipientFacts,
  facts: { readonly communityNoticeAttested: boolean },
): CollectionMemberDecision {
  const requirement = eventChannelRequirement(action, "email");
  if (!requirement) return { send: false, reason: "category_not_on_channel" };

  const hasAddress = row.eligible === true && row.address !== null && row.assurance !== null;
  const dbReason: CollectionDbSkipReason | null = hasAddress ? null : collectionSkipReason(row.skip_reason);

  if (dbReason && PRE_POLICY_REASONS.includes(dbReason)) return { send: false, reason: dbReason as CollectionSkipReason };

  const policy = decide(requirement, {
    optedOut: dbReason === "opted_out",
    // Either authority saying "not attested" is enough (restrictive): the
    // worker's own read, or the database decision (M13.3 R2 proposal).
    communityNoticeAttested: facts.communityNoticeAttested && dbReason !== "community_notice_missing",
    // Community operational email needs no member-given permission.
    permissions: new Set(),
  });
  if (!policy.send) {
    // Community operational email can only be skipped by the policy for these
    // reasons; anything else would mean the matrix changed under this caller.
    const r = policy.reason;
    const known: readonly string[] = ["opted_out", "community_notice_missing", "payment_attribution_unavailable", "category_not_on_channel"];
    return { send: false, reason: (known.includes(r) ? r : "category_not_on_channel") as CollectionSkipReason };
  }

  if (dbReason === "consent_missing") return { send: false, reason: "legacy_consent_gate" };
  if (dbReason) return { send: false, reason: dbReason as CollectionSkipReason };
  return { send: true };
}

/** The deduplication key for an eligible membership confirmation, or null. */
export function emailDedupeKey(action: string, memberId: string): string | null {
  if (action === "member.create" || action === "member.approve_join") {
    return `membership_confirmation:${memberId}`;
  }
  return null;
}
