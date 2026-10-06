-- ─────────────────────────────────────────────────────────────────────────────
-- 24 — Email identity is case-insensitive, and the comparison says so explicitly
--
-- Coverage for 20260928100000_citext_explicit_email_comparisons.sql (finding F-2,
-- docs/migration/STAGING-ENVIRONMENT-VALIDATION.md §13).
--
-- Email columns are `extensions.citext`, and citext is case-insensitive only when
-- its own `=` operator is the one chosen. Postgres picks the operator by search
-- path at the moment an expression is parsed. Two things parsed without the
-- `extensions` schema on the path silently fell back to case-sensitive `text =`:
--
--   · functions declared `set search_path = ''` — every environment, every call
--   · the RLS policy officer_invitations_select_invitee, when a migration was
--     pushed by a role whose search path lacks `extensions` — the hosted staging
--     project, where the CLI pushes as `cli_login_postgres`
--
-- So `Ada@Example.test` and `ada@example.test` were two different people to the
-- invitation-accept check and to duplicate detection.
--
-- The session search path cannot rescue the defect: every email comparison under
-- test runs either inside a function that forces `search_path = ''`, or inside a
-- policy whose operator was fixed when it was created. This file itself never
-- compares two emails — it casts to text only to read values back. `extensions`
-- is on the path solely because pgTAP lives there.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to public, app, extensions, pg_catalog;
select plan(15);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- 5a… users, 5b… communities, 5c… officer terms.
insert into auth.users (id, instance_id, aud, role, email) values
  ('5a000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'case.owner@example.test'),
  ('5a000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'exact.case@example.test'),
  ('5a000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ada.case@example.test'),
  ('5a000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ada.case@example.tes'),
  ('5a000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'case.outsider@example.test'),
  ('5a000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other.owner@example.test');

-- The auth.users insert fired app.handle_new_auth_user(); overwrite the
-- placeholder names. Emails are stored exactly as written — this file never
-- normalises case to make a comparison pass, because the fix must not either.
insert into public.users (id, full_name, email) values
  ('5a000000-0000-4000-8000-000000000001', 'Case Owner',      'case.owner@example.test'),
  ('5a000000-0000-4000-8000-000000000002', 'Exact Case',      'exact.case@example.test'),
  ('5a000000-0000-4000-8000-000000000003', 'Ada Case',        'ada.case@example.test'),
  ('5a000000-0000-4000-8000-000000000004', 'Near Miss',       'ada.case@example.tes'),
  ('5a000000-0000-4000-8000-000000000005', 'Case Outsider',   'case.outsider@example.test'),
  ('5a000000-0000-4000-8000-000000000006', 'Other Owner',     'other.owner@example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('5b000000-0000-4000-8000-00000000000a', 'email-case-a', 'Email Case A', 'fellowship', false, '5a000000-0000-4000-8000-000000000001'),
  ('5b000000-0000-4000-8000-00000000000b', 'email-case-b', 'Email Case B', 'fellowship', false, '5a000000-0000-4000-8000-000000000006');

insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('5c000000-0000-4000-8000-000000000001', '5b000000-0000-4000-8000-00000000000a', '5a000000-0000-4000-8000-000000000001', 'owner', 'Case Owner',  'created'),
  ('5c000000-0000-4000-8000-000000000002', '5b000000-0000-4000-8000-00000000000b', '5a000000-0000-4000-8000-000000000006', 'owner', 'Other Owner', 'created');


-- ── Structure: the policy's email comparison is citext's own operator ────────
-- Resolved by oid, never by name: the oid differs per database, and a name
-- lookup would itself depend on the search path this file is testing.
select ok(
  (select polqual::text from pg_policy where polname = 'officer_invitations_select_invitee')
    ~ (':opno ' || (
        select o.oid from pg_operator o
        where o.oprname = '='
          and o.oprleft  = 'extensions.citext'::regtype
          and o.oprright = 'extensions.citext'::regtype
      )::text || ' '),
  'officer_invitations_select_invitee compares email with citext''s equality operator, not text''s'
);


-- ── Officer invitations: one exact-case, one mixed-case ──────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000001","role":"authenticated"}';
create temporary table tmp_exact_invite as
  select * from app.create_officer_invitation(
    '5b000000-0000-4000-8000-00000000000a', 'admin', 'Exact Admin', null,
    'Exact Case', null, 'exact.case@example.test'
  );
-- The officer typed the address with capitals. The invitee's account is lower case.
create temporary table tmp_mixed_invite as
  select * from app.create_officer_invitation(
    '5b000000-0000-4000-8000-00000000000a', 'treasurer', 'Mixed Treasurer', null,
    'Ada Case', null, 'Ada.Case@Example.TEST'
  );
reset role;

select is(
  (select invitee_email::text from public.officer_invitations
   where id = (select id from tmp_mixed_invite)),
  'Ada.Case@Example.TEST',
  'the invitation keeps the address exactly as typed — case is compared, never rewritten'
);

-- 1. exact-case match — visibility
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(
  (select count(*)::integer from public.officer_invitations where id = (select id from tmp_exact_invite)),
  1,
  'exact-case: the invitee can see the invitation addressed to them'
);
reset role;

-- 2. mixed-case match — visibility
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  (select count(*)::integer from public.officer_invitations where id = (select id from tmp_mixed_invite)),
  1,
  'mixed-case: ada.case@ can see the invitation addressed to Ada.Case@'
);
reset role;

-- 6. an unrelated user sees neither
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000005","role":"authenticated"}';
select is(
  (select count(*)::integer from public.officer_invitations
   where id in ((select id from tmp_exact_invite), (select id from tmp_mixed_invite))),
  0,
  'an unrelated user cannot see either invitation'
);
reset role;

-- 5. a genuinely different address — differs by one character, not by case
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000004","role":"authenticated"}';
select is(
  (select count(*)::integer from public.officer_invitations where id = (select id from tmp_mixed_invite)),
  0,
  'a genuinely different address (…@example.tes) cannot see the invitation'
);
select throws_ok(
  $$ select app.accept_officer_invitation((select token from tmp_mixed_invite)) $$,
  '42501', null,
  'a genuinely different address cannot accept the invitation, even holding the token'
);
reset role;

-- 6. an unauthorized user holding the token cannot exploit the comparison
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000005","role":"authenticated"}';
select throws_ok(
  $$ select app.accept_officer_invitation((select token from tmp_mixed_invite)) $$,
  '42501', null,
  'an unrelated user holding the token cannot accept a mixed-case invitation'
);
reset role;

-- 1. exact-case acceptance
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok(
  $$ select app.accept_officer_invitation((select token from tmp_exact_invite)) $$,
  'exact-case: the invitee can accept'
);
reset role;

-- 3. mixed-case acceptance — the defect this file exists for
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000003","role":"authenticated"}';
select lives_ok(
  $$ select app.accept_officer_invitation((select token from tmp_mixed_invite)) $$,
  'mixed-case: ada.case@ can accept an invitation addressed to Ada.Case@'
);
reset role;

select ok(
  exists (
    select 1 from public.officer_terms
    where community_id = '5b000000-0000-4000-8000-00000000000a'
      and user_id = '5a000000-0000-4000-8000-000000000003'
      and role = 'treasurer' and ended_at is null
  ),
  'the mixed-case acceptance granted exactly the invited role to the right person'
);


-- ── Duplicate detection ──────────────────────────────────────────────────────
-- 'unclaimed', not 'active': an active member must have a phone number
-- (members_active_has_phone), and these rows exist to be found by email.
insert into public.members (id, community_id, full_name, email, member_code, status) values
  ('5d000000-0000-4000-8000-000000000001', '5b000000-0000-4000-8000-00000000000a', 'Ngozi Member', 'ngozi@example.test', 'CASE-0001', 'unclaimed'),
  ('5d000000-0000-4000-8000-000000000002', '5b000000-0000-4000-8000-00000000000b', 'Other Roll',   'shared@example.test', 'CASE-0002', 'unclaimed');

set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- 4. duplicate detection with case variation
select is(
  (select match_reason from app.find_member_duplicates(
     '5b000000-0000-4000-8000-00000000000a', null, null, 'NGOZI@Example.Test'
   ) where member_id = '5d000000-0000-4000-8000-000000000001'),
  'Same email address',
  'mixed-case: NGOZI@Example.Test is detected as the same email as ngozi@example.test'
);

-- 5. a genuinely different address is not a duplicate
select is(
  (select count(*)::integer from app.find_member_duplicates(
     '5b000000-0000-4000-8000-00000000000a', null, null, 'ngozi@example.tes'
   ) where match_reason = 'Same email address'),
  0,
  'a genuinely different address is not reported as the same email'
);

-- Case-insensitivity must not widen the search across communities.
select is(
  (select count(*)::integer from app.find_member_duplicates(
     '5b000000-0000-4000-8000-00000000000a', null, null, 'SHARED@example.test'
   )),
  0,
  'a case-variant address held only in another community is not reported'
);
reset role;

-- 6. an officer of another community cannot use the comparison to probe this roll
set local role authenticated;
set local request.jwt.claims = '{"sub":"5a000000-0000-4000-8000-000000000006","role":"authenticated"}';
select throws_ok(
  $$ select app.find_member_duplicates('5b000000-0000-4000-8000-00000000000a', null, null, 'Ngozi@Example.Test') $$,
  '42501', null,
  'an officer of another community cannot probe this roll by email, in any case'
);
reset role;

select * from finish();
rollback;
