-- ─────────────────────────────────────────────────────────────────────────────
-- 20261110100000 — The one amount rule a draft is allowed to break, continued
--
-- 20260921160100 taught `app.create_collection` to save a fixed collection
-- without a typed amount — a draft exists before the amount step has been
-- reached, and refusing to save it there means the wizard cannot persist
-- anything until the organiser has typed a figure. The companion function
-- `app.update_collection` was left behind: it still calls
-- `app.assert_amount_model_config` without `p_allow_missing_amount`, which
-- defaults to false, so UPDATING a draft row without an amount fails with
-- "INVALID_AMOUNT: a fixed collection needs a contribution amount above zero".
--
-- Why this only surfaced now. Until the 2026-11 wizard redesign, the first
-- step of a Fixed or Recurring flow saved the collection row for the first
-- time (CREATE, which already allows a missing amount) and the amount step
-- was next. The redesign moved the image onto the Details step: choosing a
-- file creates the draft before Continue is pressed, so the Continue click
-- takes the UPDATE path, which refused.
--
-- THE FIX. `app.update_collection` passes `p_allow_missing_amount := true`
-- when, and only when, the row is still a draft — the same rule the create
-- side has. Publishing still enforces "a fixed collection has an amount"
-- (`app.transition_collection_status` in 20260919120000 is untouched), so
-- nothing with a contribution attached can slip through amountless.
--
-- No other rule changes. A fixed collection still may not carry a range; a
-- non-fixed collection still may not carry a single amount; zero is still
-- refused where any amount IS given; and a published collection's amounts
-- stay locked by `collection.change_amount` (PRD 17.5).
--
-- The body below is 20260919120000's `app.update_collection` verbatim, with
-- the single `assert_amount_model_config` call expanded to pass the fifth
-- argument.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.update_collection(
  p_collection_id       uuid,
  p_name                text,
  p_category            public.collection_category,
  p_description         text default null,
  p_amount_model        public.amount_model default null,
  p_participation_mode  public.participation_mode default null,
  p_payment_plan        public.payment_plan default null,
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
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before     jsonb;
  v_collection public.collections%rowtype;
  v_model      public.amount_model;
  v_mode       public.participation_mode;
  v_plan       public.payment_plan;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status in ('closed', 'archived', 'suspended') then
    raise exception 'COLLECTION_NOT_EDITABLE: a % collection cannot be edited', v_collection.status
      using errcode = 'P0001',
            hint = 'Reopening is not supported. Create a new collection instead; the closed one keeps its record.';
  end if;

  if char_length(coalesce(p_name, '')) < 3 or char_length(p_name) > 80 then
    raise exception 'INVALID_NAME: collection name must be 3 to 80 characters' using errcode = 'P0001';
  end if;

  v_model := coalesce(p_amount_model, v_collection.amount_model);
  v_mode  := coalesce(p_participation_mode, v_collection.participation_mode);
  v_plan  := coalesce(p_payment_plan, v_collection.payment_plan);

  -- The amount lock: once a collection is published, what it asks people to
  -- pay is fixed. `collection.change_amount` is the permission for changing
  -- it, and it requires a second approver (PRD 17.5).
  if v_collection.status <> 'draft' then
    if v_model is distinct from v_collection.amount_model
       or v_mode is distinct from v_collection.participation_mode
       or v_plan is distinct from v_collection.payment_plan
       or p_fixed_amount_kobo  is distinct from v_collection.fixed_amount_kobo
       or p_min_amount_kobo    is distinct from v_collection.min_amount_kobo
       or p_max_amount_kobo    is distinct from v_collection.max_amount_kobo
       or p_target_amount_kobo is distinct from v_collection.target_amount_kobo then
      raise exception 'AMOUNTS_LOCKED: a published collection''s amounts and contribution rules cannot be changed'
        using errcode = 'P0001',
              hint = 'Changing them needs collection.change_amount, which requires a second approver (PRD 17.5). Close this collection and create a new one, or pause it and edit only its wording and deadline.';
    end if;
  end if;

  if v_model = 'per_member' and v_mode <> 'managed' then
    raise exception 'INVALID_CONFIGURATION: a per-member amount needs a managed collection with a member list'
      using errcode = 'P0001';
  end if;
  if v_collection.schedule = 'recurring' and v_mode <> 'managed' then
    raise exception 'INVALID_CONFIGURATION: a recurring collection needs a managed collection with a member list'
      using errcode = 'P0001';
  end if;
  if p_starts_at is not null and p_deadline_at is not null and p_deadline_at <= p_starts_at then
    raise exception 'INVALID_DEADLINE: the deadline must be after the start date' using errcode = 'P0001';
  end if;
  if v_plan = 'installments_allowed' and p_deadline_at is null then
    raise exception 'INVALID_DEADLINE: a collection that allows installments needs a deadline (COL-03)'
      using errcode = 'P0001';
  end if;

  -- Draft rows may not yet have reached the amount step. The publish gate
  -- (`app.transition_collection_status`) still enforces the rule where it
  -- matters: a published fixed collection carries an amount.
  perform app.assert_amount_model_config(
    v_model, p_fixed_amount_kobo, p_min_amount_kobo, p_max_amount_kobo, p_target_amount_kobo,
    v_collection.status = 'draft'
  );

  -- Switching away from tiers while tier rows exist would leave rows the
  -- collection_tiers trigger forbids. Say so rather than letting the trigger
  -- raise TIER_ON_NON_TIERED_COLLECTION from under an unrelated action.
  if v_model <> 'tiers' and v_collection.amount_model = 'tiers'
     and exists (select 1 from public.collection_tiers where collection_id = p_collection_id) then
    raise exception 'TIERS_EXIST: remove the tiers before changing how contributors pay'
      using errcode = 'P0001';
  end if;

  v_before := to_jsonb(v_collection);

  update public.collections set
    name               = p_name,
    description        = p_description,
    category           = p_category,
    amount_model       = v_model,
    participation_mode = v_mode,
    payment_plan       = v_plan,
    fixed_amount_kobo  = p_fixed_amount_kobo,
    min_amount_kobo    = p_min_amount_kobo,
    max_amount_kobo    = p_max_amount_kobo,
    target_amount_kobo = p_target_amount_kobo,
    starts_at          = p_starts_at,
    deadline_at        = p_deadline_at,
    visibility         = p_visibility,
    allow_non_members  = p_allow_non_members,
    allow_anonymous    = p_allow_anonymous,
    thank_you_message  = p_thank_you_message
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.update', 'collection', p_collection_id,
    v_before, (select to_jsonb(c) from public.collections c where c.id = p_collection_id)
  );
end;
$$;

comment on function app.update_collection is
  'collection.draft. Full-replace edit. A DRAFT may be saved without a contribution amount (the publish gate still refuses to publish one). A published collection''s amounts, amount model, participation mode and payment plan are locked (collection.change_amount requires a second approver, PRD 17.5); its wording, dates and visibility stay editable.';
