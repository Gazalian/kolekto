-- ─────────────────────────────────────────────────────────────────────────────
-- 12 — Collection audience and obligation sync
--
-- Coverage for 20260920150000. The distinction this file exists to protect:
--
--   AUDIENCE     configuration — who a collection is for
--   ELIGIBILITY  resolved live from membership and groups
--   OBLIGATION   a record of what someone was asked for
--
-- and the rules that follow from it, all of them the operator's own:
--
--   · sync is idempotent — running it twice creates nothing the second time
--   · a member who becomes eligible later does NOT acquire a debt on their own;
--     the sync has to be asked for
--   · an obligation is never deleted because the audience changed
--   · an open collection has no member list, so there is nothing to sync
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(25);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('81000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@aud.example.test'),
  ('81000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@aud.example.test');

insert into public.users (id, full_name, email) values
  ('81000000-0000-4000-8000-000000000001', 'Audience Owner', 'owner@aud.example.test'),
  ('81000000-0000-4000-8000-000000000002', 'Other Owner',    'other@aud.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('82000000-0000-4000-8000-00000000000a', 'audience-tests-a', 'Audience Tests A', 'university_association', false, '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-00000000000b', 'audience-tests-b', 'Audience Tests B', 'estate',                 false, '81000000-0000-4000-8000-000000000002');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('82000000-0000-4000-8000-00000000000a', '81000000-0000-4000-8000-000000000001', 'owner', 'Audience Owner', 'created'),
  ('82000000-0000-4000-8000-00000000000b', '81000000-0000-4000-8000-000000000002', 'owner', 'Other Owner',    'created');

insert into public.member_groups (id, community_id, name, sort_order) values
  ('83000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-00000000000a', '300 Level', 0),
  ('83000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-00000000000a', '400 Level', 1),
  ('83000000-0000-4000-8000-00000000000b', '82000000-0000-4000-8000-00000000000b', 'Block A',   0);

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
  ('84000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-00000000000a', 'Ada Three',   '+2348090000001', 'AU/0001', 'active',   'manual'),
  ('84000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-00000000000a', 'Bem Three',   '+2348090000002', 'AU/0002', 'active',   'manual'),
  ('84000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-00000000000a', 'Cha Four',    '+2348090000003', 'AU/0003', 'active',   'manual'),
  ('84000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-00000000000a', 'Gone Away',   '+2348090000004', 'AU/0004', 'active',   'manual');

-- members_archived_has_timestamp: the status and the timestamp are one fact, so
-- they are set together rather than in two statements.
update public.members
set status = 'archived', archived_at = now()
where id = '84000000-0000-4000-8000-000000000004';

insert into public.member_group_memberships (member_id, group_id) values
  ('84000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001'),
  ('84000000-0000-4000-8000-000000000002', '83000000-0000-4000-8000-000000000001'),
  ('84000000-0000-4000-8000-000000000003', '83000000-0000-4000-8000-000000000002'),
  ('84000000-0000-4000-8000-000000000004', '83000000-0000-4000-8000-000000000001');


-- ─────────────────────────────────────────────────────────────────────────────
-- The audience is stored, and cannot contradict participation_mode
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_dues as
  select app.create_collection(
    '82000000-0000-4000-8000-00000000000a', 'Level Dues 2026', 'dues',
    'managed', 'fixed', null, 'full_only', 'one_time', 500000
  ) as id;

create temporary table tmp_public as
  select app.create_collection(
    '82000000-0000-4000-8000-00000000000a', 'Open Fundraiser', 'fundraiser',
    'open', 'open_amount'
  ) as id;

reset role;
grant select on tmp_dues, tmp_public to authenticated;

select is(
  (select audience_mode::text from public.collections where id = (select id from tmp_dues)),
  'all_members',
  'a managed collection starts as being for all members — the common case needs no decision'
);

select is(
  (select audience_mode::text from public.collections where id = (select id from tmp_public)),
  'public',
  'an open collection is public, derived rather than asked for'
);

select throws_ok(
  format(
    $$ update public.collections set audience_mode = 'groups' where id = %L $$,
    (select id from tmp_public)
  ),
  '23514', null,
  'a collection cannot be open and for specific groups at the same time'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Groups as an audience
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format(
    $$ select app.set_collection_audience(%L, 'groups', array['83000000-0000-4000-8000-000000000001']::uuid[]) $$,
    (select id from tmp_dues)
  ),
  'a collection can be set to a group audience'
);

select throws_ok(
  format($$ select app.set_collection_audience(%L, 'groups', '{}') $$, (select id from tmp_dues)),
  'P0001', null,
  'a group audience with no groups is refused'
);

select throws_ok(
  format(
    $$ select app.set_collection_audience(%L, 'groups', array['83000000-0000-4000-8000-00000000000b']::uuid[]) $$,
    (select id from tmp_dues)
  ),
  'P0001', null,
  'a group from another community is not an audience here (SEC-18)'
);

reset role;

select is(
  (select count(*)::integer from public.collection_audience_groups where collection_id = (select id from tmp_dues)),
  1,
  'the audience stores a reference to the group, not a copy of its members'
);

-- Eligibility is resolved live: two members are in 300 Level, one is in 400,
-- and the archived member is nobody's problem.
select is(
  (select count(*)::integer from app.resolve_collection_audience((select id from tmp_dues))),
  2,
  'eligibility follows group membership, and excludes archived members'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Materialising obligations
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  app.sync_collection_obligations((select id from tmp_dues)),
  2,
  'syncing creates one obligation per eligible member'
);

select is(
  app.sync_collection_obligations((select id from tmp_dues)),
  0,
  'syncing again creates nothing — it is idempotent'
);

reset role;

select is(
  (select expected_amount_kobo::bigint from public.obligations
   where collection_id = (select id from tmp_dues)
     and member_id = '84000000-0000-4000-8000-000000000001'),
  500000::bigint,
  'the amount comes from the collection, not from whoever pressed the button'
);

select is(
  (select count(*)::integer from public.obligations
   where collection_id = (select id from tmp_dues)
     and member_id = '84000000-0000-4000-8000-000000000004'),
  0,
  'an archived member is not given an obligation'
);


-- ── A member joins the group afterwards ─────────────────────────────────────
-- This is the rule the operator was most explicit about: becoming eligible must
-- not create a debt by itself.
insert into public.member_group_memberships (member_id, group_id)
values ('84000000-0000-4000-8000-000000000003', '83000000-0000-4000-8000-000000000001');

select is(
  (select count(*)::integer from public.obligations where collection_id = (select id from tmp_dues)),
  2,
  'joining the group did not create an obligation on its own'
);

select is(
  (select awaiting from app.count_collection_audience((select id from tmp_dues))),
  1,
  'the newly eligible member is counted as awaiting, which is what the prompt shows'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  app.sync_collection_obligations((select id from tmp_dues)),
  1,
  'the officer asks, and only then is the obligation created'
);

select is(
  (select awaiting from app.count_collection_audience((select id from tmp_dues))),
  0,
  'nobody is awaiting once the sync has run'
);

reset role;


-- ── A member leaves the group ───────────────────────────────────────────────
delete from public.member_group_memberships
where member_id = '84000000-0000-4000-8000-000000000002'
  and group_id = '83000000-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.obligations where collection_id = (select id from tmp_dues)),
  3,
  'leaving the group does not delete the obligation — it records what was asked'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  app.sync_collection_obligations((select id from tmp_dues)),
  0,
  'a later sync does not remove it either'
);

reset role;

select is(
  (select count(*)::integer from public.obligations
   where collection_id = (select id from tmp_dues)
     and member_id = '84000000-0000-4000-8000-000000000002'),
  1,
  'the departed member keeps exactly the obligation they were given'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Where sync does not apply
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  format($$ select app.sync_collection_obligations(%L) $$, (select id from tmp_public)),
  'P0001', null,
  'an open collection has no member list to sync'
);

select lives_ok(
  format($$ select app.set_collection_audience(%L, 'selected_members') $$, (select id from tmp_dues)),
  'a collection can be switched to a hand-picked audience'
);

select throws_ok(
  format($$ select app.sync_collection_obligations(%L) $$, (select id from tmp_dues)),
  'P0001', null,
  'a hand-picked audience is not synced — choosing someone and expecting them to pay are the same act'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Another community cannot reach any of this
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"81000000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok(
  format($$ select app.set_collection_audience(%L, 'all_members') $$, (select id from tmp_dues)),
  '42501', null,
  'an officer of another community cannot change who a collection is for'
);

select throws_ok(
  format($$ select app.sync_collection_obligations(%L) $$, (select id from tmp_dues)),
  '42501', null,
  'an officer of another community cannot create obligations here'
);

select is(
  (select count(*)::integer from public.collection_audience_groups
   where community_id = '82000000-0000-4000-8000-00000000000a'),
  0,
  'an officer of another community reads none of this audience (RLS)'
);

reset role;

select * from finish();
rollback;
