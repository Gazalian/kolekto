-- ─────────────────────────────────────────────────────────────────────────────
-- 20261111100100 — M8.4: payment attempt and capture functions
--
-- The only writers of the tables created in 20261111100000. Design:
-- docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md §4.3–§4.9.
--
--   app.create_payment_attempt        validate → re-derive amount by id → check
--                                     the frozen fee breakdown → reserve stock →
--                                     intent + attempt + lines, ONE transaction.
--                                     Idempotent on (collection, checkout key).
--   app.mark_payment_attempt_initialized   created → initialized (checkout issued)
--   app.mark_payment_attempt_failed        created|initialized → failed; releases stock
--   app.expire_payment_attempt             created|initialized → expired; releases stock
--   app.record_provider_transaction   "T1": store what the provider said and move
--                                     the attempt to captured / failed / needs_review.
--                                     Money is recorded before anything that might
--                                     fail on its effects.
--   app.complete_payment_capture      "T2": contribution, lines, stock conversion,
--                                     obligation → paid, balanced journals, D-30
--                                     target close, completed. All or nothing;
--                                     exactly once per attempt.
--
-- ── WHO MAY CALL THESE ──────────────────────────────────────────────────────
--
-- Nobody through a client role. Every function is SECURITY DEFINER, has
-- EXECUTE revoked from public, anon and authenticated, AND refuses to run
-- unless the session role is the connection's own (`none`) — the same
-- operator-session idiom as the SES ingest functions (20261023120000). The
-- orchestrator reaches them only through `withOwnerConnection` on the server.
-- A contributor's browser can never mark its own payment successful: there is
-- no grant, no PostgREST exposure of `app`, and a role check behind both.
--
-- ── WHAT THE DATABASE TRUSTS THE SERVER FOR, AND WHAT IT DOES NOT ───────────
--
-- Trusted: the fee breakdown's RATES (D-12 — fees.ts is the one fee
-- implementation; SQL never multiplies by a rate). Checked here: that the
-- breakdown is arithmetically consistent, uses the collection's own bearer and
-- the schedule currently in force, and is within the platform ceiling.
--
-- Not trusted, re-derived here from rows: the base amount (by tier/item id,
-- obligation, or collection min/max), stock, the member's eligibility and
-- obligation, the collection's status and window.
--
-- ── D-29 WINDOW, BEFORE THE DATE COLUMNS EXIST ──────────────────────────────
--
-- D-29 makes opening/closing calendar dates in Africa/Lagos: open from 00:00 on
-- the opening date, through the end of the closing date. The date columns
-- (opens_on / closes_on) are a later migration; until then the window is the
-- Lagos calendar date of starts_at / deadline_at, which is exactly what that
-- migration's backfill will produce, so behaviour does not change when it lands.
--
-- ── LEDGER POSTINGS (D-28) ──────────────────────────────────────────────────
--
--   capture        Dr provider_receivable  total charged
--                  Cr collection_pending   total charged
--   fee            Dr collection_pending   total fees (shown lines)
--                  Cr platform_fee_income  platform + processing
--                  Cr vat_payable          vat (zero today, D-14)
--   provider_fee   Dr provider_fee_expense provider's fee (reported, else estimate)
--                  Cr provider_receivable  same
--
-- collection_pending therefore ends at net_kobo for either bearer, and
-- provider_receivable at what the provider will actually settle. Each journal
-- names the collection and is unique on its idempotency key.
--
-- Additive. Rollback: drop the functions created here and restore
-- app.block_manual_paid_status from 20260919120000 (shown below as replaced).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 0. Helpers ──────────────────────────────────────────────────────────────

create or replace function app.assert_payment_operator_session()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(nullif(current_setting('role', true), ''), 'none') <> 'none' then
    raise exception 'FORBIDDEN: payment functions run only on the server''s own connection, never as %',
      current_setting('role', true)
      using errcode = '42501';
  end if;
end;
$$;
revoke execute on function app.assert_payment_operator_session() from public, anon, authenticated;

comment on function app.assert_payment_operator_session() is
  'Refuses any session that has switched to a client role (anon, authenticated, …). Defence in depth behind the EXECUTE revokes: a stray grant must still not make a payment function client-callable.';

create or replace function app.current_payment_limits()
returns public.payment_limits
language sql
stable
security definer
set search_path = ''
as $$
  select l.* from public.payment_limits l
  where l.effective_from <= now()
  order by l.effective_from desc
  limit 1;
$$;
revoke execute on function app.current_payment_limits() from public, anon, authenticated;

create or replace function app.current_fee_schedule_version()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.version from public.fee_schedules s
  where s.effective_from <= (now() at time zone 'Africa/Lagos')::date
  order by s.effective_from desc
  limit 1;
$$;
revoke execute on function app.current_fee_schedule_version() from public, anon, authenticated;

comment on function app.current_fee_schedule_version() is
  'The fee schedule in force today (Africa/Lagos calendar day). A new attempt must be priced with exactly this version.';

-- D-29: the window as Lagos calendar dates. Pure; the caller passes now.
create or replace function app.collection_window_state(p_starts_at timestamptz, p_deadline_at timestamptz, p_now timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_starts_at is not null
     and p_now < ((p_starts_at at time zone 'Africa/Lagos')::date)::timestamp at time zone 'Africa/Lagos'
      then 'not_yet_open'
    when p_deadline_at is not null
     and p_now >= (((p_deadline_at at time zone 'Africa/Lagos')::date + 1))::timestamp at time zone 'Africa/Lagos'
      then 'closed'
    else 'open'
  end;
$$;
revoke execute on function app.collection_window_state(timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

-- One account per (scope, code), created on first use. The chart's own trigger
-- refuses a code at the wrong scope.
create or replace function app.ensure_ledger_account(p_community_id uuid, p_collection_id uuid, p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_type public.ledger_account_type;
begin
  select id into v_id from public.ledger_accounts
  where community_id is not distinct from p_community_id
    and collection_id is not distinct from p_collection_id
    and code = p_code;
  if v_id is not null then
    return v_id;
  end if;

  select type into v_type from public.ledger_account_codes where code = p_code;
  if v_type is null then
    raise exception 'UNKNOWN_LEDGER_ACCOUNT_CODE: %', p_code using errcode = 'P0001';
  end if;

  insert into public.ledger_accounts (community_id, collection_id, code, type)
  values (p_community_id, p_collection_id, p_code, v_type)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost a race to a concurrent creator; the unique index decided, read its row.
    select id into v_id from public.ledger_accounts
    where community_id is not distinct from p_community_id
      and collection_id is not distinct from p_collection_id
      and code = p_code;
  end if;
  return v_id;
end;
$$;
revoke execute on function app.ensure_ledger_account(uuid, uuid, text) from public, anon, authenticated;

-- One journal and its entries in ONE statement, so the journal never exists
-- without its entries even in a session that has set constraints immediate.
-- Zero-amount lines are dropped (ledger entries are strictly positive); the
-- balance trigger still checks Σ debits = Σ credits.
create or replace function app.post_payment_journal(
  p_community_id   uuid,
  p_collection_id  uuid,
  p_occurred_at    timestamptz,
  p_source_type    public.ledger_source_type,
  p_source_id      uuid,
  p_reason         text,
  p_fee_schedule   text,
  p_idempotency    text,
  p_entries        jsonb
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  with j as (
    insert into public.ledger_journals (community_id, collection_id, occurred_at, source_type, source_id, reason,
                                        actor_type, actor_name_snapshot, fee_schedule_version, idempotency_key)
    values (p_community_id, p_collection_id, p_occurred_at, p_source_type, p_source_id, p_reason,
            'system', 'Kolekto payments', p_fee_schedule, p_idempotency)
    returning id
  ), e as (
    insert into public.ledger_entries (journal_id, account_id, direction, amount_kobo)
    select j.id, (x ->> 'account_id')::uuid, (x ->> 'direction')::public.ledger_direction, (x ->> 'amount_kobo')::bigint
    from j cross join jsonb_array_elements(p_entries) x
    where (x ->> 'amount_kobo')::bigint > 0
    returning 1
  )
  select j.id from j;
$$;
revoke execute on function app.post_payment_journal(
  uuid, uuid, timestamptz, public.ledger_source_type, uuid, text, text, text, jsonb
) from public, anon, authenticated;

-- Stock remaining on one tier or item, NOT counting p_exclude_attempt's own
-- reservation. Caller must hold the tier/item row lock.
create or replace function app.stock_remaining(p_tier_id uuid, p_item_id uuid, p_exclude_attempt uuid, p_now timestamptz)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_held  integer;
begin
  if p_tier_id is not null then
    select quantity_limit into v_limit from public.collection_tiers where id = p_tier_id;
  else
    select quantity_available into v_limit from public.collection_items where id = p_item_id;
  end if;
  if v_limit is null then
    return null;  -- unlimited
  end if;

  select coalesce(sum(r.quantity), 0) into v_held
  from public.stock_reservations r
  where (r.tier_id = p_tier_id or r.item_id = p_item_id)
    and r.attempt_id is distinct from p_exclude_attempt
    and (r.status = 'converted' or (r.status = 'reserved' and r.expires_at > p_now));

  return v_limit - v_held;
end;
$$;
revoke execute on function app.stock_remaining(uuid, uuid, uuid, timestamptz) from public, anon, authenticated;


-- ── 1. Create a payment attempt ─────────────────────────────────────────────

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


-- ── 2. Small transitions ────────────────────────────────────────────────────

create or replace function app.mark_payment_attempt_initialized(p_attempt_id uuid, p_access_code text)
returns public.payment_attempt_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.payment_attempts%rowtype;
begin
  perform app.assert_payment_operator_session();
  select * into v_attempt from public.payment_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'PAYMENT_ATTEMPT_NOT_FOUND: %', p_attempt_id using errcode = 'P0001';
  end if;
  if v_attempt.status = 'created' then
    update public.payment_attempts
       set status = 'initialized', provider_access_code = nullif(btrim(p_access_code), '')
     where id = p_attempt_id;
    return 'initialized';
  end if;
  -- Already moved on (initialized by a retry, or captured by a fast webhook):
  -- nothing to do, and never a step backwards.
  return v_attempt.status;
end;
$$;
revoke execute on function app.mark_payment_attempt_initialized(uuid, text) from public, anon, authenticated;

create or replace function app.release_payment_attempt_stock(p_attempt_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.stock_reservations set status = 'released'
  where attempt_id = p_attempt_id and status = 'reserved';
$$;
revoke execute on function app.release_payment_attempt_stock(uuid) from public, anon, authenticated;

create or replace function app.mark_payment_attempt_failed(p_attempt_id uuid, p_failure_code text)
returns public.payment_attempt_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.payment_attempts%rowtype;
begin
  perform app.assert_payment_operator_session();
  select * into v_attempt from public.payment_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'PAYMENT_ATTEMPT_NOT_FOUND: %', p_attempt_id using errcode = 'P0001';
  end if;
  if v_attempt.status in ('created', 'initialized') then
    update public.payment_attempts
       set status = 'failed', failure_code = left(coalesce(nullif(btrim(p_failure_code), ''), 'unspecified'), 120)
     where id = p_attempt_id;
    perform app.release_payment_attempt_stock(p_attempt_id);
    return 'failed';
  end if;
  -- Never overwrite a money-known state with a failure.
  return v_attempt.status;
end;
$$;
revoke execute on function app.mark_payment_attempt_failed(uuid, text) from public, anon, authenticated;

create or replace function app.expire_payment_attempt(p_attempt_id uuid)
returns public.payment_attempt_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.payment_attempts%rowtype;
begin
  perform app.assert_payment_operator_session();
  select * into v_attempt from public.payment_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'PAYMENT_ATTEMPT_NOT_FOUND: %', p_attempt_id using errcode = 'P0001';
  end if;
  if v_attempt.status in ('created', 'initialized') then
    if now() < v_attempt.hold_expires_at then
      raise exception 'PAYMENT_ATTEMPT_STILL_HELD: attempt % holds until %', p_attempt_id, v_attempt.hold_expires_at
        using errcode = 'P0001';
    end if;
    update public.payment_attempts set status = 'expired' where id = p_attempt_id;
    perform app.release_payment_attempt_stock(p_attempt_id);
    return 'expired';
  end if;
  return v_attempt.status;
end;
$$;
revoke execute on function app.expire_payment_attempt(uuid) from public, anon, authenticated;


-- ── 3. T1: record what the provider said ────────────────────────────────────

create or replace function app.record_provider_transaction(
  p_reference               text,
  p_provider                text,
  p_provider_transaction_id text,
  p_provider_reference      text,
  p_status_mapped           text,
  p_status_raw              text,
  p_amount_kobo             bigint,
  p_currency                text,
  p_provider_fee_kobo       bigint,
  p_paid_at                 timestamptz,
  p_channel                 text,
  p_authorization_hash      text,
  p_payload                 jsonb
)
returns table (attempt_id uuid, status public.payment_attempt_status, review_reason text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_attempt public.payment_attempts%rowtype;
  v_hash    text;
  v_reason  text;
begin
  perform app.assert_payment_operator_session();

  -- By OUR reference, never by metadata (L-unattributed). An unknown reference
  -- creates nothing; the caller records it as an orphan event.
  select * into v_attempt from public.payment_attempts a where a.reference = p_reference for update;
  if not found then
    raise exception 'UNKNOWN_PAYMENT_REFERENCE: %', p_reference using errcode = 'P0001';
  end if;

  v_hash := encode(sha256(convert_to(concat_ws('|',
    p_provider, p_provider_transaction_id, p_provider_reference, p_status_mapped, p_status_raw,
    p_amount_kobo::text, p_currency, coalesce(p_provider_fee_kobo::text, '∅'),
    coalesce(to_char(p_paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '∅'),
    coalesce(p_channel, '∅'), coalesce(p_authorization_hash, '∅')), 'UTF8')), 'hex');

  insert into public.provider_transactions (
    attempt_id, provider, provider_transaction_id, provider_reference, status_mapped, status_raw,
    amount_kobo, currency, provider_fee_kobo, paid_at, channel, authorization_hash, content_hash, payload
  ) values (
    v_attempt.id, p_provider, p_provider_transaction_id, p_provider_reference, p_status_mapped, p_status_raw,
    p_amount_kobo, p_currency, p_provider_fee_kobo, p_paid_at, p_channel, p_authorization_hash, v_hash,
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (attempt_id, content_hash) do nothing;

  -- Terminal or parked: the evidence is kept, the state does not move. A
  -- reversal of a completed payment is for the (deferred) refund/dispute
  -- subsystem and an operator, not for this function.
  if v_attempt.status in ('completed', 'needs_review') then
    return query select v_attempt.id, v_attempt.status, v_attempt.review_reason;
    return;
  end if;

  if p_status_mapped = 'succeeded' then
    v_reason := case
      when p_provider is distinct from v_attempt.provider            then 'provider_mismatch'
      when p_provider_reference is distinct from v_attempt.reference then 'reference_mismatch'
      when p_currency is distinct from 'NGN'                         then 'currency_mismatch'
      when p_amount_kobo is distinct from v_attempt.amount_kobo      then 'amount_mismatch'
      else null
    end;
    if v_reason is not null then
      -- Money was taken but does not match the lock. Recorded, parked, visible;
      -- never accepted and never refused (PA-15: never convert currency).
      update public.payment_attempts set status = 'needs_review', review_reason = v_reason where id = v_attempt.id;
    elsif v_attempt.status in ('created', 'initialized', 'failed', 'expired') then
      update public.payment_attempts set status = 'captured' where id = v_attempt.id;
    end if;

  elsif p_status_mapped in ('failed', 'abandoned') then
    if v_attempt.status in ('created', 'initialized') then
      update public.payment_attempts set status = 'failed', failure_code = 'provider_' || p_status_mapped
       where id = v_attempt.id;
      perform app.release_payment_attempt_stock(v_attempt.id);
    end if;

  elsif p_status_mapped = 'reversed' then
    update public.payment_attempts set status = 'needs_review', review_reason = 'provider_reversed' where id = v_attempt.id;

  elsif p_status_mapped = 'unrecognised' then
    update public.payment_attempts set status = 'needs_review', review_reason = 'provider_status_unrecognised'
     where id = v_attempt.id;
  end if;
  -- 'pending': evidence only.

  return query select a.id, a.status, a.review_reason from public.payment_attempts a where a.id = v_attempt.id;
end;
$$;
revoke execute on function app.record_provider_transaction(
  text, text, text, text, text, text, bigint, text, bigint, timestamptz, text, text, jsonb
) from public, anon, authenticated;

comment on function app.record_provider_transaction(
  text, text, text, text, text, text, bigint, text, bigint, timestamptz, text, text, jsonb
) is
  'Plan §4.7 T1. Locks the attempt BY REFERENCE, stores the provider''s statement (deduplicated by content hash), and moves the attempt: success that matches → captured; success that does not → needs_review with the reason; failed/abandoned → failed (only from created/initialized; never over money); reversed/unrecognised → needs_review. Committed on its own so the fact that money was taken is durable before its effects are attempted.';


-- ── 4. T2: complete the capture ─────────────────────────────────────────────

create or replace function app.complete_payment_capture(p_attempt_id uuid)
returns table (contribution_id uuid, status public.payment_attempt_status, review_reason text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now            timestamptz := now();
  v_attempt        public.payment_attempts%rowtype;
  v_collection     public.collections%rowtype;
  v_tx             public.provider_transactions%rowtype;
  v_obligation     public.obligations%rowtype;
  v_line           public.payment_attempt_lines%rowtype;
  v_remaining      integer;
  v_reason         text;
  v_contribution   uuid;
  v_provider_fee   bigint;
  v_fee_basis      text;
  v_journal        uuid;
  v_receivable     uuid;
  v_pending        uuid;
  v_fee_income     uuid;
  v_vat_payable    uuid;
  v_fee_expense    uuid;
  v_raised         bigint;
begin
  perform app.assert_payment_operator_session();

  select * into v_attempt from public.payment_attempts a where a.id = p_attempt_id for update;
  if not found then
    raise exception 'PAYMENT_ATTEMPT_NOT_FOUND: %', p_attempt_id using errcode = 'P0001';
  end if;

  -- Exactly once: a second call returns what the first produced.
  if v_attempt.status = 'completed' then
    return query select c.id, v_attempt.status, v_attempt.review_reason
                 from public.contributions c where c.attempt_id = p_attempt_id;
    return;
  end if;
  if v_attempt.status <> 'captured' then
    return query select null::uuid, v_attempt.status, v_attempt.review_reason;
    return;
  end if;

  select * into v_tx from public.provider_transactions t
  where t.attempt_id = p_attempt_id and t.status_mapped = 'succeeded'
  order by t.observed_at desc, t.id desc
  limit 1;
  if not found then
    raise exception 'CAPTURE_WITHOUT_EVIDENCE: attempt % is captured but has no successful provider statement', p_attempt_id
      using errcode = 'P0001';
  end if;

  -- D-30 needs captures on one collection serialised; everything else only
  -- needs the collection to exist (a payment started inside the window is
  -- recorded even if the collection closed since — D-29).
  select * into v_collection from public.collections where id = v_attempt.collection_id for update;

  -- ── Effects that might not be possible. Decided before anything is written.
  if v_attempt.obligation_id is not null then
    select * into v_obligation from public.obligations where id = v_attempt.obligation_id for update;
    if v_obligation.status = 'paid' then
      v_reason := 'already_paid';
    elsif v_obligation.status not in ('unpaid', 'overdue')
       or v_obligation.expected_amount_kobo - v_obligation.waived_amount_kobo <> v_attempt.contribution_kobo then
      v_reason := 'obligation_changed';
    end if;
  end if;

  if v_reason is null then
    perform 1 from public.collection_tiers
     where id in (select l.tier_id from public.payment_attempt_lines l where l.attempt_id = p_attempt_id)
     order by id for update;
    perform 1 from public.collection_items
     where id in (select l.item_id from public.payment_attempt_lines l where l.attempt_id = p_attempt_id)
     order by id for update;

    for v_line in select * from public.payment_attempt_lines l where l.attempt_id = p_attempt_id order by l.line_no loop
      v_remaining := app.stock_remaining(v_line.tier_id, v_line.item_id, p_attempt_id, v_now);
      if v_remaining is not null and v_line.quantity > v_remaining then
        v_reason := 'stock_exhausted';
        exit;
      end if;
    end loop;
  end if;

  if v_reason is not null then
    -- Money is recorded (T1) and stays visible; the host decides. Nothing
    -- else is written, and the stock this attempt held goes back on sale.
    update public.payment_attempts set status = 'needs_review', review_reason = v_reason where id = p_attempt_id;
    perform app.release_payment_attempt_stock(p_attempt_id);
    perform app.write_audit_log(
      v_attempt.community_id, 'system', null, 'payment.needs_review', 'payment_attempt', p_attempt_id,
      null, jsonb_build_object('reference', v_attempt.reference, 'reason', v_reason), null);
    return query select null::uuid, 'needs_review'::public.payment_attempt_status, v_reason;
    return;
  end if;

  -- ── The effects, all in this transaction.
  if v_tx.provider_fee_kobo is not null then
    v_provider_fee := v_tx.provider_fee_kobo;
    v_fee_basis := 'reported';
  else
    v_provider_fee := v_attempt.provider_cost_estimate_kobo;
    v_fee_basis := 'estimated';
  end if;

  insert into public.contributions (
    attempt_id, community_id, collection_id, contribution_kobo, net_kobo, total_charged_kobo,
    total_fees_kobo, fee_bearer, fee_schedule_version, provider_fee_kobo, provider_fee_basis,
    member_id, obligation_id, cycle_key, captured_at
  ) values (
    p_attempt_id, v_attempt.community_id, v_attempt.collection_id, v_attempt.contribution_kobo,
    v_attempt.net_kobo, v_attempt.amount_kobo, v_attempt.total_fees_kobo, v_attempt.fee_bearer,
    v_attempt.fee_schedule_version, v_provider_fee, v_fee_basis,
    v_attempt.member_id, v_attempt.obligation_id, v_attempt.cycle_key, coalesce(v_tx.paid_at, v_now)
  )
  returning id into v_contribution;

  insert into public.contribution_lines (contribution_id, line_no, tier_id, item_id, quantity, unit_price_kobo, amount_kobo)
  select v_contribution, l.line_no, l.tier_id, l.item_id, l.quantity, l.unit_price_kobo, l.amount_kobo
  from public.payment_attempt_lines l where l.attempt_id = p_attempt_id;

  update public.stock_reservations set status = 'converted'
  where attempt_id = p_attempt_id and status in ('reserved', 'released');

  if v_attempt.obligation_id is not null then
    -- Allowed only because the contribution above exists and matches: see
    -- app.block_manual_paid_status, replaced below.
    update public.obligations set status = 'paid' where id = v_attempt.obligation_id;
  end if;

  -- Journals. Unique idempotency keys are the backstop behind the row lock.
  v_receivable  := app.ensure_ledger_account(null, null, 'provider_receivable');
  v_fee_income  := app.ensure_ledger_account(null, null, 'platform_fee_income');
  v_vat_payable := app.ensure_ledger_account(null, null, 'vat_payable');
  v_fee_expense := app.ensure_ledger_account(null, null, 'provider_fee_expense');
  v_pending     := app.ensure_ledger_account(v_attempt.community_id, v_attempt.collection_id, 'collection_pending');

  v_journal := app.post_payment_journal(
    v_attempt.community_id, v_attempt.collection_id, coalesce(v_tx.paid_at, v_now), 'capture', v_contribution,
    'Payment ' || v_attempt.reference || ' captured', v_attempt.fee_schedule_version, 'capture:' || p_attempt_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_receivable, 'direction', 'debit',  'amount_kobo', v_attempt.amount_kobo),
      jsonb_build_object('account_id', v_pending,    'direction', 'credit', 'amount_kobo', v_attempt.amount_kobo)));

  if v_attempt.total_fees_kobo > 0 then
    v_journal := app.post_payment_journal(
      v_attempt.community_id, v_attempt.collection_id, coalesce(v_tx.paid_at, v_now), 'fee', v_contribution,
      'Fees on payment ' || v_attempt.reference || ' (' || v_attempt.fee_bearer || ')',
      v_attempt.fee_schedule_version, 'fee:' || p_attempt_id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_pending,     'direction', 'debit',  'amount_kobo', v_attempt.total_fees_kobo),
        jsonb_build_object('account_id', v_fee_income,  'direction', 'credit',
                           'amount_kobo', v_attempt.platform_fee_kobo + v_attempt.gateway_fee_kobo),
        jsonb_build_object('account_id', v_vat_payable, 'direction', 'credit', 'amount_kobo', v_attempt.vat_kobo)));
  end if;

  if v_provider_fee > 0 then
    v_journal := app.post_payment_journal(
      v_attempt.community_id, v_attempt.collection_id, coalesce(v_tx.paid_at, v_now), 'fee', v_contribution,
      'Provider fee on payment ' || v_attempt.reference || ' (' || v_fee_basis || ')',
      v_attempt.fee_schedule_version, 'provider_fee:' || p_attempt_id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_fee_expense, 'direction', 'debit',  'amount_kobo', v_provider_fee),
        jsonb_build_object('account_id', v_receivable,  'direction', 'credit', 'amount_kobo', v_provider_fee)));
  end if;

  -- D-30: close a fundraiser that this payment took to its target. Payments
  -- already in flight are still recorded; nothing is trimmed.
  if v_collection.close_when_target_reached and v_collection.status = 'active' then
    select coalesce(sum(c.contribution_kobo), 0) into v_raised
    from public.contributions c where c.collection_id = v_attempt.collection_id and c.status = 'applied';
    if v_raised >= v_collection.target_amount_kobo then
      update public.collections set status = 'closed', closed_at = v_now where id = v_attempt.collection_id;
      perform app.write_audit_log(
        v_attempt.community_id, 'system', null, 'collection.close', 'collection', v_attempt.collection_id,
        jsonb_build_object('status', 'active'), jsonb_build_object('status', 'closed'), 'target_reached');
    end if;
  end if;

  update public.payment_attempts set status = 'completed' where id = p_attempt_id;

  perform app.write_audit_log(
    v_attempt.community_id, 'system', null, 'payment.captured', 'payment_attempt', p_attempt_id,
    null,
    jsonb_build_object('reference', v_attempt.reference, 'contribution_id', v_contribution,
                       'amount_kobo', v_attempt.amount_kobo, 'provider_fee_basis', v_fee_basis),
    null);

  return query select v_contribution, 'completed'::public.payment_attempt_status, null::text;
end;
$$;
revoke execute on function app.complete_payment_capture(uuid) from public, anon, authenticated;

comment on function app.complete_payment_capture(uuid) is
  'Plan §4.7 T2. From captured only. Decides first whether the payment''s effects are still possible (obligation unchanged and unpaid; stock still available) — if not, needs_review with the reason and stock released. Otherwise, in one transaction: contribution + lines, reservations converted, obligation → paid, capture/fee/provider-fee journals (balanced, collection-attributed, unique keys), D-30 target close, completed, audit. A second call returns the same contribution.';


-- ── 5. An obligation becomes paid only with the money to show for it ───────
--
-- Replaces the 20260919120000 body, which refused EVERY move to paid because no
-- payment path existed. CASH-02 / SEC-20a stand unchanged in substance: an
-- obligation is paid only by a Paystack-verified contribution. What changes is
-- that the rule is now checked against the evidence rather than assumed
-- unreachable — the update is allowed only when an applied contribution for
-- exactly the amount owed already references this obligation. Contributions
-- are writable only by app.complete_payment_capture.

create or replace function app.block_manual_paid_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    if not exists (
      select 1 from public.contributions c
      where c.obligation_id = new.id
        and c.status = 'applied'
        and c.contribution_kobo = new.expected_amount_kobo - new.waived_amount_kobo
    ) then
      raise exception
        'NO_MANUAL_PAID: an obligation becomes paid only through a Paystack-verified contribution (CASH-02, SEC-20a)'
        using errcode = 'P0001',
              hint = 'Kolekto is cashless. To clear a balance without payment, exempt the member or waive the amount, with a reason.';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function app.block_manual_paid_status() from public, anon, authenticated;
