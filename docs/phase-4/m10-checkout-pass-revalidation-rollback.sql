-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK for supabase migration 20261125100000_m10_checkout_pass_revalidation
--
-- NOT a migration. Kept outside supabase/migrations so the CLI never applies it.
-- Run only with the owner's explicit approval, against one named environment,
-- in one transaction (psql -1 / begin … commit).
--
-- Order: revert the web and package code FIRST. The old code calls
-- app.create_payment_attempt with 22 arguments; while the M10 function exists
-- that resolves to it (p_access_token defaults to null) and managed checkout
-- fails closed with MEMBER_PROOF_EXPIRED while public checkout keeps working.
-- Running this file while the M10 code is still live breaks every checkout
-- (the 23-argument call no longer exists).
--
-- Restores, verbatim from 20261111100100_payment_functions.sql lines 259–661:
-- the 22-argument function, its revoke and its comment; and the
-- membership_access_grants table comment from 20261123100100 line 944.
-- No row is written, changed or removed by M10 or by this rollback, except the
-- schema_migrations bookkeeping row.
-- ─────────────────────────────────────────────────────────────────────────────

drop function app.create_payment_attempt(
  uuid, text, text, text, uuid, text, text, text, jsonb, text[], jsonb, bigint,
  bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, public.fee_mode, text, text
);

create or replace function app.create_payment_attempt(
  p_collection_id               uuid,
  p_checkout_key                text,
  p_reference                   text,
  p_provider                    text,
  p_member_id                   uuid,
  p_contributor_name            text,
  p_contributor_email           text,
  p_contributor_phone           text,
  p_answers                     jsonb,
  p_attendee_names              text[],
  p_lines                       jsonb,      -- [{"tier_id": uuid, "quantity": n}] or [{"item_id": …}]; null otherwise
  p_open_amount_kobo            bigint,     -- open_amount only
  p_contribution_kobo           bigint,
  p_platform_fee_kobo           bigint,
  p_gateway_fee_kobo            bigint,
  p_vat_kobo                    bigint,
  p_total_fees_kobo             bigint,
  p_total_payable_kobo          bigint,
  p_net_kobo                    bigint,
  p_provider_cost_estimate_kobo bigint,
  p_fee_bearer                  public.fee_mode,
  p_fee_schedule_version        text
)
returns table (
  attempt_id            uuid,
  reference             text,
  status                public.payment_attempt_status,
  amount_kobo           bigint,
  provider_access_code  text,
  reused                boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now          timestamptz := now();
  v_collection   public.collections%rowtype;
  v_community_ok boolean;
  v_limits       public.payment_limits;
  v_member       record;
  v_obligation   public.obligations%rowtype;
  v_base         bigint := 0;
  v_line         jsonb;
  v_line_no      integer := 0;
  v_tier         public.collection_tiers%rowtype;
  v_item         public.collection_items%rowtype;
  v_qty          integer;
  v_remaining    integer;
  v_units        integer := 0;
  v_seen         uuid[] := '{}';
  v_target_ids   uuid[] := '{}';
  v_lines        jsonb := '[]'::jsonb;
  v_raised       bigint;
  v_intent_id    uuid;
  v_attempt      public.payment_attempts%rowtype;
  v_attendees    text[] := coalesce(p_attendee_names, '{}');
begin
  perform app.assert_payment_operator_session();

  -- ── The collection, read under a share lock so its status cannot change
  --    underneath this transaction.
  select * into v_collection from public.collections where id = p_collection_id for share;
  if not found then
    raise exception 'COLLECTION_NOT_FOUND: %', p_collection_id using errcode = 'P0001';
  end if;

  select exists (select 1 from public.communities c where c.id = v_collection.community_id and c.status = 'active')
    into v_community_ok;
  if not v_community_ok or v_collection.visibility not in ('public', 'unlisted') then
    raise exception 'COLLECTION_NOT_FOUND: %', p_collection_id using errcode = 'P0001';
  end if;
  if v_collection.status <> 'active' then
    raise exception 'COLLECTION_NOT_ACTIVE: collection % is %', p_collection_id, v_collection.status using errcode = 'P0001';
  end if;
  -- F5 / D-23: a collection imported from the previous system finishes there.
  -- No collection takes money in both systems.
  if v_collection.is_imported then
    raise exception 'COLLECTION_IMPORTED: collection % was imported from the previous system and takes no payments here',
      p_collection_id using errcode = 'P0001';
  end if;

  case app.collection_window_state(v_collection.starts_at, v_collection.deadline_at, v_now)
    when 'not_yet_open' then
      raise exception 'COLLECTION_NOT_YET_OPEN: contributions open on %',
        (v_collection.starts_at at time zone 'Africa/Lagos')::date using errcode = 'P0001';
    when 'closed' then
      raise exception 'COLLECTION_WINDOW_CLOSED: contributions closed at the end of %',
        (v_collection.deadline_at at time zone 'Africa/Lagos')::date using errcode = 'P0001';
    else null;
  end case;

  if v_collection.close_when_target_reached then
    select coalesce(sum(c.contribution_kobo), 0) into v_raised
    from public.contributions c where c.collection_id = p_collection_id and c.status = 'applied';
    if v_raised >= v_collection.target_amount_kobo then
      raise exception 'TARGET_REACHED: this fundraiser has reached its goal' using errcode = 'P0001';
    end if;
  end if;

  -- Partial payments are DEFERRED (D-19): whatever payment_plan says, the
  -- amount below is always the full amount owed, and nothing here ever writes
  -- in_installments.

  -- ── Who is paying. A managed collection names its members; the id came
  --    from the server's signed cookie and is re-checked here, now.
  if v_collection.audience_mode <> 'public' then
    if p_member_id is null then
      raise exception 'MEMBER_REQUIRED: this collection asks named members' using errcode = 'P0001';
    end if;
    select * into v_member from app.get_collection_member_context(p_collection_id, p_member_id) limit 1;
    if v_member.member_id is null then
      raise exception 'MEMBER_NOT_ELIGIBLE: member % cannot contribute to collection %', p_member_id, p_collection_id
        using errcode = 'P0001';
    end if;
    if v_member.obligation_id is not null then
      select * into v_obligation from public.obligations where id = v_member.obligation_id;
    end if;
  elsif p_member_id is not null then
    raise exception 'MEMBER_NOT_EXPECTED: an open collection does not identify members' using errcode = 'P0001';
  end if;

  if v_collection.schedule = 'recurring' and v_obligation.id is null then
    raise exception 'NOTHING_OWED: there is no open period to pay for' using errcode = 'P0001';
  end if;

  -- ── The base amount, re-derived from rows. The server's figure is only
  --    compared against this, never used in its place.
  if v_collection.amount_model in ('tiers', 'items') then
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
      raise exception 'LINES_REQUIRED: choose at least one option' using errcode = 'P0001';
    end if;
    if jsonb_array_length(p_lines) > 50 then
      raise exception 'TOO_MANY_LINES: at most 50 lines in one order' using errcode = 'P0001';
    end if;
  elsif p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
    raise exception 'LINES_NOT_EXPECTED: this collection does not sell options or items' using errcode = 'P0001';
  end if;

  if v_collection.amount_model = 'open_amount' then
    if p_open_amount_kobo is null or p_open_amount_kobo <= 0 then
      raise exception 'AMOUNT_REQUIRED: enter an amount' using errcode = 'P0001';
    end if;
    if v_collection.min_amount_kobo is not null and p_open_amount_kobo < v_collection.min_amount_kobo then
      raise exception 'AMOUNT_BELOW_MINIMUM: the minimum is % kobo', v_collection.min_amount_kobo using errcode = 'P0001';
    end if;
    if v_collection.max_amount_kobo is not null and p_open_amount_kobo > v_collection.max_amount_kobo then
      raise exception 'AMOUNT_ABOVE_MAXIMUM: the maximum is % kobo', v_collection.max_amount_kobo using errcode = 'P0001';
    end if;
    v_base := p_open_amount_kobo;
  elsif p_open_amount_kobo is not null then
    raise exception 'AMOUNT_NOT_EXPECTED: this collection sets its own amount' using errcode = 'P0001';
  end if;

  if v_collection.amount_model in ('fixed', 'per_member') then
    if v_obligation.id is not null then
      if v_obligation.status = 'paid' then
        raise exception 'ALREADY_PAID: this has already been paid in full' using errcode = 'P0001';
      elsif v_obligation.status = 'exempt' then
        raise exception 'OBLIGATION_EXEMPT: there is nothing to pay' using errcode = 'P0001';
      elsif v_obligation.status = 'cancelled' then
        raise exception 'NOTHING_OWED: this is no longer being asked' using errcode = 'P0001';
      elsif v_obligation.status = 'in_installments' then
        raise exception 'INSTALLMENTS_NOT_SUPPORTED: partial payments are not available (D-19)' using errcode = 'P0001';
      end if;
      v_base := v_obligation.expected_amount_kobo - v_obligation.waived_amount_kobo;
      if v_base <= 0 then
        raise exception 'NOTHING_OWED: the balance has been fully waived' using errcode = 'P0001';
      end if;
    elsif v_collection.amount_model = 'per_member' then
      raise exception 'NOTHING_OWED: no amount has been set for you on this collection' using errcode = 'P0001';
    else
      if coalesce(v_collection.fixed_amount_kobo, 0) <= 0 then
        raise exception 'MISCONFIGURED: this collection has no contribution amount set' using errcode = 'P0001';
      end if;
      v_base := v_collection.fixed_amount_kobo;
    end if;
  end if;

  if v_collection.amount_model in ('tiers', 'items') then
    -- Collect ids first and lock their rows in id order, so two baskets that
    -- share tiers cannot deadlock against each other.
    for v_line in select * from jsonb_array_elements(p_lines) loop
      if v_collection.amount_model = 'tiers' then
        v_target_ids := v_target_ids || (v_line ->> 'tier_id')::uuid;
      else
        v_target_ids := v_target_ids || (v_line ->> 'item_id')::uuid;
      end if;
    end loop;
    if array_position(v_target_ids, null) is not null then
      raise exception 'LINE_INVALID: every line needs a % id',
        case when v_collection.amount_model = 'tiers' then 'tier' else 'item' end using errcode = 'P0001';
    end if;
    if v_collection.amount_model = 'tiers' then
      perform 1 from public.collection_tiers where id = any (v_target_ids) order by id for update;
    else
      perform 1 from public.collection_items where id = any (v_target_ids) order by id for update;
    end if;

    for v_line in select * from jsonb_array_elements(p_lines) loop
      v_line_no := v_line_no + 1;
      if coalesce(jsonb_typeof(v_line -> 'quantity'), 'missing') <> 'number'
         or coalesce(v_line ->> 'quantity', '') !~ '^[0-9]{1,4}$' then
        raise exception 'QUANTITY_INVALID: line % quantity must be a whole number', v_line_no using errcode = 'P0001';
      end if;
      v_qty := (v_line ->> 'quantity')::integer;
      if v_qty < 1 or v_qty > 1000 then
        raise exception 'QUANTITY_INVALID: line % quantity must be between 1 and 1000', v_line_no using errcode = 'P0001';
      end if;

      if v_collection.amount_model = 'tiers' then
        select * into v_tier from public.collection_tiers
        where id = (v_line ->> 'tier_id')::uuid and collection_id = p_collection_id;
        if not found or v_tier.hidden then
          raise exception 'TIER_NOT_AVAILABLE: line % names an option this collection does not offer', v_line_no
            using errcode = 'P0001';
        end if;
        if v_tier.id = any (v_seen) then
          raise exception 'DUPLICATE_LINE: an option appears twice' using errcode = 'P0001';
        end if;
        v_seen := v_seen || v_tier.id;
        if v_tier.per_order_limit is not null and v_qty > v_tier.per_order_limit then
          raise exception 'PER_ORDER_LIMIT: at most % of "%" in one order', v_tier.per_order_limit, v_tier.name
            using errcode = 'P0001';
        end if;
        v_remaining := app.stock_remaining(v_tier.id, null, null, v_now);
        if v_remaining is not null and v_qty > v_remaining then
          raise exception 'SOLD_OUT: only % of "%" left', greatest(v_remaining, 0), v_tier.name using errcode = 'P0001';
        end if;
        v_lines := v_lines || jsonb_build_object(
          'line_no', v_line_no, 'tier_id', v_tier.id, 'item_id', null, 'quantity', v_qty,
          'unit_price_kobo', v_tier.price_kobo, 'limited', v_tier.quantity_limit is not null);
        v_base := v_base + v_tier.price_kobo * v_qty;
      else
        select * into v_item from public.collection_items
        where id = (v_line ->> 'item_id')::uuid and collection_id = p_collection_id;
        if not found or v_item.hidden then
          raise exception 'ITEM_NOT_AVAILABLE: line % names an item this collection does not sell', v_line_no
            using errcode = 'P0001';
        end if;
        if v_item.id = any (v_seen) then
          raise exception 'DUPLICATE_LINE: an item appears twice' using errcode = 'P0001';
        end if;
        v_seen := v_seen || v_item.id;
        if v_item.max_per_order is not null and v_qty > v_item.max_per_order then
          raise exception 'PER_ORDER_LIMIT: at most % of "%" in one order', v_item.max_per_order, v_item.name
            using errcode = 'P0001';
        end if;
        v_remaining := app.stock_remaining(null, v_item.id, null, v_now);
        if v_remaining is not null and v_qty > v_remaining then
          raise exception 'SOLD_OUT: only % of "%" left', greatest(v_remaining, 0), v_item.name using errcode = 'P0001';
        end if;
        v_lines := v_lines || jsonb_build_object(
          'line_no', v_line_no, 'tier_id', null, 'item_id', v_item.id, 'quantity', v_qty,
          'unit_price_kobo', v_item.price_kobo, 'limited', v_item.quantity_available is not null);
        v_base := v_base + v_item.price_kobo * v_qty;
      end if;
      v_units := v_units + v_qty;
    end loop;
  end if;

  -- Attendee names: one per ticket unit, only when the event asks (§18).
  if v_collection.collect_attendee_details and v_collection.amount_model = 'tiers' then
    if coalesce(array_length(v_attendees, 1), 0) <> v_units
       or exists (select 1 from unnest(v_attendees) n where n is null or char_length(btrim(n)) not between 1 and 120) then
      raise exception 'ATTENDEE_COUNT_MISMATCH: % names needed, % given', v_units, coalesce(array_length(v_attendees, 1), 0)
        using errcode = 'P0001';
    end if;
  elsif coalesce(array_length(v_attendees, 1), 0) > 0 then
    raise exception 'ATTENDEES_NOT_EXPECTED: this collection does not collect attendee names' using errcode = 'P0001';
  end if;

  -- ── The impossible-state guard (legacy pricingService, kept): the server's
  --    belief must equal the database's, to the kobo.
  if p_contribution_kobo is distinct from v_base then
    raise exception 'AMOUNT_MISMATCH: expected % kobo, was asked for % kobo — the page is stale', v_base, p_contribution_kobo
      using errcode = 'P0001';
  end if;

  -- ── The frozen fee breakdown: right bearer, right schedule, consistent
  --    arithmetic. Rates are fees.ts's alone (D-12).
  if p_fee_bearer is distinct from v_collection.fee_mode then
    raise exception 'FEE_BEARER_MISMATCH: collection is %, breakdown says %', v_collection.fee_mode, p_fee_bearer
      using errcode = 'P0001';
  end if;
  if p_fee_schedule_version is distinct from app.current_fee_schedule_version() then
    raise exception 'FEE_SCHEDULE_NOT_CURRENT: % is not the schedule in force (%)', p_fee_schedule_version,
      app.current_fee_schedule_version() using errcode = 'P0001';
  end if;
  if p_platform_fee_kobo is null or p_gateway_fee_kobo is null or p_vat_kobo is null
     or p_total_fees_kobo is null or p_total_payable_kobo is null or p_net_kobo is null
     or p_provider_cost_estimate_kobo is null
     or p_platform_fee_kobo < 0 or p_gateway_fee_kobo < 0 or p_vat_kobo < 0 or p_provider_cost_estimate_kobo < 0
     or p_total_fees_kobo <> p_platform_fee_kobo + p_gateway_fee_kobo + p_vat_kobo
     or (p_fee_bearer = 'contributor_pays'
         and (p_total_payable_kobo <> v_base + p_total_fees_kobo or p_net_kobo <> v_base))
     or (p_fee_bearer = 'community_absorbs'
         and (p_total_payable_kobo <> v_base or p_net_kobo <> v_base - p_total_fees_kobo or p_net_kobo < 0)) then
    raise exception 'FEE_BREAKDOWN_INVALID: the fee breakdown does not add up' using errcode = 'P0001';
  end if;

  v_limits := app.current_payment_limits();
  if v_limits.version is null then
    raise exception 'PAYMENT_LIMITS_MISSING: no payment limits are in force' using errcode = 'P0001';
  end if;
  if p_total_payable_kobo > v_limits.max_payment_kobo then
    raise exception 'PAYMENT_ABOVE_CEILING: % kobo exceeds the % kobo per-payment limit',
      p_total_payable_kobo, v_limits.max_payment_kobo using errcode = 'P0001';
  end if;

  -- Name, email and phone are all required (owner decision 2026-11-11). The
  -- table enforces it too; this gives the caller a code instead of a raw
  -- not-null violation.
  if nullif(btrim(p_contributor_name), '') is null
     or nullif(btrim(p_contributor_email), '') is null
     or nullif(btrim(p_contributor_phone), '') is null then
    raise exception 'CONTACT_REQUIRED: name, email address and phone number are all required' using errcode = 'P0001';
  end if;

  -- ── Idempotency: the unique index decides (D-25). A double-click returns
  --    the attempt the first click created.
  insert into public.contribution_intents (
    community_id, collection_id, checkout_idempotency_key, member_id,
    contributor_name, contributor_email, contributor_phone, answers, attendee_names
  ) values (
    v_collection.community_id, p_collection_id, p_checkout_key, p_member_id,
    btrim(p_contributor_name), nullif(btrim(p_contributor_email), ''), nullif(btrim(p_contributor_phone), ''),
    coalesce(p_answers, '{}'::jsonb), v_attendees
  )
  on conflict (collection_id, checkout_idempotency_key) do nothing
  returning id into v_intent_id;

  if v_intent_id is null then
    select a.* into v_attempt
    from public.contribution_intents i
    join public.payment_attempts a on a.intent_id = i.id
    where i.collection_id = p_collection_id and i.checkout_idempotency_key = p_checkout_key;

    if v_attempt.id is null
       or v_attempt.contribution_kobo <> v_base
       or v_attempt.amount_kobo <> p_total_payable_kobo
       or v_attempt.member_id is distinct from p_member_id then
      raise exception 'CHECKOUT_KEY_REUSED: this checkout key was used for a different payment' using errcode = 'P0001';
    end if;

    return query select v_attempt.id, v_attempt.reference, v_attempt.status, v_attempt.amount_kobo::bigint,
                        v_attempt.provider_access_code, true;
    return;
  end if;

  begin
    insert into public.payment_attempts (
      intent_id, community_id, collection_id, reference, provider,
      amount_kobo, contribution_kobo, platform_fee_kobo, gateway_fee_kobo, vat_kobo,
      total_fees_kobo, net_kobo, provider_cost_estimate_kobo, fee_bearer, fee_schedule_version,
      payment_limits_version, member_id, obligation_id, cycle_key,
      hold_expires_at, check_until
    ) values (
      v_intent_id, v_collection.community_id, p_collection_id, p_reference, p_provider,
      p_total_payable_kobo, v_base, p_platform_fee_kobo, p_gateway_fee_kobo, p_vat_kobo,
      p_total_fees_kobo, p_net_kobo, p_provider_cost_estimate_kobo, p_fee_bearer, p_fee_schedule_version,
      v_limits.version, p_member_id, v_obligation.id, v_obligation.cycle_key,
      v_now + make_interval(mins => v_limits.hold_minutes),
      v_now + make_interval(hours => v_limits.check_window_hours)
    )
    returning * into v_attempt;
  exception when unique_violation then
    if sqlerrm like '%payment_attempts_one_live_per_obligation%' then
      raise exception 'PAYMENT_IN_PROGRESS: a payment for this is already in progress' using errcode = 'P0001';
    elsif sqlerrm like '%payment_attempts_reference_key%' then
      raise exception 'REFERENCE_COLLISION: generate a new reference' using errcode = 'P0001';
    end if;
    raise;
  end;

  insert into public.payment_attempt_lines (attempt_id, line_no, tier_id, item_id, quantity, unit_price_kobo, amount_kobo)
  select v_attempt.id, (l ->> 'line_no')::smallint, (l ->> 'tier_id')::uuid, (l ->> 'item_id')::uuid,
         (l ->> 'quantity')::integer, (l ->> 'unit_price_kobo')::bigint,
         (l ->> 'unit_price_kobo')::bigint * (l ->> 'quantity')::integer
  from jsonb_array_elements(v_lines) l;

  insert into public.stock_reservations (attempt_id, line_no, tier_id, item_id, quantity, expires_at)
  select v_attempt.id, (l ->> 'line_no')::smallint, (l ->> 'tier_id')::uuid, (l ->> 'item_id')::uuid,
         (l ->> 'quantity')::integer, v_attempt.hold_expires_at
  from jsonb_array_elements(v_lines) l
  where (l ->> 'limited')::boolean;

  return query select v_attempt.id, v_attempt.reference, v_attempt.status, v_attempt.amount_kobo::bigint,
                      v_attempt.provider_access_code, false;
end;
$$;
revoke execute on function app.create_payment_attempt(
  uuid, text, text, text, uuid, text, text, text, jsonb, text[], jsonb, bigint,
  bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, public.fee_mode, text
) from public, anon, authenticated;

comment on function app.create_payment_attempt(
  uuid, text, text, text, uuid, text, text, text, jsonb, text[], jsonb, bigint,
  bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, public.fee_mode, text
) is
  'Plan §4.3 step 8. One transaction: collection share-locked and re-checked (status, D-29 window, D-30 target); member and obligation re-resolved; base amount re-derived by id and compared to the kobo; fee breakdown checked (bearer, current schedule, arithmetic, ceiling); stock locked and reserved; intent + attempt + lines written. Idempotent on (collection, checkout key). Server connection only.';

comment on table public.membership_access_grants is
  'F6.2: a 30-minute pass for one member on one collection, made by a successful membership ID check. The raw token is returned once and never stored (SHA-256 only). Not consumed by any payment code yet (Phase 3/4).';

delete from supabase_migrations.schema_migrations where version = '20261125100000';
