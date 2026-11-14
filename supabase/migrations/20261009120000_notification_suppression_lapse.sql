-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009120000 — A suppression that runs out mid-transaction must not start notifying (M13.2 P3 review)
--
-- THE FAILURE (reproduced on 20261009110000 as amended, in one transaction): an operator
-- activates suppression, a long repair writes audited rows, the 10-minute window passes,
-- and the next audited write is silently enqueued — real people are notified halfway
-- through a repair, with no record that anything changed. Whether any supported operation
-- is long enough today is beside the point: the control exists FOR long repairs.
--
-- THE RULE NOW. In an OPERATOR session (role `none`) that holds a well-formed
-- `v1|<expiry>|<reason>` setting which is OUTSIDE its permitted window (expired, or more
-- than 15 minutes ahead), a suppressible event is neither notified nor silently dropped:
--
--   · it is HELD — sent to the durable queue `notification_events_held`, intact;
--   · it is recorded in notification_suppression_log as `lapsed_held`;
--   · the operator gets ONE warning per transaction;
--   · the audited write itself always commits (this never raises).
--
-- The operator then decides, explicitly and on the record:
--   app.release_held_notifications()          move them to the live queue (they notify)
--   app.discard_held_notifications(reason)    drop them (the suppression the operator wanted)
-- Both are operator-only, refuse any client role, and write a log row per message.
--
-- WHAT DID NOT CHANGE, deliberately:
--   · operator-only, transaction-local (the helper still uses is_local = true, 10 minutes);
--   · the approved 15-minute ceiling — it is not raised, and not bypassed: past it, events are
--     held, never suppressed on the old authority;
--   · ordinary callers (anon, authenticated, service_role, importer, PostgREST): an expired or
--     any other setting is IGNORED for them and their notifications go out as before;
--   · officer access changes are never suppressible, so never held;
--   · a malformed value (not even the v1 shape) is still ignored: the helper validates strictly,
--     so malformed values only arise from hand-setting, which is not a supported path.
--
-- FAILURE DIRECTION, as in the previous fix: a hold that cannot be both RECORDED and QUEUED is
-- not a hold. The event falls through and is notified — recoverable — rather than lost.
--
-- The state function gains a column, so it is dropped and re-created (a function's result
-- columns cannot be changed in place). The trigger function is re-created below.
--
-- Additive for data: nothing in any existing table is changed except a wider CHECK on the
-- log's `outcome`. Rollback: see decision record 18.2.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Where held events wait ───────────────────────────────────────────────────
select pgmq.create('notification_events_held');


-- ── More outcomes in the log ─────────────────────────────────────────────────
alter table public.notification_suppression_log
  drop constraint notification_suppression_log_outcome_values;

alter table public.notification_suppression_log
  add constraint notification_suppression_log_outcome_values
    check (outcome in (
      'suppressed', 'ignored_untrusted_role', 'enqueue_failed',
      'lapsed_held', 'released_held', 'discarded_held'
    ));


-- ── The parser learns what "lapsed" is ───────────────────────────────────────
drop function app.notification_suppression_state();

create function app.notification_suppression_state()
returns table (present boolean, trusted boolean, valid boolean, lapsed boolean, reason text)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_raw   text;
  v_role  text;
  v_parts text[];
  v_now   bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_exp   bigint;
begin
  present := false;
  trusted := false;
  valid   := false;
  lapsed  := false;
  reason  := null;

  begin
    v_raw := nullif(btrim(current_setting('kolekto.suppress_notifications', true)), '');
    if v_raw is null then
      return next;
      return;
    end if;

    present := true;

    -- An operator session reports `none`; the web app always sets `anon` or `authenticated`.
    v_role  := coalesce(nullif(current_setting('role', true), ''), 'none');
    trusted := (v_role = 'none');

    -- Every check precedes the cast it protects, so a malformed value cannot raise.
    v_parts := string_to_array(v_raw, '|');
    if array_length(v_parts, 1) = 3
       and v_parts[1] = 'v1'
       and v_parts[2] ~ '^[0-9]{1,12}$'
       and v_parts[3] ~ '^[a-z0-9 ._-]{3,80}$'
    then
      v_exp  := v_parts[2]::bigint;
      reason := v_parts[3];
      if v_exp > v_now and v_exp <= v_now + 900 then
        valid := true;          -- inside the window: honour it
      else
        lapsed := true;         -- well-formed, but outside the window: expired, or past the 15-minute ceiling
      end if;
    end if;
  exception when others then
    valid  := false;
    lapsed := false;
    reason := null;
  end;

  return next;
  return;
end;
$$;

comment on function app.notification_suppression_state() is
  'M13.2 P3: parses kolekto.suppress_notifications without ever raising. present = a value exists; trusted = the session role is none (an operator); valid = well-formed and inside the window (in the future, at most 15 minutes ahead); lapsed = well-formed but OUTSIDE the window, so it must be neither honoured nor ignored (the trigger holds the event).';

revoke execute on function app.notification_suppression_state() from public, anon, authenticated;


-- ── The trigger ──────────────────────────────────────────────────────────────
create or replace function app.enqueue_notification_on_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_watched     constant text[] := array[
    'collection.publish',
    'member.create', 'member.approve_join', 'member.reject_join', 'member.join_via_invite',
    'officer_invitation.accept', 'officer_term.end'
  ];
  -- Officer access changes are deliberately absent: they are never suppressible.
  c_suppressible constant text[] := array[
    'collection.publish',
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

    -- A membership action is a person acting on a membership. A system actor is not.
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

    -- member.reject_join deletes the member row, so the requester can only come from
    -- before_state: the WHOLE row. Forward three fields and nothing else; the officer's
    -- free-text reason is never forwarded.
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

    select * into v_state from app.notification_suppression_state();
    if v_state.present then
      if not v_state.trusted then
        -- A public role tried the control: ignored, and visible. The record is informational — if it
        -- cannot be written, the notification still goes out.
        begin
          insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome)
          values (new.id, new.community_id, new.action, 'ignored_untrusted_role');
        exception when others then
          null;
        end;
      elsif new.action = any (c_suppressible) then
        if v_state.valid then
          -- Honoured only if it can be RECORDED; otherwise it is not an auditable suppression.
          begin
            insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome, reason)
            values (new.id, new.community_id, new.action, 'suppressed', v_state.reason);
            return new;
          exception when others then
            null;
          end;
        elsif v_state.lapsed then
          -- The operator switched suppression on and its authority has run out (a long repair
          -- outlived its window). Notifying now would start messaging people halfway through the
          -- repair; carrying on suppressing would run past the approved ceiling. So HOLD: keep the
          -- event, intact and durable, record it, tell the operator, and let them decide.
          -- If the hold cannot be both recorded and queued it is not a hold: fall through and notify.
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
      -- Anything else (a non-suppressible action, or a value that is not even v1-shaped) falls
      -- through: the notification proceeds as normal.
    end if;

    perform pgmq.send('notification_events', v_msg);
    return new;
  exception when others then
    -- The audited write must succeed whatever happens here. `raise log` goes to the server log only.
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
  'M13.2 P3 (replaces 20261009110000): as before, plus: in an operator session whose suppression setting is well-formed but outside its window, suppressible events are HELD in notification_events_held and logged as lapsed_held rather than notified or silently dropped. Never raises.';

revoke all on function app.enqueue_notification_on_audit() from public;
revoke execute on function app.enqueue_notification_on_audit() from public, anon, authenticated;


-- ── The operator's two decisions ─────────────────────────────────────────────
create or replace function app.release_held_notifications()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r       record;
  v_batch integer;
  v_total integer := 0;
  v_audit text;
  v_comm  text;
begin
  if coalesce(nullif(current_setting('role', true), ''), 'none') <> 'none' then
    raise exception 'FORBIDDEN: releasing held notifications is an operator-only action' using errcode = '42501';
  end if;

  loop
    v_batch := 0;
    for r in select msg_id, message from pgmq.read('notification_events_held', 120, 500) loop
      v_audit := r.message ->> 'audit_log_id';
      v_comm  := r.message ->> 'community_id';
      perform pgmq.send('notification_events', r.message);
      perform pgmq.delete('notification_events_held', r.msg_id);
      -- Strict, not best-effort: this is an explicit operator action and must be on the record.
      insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome)
      values (
        case when v_audit ~ '^[0-9a-f-]{36}$' then v_audit::uuid end,
        case when v_comm  ~ '^[0-9a-f-]{36}$' then v_comm::uuid end,
        r.message ->> 'action',
        'released_held'
      );
      v_batch := v_batch + 1;
      v_total := v_total + 1;
    end loop;
    exit when v_batch = 0;
  end loop;

  return v_total;
end;
$$;

comment on function app.release_held_notifications() is
  'M13.2 P3: operator-only. Moves every held notification event to the live queue (they will notify), logging one released_held row each. Returns how many.';

revoke execute on function app.release_held_notifications() from public, anon, authenticated;


create or replace function app.discard_held_notifications(p_reason text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r       record;
  v_batch integer;
  v_total integer := 0;
  v_audit text;
  v_comm  text;
begin
  if coalesce(nullif(current_setting('role', true), ''), 'none') <> 'none' then
    raise exception 'FORBIDDEN: discarding held notifications is an operator-only action' using errcode = '42501';
  end if;
  if p_reason is null or p_reason !~ '^[a-z0-9 ._-]{3,80}$' then
    raise exception 'INVALID_REASON: give a reason of 3-80 characters from a-z 0-9 space . _ -' using errcode = '22023';
  end if;

  loop
    v_batch := 0;
    for r in select msg_id, message from pgmq.read('notification_events_held', 120, 500) loop
      v_audit := r.message ->> 'audit_log_id';
      v_comm  := r.message ->> 'community_id';
      perform pgmq.delete('notification_events_held', r.msg_id);
      insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome, reason)
      values (
        case when v_audit ~ '^[0-9a-f-]{36}$' then v_audit::uuid end,
        case when v_comm  ~ '^[0-9a-f-]{36}$' then v_comm::uuid end,
        r.message ->> 'action',
        'discarded_held',
        p_reason
      );
      v_batch := v_batch + 1;
      v_total := v_total + 1;
    end loop;
    exit when v_batch = 0;
  end loop;

  return v_total;
end;
$$;

comment on function app.discard_held_notifications(text) is
  'M13.2 P3: operator-only. Deletes every held notification event (the suppression the operator wanted), logging one discarded_held row each with the given reason. Returns how many.';

revoke execute on function app.discard_held_notifications(text) from public, anon, authenticated;
