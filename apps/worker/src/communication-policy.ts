/**
 * communication-policy.ts — the central communication policy (M13.3 R1).
 *
 * docs/product/M13.3-COMMUNITY-NOTIFICATIONS-ARCHITECTURE-REVIEW.md §4 and §6,
 * approved in principle at R0. This module is the single place that says:
 *
 *   1. which communication CATEGORY each notification event belongs to;
 *   2. what each category requires on each CHANNEL before anything is sent;
 *   3. how a concrete set of facts about one recipient turns into
 *      "send" or "skip with a stable reason";
 *   4. who may record which communication choice.
 *
 * Pure: no database, no clock, no imports. Callers (the processor today, the
 * send-time recheck in R3) gather facts and ask this module for a decision, so
 * every reclassification is a one-line, reviewable change here.
 *
 * ── WHAT CHANGED FROM M13.2 ──────────────────────────────────────────────────
 * M13.2 made `members.consent_messages_at` a gate for every announcement and
 * reminder. That gate is RETIRED for essential (A), community operational (B)
 * and payment (D) communications. Consent remains a requirement only for
 * marketing (C), and is stored separately from membership. Nothing here
 * writes, infers or back-fills any consent or permission.
 *
 * This is an engineering policy. It is not proof of a lawful basis: the legal
 * questions in the review (§5, L1–L12) remain open.
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const COMMUNICATION_CATEGORIES = [
  /** A. Essential service and transaction messages. */
  "essential",
  /** B. Ordinary community operational announcements and collection updates. */
  "community_operational",
  /** C. Promotional or marketing communications. */
  "marketing",
  /** D. Payment reminders and payment-status notifications. */
  "payment",
] as const;
export type CommunicationCategory = (typeof COMMUNICATION_CATEGORIES)[number];

export const CHANNELS = ["in_app", "email", "whatsapp", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Within payment (D): a status notice (receipt, "payment received") versus a
 * targeted reminder ("you have an outstanding balance"). Both depend on
 * reliable payment attribution, which does not exist yet.
 */
export type PaymentPurpose = "status" | "targeted_reminder";

/** Permissions that only the member themselves can give, stored apart from membership. */
export type MemberPermission = "whatsapp_permission" | "marketing_consent";

/**
 * What a category needs on a channel.
 *
 *   always       — no opt-out (minimal, non-promotional content only)
 *   default_on   — sent unless the member opted out; for community messages
 *                  on external channels, also requires the community notice
 *                  attestation (R0 decision 3)
 *   opt_in       — sent only with every listed member-given permission
 *   disabled     — never sent on this channel (for now or by design)
 */
export type Requirement =
  | { readonly kind: "always" }
  | { readonly kind: "default_on"; readonly requiresCommunityNotice: boolean }
  | { readonly kind: "opt_in"; readonly permissions: readonly MemberPermission[] }
  | { readonly kind: "disabled"; readonly reason: DisabledReason };

export type DisabledReason =
  /** SMS stays off until NCC requirements and provider arrangements are verified (R0 decision 6). */
  | "channel_disabled"
  /** Payment communications need reliable payment attribution (R0 decision 7; gap G3). */
  | "payment_attribution_unavailable"
  /** The category is never delivered on this channel (e.g. marketing in-app). */
  | "category_not_on_channel";

/**
 * Platform capabilities that switch whole rows of the matrix on or off. Each is
 * false today and becomes true only through its own reviewed change. Passed
 * explicitly so tests can prove the future matrix without enabling anything.
 */
export interface PolicyCapabilities {
  /** A contributions record ties payments to obligations (G3). Not built. */
  readonly paymentAttribution: boolean;
  /** NCC requirements verified and an SMS provider contracted. Not done. */
  readonly smsApproved: boolean;
}

export const CURRENT_CAPABILITIES: PolicyCapabilities = Object.freeze({
  paymentAttribution: false,
  smsApproved: false,
});

// ── 1. Event → category ──────────────────────────────────────────────────────

/**
 * How an event's email is decided:
 *   per_event_recipient — one recipient fixed by the event (membership
 *                         confirmation, officer notice), via
 *                         app.evaluate_email_eligibility
 *   per_audience_member — one row per member of the collection audience, via
 *                         app.evaluate_collection_email_recipients
 *   none                — this event never produces an email row (a product
 *                         rule, e.g. R-E3: no rejection mail; R1: no joiner mail)
 */
export type EmailFanout = "per_event_recipient" | "per_audience_member" | "none";

/**
 * The preference topic inside community operational messages. It is also the
 * `p_category` argument of app.evaluate_collection_email_recipients, so the
 * database call is unchanged by R1.
 */
export type CommunityTopic = "announcement" | "update" | "reminder";

export interface EventPolicy {
  readonly category: CommunicationCategory;
  readonly emailFanout: EmailFanout;
  readonly topic?: CommunityTopic;
  readonly paymentPurpose?: PaymentPurpose;
}

const EVENT_POLICIES: Readonly<Record<string, EventPolicy>> = Object.freeze({
  // A. Essential: the member's own membership record and ID (E1/E2).
  "member.create": { category: "essential", emailFanout: "per_event_recipient" },
  "member.approve_join": { category: "essential", emailFanout: "per_event_recipient" },
  // A. Essential: officer access granted / ended (E4/E5).
  "officer_invitation.accept": { category: "essential", emailFanout: "per_event_recipient" },
  "officer_term.end": { category: "essential", emailFanout: "per_event_recipient" },
  // A. Essential service notices with no email by product rule.
  "member.reject_join": { category: "essential", emailFanout: "none" },
  "member.join_via_invite": { category: "essential", emailFanout: "none" },

  // B. Community operational. Neutral: none of these says what anyone owes.
  "collection.publish": { category: "community_operational", emailFanout: "per_audience_member", topic: "announcement" },
  "collection.announce_update": { category: "community_operational", emailFanout: "per_audience_member", topic: "update" },
  "collection.remind": { category: "community_operational", emailFanout: "per_audience_member", topic: "reminder" },

  // D. Payment: targeted at "members who still owe". Blocked by the matrix
  // until payment attribution is reliable (R0 decision 7).
  "collection.publish_remind_unpaid": {
    category: "payment",
    emailFanout: "per_audience_member",
    paymentPurpose: "targeted_reminder",
  },
  "collection.remind_unpaid": {
    category: "payment",
    emailFanout: "per_audience_member",
    paymentPurpose: "targeted_reminder",
  },

  // C. Marketing: no event is marketing today. A marketing event must be
  // added here explicitly; nothing defaults to marketing.
});

/** The policy for an event, or null for an event the policy does not know (sends nothing). */
export function eventPolicy(action: string): EventPolicy | null {
  return Object.prototype.hasOwnProperty.call(EVENT_POLICIES, action) ? EVENT_POLICIES[action]! : null;
}

/** Every event the policy classifies (for exhaustive tests and invariants). */
export function classifiedEvents(): readonly string[] {
  return Object.keys(EVENT_POLICIES);
}

// ── 2. Category × channel → requirement ──────────────────────────────────────

const ALWAYS: Requirement = Object.freeze({ kind: "always" });
const disabled = (reason: DisabledReason): Requirement => Object.freeze({ kind: "disabled", reason });
const optIn = (...permissions: MemberPermission[]): Requirement =>
  Object.freeze({ kind: "opt_in", permissions: Object.freeze([...permissions]) });
const defaultOn = (requiresCommunityNotice: boolean): Requirement =>
  Object.freeze({ kind: "default_on", requiresCommunityNotice });

/**
 * The approved matrix (review §4.2 / §4.3, R0 decisions 1–7).
 *
 *                 in_app       email                 whatsapp                 sms
 *   essential     always       always                opt_in(whatsapp)         disabled*
 *   community     always       default_on+notice     opt_in(whatsapp)         disabled*
 *   marketing     not on chan  opt_in(marketing)     opt_in(marketing,wa)     disabled*
 *   payment       disabled until attribution; then:
 *     status      always       always                opt_in(whatsapp)         disabled*
 *     reminder    always       default_on+notice     opt_in(whatsapp)         disabled*
 *
 *   * until smsApproved; then essential/payment-status always, community and
 *     payment reminders default_on (opt-out), marketing opt_in(marketing).
 *
 * In-app is reachable only by members with a linked account; that is a
 * recipient fact, not a permission, and is enforced by the recipient plan.
 * In-app community messages are not configurable (existing table comment).
 */
export function channelRequirement(
  category: CommunicationCategory,
  channel: Channel,
  options: {
    readonly paymentPurpose?: PaymentPurpose | undefined;
    readonly capabilities?: PolicyCapabilities | undefined;
  } = {},
): Requirement {
  const caps = options.capabilities ?? CURRENT_CAPABILITIES;

  if (category === "payment" && !caps.paymentAttribution) return disabled("payment_attribution_unavailable");

  // A payment notice is classed by its purpose once attribution exists: a
  // status notice is essential-like, a targeted reminder is opt-out-able.
  const effective: "essential" | "community_operational" | "marketing" =
    category === "payment"
      ? options.paymentPurpose === "status"
        ? "essential"
        : "community_operational"
      : category;

  switch (channel) {
    case "in_app":
      return effective === "marketing" ? disabled("category_not_on_channel") : ALWAYS;

    case "email":
      if (effective === "essential") return ALWAYS;
      if (effective === "community_operational") return defaultOn(true);
      return optIn("marketing_consent");

    case "whatsapp":
      // WhatsApp is opt-in only, for every category (R0 decision 5). Community
      // membership never implies it.
      return effective === "marketing" ? optIn("marketing_consent", "whatsapp_permission") : optIn("whatsapp_permission");

    case "sms":
      if (!caps.smsApproved) return disabled("channel_disabled");
      if (effective === "essential") return ALWAYS;
      if (effective === "community_operational") return defaultOn(true);
      return optIn("marketing_consent");
  }
}

/** The requirement for one event on one channel, or null when the event is unclassified. */
export function eventChannelRequirement(
  action: string,
  channel: Channel,
  capabilities: PolicyCapabilities = CURRENT_CAPABILITIES,
): Requirement | null {
  const p = eventPolicy(action);
  if (!p) return null;
  return channelRequirement(p.category, channel, { paymentPurpose: p.paymentPurpose, capabilities });
}

// ── 3. Facts → decision ──────────────────────────────────────────────────────

/** Stable skip codes this policy can produce (delivery error_code format). */
export type PolicySkipReason =
  | "opted_out"
  | "community_notice_missing"
  | "channel_permission_missing"
  | "marketing_consent_missing"
  | DisabledReason;

/**
 * What the caller knows about one recipient. Each fact must come from a store
 * that actually records it; a caller that cannot read a store passes the
 * restrictive value (`communityNoticeAttested: false`, an empty permission set).
 */
export interface RecipientFacts {
  /** The member has opted out of this category on this channel. */
  readonly optedOut: boolean;
  /** An authorised organiser has completed the community notice attestation. */
  readonly communityNoticeAttested: boolean;
  /** Member-given permissions currently in force (never inferred). */
  readonly permissions: ReadonlySet<MemberPermission>;
}

export type PolicyDecision =
  | { readonly send: true }
  | { readonly send: false; readonly reason: PolicySkipReason };

const SEND: PolicyDecision = Object.freeze({ send: true });
const skip = (reason: PolicySkipReason): PolicyDecision => Object.freeze({ send: false, reason });

/**
 * Apply a requirement to one recipient's facts. Order:
 *   disabled → member opt-out → community notice → member-given permissions.
 * A member's own opt-out is reported before the community notice so organisers
 * see the member's choice, not an administrative gap.
 */
export function decide(requirement: Requirement, facts: RecipientFacts): PolicyDecision {
  switch (requirement.kind) {
    case "disabled":
      return skip(requirement.reason);
    case "always":
      return SEND;
    case "default_on":
      if (facts.optedOut) return skip("opted_out");
      if (requirement.requiresCommunityNotice && !facts.communityNoticeAttested) return skip("community_notice_missing");
      return SEND;
    case "opt_in":
      // A withdrawal is an opt-out too: it wins even if a permission row lingers.
      if (facts.optedOut) return skip("opted_out");
      if (requirement.permissions.includes("marketing_consent") && !facts.permissions.has("marketing_consent")) {
        return skip("marketing_consent_missing");
      }
      if (requirement.permissions.includes("whatsapp_permission") && !facts.permissions.has("whatsapp_permission")) {
        return skip("channel_permission_missing");
      }
      return SEND;
  }
}

/** The send class for an email in this category (rate-limit / quota bucket). */
export function emailSendClass(
  category: CommunicationCategory,
  paymentPurpose?: PaymentPurpose,
): "transactional" | "bulk" | null {
  if (category === "essential") return "transactional";
  if (category === "community_operational") return "bulk";
  if (category === "payment") return paymentPurpose === "status" ? "transactional" : "bulk";
  // Marketing has no send class: nothing may send it until a marketing
  // consent store and its own quota exist.
  return null;
}

// ── 4. Who may record which choice ───────────────────────────────────────────

export type ChoiceActor = "member" | "organiser";
export type ChoiceKind = "opt_out" | "opt_in" | "grant_permission" | "withdraw_permission";

/**
 * R0 decision 4: an organiser may record an opt-out when a member requests it,
 * and must never reverse a member's opt-out or grant a permission on their
 * behalf. Only the member can opt back in or give a permission. Withdrawing a
 * permission is a form of opting out, so an organiser may record it on the
 * member's request.
 */
export function mayRecordChoice(actor: ChoiceActor, choice: ChoiceKind): boolean {
  if (actor === "member") return true;
  return choice === "opt_out" || choice === "withdraw_permission";
}
