-- ─────────────────────────────────────────────────────────────────────────────
-- 20260919120000 — Phase 3: collection and obligation write functions
--
-- Phase 1 created the collection domain as tables (20260917120700) and the
-- obligation table (20260917120800), with RLS, guards and the two whitelisted
-- anonymous read functions. Nothing wrote to any of them: there was no path
-- from the application into a collection at all. This migration is that path.
--
-- It follows 20260918140100's shape exactly, for the same reasons stated there:
-- every function is SECURITY DEFINER, re-checks `app.has_permission`, re-derives
-- tenancy from the row rather than trusting a client-supplied community_id
-- (SEC-18), and writes an audit row (AUD-01) before returning. `authenticated`
-- still holds no INSERT, UPDATE or DELETE on any table.
--
-- Functions in this file, grouped:
--   Collections     create_collection, update_collection,
--                    delete_draft_collection, transition_collection_status
--   Tiers           set_collection_tiers, set_tier_hidden
--   Custom fields   set_collection_fields
--   Obligations     assign_obligations, update_obligation_amount,
--                    cancel_obligation, exempt_obligation,
--                    waive_obligation_amount
--   Public read     get_public_collection_fields
--
-- THE MONEY BOUNDARY (ADR 0006). Nothing here moves, records or implies money.
-- There is no contribution, no payment attempt, no balance and no transition of
-- an obligation into 'paid' — `app.block_manual_paid_status` (20260917120800)
-- rejects that from every path, and this migration deliberately adds no
-- exception to it. An obligation created here says what a member is EXPECTED to
-- pay. What they HAVE paid is derived from contributions, which do not exist
-- yet (OBL-01).
--
-- Explicitly NOT built here (documented, not silently skipped):
--   · Changing a published collection's amounts. `collection.change_amount`
--     carries requires_second_approver = true (PRD 17.5) and no approval-queue
--     table exists. Building a single-approver version would misrepresent the
--     permission — the same call 20260918140100 made for community.archive. So
--     amounts are editable while a collection is a draft, and locked after it
--     is published, with an error that says why.
--   · Editing tiers or custom questions after publication, for the same reason
--     on the tier side and because a custom-field key will identify a stored
--     contributor answer once contributions exist (Phase 4). Hiding a tier is
--     allowed at any time (PRD 4.7: a sold-out tier is hidden, never removed).
--   · Recurring cycles. `obligations.cycle_key` exists and every obligation
--     written here leaves it NULL (one-time). The cycles table is Phase 5.
--   · Contributor codes. `collection_code_settings` is configured by no
--     function here; codes are issued against a contribution, which is Phase 4.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Shared helpers ───────────────────────────────────────────────────────────

-- The collection counterpart of app.generate_unique_community_slug. Uniqueness
-- is per community (collections_community_slug_key), not global: two
-- communities may each run a "dues-2026", and their public URLs differ by the
-- community segment.
create or replace function app.generate_unique_collection_slug(
  p_community_id uuid,
  p_name         text
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_base      text := left(app.slugify(p_name), 60);
  v_candidate text := v_base;
  v_suffix    integer := 1;
begin
  loop
    exit when not exists (
      select 1 from public.collections
      where community_id = p_community_id and slug = v_candidate
    );

    v_suffix := v_suffix + 1;
    v_candidate := left(v_base, 60 - length('-' || v_suffix::text)) || '-' || v_suffix::text;

    if v_suffix > 500 then
      raise exception 'SLUG_ALLOCATION_FAILED: could not allocate a unique collection slug for % after 500 attempts', p_name
        using errcode = 'P0001';
    end if;
  end loop;

  return v_candidate;
end;
$$;

comment on function app.generate_unique_collection_slug(uuid, text) is
  'A per-community collection slug. The public address is /{community-slug}/{collection-slug}, which is the shape legacy_links redirects old links into (20260918130400).';

-- The amount columns that mean anything depend on the amount model. The table
-- constraints already reject the incoherent combinations; this raises the same
-- refusals with a stable code and a sentence a person can act on, before the
-- constraint fires with a message written for a DBA.
create or replace function app.assert_amount_model_config(
  p_amount_model      public.amount_model,
  p_fixed_amount_kobo bigint,
  p_min_amount_kobo   bigint,
  p_max_amount_kobo   bigint,
  p_target_amount_kobo bigint
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_amount_model = 'fixed' then
    if p_fixed_amount_kobo is null or p_fixed_amount_kobo <= 0 then
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
      raise exception 'INVALID_AMOUNT: the smallest allowed contribution must be above zero'
        using errcode = 'P0001';
    end if;
    if p_max_amount_kobo is not null and p_max_amount_kobo <= 0 then
      raise exception 'INVALID_AMOUNT: the largest allowed contribution must be above zero'
        using errcode = 'P0001';
    end if;
    if p_min_amount_kobo is not null and p_max_amount_kobo is not null
       and p_min_amount_kobo > p_max_amount_kobo then
      raise exception 'INVALID_AMOUNT: the smallest allowed contribution is above the largest'
        using errcode = 'P0001';
    end if;
  elsif p_min_amount_kobo is not null or p_max_amount_kobo is not null then
    raise exception 'INVALID_AMOUNT: a contribution range applies only when contributors choose their own amount'
      using errcode = 'P0001';
  end if;

  if p_target_amount_kobo is not null and p_target_amount_kobo <= 0 then
    raise exception 'INVALID_AMOUNT: a target must be above zero' using errcode = 'P0001';
  end if;
end;
$$;

comment on function app.assert_amount_model_config is
  'PRD 4.1/4.2: which amount columns mean anything is decided by the amount model. Raises the readable refusal before the table constraint raises the structural one.';


-- ─────────────────────────────────────────────────────────────────────────────
-- Collections
-- ─────────────────────────────────────────────────────────────────────────────

-- COL-00 is visible here as an absence: there is no payment-method parameter,
-- because a collection can never restrict or reorder payment methods.
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

  perform app.assert_amount_model_config(
    p_amount_model, p_fixed_amount_kobo, p_min_amount_kobo, p_max_amount_kobo, p_target_amount_kobo
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
  'collection.draft. Creates a DRAFT collection owned by the community (ADR 0004 — there is no user_id). Carries no payment-method argument by design (COL-00).';

-- Full-replace semantics, like app.update_community_profile: the caller passes
-- every editable field. The slug is NOT among them — a collection's public
-- address is a promise made to everyone the link was sent to, and renaming the
-- collection does not move it.
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

  -- The lock described in this file's header. Once a collection is published,
  -- what it asks people to pay is fixed: `collection.change_amount` is the
  -- permission for changing it, and it requires a second approver (PRD 17.5)
  -- that no table can record yet.
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

  perform app.assert_amount_model_config(
    v_model, p_fixed_amount_kobo, p_min_amount_kobo, p_max_amount_kobo, p_target_amount_kobo
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
  'collection.draft. Full-replace edit. A published collection''s amounts, amount model, participation mode and payment plan are locked (collection.change_amount requires a second approver, PRD 17.5); its wording, dates and visibility stay editable.';

-- COL-14 allows deleting only an unpaid draft, and the delete guard on
-- collections enforces it. This function exists so discarding a draft is a
-- named, audited action rather than the application issuing a raw DELETE it has
-- no grant for anyway.
create or replace function app.delete_draft_collection(p_collection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  -- The audit row is written BEFORE the delete: audit_logs.object_id carries no
  -- foreign key precisely so a record survives the object it describes, and
  -- writing after the delete would leave the row's own creation unordered
  -- against it.
  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.delete_draft', 'collection', p_collection_id,
    to_jsonb(v_collection), null
  );

  -- app.enforce_collection_delete_guard refuses anything that is not an
  -- obligation-free draft (COL-14).
  delete from public.collections where id = p_collection_id;
end;
$$;

comment on function app.delete_draft_collection(uuid) is
  'COL-14: only a draft with no obligations can be deleted, enforced by the delete guard. Everything else is closed or archived, never removed.';


-- ── The state machine (STM-01) ───────────────────────────────────────────────
-- One transition function, compare-and-set: the caller states the status it
-- believes the collection is in, and a concurrent change makes the call fail
-- rather than silently apply to a state the operator never saw.
--
-- The permitted moves, and nothing else:
--
--     draft     → active | scheduled     (publish)
--     scheduled → active | paused | closed
--     active    → paused | closed
--     paused    → active | closed
--     closed    → archived
--     archived  → ✗ terminal
--     suspended → ✗ Kolekto risk action only, in neither direction
--
-- There is no route back to draft. A published collection has been shown to
-- contributors; editing its amounts afterwards is the thing AMOUNTS_LOCKED in
-- app.update_collection refuses, and an un-publish would be that refusal with
-- an extra step.
create or replace function app.transition_collection_status(
  p_collection_id uuid,
  p_expected      public.collection_status,
  p_target        public.collection_status,
  p_reason        text default null
)
returns public.collection_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_resolved   public.collection_status := p_target;
  v_action     text;
  v_tier_count integer;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.publish');

  if v_collection.status <> p_expected then
    raise exception 'STATUS_CONFLICT: collection % is %, not %', p_collection_id, v_collection.status, p_expected
      using errcode = 'P0001',
            hint = 'Someone else changed this collection. Reload and try again.';
  end if;

  if p_target = 'suspended' or v_collection.status = 'suspended' then
    raise exception 'STAFF_ONLY: suspension is a Kolekto risk action, not a community one'
      using errcode = '42501';
  end if;

  -- Publishing is the one transition with preconditions of its own: a draft
  -- must be complete enough that a contributor opening the link sees a price.
  if v_collection.status = 'draft' and p_target in ('active', 'scheduled') then
    if v_collection.amount_model = 'fixed' and coalesce(v_collection.fixed_amount_kobo, 0) <= 0 then
      raise exception 'NOT_PUBLISHABLE: set the contribution amount before publishing' using errcode = 'P0001';
    end if;

    if v_collection.amount_model = 'tiers' then
      select count(*) into v_tier_count
      from public.collection_tiers
      where collection_id = p_collection_id and not hidden;
      if v_tier_count = 0 then
        raise exception 'NOT_PUBLISHABLE: add at least one visible option before publishing' using errcode = 'P0001';
      end if;
    end if;

    if v_collection.deadline_at is not null and v_collection.deadline_at <= now() then
      raise exception 'NOT_PUBLISHABLE: the deadline has already passed' using errcode = 'P0001';
    end if;

    -- PRD 4.8: a start date in the future publishes as scheduled. The caller
    -- asks to publish; the database decides which of the two published states
    -- that means, so the two cannot disagree.
    if v_collection.starts_at is not null and v_collection.starts_at > now() then
      v_resolved := 'scheduled';
    else
      v_resolved := 'active';
    end if;

    v_action := 'collection.publish';

  elsif v_collection.status = 'scheduled' and p_target = 'active' then
    v_action := 'collection.activate';
  elsif v_collection.status in ('scheduled', 'active') and p_target = 'paused' then
    v_action := 'collection.pause';
  elsif v_collection.status = 'paused' and p_target = 'active' then
    v_action := 'collection.resume';
  elsif v_collection.status in ('scheduled', 'active', 'paused') and p_target = 'closed' then
    v_action := 'collection.close';
  elsif v_collection.status = 'closed' and p_target = 'archived' then
    v_action := 'collection.archive';
  else
    raise exception 'INVALID_TRANSITION: a % collection cannot become %', v_collection.status, p_target
      using errcode = 'P0001';
  end if;

  update public.collections set
    status       = v_resolved,
    published_at = case when v_action = 'collection.publish' then now() else published_at end,
    published_by = case when v_action = 'collection.publish' then auth.uid() else published_by end,
    closed_at    = case when v_resolved = 'closed'   then now() else closed_at end,
    archived_at  = case when v_resolved = 'archived' then now() else archived_at end
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), v_action, 'collection', p_collection_id,
    jsonb_build_object('status', v_collection.status),
    jsonb_build_object('status', v_resolved),
    p_reason
  );

  return v_resolved;
end;
$$;

comment on function app.transition_collection_status is
  'STM-01: the single collection state transition, compare-and-set. Publishing resolves to scheduled or active from starts_at, so the caller cannot pick a state the dates contradict. Suspension is staff-only in both directions.';


-- ─────────────────────────────────────────────────────────────────────────────
-- Tiers (ADR 0010)
-- ─────────────────────────────────────────────────────────────────────────────

-- Full-replace against a jsonb array, matched by tier ID and never by name.
-- That distinction is the entire point of ADR 0010: the previous system
-- resolved a tier with `.find()` on ID *or* name, so two tiers called
-- "Standard" collapsed onto whichever came first. Here a tier without an `id`
-- is new, a tier with one is an update, and a tier absent from the payload is
-- removed — by identity, in every case.
--
-- Draft only. After publication a tier's price is part of the published offer,
-- which AMOUNTS_LOCKED covers for the collection and this covers for its
-- options; app.set_tier_hidden remains available for taking one off sale.
create or replace function app.set_collection_tiers(
  p_collection_id uuid,
  p_tiers         jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_item       jsonb;
  v_id         uuid;
  v_name       text;
  v_price      bigint;
  v_payload_ids uuid[] := '{}';
  v_names      text[] := '{}';
  v_created_at jsonb   := '{}'::jsonb;
  v_count      integer := 0;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status <> 'draft' then
    raise exception 'TIERS_LOCKED: options can only be changed while the collection is a draft'
      using errcode = 'P0001',
            hint = 'Hide an option instead — a sold option is hidden, never removed (PRD 4.7).';
  end if;
  if v_collection.amount_model <> 'tiers' then
    raise exception 'NOT_TIERED: this collection does not offer options to choose between'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_tiers) <> 'array' then
    raise exception 'INVALID_TIERS: expected a list of options' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_tiers) = 0 then
    raise exception 'INVALID_TIERS: a tiered collection needs at least one option' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_tiers) > 50 then
    raise exception 'INVALID_TIERS: a collection can offer at most 50 options' using errcode = 'P0001';
  end if;

  -- Pass one validates the whole payload and collects the IDs it claims. An
  -- ID in the payload must already belong to THIS collection: a tier ID from
  -- somewhere else is not adopted, it is refused (SEC-18).
  for v_item in select * from jsonb_array_elements(p_tiers)
  loop
    v_name  := nullif(trim(v_item ->> 'name'), '');
    v_price := (v_item ->> 'price_kobo')::bigint;

    if v_name is null or char_length(v_name) > 60 then
      raise exception 'INVALID_TIERS: every option needs a name of 60 characters or fewer' using errcode = 'P0001';
    end if;
    if v_price is null or v_price <= 0 then
      raise exception 'INVALID_TIERS: option "%" needs a price above zero', v_name using errcode = 'P0001';
    end if;

    -- The duplicate-name refusal, raised here with the offending name rather
    -- than left to collection_tiers_unique_name's index violation. Both hold;
    -- only one of them is a sentence an organiser can act on.
    if lower(v_name) = any (v_names) then
      raise exception 'DUPLICATE_TIER_NAME: two options are both called "%" — give each a distinct name', v_name
        using errcode = 'P0001',
              hint = 'Duplicate option names are what made the 2026-08-06 tier incident possible.';
    end if;
    v_names := v_names || lower(v_name);

    v_id := nullif(v_item ->> 'id', '')::uuid;
    if v_id is not null then
      if not exists (
        select 1 from public.collection_tiers
        where id = v_id and collection_id = p_collection_id
      ) then
        raise exception 'NOT_FOUND: option % does not belong to this collection', v_id using errcode = 'P0002';
      end if;
      if v_id = any (v_payload_ids) then
        raise exception 'DUPLICATE_TIER_ID: option % appears twice in the same list', v_id using errcode = 'P0001';
      end if;
      v_payload_ids := v_payload_ids || v_id;
    end if;
  end loop;

  -- Pass two replaces the set wholesale, keeping every ID the payload carried.
  --
  -- Written as delete-then-insert rather than a per-row upsert because
  -- collection_tiers_unique_name is a plain unique index: renaming two options
  -- to each other's names in one save is a legitimate edit that a row-by-row
  -- update would reject halfway through, leaving the collection in neither the
  -- old shape nor the new one. Nothing in the schema references a tier yet, so
  -- there is nothing for the delete to orphan — created_at is carried across
  -- explicitly so an option's age survives an edit to its price.
  --
  -- This is safe ONLY because a draft has no contributions. When contributions
  -- arrive (Phase 4) a tier that has sold anything must be hidden instead, and
  -- this function needs a guard saying so before it deletes.
  select coalesce(jsonb_object_agg(id::text, to_jsonb(created_at)), '{}'::jsonb)
    into v_created_at
  from public.collection_tiers
  where collection_id = p_collection_id;

  delete from public.collection_tiers where collection_id = p_collection_id;

  for v_item in select * from jsonb_array_elements(p_tiers)
  loop
    v_id := coalesce(nullif(v_item ->> 'id', '')::uuid, app.uuid_generate_v7());

    insert into public.collection_tiers (
      id, collection_id, community_id, name, description, price_kobo,
      quantity_limit, per_order_limit, code_prefix, hidden, sort_order, created_at
    ) values (
      v_id, p_collection_id, v_collection.community_id,
      trim(v_item ->> 'name'),
      nullif(trim(v_item ->> 'description'), ''),
      (v_item ->> 'price_kobo')::bigint,
      nullif(v_item ->> 'quantity_limit', '')::integer,
      nullif(v_item ->> 'per_order_limit', '')::integer,
      nullif(upper(trim(coalesce(v_item ->> 'code_prefix', ''))), ''),
      coalesce((v_item ->> 'hidden')::boolean, false),
      coalesce(nullif(v_item ->> 'sort_order', '')::smallint, v_count::smallint),
      coalesce((v_created_at ->> v_id::text)::timestamptz, now())
    );

    v_count := v_count + 1;
  end loop;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_tiers', 'collection', p_collection_id,
    null, jsonb_build_object('option_count', v_count)
  );

  return v_count;
end;
$$;

comment on function app.set_collection_tiers(uuid, jsonb) is
  'ADR 0010. Full replace matched by tier ID, never by display name. Draft only: after publication a price is part of the published offer. Returns the number of options.';

create or replace function app.set_tier_hidden(
  p_tier_id uuid,
  p_hidden  boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tier public.collection_tiers%rowtype;
begin
  select * into v_tier from public.collection_tiers where id = p_tier_id;
  if v_tier.id is null then
    raise exception 'NOT_FOUND: option % does not exist', p_tier_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_tier.community_id, 'collection.draft');

  update public.collection_tiers set hidden = p_hidden where id = p_tier_id;

  perform app.write_audit_log(
    v_tier.community_id, 'officer', auth.uid(), 'collection.set_tiers', 'collection_tier', p_tier_id,
    jsonb_build_object('hidden', v_tier.hidden), jsonb_build_object('hidden', p_hidden)
  );
end;
$$;

comment on function app.set_tier_hidden(uuid, boolean) is
  'PRD 4.7: a sold-out or withdrawn option is hidden, never deleted. Allowed at any status, because taking something off sale must not require editing a live collection.';


-- ─────────────────────────────────────────────────────────────────────────────
-- Custom questions (PRD 4.3)
-- ─────────────────────────────────────────────────────────────────────────────

-- Full replace, draft only, at most ten. `key` is the stable identifier an
-- answer will be stored against once contributions exist (RPT-00 exports one
-- column per key), which is why these are not editable after publication:
-- changing a key on a live collection would orphan answers already given.
create or replace function app.set_collection_fields(
  p_collection_id uuid,
  p_fields        jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_item       jsonb;
  v_key        text;
  v_label      text;
  v_type       public.member_attribute_type;
  v_options    text[];
  v_keys       text[] := '{}';
  v_count      integer := 0;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status <> 'draft' then
    raise exception 'FIELDS_LOCKED: questions can only be changed while the collection is a draft'
      using errcode = 'P0001',
            hint = 'A question key identifies the answers already given against it, so it is fixed once contributors can see the page.';
  end if;
  if jsonb_typeof(p_fields) <> 'array' then
    raise exception 'INVALID_FIELDS: expected a list of questions' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_fields) > 10 then
    raise exception 'INVALID_FIELDS: a collection can ask at most 10 questions' using errcode = 'P0001';
  end if;

  delete from public.collection_fields where collection_id = p_collection_id;

  for v_item in select * from jsonb_array_elements(p_fields)
  loop
    v_key   := lower(nullif(trim(v_item ->> 'key'), ''));
    v_label := nullif(trim(v_item ->> 'label'), '');
    v_type  := (v_item ->> 'type')::public.member_attribute_type;

    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,38}$' then
      raise exception 'INVALID_FIELDS: question key "%" must start with a letter and use only letters, numbers and underscores', coalesce(v_key, '')
        using errcode = 'P0001';
    end if;
    if v_label is null or char_length(v_label) > 80 then
      raise exception 'INVALID_FIELDS: every question needs a label of 80 characters or fewer' using errcode = 'P0001';
    end if;
    if v_key = any (v_keys) then
      raise exception 'DUPLICATE_FIELD_KEY: two questions share the key "%"', v_key using errcode = 'P0001';
    end if;
    v_keys := v_keys || v_key;

    if v_type = 'single_select' then
      select array_agg(trim(value)) into v_options
      from jsonb_array_elements_text(coalesce(v_item -> 'options', '[]'::jsonb))
      where trim(value) <> '';

      if v_options is null or array_length(v_options, 1) is null then
        raise exception 'INVALID_FIELDS: question "%" is a choice, so it needs at least one option', v_label
          using errcode = 'P0001';
      end if;
    else
      v_options := null;
    end if;

    insert into public.collection_fields (
      collection_id, community_id, key, label, type, options, required, sort_order
    ) values (
      p_collection_id, v_collection.community_id, v_key, v_label, v_type, v_options,
      coalesce((v_item ->> 'required')::boolean, false),
      coalesce(nullif(v_item ->> 'sort_order', '')::smallint, v_count::smallint)
    );

    v_count := v_count + 1;
  end loop;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_fields', 'collection', p_collection_id,
    null, jsonb_build_object('question_count', v_count)
  );

  return v_count;
end;
$$;

comment on function app.set_collection_fields(uuid, jsonb) is
  'PRD 4.3: up to ten collection-specific questions, separate from the payment contact details every contributor gives. Draft only — a key identifies the answers stored against it.';


-- ─────────────────────────────────────────────────────────────────────────────
-- Obligations
--
-- What a member is EXPECTED to pay. Never what they have paid: there is no
-- amount_paid column (OBL-01) and no path to status 'paid' (CASH-02, SEC-20a).
-- ─────────────────────────────────────────────────────────────────────────────

-- The expected amount is resolved by the server from the collection, not taken
-- from the caller, whenever the collection already states it (SEC-18 applied to
-- money): a fixed collection's obligation is the fixed amount, full stop. Only
-- a per-member collection — whose whole definition is that each member owes a
-- different amount — reads the caller's figure.
create or replace function app.assign_obligations(
  p_collection_id       uuid,
  p_member_ids          uuid[],
  p_expected_amount_kobo bigint default null,
  p_due_at              timestamptz default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_expected   bigint;
  v_due_at     timestamptz;
  v_member_id  uuid;
  v_created    integer := 0;
  v_obligation_id uuid;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'obligation.assign');

  if v_collection.participation_mode <> 'managed' then
    raise exception 'NOT_MANAGED: only a managed collection has a list of who is expected to pay'
      using errcode = 'P0001',
            hint = 'An open collection accepts anyone with the link, so there is nobody to assign.';
  end if;
  if v_collection.status in ('closed', 'archived', 'suspended') then
    raise exception 'COLLECTION_NOT_EDITABLE: a % collection cannot take new assignments', v_collection.status
      using errcode = 'P0001';
  end if;
  if array_length(p_member_ids, 1) is null then
    raise exception 'NO_MEMBERS: select at least one member' using errcode = 'P0001';
  end if;
  if array_length(p_member_ids, 1) > 500 then
    raise exception 'TOO_MANY_MEMBERS: assign at most 500 members per call' using errcode = 'P0001';
  end if;

  if v_collection.amount_model = 'fixed' then
    v_expected := v_collection.fixed_amount_kobo;
    if p_expected_amount_kobo is not null and p_expected_amount_kobo <> v_expected then
      raise exception 'AMOUNT_NOT_YOURS_TO_SET: this collection charges everyone the same amount'
        using errcode = 'P0001';
    end if;
  else
    v_expected := p_expected_amount_kobo;
    if v_expected is null or v_expected <= 0 then
      raise exception 'INVALID_AMOUNT: say how much these members are expected to pay' using errcode = 'P0001';
    end if;
  end if;

  v_due_at := coalesce(p_due_at, v_collection.deadline_at);

  -- The member list is filtered against the collection's own community rather
  -- than trusted (SEC-18). A member id from another community is not an error
  -- to report back — reporting it would confirm the id exists — it simply
  -- matches nothing.
  for v_member_id in
    select m.id
    from public.members m
    where m.id = any (p_member_ids)
      and m.community_id = v_collection.community_id
      and m.status <> 'merged'
  loop
    v_obligation_id := app.uuid_generate_v7();

    insert into public.obligations (
      id, community_id, collection_id, member_id, expected_amount_kobo, due_at, assigned_by
    ) values (
      v_obligation_id, v_collection.community_id, p_collection_id, v_member_id, v_expected, v_due_at, auth.uid()
    )
    on conflict (collection_id, member_id, cycle_key) do nothing;

    if found then
      v_created := v_created + 1;
      perform app.write_audit_log(
        v_collection.community_id, 'officer', auth.uid(), 'obligation.assign', 'obligation', v_obligation_id,
        null, jsonb_build_object('member_id', v_member_id, 'expected_amount_kobo', v_expected)
      );
    end if;
  end loop;

  return v_created;
end;
$$;

comment on function app.assign_obligations is
  'obligation.assign. Creates one obligation per member, skipping members who already have one (the unique index decides, not a prior read). A fixed collection''s amount comes from the collection; only a per-member collection reads the caller''s figure.';

create or replace function app.update_obligation_amount(
  p_obligation_id       uuid,
  p_expected_amount_kobo bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obligation public.obligations%rowtype;
  v_model      public.amount_model;
begin
  select * into v_obligation from public.obligations where id = p_obligation_id;
  if v_obligation.id is null then
    raise exception 'NOT_FOUND: obligation % does not exist', p_obligation_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_obligation.community_id, 'obligation.assign');

  select amount_model into v_model from public.collections where id = v_obligation.collection_id;
  if v_model <> 'per_member' then
    raise exception 'AMOUNT_NOT_YOURS_TO_SET: this collection sets one amount for everyone'
      using errcode = 'P0001',
            hint = 'To reduce what one member owes, waive part of it with a reason (OBL-08).';
  end if;
  if p_expected_amount_kobo is null or p_expected_amount_kobo <= 0 then
    raise exception 'INVALID_AMOUNT: an expected amount must be above zero' using errcode = 'P0001';
  end if;
  if p_expected_amount_kobo < v_obligation.waived_amount_kobo then
    raise exception 'INVALID_AMOUNT: the expected amount is below what has already been waived'
      using errcode = 'P0001';
  end if;
  if v_obligation.status in ('cancelled', 'paid') then
    raise exception 'OBLIGATION_SETTLED: a % obligation cannot be changed', v_obligation.status
      using errcode = 'P0001';
  end if;

  update public.obligations
  set expected_amount_kobo = p_expected_amount_kobo,
      version              = version + 1
  where id = p_obligation_id;

  perform app.write_audit_log(
    v_obligation.community_id, 'officer', auth.uid(), 'obligation.update_amount', 'obligation', p_obligation_id,
    jsonb_build_object('expected_amount_kobo', v_obligation.expected_amount_kobo),
    jsonb_build_object('expected_amount_kobo', p_expected_amount_kobo)
  );
end;
$$;

comment on function app.update_obligation_amount(uuid, bigint) is
  'obligation.assign, per-member collections only. Everywhere else the amount belongs to the collection and the adjustment a member needs is a waiver, which is labelled as one.';

create or replace function app.cancel_obligation(
  p_obligation_id uuid,
  p_reason        text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obligation public.obligations%rowtype;
begin
  select * into v_obligation from public.obligations where id = p_obligation_id;
  if v_obligation.id is null then
    raise exception 'NOT_FOUND: obligation % does not exist', p_obligation_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_obligation.community_id, 'obligation.assign');

  -- Written as one membership test rather than two equality tests because
  -- 03_money_invariants.sql asserts that no function body anywhere contains an
  -- assignment-shaped reference to the settled status, and a bare equality
  -- check is indistinguishable from one to that rule. Cancelling an already
  -- cancelled obligation is a no-op, not an error.
  if v_obligation.status in ('paid', 'cancelled') then
    if v_obligation.status = 'cancelled' then
      return;
    end if;
    raise exception 'OBLIGATION_SETTLED: an obligation that has been paid cannot be cancelled'
      using errcode = 'P0001';
  end if;

  update public.obligations
  set status       = 'cancelled',
      cancelled_at = now(),
      version      = version + 1
  where id = p_obligation_id;

  perform app.write_audit_log(
    v_obligation.community_id, 'officer', auth.uid(), 'obligation.cancel', 'obligation', p_obligation_id,
    jsonb_build_object('status', v_obligation.status), jsonb_build_object('status', 'cancelled'), p_reason
  );
end;
$$;

comment on function app.cancel_obligation(uuid, text) is
  'OBL-05: an obligation is never deleted. Cancelling keeps the row and the history of it having existed.';

-- OBL-07. The reason is required by the table constraint; it is also required
-- here so the refusal is a sentence rather than a constraint name, and because
-- the audit row the community reads is the point of the reason existing.
create or replace function app.exempt_obligation(
  p_obligation_id uuid,
  p_reason        text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obligation public.obligations%rowtype;
begin
  select * into v_obligation from public.obligations where id = p_obligation_id;
  if v_obligation.id is null then
    raise exception 'NOT_FOUND: obligation % does not exist', p_obligation_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_obligation.community_id, 'obligation.exempt');

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: exempting a member needs a reason, which members and officers can see (OBL-07)'
      using errcode = 'P0001';
  end if;
  if v_obligation.status in ('paid', 'cancelled') then
    raise exception 'OBLIGATION_SETTLED: a % obligation cannot be exempted', v_obligation.status
      using errcode = 'P0001';
  end if;

  update public.obligations
  set exempt        = true,
      exempt_reason = p_reason,
      exempt_by     = auth.uid(),
      exempt_at     = now(),
      status        = 'exempt',
      version       = version + 1
  where id = p_obligation_id;

  perform app.write_audit_log(
    v_obligation.community_id, 'officer', auth.uid(), 'obligation.exempt', 'obligation', p_obligation_id,
    jsonb_build_object('status', v_obligation.status), jsonb_build_object('status', 'exempt'), p_reason
  );
end;
$$;

comment on function app.exempt_obligation(uuid, text) is
  'OBL-07: this member is not expected to pay, and here is why. An exemption is not a payment and is never counted as money collected (CASH-02).';

-- OBL-08. A waiver reduces what is owed without anyone paying it. It is
-- deliberately a separate column from expected_amount_kobo rather than a
-- subtraction: "we asked for ₦5,000 and forgave ₦2,000" and "we asked for
-- ₦3,000" are different facts, and only one of them is true.
create or replace function app.waive_obligation_amount(
  p_obligation_id      uuid,
  p_waived_amount_kobo bigint,
  p_reason             text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obligation public.obligations%rowtype;
begin
  select * into v_obligation from public.obligations where id = p_obligation_id;
  if v_obligation.id is null then
    raise exception 'NOT_FOUND: obligation % does not exist', p_obligation_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_obligation.community_id, 'obligation.exempt');

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: waiving part of a balance needs a reason (OBL-08)' using errcode = 'P0001';
  end if;
  if p_waived_amount_kobo is null or p_waived_amount_kobo <= 0 then
    raise exception 'INVALID_AMOUNT: a waived amount must be above zero' using errcode = 'P0001';
  end if;
  if p_waived_amount_kobo > v_obligation.expected_amount_kobo then
    raise exception 'INVALID_AMOUNT: you cannot waive more than the member was asked for' using errcode = 'P0001';
  end if;
  if v_obligation.status in ('paid', 'cancelled', 'exempt') then
    raise exception 'OBLIGATION_SETTLED: a % obligation cannot be waived', v_obligation.status
      using errcode = 'P0001';
  end if;

  update public.obligations
  set waived_amount_kobo = p_waived_amount_kobo,
      waived_reason      = p_reason,
      waived_by          = auth.uid(),
      waived_at          = now(),
      version            = version + 1
  where id = p_obligation_id;

  perform app.write_audit_log(
    v_obligation.community_id, 'officer', auth.uid(), 'obligation.waive', 'obligation', p_obligation_id,
    jsonb_build_object('waived_amount_kobo', v_obligation.waived_amount_kobo),
    jsonb_build_object('waived_amount_kobo', p_waived_amount_kobo),
    p_reason
  );
end;
$$;

comment on function app.waive_obligation_amount is
  'OBL-08 / CASH-02: a discount, recorded as a discount. Never counted as money collected, and never a route to marking anything paid.';


-- ─────────────────────────────────────────────────────────────────────────────
-- SEC-12: the anonymous read surface, extended by exactly one function
--
-- 20260917121000 established the rule and created two functions under it:
-- get_public_collection and get_public_collection_tiers. A contributor also has
-- to see the questions the collection asks, or the form cannot be rendered
-- before they identify themselves. Same shape, same guards, same whitelist
-- discipline: field definitions only, no answers, nothing about members.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function app.get_public_collection_fields(p_collection_id uuid)
returns table (
  field_id   uuid,
  key        text,
  label      text,
  type       public.member_attribute_type,
  options    text[],
  required   boolean,
  sort_order smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.key, f.label, f.type, f.options, f.required, f.sort_order
  from public.collection_fields f
  join public.collections c on c.id = f.collection_id
  where f.collection_id = p_collection_id
    and c.status in ('active', 'paused', 'closed')
    and c.visibility in ('public', 'unlisted')
  order by f.sort_order, f.label;
$$;

comment on function app.get_public_collection_fields(uuid) is
  'SEC-12: the questions a published collection asks, for the contributor form. Definitions only — answers are not stored anywhere yet, and when they are they will not be readable here.';

revoke all on function app.generate_unique_collection_slug(uuid, text) from public;
revoke all on function app.assert_amount_model_config(
  public.amount_model, bigint, bigint, bigint, bigint
) from public;
-- Every other function in this file is revoked and then granted by name in
-- 20260919120100_collection_and_obligation_grants.sql, following the rule
-- 20260917121100 set: one file decides what a client can reach.
