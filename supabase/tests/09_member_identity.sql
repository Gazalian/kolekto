-- ─────────────────────────────────────────────────────────────────────────────
-- 09 — Member identity
--
-- Coverage for 20260920120000 and 20260920120100: community member codes,
-- community-defined member fields as rows, uniqueness, the primary identifier,
-- duplicate detection, and restore.
--
-- The rules worth stating, because each one is a thing that has to be true for
-- "who is this person?" to have one answer:
--
--   · a member code is issued by the database, is unique per community, and is
--     never handed to two people
--   · a field marked unique cannot hold the same value twice, whatever route
--     the write takes
--   · exactly one field per community can be the primary identifier
--   · an exact duplicate is refused; a possible one is refused until the caller
--     confirms it deliberately
--   · archiving is reversible and destroys nothing
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(36);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('4d000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@mem.example.test'),
  ('4d000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@mem.example.test'),
  ('4d000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@mem.example.test');

insert into public.users (id, full_name, email) values
  ('4d000000-0000-4000-8000-000000000001', 'Member Owner',    'owner@mem.example.test'),
  ('4d000000-0000-4000-8000-000000000002', 'Member Viewer',   'viewer@mem.example.test'),
  ('4d000000-0000-4000-8000-000000000003', 'Member Outsider', 'outsider@mem.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('4c000000-0000-4000-8000-00000000000a', 'member-identity-a', 'Member Identity A', 'university_association', false, '4d000000-0000-4000-8000-000000000001'),
  ('4c000000-0000-4000-8000-00000000000b', 'member-identity-b', 'Member Identity B', 'estate',                 false, '4d000000-0000-4000-8000-000000000003');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('4c000000-0000-4000-8000-00000000000a', '4d000000-0000-4000-8000-000000000001', 'owner',  'Member Owner',    'created'),
  ('4c000000-0000-4000-8000-00000000000a', '4d000000-0000-4000-8000-000000000002', 'viewer', 'Member Viewer',   'invited'),
  ('4c000000-0000-4000-8000-00000000000b', '4d000000-0000-4000-8000-000000000003', 'owner',  'Member Outsider', 'created');


-- ─────────────────────────────────────────────────────────────────────────────
-- The community member profile
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_matric as
  select app.upsert_member_attribute_definition(
    '4c000000-0000-4000-8000-00000000000a', 'matric_number', 'Matric number', 'text',
    null::text[], true, true, true, 0::smallint
  ) as id;

create temporary table tmp_level as
  select app.upsert_member_attribute_definition(
    '4c000000-0000-4000-8000-00000000000a', 'level', 'Level', 'single_select',
    array['100','200','300'], false, false, false, 1::smallint
  ) as id;

reset role;
grant select on tmp_matric, tmp_level to authenticated;

select ok(
  exists (
    select 1 from public.member_attribute_definitions
    where id = (select id from tmp_matric) and is_unique and is_primary_identifier
  ),
  'a community can define its own identifying field, unique and primary'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  $$ select app.upsert_member_attribute_definition(
       '4c000000-0000-4000-8000-00000000000a', 'house_number', 'House number', 'text',
       null::text[], false, false, true, 2::smallint
     ) $$,
  'P0001', null,
  'a primary identifier that is not unique is refused — it would identify nothing'
);

select throws_ok(
  $$ select app.upsert_member_attribute_definition(
       '4c000000-0000-4000-8000-00000000000a', 'Bad Key', 'Bad key', 'text'
     ) $$,
  'P0001', null,
  'a field key that is not a safe identifier is refused'
);

select throws_ok(
  $$ select app.upsert_member_attribute_definition(
       '4c000000-0000-4000-8000-00000000000a', 'shirt_size', 'Shirt size', 'single_select'
     ) $$,
  'P0001', null,
  'a choice field with no options is refused'
);

select throws_ok(
  $$ select app.upsert_member_attribute_definition(
       '4c000000-0000-4000-8000-00000000000a', 'matric_number', 'Matric number again', 'text'
     ) $$,
  'P0001', null,
  'a second field with a key this community already uses is refused in words, not by an index violation'
);

-- §5: one primary identifier per community. Marking a second one moves it
-- rather than creating an ambiguity the partial unique index would reject.
create temporary table tmp_second_primary as
  select app.upsert_member_attribute_definition(
    '4c000000-0000-4000-8000-00000000000a', 'student_id', 'Student ID', 'text',
    null::text[], false, true, true, 3::smallint
  ) as id;

reset role;

select is(
  (select count(*)::integer from public.member_attribute_definitions
   where community_id = '4c000000-0000-4000-8000-00000000000a' and is_primary_identifier),
  1,
  'a community has exactly one primary identifier, even after a second field claims it'
);

select ok(
  not (select is_primary_identifier from public.member_attribute_definitions where id = (select id from tmp_matric)),
  'claiming the primary identifier moves it off the field that held it'
);

-- Put it back on the matric number, which is what the rest of this file uses.
set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok(
  format(
    $$ select app.upsert_member_attribute_definition(
         '4c000000-0000-4000-8000-00000000000a', 'matric_number', 'Matric number', 'text',
         null::text[], true, true, true, 0::smallint, %L
       ) $$,
    (select id from tmp_matric)
  ),
  'the primary identifier can be moved back'
);

select throws_ok(
  format(
    $$ select app.upsert_member_attribute_definition(
         '4c000000-0000-4000-8000-00000000000a', 'renamed_key', 'Matric number', 'text',
         null::text[], true, true, true, 0::smallint, %L
       ) $$,
    (select id from tmp_matric)
  ),
  'P0001', null,
  'a field key cannot be renamed — stored answers are filed under it'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select app.upsert_member_attribute_definition(
       '4c000000-0000-4000-8000-00000000000a', 'gender', 'Gender', 'text'
     ) $$,
  '42501', null,
  'a viewer cannot change the community member profile (community.edit_profile)'
);
reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Member codes
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  $$ select app.update_member_code_settings('4c000000-0000-4000-8000-00000000000a', 'KWASU/', 4::smallint) $$,
  'the community sets its own member code prefix'
);

create temporary table tmp_member_one as
  select app.create_member(
    '4c000000-0000-4000-8000-00000000000a', 'Chidi Eze', '+2348010000021', null,
    '{"matric_number": "20/53A/021", "level": "300"}'::jsonb
  ) as id;

create temporary table tmp_member_two as
  select app.create_member(
    '4c000000-0000-4000-8000-00000000000a', 'Fatima Sani', '+2348010000022', null,
    '{"matric_number": "20/53A/022"}'::jsonb
  ) as id;

reset role;
grant select on tmp_member_one, tmp_member_two to authenticated;

select is(
  (select member_code from public.members where id = (select id from tmp_member_one)),
  'KWASU/0001',
  'the first member of a community gets the configured prefix and the first number'
);

select is(
  (select member_code from public.members where id = (select id from tmp_member_two)),
  'KWASU/0002',
  'the next member gets the next number — the sequence is the database''s, not the caller''s'
);

select is(
  (select next_number from public.community_member_code_settings
   where community_id = '4c000000-0000-4000-8000-00000000000a'),
  3::bigint,
  'the sequence advances once per member issued'
);

-- §44: a sequence may move forward but never back, because a code already
-- given out must never be issued to a second person.
set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select app.update_member_code_settings('4c000000-0000-4000-8000-00000000000a', 'KWASU/', 4::smallint, 1::bigint) $$,
  'P0001', null,
  'the member code sequence cannot be wound back to reissue codes'
);
select lives_ok(
  $$ select app.update_member_code_settings('4c000000-0000-4000-8000-00000000000a', 'KWASU/', 4::smallint, 500::bigint) $$,
  'the member code sequence can be moved forward'
);
reset role;

-- Two communities keep their own sequences; a code is unique within one, not
-- across all of them.
set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000003","role":"authenticated"}';
create temporary table tmp_other_member as
  select app.create_member('4c000000-0000-4000-8000-00000000000b', 'Block B Resident', '+2348010000099') as id;
reset role;

select is(
  (select member_code from public.members where id = (select id from tmp_other_member)),
  '0001',
  'a community with no prefix gets plain numbers, counted separately from every other community'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Attribute values
-- ─────────────────────────────────────────────────────────────────────────────
select is(
  (select value_text from public.member_attribute_values
   where member_id = (select id from tmp_member_one) and definition_id = (select id from tmp_matric)),
  '20/53A/021',
  'a community field value is stored as a row against its definition'
);

select is(
  (select value_norm from public.member_attribute_values
   where member_id = (select id from tmp_member_one) and definition_id = (select id from tmp_matric)),
  '20/53a/021',
  'the comparison form is folded, so case and spacing cannot smuggle a duplicate past the index'
);

select ok(
  (select is_unique from public.member_attribute_values
   where member_id = (select id from tmp_member_one) and definition_id = (select id from tmp_matric)),
  'the value carries its definition''s uniqueness, which is what the partial unique index reads'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  $$ select app.create_member(
       '4c000000-0000-4000-8000-00000000000a', 'Impostor', '+2348010000033', null,
       '{"matric_number": "20/53a/021 "}'::jsonb, '{}', true
     ) $$,
  'P0001', null,
  'a unique field cannot hold the same value twice, whatever the case or spacing'
);

select throws_ok(
  $$ select app.create_member(
       '4c000000-0000-4000-8000-00000000000a', 'Wrong Field', '+2348010000034', null,
       '{"house_number": "B12"}'::jsonb
     ) $$,
  'P0001', null,
  'a value for a field this community has not defined is refused, not stored'
);

select throws_ok(
  $$ select app.create_member(
       '4c000000-0000-4000-8000-00000000000a', 'Bad Level', '+2348010000035', null,
       '{"level": "900"}'::jsonb
     ) $$,
  'P0001', null,
  'a choice field only accepts one of its own options'
);

select lives_ok(
  format(
    $$ select app.update_member(%L, 'Chidi Eze', '+2348010000021', null, '{"level": ""}'::jsonb) $$,
    (select id from tmp_member_one)
  ),
  'an empty value clears a field'
);

reset role;

select is(
  (select count(*)::integer from public.member_attribute_values
   where member_id = (select id from tmp_member_one) and definition_id = (select id from tmp_level)),
  0,
  'clearing a field removes its row rather than storing an empty string'
);

select is(
  (select value_text from public.member_attribute_values
   where member_id = (select id from tmp_member_one) and definition_id = (select id from tmp_matric)),
  '20/53A/021',
  'an update that does not mention a field leaves it alone'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Duplicates
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select match_strength from app.find_member_duplicates(
     '4c000000-0000-4000-8000-00000000000a', null, null, null, '{"matric_number": "20/53A/021"}'::jsonb
   ) limit 1),
  'exact',
  'a unique field already in use is an exact duplicate'
);

select is(
  (select match_strength from app.find_member_duplicates(
     '4c000000-0000-4000-8000-00000000000a', null, '+2348010000021'
   ) limit 1),
  'possible',
  'a shared phone number is a possible duplicate, not an exact one — households share numbers'
);

select throws_ok(
  $$ select app.create_member(
       '4c000000-0000-4000-8000-00000000000a', 'Someone Else', '+2348010000021'
     ) $$,
  'P0001', null,
  'a possible duplicate stops creation until the caller has seen it'
);

select lives_ok(
  $$ select app.create_member(
       '4c000000-0000-4000-8000-00000000000a', 'Someone Else', '+2348010000021', null,
       '{}'::jsonb, '{}', true
     ) $$,
  'a possible duplicate can be created deliberately, once confirmed'
);

-- The other community's member holds +2348010000099. Asking community A about
-- that number finds nothing: a roll is searched within its own community, never
-- across the platform.
select is(
  (select count(*)::integer from app.find_member_duplicates(
     '4c000000-0000-4000-8000-00000000000a', null, '+2348010000099'
   )),
  0,
  'duplicate detection never looks outside the community it was asked about'
);

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select app.find_member_duplicates('4c000000-0000-4000-8000-00000000000a', 'Chidi Eze') $$,
  '42501', null,
  'an officer of another community cannot probe this community''s roll for duplicates'
);
reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Archive and restore (§42)
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"4d000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format($$ select app.archive_member(%L, 'Graduated') $$, (select id from tmp_member_two)),
  'a member can be archived'
);

select is(
  (select app.restore_member((select id from tmp_member_two), 'Came back for a masters'))::text,
  'active',
  'restoring returns a member with a phone number to active'
);

select throws_ok(
  format($$ select app.restore_member(%L) $$, (select id from tmp_member_one)),
  'P0001', null,
  'a member who is not archived cannot be restored'
);

reset role;

select ok(
  exists (
    select 1 from public.member_attribute_values
    where member_id = (select id from tmp_member_two)
  ),
  'archiving and restoring never touched the member''s stored fields'
);

select * from finish();
rollback;
