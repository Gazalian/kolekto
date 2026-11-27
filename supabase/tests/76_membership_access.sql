-- ─────────────────────────────────────────────────────────────────────────────
-- 76 — Membership ID validation, rate limits and access grants
--      (20261123100100, product doc §F6; owner decisions Q9, Q10)
--
--   · a valid ID of a member in good standing who is in the collection's
--     audience yields a 30-minute token, returned once, stored as SHA-256 only
--   · every failure answers exactly the same (false, null, null): unknown ID,
--     another community's ID, suspended, archived, pending, merged, outside
--     the audience, open / closed / other-community collection
--   · the result never carries a name, code or contact
--   · 20261123120000 (owner decision A1): the typed ID is canonicalised in SQL
--     and compared with the stored plaintext ID's canonical form; typing
--     differences are tolerated; overlong input is a generic failure
--   · per-IP-hash limits (10 failures or 30 attempts in 15 minutes), a
--     per-collection limit (200 failures / hour) with ONE lockout audit row,
--     a per-community limit (1,000 failures / day)
--   · a grant works on its own collection only, expires, and stops at once on
--     suspension or ID replacement; the old ID stops validating
--   · attempts store an IP hash and no member reference
--   · the ledger is untouched
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(41);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a7610000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@m76.example.test', now()),
  ('a7610000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@m76.example.test', now());
insert into public.users (id, full_name, email, identity_level) values
  ('a7610000-0000-4000-8000-000000000001', 'M76 Owner', 'owner@m76.example.test', 'contact_verified'),
  ('a7610000-0000-4000-8000-000000000009', 'M76 Other', 'other@m76.example.test', 'contact_verified')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a7620000-0000-4000-8000-00000000000a', 'm76-a', 'M76 Alpha', 'social_group', false, 'a7610000-0000-4000-8000-000000000001'),
  ('a7620000-0000-4000-8000-00000000000b', 'm76-b', 'M76 Beta',  'social_group', false, 'a7610000-0000-4000-8000-000000000009');
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a7620000-0000-4000-8000-00000000000a', 'a7610000-0000-4000-8000-000000000001', 'owner', 'M76 Owner', 'created'),
  ('a7620000-0000-4000-8000-00000000000b', 'a7610000-0000-4000-8000-000000000009', 'owner', 'M76 Other', 'created');

insert into public.community_membership_id_settings (community_id, prefix, separator, suffix_length, enabled) values
  ('a7620000-0000-4000-8000-00000000000a', 'IDS', '/', 5, true),
  ('a7620000-0000-4000-8000-00000000000b', 'ABU', '/', 5, true);

insert into public.members (id, community_id, full_name, status, phone_e164, archived_at, merged_into_id, merged_at) values
  ('a7640000-0000-4000-8000-000000000001', 'a7620000-0000-4000-8000-00000000000a', 'Grouped Gbenga', 'unclaimed',        null,             null,  null, null),
  ('a7640000-0000-4000-8000-000000000002', 'a7620000-0000-4000-8000-00000000000a', 'Active Amina',   'active',           '+2348020000002', null,  null, null),
  ('a7640000-0000-4000-8000-000000000003', 'a7620000-0000-4000-8000-00000000000a', 'Archived Ali',   'archived',         null,             now(), null, null),
  ('a7640000-0000-4000-8000-000000000004', 'a7620000-0000-4000-8000-00000000000a', 'Pending Peju',   'pending_approval', null,             null,  null, null),
  ('a7640000-0000-4000-8000-000000000006', 'a7620000-0000-4000-8000-00000000000a', 'Ungrouped Uzo',  'unclaimed',        null,             null,  null, null),
  ('a7640000-0000-4000-8000-0000000000b1', 'a7620000-0000-4000-8000-00000000000b', 'Beta Bisi',      'unclaimed',        null,             null,  null, null);
insert into public.members (id, community_id, full_name, status, merged_into_id, merged_at) values
  ('a7640000-0000-4000-8000-000000000005', 'a7620000-0000-4000-8000-00000000000a', 'Merged Musa', 'merged',
   'a7640000-0000-4000-8000-000000000001', now());

-- IDs, as the server records them since 20261123120000: plaintext + canonical
-- form (owner decision A1). The labels the tests use map to these in pg_temp.v.
insert into public.membership_ids (community_id, member_id, membership_id, canonical_id, prefix, separator, last2)
select c, m, id, app.canonical_membership_id(id), split_part(id, '/', 1), '/', right(id, 2)
from (values
  ('a7620000-0000-4000-8000-00000000000a'::uuid, 'a7640000-0000-4000-8000-000000000001'::uuid, 'IDS/AAAA1'),
  ('a7620000-0000-4000-8000-00000000000a', 'a7640000-0000-4000-8000-000000000002', 'IDS/AAAA2'),
  ('a7620000-0000-4000-8000-00000000000a', 'a7640000-0000-4000-8000-000000000003', 'IDS/AAAA3'),
  ('a7620000-0000-4000-8000-00000000000a', 'a7640000-0000-4000-8000-000000000004', 'IDS/AAAA4'),
  ('a7620000-0000-4000-8000-00000000000a', 'a7640000-0000-4000-8000-000000000005', 'IDS/AAAA5'),
  ('a7620000-0000-4000-8000-00000000000a', 'a7640000-0000-4000-8000-000000000006', 'IDS/AAAA6'),
  ('a7620000-0000-4000-8000-00000000000b', 'a7640000-0000-4000-8000-0000000000b1', 'ABU/BBBB1')
) as t (c, m, id);

insert into public.member_groups (id, community_id, name, created_by) values
  ('a7650000-0000-4000-8000-000000000001', 'a7620000-0000-4000-8000-00000000000a', 'Class of 2010', 'a7610000-0000-4000-8000-000000000001');
insert into public.member_group_memberships (group_id, member_id, added_by) values
  ('a7650000-0000-4000-8000-000000000001', 'a7640000-0000-4000-8000-000000000001', 'a7610000-0000-4000-8000-000000000001');

insert into public.collections (
  id, community_id, slug, name, category, participation_mode, amount_model,
  fixed_amount_kobo, status, visibility, created_by, published_at, published_by
) values
  ('a7660000-0000-4000-8000-000000000001', 'a7620000-0000-4000-8000-00000000000a', 'roll-dues', 'Roll Dues',
   'dues', 'managed', 'fixed', 500000, 'active', 'unlisted', 'a7610000-0000-4000-8000-000000000001', now(), 'a7610000-0000-4000-8000-000000000001'),
  ('a7660000-0000-4000-8000-000000000002', 'a7620000-0000-4000-8000-00000000000a', 'class-dues', 'Class Dues',
   'dues', 'managed', 'fixed', 300000, 'active', 'unlisted', 'a7610000-0000-4000-8000-000000000001', now(), 'a7610000-0000-4000-8000-000000000001'),
  ('a7660000-0000-4000-8000-000000000003', 'a7620000-0000-4000-8000-00000000000a', 'open-gift', 'Open Gift',
   'fundraiser', 'open', 'open_amount', null, 'active', 'public', 'a7610000-0000-4000-8000-000000000001', now(), 'a7610000-0000-4000-8000-000000000001'),
  ('a7660000-0000-4000-8000-000000000004', 'a7620000-0000-4000-8000-00000000000a', 'old-dues', 'Old Dues',
   'dues', 'managed', 'fixed', 100000, 'closed', 'unlisted', 'a7610000-0000-4000-8000-000000000001', now(), 'a7610000-0000-4000-8000-000000000001'),
  ('a7660000-0000-4000-8000-000000000005', 'a7620000-0000-4000-8000-00000000000b', 'beta-dues', 'Beta Dues',
   'dues', 'managed', 'fixed', 100000, 'active', 'unlisted', 'a7610000-0000-4000-8000-000000000009', now(), 'a7610000-0000-4000-8000-000000000009');
update public.collections set audience_mode = 'groups' where id = 'a7660000-0000-4000-8000-000000000002';
insert into public.collection_audience_groups (collection_id, group_id, community_id, added_by) values
  ('a7660000-0000-4000-8000-000000000002', 'a7650000-0000-4000-8000-000000000001', 'a7620000-0000-4000-8000-00000000000a', 'a7610000-0000-4000-8000-000000000001');

create temp table tmp_ledger_before on commit drop as
  select (select count(*) from public.ledger_journals) as journals, (select count(*) from public.ledger_entries) as entries;
create temp table tmp_tokens (label text primary key, token text) on commit drop;
create temp table tmp_fail (case_label text, valid boolean, token text, exp timestamptz) on commit drop;
grant select, insert on tmp_ledger_before, tmp_tokens, tmp_fail to anon, authenticated;

-- v(collection, id label or typed text, ip label) → the function's single row.
-- Labels ID-1…ID-6, ID-B and ID-1-new stand for the stored IDs; anything else
-- is passed through as typed (a guess).
create function pg_temp.v(p_col text, p_id text, p_ip text)
returns table (valid boolean, access_token text, expires_at timestamptz) language sql as $$
  select * from app.validate_membership_id(('a7660000-0000-4000-8000-00000000000' || p_col)::uuid,
    case p_id when 'ID-1' then 'IDS/AAAA1' when 'ID-2' then 'IDS/AAAA2' when 'ID-3' then 'IDS/AAAA3'
              when 'ID-4' then 'IDS/AAAA4' when 'ID-5' then 'IDS/AAAA5' when 'ID-6' then 'IDS/AAAA6'
              when 'ID-B' then 'ABU/BBBB1' when 'ID-1-new' then 'IDS/NNNN1' else p_id end,
    extensions.digest(p_ip, 'sha256')) $$;
grant execute on function pg_temp.v(text, text, text) to anon, authenticated;

-- ── Success ─────────────────────────────────────────────────────────────────
set local role anon;
insert into tmp_tokens select 'roll-1', access_token from pg_temp.v('1', 'ID-1', 'ip-ok');
select ok((select token ~ '^[0-9a-f]{64}$' from tmp_tokens where label = 'roll-1'),
  'an unclaimed member in the audience gets a 64-hex token (owner decision Q8)');
select is(app.resolve_membership_access_grant('a7660000-0000-4000-8000-000000000001', (select token from tmp_tokens where label = 'roll-1')),
  'a7640000-0000-4000-8000-000000000001'::uuid, 'the token resolves to that member on that collection');
select is(app.resolve_membership_access_grant('a7660000-0000-4000-8000-000000000002', (select token from tmp_tokens where label = 'roll-1')),
  null, 'the same token is worthless on another collection');
select is(app.resolve_membership_access_grant('a7660000-0000-4000-8000-000000000001', 'not-a-token'), null,
  'a malformed token resolves to nobody');
select ok((select valid and expires_at between now() + interval '29 minutes' and now() + interval '30 minutes'
           from pg_temp.v('2', 'ID-1', 'ip-ok')),
  'a group member is valid on the group collection; the pass lasts 30 minutes');
select is((select valid from pg_temp.v('1', 'ID-2', 'ip-ok')), true, 'an active member is valid');
select is((select valid from pg_temp.v('1', ' ids - aaaa2 ', 'ip-ok')), true,
  'typing differences (case, spaces, another separator) are tolerated: compared in canonical form');

-- ── Every failure looks the same ────────────────────────────────────────────
insert into tmp_fail select 'unknown',         * from pg_temp.v('1', 'ID-nope', 'ip-f1');
insert into tmp_fail select 'other community', * from pg_temp.v('1', 'ID-B',    'ip-f1');
insert into tmp_fail select 'archived',        * from pg_temp.v('1', 'ID-3',    'ip-f1');
insert into tmp_fail select 'pending',         * from pg_temp.v('1', 'ID-4',    'ip-f1');
insert into tmp_fail select 'merged',          * from pg_temp.v('1', 'ID-5',    'ip-f1');
insert into tmp_fail select 'not in group',    * from pg_temp.v('2', 'ID-6',    'ip-f2');
insert into tmp_fail select 'open collection', * from pg_temp.v('3', 'ID-1',    'ip-f2');
insert into tmp_fail select 'closed',          * from pg_temp.v('4', 'ID-1',    'ip-f2');
insert into tmp_fail select 'wrong community collection', * from pg_temp.v('5', 'ID-1', 'ip-f2');
insert into tmp_fail select 'unknown collection', * from app.validate_membership_id('a7660000-0000-4000-8000-0000000000ff',
  'IDS/AAAA1', extensions.digest('ip-f2', 'sha256'));
insert into tmp_fail select 'overlong input', * from pg_temp.v('1', repeat('A', 41), 'ip-f3');
select is((select count(*)::int from tmp_fail), 11, 'eleven different failures were tried');
select is((select count(*)::int from (select distinct valid, token, exp from tmp_fail) d), 1,
  'all eleven answer identically');
select results_eq($$ select distinct valid, token, exp from tmp_fail $$,
  $$ values (false, null::text, null::timestamptz) $$, 'and that answer is (false, null, null)');

reset role;
select is(pg_get_function_result('app.validate_membership_id(uuid, text, bytea)'::regprocedure),
  'TABLE(valid boolean, access_token text, expires_at timestamp with time zone)',
  'validation returns no name, member code, member id or contact');
select bag_eq(
  $$ select outcome from public.membership_validation_attempts
     where ip_hash in (extensions.digest('ip-f1', 'sha256'), extensions.digest('ip-f2', 'sha256')) $$,
  -- The other community's collection is active and managed, so there the ID
  -- is simply unknown.
  $$ values ('unknown_id'), ('unknown_id'), ('unknown_id'), ('member_ineligible'), ('member_ineligible'),
            ('member_ineligible'), ('not_in_audience'), ('collection_unavailable'), ('collection_unavailable'),
            ('collection_unavailable') $$,
  'each failure is recorded with its true reason, for monitoring only');
select bag_eq(
  $$ select column_name::text from information_schema.columns
     where table_schema = 'public' and table_name = 'membership_validation_attempts' $$,
  $$ values ('id'), ('ip_hash'), ('community_id'), ('collection_id'), ('outcome'), ('attempted_at') $$,
  'attempts hold an IP hash and no member reference');
select is((select count(*)::int from public.membership_access_grants g
           where g.token_hash = extensions.digest((select token from tmp_tokens where label = 'roll-1'), 'sha256')),
  1, 'the grant is stored as the SHA-256 of the token');
select ok(not exists (select 1 from public.membership_access_grants g, tmp_tokens t
                      where encode(g.token_hash, 'hex') = t.token),
  'the raw token is not stored');

-- ── Per-IP limits ───────────────────────────────────────────────────────────
set local role anon;
select is((select count(*)::int from (select x.* from generate_series(1, 10) n, lateral pg_temp.v('1', 'ID-guess-' || n, 'ip-brute') x) x
           where not valid), 10, 'ten wrong guesses from one IP');
select is((select valid from pg_temp.v('1', 'ID-2', 'ip-brute')), false,
  'after ten failures in 15 minutes that IP is refused even with a valid ID');
select is((select valid from pg_temp.v('1', 'ID-2', 'ip-fresh')), true, 'another IP is not affected');
reset role;
-- Counted, not "latest row": every row in this transaction shares now(), and
-- app.uuid_generate_v7() is random within one millisecond, so ordering by id
-- does not reliably find the last insert (it failed this way in CI).
select is((select count(*)::int from public.membership_validation_attempts
           where ip_hash = extensions.digest('ip-brute', 'sha256') and outcome = 'rate_limited'),
  1, 'the refusal is recorded as rate-limited');
update public.membership_validation_attempts set attempted_at = attempted_at - interval '16 minutes'
where ip_hash = extensions.digest('ip-brute', 'sha256');
set local role anon;
select is((select valid from pg_temp.v('1', 'ID-2', 'ip-brute')), true, 'the IP window reopens after 15 minutes');

select is((select count(*)::int from (select x.* from generate_series(1, 30) n, lateral pg_temp.v('1', 'ID-2' || left(n::text, 0), 'ip-busy') x) x
           where valid), 30, 'thirty successful checks from one IP');
select is((select valid from pg_temp.v('1', 'ID-2', 'ip-busy')), false,
  'the 31st check in 15 minutes from that IP is refused even though it is valid');

-- ── Per-collection and per-community limits ─────────────────────────────────
reset role;
insert into public.membership_validation_attempts (ip_hash, community_id, collection_id, outcome)
select extensions.digest('spread-' || n, 'sha256'), 'a7620000-0000-4000-8000-00000000000a', 'a7660000-0000-4000-8000-000000000002', 'unknown_id'
from generate_series(1, 200) n;
set local role anon;
select is((select valid from pg_temp.v('2', 'ID-1', 'ip-new-1')), false,
  '200 failures on one collection in an hour lock it, for every IP');
select is((select valid from pg_temp.v('2', 'ID-1', 'ip-new-2')), false, 'still locked');
select is((select valid from pg_temp.v('1', 'ID-1', 'ip-new-3')), true, 'other collections are not locked');
reset role;
select is((select count(*)::int from public.audit_logs
           where action = 'membership.validation_lockout' and object_id = 'a7660000-0000-4000-8000-000000000002'),
  1, 'the lockout is written to the community''s audit log once');

insert into public.membership_validation_attempts (ip_hash, community_id, collection_id, outcome, attempted_at)
select extensions.digest('wide-' || n, 'sha256'), 'a7620000-0000-4000-8000-00000000000a', 'a7660000-0000-4000-8000-000000000001',
       'unknown_id', now() - interval '2 hours'
from generate_series(1, 1000) n;
set local role anon;
select is((select valid from pg_temp.v('1', 'ID-1', 'ip-new-4')), false,
  '1,000 failures across the community in a day lock its collections');
reset role;
delete from public.membership_validation_attempts where community_id = 'a7620000-0000-4000-8000-00000000000a'
  and ip_hash <> all (array[extensions.digest('ip-ok', 'sha256')]);
select is(app.purge_membership_validation_records(), 0, 'purge removes nothing younger than 30 days');

-- ── Grants stop with suspension, replacement and time ───────────────────────
set local role anon;
insert into tmp_tokens select 'amina', access_token from pg_temp.v('1', 'ID-2', 'ip-g');
select is(app.resolve_membership_access_grant('a7660000-0000-4000-8000-000000000001', (select token from tmp_tokens where label = 'amina')),
  'a7640000-0000-4000-8000-000000000002'::uuid, 'Amina holds a pass');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a7610000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select app.suspend_member('a7640000-0000-4000-8000-000000000002', 'review') $$, 'the owner suspends Amina');
set local role anon;
select is(app.resolve_membership_access_grant('a7660000-0000-4000-8000-000000000001', (select token from tmp_tokens where label = 'amina')),
  null, 'her pass stops at once');
select is((select valid from pg_temp.v('1', 'ID-2', 'ip-g')), false, 'and her ID no longer validates');

set local role authenticated;
select lives_ok($$ select app.reinstate_member('a7640000-0000-4000-8000-000000000002', null) $$, 'she is reinstated');
set local role anon;
select is((select valid from pg_temp.v('1', 'ID-2', 'ip-g')), true, 'her same ID validates again after reinstatement');

insert into tmp_tokens select 'gbenga', access_token from pg_temp.v('1', 'ID-1', 'ip-g');
set local role authenticated;
select lives_ok($$ select app.rotate_membership_id('a7640000-0000-4000-8000-000000000001', 'IDS/NNNN1', 'lost') $$,
  'the owner replaces Gbenga''s ID');
set local role anon;
select is(app.resolve_membership_access_grant('a7660000-0000-4000-8000-000000000001', (select token from tmp_tokens where label = 'gbenga')),
  null, 'a pass made with the old ID stops');
select is((select valid from pg_temp.v('1', 'ID-1', 'ip-g')), false, 'the old ID no longer validates');
insert into tmp_tokens select 'gbenga-new', access_token from pg_temp.v('1', 'ID-1-new', 'ip-g');
select is(app.resolve_membership_access_grant('a7660000-0000-4000-8000-000000000001', (select token from tmp_tokens where label = 'gbenga-new')),
  'a7640000-0000-4000-8000-000000000001'::uuid, 'the new ID validates and its pass works');

reset role;
update public.membership_access_grants set created_at = now() - interval '1 hour', expires_at = now() - interval '31 minutes'
where token_hash = extensions.digest((select token from tmp_tokens where label = 'gbenga-new'), 'sha256');
set local role anon;
select is(app.resolve_membership_access_grant('a7660000-0000-4000-8000-000000000001', (select token from tmp_tokens where label = 'gbenga-new')),
  null, 'an expired pass resolves to nobody');
select throws_like($$ select app.issue_membership_id('a7640000-0000-4000-8000-000000000006', 'IDS/ZZZZZ') $$,
  '%permission denied%', 'anon cannot issue IDs');
reset role;

select results_eq(
  $$ select (select count(*) from public.ledger_journals) - journals, (select count(*) from public.ledger_entries) - entries
     from tmp_ledger_before $$,
  $$ values (0::bigint, 0::bigint) $$, 'no ledger journal or entry was written');

select * from finish();
rollback;
