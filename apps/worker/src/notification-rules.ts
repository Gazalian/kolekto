/**
 * notification-rules.ts — the pure decisions behind notification processing.
 *
 * M13.2 P3. docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md §4, §18 and
 * docs/product/M13.2-MEMBERSHIP-CREATION-INVENTORY.md.
 *
 * Everything here is a pure function of its arguments: no database, no clock (the
 * caller passes `now`), no imports. That is what makes it testable without a
 * database, and it is the only reason this file exists apart from
 * notification-processor.ts, which keeps the SQL.
 *
 * What this module decides:
 *   - whether a queued message is well-formed and should be processed at all;
 *   - who the in-app recipients of each action are (a plan; the processor runs it);
 *   - what goes into an event payload — names, codes and slugs only;
 *   - what is taken from the narrow `before_state` the trigger forwards for a rejection.
 *
 * What it deliberately does NOT do: decide anything about email. P3 writes no email
 * delivery row; eligibility is P4. Nothing in this file mentions a channel.
 */

// ── The queued message ───────────────────────────────────────────────────────

export interface AuditMessage {
  readonly audit_log_id: string;
  readonly community_id: string;
  readonly action: string;
  readonly actor_type: string;
  readonly actor_user_id: string | null;
  readonly actor_name: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly after_state: Record<string, unknown> | null;
  /** Present only for member.reject_join, and already narrowed by the database trigger. */
  readonly before_state: Record<string, unknown> | null;
  readonly created_at: string;
}

/** The actions the trigger enqueues. A message for any other action is acknowledged and ignored. */
export const WATCHED_ACTIONS = [
  "collection.publish",
  "member.create",
  "member.approve_join",
  "member.reject_join",
  "member.join_via_invite",
  "officer_invitation.accept",
  "officer_term.end",
] as const;

export type WatchedAction = (typeof WATCHED_ACTIONS)[number];

/** member.* actions are people acting on a membership; only an officer or a member does that. */
export const MEMBERSHIP_ACTIONS: readonly string[] = [
  "member.create",
  "member.approve_join",
  "member.reject_join",
  "member.join_via_invite",
];

const PERSON_ACTORS: readonly string[] = ["officer", "member"];

/** A notification is stale after 72 hours (decision record 10.6.1). */
export const MAX_EVENT_AGE_MS = 72 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWatchedAction(action: string): action is WatchedAction {
  return (WATCHED_ACTIONS as readonly string[]).includes(action);
}

export function eventKey(action: string, objectId: string): string {
  return `${action}:${objectId}`;
}

// ── Validation: a queued message is untrusted input ──────────────────────────

export type ParseResult =
  | { readonly ok: true; readonly message: AuditMessage }
  | { readonly ok: false; readonly reason: "invalid_message" };

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Check the shape of a queued message and copy out only the fields the processor uses.
 * Never throws: a malformed message is a skip, not a poison message that would be
 * retried forever (there is no retry cap until P6).
 */
export function parseAuditMessage(raw: unknown): ParseResult {
  const r = objectOrNull(raw);
  if (!r) return { ok: false, reason: "invalid_message" };

  const auditLogId = str(r["audit_log_id"], 64);
  const communityId = str(r["community_id"], 64);
  const action = str(r["action"], 80);
  const actorType = str(r["actor_type"], 20);
  const objectType = str(r["object_type"], 80);
  const objectId = str(r["object_id"], 64);
  const createdAt = str(r["created_at"], 64);
  const actorName = str(r["actor_name"], 200) ?? "";
  const actorUserIdRaw = r["actor_user_id"];
  const actorUserId = typeof actorUserIdRaw === "string" && UUID.test(actorUserIdRaw) ? actorUserIdRaw : null;

  if (!auditLogId || !UUID.test(auditLogId)) return { ok: false, reason: "invalid_message" };
  if (!communityId || !UUID.test(communityId)) return { ok: false, reason: "invalid_message" };
  if (!objectId || !UUID.test(objectId)) return { ok: false, reason: "invalid_message" };
  if (!action || !actorType || !objectType || !createdAt) return { ok: false, reason: "invalid_message" };
  if (Number.isNaN(Date.parse(createdAt))) return { ok: false, reason: "invalid_message" };

  return {
    ok: true,
    message: {
      audit_log_id: auditLogId,
      community_id: communityId,
      action,
      actor_type: actorType,
      actor_user_id: actorUserId,
      actor_name: actorName,
      object_type: objectType,
      object_id: objectId,
      after_state: objectOrNull(r["after_state"]),
      before_state: objectOrNull(r["before_state"]),
      created_at: createdAt,
    },
  };
}

// ── Admission: should this message be processed at all? ──────────────────────

export type SkipReason =
  | "invalid_message"
  | "unwatched_action"
  | "not_a_person_action"
  | "event_too_old"
  | "member_unavailable"
  | "imported_member";

export type Admission = { readonly process: true } | { readonly process: false; readonly reason: SkipReason };

export function admission(message: AuditMessage, nowMs: number): Admission {
  if (!isWatchedAction(message.action)) return { process: false, reason: "unwatched_action" };

  // A system, contributor or staff actor on a membership action is not a person acting on a
  // membership (the trigger already ignores these; this is the same rule, held twice).
  if (MEMBERSHIP_ACTIONS.includes(message.action) && !PERSON_ACTORS.includes(message.actor_type)) {
    return { process: false, reason: "not_a_person_action" };
  }

  const created = Date.parse(message.created_at);
  if (nowMs - created > MAX_EVENT_AGE_MS) return { process: false, reason: "event_too_old" };

  return { process: true };
}

/** Historical imports and migrations never notify (inventory path 8). Defence in depth. */
export function isImportedMember(m: { readonly is_imported?: boolean | null; readonly joined_via?: string | null }): boolean {
  return m.is_imported === true || m.joined_via === "import" || m.joined_via === "migration";
}

// ── Who is told in-app ───────────────────────────────────────────────────────

export type RecipientPlan =
  | { readonly kind: "collection_audience" }
  | { readonly kind: "member_self" }
  | { readonly kind: "officers_with_permission"; readonly permission: string }
  | { readonly kind: "officer_term_holder" }
  | { readonly kind: "nobody" };

/**
 * The in-app plan for each action.
 *
 * member.create / member.approve_join: the member themselves, if they have an account
 *   (none do today — nothing links members to accounts; D-LINK).
 * member.join_via_invite: the officers who admit members. NEVER the joiner (R1).
 * member.reject_join: nobody. The requester has no account, and the decision notice is
 *   an email (P4).
 * officer_invitation.accept / officer_term.end: the officer whose term it is.
 */
export function recipientPlan(action: string): RecipientPlan {
  switch (action) {
    case "collection.publish":
      return { kind: "collection_audience" };
    case "member.create":
    case "member.approve_join":
      return { kind: "member_self" };
    case "member.join_via_invite":
      return { kind: "officers_with_permission", permission: "invite.approve" };
    case "officer_invitation.accept":
    case "officer_term.end":
      return { kind: "officer_term_holder" };
    default:
      return { kind: "nobody" };
  }
}

// ── What a rejected requester looks like (from the narrow before_state) ──────

export interface RejectedRequester {
  readonly full_name: string | null;
  readonly joined_via: string | null;
  readonly email: string | null;
}

/**
 * Read the three fields the trigger forwards for a rejection. Anything else in the
 * object — a phone, attributes, a reason — is dropped even if it somehow arrived.
 * The address is only believed if the requester typed it themselves.
 */
export function narrowRequester(raw: unknown): RejectedRequester {
  const o = objectOrNull(raw);
  if (!o) return { full_name: null, joined_via: null, email: null };
  const name = typeof o["full_name"] === "string" ? o["full_name"].slice(0, 120) : null;
  const via = typeof o["joined_via"] === "string" ? o["joined_via"].slice(0, 40) : null;
  const email = via === "invite_link" && typeof o["email"] === "string" ? o["email"].slice(0, 254) : null;
  return { full_name: name, joined_via: via, email };
}

// ── Payloads: names, codes and slugs only ────────────────────────────────────

/** Replace email-shaped text. The database redacts too (20261009100200); this keeps the worker's own output clean. */
const EMAIL_SHAPED = /[^\s"@\\]+@[^\s"@\\]+\.[^\s"@\\]+/g;

export function redactEmails(value: string): string {
  return value.replace(EMAIL_SHAPED, "[email removed]");
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? redactEmails(value).slice(0, max) : null;
}

export type PayloadValue = string | number | boolean | null;
export type Payload = Record<string, PayloadValue>;

/** Facts the processor read from the database, per action. Every field is optional: absence is handled. */
export interface PayloadFacts {
  readonly communitySlug?: string | null;
  readonly communityName?: string | null;
  readonly collectionName?: string | null;
  readonly collectionSlug?: string | null;
  readonly memberName?: string | null;
  readonly memberCode?: string | null;
  readonly officerRole?: string | null;
  readonly endReason?: string | null;
}

/**
 * Build an event payload. The key set is fixed per action and no contact detail has a
 * place in it: there is no field for an email, a phone number or a reason, so none can
 * be put there by accident. Values are clamped and email-shaped text is redacted.
 */
export function buildPayload(message: AuditMessage, facts: PayloadFacts): Payload {
  const base: Payload = {
    actor_name: text(message.actor_name, 120) ?? "",
    community_id: message.community_id,
  };
  const slug = text(facts.communitySlug, 80);

  switch (message.action) {
    case "collection.publish":
      return {
        ...base,
        collection_name: text(facts.collectionName, 200),
        collection_slug: text(facts.collectionSlug, 80),
        community_slug: slug,
      };
    case "member.create":
    case "member.approve_join":
      return {
        ...base,
        member_name: text(facts.memberName, 120),
        member_code: text(facts.memberCode, 32),
        community_name: text(facts.communityName, 120),
        community_slug: slug,
      };
    case "member.join_via_invite":
      return {
        ...base,
        member_name: text(facts.memberName, 120),
        community_name: text(facts.communityName, 120),
        community_slug: slug,
      };
    case "member.reject_join":
      // The requester's name only. Not the address, not the phone, not the officer's reason.
      return {
        ...base,
        member_name: text(facts.memberName, 120),
        community_name: text(facts.communityName, 120),
        community_slug: slug,
      };
    case "officer_invitation.accept":
      return {
        ...base,
        officer_role: text(facts.officerRole, 40),
        community_name: text(facts.communityName, 120),
        community_slug: slug,
      };
    case "officer_term.end":
      return {
        ...base,
        officer_role: text(facts.officerRole, 40),
        end_reason: text(facts.endReason, 40),
        community_name: text(facts.communityName, 120),
        community_slug: slug,
      };
    default:
      return base;
  }
}
