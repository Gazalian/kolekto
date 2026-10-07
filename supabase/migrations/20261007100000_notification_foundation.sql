-- ─────────────────────────────────────────────────────────────────────────────
-- 20261007100000 — Notification foundation (M13.1)
--
-- The communication layer of Kolekto's financial operating system. This
-- migration creates the event-driven notification infrastructure: tables,
-- enums, RLS, indexes, SECURITY DEFINER functions, the pgmq queue, and the
-- audit log trigger that feeds it.
--
-- Architecture (docs/product/M13-NOTIFICATION-COMMUNICATION-AUDIT.md):
--
--   Domain action (collection.publish, member.approve, …)
--     → app.write_audit_log()  [already happens, no changes needed]
--       → INSERT on audit_logs
--         → AFTER INSERT trigger: app.enqueue_notification_on_audit()
--           → pgmq.send('notification_events', …)
--             → apps/worker consumes, resolves recipients, writes deliveries
--
-- Zero modifications to existing domain functions. The audit log is the
-- event bus, and a trigger on INSERT is the subscription.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Enums ───────────────────────────────────────────────────────────────────

create type public.notification_channel as enum (
  'in_app',
  'email',
  'whatsapp',
  'sms'
);

create type public.notification_delivery_status as enum (
  'pending',
  'sent',
  'delivered',
  'failed',
  'skipped'
);


-- ── notification_events ─────────────────────────────────────────────────────
-- One row per domain event that warrants notification. Append-only.
-- The event_key column is the idempotency gate (D-25 pattern from
-- financial_idempotency): a duplicate INSERT silently does nothing.

create table public.notification_events (
  id              uuid primary key default app.uuid_generate_v7(),
  community_id    uuid not null references public.communities (id) on delete restrict,

  event_type      text not null,
  event_key       text not null,

  actor_type      public.audit_actor_type not null,
  actor_user_id   uuid references public.users (id) on delete set null,
  object_type     text not null,
  object_id       uuid not null,

  payload         jsonb not null default '{}',

  created_at      timestamptz not null default now(),

  constraint notification_events_event_key_unique unique (event_key),
  constraint notification_events_event_type_format check (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  constraint notification_events_object_type_format check (object_type ~ '^[a-z_]+$')
);

comment on table public.notification_events is
  'M13.1: append-only log of domain events that warrant notification. One row per event. The event_key column prevents duplicate processing (D-25 pattern).';

create index notification_events_community_created_idx
  on public.notification_events (community_id, created_at desc);
create index notification_events_type_idx
  on public.notification_events (event_type, created_at desc);

alter table public.notification_events enable row level security;
alter table public.notification_events force row level security;


-- ── notification_deliveries ─────────────────────────────────────────────────
-- One row per (event × recipient × channel). Tracks delivery state.

create table public.notification_deliveries (
  id                    uuid primary key default app.uuid_generate_v7(),
  notification_event_id uuid not null references public.notification_events (id) on delete restrict,
  community_id          uuid not null references public.communities (id) on delete restrict,

  recipient_member_id   uuid references public.members (id) on delete set null,
  recipient_user_id     uuid references public.users (id) on delete set null,
  recipient_address     text,

  channel               public.notification_channel not null,
  status                public.notification_delivery_status not null default 'pending',

  read_at               timestamptz,

  provider_message_id   text,
  error_code            text,
  error_message         text,

  attempt_count         integer not null default 0,
  last_attempted_at     timestamptz,
  next_retry_at         timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint notification_deliveries_attempt_count_positive
    check (attempt_count >= 0),
  constraint notification_deliveries_sent_has_no_error
    check (status <> 'sent' or (error_code is null and error_message is null)),
  constraint notification_deliveries_failed_has_reason
    check (status <> 'failed' or error_message is not null),
  constraint notification_deliveries_in_app_has_user
    check (channel <> 'in_app' or recipient_user_id is not null)
);

comment on table public.notification_deliveries is
  'M13.1: one row per (event × recipient × channel). Mutable: status transitions from pending→sent→delivered, or pending→failed→retry. read_at tracks in-app read state.';

create unique index notification_deliveries_event_recipient_channel_key
  on public.notification_deliveries (
    notification_event_id,
    coalesce(recipient_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
    channel
  );

create index notification_deliveries_inbox_idx
  on public.notification_deliveries (recipient_user_id, read_at nulls first, created_at desc)
  where channel = 'in_app';

create index notification_deliveries_retry_idx
  on public.notification_deliveries (next_retry_at)
  where status in ('pending', 'failed') and next_retry_at is not null;

alter table public.notification_deliveries enable row level security;
alter table public.notification_deliveries force row level security;

create trigger notification_deliveries_set_updated_at
  before update on public.notification_deliveries
  for each row execute function app.set_updated_at();


-- ── notification_preferences ────────────────────────────────────────────────
-- Per-member, per-community preferences. Absence = use defaults.
-- M13.1 creates the table; the preferences UI arrives in M13.4.

create table public.notification_preferences (
  id              uuid primary key default gen_random_uuid(),
  community_id    uuid not null references public.communities (id) on delete cascade,
  member_id       uuid not null references public.members (id) on delete cascade,

  email_enabled   boolean,
  whatsapp_enabled boolean,
  sms_enabled     boolean,

  announcements_enabled          boolean,
  reminders_enabled              boolean,
  collection_updates_enabled     boolean,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint notification_preferences_member_community_key
    unique (community_id, member_id)
);

comment on table public.notification_preferences is
  'M13.1: per-member, per-community notification preferences. NULL = use default (ON for all except SMS). in_app is always on, not configurable.';

alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force row level security;

create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function app.set_updated_at();


-- ── Append-only enforcement on notification_events ──────────────────────────
-- Same pattern as audit_logs (DAT-02): trigger + privilege revocation.

create or replace function app.block_notification_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'NOTIFICATION_EVENT_IS_APPEND_ONLY: notification event rows cannot be % (M13.1)',
    lower(tg_op)
    using errcode = 'P0001',
          hint = 'A correction is a new event, never an edit to the original.';
  return null;
end;
$$;

create trigger notification_events_no_update
  before update on public.notification_events
  for each row execute function app.block_notification_event_mutation();

create trigger notification_events_no_delete
  before delete on public.notification_events
  for each row execute function app.block_notification_event_mutation();

revoke update, delete, truncate on public.notification_events from authenticated, anon;
revoke execute on function app.block_notification_event_mutation() from public, anon, authenticated;


-- ── RLS policies ────────────────────────────────────────────────────────────

-- notification_events: officers can read their community's events
create policy notification_events_select_officer
  on public.notification_events for select to authenticated
  using (
    community_id in (
      select ot.community_id from public.officer_terms ot
      where ot.user_id = auth.uid() and ot.ended_at is null
    )
  );

-- notification_deliveries: users can read their own in-app deliveries
create policy notification_deliveries_select_own_inbox
  on public.notification_deliveries for select to authenticated
  using (
    recipient_user_id = auth.uid()
    and channel = 'in_app'
  );

-- notification_deliveries: officers can read their community's deliveries
create policy notification_deliveries_select_officer
  on public.notification_deliveries for select to authenticated
  using (
    community_id in (
      select ot.community_id from public.officer_terms ot
      where ot.user_id = auth.uid() and ot.ended_at is null
    )
  );

-- notification_preferences: members can read their own
create policy notification_preferences_select_own
  on public.notification_preferences for select to authenticated
  using (
    member_id in (
      select m.id from public.members m
      where m.user_id = auth.uid()
    )
  );


-- ── pgmq queue ──────────────────────────────────────────────────────────────

select pgmq.create('notification_events');


-- ── SECURITY DEFINER functions ──────────────────────────────────────────────

-- Mark a single notification as read. The recipient must be the caller.
create or replace function app.mark_notification_read(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery public.notification_deliveries%rowtype;
begin
  select * into v_delivery
  from public.notification_deliveries
  where id = p_delivery_id;

  if v_delivery.id is null then
    raise exception 'NOT_FOUND: notification delivery % does not exist', p_delivery_id
      using errcode = 'P0002';
  end if;

  if v_delivery.channel <> 'in_app' then
    raise exception 'INVALID_CHANNEL: only in-app notifications can be marked as read'
      using errcode = 'P0001';
  end if;

  if v_delivery.recipient_user_id is null or v_delivery.recipient_user_id <> auth.uid() then
    raise exception 'FORBIDDEN: cannot mark another user''s notification as read'
      using errcode = 'P0001';
  end if;

  if v_delivery.read_at is not null then
    return;
  end if;

  update public.notification_deliveries
  set read_at = now()
  where id = p_delivery_id;
end;
$$;

comment on function app.mark_notification_read(uuid) is
  'M13.1: marks a single in-app notification as read. Enforces recipient ownership — a user can only mark their own notifications.';

revoke all on function app.mark_notification_read(uuid) from public;
grant execute on function app.mark_notification_read(uuid) to authenticated;


-- Mark all unread in-app notifications as read for the caller.
create or replace function app.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.notification_deliveries
  set read_at = now()
  where recipient_user_id = auth.uid()
    and channel = 'in_app'
    and read_at is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.mark_all_notifications_read() is
  'M13.1: marks all unread in-app notifications as read for the current user.';

revoke all on function app.mark_all_notifications_read() from public;
grant execute on function app.mark_all_notifications_read() to authenticated;


-- ── The audit log trigger (the event source) ────────────────────────────────
-- This is the core architectural decision: existing domain functions already
-- write audit_logs. This trigger watches those INSERTs and enqueues
-- notification-worthy events to pgmq. Zero modifications to domain functions.

create or replace function app.enqueue_notification_on_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.community_id is null then
    return new;
  end if;

  if new.action in (
    'collection.publish',
    'member.approve',
    'invite_link.redeem'
  ) then
    perform pgmq.send(
      'notification_events',
      jsonb_build_object(
        'audit_log_id', new.id,
        'community_id', new.community_id,
        'action', new.action,
        'actor_type', new.actor_type::text,
        'actor_user_id', new.actor_user_id,
        'actor_name', new.actor_name_snapshot,
        'object_type', new.object_type,
        'object_id', new.object_id,
        'after_state', new.after_state,
        'created_at', new.created_at
      )
    );
  end if;

  return new;
end;
$$;

comment on function app.enqueue_notification_on_audit() is
  'M13.1: watches audit_logs INSERTs and enqueues notification-worthy events to the pgmq notification_events queue. Adding a new event type = adding one string to the IN (...) list.';

revoke execute on function app.enqueue_notification_on_audit() from public, anon, authenticated;

create trigger audit_log_notification_enqueue
  after insert on public.audit_logs
  for each row execute function app.enqueue_notification_on_audit();


-- ── Grants ──────────────────────────────────────────────────────────────────
-- Following the pattern from 20260917121100_grants.sql: authenticated gets
-- SELECT on the allowlist, nothing else. Writes go through SECURITY DEFINER
-- functions.

grant select on table public.notification_events      to authenticated;
grant select on table public.notification_deliveries   to authenticated;
grant select on table public.notification_preferences  to authenticated;
