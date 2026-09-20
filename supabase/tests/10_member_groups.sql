-- ─────────────────────────────────────────────────────────────────────────────
-- 10 — Member groups
--
-- Coverage for 20260920130000. Groups are how a collection will later say who
-- it is for, so the rules that matter are the ones protecting that meaning:
--
--   · a group belongs to one community and another community cannot see, edit
--     or assign into it (§19)
--   · membership is many-to-many; nothing makes it exclusive
--   · a group that has held members is archived, never deleted
--   · archiving keeps every membership it already had
--   · a member id from another community matches nothing (SEC-18)
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(22);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('61000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@grp.example.test'),
  ('61000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@grp.example.test'),
  ('61000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@grp.example.test');

insert into public.users (id, full_name, email) values
  ('61000000-0000-4000-8000-000000000001', 'Group Owner',  'owner@grp.example.test'),
  ('61000000-0000-4000-8000-000000000002', 'Group Viewer', 'viewer@grp.example.test'),
  ('61000000-0000-4000-8000-000000000003', 'Other Owner',  'other@grp.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('62000000-0000-4000-8000-00000000000a', 'group-tests-a', 'Group Tests A', 'university_association', false, '61000000-0000-4000-8000-000000000001'),
  ('62000000-0000-4000-8000-00000000000b', 'group-tests-b', 'Group Tests B', 'estate',                 false, '61000000-0000-4000-8000-000000000003');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('62000000-0000-4000-8000-00000000000a', '61000000-0000-4000-8000-000000000001', 'owner',  'Group Owner',  'created'),
  ('62000000-0000-4000-8000-00000000000a', '61000000-0000-4000-8000-000000000002', 'viewer', 'Group Viewer', 'invited'),
  ('62000000-0000-4000-8000-00000000000b', '61000000-0000-4000-8000-000000000003', 'owner',  'Other Owner',  'created');

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
  ('63000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-00000000000a', 'Ada Member',  '+2348070000001', 'GT/0001', 'active', 'manual'),
  ('63000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-00000000000a', 'Bem Member',  '+2348070000002', 'GT/0002', 'active', 'manual'),
  ('63000000-0000-4000-8000-00000000000b', '62000000-0000-4000-8000-00000000000b', 'Other Member','+2348070000003', 'OT/0001', 'active', 'manual');


-- ─────────────────────────────────────────────────────────────────────────────
-- Creating
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"61000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_youth as
  select app.create_member_group('62000000-0000-4000-8000-00000000000a', 'Youth', 'Under 30', true, 0::smallint) as id;
create temporary table tmp_choir as
  select app.create_member_group('62000000-0000-4000-8000-00000000000a', 'Choir', null, false, 1::smallint) as id;

select throws_ok(
  $$ select app.create_member_group('62000000-0000-4000-8000-00000000000a', 'youth') $$,
  'P0001', null,
  'a group name is unique within its community, ignoring case'
);

select throws_ok(
  $$ select app.create_member_group('62000000-0000-4000-8000-00000000000a', '   ') $$,
  'P0001', null,
  'a group needs a name'
);

reset role;
grant select on tmp_youth, tmp_choir to authenticated;

select ok(
  exists (
    select 1 from public.member_groups
    where id = (select id from tmp_youth)
      and community_id = '62000000-0000-4000-8000-00000000000a'
      and pickable_at_join
      and archived_at is null
  ),
  'a group is created active, in the community it was asked for'
);

select ok(
  exists (
    select 1 from public.audit_logs
    where object_type = 'member_group' and object_id = (select id from tmp_youth) and action = 'group.create'
  ),
  'creating a group is audited (AUD-01)'
);

-- SEC-16: the permission is group.manage, which a viewer does not hold.
set local role authenticated;
set local request.jwt.claims = '{"sub":"61000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select app.create_member_group('62000000-0000-4000-8000-00000000000a', 'Viewer Attempt') $$,
  '42501', null,
  'a viewer cannot create a group (group.manage)'
);
reset role;

-- §19: another community's officer is refused, whatever id they pass.
set local role authenticated;
set local request.jwt.claims = '{"sub":"61000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select app.create_member_group('62000000-0000-4000-8000-00000000000a', 'Cross Tenant Group') $$,
  '42501', null,
  'an officer of another community cannot create a group here'
);
select throws_ok(
  format($$ select app.update_member_group(%L, 'Renamed By Outsider') $$, (select id from tmp_youth)),
  '42501', null,
  'an officer of another community cannot rename this community''s group'
);
select throws_ok(
  format($$ select app.add_members_to_group(%L, array['63000000-0000-4000-8000-000000000001']::uuid[]) $$,
         (select id from tmp_youth)),
  '42501', null,
  'an officer of another community cannot assign into this community''s group'
);
select is(
  (select count(*)::integer from public.member_groups where community_id = '62000000-0000-4000-8000-00000000000a'),
  0,
  'an officer of another community reads none of this community''s groups (RLS)'
);
reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Membership — many-to-many, community-scoped
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"61000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  app.add_members_to_group(
    (select id from tmp_youth),
    array['63000000-0000-4000-8000-000000000001',
          '63000000-0000-4000-8000-000000000002',
          '63000000-0000-4000-8000-00000000000b']::uuid[]
  ),
  2,
  'assigning skips a member id from another community (SEC-18)'
);

select is(
  app.add_members_to_group((select id from tmp_youth), array['63000000-0000-4000-8000-000000000001']::uuid[]),
  0,
  'assigning someone already in the group adds nothing'
);

-- The rule an exclusive model would break: one person, two groups.
select is(
  app.add_members_to_group((select id from tmp_choir), array['63000000-0000-4000-8000-000000000001']::uuid[]),
  1,
  'a member can belong to a second group — groups are not exclusive'
);

reset role;

select is(
  (select count(*)::integer from public.member_group_memberships
   where member_id = '63000000-0000-4000-8000-000000000001'),
  2,
  'the member is in both groups at once'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"61000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format($$ select app.remove_member_from_group(%L, '63000000-0000-4000-8000-000000000002') $$,
         (select id from tmp_youth)),
  'a member can be removed from a group'
);

-- set_member_groups replaces the whole set, which is what a checkbox form means.
select is(
  app.set_member_groups(
    '63000000-0000-4000-8000-000000000002',
    (select array_agg(id) from (select id from tmp_choir) as g)
  ),
  1,
  'setting a member''s groups replaces the set with what was given'
);

reset role;

select ok(
  exists (
    select 1 from public.member_group_memberships
    where member_id = '63000000-0000-4000-8000-000000000002' and group_id = (select id from tmp_choir)
  ),
  'the member ended up in the group the form listed'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Archiving, and the one case where deleting is allowed
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"61000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  format($$ select app.delete_member_group(%L) $$, (select id from tmp_youth)),
  'P0001', null,
  'a group that holds members cannot be deleted'
);

select lives_ok(
  format($$ select app.set_member_group_archived(%L, true, 'Session ended') $$, (select id from tmp_youth)),
  'a group can be archived'
);

select throws_ok(
  format($$ select app.add_members_to_group(%L, array['63000000-0000-4000-8000-000000000002']::uuid[]) $$,
         (select id from tmp_youth)),
  'P0001', null,
  'an archived group takes no new members'
);

reset role;

select is(
  (select count(*)::integer from public.member_group_memberships where group_id = (select id from tmp_youth)),
  1,
  'archiving a group keeps every membership it already had — that is how a past audience is read'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"61000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format($$ select app.set_member_group_archived(%L, false) $$, (select id from tmp_youth)),
  'an archived group can be restored'
);

-- A group nobody was ever in is a typo, and a typo is removable.
create temporary table tmp_typo as
  select app.create_member_group('62000000-0000-4000-8000-00000000000a', 'Tpyo Group') as id;

select lives_ok(
  format($$ select app.delete_member_group(%L) $$, (select id from tmp_typo)),
  'a group nobody has ever been in can be deleted'
);

reset role;

select * from finish();
rollback;
