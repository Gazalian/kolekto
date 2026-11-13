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
  // M13.3: host targeted the "still owes payment" cohort at publish time; the
  // worker's recipient plan filters the audience by outstanding obligation.
  "collection.publish_remind_unpaid",
  // M13.3 post-publish reminders: an organiser can notify an already-published
  // collection's audience later. `collection.remind` reuses the full-audience
  // plan; `collection.remind_unpaid` reuses the outstanding-obligation filter.
  "collection.remind",
  "collection.remind_unpaid",
  // An organiser explicitly announces changes to a live collection. Queued by
  // the trigger since 20261109100100_member_collection_announcements.sql;
  // scripts/invariants keeps this list equal to the trigger's c_watched.
  "collection.announce_update",
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

/**
 * The processor dedupes an event on `event_key` so a redelivered message does
 * not create a second event (QA BUG-4). Most actions fire at most once per
 * object (a collection publishes once; a member is created once), so keying on
 * (action, object_id) is both unique and natural. The post-publish reminder
 * actions (`collection.remind`, `collection.remind_unpaid`) fire many times
 * for the same collection — one per organiser click — so they key on the
 * audit_log_id instead. A redelivered reminder still dedupes (same
 * audit_log_id), while a later reminder gets its own event.
 */
/** Actions an organiser may fire many times for one collection; each fire is its own event. */
export const REPEATABLE_ACTIONS: readonly string[] = [
  "collection.remind",
  "collection.remind_unpaid",
  "collection.announce_update",
];

export function eventKey(action: string, objectId: string, auditLogId?: string): string {
  if (REPEATABLE_ACTIONS.includes(action) && auditLogId) {
    return `${action}:${auditLogId}`;
  }
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
 * Never throws: a malformed message is a skip, not a poison message. The event
 * loop (index.ts) archives messages past a read_ct threshold (P6).
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

/**
 * A member who has been archived or merged away is not someone to notify (decision record F-3).
 * A member awaiting approval IS available: officers must still hear that someone applied.
 */
export function isUnavailableMember(m: {
  readonly status?: string | null;
  readonly archived_at?: string | null;
  readonly merged_into_id?: string | null;
}): boolean {
  return m.status === "archived" || m.status === "merged" || (m.archived_at ?? null) !== null || (m.merged_into_id ?? null) !== null;
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
  | { readonly kind: "nobody" }
  // Payment-status targeting is disabled: Kolekto records no contributions
  // and nothing ever moves an obligation to paid, so "unpaid" would include
  // people who have paid (cash, transfer). The event is kept; nobody is told.
  | { readonly kind: "payment_status_unavailable" };

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
    case "collection.remind":
    case "collection.announce_update":
      return { kind: "collection_audience" };
    case "collection.publish_remind_unpaid":
    case "collection.remind_unpaid":
      return { kind: "payment_status_unavailable" };
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
  /** Member announcements: true only when app.collection_announcement_context was read; gates every field below. */
  readonly announcementContext?: boolean;
  readonly collectionDescription?: string | null;
  readonly amountModel?: string | null;
  /** Integer kobo as a digit string (JSON-safe). */
  readonly fixedAmountKobo?: string | null;
  readonly deadlineAt?: string | null;
  readonly changedFields?: readonly string[] | null;
  /** Member announcements: organiser-authored message (stripped of email addresses in the DB, ≤1000 chars). */
  readonly announcementBody?: string | null;
  /** Member announcements: per-send target ("all_members" | "groups" | "selected_members"). */
  readonly targetAudience?: string | null;
  /** Member announcements: group ids when target=groups. */
  readonly targetGroupIds?: readonly string[] | null;
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
    case "collection.publish_remind_unpaid":
    case "collection.remind":
    case "collection.remind_unpaid":
    case "collection.announce_update":
      return {
        ...base,
        collection_name: text(facts.collectionName, 200),
        collection_slug: text(facts.collectionSlug, 80),
        community_slug: slug,
        ...collectionAnnouncementFields(message.action, facts),
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

// ── Member announcements: extra collection facts ─────────────────────────────

/** The change names an organiser may announce. Mirrors the allow-list in app.announce_collection_update. */
export const ANNOUNCEABLE_CHANGES = ["name", "description", "deadline", "start_date", "story", "other"] as const;

/**
 * Read the changed-field names from a collection.announce_update after_state.
 * Only allow-listed names survive; anything else (free text, an address, a
 * nested object) is dropped. Deduplicated and in allow-list order.
 */
export function parseChangedFields(afterState: Record<string, unknown> | null): string[] {
  const raw = afterState?.["changed_fields"];
  if (!Array.isArray(raw)) return [];
  const given = new Set(raw.filter((v): v is string => typeof v === "string"));
  return ANNOUNCEABLE_CHANGES.filter((c) => given.has(c));
}

/**
 * Member announcements v2: read the optional target the organiser chose. The
 * DB has already validated it; this is a defensive read on the worker side so
 * an older or malformed payload falls back to the collection's own audience.
 */
export const ANNOUNCE_TARGETS = ["all_members", "groups", "selected_members"] as const;
export type AnnounceTarget = (typeof ANNOUNCE_TARGETS)[number];

export function parseAnnounceTarget(afterState: Record<string, unknown> | null): AnnounceTarget | null {
  const raw = afterState?.["target_audience"];
  if (typeof raw !== "string") return null;
  return (ANNOUNCE_TARGETS as readonly string[]).includes(raw) ? (raw as AnnounceTarget) : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseAnnounceGroupIds(afterState: Record<string, unknown> | null): string[] {
  const raw = afterState?.["target_group_ids"];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v === "string" && UUID_RE.test(v)) seen.add(v.toLowerCase());
  }
  // Bounded: the audience picker caps at 100, and so does the DB.
  return [...seen].slice(0, 100);
}

/**
 * Member announcements v2: read the optional organiser message. Clamp length
 * and run one more email-redaction pass; the DB already did one, this is
 * defence in depth for a payload coming off the queue.
 */
export function parseAnnouncementBody(afterState: Record<string, unknown> | null): string | null {
  const raw = afterState?.["announcement_body"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const stripped = trimmed.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[address removed]",
  );
  return stripped.length > 1000 ? stripped.slice(0, 1000) : stripped;
}

const SAFE_ISO = /^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Payload keys added to collection events when the announcement context was
 * read. Absent facts add no key, so an event processed without the context
 * function has exactly the pre-existing payload. No key here is on the
 * database's banned list (message, reason, note, email, ...); descriptions are
 * email-redacted and clamped like every other text value.
 */
function collectionAnnouncementFields(action: string, facts: PayloadFacts): Payload {
  const out: Payload = {};
  if (facts.announcementContext !== true) return out;
  if (facts.communityName !== undefined) out["community_name"] = text(facts.communityName, 120);
  if (facts.collectionDescription !== undefined) out["collection_description"] = text(facts.collectionDescription, 500);
  if (facts.amountModel !== undefined) out["amount_model"] = text(facts.amountModel, 20);
  if (facts.fixedAmountKobo !== undefined) {
    const k = facts.fixedAmountKobo;
    out["fixed_amount_kobo"] = typeof k === "string" && /^[1-9][0-9]{0,14}$/.test(k) ? k : null;
  }
  if (facts.deadlineAt !== undefined) {
    const d = facts.deadlineAt;
    out["deadline_at"] = typeof d === "string" && SAFE_ISO.test(d) ? d : null;
  }
  if (action === "collection.announce_update" && facts.changedFields) {
    const changed = facts.changedFields;
    out["changed_fields"] = ANNOUNCEABLE_CHANGES.filter((c) => changed.includes(c)).join(",");
  }
  // Member announcements v2: organiser message + target. Keys carry
  // `announcement_body`, `target_audience`, `target_group_ids` — none on the
  // notification-event payload sanitiser's banned list. The message was
  // already address-stripped by app.strip_email_addresses in the DB; the
  // sanitiser redacts a second time if something leaks through.
  if (action === "collection.announce_update") {
    if (facts.announcementBody) out["announcement_body"] = text(facts.announcementBody, 1000);
    if (facts.targetAudience) out["target_audience"] = text(facts.targetAudience, 40);
    if (facts.targetGroupIds && facts.targetGroupIds.length > 0) {
      // Comma-joined so the payload stays scalar JSON; worker parses back when needed (none today — the server is authoritative).
      out["target_group_ids"] = facts.targetGroupIds.filter((g) => typeof g === "string").slice(0, 100).join(",");
    }
  }
  return out;
}
