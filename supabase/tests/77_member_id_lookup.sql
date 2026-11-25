-- ─────────────────────────────────────────────────────────────────────────────
-- 77 — Member identification by membership ID (20261123130000, M9b3, Phase A-2)
--
--   · a valid ID (typed carelessly too) gives a pass; the confirmation summary
--     shows the full name and a MASKED email and phone, masked in SQL
--   · a missing email or phone is shown as null, never as an error
--   · unknown, revoked, suspended, archived and not-in-audience IDs all give
--     the same generic failure and therefore no summary
--   · a pass is worthless on another collection, after expiry, and the moment
--     the member is suspended (live re-check)
--   · "yes" (confirm) returns the member id and writes ONE masked audit row;
--     a bad token writes nothing
--   · no audit row holds a plaintext ID, a full email or a full phone
--   · anon and authenticated can no longer run app.find_collection_member
--     (owner decision D4); the mask helpers are not callable by clients
--   · the per-IP rate limit still holds before any summary can be reached
--   · the ledger is untouched
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(41);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a7710000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@m77.example.test', now());
insert into public.users (id, full_name, email, identity_level) values
  ('a7710000-0000-4000-8000-000000000001', 'M77 Owner', 'owner@m77.example.test', 'contact_verified')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a7720000-0000-4000-8000-00000000000a', 'm77-a', 'M77 Alpha', 'social_group', false, 'a7710000-0000-4000-8000-000000000001');
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a7720000-0000-4000-8000-00000000000a', 'a7710000-0000-4000-8000-000000000001', 'owner', 'M77 Owner', 'created');
insert into public.community_membership_id_settings (community_id, prefix, separator, suffix_length, enabled) values
  ('a7720000-0000-4000-8000-00000000000a', 'QAM', '/', 5, true);

insert into public.members (id, community_id, full_name, status, email, phone_e164, archived_at) values
  ('a7740000-0000-4000-8000-000000000001', 'a7720000-0000-4000-8000-00000000000a', 'Aisha Ibrahim', 'active',    'jaisha@gmail.com', '+2348012345567', null),
  ('a7740000-0000-4000-8000-000000000002', 'a7720000-0000-4000-8000-00000000000a', 'Bola Bello',    'unclaimed', null,               null,             null),
  ('a7740000-0000-4000-8000-000000000003', 'a7720000-0000-4000-8000-00000000000a', 'Chidi Okafor',  'active',    'chidi@example.co', '+447700900123',  null),
  ('a7740000-0000-4000-8000-000000000004', 'a7720000-0000-4000-8000-00000000000a', 'Dayo Archived', 'archived',  null,               null,             now()),
  ('a7740000-0000-4000-8000-000000000005', 'a7720000-0000-4000-8000-00000000000a', 'Efe Revoked',   'active',    null,               '+2348099999005', null),
  ('a7740000-0000-4000-8000-000000000006', 'a7720000-0000-4000-8000-00000000000a', 'Femi Suspend',  'active',    null,               '+2348099999006', null);

insert into public.membership_ids (community_id, member_id, membership_id, canonical_id, prefix, separator, last2)
select 'a7720000-0000-4000-8000-00000000000a'::uuid, m, id, app.canonical_membership_id(id), 'QAM', '/', right(id, 2)
from (values
  ('a7740000-0000-4000-8000-000000000001'::uuid, 'QAM/AAAA1'),
  ('a7740000-0000-4000-8000-000000000002', 'QAM/AAAA2'),
  ('a7740000-0000-4000-8000-000000000003', 'QAM/AAAA3'),
  ('a7740000-0000-4000-8000-000000000004', 'QAM/AAAA4'),
  ('a7740000-0000-4000-8000-000000000005', 'QAM/AAAA5'),
  ('a7740000-0000-4000-8000-000000000006', 'QAM/AAAA6')
) as t (m, id);

-- Aisha alone is in the group that collection 2 is for.
insert into public.member_groups (id, community_id, name, created_by) values
  ('a7750000-0000-4000-8000-000000000001', 'a7720000-0000-4000-8000-00000000000a', 'Committee', 'a7710000-0000-4000-8000-000000000001');
insert into public.member_group_memberships (group_id, member_id, added_by) values
  ('a7750000-0000-4000-8000-000000000001', 'a7740000-0000-4000-8000-000000000001', 'a7710000-0000-4000-8000-000000000001');

insert into public.collections (
  id, community_id, slug, name, category, participation_mode, amount_model,
  fixed_amount_kobo, status, visibility, created_by, published_at, published_by
) values
  ('a7760000-0000-4000-8000-000000000001', 'a7720000-0000-4000-8000-00000000000a', 'm77-dues', 'M77 Dues',
   'dues', 'managed', 'fixed', 500000, 'active', 'unlisted', 'a7710000-0000-4000-8000-000000000001', now(), 'a7710000-0000-4000-8000-000000000001'),
  ('a7760000-0000-4000-8000-000000000002', 'a7720000-0000-4000-8000-00000000000a', 'm77-committee', 'M77 Committee',
   'dues', 'managed', 'fixed', 300000, 'active', 'unlisted', 'a7710000-0000-4000-8000-000000000001', now(), 'a7710000-0000-4000-8000-000000000001');
update public.collections set audience_mode = 'groups' where id = 'a7760000-0000-4000-8000-000000000002';
insert into public.collection_audience_groups (collection_id, group_id, community_id, added_by) values
  ('a7760000-0000-4000-8000-000000000002', 'a7750000-0000-4000-8000-000000000001', 'a7720000-0000-4000-8000-00000000000a', 'a7710000-0000-4000-8000-000000000001');

-- An expired pass for Aisha on collection 1 (created 40 min ago, expired 15 min ago).
insert into public.membership_access_grants (token_hash, membership_id_id, member_id, collection_id, community_id, created_at, expires_at)
select extensions.digest(repeat('e', 64), 'sha256'), mi.id, mi.member_id, 'a7760000-0000-4000-8000-000000000001', mi.community_id,
       now() - interval '40 minutes', now() - interval '15 minutes'
from public.membership_ids mi where mi.member_id = 'a7740000-0000-4000-8000-000000000001';

create temp table tmp_ledger_before on commit drop as
  select (select count(*) from public.ledger_journals) as journals, (select count(*) from public.ledger_entries) as entries;
create temp table tmp_audit_before on commit drop as select count(*) as n from public.audit_logs;
create temp table tmp_tokens (label text primary key, token text) on commit drop;
create temp table tmp_fail (case_label text, valid boolean, token text, exp timestamptz) on commit drop;
grant select, insert on tmp_ledger_before, tmp_audit_before, tmp_tokens, tmp_fail to anon, authenticated;

create function pg_temp.v(p_col text, p_id text, p_ip text)
returns table (valid boolean, access_token text, expires_at timestamptz) language sql as $$
  select * from app.validate_membership_id(('a7760000-0000-4000-8000-00000000000' || p_col)::uuid, p_id,
    extensions.digest(p_ip, 'sha256')) $$;
grant execute on function pg_temp.v(text, text, text) to anon, authenticated;
create function pg_temp.tok(p_label text) returns text language sql as $$
  select token from tmp_tokens where label = p_label $$;
grant execute on function pg_temp.tok(text) to anon, authenticated;

-- ── Grants (D4) ─────────────────────────────────────────────────────────────
select ok(not has_function_privilege('anon', 'app.find_collection_member(uuid, text)', 'EXECUTE'),
  'anon can no longer search members by name, email or phone (D4)');
select ok(not has_function_privilege('authenticated', 'app.find_collection_member(uuid, text)', 'EXECUTE'),
  'authenticated cannot either');
select ok(has_function_privilege('anon', 'app.membership_pass_summary(uuid, text)', 'EXECUTE'),
  'anon can read a pass summary (the confirmation screen)');
select ok(has_function_privilege('anon', 'app.confirm_membership_pass(uuid, text)', 'EXECUTE'),
  'anon can confirm a pass');
select ok(not has_function_privilege('anon', 'app.mask_email(text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'app.mask_email(text)', 'EXECUTE'),
  'the email mask helper is internal');
select ok(not has_function_privilege('anon', 'app.mask_phone(text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'app.mask_phone(text)', 'EXECUTE'),
  'the phone mask helper is internal');

-- ── Masks ───────────────────────────────────────────────────────────────────
select is(app.mask_email('jaisha@gmail.com'), 'j•••@gmail.com', 'email: first character, fixed mask, domain');
select is(app.mask_phone('+2348012345567'), '+234 ••• ••• •567', 'Nigerian phone: +234 and the last three digits');
select is(app.mask_phone('+447700900123'), '+••• ••• •123', 'other phone: the last three digits only');
select ok(app.mask_email(null) is null and app.mask_phone(null) is null, 'missing email and phone mask to null');
select ok(app.mask_email('@nolocal.example') is null and app.mask_phone('+234') is null,
  'malformed values mask to null, never to a partial real value');

-- ── Valid ID → summary ──────────────────────────────────────────────────────
set local role anon;
insert into tmp_tokens select 'aisha', access_token from pg_temp.v('1', ' qam - aaaa1 ', 'ip-ok');
select ok(pg_temp.tok('aisha') ~ '^[0-9a-f]{64}$', 'a valid ID typed carelessly (case, spaces, separator) gives a pass');
select is((select full_name from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', pg_temp.tok('aisha'))),
  'Aisha Ibrahim', 'the summary shows the full name');
select is((select email_masked from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', pg_temp.tok('aisha'))),
  'j•••@gmail.com', 'the summary shows the masked email');
select is((select phone_masked from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', pg_temp.tok('aisha'))),
  '+234 ••• ••• •567', 'the summary shows the masked phone');
select ok((select s::text not like '%jaisha%' and s::text not like '%8012345567%' and s::text not ilike '%AAAA1%'
           from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', pg_temp.tok('aisha')) s),
  'the summary carries no full email, full phone or membership ID');

insert into tmp_tokens select 'bola', access_token from pg_temp.v('1', 'qam/aaaa2', 'ip-ok');
select is((select (full_name, email_masked, phone_masked)::text
           from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', pg_temp.tok('bola'))),
  '("Bola Bello",,)', 'a member with no email or phone on record: name only, contacts null (lower-case ID typed)');

-- ── Bad, expired and wrong-collection passes ────────────────────────────────
select is_empty($$ select * from app.membership_pass_summary('a7760000-0000-4000-8000-000000000002', pg_temp.tok('aisha')) $$,
  'a pass is worthless on another collection (even one the member is in)');
select is_empty($$ select * from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', repeat('0', 64)) $$,
  'an unknown token gives no summary');
select is_empty($$ select * from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', 'not-a-token') $$,
  'a malformed token gives no summary');
select is_empty($$ select * from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', null) $$,
  'a null token gives no summary');
select is_empty($$ select * from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', repeat('e', 64)) $$,
  'an expired pass gives no summary');
select is(app.confirm_membership_pass('a7760000-0000-4000-8000-000000000001', repeat('e', 64)), null,
  'an expired pass cannot be confirmed');

-- ── Ineligible IDs: the same generic failure ────────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"sub":"a7710000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$ select app.revoke_membership_id('a7740000-0000-4000-8000-000000000005', 'lost card') $$, 'the owner revokes Efe''s ID');
set local role anon;
insert into tmp_tokens select 'femi', access_token from pg_temp.v('1', 'QAM/AAAA6', 'ip-ok');
set local role authenticated;
select lives_ok($$ select app.suspend_member('a7740000-0000-4000-8000-000000000006', 'review') $$, 'the owner suspends Femi');
set local role anon;

insert into tmp_fail select 'unknown',         * from pg_temp.v('1', 'QAM/ZZZZ9', 'ip-f');
insert into tmp_fail select 'revoked',         * from pg_temp.v('1', 'QAM/AAAA5', 'ip-f');
insert into tmp_fail select 'suspended',       * from pg_temp.v('1', 'QAM/AAAA6', 'ip-f');
insert into tmp_fail select 'archived',        * from pg_temp.v('1', 'QAM/AAAA4', 'ip-f');
insert into tmp_fail select 'not in audience', * from pg_temp.v('2', 'QAM/AAAA3', 'ip-f');
select is((select count(*)::int from tmp_fail), 5, 'five ineligible cases were tried');
select is((select count(distinct (valid, token, exp))::int from tmp_fail), 1, 'all five answer identically');
select ok((select bool_and(valid = false and token is null and exp is null) from tmp_fail),
  'and that answer is (false, null, null): no pass, so no summary can be reached');

select is_empty($$ select * from app.membership_pass_summary('a7760000-0000-4000-8000-000000000001', pg_temp.tok('femi')) $$,
  'a pass taken before suspension stops at once: no summary (live re-check)');
select is(app.confirm_membership_pass('a7760000-0000-4000-8000-000000000001', pg_temp.tok('femi')), null,
  'and it cannot be confirmed');

-- ── Confirm ─────────────────────────────────────────────────────────────────
select is(app.confirm_membership_pass('a7760000-0000-4000-8000-000000000002', pg_temp.tok('aisha')), null,
  'confirming on the wrong collection gives nobody');
select is(app.confirm_membership_pass('a7760000-0000-4000-8000-000000000001', repeat('0', 64)), null,
  'confirming an unknown token gives nobody');
select is(app.confirm_membership_pass('a7760000-0000-4000-8000-000000000001', pg_temp.tok('aisha')),
  'a7740000-0000-4000-8000-000000000001'::uuid, '"yes" returns the member the pass stands for');

reset role;
select is((select count(*)::int from public.audit_logs where action = 'membership.identity_confirmed'
           and object_id = 'a7740000-0000-4000-8000-000000000001'), 1,
  'exactly one identity_confirmed audit row (failed confirms wrote none)');
select is((select after_state ->> 'masked' from public.audit_logs where action = 'membership.identity_confirmed'
           and object_id = 'a7740000-0000-4000-8000-000000000001'), 'QAM/…A1',
  'the audit row holds the masked ID');
select is((select actor_type::text from public.audit_logs where action = 'membership.identity_confirmed'
           and object_id = 'a7740000-0000-4000-8000-000000000001'), 'contributor',
  'recorded as a contributor action, with no user');
select is_empty($$
  select a.id from public.audit_logs a
  where a.created_at >= now() - interval '1 minute'
    and (a::text ilike '%AAAA%' or a::text ilike '%jaisha%' or a::text like '%8012345567%'
         or a::text like '%7700900123%' or a::text like '%8099999006%' or a::text like '%8099999005%')
  $$ ,
  'no audit row written here holds a plaintext ID, full email or full phone');

-- ── Rate limit still guards the summary ─────────────────────────────────────
set local role anon;
insert into tmp_fail select 'burst', v.* from generate_series(1, 10) g, lateral pg_temp.v('1', 'QAM/ZZZZ' || g, 'ip-burst') v;
select is((select valid from pg_temp.v('1', 'QAM/AAAA1', 'ip-burst')), false,
  'after 10 failures from one client, even a valid ID gives no pass (DB-held limit)');
select is((select valid from pg_temp.v('1', 'QAM/AAAA1', 'ip-other')), true,
  'another client is not affected');

reset role;
select is((select count(*) from public.ledger_journals), (select journals from tmp_ledger_before), 'no ledger journal written');
select is((select count(*) from public.ledger_entries), (select entries from tmp_ledger_before), 'no ledger entry written');

select * from finish();
rollback;
