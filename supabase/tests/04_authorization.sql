-- ─────────────────────────────────────────────────────────────────────────────
-- 04 — Authorization behaviour
--
-- SEC-16: "for each role, a test suite asserts allowed and denied reads/writes
-- for every table." This is the behavioural half — it builds two communities
-- with real officers and checks that `has_permission` answers correctly, that a
-- member of one community cannot read the other, and that an ended term stops
-- granting anything.
--
-- The previous system had no RLS tests at all.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(12);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- auth.users rows first, because public.users references them.
insert into auth.users (id, instance_id, aud, role, email)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer@example.test'),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@example.test'),
  ('44444444-4444-4444-8444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@example.test');

-- ON CONFLICT DO UPDATE, not DO NOTHING: the auth.users insert above already
-- fired app.handle_new_auth_user() (20260918140000), which created a
-- placeholder public.users row per id. This overwrites it with the names the
-- rest of this file expects.
insert into public.users (id, full_name, email) values
  ('11111111-1111-4111-8111-111111111111', 'Owner Person',     'owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'Treasurer Person', 'treasurer@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'Viewer Person',    'viewer@example.test'),
  ('44444444-4444-4444-8444-444444444444', 'Outsider Person',  'outsider@example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'test-assoc',  'Test Association', 'university_association', false, '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'other-assoc', 'Other Association', 'university_association', false, '44444444-4444-4444-8444-444444444444');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner',     'Owner Person',     'created'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'treasurer', 'Treasurer Person', 'invited'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '33333333-3333-4333-8333-333333333333', 'viewer',    'Viewer Person',    'invited'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '44444444-4444-4444-8444-444444444444', 'owner',     'Outsider Person',  'created');


-- ── The role matrix, as data ─────────────────────────────────────────────────

select ok(
  (select count(*) from public.role_permissions where role = 'owner')
  = (select count(*) from public.permissions),
  'an owner holds every permission in the catalogue'
);

select ok(
  not exists (
    select 1 from public.role_permissions
    where role = 'viewer'
      and permission in ('withdrawal.request', 'withdrawal_account.change',
                         'refund.initiate', 'officer.invite', 'member.export')
  ),
  'a viewer holds no money, role or export permission (PRD 2.2)'
);

select ok(
  not exists (
    select 1 from public.role_permissions
    where role = 'admin'
      and permission in ('withdrawal.request', 'withdrawal_account.change',
                         'withdrawal.approve', 'refund.initiate')
  ),
  'an admin cannot move money (PRD 2.2)'
);

select ok(
  not exists (
    select 1 from public.role_permissions
    where role = 'treasurer' and permission like 'officer.%'
  ),
  'a treasurer cannot change roles (PRD 2.2)'
);

select ok(
  (select bool_and(scoped) from public.role_permissions where role = 'collector'),
  'every collector permission is scoped (ROLE-06, SEC-10)'
);

select ok(
  not exists (
    select 1 from public.role_permissions
    where role = 'collector'
      and permission in ('withdrawal.request', 'refund.initiate', 'obligation.exempt',
                         'balance.view', 'audit.view')
  ),
  'a collector has no money movement and no oversight permissions'
);

select ok(
  (select requires_second_approver from public.role_permissions
   where role = 'treasurer' and permission = 'withdrawal_account.change'),
  'changing the withdrawal account needs a second approver (PRD 17.5)'
);


-- ── has_permission, as a caller ──────────────────────────────────────────────
-- `set local role` plus a JWT claim is how Supabase evaluates `auth.uid()`.

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

select ok(
  app.has_permission('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'withdrawal.request'),
  'the treasurer may request a withdrawal in their own community'
);

select ok(
  not app.has_permission('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'officer.invite'),
  'the treasurer may NOT invite officers'
);

select ok(
  not app.has_permission('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'community.view_dashboard'),
  'the treasurer holds nothing in a community they are not an officer of (tenancy isolation)'
);

reset role;


-- ── An ended term grants nothing ─────────────────────────────────────────────
-- HND-02: at the effective moment of a handover, outgoing officers lose their
-- rights immediately. This is that rule, at the database level.

update public.officer_terms
set ended_at = now(), end_reason = 'handover'
where community_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  and user_id = '22222222-2222-4222-8222-222222222222';

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

select ok(
  not app.has_permission('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'withdrawal.request'),
  'an ended officer term grants nothing, immediately (HND-02, OFF-03)'
);

reset role;

-- The term row itself survives, because leadership history is the product.
select ok(
  exists (
    select 1 from public.officer_terms
    where user_id = '22222222-2222-4222-8222-222222222222'
      and ended_at is not null
  ),
  'ending a term keeps the record — nothing is deleted (OFF-03, HND-04)'
);

select * from finish();
rollback;
