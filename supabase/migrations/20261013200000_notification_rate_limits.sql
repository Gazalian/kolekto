-- ─────────────────────────────────────────────────────────────────────────────
-- 20261013200000 — Rate limits and deferred-backlog controls (M13.2 P5-2)
--
-- Decision record §10.6, §10.6.1.
--
-- What this does, and only this:
--
--   1. A rate-limit ledger table, notification_send_attempts: one row per
--      reservation made immediately before a provider send call. Append-only,
--      no client grants, RLS enabled and forced, rows purged after 48 hours.
--      The address_key is the lower-cased recipient email — a deliberate,
--      short-lived, inaccessible PII surface (risk U7).
--   2. app.notification_send_limits(): returns the configured L1 (3/address/
--      24 h), L2 (100/community/1 h), L3 (1,000/platform/1 h), backlog cap
--      (500), and max attempts (3). Changed only by a reviewed migration.
--   3. app.reserve_email_attempt(delivery_id): the concurrency-safe rate-
--      limit reservation. Called inside the transaction that claimed the
--      delivery (P5-1). Takes advisory locks in a fixed order (address,
--      community, platform) so concurrent workers cannot deadlock. Checks
--      L1, L2, L3, and the per-community backlog cap. Returns:
--        · granted — ledger row inserted, delivery stays in sending.
--        · address_limited — delivery skipped with recipient_rate_limited,
--          address erased, attempt undone.
--        · community_deferred — delivery returned to pending with
--          next_retry_at, attempt undone. Covers both L2 and L3 breaches.
--        · backlog_full — delivery skipped with community_backlog_full,
--          address erased, attempt undone.
--      Non-granted outcomes update the delivery row within the same
--      transaction before returning.
--   4. app.purge_stale_send_attempts(): deletes ledger rows older than 48
--      hours. Called by the sender loop or a scheduled task.
--
-- What this deliberately does NOT do (later phases):
--
--   · No sender loop, no provider call, no tick. The reserve function is
--     called by the sender (a later phase) inside the claim transaction.
--   · No pause switch, heartbeat, or health monitoring view. The monitoring
--     view (private.v_notification_send_health) is deferred to the sender
--     milestone that owns the heartbeat column.
--   · No 72-hour expiry housekeeping. Deferred deliveries live at most 72
--     hours and then become dead with event_too_old, handled by the sender's
--     expiry loop (a later phase).
--   · No held-queue interaction.
--   · No financial, payment, withdrawal, settlement, refund, authentication
--     or consent changes.
--
-- Privileges follow the P5-1 convention: SECURITY DEFINER with
-- SET search_path = '', EXECUTE revoked from public, anon and authenticated.
-- The sole caller is the notification worker over its owner connection.
--
-- Additive. No existing row is rewritten. Rollback: drop the four functions,
-- the three triggers, the three indexes, the deny policy, and the table.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Rate-limit ledger table ──────────────────────────────────────────────
create table public.notification_send_attempts (
  id            uuid        primary key default app.uuid_generate_v7(),
  delivery_id   uuid        not null references public.notification_deliveries(id),
  community_id  uuid        not null references public.communities(id),
  address_key   text        not null,
  attempted_at  timestamptz not null default now()
);

comment on table public.notification_send_attempts is
  'M13.2 P5-2: append-only rate-limit ledger. One row per reservation (attempt) made immediately before a provider send call. address_key is lower(recipient_address) for case-insensitive counting. Rows purged after 48 hours by app.purge_stale_send_attempts(). No client role has any access (risk U7: short-lived PII surface).';


-- ── 2. RLS ──────────────────────────────────────────────────────────────────
alter table public.notification_send_attempts enable row level security;
alter table public.notification_send_attempts force row level security;

create policy notification_send_attempts_deny_client_access
  on public.notification_send_attempts for select to authenticated
  using (false);

revoke all on table public.notification_send_attempts from public, anon, authenticated;


-- ── 3. Append-only enforcement ──────────────────────────────────────────────
-- The purge function signals via a session variable; the trigger allows
-- DELETE only when that variable is set (transaction-local, SECURITY DEFINER,
-- client roles have no DELETE privilege anyway).
create or replace function app.block_send_attempts_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('app.send_attempts_purging', true) = 'true' then
    return old;
  end if;

  raise exception
    'SEND_ATTEMPTS_IS_APPEND_ONLY: notification_send_attempts rows cannot be % (M13.2 P5-2)',
    lower(tg_op)
    using errcode = 'P0001';
  return null;
end;
$$;

revoke execute on function app.block_send_attempts_mutation() from public, anon, authenticated;

create trigger notification_send_attempts_no_update
  before update on public.notification_send_attempts
  for each row execute function app.block_send_attempts_mutation();
create trigger notification_send_attempts_no_delete
  before delete on public.notification_send_attempts
  for each row execute function app.block_send_attempts_mutation();
create trigger notification_send_attempts_no_truncate
  before truncate on public.notification_send_attempts
  for each statement execute function app.block_send_attempts_mutation();


-- ── 4. Indexes ──────────────────────────────────────────────────────────────
-- L1 lookup: count by address in the rolling 24-hour window.
create index notification_send_attempts_address_window_idx
  on public.notification_send_attempts (address_key, attempted_at);

-- L2 lookup: count by community in the rolling 1-hour window.
create index notification_send_attempts_community_window_idx
  on public.notification_send_attempts (community_id, attempted_at);

-- L3 lookup and purge: count platform-wide in the rolling 1-hour window;
-- also used by the 48-hour purge.
create index notification_send_attempts_platform_window_idx
  on public.notification_send_attempts (attempted_at);


-- ── 5. Configuration function ───────────────────────────────────────────────
create or replace function app.notification_send_limits()
returns table (
  l1_address      integer,
  l1_window_hours integer,
  l2_community    integer,
  l2_window_hours integer,
  l3_platform     integer,
  l3_window_hours integer,
  backlog_max     integer,
  max_attempts    integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select 3, 24, 100, 1, 1000, 1, 500, 3;
$$;

comment on function app.notification_send_limits() is
  'M13.2 P5-2: configured rate-limit and backlog values. Changed ONLY by a reviewed migration (create or replace), never at runtime or by ad-hoc SQL. Boundary tests read these values rather than hard-coding them, so a change that keeps the tests green is safe.';

revoke all on function app.notification_send_limits() from public;
revoke execute on function app.notification_send_limits() from anon, authenticated;


-- ── 6. Reserve email attempt ────────────────────────────────────────────────
create or replace function app.reserve_email_attempt(
  p_delivery_id uuid
)
returns table (
  reservation text,
  retry_at    timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery        public.notification_deliveries%rowtype;
  v_limits          record;
  v_address         text;
  v_address_count   bigint;
  v_community_count bigint;
  v_platform_count  bigint;
  v_deferred_count  bigint;
  v_oldest_at       timestamptz;
begin
  -- ── Precondition ─────────────────────────────────────────────────────
  -- The delivery must be in sending state (just claimed by the caller in
  -- the same transaction). The row lock is already held by the claim
  -- function (FOR UPDATE / FOR UPDATE SKIP LOCKED), so this read sees the
  -- uncommitted sending state within the same transaction.
  select * into v_delivery
  from public.notification_deliveries
  where id = p_delivery_id;

  if v_delivery.id is null or v_delivery.status <> 'sending' then
    raise exception
      'RESERVE_PRECONDITION: delivery % must be in sending state',
      p_delivery_id
      using errcode = 'P0001';
  end if;

  select * into v_limits from app.notification_send_limits();
  v_address := lower(v_delivery.recipient_address);

  -- ── Lock order: address, community, platform ─────────────────────────
  -- Always in this order, so two concurrent reservations cannot deadlock.
  -- A hash collision between two unrelated keys only serialises; it can
  -- never let one through.
  perform pg_advisory_xact_lock(1, hashtext(v_address));
  perform pg_advisory_xact_lock(2, hashtext(v_delivery.community_id::text));
  perform pg_advisory_xact_lock(3, 0);


  -- ── L1: per-address limit (rolling 24 h) ─────────────────────────────
  select count(*) into v_address_count
  from public.notification_send_attempts a
  where a.address_key = v_address
    and a.attempted_at > now() - make_interval(hours => v_limits.l1_window_hours);

  if v_address_count >= v_limits.l1_address then
    -- Terminal skip: mark skipped, erase address (the skipped-email
    -- constraint requires it), undo the attempt reserved by the claim.
    update public.notification_deliveries
    set status              = 'skipped',
        error_code          = 'recipient_rate_limited',
        recipient_address   = null,
        recipient_address_assurance = null,
        send_lease_token    = null,
        send_lease_expires_at = null,
        attempt_count       = v_delivery.attempt_count - 1
    where id = p_delivery_id;

    reservation := 'address_limited';
    retry_at    := null;
    return next; return;
  end if;


  -- ── L2: per-community limit (rolling 1 h) ────────────────────────────
  select count(*) into v_community_count
  from public.notification_send_attempts a
  where a.community_id = v_delivery.community_id
    and a.attempted_at > now() - make_interval(hours => v_limits.l2_window_hours);

  if v_community_count >= v_limits.l2_community then
    -- Check the per-community backlog cap before deferring.
    select count(*) into v_deferred_count
    from public.notification_deliveries d
    where d.community_id = v_delivery.community_id
      and d.channel = 'email'
      and d.status  = 'pending'
      and d.next_retry_at is not null;

    if v_deferred_count >= v_limits.backlog_max then
      update public.notification_deliveries
      set status              = 'skipped',
          error_code          = 'community_backlog_full',
          recipient_address   = null,
          recipient_address_assurance = null,
          send_lease_token    = null,
          send_lease_expires_at = null,
          attempt_count       = v_delivery.attempt_count - 1
      where id = p_delivery_id;

      reservation := 'backlog_full';
      retry_at    := null;
      return next; return;
    end if;

    -- Defer: set next_retry_at to when the oldest counted reservation
    -- leaves the binding window, so the delivery becomes claimable then.
    select min(a.attempted_at) + make_interval(hours => v_limits.l2_window_hours)
    into v_oldest_at
    from public.notification_send_attempts a
    where a.community_id = v_delivery.community_id
      and a.attempted_at > now() - make_interval(hours => v_limits.l2_window_hours);

    update public.notification_deliveries
    set status              = 'pending',
        next_retry_at       = v_oldest_at,
        send_lease_token    = null,
        send_lease_expires_at = null,
        attempt_count       = v_delivery.attempt_count - 1
    where id = p_delivery_id;

    reservation := 'community_deferred';
    retry_at    := v_oldest_at;
    return next; return;
  end if;


  -- ── L3: platform-wide limit (rolling 1 h) ────────────────────────────
  select count(*) into v_platform_count
  from public.notification_send_attempts a
  where a.attempted_at > now() - make_interval(hours => v_limits.l3_window_hours);

  if v_platform_count >= v_limits.l3_platform then
    -- Same backlog cap check (per-community, not platform-wide).
    select count(*) into v_deferred_count
    from public.notification_deliveries d
    where d.community_id = v_delivery.community_id
      and d.channel = 'email'
      and d.status  = 'pending'
      and d.next_retry_at is not null;

    if v_deferred_count >= v_limits.backlog_max then
      update public.notification_deliveries
      set status              = 'skipped',
          error_code          = 'community_backlog_full',
          recipient_address   = null,
          recipient_address_assurance = null,
          send_lease_token    = null,
          send_lease_expires_at = null,
          attempt_count       = v_delivery.attempt_count - 1
      where id = p_delivery_id;

      reservation := 'backlog_full';
      retry_at    := null;
      return next; return;
    end if;

    select min(a.attempted_at) + make_interval(hours => v_limits.l3_window_hours)
    into v_oldest_at
    from public.notification_send_attempts a
    where a.attempted_at > now() - make_interval(hours => v_limits.l3_window_hours);

    update public.notification_deliveries
    set status              = 'pending',
        next_retry_at       = v_oldest_at,
        send_lease_token    = null,
        send_lease_expires_at = null,
        attempt_count       = v_delivery.attempt_count - 1
    where id = p_delivery_id;

    reservation := 'community_deferred';
    retry_at    := v_oldest_at;
    return next; return;
  end if;


  -- ── All limits OK: insert ledger row ──────────────────────────────────
  -- The count and the insert both happen while the advisory locks are held
  -- (they are transaction-scoped), so two sessions can never both see
  -- "2 of 3 used" and both proceed.
  insert into public.notification_send_attempts
    (delivery_id, community_id, address_key)
  values
    (p_delivery_id, v_delivery.community_id, v_address);

  reservation := 'granted';
  retry_at    := null;
  return next; return;
end;
$$;

comment on function app.reserve_email_attempt(uuid) is
  'M13.2 P5-2: concurrency-safe rate-limit reservation. Called inside the transaction that claimed the delivery (P5-1 claim function, row already locked). Checks L1 (per-address/24 h), L2 (per-community/1 h), L3 (platform/1 h) and the per-community backlog cap. Advisory locks in a fixed order (address, community, platform) prevent concurrent bypass and deadlock. Returns granted (ledger row inserted, delivery stays sending), address_limited (skipped/recipient_rate_limited), community_deferred (deferred with retry_at), or backlog_full (skipped/community_backlog_full). Operator/worker only; no client role may execute it.';

revoke all on function app.reserve_email_attempt(uuid) from public;
revoke execute on function app.reserve_email_attempt(uuid) from anon, authenticated;


-- ── 7. Purge stale ledger rows ──────────────────────────────────────────────
create or replace function app.purge_stale_send_attempts()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
begin
  -- Signal the append-only trigger to allow this DELETE.
  perform set_config('app.send_attempts_purging', 'true', true);

  delete from public.notification_send_attempts
  where attempted_at < now() - interval '48 hours';

  get diagnostics v_deleted = row_count;

  perform set_config('app.send_attempts_purging', 'false', true);

  return v_deleted;
end;
$$;

comment on function app.purge_stale_send_attempts() is
  'M13.2 P5-2: delete ledger rows older than 48 hours. Called by the sender loop or a scheduled task. Uses a transaction-local session variable to bypass the append-only trigger. Client roles have no DELETE privilege, so the variable cannot be exploited. Operator/worker only.';

revoke all on function app.purge_stale_send_attempts() from public;
revoke execute on function app.purge_stale_send_attempts() from anon, authenticated;
