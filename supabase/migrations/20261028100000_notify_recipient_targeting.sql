-- ─────────────────────────────────────────────────────────────────────────────
-- 20261028100000 — Recipient targeting at publish (M13.3 follow-up)
--
-- Extends the host-facing publish gate from 20261027210000 so the host can
-- target a narrower audience than "everyone eligible":
--
--   notify_target = 'all'    → audit action `collection.publish`
--                              (every eligible audience member with an account
--                               is notified in-app, the existing default).
--   notify_target = 'unpaid' → audit action `collection.publish_remind_unpaid`
--                              (only members whose latest obligation on this
--                               collection is unpaid, in_installments or
--                               overdue; `exempt`, `paid` and `cancelled` are
--                               excluded, and members who have no obligation
--                               yet are excluded too — the data does not say
--                               they owe the payment, only that they are
--                               eligible for it).
--   notify_target = 'none'   → audit action `collection.publish_silent`
--                              (no in-app notification, same as before).
--
-- This migration:
--
--   1. Replaces `app.publish_collection(uuid, collection_status, text, boolean)`
--      with `app.publish_collection(uuid, collection_status, text, text)`,
--      whose fourth argument accepts the three values above. The boolean
--      variant is dropped (the previous slice landed in the same stack and
--      has no production callers).
--   2. Adds `collection.publish_remind_unpaid` to the audit trigger's watched
--      list in `app.enqueue_notification_on_audit`, so a publish that targets
--      the unpaid cohort still enqueues a pgmq message — the worker's
--      recipient-plan code (apps/worker/src/notification-rules.ts) handles
--      the filtered fan-out from that side.
--   3. Adds `app.count_collection_publish_recipients(uuid)` so the publish
--      dialog can preview `eligible` and `unpaid` counts without duplicating
--      the queries the worker already uses.
--
-- NOT changed by this migration:
--
--   · The notification_events, notification_deliveries or audit_logs schema.
--   · The suppression / operator-only controls from 20261009110000.
--   · Any policy, grant or table outside the two app.* functions it rewrites.
--   · `email_sending_enabled`. No real email is sent; the worker's email
--      stage is still gated by that switch.
--
-- Rollback: restore the trigger body from 20261009110000 (dropping
-- `collection.publish_remind_unpaid` from c_watched), drop the new
-- `app.count_collection_publish_recipients`, drop the text-form
-- `app.publish_collection`, and re-create the boolean form from
-- 20261027210000.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Replace app.publish_collection with the enum-shaped notify target ─────
drop function if exists app.publish_collection(uuid, public.collection_status, text, boolean);

create or replace function app.publish_collection(
  p_collection_id uuid,
  p_expected      public.collection_status,
  p_reason        text default null,
  p_notify_target text default 'all'
)
returns public.collection_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_resolved   public.collection_status;
  v_tier_count integer;
  v_action     text;
begin
  if p_notify_target is null or p_notify_target not in ('all', 'unpaid', 'none') then
    raise exception 'INVALID_NOTIFY_TARGET: p_notify_target must be one of all, unpaid, none; got %', p_notify_target
      using errcode = '22023';
  end if;

  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.publish');

  if v_collection.status <> p_expected then
    raise exception 'STATUS_CONFLICT: collection % is %, not %', p_collection_id, v_collection.status, p_expected
      using errcode = 'P0001',
            hint = 'Someone else changed this collection. Reload and try again.';
  end if;

  if v_collection.status <> 'draft' then
    raise exception 'INVALID_TRANSITION: a % collection cannot be published, use app.transition_collection_status',
                    v_collection.status
      using errcode = 'P0001';
  end if;

  -- Publish preconditions (same as STM-01's publish branch).
  if v_collection.amount_model = 'fixed' and coalesce(v_collection.fixed_amount_kobo, 0) <= 0 then
    raise exception 'NOT_PUBLISHABLE: set the contribution amount before publishing' using errcode = 'P0001';
  end if;
  if v_collection.amount_model = 'tiers' then
    select count(*) into v_tier_count
    from public.collection_tiers
    where collection_id = p_collection_id and not hidden;
    if v_tier_count = 0 then
      raise exception 'NOT_PUBLISHABLE: add at least one visible option before publishing' using errcode = 'P0001';
    end if;
  end if;
  if v_collection.deadline_at is not null and v_collection.deadline_at <= now() then
    raise exception 'NOT_PUBLISHABLE: the deadline has already passed' using errcode = 'P0001';
  end if;

  if v_collection.starts_at is not null and v_collection.starts_at > now() then
    v_resolved := 'scheduled';
  else
    v_resolved := 'active';
  end if;

  -- The audit action is what tells the audit trigger whether (and how) to
  -- enqueue: `collection.publish` fans out to the whole audience,
  -- `collection.publish_remind_unpaid` fans out only to members with an
  -- outstanding obligation on this collection (the filter lives in the
  -- worker's resolveRecipients code — the trigger is dumb about which plan
  -- applies, it just enqueues the message), `collection.publish_silent` is
  -- not watched by the trigger at all.
  v_action := case p_notify_target
    when 'all'    then 'collection.publish'
    when 'unpaid' then 'collection.publish_remind_unpaid'
    else               'collection.publish_silent'
  end;

  update public.collections set
    status       = v_resolved,
    published_at = now(),
    published_by = auth.uid()
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id,
    'officer',
    auth.uid(),
    v_action,
    'collection',
    p_collection_id,
    jsonb_build_object('status', v_collection.status),
    jsonb_build_object('status', v_resolved, 'notify_target', p_notify_target),
    p_reason
  );

  return v_resolved;
end;
$$;

comment on function app.publish_collection(uuid, public.collection_status, text, text) is
  'M13.3 follow-up: host-facing publish with an explicit notification target. '
  'p_notify_target = all → audit collection.publish (trigger enqueues, worker fans out to the whole audience). '
  'p_notify_target = unpaid → audit collection.publish_remind_unpaid (trigger enqueues, worker fans out only to '
  'audience members with an outstanding obligation on this collection). '
  'p_notify_target = none → audit collection.publish_silent (not watched, no enqueue). '
  'Business state (status, published_at, published_by) is identical in all three cases. '
  'Narrow by design: refuses non-draft transitions.';

revoke all on function app.publish_collection(uuid, public.collection_status, text, text) from public;
revoke execute on function app.publish_collection(uuid, public.collection_status, text, text) from public, anon;
grant  execute on function app.publish_collection(uuid, public.collection_status, text, text) to authenticated;


-- ── 2. Audit trigger: watch the new "remind unpaid" action ───────────────────
-- Rebuilds app.enqueue_notification_on_audit from 20261009110000 with
-- `collection.publish_remind_unpaid` added to c_watched. The trigger does NOT
-- filter recipients itself — it writes exactly the same pgmq payload for both
-- publish variants (audit_log_id, action, community_id, actor, object, …).
-- The worker reads the action from the message and picks the recipient plan
-- (apps/worker/src/notification-rules.ts recipientPlan): `collection.publish`
-- → whole audience; `collection.publish_remind_unpaid` → audience members
-- with an outstanding obligation on this collection.
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
    'member.create', 'member.approve_join', 'member.reject_join', 'member.join_via_invite',
    'officer_invitation.accept', 'officer_term.end'
  ];
  -- Both publish actions are suppressible; officer access changes are not.
  c_suppressible constant text[] := array[
    'collection.publish',
    'collection.publish_remind_unpaid',
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

    -- Operator-only notification suppression (M13.2 P3, preserved verbatim here
    -- so the lapse-held path is not accidentally bypassed by the recipient-target
    -- rewrite). A valid in-window setting → suppressed; a well-formed but lapsed
    -- one (expired, or more than 15 minutes ahead) → HELD in notification_events_held
    -- with a lapsed_held log row; an untrusted client role → ignored and logged.
    -- Officer access changes are never suppressible.
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
          -- Operator session, suppression well-formed but outside its window: keep the
          -- event intact in the held queue; the operator decides via
          -- app.release_held_notifications() / app.discard_held_notifications(reason).
          -- If the hold cannot be both recorded and queued it is not a hold: fall through.
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
  'M13.3: watches collection.publish, collection.publish_remind_unpaid, '
  'member.create / approve_join / reject_join / join_via_invite, '
  'officer_invitation.accept, officer_term.end. Ignores system actors on member.*. '
  'Narrow before_state for reject_join. Honours operator-only suppression and the '
  'lapse-held path from 20261009120000 (never for officer access changes). '
  'Never raises: a failure is absorbed so the audited write proceeds.';

revoke all on function app.enqueue_notification_on_audit() from public;
revoke execute on function app.enqueue_notification_on_audit() from public, anon, authenticated;


-- ── 3. Preview counts for the publish dialog ─────────────────────────────────
-- Reused by the UI's recipient-preview card. `eligible` is the full audience
-- (what notify_target='all' reaches); `unpaid` is the subset notify_target
-- 'unpaid' reaches: audience members with an obligation on this collection
-- in ('unpaid', 'in_installments', 'overdue'). Members with `exempt`, `paid`
-- or `cancelled` obligations are excluded, and members with no obligation yet
-- are excluded too (the data does not say they owe this payment).
create or replace function app.count_collection_publish_recipients(p_collection_id uuid)
returns table (eligible integer, unpaid integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
begin
  select community_id into v_community_id from public.collections where id = p_collection_id;
  if v_community_id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  perform app.require_permission(v_community_id, 'collection.publish');

  with audience as (
    select a.member_id, m.user_id
    from app.resolve_collection_audience(p_collection_id) a
    join public.members m on m.id = a.member_id
    where m.user_id is not null
  ),
  outstanding as (
    select o.member_id
    from public.obligations o
    where o.collection_id = p_collection_id
      and o.status in ('unpaid', 'in_installments', 'overdue')
  )
  select
    (select count(*)::integer from audience),
    (select count(*)::integer from audience a where exists (select 1 from outstanding s where s.member_id = a.member_id));
end;
$$;

comment on function app.count_collection_publish_recipients(uuid) is
  'M13.3: recipient-preview counts for the publish dialog. '
  'eligible = audience members with a linked account (what notify_target=all reaches). '
  'unpaid   = those with an obligation on this collection in (unpaid, in_installments, overdue). '
  'Permission-checked (collection.publish). Reads only.';

revoke all on function app.count_collection_publish_recipients(uuid) from public;
revoke execute on function app.count_collection_publish_recipients(uuid) from public, anon;
grant  execute on function app.count_collection_publish_recipients(uuid) to authenticated;
