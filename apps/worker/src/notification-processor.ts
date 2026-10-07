/**
 * notification-processor.ts — event → recipient resolution → delivery creation.
 *
 * Each pgmq message carries the audit log row's fields. This module:
 *   1. Creates a notification_event row (idempotent via event_key).
 *   2. Resolves recipients based on the event type.
 *   3. Creates notification_delivery rows (one per recipient, in_app channel).
 *
 * M13.1 handles the three audit actions the domain actually writes:
 *   collection.publish, member.approve_join, member.join_via_invite.
 * M13.2+ adds email/whatsapp/sms channels.
 *
 * Crash safety (QA BUG-4): the whole unit runs in one transaction and is
 * resumable. On a redelivered message the event already exists, so we read its
 * id (rather than returning early) and re-insert deliveries idempotently — any
 * deliveries a previous partial run missed are completed, none are duplicated.
 */

import type postgres from "postgres";

// Helpers run both on the base connection and inside sql.begin(), so accept
// either. (TransactionSql is not assignable to Sql in postgres.js's types.)
type Db = postgres.Sql<Record<string, never>> | postgres.TransactionSql<Record<string, never>>;

interface AuditMessage {
  audit_log_id: string;
  community_id: string;
  action: string;
  actor_type: string;
  actor_user_id: string | null;
  actor_name: string;
  object_type: string;
  object_id: string;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

export async function processNotificationMessage(
  sql: postgres.Sql,
  raw: Record<string, unknown>,
): Promise<void> {
  const msg = raw as unknown as AuditMessage;
  const eventKey = `${msg.action}:${msg.object_id}`;

  await sql.begin(async (tx) => {
    const payload = await buildPayload(tx, msg);

    // Idempotent event create. ON CONFLICT so a replayed message does not error.
    await tx`
      insert into public.notification_events (
        community_id, event_type, event_key,
        actor_type, actor_user_id, object_type, object_id,
        payload
      ) values (
        ${msg.community_id}::uuid,
        ${msg.action},
        ${eventKey},
        ${msg.actor_type}::public.audit_actor_type,
        ${msg.actor_user_id}::uuid,
        ${msg.object_type},
        ${msg.object_id}::uuid,
        ${tx.json(payload as Record<string, string | number | boolean | null>)}
      )
      on conflict (event_key) do nothing
    `;

    // Read the event id whether we just inserted it or a previous (possibly
    // partial) run did. This is what makes redelivery resumable.
    const [event] = await tx<{ id: string }[]>`
      select id from public.notification_events where event_key = ${eventKey}
    `;
    if (!event) return;

    const recipients = await resolveRecipients(tx, msg);

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
  });
}

interface Recipient {
  member_id: string | null;
  user_id: string;
}

async function resolveRecipients(
  sql: Db,
  msg: AuditMessage,
): Promise<Recipient[]> {
  switch (msg.action) {
    case "collection.publish":
      return resolveCollectionAudience(sql, msg.object_id);
    case "member.approve_join":
      return resolveMemberSelf(sql, msg.object_id);
    case "member.join_via_invite":
      // "New member joined" goes to the officers who govern membership
      // admission. invite.approve is held by admin/owner/treasurer — the
      // membership gatekeepers — and is the closest existing permission
      // (QA BUG-5). No new permission is invented.
      return resolveOfficersWithPermission(sql, msg.community_id, "invite.approve");
    default:
      return [];
  }
}

async function resolveCollectionAudience(
  sql: Db,
  collectionId: string,
): Promise<Recipient[]> {
  return sql<Recipient[]>`
    select a.member_id, m.user_id
    from app.resolve_collection_audience(${collectionId}::uuid) a
    join public.members m on m.id = a.member_id
    where m.user_id is not null
  `;
}

async function resolveMemberSelf(
  sql: Db,
  memberId: string,
): Promise<Recipient[]> {
  return sql<Recipient[]>`
    select m.id as member_id, m.user_id
    from public.members m
    where m.id = ${memberId}::uuid
      and m.user_id is not null
  `;
}

async function resolveOfficersWithPermission(
  sql: Db,
  communityId: string,
  permission: string,
): Promise<Recipient[]> {
  return sql<Recipient[]>`
    select null as member_id, ot.user_id
    from public.officer_terms ot
    join public.role_permissions rp
      on rp.role = ot.role
     and rp.permission = ${permission}
    where ot.community_id = ${communityId}::uuid
      and ot.ended_at is null
      and ot.started_at <= now()
  `;
}

async function buildPayload(
  sql: Db,
  msg: AuditMessage,
): Promise<Record<string, unknown>> {
  const base = {
    actor_name: msg.actor_name,
    community_id: msg.community_id,
  };

  switch (msg.action) {
    case "collection.publish": {
      const [col] = await sql<{ name: string; slug: string; community_slug: string }[]>`
        select c.name, c.slug, cm.slug as community_slug
        from public.collections c
        join public.communities cm on cm.id = c.community_id
        where c.id = ${msg.object_id}::uuid
      `;
      if (!col) return base;
      return {
        ...base,
        collection_name: col.name,
        collection_slug: col.slug,
        community_slug: col.community_slug,
      };
    }
    case "member.approve_join": {
      const [mem] = await sql<{ full_name: string; member_code: string | null; community_slug: string }[]>`
        select m.full_name, m.member_code, cm.slug as community_slug
        from public.members m
        join public.communities cm on cm.id = m.community_id
        where m.id = ${msg.object_id}::uuid
      `;
      if (!mem) return base;
      return {
        ...base,
        member_name: mem.full_name,
        member_code: mem.member_code,
        community_slug: mem.community_slug,
      };
    }
    case "member.join_via_invite": {
      // object_id is the new member; the name lives on the member row, not in
      // after_state (which carries only member_code).
      const [mem] = await sql<{ full_name: string; community_slug: string; community_name: string }[]>`
        select m.full_name, cm.slug as community_slug, cm.name as community_name
        from public.members m
        join public.communities cm on cm.id = m.community_id
        where m.id = ${msg.object_id}::uuid
      `;
      if (!mem) return base;
      return {
        ...base,
        member_name: mem.full_name,
        community_name: mem.community_name,
        community_slug: mem.community_slug,
      };
    }
    default:
      return base;
  }
}
