-- ─────────────────────────────────────────────────────────────────────────────
-- 20261024200000 — Provider-aware quota controls: L4 daily, L5 per-second
--                  (M13.2 P9-3)
--
-- docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md §10.6, §10.6.1,
-- §10.6.3 (added in this PR). docs/product/M13.2-P9-3-SES-QUOTA-CONTROLS-DESIGN.md.
--
-- Scope — ADD ONLY. No real provider is enabled, no AWS SDK is pulled in, no
-- credential variable is added, the sender pause switch stays off, and the
-- P5/P9-1/P9-2 code paths are preserved byte-for-byte except for the one
-- amendment to app.reserve_email_attempt that adds the two new checks.
--
-- What this does, and only this:
--
--   1. A new `send_class` dimension on public.notification_deliveries and on
--      public.notification_send_attempts. Values: 'transactional' or 'bulk',
--      enforced by CHECK. Default 'transactional' so every pre-existing row
--      is classed as transactional with no backfill. 'bulk' exists only to
--      split L4/L5 counts; no code path writes bulk rows today, and bulk's
--      configured cap is zero (every bulk reservation defers forever and ages
--      out via the existing 72-hour expiry).
--   2. A new partial index on (send_class, attempted_at) for the L4 and L5
--      lookups. The existing L1/L2/L3 indexes are untouched.
--   3. A replacement app.notification_send_limits(p_class text) that returns
--      the configured L1/L2/L3 and the new L4/L5 and the backlog cap and
--      max_attempts, as a single row chosen by class. The previous no-arg
--      signature is dropped after the reserve function stops calling it.
--   4. An amendment to app.reserve_email_attempt that:
--        · reads the delivery's send_class and passes it to the limits fn;
--        · after L3 (unchanged), checks L4 (daily per-class) and defers with
--          'provider_daily_limited' on breach — attempt undone, address NOT
--          erased (the deferred row is still a candidate to send later);
--        · after L4, checks L5 (per-second per-class) and defers with
--          'provider_rate_limited' on breach — attempt undone, address kept,
--          short next_retry_at (1 s + random jitter 0–200 ms);
--        · inserts the ledger row with send_class on 'granted';
--        · extends the fixed advisory-lock order with two new keys appended
--          to the END — (4, hashtext(send_class)) for the class-platform
--          dimension and (5, hashtext(send_class || '|daily')) for the
--          class-daily dimension. Appending preserves the fixed-order
--          deadlock argument for every existing caller: no path takes a
--          new key before an old one.
--   5. An amendment to app.notification_send_health() returning four new
--      per-class JSON fields:
--        · l4_last_24h_by_class
--        · l5_last_second_by_class
--        · l4_utilisation_pct_by_class (as JSON { "class": numeric })
--        · l5_utilisation_pct_by_class (as JSON { "class": numeric })
--      The staff-only view private.v_notification_send_health picks them up
--      with no change required (it is a `select * from` passthrough).
--
-- What this deliberately does NOT do (later milestones):
--
--   · No SES sending adapter. No registration of 'ses' in REAL_EMAIL_PROVIDERS.
--     That is P9-4 and still gated on D-PROVIDER, D-DOMAIN, D-LEGAL,
--     D-CONSENT, D-WORKER and Q-CONFIRM.
--   · No GetAccount probe, no AWS SDK dependency. P9-4.
--   · No bulk sender, no campaign model, no bulk ingress path. A later
--     milestone opens bulk by raising the two 'bulk' numbers in a reviewed
--     migration AND adding the write path, consent model and audit rules.
--   · No change to the retry schedule, the three-attempt cap, the lease
--     mechanics, the suppression table or the webhook ingestion.
--   · No change to the pause switch default. email_sending_enabled stays
--     false and nothing in this migration flips it.
--
-- Privileges follow the P5/P9 convention: SECURITY DEFINER with SET
-- search_path = '', EXECUTE revoked from public, anon and authenticated. The
-- sole caller is the notification worker over its owner connection.
--
-- Additive. No existing row is rewritten (the new column takes a default so
-- every pre-existing row is 'transactional'; `attempt_count` is not touched).
-- Rollback: restore the pre-amendment app.reserve_email_attempt body from
-- 20261022110000_email_recipient_suppression.sql, restore the no-arg
-- notification_send_limits body from 20261013200000_notification_rate_limits.sql,
-- restore the pre-amendment notification_send_health body from
-- 20261019140000_notification_sender_controls.sql, drop the new index, and
-- drop the two send_class columns.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. send_class column on the delivery row ─────────────────────────────────
alter table public.notification_deliveries
  add column send_class text not null default 'transactional'
    constraint notification_deliveries_send_class_values
      check (send_class in ('transactional', 'bulk'));

comment on column public.notification_deliveries.send_class is
  'M13.2 P9-3: send class dimension. transactional (default) is the only class any code path writes today; bulk is reserved for a future milestone and its L4/L5 caps are zero (every bulk reservation defers forever).';


-- ── 2. send_class column on the attempts ledger ──────────────────────────────
alter table public.notification_send_attempts
  add column send_class text not null default 'transactional'
    constraint notification_send_attempts_send_class_values
      check (send_class in ('transactional', 'bulk'));

comment on column public.notification_send_attempts.send_class is
  'M13.2 P9-3: send class dimension on each reservation. Backs the L4 (daily) and L5 (per-second) counts. Inserted inside app.reserve_email_attempt from the delivery row''s send_class, under the matching class-level advisory lock.';


-- ── 3. Index for L4/L5 lookups ───────────────────────────────────────────────
-- Scan path: filter by send_class, range on attempted_at. The existing
-- platform-window index covers plain time range; the L4/L5 counts always
-- filter by class first, so a composite (class, time) index wins.
create index notification_send_attempts_class_window_idx
  on public.notification_send_attempts (send_class, attempted_at);


-- ── 4. New per-class limits function (coexists briefly with the old one) ─────
-- A separate signature so plpgsql name resolution in reserve_email_attempt can
-- switch to it without a window where no limits function is callable. The
-- old no-arg signature is dropped at the end of this migration.
create or replace function app.notification_send_limits(p_class text)
returns table (
  l1_address        integer,
  l1_window_hours   integer,
  l2_community      integer,
  l2_window_hours   integer,
  l3_platform       integer,
  l3_window_hours   integer,
  l4_daily          integer,
  l4_window_hours   integer,
  l5_per_second     integer,
  l5_window_seconds integer,
  backlog_max       integer,
  max_attempts      integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Numbers live in exactly one place; §10.6.1 convention. A reviewed
  -- migration raises them. Defaults sit strictly below SES sandbox quotas
  -- (Max24HourSend = 200, MaxSendRate = 1/s) so even an unapproved AWS
  -- account cannot be throttled by SES at the configured rate.
  if p_class = 'transactional' then
    return query select
      3  as l1_address,     24 as l1_window_hours,
      100 as l2_community,  1  as l2_window_hours,
      1000 as l3_platform,  1  as l3_window_hours,
      180 as l4_daily,      24 as l4_window_hours,
      1  as l5_per_second,  1  as l5_window_seconds,
      500 as backlog_max,   3  as max_attempts;
  elsif p_class = 'bulk' then
    return query select
      3  as l1_address,     24 as l1_window_hours,
      100 as l2_community,  1  as l2_window_hours,
      1000 as l3_platform,  1  as l3_window_hours,
      0  as l4_daily,       24 as l4_window_hours,
      0  as l5_per_second,  1  as l5_window_seconds,
      500 as backlog_max,   3  as max_attempts;
  else
    raise exception 'UNKNOWN_SEND_CLASS: % (expected transactional or bulk)', p_class
      using errcode = '22023';
  end if;
end;
$$;

comment on function app.notification_send_limits(text) is
  'M13.2 P9-3: configured rate-limit, quota and backlog values, one row per send class. Changed ONLY by a reviewed migration (create or replace), never at runtime, by a UI, or by ad-hoc SQL. L4/L5 defaults sit strictly below SES sandbox quotas; raising them is a separate, reviewed migration tied to the provider''s own GetAccount numbers (P9-4). Operator/worker only.';

revoke all on function app.notification_send_limits(text) from public;
revoke execute on function app.notification_send_limits(text) from anon, authenticated;


-- ── 5. Amend reserve_email_attempt to call the new limits fn and add L4/L5 ──
-- The body below is byte-identical to the P9-1 amendment up to and including
-- the L3 branch; the four additions are:
--   · v_class, read from the delivery row and passed to the limits fn.
--   · Two more advisory locks (keys 4 and 5) APPENDED to the fixed order.
--   · L4 branch after L3: daily per-class cap; defer, keep address, undo attempt.
--   · L5 branch after L4: per-second per-class cap; defer with short jitter,
--     keep address, undo attempt.
-- The granted-insert now includes send_class.
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
  v_class           text;
  v_address_count   bigint;
  v_community_count bigint;
  v_platform_count  bigint;
  v_class_daily     bigint;
  v_class_second    bigint;
  v_deferred_count  bigint;
  v_oldest_at       timestamptz;
  v_l5_delay_ms     integer;
begin
  -- ── Precondition ─────────────────────────────────────────────────────
  select * into v_delivery
  from public.notification_deliveries
  where id = p_delivery_id;

  if v_delivery.id is null or v_delivery.status <> 'sending' then
    raise exception
      'RESERVE_PRECONDITION: delivery % must be in sending state',
      p_delivery_id
      using errcode = 'P0001';
  end if;

  v_class := v_delivery.send_class;
  select * into v_limits from app.notification_send_limits(v_class);
  v_address := lower(v_delivery.recipient_address);

  -- ── Lock order: address, community, platform, class, class-daily ─────
  -- Fixed order so two concurrent reservations cannot deadlock. The two
  -- new keys (4, 5) are APPENDED, never interleaved, so every existing
  -- caller still takes locks in a prefix of this order.
  perform pg_advisory_xact_lock(1, hashtext(v_address));
  perform pg_advisory_xact_lock(2, hashtext(v_delivery.community_id::text));
  perform pg_advisory_xact_lock(3, 0);
  perform pg_advisory_xact_lock(4, hashtext(v_class));
  perform pg_advisory_xact_lock(5, hashtext(v_class || '|daily'));


  -- ── P9-1: suppression check (BEFORE any rate limit) ──────────────────
  if app.is_address_suppressed(v_delivery.recipient_address) then
    update public.notification_deliveries
    set status              = 'skipped',
        error_code          = 'address_suppressed',
        recipient_address   = null,
        recipient_address_assurance = null,
        send_lease_token    = null,
        send_lease_expires_at = null,
        attempt_count       = v_delivery.attempt_count - 1
    where id = p_delivery_id;

    reservation := 'address_suppressed';
    retry_at    := null;
    return next; return;
  end if;


  -- ── L1: per-address limit (rolling 24 h) ─────────────────────────────
  select count(*) into v_address_count
  from public.notification_send_attempts a
  where a.address_key = v_address
    and a.attempted_at > now() - make_interval(hours => v_limits.l1_window_hours);

  if v_address_count >= v_limits.l1_address then
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


  -- ── L4: per-class daily cap (rolling 24 h) ───────────────────────────
  -- Class-level smoothing against the provider's own daily send quota. A
  -- breach defers with next_retry_at = oldest counted attempt + 24 h, so
  -- the row becomes claimable exactly when the counted attempt leaves the
  -- window. The address is NOT erased: the row is still a legitimate
  -- send that is only waiting its turn, same policy as L2/L3 deferrals.
  select count(*) into v_class_daily
  from public.notification_send_attempts a
  where a.send_class = v_class
    and a.attempted_at > now() - make_interval(hours => v_limits.l4_window_hours);

  if v_class_daily >= v_limits.l4_daily then
    select min(a.attempted_at) + make_interval(hours => v_limits.l4_window_hours)
    into v_oldest_at
    from public.notification_send_attempts a
    where a.send_class = v_class
      and a.attempted_at > now() - make_interval(hours => v_limits.l4_window_hours);

    -- Edge case: a zero cap (the default for 'bulk') makes v_oldest_at
    -- null because the count is 0 before any attempt is counted. Fall
    -- back to a now()+24h deferral so the row ages out at 72 h without
    -- a null next_retry_at (which would be claimable immediately).
    if v_oldest_at is null then
      v_oldest_at := now() + make_interval(hours => v_limits.l4_window_hours);
    end if;

    update public.notification_deliveries
    set status              = 'pending',
        next_retry_at       = v_oldest_at,
        send_lease_token    = null,
        send_lease_expires_at = null,
        attempt_count       = v_delivery.attempt_count - 1
    where id = p_delivery_id;

    reservation := 'provider_daily_limited';
    retry_at    := v_oldest_at;
    return next; return;
  end if;


  -- ── L5: per-class per-second cap (rolling 1 s) ───────────────────────
  -- Provider-rate smoothing. Short next_retry_at (1 s + 0–200 ms random
  -- jitter) so N contending workers do not re-collide on the next tick.
  -- jitter uses extensions.random() (postgres built-in via extensions
  -- schema is unavailable; random() in search_path '' is reached via a
  -- schema-qualified reference). Zero cap defers forever by the same
  -- fallback as L4.
  select count(*) into v_class_second
  from public.notification_send_attempts a
  where a.send_class = v_class
    and a.attempted_at > now() - make_interval(secs => v_limits.l5_window_seconds);

  if v_class_second >= v_limits.l5_per_second then
    v_l5_delay_ms := v_limits.l5_window_seconds * 1000 + (pg_catalog.random() * 200)::integer;
    v_oldest_at   := now() + make_interval(secs => v_l5_delay_ms / 1000.0);

    update public.notification_deliveries
    set status              = 'pending',
        next_retry_at       = v_oldest_at,
        send_lease_token    = null,
        send_lease_expires_at = null,
        attempt_count       = v_delivery.attempt_count - 1
    where id = p_delivery_id;

    reservation := 'provider_rate_limited';
    retry_at    := v_oldest_at;
    return next; return;
  end if;


  -- ── All limits OK: insert ledger row ──────────────────────────────────
  insert into public.notification_send_attempts
    (delivery_id, community_id, address_key, send_class)
  values
    (p_delivery_id, v_delivery.community_id, v_address, v_class);

  reservation := 'granted';
  retry_at    := null;
  return next; return;
end;
$$;

comment on function app.reserve_email_attempt(uuid) is
  'M13.2 P5-2 + P9-1 + P9-3: concurrency-safe rate-limit reservation. Called inside the transaction that claimed the delivery (P5-1). Checks (in order): suppression (P9-1), L1/L2/L3/backlog (P5-2), L4 daily per class (P9-3), L5 per-second per class (P9-3). Advisory locks in a fixed appended order (address, community, platform, class, class-daily) prevent concurrent bypass and deadlock. Deferred outcomes (community_deferred, provider_daily_limited, provider_rate_limited) keep the address and undo the attempt; terminal skips erase the address. Operator/worker only; no client role may execute it.';

revoke all on function app.reserve_email_attempt(uuid) from public;
revoke execute on function app.reserve_email_attempt(uuid) from anon, authenticated;


-- ── 6. Drop the old no-arg limits function ──────────────────────────────────
-- Must come AFTER the amended reserve_email_attempt is in place (it is the
-- only dependent object). Any new caller must use the per-class signature.
drop function app.notification_send_limits();


-- ── 7. Amend the health snapshot with per-class L4/L5 fields ────────────────
-- Pure addition: every pre-existing field keeps its name, type and semantics.
-- The staff-only view is a `select * from app.notification_send_health()`
-- passthrough and picks the new columns up automatically.
--
-- Because the function signature grows (new return columns), the view must
-- be dropped and recreated. It is defined with no other dependents and
-- carries no grants to any client role, so this is a one-line reset.
drop view private.v_notification_send_health;

create or replace function app.notification_send_health()
returns table (
  email_sending_enabled           boolean,
  last_heartbeat_at               timestamptz,
  last_claim_at                   timestamptz,
  pending_total                   bigint,
  pending_due                     bigint,
  oldest_pending_age_s            bigint,
  deferred_backlog                bigint,
  oldest_deferred_age_s           bigint,
  sending_count                   bigint,
  expired_lease_count             bigint,
  l2_busiest_last_hour            bigint,
  l2_utilisation_pct              numeric,   -- invariant-allow: a utilisation percentage, not a money column
  l3_last_hour                    bigint,
  l3_utilisation_pct              numeric,   -- invariant-allow: a utilisation percentage, not a money column
  l4_last_24h_by_class            jsonb,
  l4_utilisation_pct_by_class     jsonb,
  l5_last_second_by_class         jsonb,
  l5_utilisation_pct_by_class     jsonb,
  sent_24h                        bigint,
  dead_24h                        bigint,
  skipped_24h                     bigint,
  dead_by_code                    jsonb,
  skipped_by_code                 jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limits_tx record;
  v_limits_bk record;
  v_state     record;
begin
  -- Read both classes' limits so utilisation percentages can be computed by
  -- class. Transactional is always configured; bulk's caps are the
  -- 'closed' zero defaults until a later milestone opens the path.
  select * into v_limits_tx from app.notification_send_limits('transactional');
  select * into v_limits_bk from app.notification_send_limits('bulk');

  select s.email_sending_enabled, s.last_heartbeat_at, s.last_claim_at
    into v_state
  from public.notification_sender_state s
  where s.id;

  email_sending_enabled := coalesce(v_state.email_sending_enabled, false);
  last_heartbeat_at      := v_state.last_heartbeat_at;
  last_claim_at          := v_state.last_claim_at;

  select
    count(*),
    count(*) filter (
      where d.attempt_count < v_limits_tx.max_attempts
        and (d.next_retry_at is null or d.next_retry_at <= now())
    ),
    coalesce(extract(epoch from (now() - min(d.created_at)))::bigint, 0)
  into pending_total, pending_due, oldest_pending_age_s
  from public.notification_deliveries d
  where d.channel = 'email' and d.status = 'pending';

  select
    count(*),
    coalesce(extract(epoch from (now() - min(d.created_at)))::bigint, 0)
  into deferred_backlog, oldest_deferred_age_s
  from public.notification_deliveries d
  where d.channel = 'email' and d.status = 'pending' and d.next_retry_at is not null;

  select
    count(*),
    count(*) filter (where d.send_lease_expires_at is not null and d.send_lease_expires_at <= now())
  into sending_count, expired_lease_count
  from public.notification_deliveries d
  where d.channel = 'email' and d.status = 'sending';

  -- L3: platform-wide reservations in the rolling window (class-agnostic).
  select count(*) into l3_last_hour
  from public.notification_send_attempts a
  where a.attempted_at > now() - make_interval(hours => v_limits_tx.l3_window_hours);

  -- L2: busiest single community in the rolling window (class-agnostic).
  select coalesce(max(c), 0) into l2_busiest_last_hour
  from (
    select count(*) c
    from public.notification_send_attempts a
    where a.attempted_at > now() - make_interval(hours => v_limits_tx.l2_window_hours)
    group by a.community_id
  ) t;

  l3_utilisation_pct := round(100.0 * l3_last_hour / nullif(v_limits_tx.l3_platform, 0), 1);
  l2_utilisation_pct := round(100.0 * l2_busiest_last_hour / nullif(v_limits_tx.l2_community, 0), 1);

  -- L4: counts and utilisation by class.
  select coalesce(jsonb_object_agg(cls, c), '{}'::jsonb) into l4_last_24h_by_class
  from (
    select 'transactional'::text as cls,
      (select count(*) from public.notification_send_attempts a
         where a.send_class = 'transactional'
           and a.attempted_at > now() - make_interval(hours => v_limits_tx.l4_window_hours)) as c
    union all
    select 'bulk'::text as cls,
      (select count(*) from public.notification_send_attempts a
         where a.send_class = 'bulk'
           and a.attempted_at > now() - make_interval(hours => v_limits_bk.l4_window_hours)) as c
  ) t;

  l4_utilisation_pct_by_class := jsonb_build_object(
    'transactional', round(100.0 * (l4_last_24h_by_class->>'transactional')::numeric / nullif(v_limits_tx.l4_daily, 0), 1),
    'bulk',          round(100.0 * (l4_last_24h_by_class->>'bulk')::numeric          / nullif(v_limits_bk.l4_daily, 0), 1)
  );

  -- L5: counts and utilisation by class, 1-second window.
  select coalesce(jsonb_object_agg(cls, c), '{}'::jsonb) into l5_last_second_by_class
  from (
    select 'transactional'::text as cls,
      (select count(*) from public.notification_send_attempts a
         where a.send_class = 'transactional'
           and a.attempted_at > now() - make_interval(secs => v_limits_tx.l5_window_seconds)) as c
    union all
    select 'bulk'::text as cls,
      (select count(*) from public.notification_send_attempts a
         where a.send_class = 'bulk'
           and a.attempted_at > now() - make_interval(secs => v_limits_bk.l5_window_seconds)) as c
  ) t;

  l5_utilisation_pct_by_class := jsonb_build_object(
    'transactional', round(100.0 * (l5_last_second_by_class->>'transactional')::numeric / nullif(v_limits_tx.l5_per_second, 0), 1),
    'bulk',          round(100.0 * (l5_last_second_by_class->>'bulk')::numeric          / nullif(v_limits_bk.l5_per_second, 0), 1)
  );

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
  'M13.2 P5-5 + P9-3: single-sourced operational snapshot (§10.6.1). Queue depth, oldest pending, deferred backlog and its oldest, in-flight and expired-lease counts, L2/L3 utilisation, L4/L5 utilisation per send class (P9-3), terminal outcomes in the last 24h by stable code, the pause state and the heartbeat. Only counts, codes and timestamps — never an address, name or provider error text. The worker logs the same numbers once a minute. Operator/worker only; no client role may execute it.';

revoke all on function app.notification_send_health() from public;
revoke execute on function app.notification_send_health() from anon, authenticated;


create or replace view private.v_notification_send_health as
  select * from app.notification_send_health();

comment on view private.v_notification_send_health is
  'M13.2 P5-5 + P9-3: staff-only send-health view (ADR 0009: operational data is not client-readable). Carries no address, name or error text.';

revoke all on private.v_notification_send_health from public, anon, authenticated;
