-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921160100 — The one amount rule a draft is allowed to break
--
-- Companion to 20260921160000, which narrowed the table constraint. The same
-- rule is stated a second time in `app.assert_amount_model_config`, which is
-- where the readable refusal comes from — so relaxing only the constraint
-- moved the failure from "constraint violated" to "INVALID_AMOUNT: a fixed
-- collection needs a contribution amount above zero" without changing the
-- outcome. A draft still could not be saved before its amount was typed.
--
-- `p_allow_missing_amount` is added, defaulting to false, so every existing
-- caller keeps today's behaviour exactly. `app.create_collection` passes true,
-- because every collection it makes is a draft.
--
-- EVERY OTHER RULE IS UNTOUCHED, including on drafts:
--   · a fixed collection still may not carry a min/max range
--   · a non-fixed collection still may not carry a single amount
--   · an amount of zero or below is still refused when one IS given
--   · open-amount minimums, maximums and ordering are unchanged
--   · a target must still be above zero
-- Only "a fixed collection must already have an amount" becomes a publish-time
-- rule rather than a save-time one, and `app.transition_collection_status`
-- has enforced it at publish since 20260919120000.
--
-- `app.create_collection` below is the 20260919120000 body verbatim with one
-- line changed: the `assert_amount_model_config` call now passes `true`.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.assert_amount_model_config(
  p_amount_model       public.amount_model,
  p_fixed_amount_kobo  bigint,
  p_min_amount_kobo    bigint,
  p_max_amount_kobo    bigint,
  p_target_amount_kobo bigint,
  p_allow_missing_amount boolean default false
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_amount_model = 'fixed' then
    -- A draft may not have reached the amount step yet. An amount that IS
    -- given is still checked: null means "not typed yet", zero means "typed
    -- wrongly", and only the first is ever excusable.
    if p_fixed_amount_kobo is null then
      if not p_allow_missing_amount then
        raise exception 'INVALID_AMOUNT: a fixed collection needs a contribution amount above zero'
          using errcode = 'P0001';
      end if;
    elsif p_fixed_amount_kobo <= 0 then
      raise exception 'INVALID_AMOUNT: a fixed collection needs a contribution amount above zero'
        using errcode = 'P0001';
    end if;
    if p_min_amount_kobo is not null or p_max_amount_kobo is not null then
      raise exception 'INVALID_AMOUNT: a fixed collection has one amount, not a range'
        using errcode = 'P0001';
    end if;
  else
    if p_fixed_amount_kobo is not null then
      raise exception 'INVALID_AMOUNT: only a fixed collection carries a single contribution amount'
        using errcode = 'P0001';
    end if;
  end if;

  if p_amount_model = 'open_amount' then
    if p_min_amount_kobo is not null and p_min_amount_kobo <= 0 then
      raise exception 'INVALID_AMOUNT: a minimum contribution must be above zero' using errcode = 'P0001';
    end if;
    if p_max_amount_kobo is not null and p_max_amount_kobo <= 0 then
      raise exception 'INVALID_AMOUNT: a maximum contribution must be above zero' using errcode = 'P0001';
    end if;
    if p_min_amount_kobo is not null and p_max_amount_kobo is not null
       and p_min_amount_kobo > p_max_amount_kobo then
      raise exception 'INVALID_AMOUNT: the smallest contribution cannot be above the largest'
        using errcode = 'P0001';
    end if;
  elsif p_min_amount_kobo is not null or p_max_amount_kobo is not null then
    raise exception 'INVALID_AMOUNT: a range applies only when contributors choose their own amount'
      using errcode = 'P0001';
  end if;

  if p_target_amount_kobo is not null and p_target_amount_kobo <= 0 then
    raise exception 'INVALID_AMOUNT: a target must be above zero' using errcode = 'P0001';
  end if;
end;
$$;

comment on function app.assert_amount_model_config(public.amount_model, bigint, bigint, bigint, bigint, boolean) is
  'PRD 4.1/4.2: which amount columns mean anything is decided by the amount model. Raises the readable refusal before the table constraint raises the structural one. p_allow_missing_amount exempts a DRAFT from "a fixed collection already has an amount" and nothing else; the publish gate still enforces it (20260921160000).';


-- ── create_collection: every collection it makes is a draft ─────────────────
create or replace function app.create_collection(
  p_community_id        uuid,
  p_name                text,
  p_category            public.collection_category,
  p_participation_mode  public.participation_mode,
  p_amount_model        public.amount_model,
  p_description         text default null,
  p_payment_plan        public.payment_plan default 'full_only',
  p_schedule            public.collection_schedule default 'one_time',
  p_fixed_amount_kobo   bigint default null,
  p_min_amount_kobo     bigint default null,
  p_max_amount_kobo     bigint default null,
  p_target_amount_kobo  bigint default null,
  p_starts_at           timestamptz default null,
  p_deadline_at         timestamptz default null,
  p_visibility          public.collection_visibility default 'unlisted',
  p_allow_non_members   boolean default false,
  p_allow_anonymous     boolean default false,
  p_thank_you_message   text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection_id uuid;
  v_fee_mode      public.fee_mode;
begin
  perform app.require_permission(p_community_id, 'collection.draft');

  if char_length(coalesce(p_name, '')) < 3 or char_length(p_name) > 80 then
    raise exception 'INVALID_NAME: collection name must be 3 to 80 characters' using errcode = 'P0001';
  end if;
  if p_description is not null and char_length(p_description) > 2000 then
    raise exception 'INVALID_DESCRIPTION: description must be 2000 characters or fewer' using errcode = 'P0001';
  end if;
  if p_amount_model = 'per_member' and p_participation_mode <> 'managed' then
    raise exception 'INVALID_CONFIGURATION: a per-member amount needs a managed collection with a member list'
      using errcode = 'P0001';
  end if;
  if p_schedule = 'recurring' and p_participation_mode <> 'managed' then
    raise exception 'INVALID_CONFIGURATION: a recurring collection needs a managed collection with a member list'
      using errcode = 'P0001';
  end if;
  if p_starts_at is not null and p_deadline_at is not null and p_deadline_at <= p_starts_at then
    raise exception 'INVALID_DEADLINE: the deadline must be after the start date' using errcode = 'P0001';
  end if;
  if p_payment_plan = 'installments_allowed' and p_deadline_at is null then
    raise exception 'INVALID_DEADLINE: a collection that allows installments needs a deadline (COL-03)'
      using errcode = 'P0001';
  end if;

  -- The one changed line (20260921160100): true, because this function only
  -- ever produces a draft, and a draft is allowed to be unfinished.
  perform app.assert_amount_model_config(
    p_amount_model, p_fixed_amount_kobo, p_min_amount_kobo, p_max_amount_kobo, p_target_amount_kobo, true
  );

  -- PRC-02: the community's default, overridable per collection later. Read
  -- from the community rather than accepted from the caller, so a client cannot
  -- decide who pays the fee.
  select default_fee_mode into v_fee_mode from public.communities where id = p_community_id;
  if v_fee_mode is null then
    raise exception 'NOT_FOUND: community % does not exist', p_community_id using errcode = 'P0002';
  end if;

  v_collection_id := app.uuid_generate_v7();

  insert into public.collections (
    id, community_id, slug, name, description, category,
    participation_mode, amount_model, payment_plan, schedule,
    fixed_amount_kobo, min_amount_kobo, max_amount_kobo, target_amount_kobo,
    starts_at, deadline_at, status, visibility, fee_mode,
    allow_non_members, allow_anonymous, thank_you_message, created_by
  ) values (
    v_collection_id, p_community_id,
    app.generate_unique_collection_slug(p_community_id, p_name),
    p_name, p_description, p_category,
    p_participation_mode, p_amount_model, p_payment_plan, p_schedule,
    p_fixed_amount_kobo, p_min_amount_kobo, p_max_amount_kobo, p_target_amount_kobo,
    p_starts_at, p_deadline_at, 'draft', p_visibility, v_fee_mode,
    p_allow_non_members, p_allow_anonymous, p_thank_you_message, auth.uid()
  );

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'collection.create', 'collection', v_collection_id,
    null, jsonb_build_object('name', p_name, 'amount_model', p_amount_model, 'participation_mode', p_participation_mode)
  );

  return v_collection_id;
end;
$$;

comment on function app.create_collection is
  'collection.draft. Creates a DRAFT collection owned by the community (ADR 0004 — there is no user_id). Carries no payment-method argument by design (COL-00). A draft may lack its contribution amount; the publish gate does not.';
