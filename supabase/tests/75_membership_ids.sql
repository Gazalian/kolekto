-- ─────────────────────────────────────────────────────────────────────────────
-- 75 — Membership foundation (20261123100000, 20261123100100): delegable
--      permissions, membership ID format, issue / replace / revoke, suspension
--
--   · the four new permissions belong to the owner role only by default
--   · an owner can grant a DELEGABLE permission to one officer term; nobody
--     else can grant; money / officer permissions are never delegable; the
--     grant stops working when revoked or when the term ends
--   · format settings: validation, upper-casing, reserved prefixes, audit
--   · issue: format must match current settings; good-standing members only
--     (unclaimed counts — owner decision Q8); one live ID per member; unique
--     per community; a collision is reported so the server regenerates
--   · a prefix change affects new IDs only; old IDs stay live
--   · 20261123120000 (owner decisions A1, D1, D2, D5, 2026-11-23): the ID is
--     stored as plaintext with a canonical form; replaced / revoked rows KEEP
--     their ID so it is never reissued; a legacy fingerprint-only row stays
--     reserved and issuing without the fingerprint check fails closed; the full
--     ID is shown only to holders of membership.issue_ids (masked otherwise);
--     audit rows carry only the masked form; revoke needs a reason
--   · suspend / reinstate: permission, reason, state machine, archive clears
--   · the ledger is untouched
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(71);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a7510000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@m75.example.test', now()),
  ('a7510000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@m75.example.test', now()),
  ('a7510000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer@m75.example.test', now()),
  ('a7510000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@m75.example.test', now()),
  ('a7510000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@m75.example.test', now());
insert into public.users (id, full_name, email, identity_level) values
  ('a7510000-0000-4000-8000-000000000001', 'M75 Owner',     'owner@m75.example.test',     'contact_verified'),
  ('a7510000-0000-4000-8000-000000000002', 'M75 Admin',     'admin@m75.example.test',     'contact_verified'),
  ('a7510000-0000-4000-8000-000000000003', 'M75 Treasurer', 'treasurer@m75.example.test', 'contact_verified'),
  ('a7510000-0000-4000-8000-000000000004', 'M75 Viewer',    'viewer@m75.example.test',    'contact_verified'),
  ('a7510000-0000-4000-8000-000000000009', 'M75 Outsider',  'outsider@m75.example.test',  'contact_verified')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a7520000-0000-4000-8000-00000000000a', 'm75-a', 'M75 Alpha', 'social_group', false, 'a7510000-0000-4000-8000-000000000001'),
  ('a7520000-0000-4000-8000-00000000000b', 'm75-b', 'M75 Beta',  'social_group', false, 'a7510000-0000-4000-8000-000000000009');

insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a7530000-0000-4000-8000-000000000001', 'a7520000-0000-4000-8000-00000000000a', 'a7510000-0000-4000-8000-000000000001', 'owner',     'M75 Owner',     'created'),
  ('a7530000-0000-4000-8000-000000000002', 'a7520000-0000-4000-8000-00000000000a', 'a7510000-0000-4000-8000-000000000002', 'admin',     'M75 Admin',     'invited'),
  ('a7530000-0000-4000-8000-000000000003', 'a7520000-0000-4000-8000-00000000000a', 'a7510000-0000-4000-8000-000000000003', 'treasurer', 'M75 Treasurer', 'invited'),
  ('a7530000-0000-4000-8000-000000000004', 'a7520000-0000-4000-8000-00000000000a', 'a7510000-0000-4000-8000-000000000004', 'viewer',    'M75 Viewer',    'invited'),
  ('a7530000-0000-4000-8000-000000000009', 'a7520000-0000-4000-8000-00000000000b', 'a7510000-0000-4000-8000-000000000009', 'owner',     'M75 Outsider',  'created');

insert into public.members (id, community_id, full_name, status, phone_e164, archived_at) values
  ('a7540000-0000-4000-8000-000000000001', 'a7520000-0000-4000-8000-00000000000a', 'Unclaimed Uche', 'unclaimed',        null,            null),
  ('a7540000-0000-4000-8000-000000000002', 'a7520000-0000-4000-8000-00000000000a', 'Active Ada',     'active',           '+2348010000002', null),
  ('a7540000-0000-4000-8000-000000000003', 'a7520000-0000-4000-8000-00000000000a', 'Pending Pat',    'pending_approval', null,            null),
  ('a7540000-0000-4000-8000-000000000004', 'a7520000-0000-4000-8000-00000000000a', 'Archived Ayo',   'archived',         null,            now()),
  ('a7540000-0000-4000-8000-000000000005', 'a7520000-0000-4000-8000-00000000000a', 'Suspend Sam',    'unclaimed',        null,            null),
  ('a7540000-0000-4000-8000-0000000000b1', 'a7520000-0000-4000-8000-00000000000b', 'Beta Bola',      'unclaimed',        null,            null);

create temp table tmp_ledger_before on commit drop as
  select (select count(*) from public.ledger_journals) as journals, (select count(*) from public.ledger_entries) as entries;
grant select on tmp_ledger_before to authenticated, anon;

create function pg_temp.as_user(p_n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    format('{"sub":"a7510000-0000-4000-8000-00000000000%s","role":"authenticated"}', p_n), true);
end;
$$;

-- ── Defaults: owner only ─────────────────────────────────────────────────────
select results_eq(
  $$ select role::text, permission from public.role_permissions
     where permission in ('membership.configure_ids', 'membership.issue_ids', 'member.suspend', 'officer.delegate')
     order by 1, 2 $$,
  $$ values ('owner', 'member.suspend'), ('owner', 'membership.configure_ids'),
            ('owner', 'membership.issue_ids'), ('owner', 'officer.delegate') $$,
  'the four new permissions belong to the owner role only'
);
select bag_eq(
  $$ select key from public.permissions where delegable $$,
  $$ values ('membership.configure_ids'), ('membership.issue_ids'), ('member.suspend'),
            ('member.create'), ('member.edit'), ('invite.approve') $$,
  'only membership-management permissions are delegable (no money, officer or ownership permission)'
);

set local role authenticated;
select pg_temp.as_user('2');
select ok(not app.has_permission('a7520000-0000-4000-8000-00000000000a', 'membership.issue_ids'),
  'an admin does not hold membership.issue_ids by role');
select throws_like(
  $$ select app.grant_officer_permission('a7530000-0000-4000-8000-000000000003', 'member.suspend') $$,
  '%FORBIDDEN%', 'an admin cannot grant permissions (officer.delegate is the owner''s)');
select throws_like(
  $$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', 'IDS', '/', 5::smallint, true) $$,
  '%FORBIDDEN%', 'an admin cannot configure membership IDs without a grant');

select pg_temp.as_user('9');
select throws_like(
  $$ select app.grant_officer_permission('a7530000-0000-4000-8000-000000000002', 'membership.issue_ids') $$,
  '%FORBIDDEN%', 'the owner of another community cannot grant here');

select pg_temp.as_user('1');
select throws_like(
  $$ select app.grant_officer_permission('a7530000-0000-4000-8000-000000000002', 'withdrawal.request') $$,
  '%NOT_DELEGABLE%', 'a money permission cannot be delegated');
select throws_like(
  $$ select app.grant_officer_permission('a7530000-0000-4000-8000-000000000002', 'officer.delegate') $$,
  '%NOT_DELEGABLE%', 'the power to delegate cannot itself be delegated');
select throws_like(
  $$ select app.grant_officer_permission('a7530000-0000-4000-8000-000000000001', 'member.suspend') $$,
  '%NOT_NEEDED%', 'granting to an owner term is refused');
select lives_ok(
  $$ select app.grant_officer_permission('a7530000-0000-4000-8000-000000000002', 'membership.issue_ids');
     select app.grant_officer_permission('a7530000-0000-4000-8000-000000000002', 'membership.issue_ids') $$,
  'the owner grants membership.issue_ids to the admin (twice = once)');

select pg_temp.as_user('2');
select ok(app.has_permission('a7520000-0000-4000-8000-00000000000a', 'membership.issue_ids'),
  'the admin now holds membership.issue_ids through the grant');
select ok(not app.has_permission('a7520000-0000-4000-8000-00000000000b', 'membership.issue_ids'),
  'the grant does not reach another community');
select ok(not app.has_permission('a7520000-0000-4000-8000-00000000000a', 'member.suspend'),
  'a grant gives exactly one permission');

reset role;
select is((select count(*)::int from public.officer_permission_grants where officer_term_id = 'a7530000-0000-4000-8000-000000000002'),
  1, 'the repeated grant stored one row');
select is((select count(*)::int from public.audit_logs where action = 'officer.grant_permission'
           and object_id = 'a7530000-0000-4000-8000-000000000002'),
  1, 'the grant is audited once');

-- ── Settings ────────────────────────────────────────────────────────────────
set local role authenticated;
select pg_temp.as_user('1');
select throws_like($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', 'I', '/', 5::smallint, true) $$,
  '%INVALID_PREFIX%', 'a one-character prefix is refused');
select throws_like($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', '1DS', '/', 5::smallint, true) $$,
  '%INVALID_PREFIX%', 'a prefix must start with a letter');
select throws_like($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', 'ID$', '/', 5::smallint, true) $$,
  '%INVALID_PREFIX%', 'symbols are refused');
select throws_like($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', 'km', '/', 5::smallint, true) $$,
  '%RESERVED_PREFIX%', 'a reserved prefix is refused (after upper-casing)');
select throws_like($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', 'IDS', '.', 5::smallint, true) $$,
  '%INVALID_SEPARATOR%', 'only / and - are separators');
select throws_like($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', 'IDS', '/', 4::smallint, true) $$,
  '%INVALID_SUFFIX_LENGTH%', 'fewer than 5 random characters is refused');
select throws_like($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', 'IDS', '/', 9::smallint, true) $$,
  '%INVALID_SUFFIX_LENGTH%', 'more than 8 random characters is refused');
select lives_ok($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', ' ids ', '/', 5::smallint, false) $$,
  'the owner saves a valid format (switched off)');
select results_eq($$ select prefix, separator, suffix_length, enabled from app.get_membership_id_settings('a7520000-0000-4000-8000-00000000000a') $$,
  $$ values ('IDS'::text, '/'::text, 5::smallint, false) $$, 'the prefix is stored upper-case with spaces removed');

-- ── Issue (plaintext, owner decision A1 — 20261123120000) ───────────────────
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000001', 'IDS/K7P9Q') $$,
  '%MEMBERSHIP_IDS_OFF%', 'nothing is issued while membership IDs are off');
select lives_ok($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', 'IDS', '/', 5::smallint, true) $$,
  'the owner switches membership IDs on');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000001', 'OLD/K7P9Q') $$,
  '%SETTINGS_CHANGED%', 'an ID generated in another prefix is refused');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000001', 'IDS/K7P9QQ') $$,
  '%SETTINGS_CHANGED%', 'an ID generated with another suffix length is refused');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000001', 'IDS/K7P9U') $$,
  '%INVALID_INPUT%', 'a suffix outside the Crockford alphabet is refused (no U)');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000001', 'IDS/12345') $$,
  '%INVALID_INPUT%', 'an all-digit suffix is refused (it could look like a member number)');

select pg_temp.as_user('2');  -- the admin, through the grant
select lives_ok($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000001', 'IDS/K7P9Q') $$,
  'an UNCLAIMED member gets an ID (owner decision Q8), issued by a granted admin');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000001', 'IDS/K7P9R') $$,
  '%ALREADY_ISSUED%', 'one live ID per member');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000002', 'IDS/K7P9Q') $$,
  '%MEMBERSHIP_ID_COLLISION%', 'the same ID twice in one community is a collision the server must regenerate');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000003', 'IDS/P3P3P') $$,
  '%MEMBER_NOT_ELIGIBLE%', 'a pending applicant gets no ID');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000004', 'IDS/R4R4R') $$,
  '%MEMBER_NOT_ELIGIBLE%', 'an archived member gets no ID');

select pg_temp.as_user('3');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000002', 'IDS/T2T2T') $$,
  '%FORBIDDEN%', 'a treasurer without a grant cannot issue');

-- The prefix changes; the old ID stays live, new IDs use the new prefix.
select pg_temp.as_user('1');
select lives_ok($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000a', 'AHS', '-', 6::smallint, true) $$,
  'the owner changes the format');
select lives_ok($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000002', 'AHS-BBBBZ9') $$,
  'a new ID uses the new format');

reset role;
select results_eq(
  $$ select prefix, separator, revoked_at is null from public.membership_ids
     where community_id = 'a7520000-0000-4000-8000-00000000000a' order by issued_at, id $$,
  $$ values ('IDS'::text, '/'::text, true), ('AHS'::text, '-'::text, true) $$,
  'the ID issued before the change is still live, in its original format');
select results_eq(
  $$ select membership_id, canonical_id, last2, id_hash is null, id_ciphertext is null from public.membership_ids
     where member_id = 'a7540000-0000-4000-8000-000000000001' $$,
  $$ values ('IDS/K7P9Q'::text, '1DSK7P9Q'::text, '9Q'::text, true, true) $$,
  'the original ID is stored as plaintext with its canonical form; no hash, no ciphertext (A1)');

-- Legacy fingerprint-only rows stay reserved forever (owner decision D1).
-- Fixture: a revoked row of the old design, written past the guard (which now
-- refuses any new row without plaintext) inside this rolled-back test.
alter table public.membership_ids disable trigger membership_ids_guard;
insert into public.membership_ids (community_id, member_id, id_hash, prefix, separator, last2, revoked_at, revoke_reason)
values ('a7520000-0000-4000-8000-00000000000b', 'a7540000-0000-4000-8000-0000000000b1',
        extensions.digest('LEGACY-B', 'sha256'), 'IDS', '/', 'LG', now(), 'legacy fixture');
alter table public.membership_ids enable trigger membership_ids_guard;

set local role authenticated;
select pg_temp.as_user('9');
select lives_ok($$ select app.set_membership_id_settings('a7520000-0000-4000-8000-00000000000b', 'IDS', '/', 5::smallint, true) $$,
  'the other community switches IDs on');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-0000000000b1', 'IDS/K7P9Q') $$,
  '%LEGACY_CHECK_UNAVAILABLE%', 'with a legacy fingerprint row present, issuing without the fingerprint check is refused (fails closed)');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-0000000000b1', 'IDS/K7P9Q', extensions.digest('LEGACY-B', 'sha256')) $$,
  '%MEMBERSHIP_ID_COLLISION%', 'a candidate matching a legacy fingerprint is a collision: the old ID is never reissued');
select lives_ok($$ select app.issue_membership_id('a7540000-0000-4000-8000-0000000000b1', 'IDS/K7P9Q', extensions.digest('OTHER', 'sha256')) $$,
  'uniqueness is per community: the same ID is fine in another community once the legacy check passes');

-- ── Replace and revoke ──────────────────────────────────────────────────────
select pg_temp.as_user('1');
select lives_ok($$ select app.rotate_membership_id('a7540000-0000-4000-8000-000000000001', 'AHS-DDDDX7', 'member lost it') $$,
  'the owner replaces a member''s ID');
reset role;
select results_eq(
  $$ select membership_id, canonical_id, revoke_reason from public.membership_ids
     where member_id = 'a7540000-0000-4000-8000-000000000001' and revoked_at is not null $$,
  $$ values ('IDS/K7P9Q'::text, '1DSK7P9Q'::text, 'member lost it'::text) $$,
  'the replaced row is revoked and KEPT, ID included (D2)');
set local role authenticated;
select pg_temp.as_user('1');
select throws_like($$ select app.revoke_membership_id('a7540000-0000-4000-8000-000000000002', '  ') $$,
  '%REASON_REQUIRED%', 'revoking needs a reason');
select lives_ok($$ select app.revoke_membership_id('a7540000-0000-4000-8000-000000000002', 'left the association') $$,
  'the owner revokes an ID');
reset role;
select is((select membership_id from public.membership_ids
           where member_id = 'a7540000-0000-4000-8000-000000000002' and revoked_at is not null),
  'AHS-BBBBZ9', 'the revoked row keeps its ID (D2)');
set local role authenticated;
select pg_temp.as_user('1');
select is((select count(*)::int from app.get_member_membership_id('a7540000-0000-4000-8000-000000000002')), 0,
  'a revoked ID is no longer shown');
select throws_like($$ select app.issue_membership_id('a7540000-0000-4000-8000-000000000002', 'AHS-BBBBZ9') $$,
  '%MEMBERSHIP_ID_COLLISION%', 'a revoked ID can never be issued again, not even to the same member');

-- ── Who sees the full ID (owner decision D5) ────────────────────────────────
select is((select membership_id from app.get_member_membership_id('a7540000-0000-4000-8000-000000000001')),
  'AHS-DDDDX7', 'the owner sees the full current ID');
select pg_temp.as_user('2');
select is((select membership_id from app.get_member_membership_id('a7540000-0000-4000-8000-000000000001')),
  'AHS-DDDDX7', 'an officer granted membership.issue_ids sees the full ID');
select pg_temp.as_user('4');
select throws_like($$ select * from app.get_member_membership_id('a7540000-0000-4000-8000-000000000001') $$,
  '%FORBIDDEN%', 'an officer with member.view_contact only does NOT see the full ID (D5)');
select is((select masked from app.community_membership_id_summary('a7520000-0000-4000-8000-00000000000a')
           where member_id = 'a7540000-0000-4000-8000-000000000001'),
  'AHS-•••X7', 'that officer sees the masked form');
select pg_temp.as_user('9');
select throws_like($$ select * from app.get_member_membership_id('a7540000-0000-4000-8000-000000000001') $$,
  '%FORBIDDEN%', 'an outsider cannot read it');

reset role;
select throws_like($$ update public.membership_ids set membership_id = 'AHS-ZZZZZZ', canonical_id = 'AHSZZZZZZ'
                      where member_id = 'a7540000-0000-4000-8000-000000000001' and revoked_at is null $$,
  '%MEMBERSHIP_ID_IS_IMMUTABLE%', 'a live ID cannot be edited in place');
select throws_like($$ update public.membership_ids set membership_id = null, canonical_id = null, id_hash = extensions.digest('x', 'sha256')
                      where member_id = 'a7540000-0000-4000-8000-000000000002' $$,
  '%MEMBERSHIP_ID_IS_IMMUTABLE%', 'a revoked ID cannot be erased');
select throws_like($$ delete from public.membership_ids where member_id = 'a7540000-0000-4000-8000-000000000001' $$,
  '%IMMUTABLE%', 'ID rows cannot be deleted');
select bag_eq(
  $$ select column_name::text from information_schema.columns where table_schema = 'public' and table_name = 'membership_ids' $$,
  $$ values ('id'), ('community_id'), ('member_id'), ('id_hash'), ('id_ciphertext'), ('key_version'), ('prefix'),
            ('separator'), ('last2'), ('issued_at'), ('issued_by'), ('revoked_at'), ('revoked_by'), ('revoke_reason'),
            ('membership_id'), ('canonical_id') $$,
  'membership_ids columns after 20261123120000 (legacy hash/ciphertext kept until 20261123120100)');
select is((select count(*)::int from public.audit_logs
           where action in ('member.issue_membership_id', 'member.rotate_membership_id', 'member.revoke_membership_id')
             and (coalesce(before_state::text, '') || coalesce(after_state::text, '') || coalesce(reason, ''))
                 ~ '(K7P9Q|K7P9R|BBBBZ9|DDDDX7|1DSK7P9Q|v1\.|ciphertext|id_hash)'),
  0, 'audit rows carry the masked form only — never the ID, its canonical form, a ciphertext or a hash');
select ok(not has_function_privilege('authenticated', 'app.backfill_membership_id_plaintext(uuid, text)', 'EXECUTE')
          and not has_function_privilege('anon', 'app.backfill_membership_id_plaintext(uuid, text)', 'EXECUTE'),
  'no client role can run the one-time backfill');

-- ── Suspension ──────────────────────────────────────────────────────────────
set local role authenticated;
select pg_temp.as_user('3');
select throws_like($$ select app.suspend_member('a7540000-0000-4000-8000-000000000002', 'dues') $$,
  '%FORBIDDEN%', 'a treasurer without a grant cannot suspend');
select pg_temp.as_user('1');
select throws_like($$ select app.suspend_member('a7540000-0000-4000-8000-000000000002', '') $$,
  '%REASON_REQUIRED%', 'suspending needs a reason');
select lives_ok($$ select app.suspend_member('a7540000-0000-4000-8000-000000000002', 'conduct review') $$,
  'the owner suspends an active member');
select throws_like($$ select app.suspend_member('a7540000-0000-4000-8000-000000000002', 'again') $$,
  '%INVALID_STATE%', 'a suspended member cannot be suspended again');
select is(app.reinstate_member('a7540000-0000-4000-8000-000000000002', 'review closed'), 'active'::public.member_status,
  'reinstatement returns the member to the status they had');
select lives_ok($$ select app.suspend_member('a7540000-0000-4000-8000-000000000005', 'unpaid levy');
                   select app.archive_member('a7540000-0000-4000-8000-000000000005', 'left') $$,
  'a suspended member can be archived');

reset role;
select results_eq(
  $$ select status::text, suspended_at is null, status_before_suspension is null from public.members
     where id = 'a7540000-0000-4000-8000-000000000005' $$,
  $$ values ('archived'::text, true, true) $$, 'archiving clears the suspension record');
select results_eq(
  $$ select (select count(*) from public.ledger_journals) - journals, (select count(*) from public.ledger_entries) - entries
     from tmp_ledger_before $$,
  $$ values (0::bigint, 0::bigint) $$, 'no ledger journal or entry was written');

-- The grant ends with the officer's term.
update public.officer_terms set ended_at = now(), end_reason = 'removed'
where id = 'a7530000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.as_user('2');
select ok(not app.has_permission('a7520000-0000-4000-8000-00000000000a', 'membership.issue_ids'),
  'a granted permission ends when the officer term ends');

select * from finish();
rollback;
