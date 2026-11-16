-- ─────────────────────────────────────────────────────────────────────────────
-- 20261116120000 — essential emails skip L1 + checkout URL in payment context
--
-- Two fixes for the payer email pipeline built in 20261116100000:
--
--   1. app.reserve_email_attempt: skip the L1 per-address rate limit when
--      the delivery's communication_category is 'essential'. Receipts and
--      other transaction messages must never be rate-limited by a per-address
--      cap designed for marketing/reminder emails.
--
--   2. app.payment_notification_context: add provider and provider_access_code
--      so the worker can include the checkout URL in the "payment started"
--      email. The URL is provider-specific (Paystack →
--      https://checkout.paystack.com/{access_code}); the worker builds it.
--
-- Rollback: re-create app.reserve_email_attempt from 20261109100200; re-create
-- app.payment_notification_context from 20261116100000.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Essential emails skip L1 ─────────────────────────────────────────────
--
-- The ONLY change is wrapping the L1 block (lines 339–359 of 20261109100200)
-- in: if v_delivery.communication_category <> 'essential' then … end if;
-- Everything else is an exact copy of the function from 20261109100200.

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
  -- Essential emails (receipts, transaction confirmations) skip L1: a payer
  -- who makes two payments in one day must receive both receipts. L1 is
  -- designed for marketing/reminder emails, not for the payer's own
  -- transaction messages.
  if v_delivery.communication_category <> 'essential' then
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
  'M13.2 P5-2 + P9-1 + P9-3 + M13.3 R3 + 20261116120000: essential emails skip L1 (per-address rate limit). A payer who makes two payments in one day must receive both receipts. L1 is designed for marketing/reminder emails, not for the payer''s own transaction messages. All other limits (suppression, L2–L5) still apply.';

revoke all on function app.reserve_email_attempt(uuid) from public;
revoke execute on function app.reserve_email_attempt(uuid) from anon, authenticated;


-- ── 2. Add provider and access code to payment_notification_context ─────────
--
-- The worker needs the Paystack access code to build the checkout URL for the
-- "payment started" email. The provider name tells the worker which URL base
-- to use (paystack → https://checkout.paystack.com/{code}).
--
-- DROP + CREATE because create or replace cannot add return columns.

drop function if exists app.payment_notification_context(uuid);

create function app.payment_notification_context(p_attempt_id uuid)
returns table (
  attempt_id           uuid,
  community_id         uuid,
  community_name       text,
  community_slug       text,
  collection_name      text,
  collection_slug      text,
  reference            text,
  status               text,
  contributor_name     text,
  contributor_email    text,
  amount_kobo          bigint,
  contribution_kobo    bigint,
  platform_fee_kobo    bigint,
  gateway_fee_kobo     bigint,
  vat_kobo             bigint,
  total_fees_kobo      bigint,
  fee_bearer           text,
  paid_at              timestamptz,
  channel              text,
  failure_code         text,
  review_reason        text,
  provider             text,
  provider_access_code text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_payment_operator_session();
  return query
  select a.id, a.community_id, cm.name::text, cm.slug::text, co.name::text, co.slug::text,
         a.reference, a.status::text,
         i.contributor_name::text, i.contributor_email::text,
         a.amount_kobo::bigint, a.contribution_kobo::bigint, a.platform_fee_kobo::bigint,
         a.gateway_fee_kobo::bigint, a.vat_kobo::bigint, a.total_fees_kobo::bigint, a.fee_bearer::text,
         c.captured_at, t.channel, a.failure_code, a.review_reason,
         a.provider::text, a.provider_access_code
  from public.payment_attempts a
  join public.contribution_intents i on i.id = a.intent_id
  join public.communities cm on cm.id = a.community_id
  join public.collections co on co.id = a.collection_id
  left join public.contributions c on c.attempt_id = a.id
  left join lateral (
    select pt.channel from public.provider_transactions pt
    where pt.attempt_id = a.id and pt.status_mapped = 'succeeded'
    order by pt.observed_at desc, pt.id desc
    limit 1
  ) t on true
  where a.id = p_attempt_id;
end;
$$;

revoke all on function app.payment_notification_context(uuid) from public;
revoke execute on function app.payment_notification_context(uuid) from public, anon, authenticated;

comment on function app.payment_notification_context(uuid) is
  '20261116120000: adds provider and provider_access_code to the return columns (checkout URL for the payer email). Otherwise identical to 20261116100000.';
