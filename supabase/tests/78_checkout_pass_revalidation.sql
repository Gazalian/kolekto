-- ─────────────────────────────────────────────────────────────────────────────
-- 78 — M10: checkout re-validates the membership pass
--
-- Coverage for 20261125100000_m10_checkout_pass_revalidation.sql. On a managed
-- collection app.create_payment_attempt must, by itself:
--
--   · refuse a missing, malformed, unknown, expired, revoked or other-
--     collection pass (MEMBER_PROOF_EXPIRED, one wording, no ids)
--   · refuse a live pass for a different member than the contributor session
--     (MEMBER_PROOF_MISMATCH, no ids)
--   · see a membership ID revoked or rotated after the pass was issued, and a
--     member suspended, archived or removed from the audience
--   · write only the pass-resolved member, and nothing at all when it refuses
--   · keep idempotency: the same key and member returns the same attempt; the
--     same key under another member is refused
-- and on an open collection keep today's behaviour, refusing a stray token.
--
-- Runs as the database owner (session role `none`), which is how the server's
-- owner connection reaches these functions. Officer actions switch to the
-- owner's authenticated session and back.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(44);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('a7810000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@m78.example.test');
insert into public.users (id, full_name, email) values
  ('a7810000-0000-4000-8000-000000000001', 'M78 Owner', 'owner@m78.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a7820000-0000-4000-8000-00000000000a', 'm78-club', 'M78 Club', 'social_group', false, 'a7810000-0000-4000-8000-000000000001');
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a7820000-0000-4000-8000-00000000000a', 'a7810000-0000-4000-8000-000000000001', 'owner', 'M78 Owner', 'created');
insert into public.community_membership_id_settings (community_id, prefix, separator, suffix_length, enabled) values
  ('a7820000-0000-4000-8000-00000000000a', 'MTE', '/', 5, true);

insert into public.members (id, community_id, full_name, phone_e164, status, joined_via) values
  ('a7840000-0000-4000-8000-000000000001', 'a7820000-0000-4000-8000-00000000000a', 'Ada Valid',     '+2348097780001', 'active', 'manual'),
  ('a7840000-0000-4000-8000-000000000002', 'a7820000-0000-4000-8000-00000000000a', 'Bola Other',    '+2348097780002', 'active', 'manual'),
  ('a7840000-0000-4000-8000-000000000003', 'a7820000-0000-4000-8000-00000000000a', 'Chidi Suspend', '+2348097780003', 'active', 'manual'),
  ('a7840000-0000-4000-8000-000000000004', 'a7820000-0000-4000-8000-00000000000a', 'Dayo Archive',  '+2348097780004', 'active', 'manual'),
  ('a7840000-0000-4000-8000-000000000005', 'a7820000-0000-4000-8000-00000000000a', 'Efe Revoke',    '+2348097780005', 'active', 'manual'),
  ('a7840000-0000-4000-8000-000000000006', 'a7820000-0000-4000-8000-00000000000a', 'Femi Rotate',   '+2348097780006', 'active', 'manual'),
  ('a7840000-0000-4000-8000-000000000007', 'a7820000-0000-4000-8000-00000000000a', 'Gina Group',    '+2348097780007', 'active', 'manual');

insert into public.membership_ids (community_id, member_id, membership_id, canonical_id, prefix, separator, last2)
select 'a7820000-0000-4000-8000-00000000000a'::uuid, m, id, app.canonical_membership_id(id), 'MTE', '/', right(id, 2)
from (values
  ('a7840000-0000-4000-8000-000000000001'::uuid, 'MTE/AAAA1'),
  ('a7840000-0000-4000-8000-000000000002', 'MTE/AAAA2'),
  ('a7840000-0000-4000-8000-000000000003', 'MTE/AAAA3'),
  ('a7840000-0000-4000-8000-000000000004', 'MTE/AAAA4'),
  ('a7840000-0000-4000-8000-000000000005', 'MTE/AAAA5'),
  ('a7840000-0000-4000-8000-000000000006', 'MTE/AAAA6'),
  ('a7840000-0000-4000-8000-000000000007', 'MTE/AAAA7')
) as t (m, id);

insert into public.member_groups (id, community_id, name, created_by) values
  ('a7850000-0000-4000-8000-000000000001', 'a7820000-0000-4000-8000-00000000000a', 'Committee', 'a7810000-0000-4000-8000-000000000001');
insert into public.member_group_memberships (group_id, member_id, added_by) values
  ('a7850000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000007', 'a7810000-0000-4000-8000-000000000001');

-- Two managed ₦5,000 dues (all members, no obligations, so several attempts per
-- member are allowed), one managed group collection, one open pot.
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo,
   min_amount_kobo, max_amount_kobo, target_amount_kobo, deadline_at, status, visibility, fee_mode,
   collect_attendee_details, close_when_target_reached, created_by)
values
  ('a7860000-0000-4000-8000-000000000001', 'a7820000-0000-4000-8000-00000000000a', 'm78-dues', 'M78 Dues',
   'dues', 'managed', 'fixed', 500000, null, null, null, null, 'active', 'unlisted', 'community_absorbs',
   false, false, 'a7810000-0000-4000-8000-000000000001'),
  ('a7860000-0000-4000-8000-000000000002', 'a7820000-0000-4000-8000-00000000000a', 'm78-levy', 'M78 Levy',
   'dues', 'managed', 'fixed', 500000, null, null, null, null, 'active', 'unlisted', 'community_absorbs',
   false, false, 'a7810000-0000-4000-8000-000000000001'),
  ('a7860000-0000-4000-8000-000000000003', 'a7820000-0000-4000-8000-00000000000a', 'm78-committee', 'M78 Committee',
   'dues', 'managed', 'fixed', 500000, null, null, null, null, 'active', 'unlisted', 'community_absorbs',
   false, false, 'a7810000-0000-4000-8000-000000000001'),
  ('a7860000-0000-4000-8000-000000000004', 'a7820000-0000-4000-8000-00000000000a', 'm78-pot', 'M78 Pot',
   'contribution', 'open', 'open_amount', null, 10000, null, null, null, 'active', 'public', 'community_absorbs',
   false, false, 'a7810000-0000-4000-8000-000000000001');
update public.collections set audience_mode = 'groups' where id = 'a7860000-0000-4000-8000-000000000003';
insert into public.collection_audience_groups (collection_id, group_id, community_id, added_by) values
  ('a7860000-0000-4000-8000-000000000003', 'a7850000-0000-4000-8000-000000000001', 'a7820000-0000-4000-8000-00000000000a', 'a7810000-0000-4000-8000-000000000001');

-- ── Helpers ─────────────────────────────────────────────────────────────────

create temporary table tmp_tok (label text primary key, token text);

-- A grant as app.validate_membership_id writes it; optionally already old.
create function pg_temp.issue_pass(p_label text, p_collection uuid, p_member uuid, p_age interval default '0 minutes')
returns text language plpgsql as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into public.membership_access_grants (token_hash, membership_id_id, member_id, collection_id, community_id, created_at, expires_at)
  select extensions.digest(v_token, 'sha256'), mi.id, mi.member_id, p_collection, mi.community_id,
         now() - p_age, now() - p_age + interval '30 minutes'
  from public.membership_ids mi where mi.member_id = p_member and mi.revoked_at is null;
  insert into tmp_tok values (p_label, v_token);
  return v_token;
end;
$$;

create function pg_temp.tok(p_label text) returns text language sql as $$
  select token from tmp_tok where label = p_label
$$;

-- ₦5,000 managed dues, host absorbs: 0.5% + 1.5% = ₦100; estimate 1% = ₦50.
create function pg_temp.dues(p_collection uuid, p_key text, p_ref integer, p_member uuid, p_token text)
returns uuid language sql as $$
  select attempt_id from app.create_payment_attempt(
    p_collection, 'checkout-key-m78-' || p_key, 'KLK-' || lpad(p_ref::text, 26, '0'), 'fake', p_member,
    'Test Payer', 'payer@m78.example.test', '+2348000000078', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000,
    'community_absorbs', '2026-11-founder', p_token)
$$;

-- ₦10,000 open pot, host absorbs.
create function pg_temp.pot(p_key text, p_ref integer, p_member uuid, p_token text)
returns uuid language sql as $$
  select attempt_id from app.create_payment_attempt(
    'a7860000-0000-4000-8000-000000000004', 'checkout-key-m78-' || p_key, 'KLK-' || lpad(p_ref::text, 26, '0'), 'fake', p_member,
    'Test Payer', 'payer@m78.example.test', '+2348000000078', '{}'::jsonb, '{}'::text[],
    null, 1000000, 1000000, 5000, 15000, 0, 20000, 1000000, 980000, 10000,
    'community_absorbs', '2026-11-founder', p_token)
$$;

create function pg_temp.rows_written() returns bigint language sql as $$
  select (select count(*) from public.contribution_intents where community_id = 'a7820000-0000-4000-8000-00000000000a')
       + (select count(*) from public.payment_attempts where community_id = 'a7820000-0000-4000-8000-00000000000a')
$$;

create temporary table tmp_money_before as
  select (select count(*) from public.contributions) as contributions,
         (select count(*) from public.ledger_journals) as journals,
         (select count(*) from public.ledger_entries) as entries;

do $$ begin perform pg_temp.issue_pass('ada-dues',  'a7860000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000001'); end $$;
do $$ begin perform pg_temp.issue_pass('ada-dues-2','a7860000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000001'); end $$;
do $$ begin perform pg_temp.issue_pass('ada-levy',  'a7860000-0000-4000-8000-000000000002', 'a7840000-0000-4000-8000-000000000001'); end $$;
do $$ begin perform pg_temp.issue_pass('bola-dues', 'a7860000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000002'); end $$;
do $$ begin perform pg_temp.issue_pass('ada-old',   'a7860000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000001', '29 minutes 59 seconds'); end $$;
do $$ begin perform pg_temp.issue_pass('ada-revoked-grant', 'a7860000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000001'); end $$;
do $$ begin perform pg_temp.issue_pass('chidi', 'a7860000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000003'); end $$;
do $$ begin perform pg_temp.issue_pass('dayo',  'a7860000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000004'); end $$;
do $$ begin perform pg_temp.issue_pass('efe',   'a7860000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000005'); end $$;
do $$ begin perform pg_temp.issue_pass('femi',  'a7860000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000006'); end $$;
do $$ begin perform pg_temp.issue_pass('gina',  'a7860000-0000-4000-8000-000000000003', 'a7840000-0000-4000-8000-000000000007'); end $$;

-- Expired: issued 40 minutes ago, ran out 10 minutes ago.
insert into public.membership_access_grants (token_hash, membership_id_id, member_id, collection_id, community_id, created_at, expires_at)
select extensions.digest(repeat('e', 64), 'sha256'), mi.id, mi.member_id, 'a7860000-0000-4000-8000-000000000001', mi.community_id,
       now() - interval '40 minutes', now() - interval '10 minutes'
from public.membership_ids mi where mi.member_id = 'a7840000-0000-4000-8000-000000000001';
insert into tmp_tok values ('ada-expired', repeat('e', 64));

update public.membership_access_grants set revoked_at = now()
where token_hash = extensions.digest(pg_temp.tok('ada-revoked-grant'), 'sha256');


-- ── The function itself ─────────────────────────────────────────────────────

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'create_payment_attempt'),
  1, 'exactly one app.create_payment_attempt exists: the 22-argument overload is gone'
);

select is(
  (select p.pronargs::int || '/' || p.pronargdefaults::int || '/' || format_type(p.proargtypes[22], null)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'create_payment_attempt'),
  '23/1/text', 'it takes 23 arguments, the last (p_access_token text) defaulting to null'
);

select ok(
  (select p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'create_payment_attempt'),
  'it is still SECURITY DEFINER with an empty search_path'
);

select ok(
  (select not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not has_function_privilege('public', p.oid, 'EXECUTE')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'create_payment_attempt'),
  'no client role (anon, authenticated, PUBLIC) can execute it'
);


-- ── A valid pass ────────────────────────────────────────────────────────────

create temporary table tmp_ok as
  select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'ok-1', 7801, 'a7840000-0000-4000-8000-000000000001',
                      pg_temp.tok('ada-dues')) as id;

select is(
  (select member_id from public.payment_attempts where id = (select id from tmp_ok)),
  'a7840000-0000-4000-8000-000000000001'::uuid,
  'a live pass for the session''s member on this collection creates the attempt, attributed to that member'
);

select is(
  (select i.member_id from public.contribution_intents i join public.payment_attempts a on a.intent_id = i.id
   where a.id = (select id from tmp_ok)),
  'a7840000-0000-4000-8000-000000000001'::uuid,
  'and the intent carries the same pass-resolved member'
);

select is(
  pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'ok-1', 7801, 'a7840000-0000-4000-8000-000000000001',
               pg_temp.tok('ada-dues')),
  (select id from tmp_ok),
  'a double-click (same key, same pass) returns the same attempt'
);

select is(
  pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'ok-1', 7801, 'a7840000-0000-4000-8000-000000000001',
               pg_temp.tok('ada-dues-2')),
  (select id from tmp_ok),
  'a retry under a fresh pass for the same member returns the same attempt (passes are not single-use)'
);

select is(
  pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'ok-old', 7802, 'a7840000-0000-4000-8000-000000000001',
               pg_temp.tok('ada-old')) is not null,
  true, 'a pass one second short of its 30 minutes still works'
);

select is(
  (select count(*)::int from public.membership_access_grants
   where token_hash = extensions.digest(pg_temp.tok('ada-dues'), 'sha256') and revoked_at is null),
  1, 'checkout does not consume or revoke the grant'
);


-- ── Refused proofs: nothing written ─────────────────────────────────────────

create temporary table tmp_rows as select pg_temp.rows_written() as n;

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'no-pass', 7810, 'a7840000-0000-4000-8000-000000000001', null) $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'no pass: refused with the generic code and no ids'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'bad-pass', 7811, 'a7840000-0000-4000-8000-000000000001', 'not-a-token') $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'a malformed token is refused the same way'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'unknown', 7812, 'a7840000-0000-4000-8000-000000000001', repeat('0', 64)) $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'a well-formed token that was never issued is refused the same way'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'upper', 7813, 'a7840000-0000-4000-8000-000000000001',
                         upper(pg_temp.tok('ada-dues'))) $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'the token is matched exactly by its SHA-256: an upper-cased copy of a live token is not normalised into it'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'expired', 7814, 'a7840000-0000-4000-8000-000000000001',
                         pg_temp.tok('ada-expired')) $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'an expired pass is refused'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'revoked', 7815, 'a7840000-0000-4000-8000-000000000001',
                         pg_temp.tok('ada-revoked-grant')) $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'a revoked grant is refused'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'other-col', 7816, 'a7840000-0000-4000-8000-000000000001',
                         pg_temp.tok('ada-levy')) $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'the same member''s pass for another collection is refused'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'mismatch', 7817, 'a7840000-0000-4000-8000-000000000001',
                         pg_temp.tok('bola-dues')) $$,
  'P0001', 'MEMBER_PROOF_MISMATCH: the membership pass and the contributor session name different members',
  'a live pass for Bola under Ada''s session is refused, with no ids in the message'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'mismatch-2', 7818, 'a7840000-0000-4000-8000-000000000002',
                         pg_temp.tok('ada-dues')) $$,
  'P0001', 'MEMBER_PROOF_MISMATCH: the membership pass and the contributor session name different members',
  'and Ada''s pass under Bola''s session: the session cannot borrow another member''s pass'
);

select throws_like(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'ok-1', 7819, 'a7840000-0000-4000-8000-000000000002',
                         pg_temp.tok('bola-dues')) $$,
  'CHECKOUT_KEY_REUSED:%',
  'Ada''s checkout key under Bola''s valid pass and session is refused, never a second attempt'
);

select throws_like(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'no-member', 7820, null, pg_temp.tok('ada-dues')) $$,
  'MEMBER_REQUIRED:%',
  'a pass without a session member is still MEMBER_REQUIRED (unchanged)'
);

select is(pg_temp.rows_written(), (select n from tmp_rows), 'no refused proof wrote an intent or an attempt');


-- ── Officer actions after the pass was issued ───────────────────────────────

select is(app.resolve_membership_access_grant('a7860000-0000-4000-8000-000000000001', pg_temp.tok('efe')),
  'a7840000-0000-4000-8000-000000000005'::uuid, 'Efe holds a live pass');
select is(app.resolve_membership_access_grant('a7860000-0000-4000-8000-000000000001', pg_temp.tok('femi')),
  'a7840000-0000-4000-8000-000000000006'::uuid, 'Femi holds a live pass');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a7810000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$ select app.revoke_membership_id('a7840000-0000-4000-8000-000000000005', 'lost card') $$, 'the owner revokes Efe''s ID');
select lives_ok($$ select app.rotate_membership_id('a7840000-0000-4000-8000-000000000006', 'MTE/NNNN6', 'replaced') $$, 'the owner replaces Femi''s ID');
select lives_ok($$ select app.suspend_member('a7840000-0000-4000-8000-000000000003', 'review') $$, 'the owner suspends Chidi');
select lives_ok($$ select app.archive_member('a7840000-0000-4000-8000-000000000004', 'left') $$, 'the owner archives Dayo');
select lives_ok($$ select app.remove_member_from_group('a7850000-0000-4000-8000-000000000001', 'a7840000-0000-4000-8000-000000000007') $$,
  'the owner removes Gina from the committee');
reset role;

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'efe', 7830, 'a7840000-0000-4000-8000-000000000005', pg_temp.tok('efe')) $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'a pass issued before the membership ID was revoked stops at checkout'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'femi', 7831, 'a7840000-0000-4000-8000-000000000006', pg_temp.tok('femi')) $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'a pass issued under a replaced membership ID stops at checkout'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'chidi', 7832, 'a7840000-0000-4000-8000-000000000003', pg_temp.tok('chidi')) $$,
  'P0001', 'MEMBER_NOT_ELIGIBLE: member cannot contribute to this collection',
  'a suspended member is refused by the eligibility check first (D3), with no ids in the message'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000001', 'dayo', 7833, 'a7840000-0000-4000-8000-000000000004', pg_temp.tok('dayo')) $$,
  'P0001', 'MEMBER_NOT_ELIGIBLE: member cannot contribute to this collection',
  'an archived member is refused'
);

select throws_ok(
  $$ select pg_temp.dues('a7860000-0000-4000-8000-000000000003', 'gina', 7834, 'a7840000-0000-4000-8000-000000000007', pg_temp.tok('gina')) $$,
  'P0001', 'MEMBER_NOT_ELIGIBLE: member cannot contribute to this collection',
  'a member removed from the collection''s audience is refused'
);

select is(app.resolve_membership_access_grant('a7860000-0000-4000-8000-000000000001', pg_temp.tok('chidi')),
  null::uuid, 'the suspended member''s pass no longer resolves either (belt and braces)');

select is(pg_temp.rows_written(), (select n from tmp_rows), 'still no intent or attempt written by any refusal');


-- ── Open collection: unchanged, and a stray token is refused ────────────────

select is(
  (select member_id from public.payment_attempts
   where id = pg_temp.pot('pot-1', 7840, null, null)),
  null::uuid,
  'an open collection still takes a payment with no member and no pass'
);

select throws_like(
  $$ select pg_temp.pot('pot-2', 7841, null, pg_temp.tok('ada-dues')) $$,
  'MEMBER_NOT_EXPECTED:%',
  'a membership pass on an open collection is refused'
);

select throws_like(
  $$ select pg_temp.pot('pot-3', 7842, 'a7840000-0000-4000-8000-000000000001', null) $$,
  'MEMBER_NOT_EXPECTED:%',
  'a member id on an open collection is still refused (unchanged)'
);

select throws_like(
  $$ select pg_temp.pot('pot-4', 7843, 'a7840000-0000-4000-8000-000000000001', pg_temp.tok('ada-dues')) $$,
  'MEMBER_NOT_EXPECTED:%',
  'and so are both together'
);


-- ── No money moved ──────────────────────────────────────────────────────────

select is((select count(*) from public.contributions), (select contributions from tmp_money_before),
  'no contribution was written by any checkout in this file');
select is((select count(*) from public.ledger_journals), (select journals from tmp_money_before),
  'no ledger journal was written');
select is((select count(*) from public.ledger_entries), (select entries from tmp_money_before),
  'no ledger entry was written');

select is(
  (select count(*)::int from public.payment_attempts where community_id = 'a7820000-0000-4000-8000-00000000000a'),
  3, 'exactly three attempts exist: Ada''s dues, Ada''s near-expiry pass, and the open pot'
);

select * from finish();
rollback;
