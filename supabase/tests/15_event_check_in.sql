-- ─────────────────────────────────────────────────────────────────────────────
-- 15 — Event check-in (M7.5 part E)
--
-- Coverage for 20260921170000–170200. What matters at a door:
--
--   · only somebody who may work that door can admit anybody
--   · a ticket from another community is refused, not silently honoured
--   · a second tap does not create a second visit
--   · checking out somebody already outside is harmless
--   · an exempted person is refused with a reason
--   · leaving and returning is two visits, not a contradiction
--
-- No money appears anywhere in this file, because no money appears anywhere
-- in the feature: check-in attaches to an obligation, which is the roll an
-- officer created, not a purchase (ADR 0006/0012).
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(15);

-- ── Fixtures: two communities, so "somebody else's ticket" has an owner ─────
insert into auth.users (id, instance_id, aud, role, email) values
  ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@door.example.test'),
  ('a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger@door.example.test');

insert into public.users (id, full_name, email) values
  ('a1000000-0000-4000-8000-000000000001', 'Door Owner', 'owner@door.example.test'),
  ('a1000000-0000-4000-8000-000000000002', 'Other Owner', 'stranger@door.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a2000000-0000-4000-8000-00000000000a', 'door-tests', 'Door Tests', 'social_group', false, 'a1000000-0000-4000-8000-000000000001'),
  ('a2000000-0000-4000-8000-00000000000b', 'door-tests-other', 'Other Hall', 'social_group', false, 'a1000000-0000-4000-8000-000000000002');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 'owner', 'Door Owner', 'created'),
  ('a2000000-0000-4000-8000-00000000000b', 'a1000000-0000-4000-8000-000000000002', 'owner', 'Other Owner', 'created');

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', 'Ada Guest',   '+2348097770001', 'DR/0001', 'active', 'manual'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-00000000000a', 'Bola Exempt', '+2348097770002', 'DR/0002', 'active', 'manual'),
  ('a3000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-00000000000b', 'Other Guest', '+2348097770003', 'OH/0001', 'active', 'manual');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_gala as
  select app.create_collection(
    'a2000000-0000-4000-8000-00000000000a', 'Annual Gala', 'event', 'managed', 'fixed',
    null, 'full_only', 'one_time', 1000000
  ) as id;

select is(
  app.assign_obligations(
    (select id from tmp_gala),
    array['a3000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002']::uuid[],
    null, null
  ),
  2,
  'the gala has a guest list — two obligations, which is what a door can check'
);

reset role;

create temporary table tmp_ada as
  select id from public.obligations
  where collection_id = (select id from tmp_gala) and member_id = 'a3000000-0000-4000-8000-000000000001';
create temporary table tmp_bola as
  select id from public.obligations
  where collection_id = (select id from tmp_gala) and member_id = 'a3000000-0000-4000-8000-000000000002';
grant select on tmp_gala, tmp_ada, tmp_bola to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Admitting
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_visit as
  select app.check_in_obligation((select id from tmp_ada)) as id;

select ok((select id from tmp_visit) is not null, 'an officer can admit somebody on the list');

select is(
  (select count(*)::integer from public.event_check_ins where obligation_id = (select id from tmp_ada)),
  1,
  'admitting records exactly one visit'
);

-- The rule a busy entrance needs: a second tap is not a second person.
select is(
  app.check_in_obligation((select id from tmp_ada)),
  (select id from tmp_visit),
  'admitting somebody already inside returns their open visit rather than raising'
);

select is(
  (select count(*)::integer from public.event_check_ins where obligation_id = (select id from tmp_ada)),
  1,
  'and creates no second row'
);

-- An officer excused this one from the collection entirely (OBL-07), which is
-- a different thing from not having arrived.
select lives_ok(
  format($$ select app.exempt_obligation(%L, 'On duty that evening') $$, (select id from tmp_bola)),
  'somebody can be exempted from the collection'
);

select throws_ok(
  format($$ select app.check_in_obligation(%L) $$, (select id from tmp_bola)),
  'P0001', null,
  'somebody exempted from the collection is not admitted'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Leaving
-- ─────────────────────────────────────────────────────────────────────────────
select lives_ok(
  format($$ select app.check_out_obligation(%L) $$, (select id from tmp_ada)),
  'somebody inside can be checked out'
);

select ok(
  (select checked_out_at is not null from public.event_check_ins where id = (select id from tmp_visit)),
  'the visit records when they left'
);

select lives_ok(
  format($$ select app.check_out_obligation(%L) $$, (select id from tmp_ada)),
  'checking out somebody already outside does nothing and complains about nothing'
);

-- Leaving and coming back is two visits, which is a history rather than a
-- contradiction — the partial unique index only forbids two OPEN visits.
select lives_ok(
  format($$ select app.check_in_obligation(%L) $$, (select id from tmp_ada)),
  'somebody who left can be admitted again'
);

select is(
  (select count(*)::integer from public.event_check_ins where obligation_id = (select id from tmp_ada)),
  2,
  'which is a second visit, not an edit of the first'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Somebody else's door
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok(
  format($$ select app.check_in_obligation(%L) $$, (select id from tmp_ada)),
  '42501', null,
  'an officer of another community cannot admit this community''s guest (SEC-18)'
);

-- And they cannot read the visits either: RLS scopes event_check_ins to
-- whoever may work that community's door, so this reads zero rows rather
-- than somebody else's guest list.
select is(
  (select count(*)::integer from public.event_check_ins where obligation_id = (select id from tmp_ada)),
  0,
  'an officer of another community cannot even see the visits'
);

reset role;

-- Read back without a role: the history is intact, so the refused attempt
-- wrote nothing.
select is(
  (select count(*)::integer from public.event_check_ins where obligation_id = (select id from tmp_ada)),
  2,
  'and the refused attempt left no trace on the visit history'
);

select * from finish();
rollback;
