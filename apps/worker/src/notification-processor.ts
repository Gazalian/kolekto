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
 * queue to reappear every 30 seconds, and there is no retry cap until P6.
 */

import type postgres from "postgres";

import {
  emailDedupeKey,
  isEmailEvaluationEvent,
  type EligibilitySkipReason,
  type EmailOutcome,
} from "./notification-eligibility.ts";
import {
  admission,
  buildPayload,
  eventKey,
  isImportedMember,
  isUnavailableMember,
  narrowRequester,
  parseAuditMessage,
  recipientPlan,
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
    const key = eventKey(msg.action, msg.object_id);

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
    const email = await evaluateEmail(tx, msg, facts.recipientHints, event.id);

    return { outcome: "processed", deliveries: recipients.length, email };
  });
}

// ── Email evaluation (P4) ────────────────────────────────────────────────────

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

  if (found?.eligible === true && found.address !== null && found.assurance !== null) {
    // The dedupe key is set on eligible rows only: a skipped evaluation must
    // never block a later eligible one for the same member.
    const dedupe = emailDedupeKey(msg.action, hints.memberId ?? msg.object_id);
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
    case "collection.publish": {
      const [col] = await sql<{ name: string; slug: string; community_slug: string }[]>`
        select c.name, c.slug, cm.slug as community_slug
        from public.collections c
        join public.communities cm on cm.id = c.community_id
        where c.id = ${msg.object_id}::uuid
      `;
      return {
        payload: col
          ? { collectionName: col.name, collectionSlug: col.slug, communitySlug: col.community_slug }
          : {},
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
