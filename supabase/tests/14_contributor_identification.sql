-- ─────────────────────────────────────────────────────────────────────────────
-- 14 — Contributor self-identification
--
-- Coverage for 20260920170000. This is the first surface that lets an
-- unauthenticated stranger search a community's roll, so the tests are written
-- as the attacks they are meant to refuse:
--
--   · can `anon` list the members of a community?            (no)
--   · can `anon` reach a member of another community?        (no)
--   · can `anon` reach a member outside the audience?        (no)
--   · can `anon` reach an archived member?                   (no)
--   · does an ambiguous name hand back names or ids?         (no)
--   · does any of this write, or mark anything paid?         (no)
--
-- Everything runs as `anon` with no JWT, which is exactly what the public page
-- has.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(35);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@find.example.test');

insert into public.users (id, full_name, email) values
  ('a1000000-0000-4000-8000-000000000001', 'Find Owner', 'owner@find.example.test')
on conflict (id) do update set full_name = excluded.full_name;

-- Two communities, so every lookup can be asked to cross a boundary and refuse.
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a2000000-0000-4000-8000-00000000000a', 'find-tests', 'Find Tests', 'university_association', false, 'a1000000-0000-4000-8000-000000000001'),
  ('a2000000-0000-4000-8000-00000000000b', 'other-community', 'Other Community', 'estate', false, 'a1000000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 'owner', 'Find Owner', 'created'),
  ('a2000000-0000-4000-8000-00000000000b', 'a1000000-0000-4000-8000-000000000001', 'owner', 'Find Owner', 'created');

-- The community identifies people by matric number.
insert into public.member_attribute_definitions (id, community_id, key, label, type, is_unique, is_primary_identifier, sort_order) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', 'matric_number', 'Matric number', 'text', true, true, 0);

insert into public.members (id, community_id, full_name, phone_e164, email, member_code, status, joined_via, archived_at) values
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', 'Ghazali Habeebulahi', '+2348011112222', 'ghazali@example.test', 'KWASU/0001', 'active', 'manual', null),
  -- Two people who share a first name, for the ambiguity tests.
  ('a4000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-00000000000a', 'Grace Adeyemi',       '+2348011113333', null, 'KWASU/0002', 'active', 'manual', null),
  ('a4000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-00000000000a', 'Grace Adeyemi',       '+2348011114444', null, 'KWASU/0003', 'active', 'manual', null),
  -- Archived: history kept, but not expected to pay anything new.
  ('a4000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-00000000000a', 'Tunde Bakare',        '+2348011115555', null, 'KWASU/0004', 'archived', 'manual', now()),
  -- In the community, but not in the group a group-scoped collection is for.
  ('a4000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-00000000000a', 'Ngozi Okafor',        '+2348011116666', null, 'KWASU/0005', 'active', 'manual', null),
  -- Another community entirely.
  ('a4000000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-00000000000b', 'Bola Ahmed',          '+2348011117777', null, 'OTH/0001',   'active', 'manual', null);

insert into public.member_attribute_values (member_id, definition_id, community_id, value_text, value_norm) values
  ('a4000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', '20/53A/0123', '20/53a/0123'),
  ('a4000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', '20/53A/0456', '20/53a/0456'),
  ('a4000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', '20/53A/0789', '20/53a/0789');

-- A group, and a collection aimed at it.
insert into public.member_groups (id, community_id, name, created_by) values
  ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', '300 Level', 'a1000000-0000-4000-8000-000000000001');

insert into public.member_group_memberships (group_id, member_id, added_by) values
  ('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001'),
  ('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001'),
  ('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001');

-- Collections: one for the whole roll, one for the group, one selected-members,
-- one open to anyone, one still a draft, and one in the other community.
insert into public.collections (
  id, community_id, slug, name, category, participation_mode, amount_model,
  fixed_amount_kobo, status, visibility, created_by, published_at, published_by
) values
  ('a6000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', 'class-dues', 'Class Dues',
   'dues', 'managed', 'fixed', 500000, 'active', 'unlisted', 'a1000000-0000-4000-8000-000000000001', now(), 'a1000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-00000000000a', 'level-dues', 'Level Dues',
   'dues', 'managed', 'fixed', 300000, 'active', 'unlisted', 'a1000000-0000-4000-8000-000000000001', now(), 'a1000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-00000000000a', 'picked-few', 'Picked Few',
   'contribution', 'managed', 'per_member', null, 'active', 'unlisted', 'a1000000-0000-4000-8000-000000000001', now(), 'a1000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-00000000000a', 'harvest', 'Harvest',
   'fundraiser', 'open', 'open_amount', null, 'active', 'public', 'a1000000-0000-4000-8000-000000000001', now(), 'a1000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-00000000000a', 'not-yet', 'Not Yet',
   'dues', 'managed', 'fixed', 100000, 'draft', 'unlisted', 'a1000000-0000-4000-8000-000000000001', null, null),
  ('a6000000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-00000000000b', 'estate-charge', 'Estate Charge',
   'dues', 'managed', 'fixed', 900000, 'active', 'unlisted', 'a1000000-0000-4000-8000-000000000001', now(), 'a1000000-0000-4000-8000-000000000001');

update public.collections set audience_mode = 'groups'           where id = 'a6000000-0000-4000-8000-000000000002';
update public.collections set audience_mode = 'selected_members' where id = 'a6000000-0000-4000-8000-000000000003';

insert into public.collection_audience_groups (collection_id, group_id, community_id, added_by) values
  ('a6000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001');

-- The selected-members collection's audience IS its obligations.
insert into public.obligations (id, community_id, collection_id, member_id, expected_amount_kobo, assigned_by) values
  ('a7000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-000000000003',
   'a4000000-0000-4000-8000-000000000001', 750000, 'a1000000-0000-4000-8000-000000000001'),
  -- And the whole-roll collection has one for Ghazali.
  ('a7000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-000000000001',
   'a4000000-0000-4000-8000-000000000001', 500000, 'a1000000-0000-4000-8000-000000000001');


-- ─────────────────────────────────────────────────────────────────────────────
-- Everything below runs as an unauthenticated stranger.
-- ─────────────────────────────────────────────────────────────────────────────
set local role anon;

-- ── Finding yourself ─────────────────────────────────────────────────────────
select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'KWASU/0001')),
  'one',
  'a member code finds exactly one person'
);

select is(
  (select full_name from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'kwasu/0001')),
  'Ghazali Habeebulahi',
  'the code is matched case-insensitively — a phone keyboard capitalises what it likes'
);

select is(
  (select identifier_value from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'KWASU/0001')),
  '20/53A/0123',
  'the community''s primary identifier comes back, as the person wrote it'
);

select is(
  (select identifier_label from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'KWASU/0001')),
  'Matric number',
  'and it is labelled the way the community labels it'
);

select is(
  (select member_id from app.find_collection_member('a6000000-0000-4000-8000-000000000001', '20/53a/0123')),
  'a4000000-0000-4000-8000-000000000001'::uuid,
  'the primary identifier finds the same person'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', '08011112222')),
  'one',
  'a phone number typed the way Nigerians type it finds the member stored in E.164'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'ghazali@example.test')),
  'one',
  'an email address finds its member'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'ghazali habeeb')),
  'one',
  'two parts of a name are enough when only one person answers to them'
);

-- ── What a search must NOT do ────────────────────────────────────────────────
select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'ghazali')),
  'none',
  'one name part finds nobody — a single common name would otherwise walk the roll'
);

select throws_ok(
  $$ select app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'gh') $$,
  'P0001', null,
  'a two-character query is refused rather than answered'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'KWASU/')),
  'none',
  'a partial member code matches nothing — there is no prefix search to enumerate with'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', '20/53a/')),
  'none',
  'and no partial match on the primary identifier either'
);

-- ── Ambiguity ────────────────────────────────────────────────────────────────
select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'grace adeyemi')),
  'many',
  'two people with one name are reported as several, not as a list'
);

select is(
  (select match_count from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'grace adeyemi')),
  2,
  'the contributor is told how many, so they know to be more specific'
);

select ok(
  (select member_id is null and full_name is null and member_code is null and identifier_value is null
   from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'grace adeyemi')),
  'an ambiguous search returns no ids, no names and no identifiers — nothing about anybody'
);

select is(
  (select identifier_label from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'grace adeyemi')),
  'Matric number',
  'only the NAME OF THE FIELD to type next, which is not information about a person'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', '20/53a/0456')),
  'one',
  'and that field does tell them apart'
);

-- ── Audience scoping ─────────────────────────────────────────────────────────
select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000002', 'KWASU/0005')),
  'none',
  'a member outside the collection''s groups cannot identify against it'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'KWASU/0005')),
  'one',
  'the same member identifies fine against the collection that is for everyone'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000003', 'KWASU/0002')),
  'none',
  'a member who was not selected cannot identify against a selected-members collection'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000003', 'KWASU/0001')),
  'one',
  'the member who WAS selected can'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'KWASU/0004')),
  'none',
  'an archived member cannot identify — they are not expected to pay anything new'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000001', 'OTH/0001')),
  'none',
  'a member of another community does not exist as far as this collection is concerned'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000004', 'KWASU/0001')),
  'none',
  'an open collection has no roll to search, and says so the same way an empty search does'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000005', 'KWASU/0001')),
  'none',
  'a draft collection cannot be probed for its members'
);

select is(
  (select match_status from app.find_collection_member('a6000000-0000-4000-8000-000000000006', 'KWASU/0001')),
  'none',
  'and a collection in another community cannot be used to reach this one''s roll'
);


-- ── The context an identified contributor gets ───────────────────────────────
select is(
  (select expected_amount_kobo from app.get_collection_member_context(
     'a6000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001')),
  500000::bigint,
  'an identified member is shown what they are expected to contribute'
);

select is(
  (select obligation_status::text from app.get_collection_member_context(
     'a6000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001')),
  'unpaid',
  'and its status, which no public call can ever change'
);

select is_empty(
  $$ select * from app.get_collection_member_context(
       'a6000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-000000000005') $$,
  'a member outside the audience gets nothing back, even with a correct member id'
);

select is_empty(
  $$ select * from app.get_collection_member_context(
       'a6000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000006') $$,
  'and a member id from another community resolves to nothing at all (SEC-18)'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- A recurring collection asks about ONE period
--
-- October's service charge and November's are different debts. The context a
-- contributor is shown has to name which one, or they cannot know what they are
-- settling.
-- ─────────────────────────────────────────────────────────────────────────────
reset role;

insert into public.collections (
  id, community_id, slug, name, category, participation_mode, amount_model,
  fixed_amount_kobo, schedule, status, visibility, created_by, published_at, published_by
) values (
  'a6000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-00000000000a', 'service-charge', 'Service Charge',
  'dues', 'managed', 'fixed', 2000000, 'recurring', 'active', 'unlisted',
  'a1000000-0000-4000-8000-000000000001', now(), 'a1000000-0000-4000-8000-000000000001'
);

insert into public.collection_recurrences (collection_id, community_id, frequency, starts_on) values
  ('a6000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-00000000000a', 'monthly', '2026-10-01');

-- Two periods: October closed, November open.
insert into public.collection_cycles (id, collection_id, community_id, cycle_key, period_start, period_end, closed_at) values
  ('a8000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-00000000000a',
   '2026-10', '2026-10-01', '2026-10-31', now()),
  ('a8000000-0000-4000-8000-000000000002', 'a6000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-00000000000a',
   '2026-11', '2026-11-01', '2026-11-30', null);

insert into public.obligations (id, community_id, collection_id, member_id, cycle_key, expected_amount_kobo, assigned_by) values
  ('a7000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-000000000007',
   'a4000000-0000-4000-8000-000000000001', '2026-10', 2000000, 'a1000000-0000-4000-8000-000000000001'),
  ('a7000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-000000000007',
   'a4000000-0000-4000-8000-000000000001', '2026-11', 2500000, 'a1000000-0000-4000-8000-000000000001');

set local role anon;

select is(
  (select cycle_key from app.get_collection_member_context(
     'a6000000-0000-4000-8000-000000000007', 'a4000000-0000-4000-8000-000000000001')),
  '2026-11',
  'the open period is the one a contributor is asked about, not the closed one'
);

select is(
  (select expected_amount_kobo from app.get_collection_member_context(
     'a6000000-0000-4000-8000-000000000007', 'a4000000-0000-4000-8000-000000000001')),
  2500000::bigint,
  'and the amount is that period''s own obligation, not the other one'
);

select is(
  (select cycle_label from app.get_collection_member_context(
     'a6000000-0000-4000-8000-000000000007', 'a4000000-0000-4000-8000-000000000001')),
  '01 Nov 2026 – 30 Nov 2026',
  'the period is labelled the way a person would read it'
);

-- The obligations table itself is not readable by a stranger. Everything a
-- contributor is shown about what they owe comes through the one function that
-- decides what is safe to say.
select throws_ok(
  $$ select count(*) from public.obligations $$,
  '42501', null,
  'anon cannot read the obligations table, only its own row through the context function'
);

reset role;

-- Nothing on this surface can settle anything: there is no path from a public
-- call to a paid obligation, which is the rule CASH-01 has held since Phase 1.
select is(
  (select count(*)::integer from public.obligations where status = 'paid'),
  0,
  'no obligation anywhere is paid — only a verified payment could do that, and there are none'
);

select * from finish();
rollback;
