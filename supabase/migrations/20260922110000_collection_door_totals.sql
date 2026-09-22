-- ─────────────────────────────────────────────────────────────────────────────
-- 20260922110000 — The door's counters, counted by the database
--
-- M7.6 hardening, item 1. The check-in screen's three numbers — expected,
-- inside now, not arrived — were computed in the page handler by reading
-- every obligation and every check-in for the collection and counting the
-- arrays. That is the same defect the roll had: fine at twenty guests, a
-- thousand-row PostgREST cap at a thousand, and a lot of rows over the wire
-- either way.
--
-- "Not arrived" is the reason this is a function rather than three count
-- queries. Somebody may be admitted, leave, and be admitted again, so the
-- table is a history: answering "how many people have never been through the
-- door?" needs DISTINCT over obligation_id, which PostgREST cannot express
-- as a count. One function, one round trip, exact.
--
-- Modelled on app.count_collection_audience, which already does exactly this
-- for the "newly eligible" prompt.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.collection_door_totals(p_collection_id uuid)
returns table (
  expected     integer,
  inside       integer,
  has_left     integer,
  not_arrived  integer
)
language plpgsql
stable
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

  -- The same permission the door itself needs. Tenancy comes from the
  -- collection row, never from the caller (SEC-18).
  perform app.require_permission(v_collection.community_id, 'attendance.check_in');

  return query
  with roll as (
    select o.id
    from public.obligations o
    where o.collection_id = p_collection_id
      and o.status <> 'cancelled'
  ),
  -- One row per person who is inside right now. The partial unique index
  -- event_check_ins_one_open_visit guarantees at most one open visit each,
  -- so this needs no DISTINCT.
  currently_inside as (
    select c.obligation_id
    from public.event_check_ins c
    join roll r on r.id = c.obligation_id
    where c.checked_out_at is null
  ),
  -- Everyone who has been through the door at all, however many times.
  ever_admitted as (
    select distinct c.obligation_id
    from public.event_check_ins c
    join roll r on r.id = c.obligation_id
  )
  select
    (select count(*)::integer from roll),
    (select count(*)::integer from currently_inside),
    (select count(*)::integer from ever_admitted) - (select count(*)::integer from currently_inside),
    (select count(*)::integer from roll) - (select count(*)::integer from ever_admitted);
end;
$$;

comment on function app.collection_door_totals(uuid) is
  'M7.6: expected / inside now / left / not arrived for a collection''s door, counted in the database. "Not arrived" needs DISTINCT over a visit history, which is why this is a function rather than three count queries.';

revoke all     on function app.collection_door_totals(uuid) from public;
grant  execute on function app.collection_door_totals(uuid) to authenticated;
