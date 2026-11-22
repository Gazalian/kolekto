-- ─────────────────────────────────────────────────────────────────────────────
-- 71 — Second-approver management (20261120140000, session 39)
--
--   · only an owner of THIS community reads candidates / history and
--     designates, replaces or ends a designation; an admin, a treasurer, the
--     designee and another community's owner cannot
--   · eligible: an active admin or owner term AND an active account; a
--     treasurer, a collector, an ordinary member, an ended term, another
--     community's admin, a suspended account and the owner themself are not
--   · replace is atomic and audited once; a failed replace changes nothing
--   · ending is audited; designation rows are never deleted
--   · an approval given earlier keeps its recorded approver, basis and audit
--     after the designation is replaced (history is never rewritten)
--   · a suspended or ended-term designee loses Approve/Reject at once
--   · nobody approves their own withdrawal (owner included)
--   · grants
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(54);

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- 1 owner A · 2 admin D1 · 3 admin D2 · 4 treasurer · 5 plain user (no officer
-- term) · 6 admin S (suspended later) · 7 admin whose term ended · 8 owner of
-- community B · 9 admin of community B only · 10 collector of A

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
select ('a7110000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', 'u' || n || '@approvers.example.test', now()
from generate_series(1, 10) n;
insert into public.users (id, full_name, email) values
  ('a7110000-0000-4000-8000-000000000001', 'Amaka Owner',     'u1@approvers.example.test'),
  ('a7110000-0000-4000-8000-000000000002', 'Dayo Admin',      'u2@approvers.example.test'),
  ('a7110000-0000-4000-8000-000000000003', 'Efe Admin',       'u3@approvers.example.test'),
  ('a7110000-0000-4000-8000-000000000004', 'Tunde Treasurer', 'u4@approvers.example.test'),
  ('a7110000-0000-4000-8000-000000000005', 'Mira Member',     'u5@approvers.example.test'),
  ('a7110000-0000-4000-8000-000000000006', 'Sola Admin',      'u6@approvers.example.test'),
  ('a7110000-0000-4000-8000-000000000007', 'Former Admin',    'u7@approvers.example.test'),
  ('a7110000-0000-4000-8000-000000000008', 'Bisi OtherOwner', 'u8@approvers.example.test'),
  ('a7110000-0000-4000-8000-000000000009', 'Kemi OtherAdmin', 'u9@approvers.example.test'),
  ('a7110000-0000-4000-8000-000000000010', 'Chuka Collector', 'u10@approvers.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a7120000-0000-4000-8000-00000000000a', 'approver-mgmt', 'Approver Mgmt', 'social_group', false, 'a7110000-0000-4000-8000-000000000001'),
  ('a7120000-0000-4000-8000-00000000000b', 'approver-other', 'Approver Other', 'social_group', false, 'a7110000-0000-4000-8000-000000000008');
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values ('a7150000-0000-4000-8000-000000000001', 'a7120000-0000-4000-8000-00000000000a', 'approver-dues', 'Dues',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a7110000-0000-4000-8000-000000000001');
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000001', 'owner',     'Amaka Owner',     'created', null),
  ('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000002', 'admin',     'Dayo Admin',      'invited', null),
  ('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000003', 'admin',     'Efe Admin',       'invited', null),
  ('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000004', 'treasurer', 'Tunde Treasurer', 'invited', null),
  ('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000006', 'admin',     'Sola Admin',      'invited', null),
  ('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000010', 'collector', 'Chuka Collector', 'invited', null),
  ('a7120000-0000-4000-8000-00000000000b', 'a7110000-0000-4000-8000-000000000008', 'owner',     'Bisi OtherOwner', 'created', null),
  ('a7120000-0000-4000-8000-00000000000b', 'a7110000-0000-4000-8000-000000000009', 'admin',     'Kemi OtherAdmin', 'invited', null);
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope, started_at, ended_at, end_reason) values
  ('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000007', 'admin', 'Former Admin', 'invited', null,
   now() - interval '10 days', now() - interval '1 day', 'removed');

create function pg_temp.h(p_challenge uuid, p_code text) returns text language sql as $$
  select encode(sha256(convert_to(p_code || ':' || p_challenge, 'UTF8')), 'hex')
$$;
create function pg_temp.deliver() returns integer language plpgsql as $$
declare
  r record;
  n integer := 0;
begin
  for r in select * from app.claim_withdrawal_otp_deliveries(50) loop
    perform app.record_withdrawal_otp_issued(r.challenge_id, pg_temp.h(r.challenge_id, 'good'));
    perform app.record_withdrawal_otp_delivery(r.challenge_id, true, null);
    n := n + 1;
  end loop;
  return n;
end;
$$;
create function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;
-- The owner's own request, confirmed with the owner's code (as the owner).
create function pg_temp.owner_request(p_key text, p_amount bigint) returns uuid language plpgsql as $$
declare
  v_w uuid;
  v_c uuid;
begin
  perform pg_temp.as_user('a7110000-0000-4000-8000-000000000001');
  select withdrawal_id into v_w from app.request_withdrawal_to_account(
    'a7150000-0000-4000-8000-000000000001', p_amount, (select id from tmp_b where label = 'O'), p_key);
  perform set_config('role', 'none', true);
  perform pg_temp.deliver();
  perform pg_temp.as_user('a7110000-0000-4000-8000-000000000001');
  select challenge_id into v_c from app.withdrawal_otp_state(v_w);
  perform app.verify_withdrawal_otp(v_w, v_c, pg_temp.h(v_c, 'good'));
  perform set_config('role', 'none', true);
  return v_w;
end;
$$;

create temporary table tmp_b (label text primary key, id uuid);
create temporary table tmp_w (label text primary key, id uuid);
grant all on tmp_b, tmp_w to authenticated;

insert into tmp_b select 'O', bank_account_id from app.register_bank_account(
  'a7110000-0000-4000-8000-000000000001', '044', 'Access Bank', '0123471101', 'OWNER AMAKA', 'Amaka Owner', true);
select app.set_bank_account_recipient((select id from tmp_b where label = 'O'), 'RCP_approvermgmt1');

select app.post_ledger_journal(
  'a7120000-0000-4000-8000-00000000000a', 'a7150000-0000-4000-8000-000000000001', now(), 'adjustment',
  'a7150000-0000-4000-8000-000000000001', 'test fixture funding', 'test-fund-approver-mgmt',
  jsonb_build_array(
    jsonb_build_object('account_id', app.ensure_ledger_account(null, null, 'provider_settled_funds'), 'direction', 'debit', 'amount_kobo', 5000000),
    jsonb_build_object('account_id', app.ensure_ledger_account('a7120000-0000-4000-8000-00000000000a', 'a7150000-0000-4000-8000-000000000001', 'collection_available'),
                       'direction', 'credit', 'amount_kobo', 5000000)),
  'system', null);


-- ── Who may read and manage (server-side) ───────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000001","role":"authenticated"}';
select set_eq($$ select user_id from app.withdrawal_approver_candidates('a7120000-0000-4000-8000-00000000000a') $$,
  $$ values ('a7110000-0000-4000-8000-000000000002'::uuid), ('a7110000-0000-4000-8000-000000000003'::uuid), ('a7110000-0000-4000-8000-000000000006'::uuid) $$,
  'candidates are exactly the active admins: not the owner, a treasurer, a collector, a plain user, an ended term or another community''s admin');
select is((select count(*)::integer from app.withdrawal_approver_history('a7120000-0000-4000-8000-00000000000a')), 0, 'no designation yet');

set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select * from app.withdrawal_approver_candidates('a7120000-0000-4000-8000-00000000000a') $$, '42501', null,
  'an admin cannot list candidates');
select throws_ok($$ select * from app.withdrawal_approver_history('a7120000-0000-4000-8000-00000000000a') $$, '42501', null,
  'an admin cannot read the designation history');
select throws_ok($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000003', true) $$, '42501', null,
  'an admin cannot designate (no role escalation)');
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000002', true) $$, '42501', null,
  'a treasurer cannot designate');
select throws_ok($$ select * from app.withdrawal_approver_history('a7120000-0000-4000-8000-00000000000a') $$, '42501', null,
  'a treasurer cannot read the designation history');
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000008","role":"authenticated"}';
select throws_ok($$ select * from app.withdrawal_approver_candidates('a7120000-0000-4000-8000-00000000000a') $$, '42501', null,
  'another community''s owner cannot list this community''s candidates');
select throws_ok($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000002', true) $$, '42501', null,
  'another community''s owner cannot designate here');
select throws_like($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000b', 'a7110000-0000-4000-8000-000000000002', true) $$,
  '%WITHDRAWAL_APPROVER_NOT_ELIGIBLE%', 'an owner cannot designate an admin of a different community');


-- ── Eligibility ─────────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_like($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000004', true) $$,
  '%WITHDRAWAL_APPROVER_NOT_ELIGIBLE%', 'a treasurer is not eligible');
select throws_like($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000010', true) $$,
  '%WITHDRAWAL_APPROVER_NOT_ELIGIBLE%', 'a collector is not eligible');
select throws_like($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000005', true) $$,
  '%WITHDRAWAL_APPROVER_NOT_ELIGIBLE%', 'an ordinary member (no officer term) is not eligible');
select throws_like($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000007', true) $$,
  '%WITHDRAWAL_APPROVER_NOT_ELIGIBLE%', 'an admin whose term ended is not eligible');
select throws_like($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000009', true) $$,
  '%WITHDRAWAL_APPROVER_NOT_ELIGIBLE%', 'another community''s admin is not eligible');
select throws_like($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000001', true) $$,
  '%WITHDRAWAL_APPROVER_SELF%', 'the owner cannot designate themself');

select is(app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000002', true), true,
  'the owner designates an eligible admin');
select is((select full_name || ':' || designated_by_name || ':' || active || ':' || eligible || ':' || officer_role || ':' || (started_at is not null)
           from app.withdrawal_approver_history('a7120000-0000-4000-8000-00000000000a')),
  'Dayo Admin:Amaka Owner:true:true:admin:true', 'the history shows who, by whom, when, active and eligible');
select is((select designated from app.withdrawal_approver_candidates('a7120000-0000-4000-8000-00000000000a')
           where user_id = 'a7110000-0000-4000-8000-000000000002'), true, 'the candidate list marks the designee');

set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000003', true) $$, '42501', null,
  'the designee cannot designate anyone else');
select throws_ok($$ select app.replace_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000002', 'a7110000-0000-4000-8000-000000000003') $$, '42501', null,
  'nor replace themself');


-- ── An owner's request approved by the designee (history to preserve) ───────

reset role;
insert into tmp_w values ('w1', pg_temp.owner_request('approver-mgmt-w1', 100000));
set local role authenticated;
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_like(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w1')),
  '%nobody approves or rejects their own withdrawal%', 'the owner cannot approve their own withdrawal');
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w1')), '42501', null,
  'a treasurer without a designation cannot approve it');
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(app.decide_withdrawal((select id from tmp_w where label = 'w1'), 'approve')::text, 'approved', 'the designee approves');
reset role;
-- Test clock (as in 69): inside one transaction now() never moves, so the
-- designee's term and designation are placed an hour back and the approval
-- half an hour back, before the replacement below (fixture only).
alter table public.community_withdrawal_approvers disable trigger community_withdrawal_approvers_guard;
update public.community_withdrawal_approvers set started_at = started_at - interval '1 hour'
  where user_id = 'a7110000-0000-4000-8000-000000000002' and ended_at is null;
alter table public.community_withdrawal_approvers enable trigger community_withdrawal_approvers_guard;
update public.officer_terms set started_at = started_at - interval '1 hour'
  where user_id = 'a7110000-0000-4000-8000-000000000002' and ended_at is null;
alter table public.withdrawals disable trigger withdrawals_guard;
update public.withdrawals set approved_at = approved_at - interval '30 minutes' where id = (select id from tmp_w where label = 'w1');
alter table public.withdrawals enable trigger withdrawals_guard;
create temporary table tmp_before as
  select w.approved_by, w.approved_at, w.approved_as,
         (select count(*) from public.audit_logs l where l.object_id = w.id and l.action = 'withdrawal.approve') as audits,
         (select l.after_state from public.audit_logs l where l.object_id = w.id and l.action = 'withdrawal.approve') as audit_after
  from public.withdrawals w where w.id = (select id from tmp_w where label = 'w1');


-- ── Replace ─────────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000001","role":"authenticated"}';
select isnt(app.replace_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000002', 'a7110000-0000-4000-8000-000000000003'),
  null, 'the owner replaces the designee');
select is((select string_agg(full_name || ':' || active || ':' || coalesce(ended_by_name, '-'), ',' order by full_name)
           from app.withdrawal_approver_history('a7120000-0000-4000-8000-00000000000a')),
  'Dayo Admin:false:Amaka Owner,Efe Admin:true:-', 'the old designation is ended by the owner; the new one is active');
select throws_like($$ select app.replace_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000002', 'a7110000-0000-4000-8000-000000000006') $$,
  '%WITHDRAWAL_APPROVER_NOT_DESIGNATED%', 'a designation that already ended cannot be replaced again');
select throws_like($$ select app.replace_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000003', 'a7110000-0000-4000-8000-000000000004') $$,
  '%WITHDRAWAL_APPROVER_NOT_ELIGIBLE%', 'replacing with a treasurer is refused');
select throws_like($$ select app.replace_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000003', 'a7110000-0000-4000-8000-000000000001') $$,
  '%WITHDRAWAL_APPROVER_SELF%', 'replacing with the owner themself is refused');
select is((select count(*)::integer from app.withdrawal_approver_history('a7120000-0000-4000-8000-00000000000a')
           where active and user_id = 'a7110000-0000-4000-8000-000000000003'), 1, 'a refused replace changes nothing');
select is(app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000006', true), true,
  'a second person can be designated alongside (several approvers is the existing policy)');
select throws_like($$ select app.replace_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000003', 'a7110000-0000-4000-8000-000000000006') $$,
  '%WITHDRAWAL_APPROVER_ALREADY_DESIGNATED%', 'replacing with someone already designated is refused');

reset role;
select is((select (before_state->>'user_id') || '>' || (after_state->>'user_id') from public.audit_logs
           where community_id = 'a7120000-0000-4000-8000-00000000000a' and action = 'withdrawal_approver.replaced'),
  'a7110000-0000-4000-8000-000000000002>a7110000-0000-4000-8000-000000000003', 'the replacement is audited once, old and new');
select is((select approved_by::text || ':' || approved_as || ':' || (approved_at = (select approved_at from tmp_before))
           from public.withdrawals where id = (select id from tmp_w where label = 'w1')),
  'a7110000-0000-4000-8000-000000000002:second_approver:true', 'the earlier approval keeps its approver, basis and time');
select is((select count(*) from public.audit_logs l where l.object_id = (select id from tmp_w where label = 'w1') and l.action = 'withdrawal.approve'),
  (select audits from tmp_before), 'its approval audit row is neither removed nor added to');
select is((select after_state from public.audit_logs l where l.object_id = (select id from tmp_w where label = 'w1') and l.action = 'withdrawal.approve'),
  (select audit_after from tmp_before), 'and is unchanged');
select is((select app.withdrawal_approval_basis(w, w.approved_by, w.approved_at) from public.withdrawals w
           where id = (select id from tmp_w where label = 'w1')),
  'second_approver', 'the approval stays valid for the time it was given');


-- ── Remove ──────────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000003', false), true,
  'the owner removes a designation');
select is(app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000003', false), false,
  'removing it again changes nothing');
reset role;
select is((select count(*)::integer from public.audit_logs
           where community_id = 'a7120000-0000-4000-8000-00000000000a' and action = 'withdrawal_approver.ended'), 1, 'the removal is audited once');
select throws_ok($$ delete from public.community_withdrawal_approvers where community_id = 'a7120000-0000-4000-8000-00000000000a' $$,
  'P0001', null, 'designations are never deleted');


-- ── Suspended and ended-term designees lose authority at once ───────────────

insert into tmp_w values ('w2', pg_temp.owner_request('approver-mgmt-w2', 200000));
update public.users set status = 'suspended' where id = 'a7110000-0000-4000-8000-000000000006';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000006","role":"authenticated"}';
select is((select can_decide || ':' || can_reject from app.collection_withdrawals('a7150000-0000-4000-8000-000000000001')
           where id = (select id from tmp_w where label = 'w2')), 'false:false', 'a suspended designee sees no Approve or Reject');
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w2')), '42501', null,
  'a suspended designee cannot approve');
select throws_ok(format($$ select app.decide_withdrawal(%L, 'reject', 'x') $$, (select id from tmp_w where label = 'w2')), '42501', null,
  'nor reject');
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select eligible from app.withdrawal_approvers('a7120000-0000-4000-8000-00000000000a') where user_id = 'a7110000-0000-4000-8000-000000000006'),
  false, 'the owner sees the suspended designee as not eligible');
select is(app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000006', false), true,
  'the owner ends that designation');
select throws_like($$ select app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000006', true) $$,
  '%WITHDRAWAL_APPROVER_NOT_ELIGIBLE%', 'a suspended admin cannot be designated');

-- An admin designated and then removed from office.
select is(app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000003', true), true,
  'the owner designates another admin');
reset role;
update public.officer_terms set ended_at = now(), end_reason = 'removed'
  where community_id = 'a7120000-0000-4000-8000-00000000000a' and user_id = 'a7110000-0000-4000-8000-000000000003' and ended_at is null;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w2')), '42501', null,
  'a designee whose admin term ended cannot approve');
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select eligible from app.withdrawal_approver_history('a7120000-0000-4000-8000-00000000000a')
           where active and user_id = 'a7110000-0000-4000-8000-000000000003'), false, 'the history shows that designation as no longer eligible');

-- The normal path still works afterwards.
select is(app.set_withdrawal_approver('a7120000-0000-4000-8000-00000000000a', 'a7110000-0000-4000-8000-000000000002', true), true,
  'the owner designates an eligible admin again');
set local request.jwt.claims = '{"sub":"a7110000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(app.decide_withdrawal((select id from tmp_w where label = 'w2'), 'approve')::text, 'approved', 'who then approves the owner''s request');


-- ── Grants ──────────────────────────────────────────────────────────────────

reset role;
select ok(not has_function_privilege('anon', 'app.withdrawal_approver_candidates(uuid)', 'execute')
          and not has_function_privilege('anon', 'app.withdrawal_approver_history(uuid)', 'execute')
          and not has_function_privilege('anon', 'app.replace_withdrawal_approver(uuid, uuid, uuid)', 'execute'),
  'anon executes none of the management functions');
select ok(not has_function_privilege('authenticated', 'app.withdrawal_decider_basis(public.withdrawals, uuid, timestamptz)', 'execute'),
  'the decider basis is internal');

select * from finish();
rollback;
