-- Promoted 2026-11-09 from docs/database/proposals/M13.3-R3-SEND-TIME-RECHECK.proposed.sql (body unchanged; only this
-- status header replaced). Apply order: 20261109100000 policy -> 20261109100100 announcements -> 20261109100200 R3.
--
-- APPLY ORDER: after M13.3-COMMUNICATION-POLICY.proposed.sql and MEMBER-ANNOUNCEMENTS.proposed.sql
-- (it calls app.communication_requirement, app.community_communication_notice_attested,
-- app.member_communication_opted_out and app.member_communication_permission).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- M13.3 R3 — Send-time eligibility recheck
--
-- docs/product/M13.3-R3-SEND-TIME-IMPLEMENTATION-REPORT.md.
--
-- Where the check runs. The sender's only transaction before a provider call is
--   BEGIN → app.claim_next_notification_delivery (row lock, SKIP LOCKED, status → sending)
--         → app.reserve_email_attempt (suppression, L1–L5) → COMMIT → provider call
-- so the recheck runs INSIDE app.reserve_email_attempt, first, while the claim
-- transaction holds the delivery's row lock. A row that is no longer eligible
-- is settled skipped (stable code, address erased, attempt undone, lease
-- cleared) in that same transaction and is never handed to a provider.
--
-- Serialisation with withdrawals. The recheck takes SHARED advisory locks on
-- the same keys the opt-out writer (app.insert_member_communication_choice)
-- and the attestation writers take EXCLUSIVELY. A withdrawal committing
-- concurrently is therefore either visible to the recheck or waits until the
-- claim transaction commits. The recheck is VOLATILE plpgsql under READ
-- COMMITTED, so every statement after the locks reads a fresh snapshot.
-- Residual window: a withdrawal committed after the claim transaction commits
-- and before the provider accepts the message (the length of one provider
-- call) cannot be honoured for that message; it is honoured for every later one.
--
-- Audience-agnostic on purpose (N-AUD). The recheck never asks "is this member
-- still in the collection's (payment) audience". It asks only whether this
-- recipient may still receive this category on this channel from this
-- community, so the independent notification audience (N-AUD) can replace
-- fan-out without touching send-time protection.
--
-- Objects (additive except the one CREATE OR REPLACE):
--   1. app.communication_category_for_event(text)  — event → category / payment purpose / topic;
--      identical to apps/worker/src/communication-policy.ts EVENT_POLICIES (parity test).
--   2. app.recheck_delivery_eligibility(uuid) → text — NULL = may send, else a stable skip code.
--   3. app.reserve_email_attempt(uuid) — the 20261024200000 body, unchanged except one block at
--      the top that calls (2); new outcome `ineligible`. CREATE OR REPLACE keeps the function's
--      identity, so the worker role's existing EXECUTE grant still applies: no new grant.
--
-- Invariant the worker relies on: (2) and (3) ship together. The worker treats the existence of
-- app.recheck_delivery_eligibility(uuid) as proof that reservations recheck, and refuses to send
-- a non-essential row when it is absent (fail closed).
--
-- Rollback (isolated stack or later environments): re-create app.reserve_email_attempt from
-- 20261024200000 (section 5) unchanged; then
--   drop function app.recheck_delivery_eligibility(uuid);
--   drop function app.communication_category_for_event(text);
-- (in that order: the old reserve body does not reference them). Rows already skipped by the
-- recheck stay skipped (terminal; never re-sent).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Event → category ──────────────────────────────────────────────────────
create or replace function app.communication_category_for_event(p_event_type text)
returns table (category text, payment_purpose text, topic text)
language sql
immutable
set search_path = ''
as $$
  select m.category, m.payment_purpose, m.topic
  from (values
    -- EVENT-CATEGORY-BEGIN (parsed by apps/worker/test/communication-policy-sql-parity.test.ts; one row per line)
    ('member.create',                    'essential',             null::text,          null::text),
    ('member.approve_join',              'essential',             null,                null),
    ('officer_invitation.accept',        'essential',             null,                null),
    ('officer_term.end',                 'essential',             null,                null),
    ('member.reject_join',               'essential',             null,                null),
    ('member.join_via_invite',           'essential',             null,                null),
    ('collection.publish',               'community_operational', null,                'announcement'),
    ('collection.announce_update',       'community_operational', null,                'update'),
    ('collection.remind',                'community_operational', null,                'reminder'),
    ('collection.publish_remind_unpaid', 'payment',               'targeted_reminder', null),
    ('collection.remind_unpaid',         'payment',               'targeted_reminder', null)
    -- EVENT-CATEGORY-END
  ) as m (event_type, category, payment_purpose, topic)
  where m.event_type = p_event_type;
$$;

comment on function app.communication_category_for_event(text) is
  'M13.3 R3: the communication category (and payment purpose / preference topic) of a notification event type, identical to the worker''s central policy. No row = unclassified (the recheck then refuses to send anything non-essential). Internal.';

revoke all on function app.communication_category_for_event(text) from public;
revoke execute on function app.communication_category_for_event(text) from public, anon, authenticated;


-- ── 2. The send-time recheck ─────────────────────────────────────────────────
create or replace function app.recheck_delivery_eligibility(p_delivery_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d         record;
  v_policy    record;
  v_req       record;
  v_member    record;
  v_prefs     record;
  v_candidate text;
begin
  select d.id, d.community_id, d.channel::text as channel, d.recipient_member_id, d.recipient_address,
         d.communication_category, e.event_type, e.object_type, e.object_id
    into v_d
  from public.notification_deliveries d
  join public.notification_events e on e.id = d.notification_event_id
  where d.id = p_delivery_id;

  if v_d.id is null then
    return 'delivery_not_found';
  end if;

  -- Category: from the event (the policy map). A stored category must agree.
  select c.category, c.payment_purpose, c.topic into v_policy
  from app.communication_category_for_event(v_d.event_type) c;
  if v_policy.category is null then
    return 'category_unknown';
  end if;
  if v_d.communication_category is not null and v_d.communication_category <> v_policy.category then
    return 'category_mismatch';
  end if;

  select r.requirement, r.detail into v_req
  from app.communication_requirement(v_policy.category, v_d.channel, v_policy.payment_purpose) r;
  if v_req.requirement is null then
    return 'category_not_on_channel';
  end if;
  if v_req.requirement = 'disabled' then
    return coalesce(v_req.detail, 'category_not_on_channel');
  end if;
  -- Essential (transactional) messages are not optional: no opt-out, no
  -- attestation, no permission applies. Unchanged by M13.3.
  if v_req.requirement = 'always' then
    return null;
  end if;

  -- Everything below is optional communication addressed to a member.
  if v_d.recipient_member_id is null then
    return 'member_unavailable';
  end if;

  -- Serialise with in-flight withdrawals and attestation changes (see header).
  perform pg_advisory_xact_lock_shared(hashtextextended('member_communication_choice:' || v_d.recipient_member_id::text, 0));
  perform pg_advisory_xact_lock_shared(hashtextextended('community_communication_attestation:' || v_d.community_id::text, 0));

  select m.id, m.community_id, m.status::text as status, m.archived_at, m.merged_into_id, m.user_id, m.email::text as email
    into v_member
  from public.members m
  where m.id = v_d.recipient_member_id;
  if v_member.id is null
     or v_member.community_id <> v_d.community_id
     or v_member.status in ('archived', 'merged')
     or v_member.archived_at is not null
     or v_member.merged_into_id is not null then
    return 'member_unavailable';
  end if;

  -- The member's own choice first (worker: decide()).
  if app.member_communication_opted_out(v_member.id, v_policy.category, v_d.channel) then
    return 'opted_out';
  end if;
  select p.email_enabled, p.whatsapp_enabled, p.sms_enabled,
         case v_policy.topic
           when 'announcement' then p.announcements_enabled
           when 'update'       then p.collection_updates_enabled
           when 'reminder'     then p.reminders_enabled
         end as topic_enabled
    into v_prefs
  from public.notification_preferences p
  where p.member_id = v_member.id and p.community_id = v_member.community_id;
  if (v_d.channel = 'email'    and v_prefs.email_enabled    is false)
     or (v_d.channel = 'whatsapp' and v_prefs.whatsapp_enabled is false)
     or (v_d.channel = 'sms'      and v_prefs.sms_enabled      is false)
     or v_prefs.topic_enabled is false then
    return 'opted_out';
  end if;

  if v_req.requirement = 'default_on' then
    if v_req.detail = 'community_notice'
       and not app.community_communication_notice_attested(v_d.community_id) then
      return 'community_notice_missing';
    end if;
  elsif v_req.requirement = 'opt_in' then
    -- Member-given permissions only. The attestation is never consulted here.
    if position('marketing_consent' in coalesce(v_req.detail, '')) > 0
       and not app.member_communication_permission(v_member.id, 'marketing_consent') then
      return 'marketing_consent_missing';
    end if;
    if position('whatsapp_permission' in coalesce(v_req.detail, '')) > 0
       and not app.member_communication_permission(v_member.id, 'whatsapp_permission') then
      return 'channel_permission_missing';
    end if;
  else
    return 'category_not_on_channel';
  end if;

  -- A collection message must still link to a page a member without an account can open.
  if v_d.object_type = 'collection' and not exists (
       select 1
       from public.collections c
       join public.communities cm on cm.id = c.community_id
       where c.id = v_d.object_id
         and c.community_id = v_d.community_id
         and c.visibility in ('public', 'unlisted')
         and c.status in ('active', 'paused', 'closed')
         and cm.status = 'active') then
    return 'collection_not_reachable';
  end if;

  -- The address the row carries must still be the member's current address
  -- (an organiser may have corrected it after fan-out).
  if v_d.channel = 'email' then
    if v_member.user_id is not null then
      select u.email::text into v_candidate
      from auth.users u
      where u.id = v_member.user_id and u.email_confirmed_at is not null;
    else
      v_candidate := v_member.email;
    end if;
    if v_candidate is null or v_d.recipient_address is null
       or lower(v_candidate) <> lower(v_d.recipient_address) then
      return 'recipient_changed';
    end if;
  end if;

  return null;
end;
$$;

comment on function app.recheck_delivery_eligibility(uuid) is
  'M13.3 R3: send-time eligibility for one delivery. NULL = may be handed to a provider; otherwise a stable skip code (category_unknown, category_mismatch, payment_attribution_unavailable, channel_disabled, category_not_on_channel, member_unavailable, opted_out, community_notice_missing, marketing_consent_missing, channel_permission_missing, collection_not_reachable, recipient_changed). Essential messages always NULL. Audience-agnostic. Takes shared advisory locks that serialise it with opt-out and attestation writers. Called by app.reserve_email_attempt inside the claim transaction. Internal: no client role may execute it.';

revoke all on function app.recheck_delivery_eligibility(uuid) from public;
revoke execute on function app.recheck_delivery_eligibility(uuid) from public, anon, authenticated;


-- ── 3. app.reserve_email_attempt with the recheck ────────────────────────────
-- GENERATED from supabase/migrations/20261024200000_notification_quota_controls.sql (section 5):
-- byte-identical except (a) one declared variable and (b) the M13.3 R3 block after the
-- precondition. The R3 report records the generator and the diff check.
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
  v_ineligible      text;     -- M13.3 R3
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

  -- ── M13.3 R3: send-time eligibility recheck (BEFORE suppression and limits) ──
  -- Runs while this (claim) transaction holds the delivery's row lock. An
  -- ineligible row is settled exactly like a suppressed one: skipped with a
  -- stable code, address erased, attempt undone, lease cleared, no ledger row,
  -- no provider call. Essential (transactional) rows always pass.
  v_ineligible := app.recheck_delivery_eligibility(p_delivery_id);
  if v_ineligible is not null then
    update public.notification_deliveries
    set status              = 'skipped',
        error_code          = v_ineligible,
        recipient_address   = null,
        recipient_address_assurance = null,
        send_lease_token    = null,
        send_lease_expires_at = null,
        attempt_count       = v_delivery.attempt_count - 1
    where id = p_delivery_id;

    reservation := 'ineligible';
    retry_at    := null;
    return next; return;
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
  'M13.2 P5-2 + P9-1 + P9-3 + M13.3 R3: concurrency-safe rate-limit reservation. Called inside the transaction that claimed the delivery (P5-1). Checks (in order): send-time eligibility (M13.3 R3, app.recheck_delivery_eligibility; outcome ineligible), suppression (P9-1), L1/L2/L3/backlog (P5-2), L4 daily per class (P9-3), L5 per-second per class (P9-3). Advisory locks in a fixed appended order (address, community, platform, class, class-daily) prevent concurrent bypass and deadlock. Deferred outcomes (community_deferred, provider_daily_limited, provider_rate_limited) keep the address and undo the attempt; terminal skips erase the address. Operator/worker only; no client role may execute it.';

revoke all on function app.reserve_email_attempt(uuid) from public;
revoke execute on function app.reserve_email_attempt(uuid) from anon, authenticated;

