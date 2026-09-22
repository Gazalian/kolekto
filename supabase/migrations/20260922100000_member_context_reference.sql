-- ─────────────────────────────────────────────────────────────────────────────
-- 20260922100000 — The contributor sees their own reference
--
-- M7.6 part N. The reference exists so that a person and an organiser can
-- talk about the same participation: "I paid, my reference is BIO26-0042."
-- That only works if the person has been told what it is. Until now it was
-- visible on the organiser's roll and nowhere else, which makes it an
-- internal number rather than a reference.
--
-- WHO THIS SHOWS IT TO. `app.get_collection_member_context` is the function
-- behind "find yourself on the list" (M7). It already returns that member's
-- name, their community identifier and what they personally are expected to
-- pay, and it returns rows only after `app.collection_accepts_identification`
-- and a re-check that the member is still in the collection's audience. The
-- reference is one more fact about the same participation, disclosed to the
-- same person under the same checks. Nobody can list references with it: it
-- takes one member id and returns one row.
--
-- WHY IT IS NOT NEW STATE. It is a join to the row that already exists, on
-- the obligation the function already resolved.
--
-- Written from the live definition read back with pg_get_functiondef, with
-- one column added — see the header of 20260921190100 for why a SELECT list
-- in this schema is never reconstructed from memory.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists app.get_collection_member_context(uuid, uuid);

create or replace function app.get_collection_member_context(p_collection_id uuid, p_member_id uuid)
returns table (
  member_id            uuid,
  full_name            text,
  member_code          text,
  identifier_label     text,
  identifier_value     text,
  obligation_id        uuid,
  cycle_key            text,
  cycle_label          text,
  expected_amount_kobo bigint,
  waived_amount_kobo   bigint,
  obligation_status    public.obligation_status,
  due_at               timestamptz,
  -- New in M7.6. Null when this collection does not issue references, or
  -- when this member has not been given one yet.
  contributor_reference text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_schedule     public.collection_schedule;
  v_cycle        public.collection_cycles%rowtype;
  v_primary_id   uuid;
  v_primary_label text;
begin
  if not app.collection_accepts_identification(p_collection_id) then
    return;  -- No rows. The caller cannot tell this from "not that member".
  end if;

  select community_id, schedule into v_community_id, v_schedule
  from public.collections where id = p_collection_id;

  -- Still eligible, checked now rather than remembered from the lookup: a
  -- member archived between the two calls stops being able to continue.
  if not exists (
    select 1 from app.resolve_collection_audience(p_collection_id) a where a.member_id = p_member_id
  ) then
    return;
  end if;

  select id, label into v_primary_id, v_primary_label
  from public.member_attribute_definitions
  where community_id = v_community_id and is_primary_identifier;

  -- A recurring collection is asking about one period: the open one.
  if v_schedule = 'recurring' then
    select * into v_cycle
    from public.collection_cycles
    where collection_id = p_collection_id and closed_at is null
    order by period_start desc
    limit 1;
  end if;

  return query
  select
    m.id,
    m.full_name,
    m.member_code,
    v_primary_label,
    (
      select mav.value_text
      from public.member_attribute_values mav
      where mav.member_id = m.id and mav.definition_id = v_primary_id
    ),
    o.id,
    o.cycle_key,
    -- The period as a person says it: "1 Oct 2026 – 31 Oct 2026".
    case when v_cycle.id is null then null
         else to_char(v_cycle.period_start, 'DD Mon YYYY') || ' – ' || to_char(v_cycle.period_end, 'DD Mon YYYY')
    end,
    -- Cast out of the app.kobo domain: RETURN QUERY matches the declared
    -- return type exactly, and a domain is not its base type to that check.
    o.expected_amount_kobo::bigint,
    o.waived_amount_kobo::bigint,
    o.status,
    o.due_at,
    r.reference
  from public.members m
  left join public.obligations o
    on o.collection_id = p_collection_id
   and o.member_id = m.id
   and o.status <> 'cancelled'
   and (v_schedule <> 'recurring' or o.cycle_key is not distinct from v_cycle.cycle_key)
  left join public.contributor_references r
    on r.obligation_id = o.id
  where m.id = p_member_id;
end;
$$;

comment on function app.get_collection_member_context(uuid, uuid) is
  'M7: what one identified member is asked for on one collection. Returns rows only after the collection accepts identification and the member is still in its audience. Includes their contributor reference (M7.6 part N) so the person and the organiser can name the same participation.';

revoke all     on function app.get_collection_member_context(uuid, uuid) from public;
grant  execute on function app.get_collection_member_context(uuid, uuid) to anon, authenticated;
