/**
 * notification-processor.ts — event → recipient resolution → in-app delivery creation.
 *
 * Each pgmq message carries an audit-log row's fields (see the trigger in
 * 20261009110000). This module:
 *   1. Validates the message and decides whether it is processed at all
 *      (notification-rules.ts: shape, watched action, person actor, age).
 *   2. Creates a notification_event row (idempotent via event_key).
 *   3. Resolves the in-app recipients and creates notification_delivery rows.
 *
 * M13.2 P3 handles seven audit actions: collection.publish, member.create,
 * member.approve_join, member.reject_join, member.join_via_invite,
 * officer_invitation.accept and officer_term.end.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 * It contacts no provider and sends nothing. Email rows are created as
 * `pending` (eligible) or `skipped` (stable reason, no address) from the
 * centralized eligibility decision (P4); dispatch, leases, retries and rate
 * limits are the later sender milestone (P5). Nothing here reads, stores or
 * forwards a contact address except through the eligibility function, and the
 * event payload carries a name, a code and a slug, never an address.
 *
 * Crash safety (QA BUG-4, unchanged): the whole unit runs in one transaction and is
 * resumable. On a redelivered message the event already exists, so we read its id
 * rather than returning early, and re-insert deliveries idempotently — deliveries a
 * previous partial run missed are completed, none are duplicated.
 *
 * A message that cannot or should not be processed is SKIPPED (acknowledged, reported
 * through the return value), never thrown: a thrown error leaves the message in the
 * queue to reappear every 30 seconds. The event loop (index.ts) archives messages
 * past a read_ct threshold so a poison message is not retried forever (P6).
 */

import type postgres from "postgres";

import {
  COLLECTION_EMAIL_SEND_CLASS,
  collectionEmailCategory,
  collectionMemberDecision,
  emailDedupeKey,
  isEmailEvaluationEvent,
  type CollectionEmailCategory,
  type EligibilitySkipReason,
  type EmailOutcome,
} from "./notification-eligibility.ts";
import { eventPolicy, type CommunicationCategory } from "./communication-policy.ts";
import {
  admission,
  buildPayload,
  eventKey,
  isImportedMember,
  isUnavailableMember,
  narrowRequester,
  parseAnnouncementBody,
  parseAnnounceGroupIds,
  parseAnnounceTarget,
  parseAuditMessage,
  parseChangedFields,
  recipientPlan,
  type AnnounceTarget,
  type AuditMessage,
  type PayloadFacts,
  type SkipReason,
} from "./notification-rules.ts";

// Helpers run both on the base connection and inside a transaction, so accept either.
// (TransactionSql is not assignable to Sql in postgres.js's types.)
type Db = postgres.Sql<Record<string, never>> | postgres.TransactionSql<Record<string, never>>;

export type ProcessOutcome =
  | { readonly outcome: "processed"; readonly deliveries: number; readonly email: EmailOutcome }
  | { readonly outcome: "skipped"; readonly reason: SkipReason };

const SKIPPED = (reason: SkipReason): ProcessOutcome => ({ outcome: "skipped", reason });

/**
 * Run `fn` atomically. On the base connection that is a transaction; inside an
 * existing transaction (the integration test wraps the whole run in one so it can
 * roll back) it is a savepoint.
 */
function atomically<T>(sql: postgres.Sql | postgres.TransactionSql, fn: (tx: Db) => Promise<T>): Promise<T> {
  const s = sql as unknown as {
    begin?: (f: (tx: Db) => Promise<T>) => Promise<T>;
    savepoint?: (f: (tx: Db) => Promise<T>) => Promise<T>;
  };
  if (typeof s.begin === "function") return s.begin(fn);
  if (typeof s.savepoint === "function") return s.savepoint(fn);
  throw new Error("processNotificationMessage needs a postgres.js connection or transaction");
}

export async function processNotificationMessage(
  sql: postgres.Sql | postgres.TransactionSql,
  raw: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<ProcessOutcome> {
  const parsed = parseAuditMessage(raw);
  if (!parsed.ok) return SKIPPED(parsed.reason);
  const msg = parsed.message;

  const admitted = admission(msg, nowMs);
  if (!admitted.process) return SKIPPED(admitted.reason);

  return atomically(sql, async (tx): Promise<ProcessOutcome> => {
    const facts = await readFacts(tx, msg);
    if (facts === "member_unavailable") return SKIPPED("member_unavailable");
    if (facts === "imported_member") return SKIPPED("imported_member");

    const payload = buildPayload(msg, facts.payload);
    const key = eventKey(msg.action, msg.object_id, msg.audit_log_id);

    // Idempotent event create. ON CONFLICT so a replayed message does not error.
    await tx`
      insert into public.notification_events (
        community_id, event_type, event_key,
        actor_type, actor_user_id, object_type, object_id,
        payload
      ) values (
        ${msg.community_id}::uuid,
        ${msg.action},
        ${key},
        ${msg.actor_type}::public.audit_actor_type,
        ${msg.actor_user_id}::uuid,
        ${msg.object_type},
        ${msg.object_id}::uuid,
        ${tx.json(payload)}
      )
      on conflict (event_key) do nothing
    `;

    // Read the event id whether we just inserted it or a previous (possibly partial)
    // run did. This is what makes redelivery resumable.
    const [event] = await tx<{ id: string }[]>`
      select id from public.notification_events where event_key = ${key}
    `;
    if (!event) return { outcome: "processed", deliveries: 0, email: { kind: "no_row" } };

    const recipients = await resolveRecipients(tx, msg, facts.recipientHints);

    for (const r of recipients) {
      await tx`
        insert into public.notification_deliveries (
          notification_event_id, community_id,
          recipient_member_id, recipient_user_id,
          channel, status
        ) values (
          ${event.id}::uuid,
          ${msg.community_id}::uuid,
          ${r.member_id}::uuid,
          ${r.user_id}::uuid,
          'in_app',
          'sent'
        )
        on conflict (
          notification_event_id,
          coalesce(
            recipient_member_id,
            recipient_user_id,
            '00000000-0000-0000-0000-000000000000'::uuid
          ),
          channel
        ) do nothing
      `;
    }

    // ── P4 email evaluation ────────────────────────────────────────────────
    // Email-evaluation events always produce an email delivery row (pending or
    // skipped); every other event produces no email row. The in-app rows above
    // are untouched by whatever happens here: an email skip never deletes or
    // prevents a valid in-app delivery. No provider is contacted — dispatch,
    // leases, retries and rate limits belong to the later sender milestone.
    //
    // Member announcements: collection events evaluate email per audience
    // MEMBER from the member record (no account needed). Only one of the two
    // evaluations can apply to any action.
    const category = collectionEmailCategory(msg.action);
    const email = category
      ? await evaluateCollectionEmail(tx, msg, event.id, category)
      : await evaluateEmail(tx, msg, facts.recipientHints, event.id);

    // Publisher notice: when a collection is PUBLISHED, email the officer who
    // published it (the actor) at their confirmed account email, as an
    // essential confirmation. Publish only — not reminders or change
    // announcements. Skipped silently when the actor-email function is not
    // installed, when there is no officer actor, or when the same address is
    // already queued as an audience member (no duplicate to one inbox).
    if (msg.action === "collection.publish") {
      await notifyPublisher(tx, msg, event.id);
    }

    return { outcome: "processed", deliveries: recipients.length, email };
  });
}

// ── Publisher notice (collection.publish) ────────────────────────────────────

/**
 * Create one email delivery to the officer who published the collection, at
 * their confirmed account email. Essential (transactional): it carries no
 * communication_category, so the send-time recheck treats it as an
 * account-addressed essential notice rather than member communication. Never
 * creates a second delivery for an address already queued for this event, and
 * never throws — a publisher-notice failure must not fail the whole message.
 */
async function notifyPublisher(sql: Db, msg: AuditMessage, eventId: string): Promise<void> {
  if (msg.actor_type !== "officer" || !msg.actor_user_id) return;

  // Feature-detect the helper so a worker on an older database (or without the
  // grant) keeps processing the rest of the message.
  const [probe] = await sql<{ available: boolean }[]>`
    select coalesce(has_function_privilege(
      to_regprocedure('app.evaluate_actor_email(uuid)'), 'execute'), false) as available
  `;
  if (probe?.available !== true) return;

  const [actor] = await sql<{ address: string | null; assurance: string | null; skip_reason: string | null }[]>`
    select address, assurance, skip_reason from app.evaluate_actor_email(${msg.actor_user_id}::uuid)
  `;
  if (!actor || actor.address === null || actor.assurance === null) return;

  // Do not email the same address twice for one event (the publisher may also
  // be an audience member). Compared case-insensitively, against rows already
  // written in this transaction.
  const [dup] = await sql<{ exists: boolean }[]>`
    select exists (
      select 1 from public.notification_deliveries
      where notification_event_id = ${eventId}::uuid
        and channel = 'email'
        and recipient_address is not null
        and lower(recipient_address) = lower(${actor.address})
    ) as exists
  `;
  if (dup?.exists === true) return;

  await sql`
    insert into public.notification_deliveries (
      notification_event_id, community_id,
      recipient_member_id, recipient_user_id,
      recipient_address, recipient_address_assurance,
      channel, status, send_class
    ) values (
      ${eventId}::uuid,
      ${msg.community_id}::uuid,
      null,
      ${msg.actor_user_id}::uuid,
      ${actor.address},
      ${actor.assurance},
      'email',
      'pending',
      'transactional'
    )
    on conflict do nothing
  `;
}

// ── Email evaluation (P4) ────────────────────────────────────────────────────

/**
 * M13.3 R3: the communication category to store on new email deliveries, or
 * null when the database has no `notification_deliveries.communication_category`
 * column yet (the M13.3 policy migration is not applied). Existence is read
 * from the catalogue, which every role may read; the worker role's table-level
 * INSERT covers the new column, so no new grant is needed.
 */
async function deliveryCategoryFor(sql: Db, action: string): Promise<CommunicationCategory | null> {
  const category = eventPolicy(action)?.category ?? null;
  if (category === null) return null;
  const [row] = await sql<{ supported: boolean }[]>`
    select exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'public.notification_deliveries'::regclass
        and attname = 'communication_category'
        and not attisdropped
    ) as supported
  `;
  return row?.supported === true ? category : null;
}

interface EligibilityRow {
  eligible: boolean;
  address: string | null;
  assurance: string | null;
  skip_reason: string | null;
}

/**
 * Evaluate email eligibility for one processed event and record the outcome.
 * The database function is the authority: it derives the recipient from the
 * member or officer_term record, checks any asserted user id against it, and
 * returns either an address with its assurance or a stable skip reason.
 * This function only files the answer under the existing delivery constraints:
 * eligible rows carry address + assurance + dedupe key, skipped rows carry a
 * stable error_code and no address, and non-evaluation events yield no row.
 */
async function evaluateEmail(
  sql: Db,
  msg: AuditMessage,
  hints: Facts["recipientHints"],
  eventId: string,
): Promise<EmailOutcome> {
  if (!isEmailEvaluationEvent(msg.action)) return { kind: "no_row" };

  const isMembership = msg.action === "member.create" || msg.action === "member.approve_join";
  const objectId = isMembership ? (hints.memberId ?? msg.object_id) : msg.object_id;
  const assertedUserId = isMembership ? (hints.memberUserId ?? null) : (hints.termUserId ?? null);

  const [found] = await sql<EligibilityRow[]>`
    select eligible, address, assurance, skip_reason
    from app.evaluate_email_eligibility(${msg.action}, ${objectId}::uuid, ${assertedUserId}::uuid)
  `;
  const reason = (found?.skip_reason ?? "unsupported_event") as EligibilitySkipReason;

  // Only ids verified to exist are stored: the member was read above (readFacts
  // found it, otherwise processing stopped earlier) and the asserted user id
  // comes from a members.user_id / officer_terms.user_id foreign key.
  const memberId = isMembership ? (hints.memberId ?? null) : null;
  const userId = assertedUserId;

  const category = await deliveryCategoryFor(sql, msg.action);

  if (found?.eligible === true && found.address !== null && found.assurance !== null) {
    // The dedupe key is set on eligible rows only: a skipped evaluation must
    // never block a later eligible one for the same member.
    const dedupe = emailDedupeKey(msg.action, hints.memberId ?? msg.object_id);
    if (category !== null) {
      await sql`
        insert into public.notification_deliveries (
          notification_event_id, community_id,
          recipient_member_id, recipient_user_id,
          recipient_address, recipient_address_assurance,
          channel, status, dedupe_key, send_class, communication_category
        ) values (
          ${eventId}::uuid,
          ${msg.community_id}::uuid,
          ${memberId}::uuid,
          ${userId}::uuid,
          ${found.address},
          ${found.assurance},
          'email',
          'pending',
          ${dedupe},
          'transactional',
          ${category}
        )
        on conflict do nothing
      `;
      return { kind: "pending" };
    }
    await sql`
      insert into public.notification_deliveries (
        notification_event_id, community_id,
        recipient_member_id, recipient_user_id,
        recipient_address, recipient_address_assurance,
        channel, status, dedupe_key, send_class
      ) values (
        ${eventId}::uuid,
        ${msg.community_id}::uuid,
        ${memberId}::uuid,
        ${userId}::uuid,
        ${found.address},
        ${found.assurance},
        'email',
        'pending',
        ${dedupe},
        'transactional'
      )
      -- Bare DO NOTHING covers both uniqueness boundaries: the per-event
      -- recipient index (replay of this message) and the dedupe-key index
      -- (creation and approval collapsing to one confirmation). Any conflict
      -- means an equivalent delivery already exists.
      on conflict do nothing
    `;
    return { kind: "pending" };
  }

  if (category !== null) {
    await sql`
      insert into public.notification_deliveries (
        notification_event_id, community_id,
        recipient_member_id, recipient_user_id,
        channel, status, error_code, send_class, communication_category
      ) values (
        ${eventId}::uuid,
        ${msg.community_id}::uuid,
        ${memberId}::uuid,
        ${userId}::uuid,
        'email',
        'skipped',
        ${reason},
        'transactional',
        ${category}
      )
      on conflict do nothing
    `;
    return { kind: "skipped", reason };
  }
  await sql`
    insert into public.notification_deliveries (
      notification_event_id, community_id,
      recipient_member_id, recipient_user_id,
      channel, status, error_code, send_class
    ) values (
      ${eventId}::uuid,
      ${msg.community_id}::uuid,
      ${memberId}::uuid,
      ${userId}::uuid,
      'email',
      'skipped',
      ${reason},
      'transactional'
    )
    on conflict do nothing
  `;
  return { kind: "skipped", reason };
}

// ── Collection email to members (member announcements) ───────────────────────

interface CollectionRecipientRow {
  member_id: string;
  user_id: string | null;
  eligible: boolean;
  address: string | null;
  assurance: string | null;
  skip_reason: string | null;
}

/**
 * Whether the member-announcement functions are installed AND executable by
 * this connection. Checked rather than assumed so a worker deployed before
 * the proposal is applied (or before the worker role is granted EXECUTE)
 * keeps processing in-app deliveries instead of failing the transaction.
 */
async function announcementSupport(
  sql: Db,
): Promise<{ context: boolean; eligibility: boolean; notice: boolean; targeted: boolean }> {
  const [row] = await sql<{ context: boolean; eligibility: boolean; notice: boolean; targeted: boolean }[]>`
    select
      coalesce(has_function_privilege(
        to_regprocedure('app.collection_announcement_context(uuid)'), 'execute'), false) as context,
      coalesce(has_function_privilege(
        to_regprocedure('app.evaluate_collection_email_recipients(uuid, text)'), 'execute'), false) as eligibility,
      coalesce(has_function_privilege(
        to_regprocedure('app.community_communication_notice_attested(uuid)'), 'execute'), false) as notice,
      coalesce(has_function_privilege(
        to_regprocedure('app.evaluate_collection_email_recipients_targeted(uuid, text, text, uuid[])'), 'execute'), false) as targeted
  `;
  return {
    context: row?.context === true,
    eligibility: row?.eligibility === true,
    notice: row?.notice === true,
    targeted: row?.targeted === true,
  };
}

/**
 * Whether an authorised organiser has completed the community communication
 * notice attestation (R0 decision 3). The attestation store is R2: until
 * app.community_communication_notice_attested(uuid) exists and is executable,
 * the answer is the restrictive one (false), so no community operational email
 * becomes pending.
 */
async function communityNoticeAttested(sql: Db, communityId: string, available: boolean): Promise<boolean> {
  if (!available) return false;
  const [row] = await sql<{ attested: boolean | null }[]>`
    select app.community_communication_notice_attested(${communityId}::uuid) as attested
  `;
  return row?.attested === true;
}

/**
 * Write one email delivery per audience member: `pending` with the address
 * the database chose, or `skipped` with a stable reason and no address.
 * The database function supplies the facts (reachability, availability,
 * stored opt-out, address); the central communication policy decides what
 * they require (collectionMemberDecision). Replays are idempotent on the
 * per-event recipient index (one row per event × member × channel), so a
 * retried message never creates a second delivery for the same member.
 */
async function evaluateCollectionEmail(
  sql: Db,
  msg: AuditMessage,
  eventId: string,
  category: CollectionEmailCategory,
): Promise<EmailOutcome> {
  const support = await announcementSupport(sql);
  if (!support.eligibility) return { kind: "collection_unavailable" };

  // Member announcements v2: when the audit payload carries a per-send target,
  // use the targeted evaluator (same decision logic, members filtered first).
  // The targeted function is feature-detected (support.targeted) BEFORE it is
  // called: a failed query would abort this whole transaction, so there is no
  // in-transaction fallback. A worker on a database without the v2 migration
  // falls back here to the untargeted evaluator and emails the collection's own
  // audience — the audit row's target is simply not honoured until the migration
  // is applied.
  const target: AnnounceTarget | null =
    msg.action === "collection.announce_update" && support.targeted ? parseAnnounceTarget(msg.after_state) : null;
  const groupIds: string[] =
    target === "groups" ? parseAnnounceGroupIds(msg.after_state) : [];

  const rows = target
    ? await sql<CollectionRecipientRow[]>`
        select member_id, user_id, eligible, address, assurance, skip_reason
        from app.evaluate_collection_email_recipients_targeted(
          ${msg.object_id}::uuid, ${category}, ${target}, ${groupIds}::uuid[]
        )
      `
    : await sql<CollectionRecipientRow[]>`
        select member_id, user_id, eligible, address, assurance, skip_reason
        from app.evaluate_collection_email_recipients(${msg.object_id}::uuid, ${category})
      `;
  const attested = await communityNoticeAttested(sql, msg.community_id, support.notice);
  const deliveryCategory = await deliveryCategoryFor(sql, msg.action);

  let pending = 0;
  let skipped = 0;
  for (const r of rows) {
    const decision = collectionMemberDecision(msg.action, r, { communityNoticeAttested: attested });
    if (deliveryCategory !== null) {
      // M13.3 R3: same rows, with the category the decision was made under.
      if (decision.send && r.address !== null && r.assurance !== null) {
        await sql`
          insert into public.notification_deliveries (
            notification_event_id, community_id,
            recipient_member_id, recipient_user_id,
            recipient_address, recipient_address_assurance,
            channel, status, send_class, communication_category
          ) values (
            ${eventId}::uuid,
            ${msg.community_id}::uuid,
            ${r.member_id}::uuid,
            ${r.user_id}::uuid,
            ${r.address},
            ${r.assurance},
            'email',
            'pending',
            ${COLLECTION_EMAIL_SEND_CLASS},
            ${deliveryCategory}
          )
          on conflict do nothing
        `;
        pending += 1;
      } else {
        await sql`
          insert into public.notification_deliveries (
            notification_event_id, community_id,
            recipient_member_id, recipient_user_id,
            channel, status, error_code, send_class, communication_category
          ) values (
            ${eventId}::uuid,
            ${msg.community_id}::uuid,
            ${r.member_id}::uuid,
            ${r.user_id}::uuid,
            'email',
            'skipped',
            ${decision.send ? "no_recipient" : decision.reason},
            ${COLLECTION_EMAIL_SEND_CLASS},
            ${deliveryCategory}
          )
          on conflict do nothing
        `;
        skipped += 1;
      }
      continue;
    }
    if (decision.send && r.address !== null && r.assurance !== null) {
      await sql`
        insert into public.notification_deliveries (
          notification_event_id, community_id,
          recipient_member_id, recipient_user_id,
          recipient_address, recipient_address_assurance,
          channel, status, send_class
        ) values (
          ${eventId}::uuid,
          ${msg.community_id}::uuid,
          ${r.member_id}::uuid,
          ${r.user_id}::uuid,
          ${r.address},
          ${r.assurance},
          'email',
          'pending',
          ${COLLECTION_EMAIL_SEND_CLASS}
        )
        on conflict do nothing
      `;
      pending += 1;
    } else {
      await sql`
        insert into public.notification_deliveries (
          notification_event_id, community_id,
          recipient_member_id, recipient_user_id,
          channel, status, error_code, send_class
        ) values (
          ${eventId}::uuid,
          ${msg.community_id}::uuid,
          ${r.member_id}::uuid,
          ${r.user_id}::uuid,
          'email',
          'skipped',
          ${decision.send ? "no_recipient" : decision.reason},
          ${COLLECTION_EMAIL_SEND_CLASS}
        )
        on conflict do nothing
      `;
      skipped += 1;
    }
  }
  return { kind: "collection", pending, skipped };
}

interface AnnouncementContextRow {
  community_name: string | null;
  description_excerpt: string | null;
  amount_model: string | null;
  fixed_amount_kobo: string | number | null;
  deadline_at: Date | string | null;
}

/** Collection facts for the announcement payload, or null when the context function is unavailable. */
async function readAnnouncementContext(sql: Db, collectionId: string): Promise<AnnouncementContextRow | null> {
  const support = await announcementSupport(sql);
  if (!support.context) return null;
  const [row] = await sql<AnnouncementContextRow[]>`
    select community_name, description_excerpt, amount_model, fixed_amount_kobo, deadline_at
    from app.collection_announcement_context(${collectionId}::uuid)
  `;
  return row ?? null;
}

/** Kobo crosses a JSON boundary as a digit string, never a JSON number (packages/domain toJSON). */
function koboToString(value: string | number | bigint | null): string | null {
  if (value === null) return null;
  const s = String(value);
  return /^[0-9]{1,15}$/.test(s) ? s : null;
}

// ── Reading facts ────────────────────────────────────────────────────────────

interface Recipient {
  member_id: string | null;
  user_id: string;
}

interface Facts {
  payload: PayloadFacts;
  /** Ids read while gathering facts, so recipient resolution does not re-query them. */
  recipientHints: { memberUserId?: string | null; memberId?: string | null; termUserId?: string | null };
}

async function readFacts(
  sql: Db,
  msg: AuditMessage,
): Promise<Facts | "member_unavailable" | "imported_member"> {
  switch (msg.action) {
    case "collection.publish":
    case "collection.publish_remind_unpaid":
    case "collection.remind":
    case "collection.remind_unpaid":
    case "collection.announce_update": {
      const [col] = await sql<{ name: string; slug: string; community_slug: string }[]>`
        select c.name, c.slug, cm.slug as community_slug
        from public.collections c
        join public.communities cm on cm.id = c.community_id
        where c.id = ${msg.object_id}::uuid
      `;
      if (!col) return { payload: {}, recipientHints: {} };
      const base = { collectionName: col.name, collectionSlug: col.slug, communitySlug: col.community_slug };
      // Member announcements: richer facts for the email, only when the
      // context function exists. Without it the payload is exactly as before.
      const ctx = collectionEmailCategory(msg.action) ? await readAnnouncementContext(sql, msg.object_id) : null;
      if (!ctx) return { payload: base, recipientHints: {} };
      const deadline = ctx.deadline_at instanceof Date ? ctx.deadline_at.toISOString() : ctx.deadline_at;
      return {
        payload: {
          ...base,
          announcementContext: true,
          communityName: ctx.community_name,
          collectionDescription: ctx.description_excerpt,
          amountModel: ctx.amount_model,
          fixedAmountKobo: koboToString(ctx.fixed_amount_kobo),
          deadlineAt: deadline,
          changedFields: msg.action === "collection.announce_update" ? parseChangedFields(msg.after_state) : null,
          announcementBody: msg.action === "collection.announce_update" ? parseAnnouncementBody(msg.after_state) : null,
          targetAudience: msg.action === "collection.announce_update" ? parseAnnounceTarget(msg.after_state) : null,
          targetGroupIds: msg.action === "collection.announce_update" ? parseAnnounceGroupIds(msg.after_state) : null,
        },
        recipientHints: {},
      };
    }

    case "member.create":
    case "member.approve_join":
    case "member.join_via_invite": {
      const [mem] = await sql<
        {
          id: string;
          full_name: string;
          member_code: string | null;
          user_id: string | null;
          is_imported: boolean | null;
          joined_via: string | null;
          status: string | null;
          archived_at: string | null;
          merged_into_id: string | null;
          community_slug: string;
          community_name: string;
        }[]
      >`
        select m.id, m.full_name, m.member_code, m.user_id, m.is_imported, m.joined_via,
               m.status, m.archived_at, m.merged_into_id,
               cm.slug as community_slug, cm.name as community_name
        from public.members m
        join public.communities cm on cm.id = m.community_id
        where m.id = ${msg.object_id}::uuid
      `;
      // Rejected, deleted, archived, merged or never existed before we got to it: nothing to tell anyone.
      if (!mem || isUnavailableMember(mem)) return "member_unavailable";
      if (isImportedMember(mem)) return "imported_member";
      return {
        payload: {
          memberName: mem.full_name,
          memberCode: mem.member_code,
          communitySlug: mem.community_slug,
          communityName: mem.community_name,
        },
        recipientHints: { memberUserId: mem.user_id, memberId: mem.id },
      };
    }

    case "member.reject_join": {
      // The member row is deleted by the rejection. The requester's name comes from the
      // narrow before_state the trigger forwarded; nothing else of theirs is used.
      const requester = narrowRequester(msg.before_state);
      const [cm] = await sql<{ slug: string; name: string }[]>`
        select slug, name from public.communities where id = ${msg.community_id}::uuid
      `;
      return {
        payload: {
          memberName: requester.full_name,
          communitySlug: cm?.slug ?? null,
          communityName: cm?.name ?? null,
        },
        recipientHints: {},
      };
    }

    case "officer_invitation.accept":
    case "officer_term.end": {
      const [term] = await sql<
        { user_id: string; role: string; end_reason: string | null; community_slug: string; community_name: string }[]
      >`
        select ot.user_id, ot.role, ot.end_reason, cm.slug as community_slug, cm.name as community_name
        from public.officer_terms ot
        join public.communities cm on cm.id = ot.community_id
        where ot.id = ${msg.object_id}::uuid
      `;
      return {
        payload: term
          ? {
              officerRole: term.role,
              endReason: term.end_reason,
              communitySlug: term.community_slug,
              communityName: term.community_name,
            }
          : {},
        recipientHints: { termUserId: term?.user_id ?? null },
      };
    }

    default:
      return { payload: {}, recipientHints: {} };
  }
}

// ── Who is told, in-app ──────────────────────────────────────────────────────

async function resolveRecipients(sql: Db, msg: AuditMessage, hints: Facts["recipientHints"]): Promise<Recipient[]> {
  const plan = recipientPlan(msg.action);
  switch (plan.kind) {
    case "collection_audience":
      return sql<Recipient[]>`
        select a.member_id, m.user_id
        from app.resolve_collection_audience(${msg.object_id}::uuid) a
        join public.members m on m.id = a.member_id
        where m.user_id is not null
      `;

    case "payment_status_unavailable":
      // Disabled on purpose. obligations.status is 'unpaid' by default and no
      // code path ever sets 'paid' or 'in_installments' (there is no
      // contributions record, and cash/transfer payments cannot be entered),
      // so "unpaid" would include members who have already paid. Telling
      // them they still owe is worse than telling no one. The event row is
      // kept for the audit trail; no delivery is created.
      return [];

    case "member_self":
      // Only a member who has an account can be told in-app. None do yet (D-LINK).
      return hints.memberUserId && hints.memberId ? [{ member_id: hints.memberId, user_id: hints.memberUserId }] : [];

    case "officers_with_permission":
      // "New member joined" goes to the officers who govern membership admission.
      // invite.approve is held by admin/owner/treasurer (QA BUG-5). The joiner is NOT told.
      return sql<Recipient[]>`
        select null as member_id, ot.user_id
        from public.officer_terms ot
        join public.role_permissions rp
          on rp.role = ot.role
         and rp.permission = ${plan.permission}
        where ot.community_id = ${msg.community_id}::uuid
          and ot.ended_at is null
          and ot.started_at <= now()
      `;

    case "officer_term_holder":
      return hints.termUserId ? [{ member_id: null, user_id: hints.termUserId }] : [];

    case "nobody":
      return [];
  }
}
