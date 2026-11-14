-- ─────────────────────────────────────────────────────────────────────────────
-- 41 — Security regression: members_select_officer honours collector scope
--
-- Migration 20261019130000. The members RLS read policy must:
--   · let an UNSCOPED holder of member.view_contact (owner, viewer, admin,
--     treasurer) read the whole community roll (permitted path), and
--   · restrict a COLLECTOR to members who have an obligation in a collection
--     within the collector's scope (denied path for out-of-scope members),
--   · never leak across communities, and
--   · leave the self-read policy (members_select_self) working.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(10);


-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('e4000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@t41.example.test',     now()),
  ('e4000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@t41.example.test', now()),
  ('e4000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@t41.example.test',    now()),
  ('e4000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'self@t41.example.test',      now()),
  ('e4000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@t41.example.test',  now());
insert into public.users (id, full_name, email) values
  ('e4000000-0000-4000-8000-000000000001', 'T41 Owner',     'owner@t41.example.test'),
  ('e4000000-0000-4000-8000-000000000002', 'T41 Collector', 'collector@t41.example.test'),
  ('e4000000-0000-4000-8000-000000000003', 'T41 Viewer',    'viewer@t41.example.test'),
  ('e4000000-0000-4000-8000-000000000004', 'T41 Self',      'self@t41.example.test'),
  ('e4000000-0000-4000-8000-000000000005', 'T41 Outsider',  'outsider@t41.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('e5000000-0000-4000-8000-00000000000a', 't41-community-a', 'T41 Community A', 'social_group', false, 'e4000000-0000-4000-8000-000000000001'),
  ('e5000000-0000-4000-8000-00000000000b', 't41-community-b', 'T41 Community B', 'social_group', false, 'e4000000-0000-4000-8000-000000000001');

-- Owner and viewer are unscoped. The collector is scoped to collection C1 only.
insert into public.officer_terms (id, community_id, user_id, role, scope, actor_name_snapshot, start_reason) values
  ('e8000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-000000000001', 'owner',   null, 'T41 Owner', 'created'),
  ('e8000000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-000000000003', 'viewer',  null, 'T41 Viewer', 'created'),
  ('e8000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-000000000002', 'collector',
   '{"collection_ids": ["e6000000-0000-4000-8000-000000000001"]}'::jsonb, 'T41 Collector', 'created');

-- C1 is in the collector's scope; C2 is not.
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, created_by)
values
  ('e6000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000a', 'c1-in-scope',  'C1 In Scope',  'dues', 'managed', 'fixed', 2000000, 'active', 'e4000000-0000-4000-8000-000000000001'),
  ('e6000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-00000000000a', 'c2-out-scope', 'C2 Out Scope', 'dues', 'managed', 'fixed', 2000000, 'active', 'e4000000-0000-4000-8000-000000000001');

-- M1 has an obligation in C1 (in scope). M2 has an obligation in C2 (out of
-- scope). M3 has no obligation and is claimed by the self user. MB is in the
-- other community.
insert into public.members (id, community_id, full_name, phone_e164, member_code, status, user_id, claimed_at) values
  ('e7000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000a', 'M1 In Scope',  '+2348010000001', 'M-001', 'active', null, null),
  ('e7000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-00000000000a', 'M2 Out Scope', '+2348010000002', 'M-002', 'active', null, null),
  ('e7000000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-00000000000a', 'M3 Self',      '+2348010000003', 'M-003', 'active', 'e4000000-0000-4000-8000-000000000004', now()),
  ('e7000000-0000-4000-8000-00000000000b', 'e5000000-0000-4000-8000-00000000000b', 'MB Other Comm','+2348010000009', 'M-00B', 'active', null, null);

insert into public.obligations (id, community_id, collection_id, member_id, expected_amount_kobo) values
  ('e9000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 2000000),
  ('e9000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000002', 2000000);


-- Helpers: run a read under a given user with RLS in force, then restore role
-- so the pgTAP assertions run as the (superuser) test role.
create function pg_temp.visible_count(p_uid uuid, p_community uuid)
returns integer language plpgsql as $$
declare v integer;
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v from public.members where community_id = p_community;
  execute 'reset role';
  return v;
end $$;

create function pg_temp.can_see(p_uid uuid, p_member uuid)
returns boolean language plpgsql as $$
declare b boolean;
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select exists(select 1 from public.members where id = p_member) into b;
  execute 'reset role';
  return b;
end $$;


-- ── Unscoped holders see the whole roll (permitted) ─────────────────────────
select is(pg_temp.visible_count('e4000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000a'),
  3, 'owner (unscoped) sees all three members in the community');
select is(pg_temp.visible_count('e4000000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-00000000000a'),
  3, 'viewer (unscoped) sees all three members in the community');


-- ── Collector is restricted to in-scope members (denied) ────────────────────
select is(pg_temp.visible_count('e4000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-00000000000a'),
  1, 'collector sees only members in its collection scope');
select ok(pg_temp.can_see('e4000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000001'),
  'collector CAN see M1 (obligation in a scoped collection)');
select ok(not pg_temp.can_see('e4000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000002'),
  'collector CANNOT see M2 (obligation in an out-of-scope collection)');
select ok(not pg_temp.can_see('e4000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000003'),
  'collector CANNOT see M3 (no obligation at all)');


-- ── Cross-community isolation ───────────────────────────────────────────────
select is(pg_temp.visible_count('e4000000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-00000000000b'),
  0, 'collector cannot see members of another community');


-- ── Self-read policy still works, and does not leak the roll ────────────────
select ok(pg_temp.can_see('e4000000-0000-4000-8000-000000000004', 'e7000000-0000-4000-8000-000000000003'),
  'a member reads their own row via members_select_self');
select is(pg_temp.visible_count('e4000000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-00000000000a'),
  1, 'the self-reader sees only their own row, not the roll');


-- ── A non-officer sees nothing ──────────────────────────────────────────────
select is(pg_temp.visible_count('e4000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-00000000000a'),
  0, 'a non-officer sees no members');


select * from finish();
rollback;
