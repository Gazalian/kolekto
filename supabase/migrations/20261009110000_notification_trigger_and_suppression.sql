-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009110000 — Approved event mapping, trigger safety and suppression (M13.2 P3)
--
-- docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md, sections 10.7 and 18;
-- docs/product/M13.2-MEMBERSHIP-CREATION-INVENTORY.md.
--
-- What this does, and only this:
--
--   1. Replaces app.enqueue_notification_on_audit() so that it
--        · watches the approved actions: the three M13.1 ones plus member.create,
--          member.reject_join, officer_invitation.accept and officer_term.end;
--        · ignores the four member.* actions when the actor is not an officer or a
--          member (a `system` actor is not a person acting on a membership);
--        · for member.reject_join, forwards ONLY a narrow object from before_state
--          — display name, joined_via, and the email only if the requester typed it
--          themselves (joined_via = 'invite_link') — never the whole member row,
--          never the officer's free-text reason;
--        · honours the operator-only suppression control (below);
--        · NEVER makes the audited write fail: the whole body runs inside an
--          exception handler. This trigger fires inside every audited write in the
--          product, so an error in it would roll back a legitimate business action.
--          A failure is recorded (server log, no data; and a row in the log table
--          if that too can be written) and the write proceeds.
--   2. Adds the append-only notification_suppression_log. No client role can read
--      or write it.
--   3. Adds app.begin_notification_suppression(reason): the only supported way to
--      switch suppression on. Operator sessions only; transaction-local.
--   4. Adds app.notification_suppression_state(): parses the setting WITHOUT ever
--      raising, so a malformed value can never break a write.
--
-- It does NOT create any email delivery row, add any permission, touch any business
-- or financial table, or change what the worker does (that is application code).
--
-- Suppression, in one paragraph. The custom setting kolekto.suppress_notifications
-- is `v1|<expiry unix seconds>|<reason>`. It is honoured only if ALL of: the session
-- `role` setting is `none` (an operator session — the web app always switches to
-- `anon` or `authenticated` first, packages/db/src/client.ts, so a public caller can
-- never satisfy this even if they could set the variable); the expiry is in the
-- future and no more than 15 minutes ahead; the reason is 3-80 characters of
-- a-z 0-9 space . _ -; and the action is suppressible. Officer access changes
-- (officer_term.end, officer_invitation.accept) are never suppressible. A suppressed
-- event is not enqueued and is recorded in the log; the audit row itself and every
-- business record are untouched.
--
-- Additive; no row in any existing table is changed. Rollback: restore the previous
-- function body from 20261007110000, drop the two helper functions and the log table.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── The log ──────────────────────────────────────────────────────────────────
-- Records every time a notification was deliberately not produced, or could not be.
-- Holds no names, addresses or error text: ids, an action name, an outcome and the
-- operator's reason slug.
create table public.notification_suppression_log (
  id           uuid primary key default app.uuid_generate_v7(),
  audit_log_id uuid,
  community_id uuid,
  action       text not null,
  outcome      text not null,
  reason       text,
  created_at   timestamptz not null default now(),

  constraint notification_suppression_log_outcome_values
    check (outcome in ('suppressed', 'ignored_untrusted_role', 'enqueue_failed')),
  constraint notification_suppression_log_action_format
    check (action ~ '^[a-z_]+\.[a-z_]+$'),
  constraint notification_suppression_log_reason_format
    check (reason is null or reason ~ '^[a-z0-9 ._-]{3,80}$')
);

comment on table public.notification_suppression_log is
  'M13.2 P3: append-only record of notifications deliberately not produced (suppressed by an operator), attempts to suppress from an untrusted role, and enqueue failures that the trigger absorbed so the business write could proceed. No client role has any access.';

create index notification_suppression_log_created_idx
  on public.notification_suppression_log (created_at desc);
create index notification_suppression_log_audit_idx
  on public.notification_suppression_log (audit_log_id);

alter table public.notification_suppression_log enable row level security;
alter table public.notification_suppression_log force row level security;

-- The repository's rule (01_rls_coverage.sql) is that every public table carries a
-- policy, so "nobody but the server" is a stated decision, not an accident. This is the
-- same explicit deny used for the migration.* tables: it matches no row for anyone. The
-- privileges are also revoked, so a client role is refused before RLS is even consulted.
create policy notification_suppression_log_deny_client_access
  on public.notification_suppression_log for select to authenticated
  using (false);

revoke all on table public.notification_suppression_log from public, anon, authenticated;

create or replace function app.block_notification_log_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'NOTIFICATION_LOG_IS_APPEND_ONLY: notification_suppression_log rows cannot be % (M13.2 P3)',
    lower(tg_op)
    using errcode = 'P0001';
  return null;
end;
$$;

revoke execute on function app.block_notification_log_mutation() from public, anon, authenticated;

create trigger notification_suppression_log_no_update
  before update on public.notification_suppression_log
  for each row execute function app.block_notification_log_mutation();
create trigger notification_suppression_log_no_delete
  before delete on public.notification_suppression_log
  for each row execute function app.block_notification_log_mutation();
create trigger notification_suppression_log_no_truncate
  before truncate on public.notification_suppression_log
  for each statement execute function app.block_notification_log_mutation();


-- ── Reading the setting: never raises ────────────────────────────────────────
create or replace function app.notification_suppression_state()
returns table (present boolean, trusted boolean, valid boolean, reason text)
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
  reason  := null;

  begin
    v_raw := nullif(btrim(current_setting('kolekto.suppress_notifications', true)), '');
    if v_raw is null then
      return next;
      return;
    end if;

    present := true;

    -- An operator session reports `none`; the web app always sets `anon` or
    -- `authenticated` (verified: packages/db/src/client.ts withCallerContext).
    v_role  := coalesce(nullif(current_setting('role', true), ''), 'none');
    trusted := (v_role = 'none');

    -- Every check precedes the cast it protects, so a malformed value cannot raise.
    v_parts := string_to_array(v_raw, '|');
    if array_length(v_parts, 1) = 3
       and v_parts[1] = 'v1'
       and v_parts[2] ~ '^[0-9]{1,12}$'
       and v_parts[3] ~ '^[a-z0-9 ._-]{3,80}$'
    then
      v_exp := v_parts[2]::bigint;
      -- Lifetime: in the future, and at most 15 minutes ahead.
      if v_exp > v_now and v_exp <= v_now + 900 then
        valid  := true;
        reason := v_parts[3];
      end if;
    end if;
  exception when others then
    -- Belt and braces: nothing above should raise, and if it does the answer is "not valid".
    valid  := false;
    reason := null;
  end;

  return next;
  return;
end;
$$;

comment on function app.notification_suppression_state() is
  'M13.2 P3: parses kolekto.suppress_notifications without ever raising. present = a value exists; trusted = the session role is none (an operator); valid = well-formed, in the future, at most 15 minutes ahead.';

revoke execute on function app.notification_suppression_state() from public, anon, authenticated;


-- ── Switching it on: the only supported way ──────────────────────────────────
create or replace function app.begin_notification_suppression(p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(nullif(current_setting('role', true), ''), 'none') <> 'none' then
    raise exception 'FORBIDDEN: notification suppression is an operator-only control'
      using errcode = '42501';
  end if;
  if p_reason is null or p_reason !~ '^[a-z0-9 ._-]{3,80}$' then
    raise exception 'INVALID_REASON: give a reason of 3-80 characters from a-z 0-9 space . _ -'
      using errcode = '22023';
  end if;

  -- is_local = true: transaction-local. The setting disappears when the transaction ends.
  perform set_config(
    'kolekto.suppress_notifications',
    'v1|' || (floor(extract(epoch from clock_timestamp()))::bigint + 600)::text || '|' || p_reason,
    true
  );
end;
$$;

comment on function app.begin_notification_suppression(text) is
  'M13.2 P3: operator-only. Starts notification suppression for the rest of the current transaction, for at most 10 minutes. Refuses any session whose role is anon or authenticated. Not executable by any client role.';

revoke execute on function app.begin_notification_suppression(text) from public, anon, authenticated;


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

    -- A membership action is a person acting on a membership. A system actor (a
    -- maintenance marker, a repair) is not, and must not notify anyone.
    if new.action like 'member.%' and new.actor_type::text not in ('officer', 'member') then
      return new;
    end if;

    select * into v_state from app.notification_suppression_state();
    if v_state.present then
      if not v_state.trusted then
        -- Someone tried to use the control from a public role. It is ignored, and visible.
        -- The record is informational: if it cannot be written, the notification must
        -- still go out, so a broken log can never swallow an event.
        begin
          insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome)
          values (new.id, new.community_id, new.action, 'ignored_untrusted_role');
        exception when others then
          null;
        end;
      elsif v_state.valid and new.action = any (c_suppressible) then
        -- A suppression is honoured only if it can be RECORDED. One that cannot be
        -- recorded is not an auditable suppression, so it falls through and the
        -- notification proceeds: failing toward notifying is recoverable, a silent
        -- unrecorded loss is not.
        begin
          insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome, reason)
          values (new.id, new.community_id, new.action, 'suppressed', v_state.reason);
          return new;
        exception when others then
          null;
        end;
      end if;
      -- Anything else (expired, too far ahead, malformed, or a non-suppressible
      -- action) falls through: the notification proceeds as normal.
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
    -- before_state. That is the WHOLE row (phone, attributes, ...): forward three
    -- fields and nothing else. The officer's free-text reason is never forwarded.
    if new.action = 'member.reject_join' and jsonb_typeof(new.before_state) = 'object' then
      v_before := new.before_state;
      v_name  := case when jsonb_typeof(v_before -> 'full_name') = 'string'
                      then left(v_before ->> 'full_name', 120) end;
      v_via   := case when jsonb_typeof(v_before -> 'joined_via') = 'string'
                      then left(v_before ->> 'joined_via', 40) end;
      -- Only an address the requester typed themselves, and only because the rejection notice (P4) needs it.
      v_email := case when v_via = 'invite_link' and jsonb_typeof(v_before -> 'email') = 'string'
                      then left(v_before ->> 'email', 254) end;
      v_msg := v_msg || jsonb_build_object(
        'before_state',
        jsonb_build_object('full_name', v_name, 'joined_via', v_via, 'email', v_email)
      );
    end if;

    perform pgmq.send('notification_events', v_msg);
    return new;
  exception when others then
    -- The audited write must succeed whatever happens here. `raise log` goes to the
    -- server log only (never to the client), and carries no data from the row.
    raise log 'notification enqueue failed (sqlstate %): the audited write was allowed to proceed', sqlstate;
    begin
      insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome)
      values (new.id, new.community_id, new.action, 'enqueue_failed');
    exception when others then
      null;  -- recording the failure must not itself become a failure
    end;
    return new;
  end;
end;
$$;

comment on function app.enqueue_notification_on_audit() is
  'M13.2 P3 (replaces 20261007110000): watches collection.publish, member.create / approve_join / reject_join / join_via_invite, officer_invitation.accept, officer_term.end. Ignores system actors on member.*. Narrow before_state for reject_join. Honours operator-only suppression (never for officer access changes). Never raises: a failure is absorbed so the audited write proceeds.';

revoke all on function app.enqueue_notification_on_audit() from public;
revoke execute on function app.enqueue_notification_on_audit() from public, anon, authenticated;
