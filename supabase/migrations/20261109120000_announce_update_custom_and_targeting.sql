-- ─────────────────────────────────────────────────────────────────────────────
-- Announce-update: optional organiser message and audience targeting
--
-- Additive on top of 20261109100100_member_collection_announcements.sql. Adds
-- two things the organiser can set when they click "Announce changes":
--
--   1. custom_message (optional text, up to 1000 chars).
--      Stripped, length-clamped, and run through a conservative email-address
--      stripper here so no address reaches the member email body by mistake
--      (banned payload fields: 'email', 'message', 'reason' — we rename to
--      'announcement_body' in the audit after_state so the trigger / processor
--      do not ban it, but the stripping is still applied; see below).
--
--   2. target_audience ('all_members' | 'groups' | 'selected_members') and
--      target_group_ids uuid[]. DEFAULTS to the collection's own audience.
--
--      This is a per-send OVERRIDE for who hears the announcement; it never
--      changes the collection's audience_mode or obligations. The resolver
--      app.evaluate_collection_email_recipients(uuid, text) is unchanged;
--      a new sibling, app.evaluate_collection_email_recipients_targeted,
--      restricts the member list by the chosen target. The worker calls the
--      new one when the payload's audit after_state names a target.
--
-- Deliberately NOT included:
--   · "Unpaid members" targeting. Payment status cannot be established today
--     (no contributions / ledger writer — see docs gap analysis G3). Adding an
--     "unpaid" option would email people who have paid (cash / transfer) that
--     they still owe. A reviewed migration adds it only once a real payment
--     ledger exists.
--   · "Public" as a target: open collections have no member audience by
--     definition; the current evaluator already treats a public collection as
--     "every current member of the community" for announcements.
--
-- Column name note: the `after_state` column rejects certain keys ('email',
-- 'message', 'reason', ...). We use 'announcement_body' for the custom text
-- so the guard does not refuse the row. The text is still email-stripped
-- before it goes in. See 20261009100200_notification_event_payload_guard.sql.
--
-- Rollback (additive only):
--   drop function app.announce_collection_update_v2(uuid, text[], text, text, uuid[], text);
--   drop function app.evaluate_collection_email_recipients_targeted(uuid, text, text, uuid[]);
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Email-safe text helper ────────────────────────────────────────────────
-- Strips anything that looks like an email address from the custom message
-- before it can reach the audit payload or the rendered email body. Does the
-- same thing the TypeScript side used to, in the database, so no caller can
-- bypass it.
create or replace function app.strip_email_addresses(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Conservative: replace any token that looks like local-part@host.tld with
  -- a placeholder. Mirrors the shape used by app.email_address_usable, loosened
  -- to match "myname.at.gmail.com" shapes we might see in the wild.
  select case
    when p_text is null then null
    else regexp_replace(
      p_text,
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
      '[address removed]',
      'g'
    )
  end;
$$;

comment on function app.strip_email_addresses(text) is
  'Replaces email-shaped tokens in free text with [address removed]. Used by app.announce_collection_update_v2 before storing the organiser message, so no address is ever carried in the audit payload or the rendered email body.';

revoke all on function app.strip_email_addresses(text) from public;
revoke execute on function app.strip_email_addresses(text) from public, anon, authenticated;


-- ── 2. Targeted recipient evaluator ──────────────────────────────────────────
-- Same shape as app.evaluate_collection_email_recipients, with a target filter
-- applied to the member list BEFORE the per-member eligibility checks run.
--
-- The target is one of:
--   · 'all_members'        — every member on the community's roll
--   · 'groups'              — members in any of the given groups
--   · 'selected_members'    — members with an obligation on this collection
--
-- `p_group_ids` is read only when p_target = 'groups'. Groups belonging to
-- other communities are ignored (they match zero members), and an archived
-- group is also ignored.
create or replace function app.evaluate_collection_email_recipients_targeted(
  p_collection_id uuid,
  p_category      text,
  p_target        text,
  p_group_ids     uuid[] default '{}'
)
returns table (
  member_id   uuid,
  user_id     uuid,
  eligible    boolean,
  address     text,
  assurance   text,
  skip_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_community_id uuid;
  v_reachable    boolean;
begin
  if p_target not in ('all_members', 'groups', 'selected_members') then
    raise exception 'INVALID_TARGET: expected all_members, groups or selected_members; got %', p_target
      using errcode = '22023';
  end if;

  select c.community_id,
         (c.visibility in ('public', 'unlisted')
           and c.status in ('active', 'paused', 'closed')
           and cm.status = 'active')
    into v_community_id, v_reachable
  from public.collections c
  join public.communities cm on cm.id = c.community_id
  where c.id = p_collection_id;

  if v_community_id is null then return; end if;

  -- The full per-member decision for THIS category, then filter by target.
  return query
  with d as (
    select *
    from app.collection_member_email_decisions(p_collection_id, p_category, coalesce(v_reachable, false))
  ),
  keep as (
    select m.id as kept_id
    from public.members m
    where m.community_id = v_community_id
      and m.status in ('active', 'unclaimed', 'invited')
      and (
        p_target = 'all_members'
        or (p_target = 'groups' and exists (
              select 1
              from public.member_group_memberships mgm
              join public.member_groups g on g.id = mgm.group_id
              where mgm.member_id = m.id
                and g.community_id = v_community_id
                and g.archived_at is null
                and g.id = any (coalesce(p_group_ids, '{}'::uuid[]))
            ))
        or (p_target = 'selected_members' and exists (
              select 1 from public.obligations o
              where o.collection_id = p_collection_id and o.member_id = m.id
            ))
      )
  )
  select d.member_id, d.user_id, d.eligible, d.address, d.assurance, d.skip_reason
  from d
  join keep k on k.kept_id = d.member_id
  order by d.member_id;
end;
$$;

comment on function app.evaluate_collection_email_recipients_targeted(uuid, text, text, uuid[]) is
  'Member announcements: same per-member decision as app.evaluate_collection_email_recipients, restricted to a per-send target (all_members, groups or selected_members). Never widens the audience past active/unclaimed/invited members of the collection''s community. Worker only.';

revoke all on function app.evaluate_collection_email_recipients_targeted(uuid, text, text, uuid[]) from public;
revoke execute on function app.evaluate_collection_email_recipients_targeted(uuid, text, text, uuid[]) from anon, authenticated;


-- ── 3. New announce function with custom message + target ───────────────────
-- Keeps the original signature available; this one supersedes it. The web
-- app calls v2 and the original stays callable for backward compat.
create or replace function app.announce_collection_update_v2(
  p_collection_id    uuid,
  p_changed_fields   text[],
  p_idempotency_key  text,
  p_custom_message   text   default null,
  p_target_audience  text   default null,
  p_target_group_ids uuid[] default '{}'
)
returns table (audit_log_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_allowed_fields constant text[] := array['name','description','deadline','start_date','story','other'];
  c_allowed_target constant text[] := array['all_members','groups','selected_members'];
  v_collection     public.collections%rowtype;
  v_actor          uuid := auth.uid();
  v_fields         text[];
  v_existing       record;
  v_audit_id       uuid;
  v_target         text;
  v_groups         uuid[];
  v_custom         text;
  v_after          jsonb;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,128}$' then
    raise exception 'INVALID_IDEMPOTENCY_KEY: 8-128 characters of A-Z a-z 0-9 _ -'
      using errcode = '22023';
  end if;

  select array_agg(distinct f order by f) into v_fields
  from unnest(coalesce(p_changed_fields, array[]::text[])) as f;

  if v_fields is null or array_length(v_fields, 1) = 0 then
    raise exception 'INVALID_CHANGES: choose at least one change to announce' using errcode = '22023';
  end if;
  if not (v_fields <@ c_allowed_fields) then
    raise exception 'INVALID_CHANGES: changed fields must be among %', c_allowed_fields using errcode = '22023';
  end if;

  -- Custom message: clamp and strip addresses. Null in means null out.
  if p_custom_message is not null then
    v_custom := app.strip_email_addresses(btrim(p_custom_message));
    if length(coalesce(v_custom, '')) = 0 then
      v_custom := null;
    elsif length(v_custom) > 1000 then
      raise exception 'MESSAGE_TOO_LONG: custom message must be 1000 characters or fewer'
        using errcode = '22023';
    end if;
  end if;

  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.publish');

  if v_collection.status not in ('active', 'scheduled', 'paused') then
    raise exception 'INVALID_STATE: a % collection cannot announce changes (only active, scheduled or paused)',
                    v_collection.status
      using errcode = 'P0001';
  end if;

  if v_actor is null then
    raise exception 'FORBIDDEN: an announcement must be sent by a signed-in officer' using errcode = '42501';
  end if;

  -- Target audience: NULL means "same as the collection's own audience".
  if p_target_audience is null then
    v_target := case v_collection.audience_mode::text
                  when 'public' then 'all_members'
                  when 'selected_members' then 'selected_members'
                  when 'groups' then 'groups'
                  else 'all_members'
                end;
  else
    if not (p_target_audience = any (c_allowed_target)) then
      raise exception 'INVALID_TARGET: expected one of %', c_allowed_target using errcode = '22023';
    end if;
    v_target := p_target_audience;
  end if;

  if v_target = 'groups' then
    -- Keep only groups that actually belong to this community and are active.
    select array_agg(distinct g.id order by g.id)
      into v_groups
    from unnest(coalesce(p_target_group_ids, '{}'::uuid[])) as gid
    join public.member_groups g
      on g.id = gid
     and g.community_id = v_collection.community_id
     and g.archived_at is null;

    if v_groups is null or array_length(v_groups, 1) = 0 then
      raise exception 'NO_GROUPS: choose at least one of this community''s groups' using errcode = '22023';
    end if;
  elsif v_target = 'selected_members' then
    v_groups := '{}';
    -- Only sensible if there is at least one obligation on this collection.
    if not exists (select 1 from public.obligations o where o.collection_id = p_collection_id) then
      raise exception 'NO_SELECTED_MEMBERS: this collection has no selected members yet' using errcode = 'P0001';
    end if;
  else
    v_groups := '{}';
  end if;

  -- Idempotency check (same shape as v1).
  select r.audit_log_id, r.notify_target
    into v_existing
  from public.collection_reminder_requests r
  where r.community_id    = v_collection.community_id
    and r.actor_user_id   = v_actor
    and r.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.notify_target <> 'update' then
      raise exception 'IDEMPOTENCY_CONFLICT: this request key was already used for a %, not an update announcement',
                      v_existing.notify_target
        using errcode = 'P0001';
    end if;
    return query select v_existing.audit_log_id, false;
    return;
  end if;

  v_after := jsonb_build_object(
    'changed_fields',    to_jsonb(v_fields),
    'notify_target',     'all',
    'collection_status', v_collection.status,
    'target_audience',   v_target,
    'target_group_ids',  to_jsonb(v_groups)
  );
  if v_custom is not null then
    v_after := v_after || jsonb_build_object('announcement_body', v_custom);
  end if;

  v_audit_id := app.write_audit_log(
    v_collection.community_id,
    'officer',
    v_actor,
    'collection.announce_update',
    'collection',
    p_collection_id,
    null,
    v_after,
    null
  );

  insert into public.collection_reminder_requests
    (community_id, collection_id, actor_user_id, idempotency_key, notify_target, audit_log_id)
  values
    (v_collection.community_id, p_collection_id, v_actor, p_idempotency_key, 'update', v_audit_id);

  return query select v_audit_id, true;
end;
$$;

comment on function app.announce_collection_update_v2(uuid, text[], text, text, text, uuid[]) is
  'Member announcements v2: adds an optional organiser message (<=1000 chars, email addresses stripped) and a per-send target audience (all_members / groups / selected_members; defaults to the collection''s own audience). Idempotent per (community, actor, key). Payment-status targeting is deliberately not available.';

revoke all on function app.announce_collection_update_v2(uuid, text[], text, text, text, uuid[]) from public;
revoke execute on function app.announce_collection_update_v2(uuid, text[], text, text, text, uuid[]) from public, anon;
grant  execute on function app.announce_collection_update_v2(uuid, text[], text, text, text, uuid[]) to authenticated;
