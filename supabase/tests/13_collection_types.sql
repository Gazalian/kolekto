-- ─────────────────────────────────────────────────────────────────────────────
-- 13 — Collection types
--
-- Coverage for 20260920160100–160300: items, events, suggested amounts,
-- recurrence and cycles.
--
-- The rules worth protecting, all of them versions of the same idea — that what
-- a contributor will be charged is decided by the database, from a stable
-- identity, and cannot be edited out from under them once published:
--
--   · an item is identified by its id, never its name (ADR 0010 for items)
--   · an item cannot exist on a collection that does not sell items
--   · items and prices are fixed once published; a venue is not
--   · a recurring collection owes per period, and a period has to be opened
--   · a cycle is opened once and cannot be opened twice
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(44);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('91000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@typ.example.test');

insert into public.users (id, full_name, email) values
  ('91000000-0000-4000-8000-000000000001', 'Type Owner', 'owner@typ.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('92000000-0000-4000-8000-00000000000a', 'type-tests', 'Type Tests', 'social_group', false, '91000000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('92000000-0000-4000-8000-00000000000a', '91000000-0000-4000-8000-000000000001', 'owner', 'Type Owner', 'created');

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
  ('93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-00000000000a', 'Resident One', '+2348095550001', 'TT/0001', 'active', 'manual'),
  ('93000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-00000000000a', 'Resident Two', '+2348095550002', 'TT/0002', 'active', 'manual');


-- ─────────────────────────────────────────────────────────────────────────────
-- Items
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_asoebi as
  select app.create_collection(
    '92000000-0000-4000-8000-00000000000a', 'Aso-Ebi Order', 'items', 'open', 'items'
  ) as id;

create temporary table tmp_dinner as
  select app.create_collection(
    '92000000-0000-4000-8000-00000000000a', 'Annual Dinner', 'event', 'open', 'tiers'
  ) as id;

select is(
  app.set_collection_items(
    (select id from tmp_asoebi),
    '[{"name": "Blue", "price_kobo": "3500000", "quantity_available": 40, "max_per_order": 4},
      {"name": "Gold", "price_kobo": "5000000"}]'::jsonb
  ),
  2,
  'an item collection stores the items it was given'
);

select throws_ok(
  format(
    $$ select app.set_collection_items(%L, '[{"name": "Blue", "price_kobo": "1"}, {"name": "blue", "price_kobo": "2"}]'::jsonb) $$,
    (select id from tmp_asoebi)
  ),
  'P0001', null,
  'two items with the same name are refused — a receipt could not tell them apart'
);

select throws_ok(
  format($$ select app.set_collection_items(%L, '[{"name": "Free", "price_kobo": "0"}]'::jsonb) $$,
         (select id from tmp_asoebi)),
  'P0001', null,
  'an item priced at zero is refused'
);

select throws_ok(
  format($$ select app.set_collection_items(%L, '[{"name": "Ticket", "price_kobo": "100"}]'::jsonb) $$,
         (select id from tmp_dinner)),
  'P0001', null,
  'a collection that sells tiers cannot be given items'
);

reset role;

create temporary table tmp_blue as
  select id from public.collection_items
  where collection_id = (select id from tmp_asoebi) and name = 'Blue';
grant select on tmp_blue, tmp_asoebi, tmp_dinner to authenticated;

select is(
  (select quantity_available from public.collection_items where id = (select id from tmp_blue)),
  40,
  'an item carries how many exist to sell'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The ADR 0010 rule, for items: renaming keeps identity.
select is(
  app.set_collection_items(
    (select id from tmp_asoebi),
    (select jsonb_build_array(
       jsonb_build_object('id', (select id from tmp_blue), 'name', 'Royal Blue', 'price_kobo', '3800000'),
       jsonb_build_object('name', 'Gold', 'price_kobo', '5000000')
     ))
  ),
  2,
  'an item can be renamed and repriced in place'
);

reset role;

select ok(
  exists (
    select 1 from public.collection_items
    where id = (select id from tmp_blue) and name = 'Royal Blue' and price_kobo = 3800000
  ),
  'the renamed item kept its identity — the same row, not a replacement'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- The event a ticketed collection is for
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format(
    $$ select app.set_collection_event(%L, '2026-12-20 18:00+01'::timestamptz, '2026-12-20 23:00+01'::timestamptz, 'Ostrich Hall, Ilorin') $$,
    (select id from tmp_dinner)
  ),
  'a ticketed collection records the event it is for'
);

select throws_ok(
  format(
    $$ select app.set_collection_event(%L, '2026-12-20 18:00+01'::timestamptz, '2026-12-19 18:00+01'::timestamptz) $$,
    (select id from tmp_dinner)
  ),
  'P0001', null,
  'an event cannot end before it starts'
);

-- §18: an organiser may ask the public form to collect one name per ticket
-- rather than only the buyer's — off by default, on when the event sets it.
select is(
  (select collect_attendee_details from public.collections where id = (select id from tmp_dinner)),
  false,
  'a ticketed collection does not collect attendee details unless asked to'
);

select lives_ok(
  format(
    $$ select app.set_collection_event(%L, '2026-12-20 18:00+01'::timestamptz, '2026-12-20 23:00+01'::timestamptz, 'Ostrich Hall, Ilorin', true) $$,
    (select id from tmp_dinner)
  ),
  'the event can ask for attendee details'
);

select is(
  (select collect_attendee_details from public.collections where id = (select id from tmp_dinner)),
  true,
  'the setting is stored'
);

-- Tickets are tiers: stable ids, availability, and a price that locks on publish.
select is(
  app.set_collection_tiers(
    (select id from tmp_dinner),
    '[{"name": "Regular", "price_kobo": "500000", "quantity_limit": 100},
      {"name": "VIP", "price_kobo": "1500000", "quantity_limit": 20}]'::jsonb
  ),
  2,
  'ticket types are tiers, with their own availability'
);

select is(
  app.transition_collection_status((select id from tmp_dinner), 'draft', 'active')::text,
  'active',
  'a ticketed collection publishes'
);

select lives_ok(
  format(
    $$ select app.set_collection_event(%L, '2026-12-21 18:00+01'::timestamptz, null, 'Moved to the Banquet Hall') $$,
    (select id from tmp_dinner)
  ),
  'the venue and date can still change after publication — ticket-holders need to be told'
);

-- Regression: app.get_public_collection was redefined twice in this session
-- (attendee details, then the fundraiser story) from a copy of the function
-- that predated audience_mode being added to it, silently dropping the
-- column from its return shape both times. Nothing caught it until the
-- public contribution page started treating every open collection as if it
-- were `audience_mode = null` — which is not `'public'` — and sent every
-- contributor to "find yourself on the list" ahead of a form that was never
-- gated at all. Fixed in 20260921140000; this is the test that should have
-- caught it, and now would.
select is(
  (select audience_mode from app.get_public_collection('type-tests', (select slug from public.collections where id = (select id from tmp_dinner)))),
  'public',
  'the public page can tell an open collection is not asking a named list'
);

select throws_ok(
  format($$ select app.set_collection_tiers(%L, '[{"name": "Regular", "price_kobo": "100"}]'::jsonb) $$,
         (select id from tmp_dinner)),
  'P0001', null,
  'the ticket price cannot change after publication'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Suggested amounts
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_fund as
  select app.create_collection(
    '92000000-0000-4000-8000-00000000000a', 'Medical Fund', 'fundraiser', 'open', 'open_amount',
    null, 'full_only', 'one_time', null, 100000, 10000000, 200000000
  ) as id;

select lives_ok(
  format($$ select app.set_collection_suggested_amounts(%L, array[500000, 1000000, 2000000]::bigint[]) $$,
         (select id from tmp_fund)),
  'a fundraiser can suggest amounts'
);

select throws_ok(
  format($$ select app.set_collection_suggested_amounts(%L, array[50000]::bigint[]) $$, (select id from tmp_fund)),
  'P0001', null,
  'a suggestion below the smallest allowed contribution is refused'
);

select throws_ok(
  format($$ select app.set_collection_suggested_amounts(%L, array[500000]::bigint[]) $$, (select id from tmp_asoebi)),
  'P0001', null,
  'suggestions make no sense where the contributor does not choose the amount'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- A fundraiser's story (§5/§19)
-- ─────────────────────────────────────────────────────────────────────────────

select lives_ok(
  format(
    $$ select app.set_collection_story(%L, 'A library for 200 students', 'Three books shared among 200 children', 'Buys 500 books and a shelf') $$,
    (select id from tmp_fund)
  ),
  'a fundraiser can record its story'
);

select is(
  (select story_why from public.collections where id = (select id from tmp_fund)),
  'Three books shared among 200 children',
  'the story is stored'
);

select throws_ok(
  format($$ select app.set_collection_story(%L, 'Not a fundraiser') $$, (select id from tmp_asoebi)),
  'P0001', null,
  'a story makes no sense where the collection is not a fundraiser'
);

select throws_ok(
  format($$ select app.set_collection_story(%L, %L) $$, (select id from tmp_fund), repeat('x', 2001)),
  'P0001', null,
  'a story section is refused past 2000 characters'
);

reset role;

select is(
  (select suggested_amounts_kobo from public.collections where id = (select id from tmp_fund)),
  array[500000, 1000000, 2000000]::bigint[],
  'the suggestions are stored as integer kobo'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Recurring collections and their cycles
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_charge as
  select app.create_collection(
    '92000000-0000-4000-8000-00000000000a', 'Estate Service Charge', 'dues',
    'managed', 'fixed', null, 'full_only', 'recurring', 2500000
  ) as id;

reset role;
grant select on tmp_charge, tmp_fund to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format($$ select app.set_collection_recurrence(%L, 'monthly', 1::smallint, '2026-10-01'::date, 9::smallint) $$,
         (select id from tmp_charge)),
  'a recurring collection records how often it repeats'
);

select throws_ok(
  format($$ select app.set_collection_recurrence(%L, 'monthly') $$, (select id from tmp_fund)),
  'P0001', null,
  'a one-time collection has no repeat schedule to set'
);

select is(
  app.transition_collection_status((select id from tmp_charge), 'draft', 'active')::text,
  'active',
  'a recurring collection publishes'
);

select throws_ok(
  format($$ select app.set_collection_recurrence(%L, 'weekly') $$, (select id from tmp_charge)),
  'P0001', null,
  'how often a published charge repeats cannot change — members agreed to monthly'
);

-- A recurring obligation belongs to a period, so the period has to exist first.
select throws_ok(
  format($$ select app.sync_collection_obligations(%L) $$, (select id from tmp_charge)),
  'P0001', null,
  'a recurring collection will not create obligations for no particular month'
);

create temporary table tmp_cycle as
  select * from app.open_collection_cycle((select id from tmp_charge));

reset role;
grant select on tmp_cycle to authenticated;

select is(
  (select cycle_key from tmp_cycle),
  '2026-10',
  'opening a period labels it the way a person would say it'
);

select is(
  (select period_end from tmp_cycle),
  '2026-10-31'::date,
  'a monthly period runs to the end of the month'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  app.sync_collection_obligations((select id from tmp_charge), null, null, (select cycle_key from tmp_cycle)),
  2,
  'obligations are created for the named period'
);

select is(
  app.sync_collection_obligations((select id from tmp_charge), null, null, (select cycle_key from tmp_cycle)),
  0,
  'syncing the same period again creates nothing'
);

create temporary table tmp_cycle2 as
  select * from app.open_collection_cycle((select id from tmp_charge));

select is(
  (select cycle_key from tmp_cycle2),
  '2026-11',
  'the next period follows the last one'
);

select is(
  app.sync_collection_obligations((select id from tmp_charge), null, null, (select cycle_key from tmp_cycle2)),
  2,
  'November is owed separately from October — one obligation per member per period'
);

reset role;

select is(
  (select count(*)::integer from public.obligations where collection_id = (select id from tmp_charge)),
  4,
  'two members across two periods is four obligations, each tied to its month'
);

-- Hand-assignment follows the same rule as the sync, because the row it writes
-- is the same row. Without this, a hand-assigned obligation would belong to no
-- month and a later sync would charge the member twice.
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  format(
    $$ select app.assign_obligations(%L, array['93000000-0000-4000-8000-000000000001']::uuid[]) $$,
    (select id from tmp_charge)
  ),
  'P0001', null,
  'a recurring collection will not hand-assign an obligation for no particular month'
);

select throws_ok(
  format(
    $$ select app.assign_obligations(%L, array['93000000-0000-4000-8000-000000000001']::uuid[], null, null, '2026-12') $$,
    (select id from tmp_charge)
  ),
  'P0002', null,
  'assigning to a period that was never opened is refused'
);

select is(
  app.assign_obligations(
    (select id from tmp_charge),
    array['93000000-0000-4000-8000-000000000001']::uuid[],
    null, null, (select cycle_key from tmp_cycle)
  ),
  0,
  'a member already charged for October is not charged for it twice'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- The flyer
--
-- The URL is client-supplied text that ends up rendered on a public page, so
-- the function only accepts one pointing into this deployment's own bucket.
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format(
    $$ select app.set_collection_cover(%L, 'http://127.0.0.1:54321/storage/v1/object/public/collection-covers/92000000-0000-4000-8000-00000000000a/%s/1.jpg') $$,
    (select id from tmp_fund), (select id from tmp_fund)
  ),
  'a collection accepts a flyer uploaded to its own folder'
);

-- SEC-18: the object path carries the community and the collection, so one
-- collection cannot be pointed at another one's image.
select throws_ok(
  format(
    $$ select app.set_collection_cover(%L, 'http://127.0.0.1:54321/storage/v1/object/public/collection-covers/92000000-0000-4000-8000-00000000000a/%s/1.jpg') $$,
    (select id from tmp_fund), (select id from tmp_asoebi)
  ),
  'P0001', null,
  'a flyer belonging to another collection is refused'
);

select throws_ok(
  format($$ select app.set_collection_cover(%L, 'https://example.test/someone-elses-poster.jpg') $$,
         (select id from tmp_fund)),
  'P0001', null,
  'a flyer hosted somewhere else is refused — the public page would be serving another site''s content'
);

select lives_ok(
  format($$ select app.set_collection_cover(%L, null) $$, (select id from tmp_fund)),
  'a flyer can be removed'
);

reset role;

select * from finish();
rollback;
