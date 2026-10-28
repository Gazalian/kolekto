-- ─────────────────────────────────────────────────────────────────────────────
-- 20261029100000 — Post-publish reminders for an already-published collection
--
-- An organiser must be able to notify members AFTER a collection is already
-- published: particularly members who still owe money. Until now the only
-- notification hook has been publish time (20261027210000, extended with
-- recipient targeting in 20261028100000). This milestone adds a dedicated
-- action an organiser can trigger on any `active` or `scheduled` collection.
--
--   notify_target = 'all'    → audit action `collection.remind`
--                              (the full eligible audience, same cohort as
--                               `collection.publish` with notify_target=all).
--   notify_target = 'unpaid' → audit action `collection.remind_unpaid`
--                              (audience members whose current obligation on
--                               this collection is unpaid, in_installments or
--                               overdue — exempt, paid, cancelled and
--                               no-obligation members are excluded, matching
--                               `collection.publish_remind_unpaid`).
--
-- `none` is not a server-side value for reminders: the UI treats "no
-- notification" as a cancel/close, which never reaches the server. The DB
-- function therefore rejects anything other than `all` or `unpaid`.
--
-- WHY A NEW ACTION, NOT A REPUBLISH. A reminder is semantically different
-- from publishing: no state transition, no change to `published_at` /
-- `published_by`, no "newly live" copy. The notification pipeline consumes
-- the audit action's name to pick a recipient plan and payload, and the
-- audit log is also the historical record people inspect. Hiding a reminder
-- as a second `collection.publish` would make old publications look like new
-- ones and would re-fire the worker's single-publish dedupe. See the
-- adjustment to `eventKey` in apps/worker/src/notification-rules.ts.
--
-- IDEMPOTENCY. A publish is naturally once-per-collection (can't republish),
-- so the worker dedupes on (action, collection_id). A reminder can fire many
-- times and must still protect against accidental duplicate submissions
-- without blocking legitimate future reminders. Each request carries an
-- `idempotency_key` the client generates when the dialog opens, and the
-- function uniquely records (community_id, actor_user_id, idempotency_key)
-- in `public.collection_reminder_requests`. A duplicate submission re-finds
-- the existing row and returns its original audit_log_id without writing a
-- second audit event; a later legitimate reminder (new key) writes a new
-- audit event and a new request row. See `apps/web/.../CollectionDetailClient.tsx`
-- for the key-per-open behaviour.
--
-- AUTHORIZATION. The function is `security definer` with `search_path=''`
-- and requires `collection.publish` on the collection's community (reused:
-- the officer role that can publish is the same one that can remind). It
-- refuses any other collection state than `active` or `scheduled`.
--
-- The worker's recipient resolution (`collection_audience` and
-- `collection_audience_unpaid` plans) is reused unchanged — the two new
-- action names map onto the existing plans in notification-rules.ts.
-- No change to notification_events, notification_deliveries,
-- obligations, or audience resolution. `email_sending_enabled` stays off:
-- reminders use the same in-app pipeline, so email remains disabled.
--
-- Rollback: drop `app.send_collection_publish_reminder`,
-- drop `public.collection_reminder_requests`, and re-create
-- `app.enqueue_notification_on_audit` without the two new actions in
-- c_watched / c_suppressible.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Idempotency table for reminder requests ───────────────────────────────
-- One row per unique (community, actor, idempotency_key) tuple. The audit
-- log the function wrote for this request is referenced here so a duplicate
-- submission can return the same audit_log_id without re-firing anything.
-- Tiny table (growth is bounded by the human cadence of "send reminder"
-- clicks, not by any data event); narrow indexes on the natural key.
create table public.collection_reminder_requests (
  id               uuid primary key default app.uuid_generate_v7(),
  community_id     uuid not null references public.communities(id) on delete cascade,
  collection_id    uuid not null references public.collections(id) on delete cascade,
  actor_user_id    uuid not null references public.users(id)       on delete cascade,
  idempotency_key  text not null,
  notify_target    text not null,
  audit_log_id     uuid references public.audit_logs(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint collection_reminder_requests_target_values
    check (notify_target in ('all', 'unpaid')),
  constraint collection_reminder_requests_key_shape
    check (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$')
);

create unique index collection_reminder_requests_actor_key_uq
  on public.collection_reminder_requests (community_id, actor_user_id, idempotency_key);

create index collection_reminder_requests_collection_idx
  on public.collection_reminder_requests (collection_id);

comment on table public.collection_reminder_requests is
  'M13.3 post-publish reminders: one row per unique (community, actor, idempotency_key). '
  'A duplicate submission with the same key reuses the recorded audit_log_id and does not '
  'enqueue a second notification. Does not store any member-facing content.';

alter table public.collection_reminder_requests enable row level security;
alter table public.collection_reminder_requests force row level security;

-- The repository's rule (01_rls_coverage.sql) is that every public table carries a
-- policy, so "nobody but the server" is a stated decision, not an accident. Same
-- pattern as public.notification_suppression_log: an explicit deny that matches no
-- row for any client role; privileges are revoked below so a client is refused
-- before RLS is even consulted.
create policy collection_reminder_requests_deny_client_access
  on public.collection_reminder_requests for select to authenticated
  using (false);

revoke all on public.collection_reminder_requests from public, anon, authenticated;


-- ── 2. The reminder function ─────────────────────────────────────────────────
-- Pure server action: permission-check, state-check, resolve the audit action
-- from the target, record the idempotency row (or reuse one), write the audit
-- log, backfill the audit_log_id. The audit insert triggers
-- `app.enqueue_notification_on_audit` which enqueues the pgmq message; the
-- worker then fans out to the audience the recipient plan selects.
--
-- Returns the audit_log_id so the caller (and tests) can confirm what event
-- was created and whether it was a fresh one or an idempotent reuse.
create or replace function app.send_collection_publish_reminder(
  p_collection_id   uuid,
  p_notify_target   text,
  p_idempotency_key text,
  p_reason          text default null
)
returns table (audit_log_id uuid, created boolean, notify_target text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_action     text;
  v_actor      uuid := auth.uid();
  v_existing   record;
  v_audit_id   uuid;
begin
  if p_notify_target is null or p_notify_target not in ('all', 'unpaid') then
    raise exception 'INVALID_NOTIFY_TARGET: p_notify_target must be all or unpaid; got %', p_notify_target
      using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,128}$' then
    raise exception 'INVALID_IDEMPOTENCY_KEY: 8-128 characters of A-Z a-z 0-9 _ -'
      using errcode = '22023';
  end if;

  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.publish');

  if v_collection.status not in ('active', 'scheduled') then
    raise exception 'INVALID_STATE: a % collection cannot send reminders (only active or scheduled)',
                    v_collection.status
      using errcode = 'P0001',
            hint   = 'A reminder is for a published collection that is still collecting.';
  end if;

  if v_actor is null then
    raise exception 'FORBIDDEN: a reminder must be sent by a signed-in officer' using errcode = '42501';
  end if;

  v_action := case p_notify_target
    when 'all'    then 'collection.remind'
    when 'unpaid' then 'collection.remind_unpaid'
  end;

  -- Idempotent record of this request. If the same (community, actor, key)
  -- already fired, return its audit_log_id without writing anything new.
  select r.audit_log_id, r.notify_target
    into v_existing
  from public.collection_reminder_requests r
  where r.community_id    = v_collection.community_id
    and r.actor_user_id   = v_actor
    and r.idempotency_key = p_idempotency_key;

  if found then
    -- A second submission under the same key with a different target is a
    -- client bug: refuse rather than silently rewriting what the first
    -- submission did. Future reminders use a fresh key.
    if v_existing.notify_target <> p_notify_target then
      raise exception 'IDEMPOTENCY_CONFLICT: this request key was already used with target %, cannot reuse it for %',
                      v_existing.notify_target, p_notify_target
        using errcode = 'P0001';
    end if;
    return query select v_existing.audit_log_id, false, v_existing.notify_target;
    return;
  end if;

  -- Fresh request: write the audit log; the trigger enqueues the pgmq
  -- message with action=v_action and object_id=p_collection_id.
  v_audit_id := app.write_audit_log(
    v_collection.community_id,
    'officer',
    v_actor,
    v_action,
    'collection',
    p_collection_id,
    null,
    jsonb_build_object(
      'notify_target', p_notify_target,
      'collection_status', v_collection.status
    ),
    p_reason
  );

  insert into public.collection_reminder_requests
    (community_id, collection_id, actor_user_id, idempotency_key, notify_target, audit_log_id)
  values
    (v_collection.community_id, p_collection_id, v_actor, p_idempotency_key, p_notify_target, v_audit_id);

  return query select v_audit_id, true, p_notify_target;
end;
$$;

comment on function app.send_collection_publish_reminder(uuid, text, text, text) is
  'M13.3 post-publish reminders: an officer with collection.publish sends a reminder on an '
  'already-published (active or scheduled) collection. p_notify_target = all → '
  '`collection.remind` (full audience), p_notify_target = unpaid → `collection.remind_unpaid` '
  '(audience members with an unpaid / in_installments / overdue obligation). Idempotent via '
  'p_idempotency_key: a duplicate submission reuses the recorded audit_log_id and does not '
  'enqueue a second event. Returns audit_log_id, created (true = fresh request, false = reused), '
  'notify_target.';

revoke all on function app.send_collection_publish_reminder(uuid, text, text, text) from public;
revoke execute on function app.send_collection_publish_reminder(uuid, text, text, text) from public, anon;
grant  execute on function app.send_collection_publish_reminder(uuid, text, text, text) to authenticated;


-- ── 3. Audit trigger: watch the two new reminder actions ─────────────────────
-- Additive update to 20261028100000's body: `collection.remind` and
-- `collection.remind_unpaid` are watched (so the worker runs the recipient
-- plan) and suppressible (so a maintenance operator's suppression setting
-- applies the same way it does for publish). Officer access changes stay
-- non-suppressible. Nothing else in the trigger body changes.
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
    'member.create', 'member.approve_join', 'member.reject_join', 'member.join_via_invite',
    'officer_invitation.accept', 'officer_term.end'
  ];
  c_suppressible constant text[] := array[
    'collection.publish',
    'collection.publish_remind_unpaid',
    'collection.remind',
    'collection.remind_unpaid',
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
  'M13.3 post-publish reminders: watches collection.publish, collection.publish_remind_unpaid, '
  'collection.remind, collection.remind_unpaid, member.create / approve_join / reject_join / '
  'join_via_invite, officer_invitation.accept, officer_term.end. Officer access changes are '
  'never suppressible. Preserves lapse-held suppression path from 20261009120000. Never raises.';

revoke all on function app.enqueue_notification_on_audit() from public;
revoke execute on function app.enqueue_notification_on_audit() from public, anon, authenticated;
