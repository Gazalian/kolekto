-- ─────────────────────────────────────────────────────────────────────────────
-- 64 — A profile name change sends verified bank accounts back to review
--      (20261118100200; owner decision 2026-11-18, audit doc §14)
--
--   · case / spacing-only edits change nothing
--   · a real change moves every verified account to needs_review, clears the
--     default, leaves other states and other users alone, and is audited
--   · while in review: no new withdrawal to it, an approved withdrawal is not
--     claimed for transfer; after an operator approves, it is claimed
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(16);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a6410000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@rr.example.test', now()),
  ('a6410000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@rr.example.test', now());
insert into public.users (id, full_name, email) values
  ('a6410000-0000-4000-8000-000000000001', 'Adaeze Okafor', 'owner@rr.example.test'),
  ('a6410000-0000-4000-8000-000000000002', 'Tunde Bello',   'other@rr.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a6420000-0000-4000-8000-00000000000a', 'rr-tests', 'Re-review Tests', 'social_group', false, 'a6410000-0000-4000-8000-000000000001');
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values ('a6450000-0000-4000-8000-000000000001', 'a6420000-0000-4000-8000-00000000000a', 'rr-a', 'Dues',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6410000-0000-4000-8000-000000000001');
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a6420000-0000-4000-8000-00000000000a', 'a6410000-0000-4000-8000-000000000001', 'owner', 'Adaeze Okafor', 'created', null),
  ('a6420000-0000-4000-8000-00000000000a', 'a6410000-0000-4000-8000-000000000002', 'admin', 'Tunde Bello',   'invited', null);
-- The owner designated the admin as second approver for the owner's own
-- requests (20261120100000: nobody approves their own withdrawal).
insert into public.community_withdrawal_approvers (community_id, user_id, designated_by) values
  ('a6420000-0000-4000-8000-00000000000a', 'a6410000-0000-4000-8000-000000000002', 'a6410000-0000-4000-8000-000000000001');

-- ₦100,000 available (test-only funding against the Paystack balance).
select app.post_ledger_journal(
  'a6420000-0000-4000-8000-00000000000a', 'a6450000-0000-4000-8000-000000000001', now(), 'adjustment',
  'a6450000-0000-4000-8000-000000000001', 'test fixture funding', 'test-fund-rr',
  jsonb_build_array(
    jsonb_build_object('account_id', app.ensure_ledger_account(null, null, 'provider_receivable'), 'direction', 'debit', 'amount_kobo', 10000000),
    jsonb_build_object('account_id', app.ensure_ledger_account('a6420000-0000-4000-8000-00000000000a', 'a6450000-0000-4000-8000-000000000001', 'collection_available'),
                       'direction', 'credit', 'amount_kobo', 10000000)),
  'system', null);

create temporary table tmp_b (label text primary key, id uuid) on commit drop;
grant select on tmp_b to authenticated;
insert into tmp_b select 'first', bank_account_id from app.register_bank_account(
  'a6410000-0000-4000-8000-000000000001', '058', 'Guaranty Trust Bank', '0123456781', 'OKAFOR ADAEZE', 'Adaeze Okafor', true);
insert into tmp_b select 'second', bank_account_id from app.register_bank_account(
  'a6410000-0000-4000-8000-000000000001', '044', 'Access Bank', '0123456782', 'OKAFOR ADAEZE', 'Adaeze Okafor', true);
insert into tmp_b select 'mismatch', bank_account_id from app.register_bank_account(
  'a6410000-0000-4000-8000-000000000001', '057', 'Zenith Bank', '0123456783', 'SOMEONE ELSE', 'Adaeze Okafor', false);
insert into tmp_b select 'other', bank_account_id from app.register_bank_account(
  'a6410000-0000-4000-8000-000000000002', '058', 'Guaranty Trust Bank', '0123456784', 'BELLO TUNDE', 'Tunde Bello', true);

create function pg_temp.st(p_label text) returns text language sql as $$
  select b.status || ':' || b.is_default from public.user_bank_accounts b where b.id = (select id from tmp_b where label = p_label)
$$;

-- An approved withdrawal to the first account, waiting to be claimed:
-- requested, confirmed with the member's code, approved by the designated
-- second approver (the owner requested it for themself)
-- (owner decisions 2026-11-19; the code delivery is played by hand).
create temporary table tmp_w (id uuid) on commit drop;
grant select, insert on tmp_w to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6410000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into tmp_w select withdrawal_id from app.request_withdrawal_to_account('a6450000-0000-4000-8000-000000000001', 5000000,
            (select id from tmp_b where label = 'first'), 'rr-withdrawal-1');
select is((select status::text || ':' || stage from app.collection_withdrawals('a6450000-0000-4000-8000-000000000001') where id = (select id from tmp_w)),
  'requested:awaiting_member_verification',
  'the owner''s withdrawal to their verified account starts requested');
reset role;
create temporary table tmp_c on commit drop as select challenge_id from app.claim_withdrawal_otp_deliveries(10);
select app.record_withdrawal_otp_issued(challenge_id, encode(sha256(convert_to('rr:' || challenge_id, 'UTF8')), 'hex')) from tmp_c;
grant select on tmp_c to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6410000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select v.outcome from tmp_c c, tmp_w w,
             lateral app.verify_withdrawal_otp(w.id, c.challenge_id, encode(sha256(convert_to('rr:' || c.challenge_id, 'UTF8')), 'hex')) v),
  'verified', 'the requester confirms with the code');
set local request.jwt.claims = '{"sub":"a6410000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select app.decide_withdrawal(id, 'approve')::text from tmp_w), 'approved', 'the designated second approver approves it');
reset role;

select is(pg_temp.st('first') || ',' || pg_temp.st('second') || ',' || pg_temp.st('mismatch'),
  'verified:true,verified:false,needs_review:false', 'fixtures: two verified accounts (one default) and one in review');

-- ── Spacing / case only: nothing changes ────────────────────────────────────

update public.users set full_name = '  adaeze   OKAFOR ' where id = 'a6410000-0000-4000-8000-000000000001';
select is(pg_temp.st('first') || ',' || pg_temp.st('second'), 'verified:true,verified:false',
  'a case or spacing edit of the same name leaves the accounts verified');

-- ── A real change ───────────────────────────────────────────────────────────

update public.users set full_name = 'Chioma Eze' where id = 'a6410000-0000-4000-8000-000000000001';
select is(pg_temp.st('first') || ',' || pg_temp.st('second'), 'needs_review:false,needs_review:false',
  'a name change sends every verified account back to review and clears the default');
select is(pg_temp.st('mismatch'), 'needs_review:false', 'an account already in review stays in review');
select is(pg_temp.st('other'), 'verified:true', 'another user''s accounts are untouched');
select is((select count(*)::integer from public.audit_logs
           where action = 'bank_account.rereview'
             and object_id in (select id from tmp_b where label in ('first', 'second'))), 2,
  'each account moved to review is audited');
select is((select count(*)::integer from public.audit_logs
           where action = 'bank_account.rereview' and object_id in (select id from tmp_b)
             and (after_state::text like '%0123456781%' or after_state::text like '%Okafor%' or after_state::text like '%Chioma%')), 0,
  'the audit carries the last four digits only — no full number, no names');

-- ── While in review ─────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6410000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(format($$ select * from app.request_withdrawal_to_account('a6450000-0000-4000-8000-000000000001', 100000, %L, 'rr-withdrawal-2') $$,
                        (select id from tmp_b where label = 'second')),
  'P0001', null, 'no new withdrawal can go to an account in review');
reset role;
select is(has_function_privilege('authenticated', 'app.rereview_bank_accounts_on_name_change()', 'execute'), false,
  'clients cannot execute the re-review function');

select is((select count(*)::integer from app.claim_withdrawal_transfers(10)), 0,
  'the approved withdrawal is not sent while its account is in review');
select is((select status::text from public.withdrawals where reference = (
             select reference from public.withdrawals where collection_id = 'a6450000-0000-4000-8000-000000000001')),
  'approved', 'and it keeps its hold, waiting for the review');

-- ── Approved again ──────────────────────────────────────────────────────────

select is(app.review_bank_account((select id from tmp_b where label = 'first'), 'approve', 'Ops Reviewer',
                                  'Checked the new name against the bank'),
  'verified', 'an operator approves the account again');
select is((select count(*)::integer from app.claim_withdrawal_transfers(10)), 1,
  'then the waiting withdrawal is claimed for transfer');

select * from finish();
rollback;
