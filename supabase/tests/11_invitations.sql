-- ─────────────────────────────────────────────────────────────────────────────
-- 11 — Invitations and self-onboarding
--
-- Coverage for 20260920140000. This is the one anonymous write path in the
-- schema (MEM-05), so the tests are mostly about what a joiner CANNOT do:
--
--   · land in a group the link did not offer
--   · skip a field the link requires
--   · write a field the link never asked for
--   · obtain any role at all
--   · learn anything about the community beyond what the page needs
--
-- Plus the thing they should get: a community member code of their own (§16).
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(26);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('71000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@inv.example.test');

insert into public.users (id, full_name, email) values
  ('71000000-0000-4000-8000-000000000001', 'Invite Owner', 'owner@inv.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('72000000-0000-4000-8000-00000000000a', 'invite-tests', 'Invite Tests', 'university_association', false, '71000000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('72000000-0000-4000-8000-00000000000a', '71000000-0000-4000-8000-000000000001', 'owner', 'Invite Owner', 'created');

insert into public.community_member_code_settings (community_id, prefix, padding, next_number) values
  ('72000000-0000-4000-8000-00000000000a', 'INV/', 4, 1);

insert into public.member_attribute_definitions
  (id, community_id, key, label, type, options, required_at_join, is_unique, is_primary_identifier, sort_order) values
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-00000000000a', 'matric_number', 'Matric number', 'text', null, false, true, true, 0),
  ('73000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-00000000000a', 'level', 'Level', 'single_select', array['100','200','300'], false, false, false, 1),
  ('73000000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-00000000000a', 'gender', 'Gender', 'text', null, false, false, false, 2);

-- Two groups: one the link puts people in, one it does not mention at all.
insert into public.member_groups (id, community_id, name, pickable_at_join, sort_order) values
  ('74000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-00000000000a', '300 Level', false, 0),
  ('74000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-00000000000a', 'Executive', false, 1);


-- ─────────────────────────────────────────────────────────────────────────────
-- Creating the link
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_link as
  select * from app.create_invite_link(
    '72000000-0000-4000-8000-00000000000a',
    array['74000000-0000-4000-8000-000000000001']::uuid[],
    false, false, false, null, null, 'Join 300 Level',
    array['matric_number', 'level'], array['matric_number']
  );

select throws_ok(
  $$ select app.create_invite_link(
       '72000000-0000-4000-8000-00000000000a', '{}', false, false, false, null, null, null,
       array['no_such_field'], '{}'
     ) $$,
  'P0001', null,
  'a link cannot ask for a field this community has not defined'
);

select throws_ok(
  $$ select app.create_invite_link(
       '72000000-0000-4000-8000-00000000000a', '{}', false, false, false, null, null, null,
       array['level'], array['matric_number']
     ) $$,
  'P0001', null,
  'a field cannot be required unless the form asks for it'
);

reset role;
grant select on tmp_link to authenticated, anon;

select ok(
  exists (
    select 1 from public.invite_links
    where id = (select id from tmp_link)
      and group_ids = array['74000000-0000-4000-8000-000000000001']::uuid[]
      and asked_attribute_keys = array['matric_number', 'level']
      and required_attribute_keys = array['matric_number']
  ),
  'the link stores the groups and the field selection it was given'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- What the join page may see
-- ─────────────────────────────────────────────────────────────────────────────
set local role anon;

select is(
  (select community_name from app.get_public_invite((select token from tmp_link))),
  'Invite Tests',
  'the join page learns which community is asking'
);

select is(
  (select preset_group_names from app.get_public_invite((select token from tmp_link))),
  array['300 Level'],
  'the join page can say which group the person will land in'
);

select is(
  (select jsonb_array_length(fields) from app.get_public_invite((select token from tmp_link))),
  2,
  'the join page is told exactly which fields to ask — the two the link named, not all three'
);

select is(
  (select fields -> 0 ->> 'required' from app.get_public_invite((select token from tmp_link))),
  'true',
  'the required field is marked required'
);

select is(
  (select count(*)::integer from app.get_public_invite('not-a-real-token-at-all')),
  0,
  'an unknown token resolves to nothing'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Redeeming — what a joiner cannot do
-- ─────────────────────────────────────────────────────────────────────────────
set local role anon;

select throws_ok(
  format(
    $$ select * from app.redeem_invite_link(%L, 'No Matric', '+2348060000001', null, '{}', '{"level": "300"}'::jsonb) $$,
    (select token from tmp_link)
  ),
  'P0001', null,
  'a joiner cannot skip a field the link requires'
);

create temporary table tmp_joined as
  select * from app.redeem_invite_link(
    (select token from tmp_link),
    'Ada Joiner', '+2348060000002', null,
    -- A group the link never offered, supplied by the browser.
    array['74000000-0000-4000-8000-000000000002']::uuid[],
    -- An answer to a field the link never asked for, alongside the real ones.
    '{"matric_number": "20/53A/900", "level": "300", "gender": "Female"}'::jsonb
  );

reset role;
grant select on tmp_joined to authenticated, anon;

select is(
  (select member_code from tmp_joined),
  'INV/0001',
  'a joiner receives this community''s member code (§16)'
);

select is(
  (select status::text from tmp_joined),
  'unclaimed',
  'joining never marks a member active — that means a verified phone (CON-22)'
);

select ok(
  exists (
    select 1 from public.member_group_memberships
    where member_id = (select member_id from tmp_joined)
      and group_id = '74000000-0000-4000-8000-000000000001'
  ),
  'the joiner lands in the group the link presets'
);

select ok(
  not exists (
    select 1 from public.member_group_memberships
    where member_id = (select member_id from tmp_joined)
      and group_id = '74000000-0000-4000-8000-000000000002'
  ),
  'a group the browser supplied but the link never offered is ignored (SEC-18)'
);

select is(
  (select value_text from public.member_attribute_values
   where member_id = (select member_id from tmp_joined)
     and definition_id = '73000000-0000-4000-8000-000000000001'),
  '20/53A/900',
  'answers to the fields the link asked for are stored against their definitions'
);

select is(
  (select count(*)::integer from public.member_attribute_values
   where member_id = (select member_id from tmp_joined)
     and definition_id = '73000000-0000-4000-8000-000000000003'),
  0,
  'an answer to a field the link never asked for is dropped, not stored'
);

-- The rule that makes this safe to expose anonymously at all.
select is(
  (select count(*)::integer from public.officer_terms
   where community_id = '72000000-0000-4000-8000-00000000000a'
     and user_id is not null
     and started_at > now() - interval '1 minute'
     and role <> 'owner'),
  0,
  'joining grants no role — a member invite creates a member, never an officer'
);

select is(
  (select uses from public.invite_links where id = (select id from tmp_link)),
  1,
  'redeeming counts against the link''s usage'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- A unique field still means unique, even from the anonymous path
-- ─────────────────────────────────────────────────────────────────────────────
set local role anon;

select throws_ok(
  format(
    $$ select * from app.redeem_invite_link(%L, 'Copycat', '+2348060000003', null, '{}',
         '{"matric_number": "20/53a/900"}'::jsonb) $$,
    (select token from tmp_link)
  ),
  'P0001', null,
  'a joiner cannot claim a matric number another member already holds'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Revoked and expired links
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}';
select app.revoke_invite_link((select id from tmp_link));
reset role;

set local role anon;

select is(
  (select count(*)::integer from app.get_public_invite((select token from tmp_link))),
  0,
  'a revoked link shows nothing on the join page'
);

select throws_ok(
  format(
    $$ select * from app.redeem_invite_link(%L, 'Too Late', '+2348060000004', null, '{}',
         '{"matric_number": "20/53A/901"}'::jsonb) $$,
    (select token from tmp_link)
  ),
  'P0001', null,
  'a revoked link cannot be redeemed'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921100000 — a joiner choosing their own group
--
-- Coverage for `pickable_groups` and the `allow_group_choice`/`allow_multi_group`
-- branch of `app.redeem_invite_link`, which existed since 20260920140000 but had
-- no test exercising it — the assertions above only ever used links with
-- `allow_group_choice = false`.
-- ─────────────────────────────────────────────────────────────────────────────

-- A second community, so "a group from another community" has somewhere to be from.
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('72000000-0000-4000-8000-00000000000b', 'invite-tests-other', 'Invite Tests Other', 'university_association', false, '71000000-0000-4000-8000-000000000001');
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('72000000-0000-4000-8000-00000000000b', '71000000-0000-4000-8000-000000000001', 'owner', 'Invite Owner', 'created');
insert into public.community_member_code_settings (community_id, prefix, padding, next_number) values
  ('72000000-0000-4000-8000-00000000000b', 'OTH/', 4, 1);

insert into public.member_groups (id, community_id, name, pickable_at_join, sort_order, archived_at) values
  -- Two pickable groups in the invitation's own community: what a chooser should see.
  ('74000000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-00000000000a', '100 Level', true, 2, null),
  ('74000000-0000-4000-8000-000000000004', '72000000-0000-4000-8000-00000000000a', '200 Level', true, 3, null),
  -- Pickable, but archived — must not be offered or accepted.
  ('74000000-0000-4000-8000-000000000005', '72000000-0000-4000-8000-00000000000a', 'Old Level', true, 4, now()),
  -- Pickable, but in a different community entirely.
  ('74000000-0000-4000-8000-000000000006', '72000000-0000-4000-8000-00000000000b', 'Other Group', true, 0, null);

set local role authenticated;
set local request.jwt.claims = '{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- A link that never offers a choice at all — freshly created here rather than
-- reusing `tmp_link`, which by this point in the file has already been revoked.
create temporary table tmp_no_choice_link as
  select * from app.create_invite_link(
    '72000000-0000-4000-8000-00000000000a', '{}', false, false, false, null, null, 'No choice'
  );

-- Single-choice link: allow_group_choice on, allow_multi_group off.
create temporary table tmp_choice_link as
  select * from app.create_invite_link(
    '72000000-0000-4000-8000-00000000000a', '{}', true, false, false, null, null, 'Choose your level'
  );

-- Multi-choice link: both on.
create temporary table tmp_multi_link as
  select * from app.create_invite_link(
    '72000000-0000-4000-8000-00000000000a', '{}', true, true, false, null, null, 'Choose your levels'
  );

reset role;
grant select on tmp_no_choice_link, tmp_choice_link, tmp_multi_link to authenticated, anon;

set local role anon;

select is(
  (select pickable_groups from app.get_public_invite((select token from tmp_no_choice_link))),
  '[]'::jsonb,
  'a link with allow_group_choice off offers no pickable groups on the join page'
);

select is(
  (select jsonb_agg(g ->> 'name' order by g ->> 'name')
   from app.get_public_invite((select token from tmp_choice_link)), jsonb_array_elements(pickable_groups) g),
  '["100 Level", "200 Level"]'::jsonb,
  'a choice link offers exactly the pickable, unarchived groups of its own community — not the archived one, not the other community''s'
);

create temporary table tmp_chooser as
  select * from app.redeem_invite_link(
    (select token from tmp_choice_link), 'Chidi Chooser', '+2348060000010', null,
    array['74000000-0000-4000-8000-000000000003']::uuid[]
  );

reset role;
grant select on tmp_chooser to authenticated, anon;

select ok(
  exists (
    select 1 from public.member_group_memberships
    where member_id = (select member_id from tmp_chooser)
      and group_id = '74000000-0000-4000-8000-000000000003'
  ),
  'a joiner who chooses a group the link offers lands in it'
);

set local role anon;

create temporary table tmp_chooser_bad as
  select * from app.redeem_invite_link(
    (select token from tmp_choice_link), 'Bad Chooser', '+2348060000011', null,
    -- Archived pickable group and another community's pickable group, both invalid.
    array['74000000-0000-4000-8000-000000000005', '74000000-0000-4000-8000-000000000006']::uuid[]
  );

reset role;
grant select on tmp_chooser_bad to authenticated, anon;

select is(
  (select count(*)::integer from public.member_group_memberships
   where member_id = (select member_id from tmp_chooser_bad)),
  0,
  'an archived group and a group from another community are both silently ignored, not honoured (SEC-18)'
);

set local role anon;

create temporary table tmp_chooser_single as
  select * from app.redeem_invite_link(
    (select token from tmp_choice_link), 'Single Chooser', '+2348060000012', null,
    array['74000000-0000-4000-8000-000000000003', '74000000-0000-4000-8000-000000000004']::uuid[]
  );

reset role;
grant select on tmp_chooser_single to authenticated, anon;

select is(
  (select count(*)::integer from public.member_group_memberships
   where member_id = (select member_id from tmp_chooser_single)),
  1,
  'a single-choice link (allow_multi_group off) honours only the first group offered, even if the browser sends two'
);

set local role anon;

create temporary table tmp_chooser_multi as
  select * from app.redeem_invite_link(
    (select token from tmp_multi_link), 'Multi Chooser', '+2348060000013', null,
    array['74000000-0000-4000-8000-000000000003', '74000000-0000-4000-8000-000000000004']::uuid[]
  );

reset role;
grant select on tmp_chooser_multi to authenticated, anon;

select is(
  (select count(*)::integer from public.member_group_memberships
   where member_id = (select member_id from tmp_chooser_multi)),
  2,
  'a multi-choice link (allow_multi_group on) honours every valid group offered'
);

select * from finish();
rollback;
