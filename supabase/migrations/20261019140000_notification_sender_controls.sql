-- ─────────────────────────────────────────────────────────────────────────────
-- 20261019140000 — Sender controls: pause switch, 72-hour expiry, health view
--                  (M13.2 P5 / P5-5)
--
-- Decision record §10.6.1 (pause switch, bounded life, monitoring) and §10.4
-- (72-hour life, dead letters). Completes the three pieces the P5-1 and P5-2
-- migrations (20261013100000, 20261013200000) deferred to the sender milestone:
--
--   1. public.notification_sender_state — a single operational row holding the
--      email_sending_enabled pause switch (FALSE by default in every
--      environment: §10.6.1 makes pausing, not editing a limit, the emergency
--      control) and the sender's heartbeat (last_heartbeat_at) and last-claim
--      time (last_claim_at, the §10.6.1 heartbeat signal). Operational data,
--      so RLS enabled and forced, no client grant (ADR 0009), mirroring
--      notification_send_attempts.
--   2. app.email_sending_enabled() / app.set_email_sending_enabled(boolean):
--      read and flip the switch. The setter is the emergency control; it is an
--      operator/owner call, never reachable by a client role.
--   3. app.record_sender_heartbeat(boolean): the sender stamps its heartbeat
--      each tick, and its last-claim time when it claimed a row.
--   4. app.expire_stale_notification_deliveries(max_age_hours): turns a pending
--      email delivery older than its 72-hour life into dead / event_too_old.
--      Locks each due row FOR UPDATE SKIP LOCKED and re-checks status = pending
--      under the lock, so it can never race a concurrent claim into an invalid
--      transition: a row a worker holds is skipped, and a row already sending
--      is never touched. Runs whether or not sending is paused — ageing out is
--      the one maintenance action the pause switch must not stop (§10.6.1).
--   5. app.notification_send_health() + private.v_notification_send_health:
--      the single-sourced operational snapshot §10.6.1 asks for (queue depth,
--      oldest pending, deferred backlog and its oldest, L2/L3 utilisation,
--      sent/dead/skipped in the last 24h BY CODE, expired leases, the pause
--      state and the heartbeat). No addresses, names or error text — only
--      stable error codes and counts. The worker logs the same numbers once a
--      minute. The view is in the private schema (not exposed via PostgREST,
--      revoked from every client role); it is read over the owner connection.
--
-- What this deliberately does NOT do: no provider call, no sender loop (that is
-- the worker, apps/worker/src/notification-sender.ts), no AWS SES, no template
-- rendering, no held-queue interaction, and no financial, payment, withdrawal,
-- settlement, auth or consent change.
--
-- Privileges follow the P5 convention: SECURITY DEFINER with SET search_path =
-- '', EXECUTE revoked from public, anon and authenticated. The sole caller is
-- the notification worker over its owner connection.
--
-- Additive. The only row written is the seeded pause-switch row (disabled). No
-- existing row is rewritten. Rollback: drop the view, the five functions and
-- the table.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Sender-state table (single row) ───────────────────────────────────────
-- The boolean primary key with a CHECK pins the table to exactly one row: a
-- second insert collides on the key, and id can only ever be true.
create table public.notification_sender_state (
  id                    boolean     primary key default true,
  email_sending_enabled boolean     not null default false,
  last_heartbeat_at     timestamptz,
  last_claim_at         timestamptz,
  updated_at            timestamptz not null default now(),
  constraint notification_sender_state_singleton check (id)
);

comment on table public.notification_sender_state is
  'M13.2 P5-5: single operational row. email_sending_enabled is the pause switch (FALSE by default in every environment until a provider is approved; §10.6.1 emergency control). last_heartbeat_at and last_claim_at are the sender heartbeat (§10.6.1). Operational data: no client role has any access (ADR 0009). Written only by the worker over its owner connection.';

create trigger notification_sender_state_set_updated_at
  before update on public.notification_sender_state
  for each row execute function app.set_updated_at();


-- ── 2. RLS: operational data, no client access ───────────────────────────────
-- Mirrors notification_send_attempts (20261013200000): enabled and forced, a
-- deny-select policy for authenticated, and every grant revoked. The worker's
-- owner connection bypasses RLS; no client role can read the pause state.
alter table public.notification_sender_state enable row level security;
alter table public.notification_sender_state force row level security;

create policy notification_sender_state_deny_client_access
  on public.notification_sender_state for select to authenticated
  using (false);

revoke all on table public.notification_sender_state from public, anon, authenticated;


-- ── 3. Seed the single row, disabled ─────────────────────────────────────────
insert into public.notification_sender_state (id, email_sending_enabled)
values (true, false)
on conflict (id) do nothing;


-- ── 4. Read / flip the pause switch ──────────────────────────────────────────
create or replace function app.email_sending_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select email_sending_enabled from public.notification_sender_state where id),
    false
  );
$$;

comment on function app.email_sending_enabled() is
  'M13.2 P5-5: current pause switch. TRUE only when an operator has enabled email sending (local/CI with the fake or Mailpit adapter until P9). FALSE when the row is missing, so a half-applied state fails closed. Operator/worker only; no client role may execute it.';

revoke all on function app.email_sending_enabled() from public;
revoke execute on function app.email_sending_enabled() from anon, authenticated;


create or replace function app.set_email_sending_enabled(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_enabled is null then
    raise exception 'SET_EMAIL_SENDING_ENABLED: value must be true or false, not null'
      using errcode = '22023';
  end if;

  insert into public.notification_sender_state (id, email_sending_enabled)
  values (true, p_enabled)
  on conflict (id) do update set email_sending_enabled = excluded.email_sending_enabled;

  return p_enabled;
end;
$$;

comment on function app.set_email_sending_enabled(boolean) is
  'M13.2 P5-5: the emergency pause control (§10.6.1). Flips email_sending_enabled; pausing stops the sender claiming anything while queued rows wait and age out at 72 hours, losing nothing early. Operator/worker only; no client role may execute it.';

revoke all on function app.set_email_sending_enabled(boolean) from public;
revoke execute on function app.set_email_sending_enabled(boolean) from anon, authenticated;


-- ── 5. Heartbeat ─────────────────────────────────────────────────────────────
create or replace function app.record_sender_heartbeat(p_claimed boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notification_sender_state (id, last_heartbeat_at, last_claim_at)
  values (
    true,
    now(),
    case when coalesce(p_claimed, false) then now() else null end
  )
  on conflict (id) do update
    set last_heartbeat_at = now(),
        last_claim_at = case when coalesce(p_claimed, false) then now()
                             else public.notification_sender_state.last_claim_at end;
end;
$$;

comment on function app.record_sender_heartbeat(boolean) is
  'M13.2 P5-5: the sender stamps its heartbeat each tick. last_claim_at advances only on a tick that claimed a row, so a long idle period is visible as a fresh heartbeat with a stale last_claim_at. Operator/worker only; no client role may execute it.';

revoke all on function app.record_sender_heartbeat(boolean) from public;
revoke execute on function app.record_sender_heartbeat(boolean) from anon, authenticated;


-- ── 6. 72-hour expiry (race-safe with concurrent claims) ─────────────────────
create or replace function app.expire_stale_notification_deliveries(
  p_max_age_hours integer default 72
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hours   integer;
  v_expired bigint;
begin
  -- At least one hour, 72 by contract. The parameter exists so tests can
  -- choose an age; it cannot select a zero/negative threshold that would
  -- expire live rows.
  v_hours := greatest(1, coalesce(p_max_age_hours, 72));

  -- Lock each due pending email row with SKIP LOCKED and re-check status =
  -- pending in the same statement. A row a worker is claiming (holding its
  -- FOR UPDATE lock) is skipped, not waited on; a row already sending is not
  -- selected at all. So expiry and a claim can never both act on one row, and
  -- no sending/sent/dead row is ever forced to dead by age.
  with due as (
    select d.id
    from public.notification_deliveries d
    where d.channel = 'email'
      and d.status = 'pending'
      and d.created_at < now() - make_interval(hours => v_hours)
    order by d.created_at
    for update skip locked
  )
  update public.notification_deliveries d
  set status = 'dead',
      error_code = 'event_too_old',
      -- A pending row holds no lease; clearing is belt-and-braces so the
      -- lease-only-when-sending constraint can never be tripped.
      send_lease_token = null,
      send_lease_expires_at = null
  from due
  where d.id = due.id;

  get diagnostics v_expired = row_count;
  return v_expired;
end;
$$;

comment on function app.expire_stale_notification_deliveries(integer) is
  'M13.2 P5-5: turn pending email deliveries older than their 72-hour life into dead / event_too_old. FOR UPDATE SKIP LOCKED plus a status re-check make it race-safe against a concurrent claim (a held row is skipped, a sending row is never selected). Runs whether or not sending is paused. Returns the number of rows expired. Operator/worker only; no client role may execute it.';

revoke all on function app.expire_stale_notification_deliveries(integer) from public;
revoke execute on function app.expire_stale_notification_deliveries(integer) from anon, authenticated;


-- ── 7. Health snapshot (single source of truth) ──────────────────────────────
create or replace function app.notification_send_health()
returns table (
  email_sending_enabled    boolean,
  last_heartbeat_at        timestamptz,
  last_claim_at            timestamptz,
  pending_total            bigint,
  pending_due              bigint,
  oldest_pending_age_s     bigint,
  deferred_backlog         bigint,
  oldest_deferred_age_s    bigint,
  sending_count            bigint,
  expired_lease_count      bigint,
  l2_busiest_last_hour     bigint,
  l2_utilisation_pct       numeric,   -- invariant-allow: a utilisation percentage, not a money column
  l3_last_hour             bigint,
  l3_utilisation_pct       numeric,   -- invariant-allow: a utilisation percentage, not a money column
  sent_24h                 bigint,
  dead_24h                 bigint,
  skipped_24h              bigint,
  dead_by_code             jsonb,
  skipped_by_code          jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limits record;
  v_state  record;
begin
  select * into v_limits from app.notification_send_limits();
  select s.email_sending_enabled, s.last_heartbeat_at, s.last_claim_at
    into v_state
  from public.notification_sender_state s
  where s.id;

  email_sending_enabled := coalesce(v_state.email_sending_enabled, false);
  last_heartbeat_at      := v_state.last_heartbeat_at;
  last_claim_at          := v_state.last_claim_at;

  -- Queue depth: all pending email rows, and the subset claimable right now.
  select
    count(*),
    count(*) filter (
      where d.attempt_count < v_limits.max_attempts
        and (d.next_retry_at is null or d.next_retry_at <= now())
    ),
    coalesce(extract(epoch from (now() - min(d.created_at)))::bigint, 0)
  into pending_total, pending_due, oldest_pending_age_s
  from public.notification_deliveries d
  where d.channel = 'email' and d.status = 'pending';

  -- Deferred backlog: pending rows carrying a next_retry_at (matches the cap
  -- counted by app.reserve_email_attempt), and the age of the oldest.
  select
    count(*),
    coalesce(extract(epoch from (now() - min(d.created_at)))::bigint, 0)
  into deferred_backlog, oldest_deferred_age_s
  from public.notification_deliveries d
  where d.channel = 'email' and d.status = 'pending' and d.next_retry_at is not null;

  -- In flight, and the subset whose lease has lapsed (recoverable).
  select
    count(*),
    count(*) filter (where d.send_lease_expires_at is not null and d.send_lease_expires_at <= now())
  into sending_count, expired_lease_count
  from public.notification_deliveries d
  where d.channel = 'email' and d.status = 'sending';

  -- L3: platform reservations in the rolling window. L2: the busiest single
  -- community in the rolling window. Utilisation as a percentage of the cap.
  select count(*) into l3_last_hour
  from public.notification_send_attempts a
  where a.attempted_at > now() - make_interval(hours => v_limits.l3_window_hours);

  select coalesce(max(c), 0) into l2_busiest_last_hour
  from (
    select count(*) c
    from public.notification_send_attempts a
    where a.attempted_at > now() - make_interval(hours => v_limits.l2_window_hours)
    group by a.community_id
  ) t;

  l3_utilisation_pct := round(100.0 * l3_last_hour / nullif(v_limits.l3_platform, 0), 1);
  l2_utilisation_pct := round(100.0 * l2_busiest_last_hour / nullif(v_limits.l2_community, 0), 1);

  -- Terminal outcomes in the last 24 hours, counted and broken down by stable
  -- code. updated_at is when the row reached its terminal state.
  select
    count(*) filter (where d.status = 'sent'),
    count(*) filter (where d.status = 'dead'),
    count(*) filter (where d.status = 'skipped')
  into sent_24h, dead_24h, skipped_24h
  from public.notification_deliveries d
  where d.channel = 'email'
    and d.status in ('sent', 'dead', 'skipped')
    and d.updated_at > now() - interval '24 hours';

  select coalesce(jsonb_object_agg(code, c), '{}'::jsonb) into dead_by_code
  from (
    select d.error_code as code, count(*) c
    from public.notification_deliveries d
    where d.channel = 'email' and d.status = 'dead'
      and d.updated_at > now() - interval '24 hours'
    group by d.error_code
  ) t;

  select coalesce(jsonb_object_agg(code, c), '{}'::jsonb) into skipped_by_code
  from (
    select d.error_code as code, count(*) c
    from public.notification_deliveries d
    where d.channel = 'email' and d.status = 'skipped'
      and d.updated_at > now() - interval '24 hours'
    group by d.error_code
  ) t;

  return next;
end;
$$;

comment on function app.notification_send_health() is
  'M13.2 P5-5: single-sourced operational snapshot (§10.6.1). Queue depth, oldest pending, deferred backlog and its oldest, in-flight and expired-lease counts, L2/L3 utilisation, terminal outcomes in the last 24h by stable code, the pause state and the heartbeat. Only counts, codes and timestamps — never an address, name or provider error text. The view private.v_notification_send_health selects from it; the worker logs the same numbers once a minute. Operator/worker only; no client role may execute it.';

revoke all on function app.notification_send_health() from public;
revoke execute on function app.notification_send_health() from anon, authenticated;


-- ── 8. Staff-only health view ────────────────────────────────────────────────
create or replace view private.v_notification_send_health as
  select * from app.notification_send_health();

comment on view private.v_notification_send_health is
  'M13.2 P5-5: staff-only send-health view (ADR 0009: operational data is not client-readable). Not exposed via PostgREST; read over the owner connection only. Carries no address, name or error text.';

revoke all on private.v_notification_send_health from public, anon, authenticated;
