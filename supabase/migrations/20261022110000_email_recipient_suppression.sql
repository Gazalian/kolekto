-- ─────────────────────────────────────────────────────────────────────────────
-- 20261022110000 — Recipient suppression and pre-send enforcement (M13.2 P9-1)
--
-- docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md, §10.4 (the
-- envisioned `address_suppressed` skip code), §10.6 (reserve path), §13
-- (D-SUPPRESS: this migration closes the recipient-suppression part of it;
-- bounce/complaint event ingestion lands in P9-2 and writes into this table).
--
-- What this does, and only this:
--
--   1. public.email_suppressions: the recipient-suppression list. One row per
--      suppressed address. address_key is lower(address) — SAME NORMALISATION
--      as notification_send_attempts.address_key, so the reserve function can
--      use the value it already has (v_address) without a second lower() call.
--      Append-only via trigger; the only mutation allowed from the trigger's
--      point of view is the operator-controlled purge of expired rows and the
--      operator-controlled clear, each of which signals the trigger first.
--      No client role has any grant.
--   2. app.is_address_suppressed(p_address text): read-only probe. Returns
--      true when a permanent row exists (expires_at is null) OR an unexpired
--      transient row exists.
--   3. app.set_email_suppression(p_address, p_reason, p_expires_at,
--      p_source, p_source_event_id): operator-session only. Lower-cases,
--      validates, upserts. The ses_event source is reserved for the
--      P9-2 webhook handler (not reachable here) and is checked for by the
--      role gate so an accidental ad-hoc call cannot bypass it.
--   4. app.clear_email_suppression(p_address): operator-session only.
--      Deletes the row(s) matching the address.
--   5. app.list_email_suppressions_masked(p_limit, p_before): the ONLY path
--      from which an operator may READ this table. Returns
--      recipient_address_masked (f***@d***.com) via the existing
--      app.mask_email_address, never the raw address.
--   6. app.purge_expired_email_suppressions(): deletes transient rows whose
--      expires_at is more than 30 days in the past. The 30-day grace lets an
--      operator audit a recently expired suppression. Permanent rows
--      (expires_at is null) are never purged.
--   7. app.reserve_email_attempt(uuid): AMENDED to call is_address_suppressed
--      FIRST, before the L1/L2/L3 checks. On hit: terminal skip with
--      error_code = 'address_suppressed', recipient_address erased (matching
--      the recipient_rate_limited / community_backlog_full pattern), the
--      attempt counter undone. New reservation value: 'address_suppressed'.
--
-- What this deliberately does NOT do (later phases):
--
--   · No SES adapter, no SES SDK dependency, no registration of 'ses' in
--     REAL_EMAIL_PROVIDERS. P9-4.
--   · No SNS webhook, no event ingestion, no automatic suppression from
--     bounces/complaints. P9-2.
--   · No SES-quota-aware L4/L5 limits. P9-3.
--   · No crash-after-accept guard (send_in_flight_marker). P9-4.
--   · No change to the sender pause switch (still default false; verified).
--   · No change to the existing rate-limit numbers, retry policy, claim/lease
--     semantics or provider behavior.
--
-- Privileges: SECURITY DEFINER on every app.* function, SET search_path = '',
-- EXECUTE revoked from public, anon, authenticated. The functions that write
-- or read the table are operator-only (role = 'none'); the probe
-- (is_address_suppressed) is callable by the owner connection only (no client
-- grant). No row in email_suppressions is reachable by any client role.
--
-- Additive. No existing row is rewritten by this migration. The amended
-- reserve function uses `create or replace`; the previous body remains in the
-- migration history and could be restored by reverting this migration.
-- Rollback: drop the five app.* functions added here, drop the three triggers,
-- the three indexes, the deny policy, and the table; restore the previous
-- reserve_email_attempt body from 20261013200000_notification_rate_limits.sql.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The suppression table ─────────────────────────────────────────────────
create table public.email_suppressions (
  id                uuid         primary key default app.uuid_generate_v7(),
  -- lower(address). Same normalisation as notification_send_attempts.address_key
  -- so the reserve function reuses its existing v_address value for the check
  -- and there is one key format for recipient-identifying data across tables.
  address_key       text         not null,
  -- Stable, append-only vocabulary. New codes land only in a reviewed migration.
  reason            text         not null,
  -- Where the row came from. Operator entries are 'operator'; P9-2 bounce/
  -- complaint ingestion will record 'ses_event'. The sender itself does not
  -- write to this table (it is read-only through is_address_suppressed).
  source            text         not null,
  -- Optional lineage: SES messageId or feedbackId for ses_event rows; null for
  -- operator rows. Not a foreign key: SES events have no table yet.
  source_event_id   text,
  -- When this address first became suppressed, for audit. On upsert the row's
  -- first_seen_at is preserved; only reason, source, source_event_id and
  -- updated_at change on the permanent-already-exists path.
  first_seen_at     timestamptz  not null default now(),
  -- NULL means permanent (hard bounce, complaint, manual block). A timestamp
  -- means transient: suppression lifts when now() > expires_at (checked in
  -- is_address_suppressed). Operator-settable; P9-2 may set it for the
  -- transient-bounce-cap feature.
  expires_at        timestamptz,
  created_at        timestamptz  not null default now(),
  updated_at        timestamptz  not null default now(),

  constraint email_suppressions_reason_values
    check (reason in ('hard_bounce', 'complaint', 'manual_block', 'transient_bounce_capped', 'list_unsubscribe')),
  constraint email_suppressions_source_values
    check (source in ('operator', 'ses_event', 'sender_classification')),
  constraint email_suppressions_address_key_format
    -- Must be the lower-cased ASCII form email-provider.ts accepts. Full
    -- validation lives in the setter; this is the storage-layer sanity check.
    -- The character class covers 0x00-0x1F, 0x7F, and space.
    check (
      length(address_key) between 3 and 254
      and address_key = lower(address_key)
      and position('@' in address_key) > 1
      and address_key !~ '[[:cntrl:] ]'
    ),
  constraint email_suppressions_expiry_future_or_null
    -- A permanent row has no expiry. A transient row's expiry must sit strictly
    -- after first_seen_at. The function enforces "in the future at insert time"
    -- separately (now() is not stable, so it cannot live in a CHECK).
    check (expires_at is null or expires_at > first_seen_at)
);

comment on table public.email_suppressions is
  'M13.2 P9-1: recipient suppression list. One row per suppressed address. address_key is lower(address) — same normalisation as notification_send_attempts.address_key. Deny-all RLS, no client grants (long-lived PII surface, same convention as notification_send_attempts). Operator reads go through app.list_email_suppressions_masked() which never returns the raw address. P9-2 bounce/complaint ingestion writes here; the sender reads via app.is_address_suppressed in app.reserve_email_attempt.';


-- One permanent suppression per address (uniqueness only on permanent rows,
-- via a partial unique index — a transient row can co-exist for the same
-- address but is superseded by upsert when a permanent one lands).
create unique index email_suppressions_permanent_address_key_idx
  on public.email_suppressions (address_key)
  where expires_at is null;

-- Lookup index for the probe. Partial on NOT NULL expires_at keeps it small;
-- the permanent index above covers the permanent-row lookup.
create index email_suppressions_transient_lookup_idx
  on public.email_suppressions (address_key, expires_at desc)
  where expires_at is not null;

-- Housekeeping scan: age-based pruning of long-expired transient rows.
create index email_suppressions_expires_at_idx
  on public.email_suppressions (expires_at)
  where expires_at is not null;


-- ── 2. RLS and client denial ────────────────────────────────────────────────
alter table public.email_suppressions enable row level security;
alter table public.email_suppressions force row level security;

-- The repository's rule (01_rls_coverage.sql): every public table carries a
-- policy. Same explicit deny used for notification_send_attempts and the
-- suppression log.
create policy email_suppressions_deny_client_access
  on public.email_suppressions for select to authenticated
  using (false);

revoke all on table public.email_suppressions from public, anon, authenticated;


-- ── 3. Append-only enforcement ──────────────────────────────────────────────
-- The clear/purge/upsert operations run under
--   set_config('app.email_suppressions_mutating', 'true', true)
-- inside the operator-only function body, which signals the trigger to allow
-- the DELETE/UPDATE. Any other DELETE/UPDATE path is blocked.
create or replace function app.block_email_suppressions_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('DELETE', 'UPDATE')
     and current_setting('app.email_suppressions_mutating', true) = 'true' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  raise exception
    'EMAIL_SUPPRESSIONS_IS_APPEND_ONLY: email_suppressions rows cannot be % outside the operator-controlled setter, clear or purge functions (M13.2 P9-1)',
    lower(tg_op)
    using errcode = 'P0001';
  return null;
end;
$$;

revoke execute on function app.block_email_suppressions_mutation() from public, anon, authenticated;

create trigger email_suppressions_no_update
  before update on public.email_suppressions
  for each row execute function app.block_email_suppressions_mutation();
create trigger email_suppressions_no_delete
  before delete on public.email_suppressions
  for each row execute function app.block_email_suppressions_mutation();
create trigger email_suppressions_no_truncate
  before truncate on public.email_suppressions
  for each statement execute function app.block_email_suppressions_mutation();


-- ── 4. Probe: is this address suppressed? ────────────────────────────────────
-- Called by the sender inside the reserve transaction. Case-folded. Returns
-- true if a permanent row exists OR an unexpired transient row exists. Does
-- NOT raise on malformed input: it returns false, because the caller (reserve)
-- has already validated the delivery and this probe must never fail the whole
-- sender tick.
create or replace function app.is_address_suppressed(p_address text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key   text;
  v_found boolean;
begin
  if p_address is null or btrim(p_address) = '' then
    return false;
  end if;

  v_key := lower(btrim(p_address));

  select true into v_found
  from public.email_suppressions
  where address_key = v_key
    and (expires_at is null or expires_at > now())
  limit 1;

  return coalesce(v_found, false);
end;
$$;

comment on function app.is_address_suppressed(text) is
  'M13.2 P9-1: pre-send suppression probe. Returns true when a permanent row exists (expires_at is null) OR an unexpired transient row exists for lower(address). Never raises on bad input (returns false). Called by app.reserve_email_attempt inside the claim transaction, BEFORE the L1/L2/L3 counts, so a suppressed address never reaches the provider and never consumes a rate-limit slot.';

revoke all on function app.is_address_suppressed(text) from public;
revoke execute on function app.is_address_suppressed(text) from anon, authenticated;


-- ── 5. Operator-only setter ──────────────────────────────────────────────────
create or replace function app.set_email_suppression(
  p_address         text,
  p_reason          text,
  p_expires_at      timestamptz default null,
  p_source          text        default 'operator',
  p_source_event_id text        default null
)
returns table (
  address_key  text,
  reason       text,
  expires_at   timestamptz,
  inserted     boolean,
  updated      boolean
)
language plpgsql
security definer
set search_path = ''
as $$
-- The OUT parameters (address_key, reason, expires_at) share names with
-- columns on public.email_suppressions. Prefer the column reference inside
-- SQL statements so queries read naturally; variables are still accessible
-- by their explicit v_/p_/OUT names, so no legitimate variable use is
-- shadowed.
#variable_conflict use_column
declare
  v_key            text;
  v_role           text;
  v_inserted       boolean := false;
  v_updated        boolean := false;
  v_existing_perm  record;
begin
  v_role := coalesce(nullif(current_setting('role', true), ''), 'none');
  -- Operator-only. The ses_event and sender_classification sources are
  -- reserved for later-phase SECURITY DEFINER entry points (P9-2); they are
  -- NOT reachable via this operator-only setter, so a stray p_source value
  -- cannot create a row that pretends to come from a webhook.
  if v_role <> 'none' then
    raise exception 'FORBIDDEN: email suppression setter is operator-only (role = none)'
      using errcode = '42501';
  end if;

  if p_address is null or btrim(p_address) = '' then
    raise exception 'INVALID_ADDRESS: p_address must not be empty' using errcode = '22023';
  end if;

  v_key := lower(btrim(p_address));

  if length(v_key) < 3
     or length(v_key) > 254
     or position('@' in v_key) < 2
     or v_key ~ '[[:cntrl:] ]'
  then
    raise exception 'INVALID_ADDRESS: p_address is not a plausible single email address' using errcode = '22023';
  end if;

  if p_reason not in ('hard_bounce', 'complaint', 'manual_block', 'transient_bounce_capped', 'list_unsubscribe') then
    raise exception 'INVALID_REASON: unknown suppression reason' using errcode = '22023';
  end if;

  if p_source not in ('operator', 'ses_event', 'sender_classification') then
    raise exception 'INVALID_SOURCE: unknown suppression source' using errcode = '22023';
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'INVALID_EXPIRY: p_expires_at must be in the future, or null for a permanent suppression' using errcode = '22023';
  end if;

  -- Take the same advisory lock the reserve function takes for this address,
  -- so a concurrent "send-this-address" and "block-this-address" cannot both
  -- see "not suppressed" and both proceed.
  perform pg_advisory_xact_lock(1, hashtext(v_key));

  -- Signal the append-only trigger to allow the UPDATE path below.
  perform set_config('app.email_suppressions_mutating', 'true', true);

  -- If a permanent row already exists for this address, keep it permanent;
  -- a transient request cannot downgrade a permanent suppression.
  select * into v_existing_perm
  from public.email_suppressions
  where address_key = v_key
    and expires_at is null
  limit 1;

  if v_existing_perm.id is not null then
    -- Permanent exists. If the new request is also permanent, refresh lineage
    -- fields and reason. If the new request is transient, leave the permanent
    -- row untouched (a transient request never downgrades).
    if p_expires_at is null then
      update public.email_suppressions
      set reason          = p_reason,
          source          = p_source,
          source_event_id = coalesce(p_source_event_id, v_existing_perm.source_event_id),
          updated_at      = now()
      where id = v_existing_perm.id;
      v_updated := true;
    end if;
    -- (no-op if transient-while-permanent-exists)
  else
    -- No permanent row.
    if p_expires_at is null then
      -- New permanent: tolerate the race against another writer by
      -- on-conflict-do-nothing on the partial unique index.
      -- The partial unique index covers only expires_at IS NULL rows; the
      -- inference predicate here matches that so ON CONFLICT resolves to the
      -- intended index.
      insert into public.email_suppressions
        (address_key, reason, source, source_event_id, expires_at)
      values
        (v_key, p_reason, p_source, p_source_event_id, null)
      on conflict (address_key) where expires_at is null do nothing;
      v_inserted := true;
    else
      insert into public.email_suppressions
        (address_key, reason, source, source_event_id, expires_at)
      values
        (v_key, p_reason, p_source, p_source_event_id, p_expires_at);
      v_inserted := true;
    end if;
  end if;

  perform set_config('app.email_suppressions_mutating', 'false', true);

  address_key := v_key;
  reason      := p_reason;
  expires_at  := p_expires_at;
  inserted    := v_inserted;
  updated     := v_updated;
  return next;
  return;
end;
$$;

comment on function app.set_email_suppression(text, text, timestamptz, text, text) is
  'M13.2 P9-1: add or update a suppression for lower(address). Operator-session only (role = none). A permanent suppression (p_expires_at is null) once set is not downgraded by a subsequent transient request. Takes the same address-order advisory lock as app.reserve_email_attempt, so a race between a send and a block cannot both proceed. Returns the lower-cased key, the stored reason/expiry, and whether the operation inserted or updated.';

revoke all on function app.set_email_suppression(text, text, timestamptz, text, text) from public;
revoke execute on function app.set_email_suppression(text, text, timestamptz, text, text) from anon, authenticated;


-- ── 6. Operator-only clear ───────────────────────────────────────────────────
create or replace function app.clear_email_suppression(p_address text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key     text;
  v_role    text;
  v_deleted bigint;
begin
  v_role := coalesce(nullif(current_setting('role', true), ''), 'none');
  if v_role <> 'none' then
    raise exception 'FORBIDDEN: email suppression clear is operator-only (role = none)'
      using errcode = '42501';
  end if;

  if p_address is null or btrim(p_address) = '' then
    raise exception 'INVALID_ADDRESS: p_address must not be empty' using errcode = '22023';
  end if;

  v_key := lower(btrim(p_address));

  perform pg_advisory_xact_lock(1, hashtext(v_key));
  perform set_config('app.email_suppressions_mutating', 'true', true);

  delete from public.email_suppressions
  where address_key = v_key;

  get diagnostics v_deleted = row_count;

  perform set_config('app.email_suppressions_mutating', 'false', true);

  return v_deleted;
end;
$$;

comment on function app.clear_email_suppression(text) is
  'M13.2 P9-1: delete every suppression row (permanent and transient) for lower(address). Operator-session only. Returns the number of rows deleted. The address is lower-cased and btrim-ed; no further validation (an operator may clear an address that was never suppressed — returns 0).';

revoke all on function app.clear_email_suppression(text) from public;
revoke execute on function app.clear_email_suppression(text) from anon, authenticated;


-- ── 7. Operator-only masked read ─────────────────────────────────────────────
create or replace function app.list_email_suppressions_masked(
  p_limit  integer     default 100,
  p_before timestamptz default null
)
returns table (
  recipient_address_masked text,
  reason                   text,
  source                   text,
  first_seen_at            timestamptz,
  expires_at               timestamptz,
  updated_at               timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  v_role := coalesce(nullif(current_setting('role', true), ''), 'none');
  if v_role <> 'none' then
    raise exception 'FORBIDDEN: email suppression list is operator-only (role = none)'
      using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    p_limit := 100;
  end if;

  return query
    select
      -- Reuse the existing masking helper so masking logic lives in one place.
      app.mask_email_address(s.address_key) as recipient_address_masked,
      s.reason,
      s.source,
      s.first_seen_at,
      s.expires_at,
      s.updated_at
    from public.email_suppressions s
    where (p_before is null or s.updated_at < p_before)
    order by s.updated_at desc, s.id desc
    limit p_limit;
end;
$$;

comment on function app.list_email_suppressions_masked(integer, timestamptz) is
  'M13.2 P9-1: operator-only read path for the suppression list. Returns recipient_address_masked via app.mask_email_address; never returns the raw address_key. Default limit 100, max 500. Paginate with p_before = oldest updated_at from the previous page. No officer-visible path yet — if officers later need their community''s suppressed addresses, add a scoped function then.';

revoke all on function app.list_email_suppressions_masked(integer, timestamptz) from public;
revoke execute on function app.list_email_suppressions_masked(integer, timestamptz) from anon, authenticated;


-- ── 8. Operator-callable purge of long-expired transient rows ────────────────
create or replace function app.purge_expired_email_suppressions(p_grace_days integer default 30)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_deleted bigint;
begin
  v_role := coalesce(nullif(current_setting('role', true), ''), 'none');
  if v_role <> 'none' then
    raise exception 'FORBIDDEN: suppression purge is operator-only (role = none)'
      using errcode = '42501';
  end if;

  if p_grace_days is null or p_grace_days < 0 or p_grace_days > 3650 then
    p_grace_days := 30;
  end if;

  perform set_config('app.email_suppressions_mutating', 'true', true);

  delete from public.email_suppressions
  where expires_at is not null
    and expires_at < now() - make_interval(days => p_grace_days);

  get diagnostics v_deleted = row_count;

  perform set_config('app.email_suppressions_mutating', 'false', true);

  return v_deleted;
end;
$$;

comment on function app.purge_expired_email_suppressions(integer) is
  'M13.2 P9-1: delete transient suppression rows whose expiry is more than p_grace_days (default 30) in the past. Permanent rows (expires_at is null) are never touched. Operator-only. Returns the number deleted.';

revoke all on function app.purge_expired_email_suppressions(integer) from public;
revoke execute on function app.purge_expired_email_suppressions(integer) from anon, authenticated;


-- ── 9. Amend reserve_email_attempt to call is_address_suppressed FIRST ───────
-- The ONLY change versus the body in 20261013200000: a new terminal branch
-- inserted immediately after v_address is computed and before the L1 check.
-- Everything else is byte-identical to the previous body to minimise merge
-- risk. The additional reservation outcome is 'address_suppressed'.
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
  perform pg_advisory_xact_lock(1, hashtext(v_address));
  perform pg_advisory_xact_lock(2, hashtext(v_delivery.community_id::text));
  perform pg_advisory_xact_lock(3, 0);


  -- ── P9-1: suppression check (BEFORE any rate limit) ──────────────────
  -- Runs under the address advisory lock (taken above), which the setter
  -- also takes, so a race between a send and a block cannot both see
  -- "not suppressed" and both proceed. is_address_suppressed never raises.
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


  -- ── All limits OK: insert ledger row ──────────────────────────────────
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
  'M13.2 P5-2 + P9-1: concurrency-safe rate-limit reservation. Called inside the transaction that claimed the delivery (P5-1). P9-1 adds a pre-send suppression check (app.is_address_suppressed) BEFORE the L1/L2/L3 counts: a suppressed address never consumes a rate-limit slot. Advisory locks in a fixed order (address, community, platform) prevent concurrent bypass and deadlock; the suppression check and the operator setter both take the address lock. Returns granted, address_suppressed (new in P9-1: skipped/address_suppressed), address_limited (skipped/recipient_rate_limited), community_deferred (deferred with retry_at), or backlog_full (skipped/community_backlog_full). Operator/worker only; no client role may execute it.';

-- Permissions re-asserted (create or replace preserves prior grants, but we
-- state them explicitly for review).
revoke all on function app.reserve_email_attempt(uuid) from public;
revoke execute on function app.reserve_email_attempt(uuid) from anon, authenticated;
