-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921180200 — Assigning somebody to a tier
--
-- `obligations.tier_id` exists as of 20260921180000, and nothing could set it.
-- This gives the assign path a sixth argument, and takes the price from the
-- tier rather than from the caller when one is named: on a tiered collection
-- the tier IS the amount (ADR 0010 — a tier is a row with a price), and a
-- caller-supplied figure that disagreed with it would be a second source of
-- truth for money.
--
-- ONE SIGNATURE. The live function before this file was
-- `(uuid, uuid[], bigint, timestamptz, text)` — the period-aware version from
-- 20260920160700, which itself replaced a four-argument one. Adding a
-- defaulted parameter to a plpgsql function does not replace it, it overloads
-- it, and every existing four-argument call then fails with "function … is
-- not unique". That is exactly what happened when this file was first written
-- against the four-argument version that no longer existed. Both older
-- signatures are dropped here so there is one function with one meaning.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists app.assign_obligations(uuid, uuid[], bigint, timestamptz);
drop function if exists app.assign_obligations(uuid, uuid[], bigint, timestamptz, text);
drop function if exists app.assign_obligations(uuid, uuid[], bigint, timestamptz, uuid);

create or replace function app.assign_obligations(
  p_collection_id        uuid,
  p_member_ids           uuid[],
  p_expected_amount_kobo bigint      default null,
  p_due_at               timestamptz default null,
  p_cycle_key            text        default null,
  p_tier_id              uuid        default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_cycle      public.collection_cycles%rowtype;
  v_tier       public.collection_tiers%rowtype;
  v_expected   bigint;
  v_due_at     timestamptz;
  v_cycle_key  text;
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

  -- The period, under the same rule sync_collection_obligations follows.
  if v_collection.schedule = 'recurring' then
    if p_cycle_key is null then
      raise exception 'CYCLE_REQUIRED: say which period these members are being charged for'
        using errcode = 'P0001',
              hint = 'Open a period first — a recurring charge is owed for a month, not in general.';
    end if;

    select * into v_cycle
    from public.collection_cycles
    where collection_id = p_collection_id and cycle_key = p_cycle_key;

    if v_cycle.id is null then
      raise exception 'NOT_FOUND: this collection has no period called %', p_cycle_key using errcode = 'P0002';
    end if;
    if v_cycle.closed_at is not null then
      raise exception 'CYCLE_CLOSED: % has been closed', p_cycle_key using errcode = 'P0001';
    end if;

    v_cycle_key := v_cycle.cycle_key;
    v_due_at    := coalesce(p_due_at, v_cycle.due_at, v_collection.deadline_at);
  else
    if p_cycle_key is not null then
      raise exception 'NOT_RECURRING: this collection has no periods' using errcode = 'P0001';
    end if;
    v_cycle_key := null;
    v_due_at    := coalesce(p_due_at, v_collection.deadline_at);
  end if;

  -- The tier, if one was named. Resolved against THIS collection, so a tier
  -- id from another collection matches nothing and is refused (SEC-18).
  if p_tier_id is not null then
    select * into v_tier
    from public.collection_tiers
    where id = p_tier_id and collection_id = p_collection_id;

    if v_tier.id is null then
      raise exception 'NOT_FOUND: that option does not belong to this collection' using errcode = 'P0002';
    end if;
    if v_collection.amount_model <> 'tiers' then
      raise exception 'NOT_TIERED: this collection does not have options to assign people to'
        using errcode = 'P0001';
    end if;
  end if;

  if v_tier.id is not null then
    -- The tier's price, not the caller's. ADR 0010.
    v_expected := v_tier.price_kobo;
  elsif v_collection.amount_model = 'fixed' then
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
      id, community_id, collection_id, member_id, cycle_key, expected_amount_kobo, due_at, assigned_by, tier_id
    ) values (
      v_obligation_id, v_collection.community_id, p_collection_id, v_member_id, v_cycle_key,
      v_expected, v_due_at, auth.uid(), p_tier_id
    )
    on conflict (collection_id, member_id, cycle_key) do nothing;

    if found then
      v_created := v_created + 1;
      perform app.write_audit_log(
        v_collection.community_id, 'officer', auth.uid(), 'obligation.assign', 'obligation', v_obligation_id,
        null,
        jsonb_build_object(
          'member_id', v_member_id, 'expected_amount_kobo', v_expected,
          'cycle_key', v_cycle_key, 'tier_id', p_tier_id
        )
      );

      -- A collection that issues references issues them as the roll is built,
      -- not as a separate chore somebody has to remember. Cheap, idempotent,
      -- and it means the reference exists by the time anyone looks.
      if v_collection.codes_enabled then
        perform app.issue_contributor_reference(v_obligation_id);
      end if;
    end if;
  end loop;

  return v_created;
end;
$$;

comment on function app.assign_obligations(uuid, uuid[], bigint, timestamptz, text, uuid) is
  'obligation.assign. Hand-picked assignment. A recurring charge is owed for a named period, never in general. A tier, when named, supplies the amount; a fixed collection''s amount comes from the collection; only a per-member collection reads the caller''s figure. Issues a contributor reference when the collection has them switched on.';

revoke execute on function app.assign_obligations(uuid, uuid[], bigint, timestamptz, text, uuid) from public;
grant  execute on function app.assign_obligations(uuid, uuid[], bigint, timestamptz, text, uuid) to authenticated;
