-- ─────────────────────────────────────────────────────────────────────────────
-- 73 — Community home and community overview report (20261122120000)
--
--   · my_communities: only communities with an active officer term; role,
--     counts; ended terms and outsiders see nothing
--   · overview counts: members on the roll (active + unclaimed), waiting
--     (invited + pending approval) not counted, archived excluded; active
--     officers only; collection lifecycle counts
--   · collected = applied contributions only (pending and failed excluded)
--     and equals Σ collection_financial_overview.total_raised_kobo
--   · every balance figure equals Σ v_collection_position over the community,
--     and each collection row equals that collection's own overview
--   · pending withdrawals = ledger "withdrawing" = Σ open withdrawals; paid
--     ones are not pending; balance = pending + available + on hold + withdrawing
--   · collector scope: only the scoped collection's money, no balances
--   · outsiders and unknown ids refused alike; anon cannot execute
--   · recent activity: limited, newest first, permission-filtered, no emails
--   · readiness: real status, owner-only owner facts, D-07 usage today
--   · reading moves no money; all six functions are STABLE
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
-- Same pin as 62: provider-confirmed settlement for captures dated relative to now().
insert into public.settlement_schedules
  (version, effective_from, timezone, release_day_offset, release_time, requires_provider_confirmation, notes)
values ('test-pin-provider-confirmed-73', greatest(now() - interval '3 days', (select max(s.effective_from) from public.settlement_schedules s) + interval '1 second'), 'Africa/Lagos', 1, time '05:00', true, 'test only');
-- As in 62: the typed-destination request is used to create withdrawals; the
-- grant is restored inside this rolled-back transaction only.
grant execute on function app.request_withdrawal(uuid, bigint, text, text, text, text) to authenticated;
select plan(39);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a7310000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@overview.example.test', now()),
  ('a7310000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer@overview.example.test', now()),
  ('a7310000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@overview.example.test', now()),
  ('a7310000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@overview.example.test', now()),
  ('a7310000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'former@overview.example.test', now()),
  ('a7310000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@overview.example.test', now());
insert into public.users (id, full_name, email, identity_level) values
  ('a7310000-0000-4000-8000-000000000001', 'Overview Owner',     'owner@overview.example.test',     'identity_verified'),
  ('a7310000-0000-4000-8000-000000000002', 'Overview Treasurer', 'treasurer@overview.example.test', 'contact_verified'),
  ('a7310000-0000-4000-8000-000000000003', 'Overview Collector', 'collector@overview.example.test', 'contact_verified'),
  ('a7310000-0000-4000-8000-000000000004', 'Overview Viewer',    'viewer@overview.example.test',    'contact_verified'),
  ('a7310000-0000-4000-8000-000000000005', 'Former Officer',     'former@overview.example.test',    'contact_verified'),
  ('a7310000-0000-4000-8000-000000000009', 'Other Owner',        'outsider@overview.example.test',  'identity_verified')
on conflict (id) do update set full_name = excluded.full_name, identity_level = excluded.identity_level;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a7320000-0000-4000-8000-00000000000a', 'overview-tests', 'Overview Tests', 'social_group', false, 'a7310000-0000-4000-8000-000000000001'),
  ('a7320000-0000-4000-8000-00000000000b', 'overview-other', 'Overview Other', 'social_group', false, 'a7310000-0000-4000-8000-000000000009');

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by, archived_at)
values
  ('a7350000-0000-4000-8000-000000000001', 'a7320000-0000-4000-8000-00000000000a', 'absorbs', 'Host Absorbs',
   'dues', 'open', 'public', 'fixed', 1000000, 'active', 'unlisted', 'community_absorbs', 'a7310000-0000-4000-8000-000000000001', null),
  ('a7350000-0000-4000-8000-000000000002', 'a7320000-0000-4000-8000-00000000000a', 'payer-pays', 'Payer Pays',
   'dues', 'open', 'public', 'fixed', 1000000, 'active', 'unlisted', 'contributor_pays', 'a7310000-0000-4000-8000-000000000001', null),
  ('a7350000-0000-4000-8000-000000000003', 'a7320000-0000-4000-8000-00000000000a', 'a-draft', 'A Draft',
   'dues', 'open', 'public', 'fixed', 1000000, 'draft', 'unlisted', 'community_absorbs', 'a7310000-0000-4000-8000-000000000001', null),
  ('a7350000-0000-4000-8000-000000000004', 'a7320000-0000-4000-8000-00000000000a', 'closed-one', 'Closed One',
   'dues', 'open', 'public', 'fixed', 1000000, 'closed', 'unlisted', 'community_absorbs', 'a7310000-0000-4000-8000-000000000001', null),
  ('a7350000-0000-4000-8000-000000000005', 'a7320000-0000-4000-8000-00000000000a', 'archived-one', 'Archived One',
   'dues', 'open', 'public', 'fixed', 1000000, 'archived', 'unlisted', 'community_absorbs', 'a7310000-0000-4000-8000-000000000001', now());

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a7320000-0000-4000-8000-00000000000a', 'a7310000-0000-4000-8000-000000000001', 'owner',     'Overview Owner',     'created', null),
  ('a7320000-0000-4000-8000-00000000000a', 'a7310000-0000-4000-8000-000000000002', 'treasurer', 'Overview Treasurer', 'invited', null),
  ('a7320000-0000-4000-8000-00000000000a', 'a7310000-0000-4000-8000-000000000003', 'collector', 'Overview Collector', 'invited',
   '{"collection_ids": ["a7350000-0000-4000-8000-000000000001"]}'::jsonb),
  ('a7320000-0000-4000-8000-00000000000a', 'a7310000-0000-4000-8000-000000000004', 'viewer',    'Overview Viewer',    'invited', null),
  ('a7320000-0000-4000-8000-00000000000b', 'a7310000-0000-4000-8000-000000000009', 'owner',     'Other Owner',        'created', null);
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, started_at, ended_at, end_reason) values
  ('a7320000-0000-4000-8000-00000000000a', 'a7310000-0000-4000-8000-000000000005', 'viewer', 'Former Officer', 'invited',
   now() - interval '10 days', now() - interval '1 day', 'resigned');

insert into public.members (community_id, full_name, phone_e164, status, joined_via, archived_at) values
  ('a7320000-0000-4000-8000-00000000000a', 'Active One',    '+2348000007301', 'active',           'manual',      null),
  ('a7320000-0000-4000-8000-00000000000a', 'Active Two',    '+2348000007302', 'active',           'invite_link', null),
  ('a7320000-0000-4000-8000-00000000000a', 'Unclaimed One', null,             'unclaimed',        'import',      null),
  ('a7320000-0000-4000-8000-00000000000a', 'Invited One',   null,             'invited',          'manual',      null),
  ('a7320000-0000-4000-8000-00000000000a', 'Waiting One',   '+2348000007305', 'pending_approval', 'invite_link', null),
  ('a7320000-0000-4000-8000-00000000000a', 'Gone One',      null,             'archived',         'manual',      now());

create function pg_temp.ref(n integer) returns text language sql as $$ select 'KLK-' || lpad(n::text, 26, '0') $$;
create function pg_temp.col(n integer) returns uuid language sql as $$
  select ('a7350000-0000-4000-8000-00000000000' || n)::uuid $$;

-- ₦10,000 each. Host absorbs: net ₦9,800. Contributor pays: net ₦10,000.
create function pg_temp.attempt(p_col integer, p_ref integer, p_name text) returns uuid language plpgsql as $$
declare
  v_attempt uuid;
  v_payer_pays boolean := p_col = 2;
begin
  select attempt_id into v_attempt from app.create_payment_attempt(
    pg_temp.col(p_col), 'checkout-key-overview-' || p_ref, pg_temp.ref(p_ref), 'fake', null,
    p_name, 'payer' || p_ref || '@overview.example.test', '+2348000000073', '{}'::jsonb, '{}'::text[],
    null, null,
    1000000, 5000, 15000, 0, 20000,
    case when v_payer_pays then 1020000 else 1000000 end,
    case when v_payer_pays then 1000000 else 980000 end, 10000,
    case when v_payer_pays then 'contributor_pays' else 'community_absorbs' end::public.fee_mode, '2026-11-founder');
  return v_attempt;
end;
$$;

create function pg_temp.pay(p_col integer, p_ref integer, p_name text, p_paid_at timestamptz) returns uuid language plpgsql as $$
declare
  v_attempt uuid := pg_temp.attempt(p_col, p_ref, p_name);
begin
  perform app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), 'succeeded', 'succeeded',
    case when p_col = 2 then 1020000 else 1000000 end, 'NGN', null, p_paid_at, 'card', null, '{"__fake": true}'::jsonb);
  perform app.complete_payment_capture(v_attempt);
  return v_attempt;
end;
$$;

create temporary table tmp_a (label text primary key, id uuid);
insert into tmp_a values
  ('today',    pg_temp.pay(1, 7301, 'Adebayo Johnson', now())),
  ('due',      pg_temp.pay(1, 7302, 'Maryam Ibrahim',  now() - interval '2 days')),
  ('released', pg_temp.pay(1, 7303, 'David Okafor',    now() - interval '2 days')),
  ('waiting',  pg_temp.attempt(1, 7304, 'Fatima Bello')),
  ('refused',  pg_temp.attempt(1, 7305, 'Kunle Ade')),
  ('payer',    pg_temp.pay(2, 7306, 'Ngozi Eze',       now() - interval '2 days'));
select app.mark_payment_attempt_initialized((select id from tmp_a where label = 'refused'), 'access-7305');
select app.mark_payment_attempt_failed((select id from tmp_a where label = 'refused'), 'declined');
-- The provider settles David's and Ngozi's payments; the release job makes them available.
select app.record_provider_settlement(pg_temp.ref(7303), 'STL-73A', 990000,  now() - interval '1 day');
select app.record_provider_settlement(pg_temp.ref(7306), 'STL-73B', 1010000, now() - interval '1 day');
select app.release_due_settlements(500);

-- One withdrawal per collection: ₦3,000 from Host Absorbs (paid out),
-- ₦2,000 from Payer Pays (still open).
create temporary table tmp_w (label text primary key, id uuid);
grant select, insert on tmp_w to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a7310000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into tmp_w select 'paid', withdrawal_id from app.request_withdrawal(
  pg_temp.col(1), 300000, 'Overview Owner', '0123456789', 'Test Bank', 'overview-wd-key-1');
insert into tmp_w select 'open', withdrawal_id from app.request_withdrawal(
  pg_temp.col(2), 200000, 'Overview Owner', '0123456789', 'Test Bank', 'overview-wd-key-2');
reset role;
select app.mark_withdrawal_processing((select id from tmp_w where label = 'paid'));
select app.complete_withdrawal((select id from tmp_w where label = 'paid'), 'NIP-73', now());

-- Snapshot of everything reading must not touch.
create temporary table tmp_before as select
  (select count(*) from public.ledger_journals) as journals,
  (select count(*) from public.ledger_entries)  as entries,
  (select coalesce(md5(string_agg(p::text, '|' order by p.collection_id)), '') from public.v_collection_position p
     where p.community_id = 'a7320000-0000-4000-8000-00000000000a') as positions,
  (select coalesce(md5(string_agg(w::text, '|' order by w.id)), '') from public.withdrawals w) as withdrawals;

-- Ledger truth for the community, read as postgres (no permission filter).
create temporary table tmp_pos as select
  sum(pending_kobo)::bigint p, sum(available_kobo)::bigint a, sum(on_hold_kobo)::bigint h,
  sum(withdrawing_kobo)::bigint w, sum(withdrawn_kobo)::bigint d
from public.v_collection_position where community_id = 'a7320000-0000-4000-8000-00000000000a';
create temporary table tmp_open as select coalesce(sum(w.amount_kobo), 0)::bigint as open_kobo
from public.withdrawals w
where w.community_id = 'a7320000-0000-4000-8000-00000000000a' and w.status in ('requested', 'approved', 'processing');
grant select on tmp_pos, tmp_open, tmp_a, tmp_before to authenticated, anon;

create function pg_temp.as_user(p_n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    format('{"sub":"a7310000-0000-4000-8000-00000000000%s","role":"authenticated"}', p_n), true);
end;
$$;


-- ── Community home ─────────────────────────────────────────────────────────

set local role authenticated;
select pg_temp.as_user(1);

select is(
  (select concat_ws(':', role, collection_count, live_collection_count, verification_status)
     from app.my_communities() where community_id = 'a7320000-0000-4000-8000-00000000000a'),
  'owner:4:2:unverified',
  'owner sees the community: role, 4 collections (archived excluded), 2 live, unverified');
select is((select count(*)::integer from app.my_communities() where community_id = 'a7320000-0000-4000-8000-00000000000b'),
  0, 'another community is not listed');

select pg_temp.as_user(5);
select is((select count(*)::integer from app.my_communities() where community_id = 'a7320000-0000-4000-8000-00000000000a'),
  0, 'an officer whose term ended no longer sees the community');

select pg_temp.as_user(3);
select is((select role::text from app.my_communities() where community_id = 'a7320000-0000-4000-8000-00000000000a'),
  'collector', 'a collector sees the community with their role');


-- ── Overview counts (owner) ────────────────────────────────────────────────

select pg_temp.as_user(1);
select is(
  (select concat_ws(':', members_count, members_confirmed_count, members_waiting_count, officer_count)
     from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  '3:2:2:4',
  'members: 2 active + 1 unclaimed on the roll; invited and pending approval waiting, not counted; archived excluded; 4 active officers (ended term excluded)');
select is(
  (select concat_ws(':', collection_count, live_collection_count, draft_collection_count, upcoming_or_paused_count, closed_collection_count)
     from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  '4:2:1:0:1',
  'collections: 4 not archived, 2 live, 1 draft, 0 scheduled/paused, 1 closed');


-- ── Collected: successful contributions only ───────────────────────────────

select is(
  (select concat_ws(':', collected_kobo, contribution_count) from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  '4000000:4',
  'collected ₦40,000 from 4 successful payments; the pending and the refused checkout are excluded');
select is(
  (select collected_kobo from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  (select sum(o.total_raised_kobo)::bigint
     from public.collections k cross join lateral app.collection_financial_overview(k.id) o
    where k.community_id = 'a7320000-0000-4000-8000-00000000000a'),
  'collected equals Σ collection_financial_overview.total_raised_kobo over the community''s collections');
select is(
  (select concat_ws(':', collected_30d_kobo, contribution_30d_count) from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  '4000000:4', 'all four payments fall in the last 30 days');


-- ── Balances: the ledger, summed ───────────────────────────────────────────

select is(
  (select concat_ws(':', pending_kobo, available_kobo, on_hold_kobo, withdrawing_kobo, withdrawn_kobo)
     from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  (select concat_ws(':', p, a, h, w, d) from tmp_pos),
  'every balance figure equals Σ v_collection_position over the community');
select is(
  (select concat_ws(':', available_kobo, withdrawing_kobo, withdrawn_kobo)
     from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  '1480000:200000:300000',
  'available ₦14,800 (Host Absorbs ₦9,800 − ₦3,000 paid; Payer Pays ₦10,000 − ₦2,000 held); ₦2,000 being withdrawn; ₦3,000 paid out');
select is(
  (select balance_kobo from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  (select p + a + h + w from tmp_pos),
  'collection balances = pending + available + on hold + being withdrawn');
select is(
  (select concat_ws(':', open_withdrawal_count, paid_withdrawal_count) from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  '1:1', 'one open withdrawal, one paid; the paid one is not pending');
select is(
  (select withdrawing_kobo from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  (select open_kobo from tmp_open),
  'pending withdrawals in the ledger equal the open withdrawal records');
select is(
  (select pending_kobo from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  1960000::bigint,
  'two successful payments not yet released (₦9,800 + ₦9,800) are pending, not available');

select is(
  (select concat_ws(':', f.collected_kobo, f.pending_kobo, f.available_kobo, f.withdrawing_kobo, f.withdrawn_kobo)
     from app.community_collection_figures('a7320000-0000-4000-8000-00000000000a') f where f.collection_id = pg_temp.col(1)),
  (select concat_ws(':', o.total_raised_kobo, o.pending_kobo, o.available_kobo, o.withdrawing_kobo, o.withdrawn_kobo)
     from app.collection_financial_overview(pg_temp.col(1)) o),
  'Host Absorbs'' row equals that collection''s own financial overview');
select is(
  (select concat_ws(':', f.collected_kobo, f.pending_kobo, f.available_kobo, f.withdrawing_kobo, f.withdrawn_kobo)
     from app.community_collection_figures('a7320000-0000-4000-8000-00000000000a') f where f.collection_id = pg_temp.col(2)),
  (select concat_ws(':', o.total_raised_kobo, o.pending_kobo, o.available_kobo, o.withdrawing_kobo, o.withdrawn_kobo)
     from app.collection_financial_overview(pg_temp.col(2)) o),
  'Payer Pays'' row equals its own financial overview (no money crosses collections)');
select is(
  (select f.available_kobo from app.community_collection_figures('a7320000-0000-4000-8000-00000000000a') f where f.collection_id = pg_temp.col(2)),
  800000::bigint, 'Payer Pays available is its own ₦10,000 − its own ₦2,000 withdrawal; nothing from Host Absorbs');
select is((select count(*)::integer from app.community_collection_figures('a7320000-0000-4000-8000-00000000000a')),
  5, 'figures list every collection, archived included (its money stays its own)');


-- ── Collector scope ────────────────────────────────────────────────────────

select pg_temp.as_user(3);
select is(
  (select concat_ws(':', can_view_transactions, collected_kobo, contribution_count, can_view_balances, coalesce(available_kobo::text, 'null'))
     from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  't:3000000:3:f:null',
  'collector: only the scoped collection''s ₦30,000 from 3 payments; no balances');
select is(
  (select coalesce(f.collected_kobo::text, 'null') from app.community_collection_figures('a7320000-0000-4000-8000-00000000000a') f
    where f.collection_id = pg_temp.col(2)),
  'null', 'collector gets no figure for a collection outside their scope');
select is(
  (select count(*)::integer from app.community_recent_activity('a7320000-0000-4000-8000-00000000000a', 20)
    where kind like 'withdrawal%' or (kind = 'contribution' and collection_id = pg_temp.col(2))),
  0, 'collector''s activity has no withdrawals and no payment outside their scope');


-- ── Viewer ─────────────────────────────────────────────────────────────────

select pg_temp.as_user(4);
select is(
  (select concat_ws(':', can_view_balances, available_kobo, withdrawn_kobo) from app.community_overview('a7320000-0000-4000-8000-00000000000a')),
  't:1480000:300000', 'viewer (balance.view) sees the same balance figures');


-- ── Outsiders ──────────────────────────────────────────────────────────────

select pg_temp.as_user(9);
select throws_ok($$ select * from app.community_overview('a7320000-0000-4000-8000-00000000000a') $$,
  '42501', null, 'another community''s owner is refused the overview');
select throws_ok($$ select * from app.community_collection_figures('a7320000-0000-4000-8000-00000000000a') $$,
  '42501', null, 'and the per-collection figures');
select throws_ok($$ select * from app.community_recent_activity('a7320000-0000-4000-8000-00000000000a', 5) $$,
  '42501', null, 'and the activity');
select throws_ok($$ select * from app.community_verification_readiness('a7320000-0000-4000-8000-00000000000a') $$,
  '42501', null, 'and the verification readiness');
select throws_ok($$ select * from app.community_overview('a7320000-0000-4000-8000-0000000000ff') $$,
  '42501', null, 'an unknown community is refused exactly like a forbidden one (no existence leak)');

reset role;
set local role anon;
select throws_ok($$ select * from app.my_communities() $$, '42501', null, 'anon cannot execute my_communities');
select throws_ok($$ select * from app.community_overview('a7320000-0000-4000-8000-00000000000a') $$,
  '42501', null, 'anon cannot execute community_overview');
reset role;


-- ── Recent activity (owner) ────────────────────────────────────────────────

set local role authenticated;
select pg_temp.as_user(1);
select is((select count(*)::integer from app.community_recent_activity('a7320000-0000-4000-8000-00000000000a', 5)),
  5, 'activity is limited to the requested five');
select ok(
  (select bool_and(s.ok) from (
     select coalesce(occurred_at >= lead(occurred_at) over (), true) as ok
     from app.community_recent_activity('a7320000-0000-4000-8000-00000000000a', 20)) s),
  'activity is newest first');
select is(
  (select count(*)::integer from app.community_recent_activity('a7320000-0000-4000-8000-00000000000a', 20)
    where coalesce(actor_name, '') || coalesce(detail, '') ~ '@|\+234|KLK-|[0-9]{10}'),
  0, 'no email, phone, payment reference or account number in the feed');
select is(
  (select count(*)::integer from app.community_recent_activity('a7320000-0000-4000-8000-00000000000a', 20)
    where kind = 'contribution' and actor_name in ('Fatima Bello', 'Kunle Ade')),
  0, 'pending and refused checkouts never appear as contributions');
select throws_ok($$ select * from app.community_recent_activity('a7320000-0000-4000-8000-00000000000a', 21) $$,
  '22023', null, 'a limit above 20 is refused');


-- ── Verification readiness ─────────────────────────────────────────────────

select is(
  (select concat_ws(':', verification_status, can_submit, owner_email_confirmed, owner_has_verified_payout,
                    unverified_daily_limit_kobo, requested_today_kobo)
     from app.community_verification_readiness('a7320000-0000-4000-8000-00000000000a')),
  'unverified:t:t:f:100000000:500000',
  'owner: unverified, may submit, email confirmed, no verified payout account, ₦5,000 of ₦1,000,000 used today (D-07 predicate)');
select pg_temp.as_user(4);
select is(
  (select concat_ws(':', can_submit, coalesce(owner_email_confirmed::text, 'null'), coalesce(owner_has_verified_payout::text, 'null'))
     from app.community_verification_readiness('a7320000-0000-4000-8000-00000000000a')),
  'f:null:null', 'viewer cannot submit and is not told about the owner''s accounts');


-- ── Reading moves nothing ──────────────────────────────────────────────────

reset role;
select is(
  (select concat_ws(':', journals, entries, positions, withdrawals) from tmp_before),
  (select concat_ws(':',
     (select count(*) from public.ledger_journals),
     (select count(*) from public.ledger_entries),
     (select coalesce(md5(string_agg(p::text, '|' order by p.collection_id)), '') from public.v_collection_position p
        where p.community_id = 'a7320000-0000-4000-8000-00000000000a'),
     (select coalesce(md5(string_agg(w::text, '|' order by w.id)), '') from public.withdrawals w))),
  'no journal, entry, position or withdrawal changed after every read above');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and p.proname in ('my_communities', 'community_collection_figures', 'community_overview',
                        'community_recent_activity', 'community_verification_readiness', 'my_identity_summary')
      and p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=""']),
  6, 'all six functions are STABLE, security definer, with an empty search_path');

select * from finish();
rollback;

