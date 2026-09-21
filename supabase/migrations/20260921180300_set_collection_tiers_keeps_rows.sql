-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921180300 — Editing options without destroying them
--
-- WHY THIS HAS TO CHANGE NOW. `app.set_collection_tiers` replaced the whole
-- set with DELETE-then-INSERT, carrying the ids across so nothing appeared to
-- move. Nothing referenced a tier row, so nothing noticed. As of
-- 20260921180000 two things do: `obligations.tier_id` and
-- `contributor_references.tier_id`, both ON DELETE RESTRICT. The old
-- implementation would now fail on any draft where somebody has been assigned
-- to an option — including when the edit was merely adding a second option.
--
-- WHY IT WAS WRITTEN THAT WAY. `collection_tiers_unique_name` is a plain
-- unique index, so it is checked per statement and cannot be deferred.
-- Renaming two options to each other's names — a real edit, and one an
-- organiser makes while a draft is still soft — collides halfway through a
-- row-by-row update and leaves the collection in neither shape.
--
-- WHAT THIS DOES INSTEAD. Three statements instead of two:
--
--   1. park every surviving row on a name nothing can collide with, and drop
--      its code prefix, which has a unique index of its own
--   2. write the real values, now that the old ones are out of the way
--   3. delete only the rows the payload dropped, and insert the new ones
--
-- The swap still works, the ids survive, and an option somebody is already
-- assigned to cannot be silently deleted — step 3 hits the foreign key and
-- says so, which is the correct answer to "remove the tier eleven people are
-- booked onto".
-- ─────────────────────────────────────────────────────────────────────────────

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
  v_prefixes   text[] := '{}';
  v_prefix     text;
  v_count      integer := 0;
  v_orphan     record;
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

    -- M7.6 part K: the prefix an option's references are numbered under. Two
    -- options sharing one would merge two series that are supposed to be
    -- separate, so it is refused in the same breath as a duplicate name.
    v_prefix := nullif(upper(trim(coalesce(v_item ->> 'code_prefix', ''))), '');
    if v_prefix is not null then
      if v_prefix !~ '^[A-Z0-9]{1,8}$' then
        raise exception 'INVALID_TIER_PREFIX: "%" must be 1 to 8 letters or digits', v_prefix
          using errcode = 'P0001';
      end if;
      if v_prefix = any (v_prefixes) then
        raise exception 'DUPLICATE_TIER_PREFIX: two options both use the prefix "%"', v_prefix
          using errcode = 'P0001',
                hint = 'Each option needs its own prefix, or references from different options would share a series.';
      end if;
      v_prefixes := v_prefixes || v_prefix;
    end if;

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

  -- An option somebody is already assigned to cannot be dropped. The foreign
  -- key would stop it anyway; this stops it with a sentence that names the
  -- option rather than the constraint.
  for v_orphan in
    select t.id, t.name, count(o.id) as assigned
    from public.collection_tiers t
    join public.obligations o on o.tier_id = t.id
    where t.collection_id = p_collection_id
      and not (t.id = any (v_payload_ids))
    group by t.id, t.name
  loop
    raise exception
      'TIER_IN_USE: "%" cannot be removed — % member(s) are assigned to it', v_orphan.name, v_orphan.assigned
      using errcode = 'P0001',
            hint = 'Move those members to another option first, or hide this one instead of removing it.';
  end loop;

  -- Step 1: park EVERY existing row somewhere nothing collides, so a two-way
  -- rename has room to happen. `__t:<uuid>` is 39 characters, inside the
  -- 1..60 the name constraint allows, and unique by construction.
  --
  -- Every row, not only the survivors: an option being dropped still holds
  -- its name and its prefix until step 3 deletes it, and a survivor taking
  -- over that name — "VIP" moving from the option you removed to the one you
  -- kept — would collide against a row that is on its way out.
  update public.collection_tiers
  set name = '__t:' || id::text, code_prefix = null
  where collection_id = p_collection_id;

  -- Step 2: the real values, on the rows that already exist.
  v_count := 0;
  for v_item in select * from jsonb_array_elements(p_tiers)
  loop
    v_id := nullif(v_item ->> 'id', '')::uuid;
    if v_id is not null then
      update public.collection_tiers
      set name            = trim(v_item ->> 'name'),
          description     = nullif(trim(v_item ->> 'description'), ''),
          price_kobo      = (v_item ->> 'price_kobo')::bigint,
          quantity_limit  = nullif(v_item ->> 'quantity_limit', '')::integer,
          per_order_limit = nullif(v_item ->> 'per_order_limit', '')::integer,
          code_prefix     = nullif(upper(trim(coalesce(v_item ->> 'code_prefix', ''))), ''),
          hidden          = coalesce((v_item ->> 'hidden')::boolean, false),
          sort_order      = coalesce(nullif(v_item ->> 'sort_order', '')::smallint, v_count::smallint)
      where id = v_id;
    end if;
    v_count := v_count + 1;
  end loop;

  -- Step 3: the rows the payload dropped, and the ones it added.
  delete from public.collection_tiers
  where collection_id = p_collection_id
    and not (id = any (v_payload_ids));

  v_count := 0;
  for v_item in select * from jsonb_array_elements(p_tiers)
  loop
    if nullif(v_item ->> 'id', '') is null then
      insert into public.collection_tiers (
        id, collection_id, community_id, name, description, price_kobo,
        quantity_limit, per_order_limit, code_prefix, hidden, sort_order
      ) values (
        app.uuid_generate_v7(), p_collection_id, v_collection.community_id,
        trim(v_item ->> 'name'),
        nullif(trim(v_item ->> 'description'), ''),
        (v_item ->> 'price_kobo')::bigint,
        nullif(v_item ->> 'quantity_limit', '')::integer,
        nullif(v_item ->> 'per_order_limit', '')::integer,
        nullif(upper(trim(coalesce(v_item ->> 'code_prefix', ''))), ''),
        coalesce((v_item ->> 'hidden')::boolean, false),
        v_count::smallint
      );
    end if;
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
  'ADR 0010. Matched by tier ID, never by display name, and now updated in place rather than replaced — an option a member is assigned to keeps its row (M7.6). Draft only: after publication a price is part of the published offer. Returns the number of options.';
