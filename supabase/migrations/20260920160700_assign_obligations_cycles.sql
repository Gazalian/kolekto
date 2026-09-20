-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920160700 — Hand-assignment learns about periods
--
-- 20260920160300 taught app.sync_collection_obligations that a recurring
-- collection's obligation belongs to a period. app.assign_obligations, which is
-- the other way an obligation comes into existence, was left behind: it still
-- inserted with cycle_key null.
--
-- On a recurring collection that is a defect, not a gap in a feature. The row
-- it produces is a debt for no particular month:
--
--   · it is not counted by count_collection_audience, which scopes to the open
--     period, so the screen says the member is still unassigned;
--   · a later sync for October then inserts a SECOND obligation for the same
--     member, because (collection, member, null) and (collection, member,
--     '2026-10') are different rows to the unique index;
--   · and no statement of "what you owe for October" can ever include or
--     exclude it correctly.
--
-- So this file gives assign_obligations the same rule: name the period, or, on
-- a collection that has no periods, name nothing. The function is dropped and
-- recreated rather than replaced, because adding a defaulted parameter to an
-- existing signature leaves the old one callable and ambiguous.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists app.assign_obligations(uuid, uuid[], bigint, timestamptz);

create or replace function app.assign_obligations(
  p_collection_id        uuid,
  p_member_ids           uuid[],
  p_expected_amount_kobo bigint default null,
  p_due_at               timestamptz default null,
  p_cycle_key            text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_cycle      public.collection_cycles%rowtype;
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
      id, community_id, collection_id, member_id, cycle_key, expected_amount_kobo, due_at, assigned_by
    ) values (
      v_obligation_id, v_collection.community_id, p_collection_id, v_member_id, v_cycle_key,
      v_expected, v_due_at, auth.uid()
    )
    on conflict (collection_id, member_id, cycle_key) do nothing;

    if found then
      v_created := v_created + 1;
      perform app.write_audit_log(
        v_collection.community_id, 'officer', auth.uid(), 'obligation.assign', 'obligation', v_obligation_id,
        null,
        jsonb_build_object('member_id', v_member_id, 'expected_amount_kobo', v_expected, 'cycle_key', v_cycle_key)
      );
    end if;
  end loop;

  return v_created;
end;
$$;

comment on function app.assign_obligations(uuid, uuid[], bigint, timestamptz, text) is
  'obligation.assign. Hand-picked assignment, with the same period rule as sync_collection_obligations: a recurring charge is owed for a named period, never in general.';

revoke execute on function app.assign_obligations(uuid, uuid[], bigint, timestamptz, text) from public;
grant  execute on function app.assign_obligations(uuid, uuid[], bigint, timestamptz, text) to authenticated;
