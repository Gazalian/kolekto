-- PROPOSED FOR REVIEW. NOT A MIGRATION. NOT APPLIED ANYWHERE. NOT EXECUTED, EVEN ON THE TEST STACK.
-- Kept outside supabase/migrations on purpose: the test stack refuses to start if that directory differs
-- from its copy, and nothing here is approved. On approval it becomes
-- supabase/migrations/<timestamp>_member_collection_announcements.sql unchanged.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Member collection announcements by email
--
-- See docs/product/MEMBER-NOTIFICATIONS-GAP-ANALYSIS.md and
-- docs/product/MEMBER-NOTIFICATIONS-IMPLEMENTATION-REPORT.md.
--
-- Problem: collection notifications only reached members with a linked
-- account (members.user_id IS NOT NULL). No flow ever sets user_id, so every
-- collection notification reached zero members. A community member is a
-- record on the community's roll, not an account (PRD 0.3); they must be
-- reachable through the contact details on that record.
--
-- This migration is additive:
--
--   1. app.collection_announcement_context(uuid)
--        Collection facts the worker puts in an announcement (name, slug,
--        community, description excerpt, fixed amount, deadline) and whether
--        the collection has a page a member WITHOUT an account can open.
--        Reachable = what app.get_public_collection serves: visibility public
--        or unlisted, status active/paused/closed, community active.
--        Members-only and scheduled collections are NOT reachable; nothing
--        here widens the public route.
--
--   2. app.evaluate_collection_email_recipients(uuid, text)
--      (over the internal app.collection_member_email_decisions(uuid, text, boolean))
--        The single email-eligibility decision for collection announcements
--        (category 'announcement' | 'update' | 'reminder'). One row per
--        audience member: either an address with its assurance, or a stable
--        skip reason and no address. Order of checks:
--          collection_not_reachable → member_unavailable → consent_missing →
--          opted_out → address checks.
--        · Consent: members.consent_messages_at must be set (MEM-07 /
--          NOT-01a, decision record §8). It is never written here and NULL is
--          never treated as consent.
--        · Opt-out: notification_preferences.email_enabled = false, or the
--          category flag (announcements_enabled / collection_updates_enabled /
--          reminders_enabled) = false. NULL = default (on), as the table
--          comment specifies.
--        · Address: a member WITHOUT an account uses members.email
--          (assurance unverified_supplied). A member WITH an account uses the
--          confirmed auth.users email only (verified_account), the existing
--          Q-FALLBACK rule from 20261012100000 — never members.email.
--        · Audience: the collection's own audience
--          (app.resolve_collection_audience); for an open ('public' audience)
--          collection, which has no member audience, every current member of
--          the community (status active / unclaimed / invited).
--        No account, auth.users row, profile or session is required.
--
--   3. app.preview_collection_announcement_recipients(uuid, text)
--        Counts only (never addresses) for the organiser's dialog: audience
--        size, email-eligible, in-app-eligible, and each skip reason.
--        Permission: collection.publish.
--
--   4. app.announce_collection_update(uuid, text[], text)
--        Explicit organiser action to announce changes to a live collection.
--        Writes audit action collection.announce_update with the changed
--        field names (an allow-list, never free text) in after_state.
--        Idempotent per (community, actor, key) through the existing
--        collection_reminder_requests table, whose notify_target CHECK is
--        widened (non-destructively) to admit 'update'. Never called by an
--        edit: an edit notifies nobody unless the organiser chooses this.
--
--   5. app.enqueue_notification_on_audit: adds collection.announce_update to
--      the watched and suppressible lists. Body otherwise identical to
--      20261029100000.
--
-- NOT changed:
--   · Unpaid targeting. The worker stops fanning out
--     collection.publish_remind_unpaid / collection.remind_unpaid (payment
--     status cannot be established — no contributions are recorded and no
--     path sets an obligation to paid). The trigger still enqueues them so
--     pgTAP 46/47 remain true; the worker records the event with zero
--     deliveries. The web app no longer offers the option.
--   · email_sending_enabled, send limits (bulk caps stay at zero), any
--     existing row, policy or table other than the one CHECK widened above.
--   · members.consent_messages_at is not written or back-filled.
--
-- Worker activation (same change that applies this file): add
-- "collection.announce_update" to WATCHED_ACTIONS in
-- apps/worker/src/notification-rules.ts. scripts/invariants requires that list
-- to equal c_watched below, so the two land together; the rest of the worker
-- (plan, event key, payload, email category, template) already handles it.
--
-- Worker grant (operator step, NOT in this migration because the worker
-- role is created outside migrations): the least-privilege worker role needs
--   grant execute on function app.collection_announcement_context(uuid) to <worker role>;
--   grant execute on function app.evaluate_collection_email_recipients(uuid, text) to <worker role>;
-- (itest: WORKER_ROLE_FUNCTIONS in scripts/itest/itest.mjs; production: the
-- worker deployment runbook.) Until then the worker detects the functions are
-- unavailable and writes no collection email rows; in-app behaviour is
-- unaffected.
--
-- Rollback (all additive):
--   drop function app.announce_collection_update(uuid, text[], text);
--   drop function app.preview_collection_announcement_recipients(uuid, text);
--   drop function app.evaluate_collection_email_recipients(uuid, text);
--   drop function app.collection_member_email_decisions(uuid, text, boolean);
--   drop function app.collection_announcement_context(uuid);
--   re-create app.enqueue_notification_on_audit from 20261029100000;
--   restore collection_reminder_requests_target_values to ('all','unpaid')
--     (only after confirming no 'update' rows exist).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Collection facts for an announcement ──────────────────────────────────
create or replace function app.collection_announcement_context(p_collection_id uuid)
returns table (
  collection_id       uuid,
  community_id        uuid,
  community_name      text,
  community_slug      text,
  collection_name     text,
  collection_slug     text,
  description_excerpt text,
  amount_model        text,
  fixed_amount_kobo   bigint,
  deadline_at         timestamptz,
  visibility          text,
  status              text,
  audience_mode       text,
  member_reachable    boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id,
    c.community_id,
    cm.name::text,
    cm.slug::text,
    c.name::text,
    c.slug::text,
    left(c.description, 500),
    c.amount_model::text,
    c.fixed_amount_kobo::bigint,
    c.deadline_at,
    c.visibility::text,
    c.status::text,
    c.audience_mode::text,
    -- Mirrors app.get_public_collection exactly: the only page a member
    -- without an account can open.
    (c.visibility in ('public', 'unlisted')
      and c.status in ('active', 'paused', 'closed')
      and cm.status = 'active')
  from public.collections c
  join public.communities cm on cm.id = c.community_id
  where c.id = p_collection_id;
$$;

comment on function app.collection_announcement_context(uuid) is
  'Member announcements: collection facts for an announcement email and whether the collection has a page a member without an account can open (public/unlisted, active/paused/closed). Worker only; no client role may execute it.';

revoke all on function app.collection_announcement_context(uuid) from public;
revoke execute on function app.collection_announcement_context(uuid) from anon, authenticated;


-- ── 2. The eligibility decision ──────────────────────────────────────────────
-- 2a. The per-member decision, given whether the collection is reachable.
--     Internal: callers are 2b (the worker's entry point) and 3 (the preview,
--     which asks "would members be reachable once this draft is live?").
create or replace function app.collection_member_email_decisions(
  p_collection_id uuid,
  p_category      text,
  p_reachable     boolean
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
  v_community_id   uuid;
  v_audience_mode  text;
  v_reachable      boolean;
begin
  if p_category is null or p_category not in ('announcement', 'update', 'reminder') then
    raise exception 'INVALID_CATEGORY: p_category must be announcement, update or reminder; got %', p_category
      using errcode = '22023';
  end if;

  select c.community_id, c.audience_mode::text
    into v_community_id, v_audience_mode
  from public.collections c
  where c.id = p_collection_id;

  if v_community_id is null then
    return;
  end if;

  v_reachable := coalesce(p_reachable, false);

  return query
  with audience as (
    select m.id as aud_member_id
    from public.members m
    where v_audience_mode = 'public'
      and m.community_id = v_community_id
      and m.status in ('active', 'unclaimed', 'invited')
    union
    select a.member_id
    from app.resolve_collection_audience(p_collection_id) a
  ),
  facts as (
    select
      m.id                 as f_member_id,
      m.user_id            as f_user_id,
      m.email::text        as f_member_email,
      m.consent_messages_at as f_consent_at,
      m.status::text       as f_status,
      m.archived_at        as f_archived_at,
      m.merged_into_id     as f_merged_into_id,
      p.email_enabled      as f_email_enabled,
      case p_category
        when 'announcement' then p.announcements_enabled
        when 'update'       then p.collection_updates_enabled
        else                     p.reminders_enabled
      end                  as f_category_enabled,
      u.email::text        as f_auth_email,
      u.email_confirmed_at as f_auth_confirmed_at
    from audience a
    join public.members m
      on m.id = a.aud_member_id
     and m.community_id = v_community_id
    left join public.notification_preferences p
      on p.member_id = m.id and p.community_id = m.community_id
    left join auth.users u
      on u.id = m.user_id
  ),
  decided as (
    select
      f.f_member_id,
      f.f_user_id,
      case
        when not v_reachable then 'collection_not_reachable'
        when f.f_status in ('archived', 'merged')
          or f.f_archived_at is not null
          or f.f_merged_into_id is not null then 'member_unavailable'
        -- Missing consent is never consent (MEM-07 / NOT-01a).
        when f.f_consent_at is null then 'consent_missing'
        when f.f_email_enabled is false or f.f_category_enabled is false then 'opted_out'
        -- Account holder: confirmed auth email only (Q-FALLBACK, 20261012100000).
        when f.f_user_id is not null
         and (f.f_auth_email is null or f.f_auth_confirmed_at is null) then 'unverified_account_email'
        when f.f_user_id is not null
         and not app.email_address_usable(f.f_auth_email) then 'invalid_recipient_address'
        -- No account: the address on the member record.
        when f.f_user_id is null and f.f_member_email is null then 'no_recipient'
        when f.f_user_id is null
         and not app.email_address_usable(f.f_member_email) then 'invalid_recipient_address'
        else null
      end as d_skip_reason,
      case when f.f_user_id is not null then f.f_auth_email else f.f_member_email end as d_candidate,
      case when f.f_user_id is not null then 'verified_account' else 'unverified_supplied' end as d_assurance
    from facts f
  )
  select
    d.f_member_id,
    d.f_user_id,
    d.d_skip_reason is null,
    case when d.d_skip_reason is null then d.d_candidate end,
    case when d.d_skip_reason is null then d.d_assurance end,
    d.d_skip_reason
  from decided d
  order by d.f_member_id;
end;
$$;

comment on function app.collection_member_email_decisions(uuid, text, boolean) is
  'Member announcements (internal): per-member email decision given the collection''s reachability. One row per audience member: an address with its assurance, or a stable skip reason (collection_not_reachable, member_unavailable, consent_missing, opted_out, unverified_account_email, no_recipient, invalid_recipient_address) and no address. No client role may execute it.';

revoke all on function app.collection_member_email_decisions(uuid, text, boolean) from public;
revoke execute on function app.collection_member_email_decisions(uuid, text, boolean) from anon, authenticated;

-- 2b. The worker's entry point: reachability is decided HERE, from the
--     collection's current state, never by the caller.
create or replace function app.evaluate_collection_email_recipients(
  p_collection_id uuid,
  p_category      text
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
declare
  v_reachable boolean;
begin
  -- Mirrors app.get_public_collection: the only page a member without an
  -- account can open.
  select (c.visibility in ('public', 'unlisted')
           and c.status in ('active', 'paused', 'closed')
           and cm.status = 'active')
    into v_reachable
  from public.collections c
  join public.communities cm on cm.id = c.community_id
  where c.id = p_collection_id;

  return query
  select * from app.collection_member_email_decisions(p_collection_id, p_category, coalesce(v_reachable, false));
end;
$$;

comment on function app.evaluate_collection_email_recipients(uuid, text) is
  'Member announcements: the single email-eligibility decision for collection announcements, updates and reminders, with reachability taken from the collection''s current state. Requires no account. Worker only; no client role may execute it.';

revoke all on function app.evaluate_collection_email_recipients(uuid, text) from public;
revoke execute on function app.evaluate_collection_email_recipients(uuid, text) from anon, authenticated;


-- ── 3. Organiser preview: counts only ────────────────────────────────────────
create or replace function app.preview_collection_announcement_recipients(
  p_collection_id uuid,
  p_category      text default 'announcement'
)
returns table (
  audience_total             integer,
  email_eligible             integer,
  in_app_eligible            integer,
  collection_reachable       boolean,
  skipped_not_reachable      integer,
  skipped_consent_missing    integer,
  skipped_opted_out          integer,
  skipped_no_email           integer,
  skipped_invalid_email      integer,
  skipped_unverified_account integer,
  starts_later               boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_reachable    boolean;
  v_starts_later boolean;
begin
  -- "Reachable once live": the preview is shown BEFORE publishing (draft) as
  -- well as after, so a draft that will open now counts as reachable. A
  -- future start (scheduled) is not: the page 404s until it opens, and the
  -- worker skips those members with collection_not_reachable.
  select c.community_id,
         (c.visibility in ('public', 'unlisted')
           and cm.status = 'active'
           and (c.status in ('active', 'paused', 'closed')
                or (c.status = 'draft' and (c.starts_at is null or c.starts_at <= now())))),
         (c.starts_at is not null and c.starts_at > now())
    into v_community_id, v_reachable, v_starts_later
  from public.collections c
  join public.communities cm on cm.id = c.community_id
  where c.id = p_collection_id;

  if v_community_id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  perform app.require_permission(v_community_id, 'collection.publish');

  return query
  select
    count(*)::integer,
    (count(*) filter (where r.eligible))::integer,
    (count(*) filter (where r.user_id is not null))::integer,
    coalesce(v_reachable, false),
    (count(*) filter (where r.skip_reason = 'collection_not_reachable'))::integer,
    (count(*) filter (where r.skip_reason = 'consent_missing'))::integer,
    (count(*) filter (where r.skip_reason = 'opted_out'))::integer,
    (count(*) filter (where r.skip_reason = 'no_recipient'))::integer,
    (count(*) filter (where r.skip_reason = 'invalid_recipient_address'))::integer,
    (count(*) filter (where r.skip_reason = 'unverified_account_email'))::integer,
    coalesce(v_starts_later, false)
  from app.collection_member_email_decisions(p_collection_id, p_category, coalesce(v_reachable, false)) r;
end;
$$;

comment on function app.preview_collection_announcement_recipients(uuid, text) is
  'Member announcements: recipient counts for the organiser dialog (never addresses). Reachability is assessed as "once live", so a draft about to open counts; a future start does not. Permission-checked (collection.publish). Reads only.';

revoke all on function app.preview_collection_announcement_recipients(uuid, text) from public;
revoke execute on function app.preview_collection_announcement_recipients(uuid, text) from public, anon;
grant  execute on function app.preview_collection_announcement_recipients(uuid, text) to authenticated;


-- ── 4. Explicit "announce changes" action ────────────────────────────────────
alter table public.collection_reminder_requests
  drop constraint collection_reminder_requests_target_values;
alter table public.collection_reminder_requests
  add constraint collection_reminder_requests_target_values
    check (notify_target in ('all', 'unpaid', 'update'));

create or replace function app.announce_collection_update(
  p_collection_id   uuid,
  p_changed_fields  text[],
  p_idempotency_key text
)
returns table (audit_log_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_allowed    constant text[] := array['name', 'description', 'deadline', 'start_date', 'story', 'other'];
  v_collection public.collections%rowtype;
  v_actor      uuid := auth.uid();
  v_fields     text[];
  v_existing   record;
  v_audit_id   uuid;
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
  if not (v_fields <@ c_allowed) then
    raise exception 'INVALID_CHANGES: changed fields must be among %', c_allowed using errcode = '22023';
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

  v_audit_id := app.write_audit_log(
    v_collection.community_id,
    'officer',
    v_actor,
    'collection.announce_update',
    'collection',
    p_collection_id,
    null,
    jsonb_build_object(
      'changed_fields', to_jsonb(v_fields),
      'notify_target', 'all',
      'collection_status', v_collection.status
    ),
    null
  );

  insert into public.collection_reminder_requests
    (community_id, collection_id, actor_user_id, idempotency_key, notify_target, audit_log_id)
  values
    (v_collection.community_id, p_collection_id, v_actor, p_idempotency_key, 'update', v_audit_id);

  return query select v_audit_id, true;
end;
$$;

comment on function app.announce_collection_update(uuid, text[], text) is
  'Member announcements: an officer with collection.publish explicitly announces changes to a live (active, scheduled or paused) collection. Writes collection.announce_update with an allow-listed changed_fields list. Idempotent per (community, actor, key). Editing a collection never calls this.';

revoke all on function app.announce_collection_update(uuid, text[], text) from public;
revoke execute on function app.announce_collection_update(uuid, text[], text) from public, anon;
grant  execute on function app.announce_collection_update(uuid, text[], text) to authenticated;


-- ── 5. Audit trigger: watch collection.announce_update ───────────────────────
-- Identical to 20261029100000 except for the one new action in both lists.
create or replace function app.enqueue_notification_on_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_watched     constant text[] := array[
    'collection.publish',
    'collection.publish_remind_unpaid',
    'collection.remind',
    'collection.remind_unpaid',
    'collection.announce_update',
    'member.create', 'member.approve_join', 'member.reject_join', 'member.join_via_invite',
    'officer_invitation.accept', 'officer_term.end'
  ];
  c_suppressible constant text[] := array[
    'collection.publish',
    'collection.publish_remind_unpaid',
    'collection.remind',
    'collection.remind_unpaid',
    'collection.announce_update',
    'member.create', 'member.approve_join', 'member.reject_join', 'member.join_via_invite'
  ];
  v_state   record;
  v_msg     jsonb;
  v_before  jsonb;
  v_name    text;
  v_via     text;
  v_email   text;
begin
  begin
    if new.community_id is null or not (new.action = any (c_watched)) then
      return new;
    end if;

    if new.action like 'member.%' and new.actor_type::text not in ('officer', 'member') then
      return new;
    end if;

    v_msg := jsonb_build_object(
      'audit_log_id', new.id,
      'community_id', new.community_id,
      'action',       new.action,
      'actor_type',   new.actor_type::text,
      'actor_user_id', new.actor_user_id,
      'actor_name',   new.actor_name_snapshot,
      'object_type',  new.object_type,
      'object_id',    new.object_id,
      'after_state',  new.after_state,
      'created_at',   new.created_at
    );

    if new.action = 'member.reject_join' and jsonb_typeof(new.before_state) = 'object' then
      v_before := new.before_state;
      v_name  := case when jsonb_typeof(v_before -> 'full_name') = 'string'
                      then left(v_before ->> 'full_name', 120) end;
      v_via   := case when jsonb_typeof(v_before -> 'joined_via') = 'string'
                      then left(v_before ->> 'joined_via', 40) end;
      v_email := case when v_via = 'invite_link' and jsonb_typeof(v_before -> 'email') = 'string'
                      then left(v_before ->> 'email', 254) end;
      v_msg := v_msg || jsonb_build_object(
        'before_state',
        jsonb_build_object('full_name', v_name, 'joined_via', v_via, 'email', v_email)
      );
    end if;

    -- Operator-only notification suppression (M13.2 P3, preserved).
    select * into v_state from app.notification_suppression_state();
    if v_state.present then
      if not v_state.trusted then
        begin
          insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome)
          values (new.id, new.community_id, new.action, 'ignored_untrusted_role');
        exception when others then
          null;
        end;
      elsif new.action = any (c_suppressible) then
        if v_state.valid then
          begin
            insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome, reason)
            values (new.id, new.community_id, new.action, 'suppressed', v_state.reason);
            return new;
          exception when others then
            null;
          end;
        elsif v_state.lapsed then
          begin
            insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome, reason)
            values (new.id, new.community_id, new.action, 'lapsed_held', v_state.reason);
            perform pgmq.send('notification_events_held', v_msg);

            if coalesce(current_setting('kolekto.suppression_lapse_warned', true), '') <> 'on' then
              raise warning 'NOTIFICATION SUPPRESSION LAPSED in this transaction: its window ended, so further notification events are being HELD in notification_events_held (not sent, not discarded). Decide with app.release_held_notifications() or app.discard_held_notifications(reason). Keep maintenance transactions under 10 minutes.';
              perform set_config('kolekto.suppression_lapse_warned', 'on', true);
            end if;
            return new;
          exception when others then
            null;
          end;
        end if;
      end if;
    end if;

    perform pgmq.send('notification_events', v_msg);
    return new;
  exception when others then
    raise log 'notification enqueue failed (sqlstate %): the audited write was allowed to proceed', sqlstate;
    begin
      insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome)
      values (new.id, new.community_id, new.action, 'enqueue_failed');
    exception when others then
      null;
    end;
    return new;
  end;
end;
$$;

comment on function app.enqueue_notification_on_audit() is
  'Member announcements: watches collection.publish, collection.publish_remind_unpaid, '
  'collection.remind, collection.remind_unpaid, collection.announce_update, member.create / '
  'approve_join / reject_join / join_via_invite, officer_invitation.accept, officer_term.end. '
  'Officer access changes are never suppressible. Preserves lapse-held suppression path from '
  '20261009120000. Never raises.';

revoke all on function app.enqueue_notification_on_audit() from public;
revoke execute on function app.enqueue_notification_on_audit() from public, anon, authenticated;
