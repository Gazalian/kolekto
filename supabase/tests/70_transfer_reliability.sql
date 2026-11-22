-- ─────────────────────────────────────────────────────────────────────────────
-- 70 — Transfer reliability: leases, backoff, escalation, release rules,
--      Paystack server approval, reconciliation report
--      (20261119120000; PA-08 P8-1, P8-2, P8-4; PA-09; owner decisions 2026-11-19)
--
--   · P8-2: claims are leases with a token; a stale token changes nothing
--   · PA-09: immediate, 2, 5, 10, 30 min, 1 h, 2 h, 4 h, then capped at 6 h;
--     every check is logged; escalation after the policy limits never
--     releases funds and never allows a re-send
--   · P8-1: one NOT FOUND never releases; a never-sent row may be released;
--     a refusal needs repeated NOT FOUND over at least 30 minutes; a
--     duplicate-reference refusal, a transfer code or a Paystack approval
--     request never release
--   · approval URL: every reason to say no, deterministic duplicates, log
--   · reconciliation: Kolekto rows, a recorded run, resolution, append-only
--   · 2026-11-20 (20261120100000): the approval URL also checks NGN currency,
--     Paystack's transfer code, records a parser refusal (payload_…), refuses
--     a self-approval, an approval without a valid basis and a paid withdrawal.
--     The owner's own requests here are approved by a designated admin.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(92);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a7710000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@rel.example.test', now());
insert into public.users (id, full_name, email) values
  ('a7710000-0000-4000-8000-000000000001', 'Amaka Obi', 'owner@rel.example.test')
on conflict (id) do update set full_name = excluded.full_name;
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a7720000-0000-4000-8000-00000000000a', 'rel-tests', 'Reliability Tests', 'social_group', false, 'a7710000-0000-4000-8000-000000000001');
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values ('a7750000-0000-4000-8000-000000000001', 'a7720000-0000-4000-8000-00000000000a', 'rel-a', 'Project Fund',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a7710000-0000-4000-8000-000000000001');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a7710000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@rel.example.test', now());
insert into public.users (id, full_name, email) values
  ('a7710000-0000-4000-8000-000000000002', 'Second Approver', 'admin@rel.example.test')
on conflict (id) do update set full_name = excluded.full_name;
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a7720000-0000-4000-8000-00000000000a', 'a7710000-0000-4000-8000-000000000001', 'owner', 'Amaka Obi', 'created', null),
  ('a7720000-0000-4000-8000-00000000000a', 'a7710000-0000-4000-8000-000000000002', 'admin', 'Second Approver', 'invited', null);
-- The owner designated the admin as second approver (fixture; the function is proved in 69).
insert into public.community_withdrawal_approvers (community_id, user_id, designated_by) values
  ('a7720000-0000-4000-8000-00000000000a', 'a7710000-0000-4000-8000-000000000002', 'a7710000-0000-4000-8000-000000000001');

create temporary table tmp_b (label text primary key, id uuid);
create temporary table tmp_t (label text primary key, withdrawal_id uuid, ref text, token uuid);
create temporary table tmp_n (label text primary key, n bigint);
grant all on tmp_b, tmp_t, tmp_n to authenticated;

insert into tmp_b select 'O', bank_account_id from app.register_bank_account(
  'a7710000-0000-4000-8000-000000000001', '058', 'GTBank', '0123477001', 'OBI AMAKA', 'Amaka Obi', true);
select app.set_bank_account_recipient((select id from tmp_b where label = 'O'), 'RCP_relowner01');

select app.post_ledger_journal(
  'a7720000-0000-4000-8000-00000000000a', 'a7750000-0000-4000-8000-000000000001', now(), 'adjustment',
  'a7750000-0000-4000-8000-000000000001', 'test fixture funding', 'test-fund-rel',
  jsonb_build_array(
    jsonb_build_object('account_id', app.ensure_ledger_account(null, null, 'provider_settled_funds'), 'direction', 'debit', 'amount_kobo', 10000000),
    jsonb_build_object('account_id', app.ensure_ledger_account('a7720000-0000-4000-8000-00000000000a', 'a7750000-0000-4000-8000-000000000001', 'collection_available'),
                       'direction', 'credit', 'amount_kobo', 10000000)),
  'system', null);

create function pg_temp.pos() returns text language sql as $$
  select available_kobo || ':' || withdrawing_kobo || ':' || withdrawn_kobo
  from public.v_collection_position where collection_id = 'a7750000-0000-4000-8000-000000000001'
$$;

-- A withdrawal with both approvals, claimed for transfer: request (owner for
-- themself), code issued and verified, the designated second approver
-- approves (nobody approves their own request), worker claims.
create function pg_temp.ready(p_label text, p_amount bigint) returns void language plpgsql as $$
declare
  v_w uuid;
  v_c uuid;
  v_h text;
  r   record;
begin
  perform set_config('request.jwt.claims', '{"sub":"a7710000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  perform set_config('role', 'authenticated', true);
  select withdrawal_id into v_w from app.request_withdrawal_to_account(
    'a7750000-0000-4000-8000-000000000001', p_amount, (select id from tmp_b where label = 'O'), 'rel-key-' || p_label);
  perform set_config('role', 'none', true);
  select challenge_id into v_c from app.claim_withdrawal_otp_deliveries(1);
  v_h := encode(sha256(convert_to('good:' || v_c, 'UTF8')), 'hex');
  perform app.record_withdrawal_otp_issued(v_c, v_h);
  perform app.record_withdrawal_otp_delivery(v_c, true, null);
  perform set_config('role', 'authenticated', true);
  perform app.verify_withdrawal_otp(v_w, v_c, v_h);
  perform set_config('request.jwt.claims', '{"sub":"a7710000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  perform app.decide_withdrawal(v_w, 'approve');
  perform set_config('role', 'none', true);
  select * into r from app.claim_withdrawal_transfers(1, 'dispatch-test');
  insert into tmp_t values (p_label, v_w, r.transfer_reference, r.claim_token);
end;
$$;

-- The approval URL as the route calls it for a consistent Paystack payload:
-- currency NGN, Paystack's transfer code (Kolekto's when it has one), no parser refusal.
create function pg_temp.dta(p_ref text, p_amount bigint, p_recipient text, p_signature text)
returns table (decision text, reason_code text) language sql as $$
  select * from app.decide_transfer_approval(p_ref, p_amount, p_recipient, p_signature, 'NGN',
    coalesce((select transfer_code from public.withdrawal_transfers where reference = p_ref), 'TRF_reltest0001'), null)
$$;

-- Time passes: the row is due for its next check.
create function pg_temp.due(p_label text) returns void language sql as $$
  update public.withdrawal_transfers set next_check_at = now() - interval '1 second'
  where reference = (select ref from tmp_t where label = p_label);
$$;

-- One scheduled check: claim, then record what Paystack said.
-- → status:check_count:not_found_count:delay_seconds:escalated:resend:eligible:stale
create function pg_temp.chk(p_label text, p_result text, p_status text, p_code text default null, p_transfer_code text default null)
returns text language plpgsql as $$
declare
  v_tok uuid;
  r     record;
begin
  perform pg_temp.due(p_label);
  select claim_token into v_tok from app.claim_withdrawal_transfers_to_check('checker-test', 50)
  where transfer_reference = (select ref from tmp_t where label = p_label);
  select * into r from app.record_withdrawal_transfer_check(
    (select ref from tmp_t where label = p_label), v_tok, 'check', 'checker-test', p_result, p_status, p_code, p_status,
    null, p_transfer_code, null, 'test_' || p_result, null, true);
  -- other rows claimed by the same call go back
  update public.withdrawal_transfers set claimed_by = null, claimed_until = null, claim_token = null
  where claimed_by = 'checker-test';
  return r.status || ':' || r.check_count || ':' || r.not_found_count || ':'
         || coalesce(round(extract(epoch from r.next_check_at - now()))::text, '-') || ':'
         || r.escalated || ':' || r.resend_allowed || ':' || r.release_eligible || ':' || r.stale;
end;
$$;

-- Test clock for write-once facts (refusal time); guard bypassed for the fixture only.
create function pg_temp.backdate_refusal(p_label text, p_by interval) returns void language plpgsql as $$
begin
  alter table public.withdrawal_transfers disable trigger withdrawal_transfers_guard;
  update public.withdrawal_transfers set refused_at = refused_at - p_by where reference = (select ref from tmp_t where label = p_label);
  alter table public.withdrawal_transfers enable trigger withdrawal_transfers_guard;
end;
$$;

create function pg_temp.ref(p_label text) returns text language sql as $$ select ref from tmp_t where label = p_label $$;
create function pg_temp.tok(p_label text) returns uuid language sql as $$ select token from tmp_t where label = p_label $$;


-- ── P8-2: leases ────────────────────────────────────────────────────────────

select is((select app.current_transfer_check_policy()).version, '2026-11-19-default', 'the 2026-11-19 check policy is in force');

select pg_temp.ready('t1', 1000000);
select is((select claimed_by || ':' || (claimed_until = now() + interval '120 seconds') || ':' || (claim_token = pg_temp.tok('t1'))
                  || ':' || (initiate_requested_at is null)
           from public.withdrawal_transfers where reference = pg_temp.ref('t1')),
  'dispatch-test:true:true:true', 'the dispatch claim is a 120-second lease with a token; nothing has been sent yet');
select is((select count(*)::integer from app.claim_withdrawal_transfers_to_check('checker-test', 50)), 0,
  'a checker cannot take a row under a live lease');
select is(app.mark_withdrawal_transfer_initiating(pg_temp.ref('t1'), app.uuid_generate_v7()), false,
  'only the lease holder may mark a transfer as about to be sent');
select is(app.mark_withdrawal_transfer_initiating(pg_temp.ref('t1'), pg_temp.tok('t1')), true, 'the holder marks it');
select is((select initiate_requested_at is not null from public.withdrawal_transfers where reference = pg_temp.ref('t1')), true,
  'from now on the row counts as possibly sent');
select is((select stale::text || ':' || status from app.record_withdrawal_transfer_check(pg_temp.ref('t1'), app.uuid_generate_v7(), 'dispatch', 'other-worker',
             'ok', 'pending', null, 'pending', null, 'TRF_stale0001', null, 'initiated', null, true)),
  'true:initiating', 'a stale token changes nothing');
select is((select outcome from public.withdrawal_transfer_checks c join public.withdrawal_transfers t on t.id = c.transfer_id
           where t.reference = pg_temp.ref('t1') order by c.checked_at desc, c.id desc limit 1),
  'stale_claim', 'but the stale attempt is logged');
select is((select transfer_code is null from public.withdrawal_transfers where reference = pg_temp.ref('t1')), true,
  'and its transfer code was not recorded');


-- ── PA-09: an ambiguous send, then the backoff ──────────────────────────────

select is((select status || ':' || check_count || ':' || round(extract(epoch from next_check_at - now())) || ':' || escalated || ':'
                  || resend_allowed || ':' || release_eligible || ':' || stale
           from app.record_withdrawal_transfer_check(pg_temp.ref('t1'), pg_temp.tok('t1'), 'dispatch', 'dispatch-test',
             'unavailable', null, 'http_502', 'unknown', null, null, null, 'initiate_ambiguous', 'gateway error', true)),
  'unknown:1:120:false:false:false:false', 'a 502 on send is ambiguous: unknown, checked again in 2 minutes, never released');
select is((select (claim_token is null)::text || ':' || (ambiguous_since is not null) from public.withdrawal_transfers where reference = pg_temp.ref('t1')),
  'true:true', 'the lease is returned and the ambiguity is timed');
select is(pg_temp.chk('t1', 'not_found', 'unknown'), 'unknown:2:1:300:false:false:false:false',
  'P8-1: one NOT FOUND neither releases nor re-sends; next check in 5 minutes');
select is(pg_temp.chk('t1', 'not_found', 'unknown'), 'unknown:3:2:600:false:true:false:false',
  'a second NOT FOUND allows a re-send under the same reference, still no release; next in 10 minutes');
select is(pg_temp.chk('t1', 'ok', 'pending', null, 'TRF_relt10001'), 'pending:4:0:1800:false:false:false:false',
  'Paystack finds it: pending with a transfer code; the NOT FOUND count resets; next in 30 minutes');
select is(pg_temp.chk('t1', 'ok', 'pending'), 'pending:5:0:3600:false:false:false:false', 'then 1 hour');
select is(pg_temp.chk('t1', 'ok', 'pending'), 'pending:6:0:7200:false:false:false:false', 'then 2 hours');
select is(pg_temp.chk('t1', 'ok', 'pending'), 'pending:7:0:14400:false:false:false:false', 'then 4 hours');
select is(pg_temp.chk('t1', 'ok', 'pending'), 'pending:8:0:21600:false:false:false:false', 'then capped at 6 hours');
select is(pg_temp.chk('t1', 'not_found', 'pending'), 'pending:9:1:21600:false:false:false:false',
  'once a transfer code exists, NOT FOUND never allows a re-send or release');
select is((select count(*)::integer || ':' || count(*) filter (where source = 'check') from public.withdrawal_transfer_checks c
           join public.withdrawal_transfers t on t.id = c.transfer_id where t.reference = pg_temp.ref('t1')),
  '10:8', 'every look is logged: 1 stale + 1 dispatch + 8 scheduled checks');


-- ── PA-09: escalation ───────────────────────────────────────────────────────

update public.withdrawal_transfers set check_count = 39 where reference = pg_temp.ref('t1');
select is(pg_temp.chk('t1', 'ok', 'pending'), 'pending:40:0:21600:true:false:false:false',
  'the 40th automatic check escalates the transfer');
select is((select escalation_reason from public.withdrawal_transfers where reference = pg_temp.ref('t1')),
  'automatic verification attempts exhausted', 'with the reason');
select is((select status::text from public.withdrawals where id = (select withdrawal_id from tmp_t where label = 't1')), 'processing',
  'escalation does not settle the withdrawal');
select is(pg_temp.pos(), '9000000:1000000:0', 'and never releases the reserved ₦10,000');
select is((select string_agg(transfer_reference, ',') from app.withdrawal_transfers_needing_attention()), pg_temp.ref('t1'),
  'the escalated transfer is listed for manual reconciliation');
select is((select count(*)::integer from public.audit_logs where action = 'withdrawal.transfer_escalated'
           and object_id = (select withdrawal_id from tmp_t where label = 't1')), 1, 'and the escalation is audited once');
select is(pg_temp.chk('t1', 'ok', 'pending'), 'pending:41:0:21600:true:false:false:false',
  'checks continue after escalation, without a second escalation');

select pg_temp.ready('t3', 500000);
select app.mark_withdrawal_transfer_initiating(pg_temp.ref('t3'), pg_temp.tok('t3'));
select app.record_withdrawal_transfer_check(pg_temp.ref('t3'), pg_temp.tok('t3'), 'dispatch', 'dispatch-test', 'ok', 'otp', null, 'otp',
  null, 'TRF_relt30001', null, 'initiated', null, true);
update public.withdrawal_transfers set initiated_at = now() - interval '3 hours' where reference = pg_temp.ref('t3');
select is(pg_temp.chk('t3', 'ok', 'otp'), 'otp:2:0:300:true:false:false:false',
  'a transfer parked at Paystack''s dashboard OTP for over 2 hours is escalated');


-- ── P8-1: release eligibility ───────────────────────────────────────────────

-- t4: claimed, never marked, never sent.
select pg_temp.ready('t4', 300000);
select is(app.transfer_release_eligible((select id from public.withdrawal_transfers where reference = pg_temp.ref('t4'))), true,
  'a transfer provably never sent may be released');
select is(app.release_withdrawal_transfer_never_sent(pg_temp.ref('t4'), app.uuid_generate_v7(), null), 'stale_claim',
  'but only by the lease holder');
select is(app.release_withdrawal_transfer_never_sent(pg_temp.ref('t4'), pg_temp.tok('t4'), null), 'failed',
  'the holder releases it: the withdrawal fails, nothing was paid');
select is((select w.status::text || ':' || t.status from public.withdrawals w join public.withdrawal_transfers t on t.withdrawal_id = w.id
           where t.reference = pg_temp.ref('t4')), 'failed:failed', 'withdrawal and transfer are both failed');
select is(pg_temp.pos(), '8500000:1500000:0', 'the ₦3,000 is available again; t1 and t3 stay reserved');

-- t5: sent, refused synchronously (not as a duplicate).
select pg_temp.ready('t5', 200000);
select app.mark_withdrawal_transfer_initiating(pg_temp.ref('t5'), pg_temp.tok('t5'));
select is((select release_eligible::text || ':' || resend_allowed from app.record_withdrawal_transfer_check(pg_temp.ref('t5'), pg_temp.tok('t5'),
             'dispatch', 'dispatch-test', 'refused', null, 'invalid_recipient', null, null, null, null, 'initiate_refused', 'Recipient invalid', true)),
  'false:false', 'a refusal on send is not enough to release');
select is(pg_temp.chk('t5', 'not_found', null), 'initiating:2:1:300:false:false:false:false', 'nor one NOT FOUND after it');
select is(pg_temp.chk('t5', 'not_found', null), 'initiating:3:2:600:false:false:false:false',
  'nor two; and a refused transfer is never re-sent');
select is(pg_temp.chk('t5', 'not_found', null), 'initiating:4:3:1800:false:false:false:false',
  'three NOT FOUND within 30 minutes of the refusal: still held');
select pg_temp.backdate_refusal('t5', interval '31 minutes');
select is(app.transfer_release_eligible((select id from public.withdrawal_transfers where reference = pg_temp.ref('t5'))), true,
  'three NOT FOUND over more than 30 minutes after a refusal: eligible');
select pg_temp.due('t5');
update tmp_t set token = (select claim_token from app.claim_withdrawal_transfers_to_check('checker-test', 50) where transfer_reference = pg_temp.ref('t5'))
where label = 't5';
select is(app.release_withdrawal_transfer_never_sent(pg_temp.ref('t5'), pg_temp.tok('t5'), null), 'failed', 'and is released once');
update public.withdrawal_transfers set claimed_by = null, claimed_until = null, claim_token = null where claimed_by = 'checker-test';

-- t6: refused as a duplicate reference: an earlier send may have succeeded.
select pg_temp.ready('t6', 100000);
select app.mark_withdrawal_transfer_initiating(pg_temp.ref('t6'), pg_temp.tok('t6'));
select app.record_withdrawal_transfer_check(pg_temp.ref('t6'), pg_temp.tok('t6'), 'dispatch', 'dispatch-test', 'refused', null,
  'duplicate_transfer_reference', null, null, null, null, 'initiate_refused', 'Duplicate reference', true);
select pg_temp.chk('t6', 'not_found', null);
select pg_temp.chk('t6', 'not_found', null);
select pg_temp.chk('t6', 'not_found', null);
select pg_temp.backdate_refusal('t6', interval '2 hours');
select is(app.transfer_release_eligible((select id from public.withdrawal_transfers where reference = pg_temp.ref('t6'))), false,
  'a duplicate-reference refusal is never released, however long Paystack says NOT FOUND');
select is(pg_temp.chk('t6', 'not_found', null), 'initiating:5:4:3600:false:false:false:false', 'and never re-sent');

-- t7: never sent, but Paystack asked the approval URL for it: it was sent.
select pg_temp.ready('t7', 100000);
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent')),
  'approve:authorised', 'Paystack asks for approval of a fully authorised transfer: approved');
select is(app.transfer_release_eligible((select id from public.withdrawal_transfers where reference = pg_temp.ref('t7'))), false,
  'once Paystack asked for approval, the transfer is never released as unsent');
select is(app.release_withdrawal_transfer_never_sent(pg_temp.ref('t7'), pg_temp.tok('t7'), null), 'not_eligible', 'the release is refused');
select is(pg_temp.pos(), '8300000:1700000:0', 't5 released; t1, t3, t6, t7 reserved');


-- ── Paystack server approval ────────────────────────────────────────────────

select is((select decision || ':' || reason_code from pg_temp.dta('ktr_000000000000000000000000', 1000000, 'RCP_relowner01', 'valid')),
  'reject:unknown_reference', 'an unknown reference is rejected');
select is((select decision || ':' || reason_code from pg_temp.dta(null, null, null, 'absent')),
  'reject:unknown_reference', 'an unreadable request is rejected');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t4'), 300000, 'RCP_relowner01', 'valid')),
  'reject:transfer_already_final', 'a transfer already final is rejected');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t1'), 1000001, 'RCP_relowner01', 'valid')),
  'reject:amount_mismatch', 'a different amount is rejected');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t1'), 1000000, 'RCP_someoneelse', 'valid')),
  'reject:recipient_mismatch', 'a different recipient is rejected');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t1'), 1000000, null, 'valid')),
  'reject:recipient_mismatch', 'a missing recipient is rejected');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t1'), 1000000, 'RCP_relowner01', 'valid')),
  'approve:authorised', 'the matching request is approved');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t1'), 1000000, 'RCP_relowner01', 'valid')),
  'approve:authorised', 'a duplicate request gets the same answer');
select is((select provider_approval_count || ':' || (provider_approved_at is not null) from public.withdrawal_transfers where reference = pg_temp.ref('t1')),
  '5:true', 'each request is counted on the transfer; the first approval time is kept');
select is((select count(*)::integer from public.audit_logs where action = 'withdrawal.transfer_approved_by_kolekto'
           and object_id = (select withdrawal_id from tmp_t where label = 't1')), 1, 'the approval is audited once, refusals each time');
select is((select count(*)::integer || ':' || count(*) filter (where transfer_id is null) from public.withdrawal_transfer_approval_requests
           where received_at = now()),
  '9:2', 'every request is logged, unknown references without a transfer');
select throws_ok($$ select * from pg_temp.dta('x', 1, 'RCP_x', 'invalid') $$, '22023', null,
  'an invalid signature never reaches the decision (the route answers 400 first)');
select is(pg_temp.pos(), '8300000:1700000:0', 'approving moves no money: approval is not payment');

-- Each authorisation fact on its own (2026-11-20). The guards make these
-- states unreachable through the app, so the fixture forges them on t7 (a
-- fully authorised transfer, approved above) with the guard off, one at a
-- time, and restores the row: the approval URL must still say no.
create function pg_temp.forge(p_label text, p_set text) returns void language plpgsql as $$
begin
  alter table public.withdrawals disable trigger withdrawals_guard;
  execute format('update public.withdrawals set %s where id = (select withdrawal_id from tmp_t where label = %L)', p_set, p_label);
  alter table public.withdrawals enable trigger withdrawals_guard;
end;
$$;
create temporary table tmp_w as select * from public.withdrawals where id = (select withdrawal_id from tmp_t where label = 't7');
create function pg_temp.restore_t7() returns void language plpgsql as $$
begin
  alter table public.withdrawals disable trigger withdrawals_guard;
  update public.withdrawals w set status = s.status, member_otp_verified_at = s.member_otp_verified_at,
         member_otp_challenge_id = s.member_otp_challenge_id, approved_by = s.approved_by, approved_at = s.approved_at,
         hold_journal_id = s.hold_journal_id, approved_as = s.approved_as, owner_self_approved = s.owner_self_approved,
         paid_at = s.paid_at
  from tmp_w s where w.id = s.id;
  alter table public.withdrawals enable trigger withdrawals_guard;
end;
$$;

select pg_temp.forge('t7', 'status = ''approved''');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent')),
  'reject:withdrawal_not_processing', 'a withdrawal that is not being paid out is rejected');
select pg_temp.restore_t7();
select pg_temp.forge('t7', 'member_otp_verified_at = null, member_otp_challenge_id = null');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent')),
  'reject:member_not_verified', 'a withdrawal whose requester never verified their code is rejected');
select pg_temp.restore_t7();
select pg_temp.forge('t7', 'approved_by = null, approved_at = null');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent')),
  'reject:owner_not_approved', 'a withdrawal without the owner''s approval is rejected');
select pg_temp.restore_t7();
select pg_temp.forge('t7', 'hold_journal_id = null');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent')),
  'reject:funds_not_reserved', 'a withdrawal without its hold journal is rejected');
select pg_temp.restore_t7();
select pg_temp.forge('t7', 'approved_by = requested_by');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent')),
  'reject:self_approved', 'a withdrawal approved by its own requester is rejected');
select pg_temp.restore_t7();
select pg_temp.forge('t7', 'approved_as = ''owner''');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent')),
  'reject:approver_not_authorised', 'an owner''s request approved on an owner basis (not by a designated approver) is rejected');
select pg_temp.restore_t7();
select pg_temp.forge('t7', 'paid_at = now()');
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent')),
  'reject:already_paid', 'a withdrawal that already has a payout is rejected');
select pg_temp.restore_t7();

-- Payload facts from the parsed Paystack request (2026-11-20).
select is((select decision || ':' || reason_code from app.decide_transfer_approval(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent',
                                                                                  'USD', 'TRF_reltest0001', null)),
  'reject:currency_mismatch', 'a currency other than NGN is rejected');
update public.withdrawal_transfers set transfer_code = 'TRF_kolekto0007' where reference = pg_temp.ref('t7');
select is((select decision || ':' || reason_code from app.decide_transfer_approval(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent',
                                                                                  'NGN', 'TRF_other000007', null)),
  'reject:transfer_code_mismatch', 'a Paystack transfer code different from the one Kolekto holds is rejected');
select is((select decision || ':' || reason_code from app.decide_transfer_approval(pg_temp.ref('t7'), 100000, 'RCP_relowner01', 'absent',
                                                                                  'NGN', 'TRF_kolekto0007', null)),
  'approve:authorised', 'the same request with the matching transfer code is approved');
select is((select d.decision || ':' || d.reason_code || ':' || (l.transfer_id is not null)
           from app.decide_transfer_approval(pg_temp.ref('t7'), null, null, 'valid', null, null, 'payload_mismatch') d,
                lateral (select transfer_id from public.withdrawal_transfer_approval_requests
                         where reference = pg_temp.ref('t7') order by received_at desc, id desc limit 1) l),
  'reject:payload_mismatch:true', 'a payload the parser refused is rejected with its reason, linked to the transfer');
select is((select decision || ':' || reason_code from app.decide_transfer_approval(null, null, null, 'absent', null, null, 'payload_malformed')),
  'reject:payload_malformed', 'an unreadable payload is recorded as such, not as an unknown reference');
select throws_ok($$ select * from app.decide_transfer_approval(null, null, null, 'absent', null, null, 'anything') $$, '22023', null,
  'only a payload_… reason can be passed as a parser refusal');

-- The destination stops being verified after approval: Paystack is told no.
update public.users set full_name = 'Amaka Obi-Nwankwo' where id = 'a7710000-0000-4000-8000-000000000001';
select is((select decision || ':' || reason_code from pg_temp.dta(pg_temp.ref('t1'), 1000000, 'RCP_relowner01', 'valid')),
  'reject:account_not_verified', 'a destination no longer verified is rejected, even after an earlier approval');


-- ── Append-only and write-once ──────────────────────────────────────────────

select throws_ok($$ update public.withdrawal_transfer_checks set outcome = 'edited' $$, 'P0001', null, 'the check log is never edited');
select throws_ok($$ delete from public.withdrawal_transfer_checks $$, 'P0001', null, 'or deleted');
select throws_ok($$ delete from public.withdrawal_transfer_approval_requests $$, 'P0001', null, 'the approval log is never deleted');
select throws_ok($$ update public.withdrawal_transfer_check_policies set lease_seconds = 60 $$, 'P0001', null, 'a policy version is never edited');
select throws_ok(format($$ update public.withdrawal_transfers set initiate_requested_at = null where reference = %L $$, pg_temp.ref('t1')),
  'P0001', null, '"possibly sent" is never undone');
select throws_ok(format($$ update public.withdrawal_transfers set check_count = 1 where reference = %L $$, pg_temp.ref('t1')),
  'P0001', null, 'check counts never go back');
select throws_ok(format($$ update public.withdrawal_transfers set provider_approved_at = null where reference = %L $$, pg_temp.ref('t1')),
  'P0001', null, 'a Paystack approval request is never forgotten');


-- ── P8-4: reconciliation report ─────────────────────────────────────────────

insert into tmp_n select 'journals', count(*) from public.ledger_journals;
select is((select count(*)::integer from app.transfer_reconciliation_kolekto_rows(now() - interval '1 day', now() + interval '1 day')
           where reference in (select ref from tmp_t)),
  6, 'Kolekto''s side lists every transfer in the window');
create temporary table tmp_r as select app.record_transfer_reconciliation_run(
    jsonb_build_object('started_at', now(), 'window_from', now() - interval '7 days', 'window_to', now(),
                       'provider_mode', 'fake', 'provider_count', 5, 'kolekto_count', 6),
    jsonb_build_array(
      jsonb_build_object('kind', 'missing_at_provider', 'severity', 'critical', 'reference', pg_temp.ref('t6'),
                         'kolekto_detail', 'initiating, refused as duplicate', 'provider_detail', null),
      jsonb_build_object('kind', 'foreign_reference', 'severity', 'warning', 'reference', 'kprobe_seq_1795094234',
                         'kolekto_detail', null, 'provider_detail', 'otp, 10000 kobo'))) as id;
select is((select provider_mode || ':' || provider_count || ':' || kolekto_count || ':' || discrepancy_count
           from public.transfer_reconciliation_runs where id = (select id from tmp_r)),
  'fake:5:6:2', 'a run is recorded with its counts and discrepancies');
select is((select string_agg(kind || ':' || resolution_status || ':' || (transfer_id is not null), ',' order by kind)
           from public.transfer_reconciliation_discrepancies where run_id = (select id from tmp_r)),
  'foreign_reference:open:false,missing_at_provider:open:true', 'discrepancies start open and are linked to Kolekto''s transfer when known');
select throws_ok($$ select app.record_transfer_reconciliation_run('{}'::jsonb, '{}'::jsonb) $$, '22023', null, 'discrepancies must be an array');
select throws_ok(format($$ select app.record_transfer_reconciliation_run(%L::jsonb, '[{"kind":"made_up","severity":"info"}]'::jsonb) $$,
                        jsonb_build_object('started_at', now(), 'window_from', now(), 'window_to', now(), 'provider_mode', 'fake',
                                           'provider_count', 0, 'kolekto_count', 0)),
  '23514', null, 'only the known discrepancy kinds are accepted');
select throws_ok(format($$ select app.resolve_transfer_reconciliation_discrepancy(%L, 'resolved', 'ops', '') $$,
                        (select id from public.transfer_reconciliation_discrepancies where kind = 'foreign_reference' and run_id = (select id from tmp_r))),
  '22023', null, 'a resolution names the operator and says why');
select lives_ok(format($$ select app.resolve_transfer_reconciliation_discrepancy(%L, 'acknowledged', 'Ops Reviewer', %L) $$,
                       (select id from public.transfer_reconciliation_discrepancies where kind = 'foreign_reference' and run_id = (select id from tmp_r)),
                       'Paystack TEST probe transfer left at otp; not a Kolekto withdrawal'),
  'an operator acknowledges the foreign TEST probe');
select throws_ok($$ update public.transfer_reconciliation_discrepancies set kind = 'stale_open' $$, 'P0001', null,
  'only the resolution of a discrepancy changes');
select throws_ok($$ delete from public.transfer_reconciliation_runs $$, 'P0001', null, 'runs are never deleted');
select is((select count(*) from public.ledger_journals) - (select n from tmp_n where label = 'journals'), 0::bigint,
  'the report posts no journal and moves no money');


-- ── Grants ──────────────────────────────────────────────────────────────────

select is((select count(*)::integer from unnest(array[
    'app.claim_withdrawal_transfers(integer, text)', 'app.claim_withdrawal_transfers_to_check(text, integer)',
    'app.mark_withdrawal_transfer_initiating(text, uuid)',
    'app.record_withdrawal_transfer_check(text, uuid, text, text, text, text, text, text, text, text, text, text, text, boolean)',
    'app.transfer_release_eligible(uuid)', 'app.release_withdrawal_transfer_claim(text, uuid)',
    'app.release_withdrawal_transfer_never_sent(text, uuid, text)', 'app.decide_transfer_approval(text, bigint, text, text, text, text, text)',
    'app.transfer_reconciliation_kolekto_rows(timestamp with time zone, timestamp with time zone)',
    'app.record_transfer_reconciliation_run(jsonb, jsonb)', 'app.resolve_transfer_reconciliation_discrepancy(uuid, text, text, text)',
    'app.withdrawal_transfers_needing_attention()', 'app.current_transfer_check_policy()']) f
  where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  0, 'no transfer operator function is callable by a client');
select is((select count(*)::integer from pg_class
           where oid in ('public.withdrawal_transfer_checks'::regclass, 'public.withdrawal_transfer_check_policies'::regclass,
                         'public.withdrawal_transfer_approval_requests'::regclass, 'public.transfer_reconciliation_runs'::regclass,
                         'public.transfer_reconciliation_discrepancies'::regclass)
             and relrowsecurity and relforcerowsecurity),
  5, 'row level security is enabled and forced on every new table');
select is((select count(*)::integer from public.v_ledger_imbalances), 0, 'every journal balances');

select * from finish();
rollback;
