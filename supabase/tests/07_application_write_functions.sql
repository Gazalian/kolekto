-- ─────────────────────────────────────────────────────────────────────────────
-- 07 — Phase 2 application write functions
--
-- Behavioural coverage for 20260918140000 and 20260918140100: the sign-up
-- bootstrap trigger, and every SECURITY DEFINER function a Phase 2 feature
-- (communities, members, invitations) writes through. Each write path is
-- exercised both as a caller who holds the permission it checks and as one
-- who does not (SEC-16's "allowed and denied" requirement, extended from
-- reads in 04_authorization.sql to the write functions this phase adds).
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(24);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('99999999-9999-4999-8999-999999999991', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@app.example.test'),
  ('99999999-9999-4999-8999-999999999992', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@app.example.test'),
  ('99999999-9999-4999-8999-999999999993', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@app.example.test'),
  ('99999999-9999-4999-8999-999999999994', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'invitee@app.example.test');

-- ON CONFLICT DO UPDATE: the auth.users insert above already fired
-- app.handle_new_auth_user() (20260918140000), which created a placeholder
-- public.users row per id (and, incidentally, a personal community and owner
-- term for each — harmless extra rows this file's assertions never count).
insert into public.users (id, full_name, email) values
  ('99999999-9999-4999-8999-999999999991', 'App Owner',    'owner@app.example.test'),
  ('99999999-9999-4999-8999-999999999992', 'App Admin',    'admin@app.example.test'),
  ('99999999-9999-4999-8999-999999999993', 'App Outsider', 'outsider@app.example.test'),
  ('99999999-9999-4999-8999-999999999994', 'App Invitee',  'invitee@app.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('88888888-8888-4888-8888-888888888881', 'app-write-tests', 'App Write Tests', 'fellowship', false, '99999999-9999-4999-8999-999999999991');

insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('77777777-7777-4777-8777-777777777771', '88888888-8888-4888-8888-888888888881', '99999999-9999-4999-8999-999999999991', 'owner', 'App Owner', 'created'),
  ('77777777-7777-4777-8777-777777777772', '88888888-8888-4888-8888-888888888881', '99999999-9999-4999-8999-999999999992', 'admin', 'App Admin', 'created');


-- ── Sign-up bootstrap (COM-01, 20260918140000) ───────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
values ('99999999-9999-4999-8999-999999999999', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'newcomer@app.example.test', '{"full_name":"New Comer"}');

select ok(
  exists (select 1 from public.users where id = '99999999-9999-4999-8999-999999999999' and full_name = 'New Comer'),
  'a public.users row is created automatically on auth.users insert'
);
select ok(
  (select count(*) from public.communities where created_by = '99999999-9999-4999-8999-999999999999' and is_personal) = 1,
  'exactly one personal community is created for the new user (COM-01)'
);
select ok(
  exists (
    select 1 from public.officer_terms ot
    join public.communities c on c.id = ot.community_id
    where ot.user_id = '99999999-9999-4999-8999-999999999999' and ot.role = 'owner' and ot.ended_at is null
      and c.is_personal
  ),
  'the new user holds an active owner term on their personal community'
);


-- ── create_community ─────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999991","role":"authenticated"}';

create temporary table tmp_new_community as
  select app.create_community('Test Fellowship Named', 'fellowship') as id;

reset role;

select ok(
  exists (select 1 from public.communities where id = (select id from tmp_new_community) and name = 'Test Fellowship Named'),
  'create_community creates a named community'
);
select ok(
  exists (
    select 1 from public.officer_terms
    where community_id = (select id from tmp_new_community)
      and user_id = '99999999-9999-4999-8999-999999999991' and role = 'owner' and ended_at is null
  ),
  'the caller becomes owner of the community they created'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999991","role":"authenticated"}';
select throws_ok(
  $$ select app.create_community('Should Not Work', 'personal') $$,
  'P0001', null,
  'create_community refuses type ''personal'' — personal communities are sign-up only'
);
reset role;


-- ── create_member / update_member / archive_member (member.create/edit/archive) ─
set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999991","role":"authenticated"}';
create temporary table tmp_new_member as
  select app.create_member('88888888-8888-4888-8888-888888888881', 'Test Member', '+2348012345678') as id;
reset role;

select ok(
  exists (select 1 from public.members where id = (select id from tmp_new_member) and full_name = 'Test Member'),
  'the owner can create a member (member.create)'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999993","role":"authenticated"}';
select throws_ok(
  $$ select app.create_member('88888888-8888-4888-8888-888888888881', 'Should Not Exist', null) $$,
  '42501', null,
  'an outsider with no role in the community cannot create a member'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999992","role":"authenticated"}';
select lives_ok(
  $$ select app.update_member(
       (select id from tmp_new_member), 'Test Member Updated', '+2348012345678', null, '{}'::jsonb
     ) $$,
  'an admin (member.edit) can update a member'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999993","role":"authenticated"}';
select throws_ok(
  $$ select app.archive_member((select id from tmp_new_member), null) $$,
  '42501', null,
  'an outsider cannot archive a member'
);
reset role;


-- ── Member invite links (MEM-05) ─────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999991","role":"authenticated"}';
create temporary table tmp_open_invite as
  select * from app.create_invite_link('88888888-8888-4888-8888-888888888881');
create temporary table tmp_approval_invite as
  select * from app.create_invite_link('88888888-8888-4888-8888-888888888881', '{}', false, false, true);
create temporary table tmp_expired_invite as
  select * from app.create_invite_link('88888888-8888-4888-8888-888888888881', '{}', false, false, false, now() - interval '1 day');
-- These temp tables are owned by `authenticated` (the role active when
-- CREATE ran); the redemption calls below run as `anon`, which needs its own
-- grant to read them. Real anonymous redemption never involves a temp table —
-- this exists only so the test can hand the raw token to the next statement.
grant select on tmp_open_invite, tmp_approval_invite, tmp_expired_invite to anon;
reset role;

set local role anon;
create temporary table tmp_redeemed as
  select * from app.redeem_invite_link((select token from tmp_open_invite), 'Anon Joiner', '+2348022223333');
reset role;

select ok(
  (select status from tmp_redeemed) = 'unclaimed',
  'an anonymous joiner via an open invite link becomes ''unclaimed'' (never ''active'' — that needs phone verification)'
);

set local role anon;
select throws_ok(
  $$ select app.redeem_invite_link(
       (select token from tmp_expired_invite), 'Late Joiner', '+2348022224444'
     ) $$,
  'P0001', null,
  'a joiner cannot redeem an expired invite link'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999991","role":"authenticated"}';
select lives_ok(
  $$ select app.revoke_invite_link((select id from tmp_open_invite)) $$,
  'the owner can revoke an invite link'
);
reset role;

set local role anon;
select throws_ok(
  $$ select app.redeem_invite_link(
       (select token from tmp_open_invite), 'Too Late Joiner', '+2348022225555'
     ) $$,
  'P0001', null,
  'a joiner cannot redeem a revoked invite link'
);
create temporary table tmp_pending as
  select * from app.redeem_invite_link((select token from tmp_approval_invite), 'Pending Joiner', '+2348022226666');
grant select on tmp_pending to authenticated;
reset role;

select ok(
  (select status from tmp_pending) = 'pending_approval',
  'a joiner via an approval-required invite link becomes ''pending_approval'' (MEM-09)'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999991","role":"authenticated"}';
select lives_ok(
  $$ select app.approve_pending_member((select member_id from tmp_pending)) $$,
  'the owner (invite.approve) can approve a pending join request'
);
reset role;

select ok(
  (select status from public.members where id = (select member_id from tmp_pending)) = 'unclaimed',
  'an approved pending member moves to ''unclaimed'', not ''active'''
);


-- ── Officer invitations (OFF-01) ─────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999991","role":"authenticated"}';
create temporary table tmp_officer_invite as
  select * from app.create_officer_invitation(
    '88888888-8888-4888-8888-888888888881', 'admin', 'Team Admin', null,
    'App Invitee', null, 'invitee@app.example.test'
  );
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999993","role":"authenticated"}';
select throws_ok(
  $$ select app.accept_officer_invitation((select token from tmp_officer_invite)) $$,
  '42501', null,
  'someone other than the named invitee cannot accept an officer invitation, even with the token'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999994","role":"authenticated"}';
create temporary table tmp_accepted as
  select app.accept_officer_invitation((select token from tmp_officer_invite)) as officer_term_id;
reset role;

select ok(
  exists (
    select 1 from public.officer_terms
    where id = (select officer_term_id from tmp_accepted)
      and user_id = '99999999-9999-4999-8999-999999999994' and role = 'admin' and ended_at is null
  ),
  'the invitee accepting creates their officer_term (OFF-01)'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999994","role":"authenticated"}';
select throws_ok(
  $$ select app.accept_officer_invitation((select token from tmp_officer_invite)) $$,
  'P0001', null,
  'the same officer invitation cannot be accepted twice'
);
reset role;


-- ── end_officer_term ──────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999994","role":"authenticated"}';
select lives_ok(
  $$ select app.end_officer_term((select officer_term_id from tmp_accepted), 'no longer available') $$,
  'an officer can end (resign) their own term'
);
reset role;

select ok(
  (select end_reason from public.officer_terms where id = (select officer_term_id from tmp_accepted)) = 'resigned',
  'a self-ended term is recorded as a resignation'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999992","role":"authenticated"}';
select throws_ok(
  $$ select app.end_officer_term('77777777-7777-4777-8777-777777777771', 'unauthorized removal attempt') $$,
  '42501', null,
  'an admin cannot remove an owner — that needs officer.remove_owner (PRD 2.2)'
);
reset role;

-- ROLE-02's owner guard is a deferred constraint trigger; see 05_guards.sql for
-- why this file must move it to IMMEDIATE for throws_ok to observe it.
set constraints all immediate;

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-4999-8999-999999999991","role":"authenticated"}';
select throws_ok(
  $$ select app.end_officer_term('77777777-7777-4777-8777-777777777771', 'testing last-owner guard') $$,
  'P0001', null,
  'the last owner cannot end their own term via end_officer_term (ROLE-02)'
);
reset role;

select * from finish();
rollback;
