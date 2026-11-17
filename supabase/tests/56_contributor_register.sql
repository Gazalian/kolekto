-- ─────────────────────────────────────────────────────────────────────────────
-- 56 — Collection financial overview, contributor register, acknowledgement
--      (20261116130000)
--
--   · only applied contributions count; failed and needs_review attempts never
--     reach Raised, Pending or the register; a repeated capture adds nothing
--   · Raised − organiser-borne fees = the ledger position (pending + …)
--   · one person = member, else checkout email (case/space-insensitive)
--   · contact details only on request and only with member.view_contact
--   · search escapes LIKE wildcards and reaches organiser answers
--   · acknowledgement is idempotent, collection-bound, audited, and changes no
--     money figure; "acknowledge all" stops at the time the list was loaded
--   · balance figures need balance.view; collector scope is honoured; another
--     community's officer, anon and direct table reads get nothing
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(49);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('a5610000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@reg.example.test'),
  ('a5610000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@reg.example.test'),
  ('a5610000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@reg.example.test'),
  ('a5610000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@reg.example.test'),
  ('a5610000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@reg.example.test');

insert into public.users (id, full_name, email) values
  ('a5610000-0000-4000-8000-000000000001', 'Reg Owner',     'owner@reg.example.test'),
  ('a5610000-0000-4000-8000-000000000002', 'Reg Admin',     'admin@reg.example.test'),
  ('a5610000-0000-4000-8000-000000000003', 'Reg Viewer',    'viewer@reg.example.test'),
  ('a5610000-0000-4000-8000-000000000004', 'Reg Collector', 'collector@reg.example.test'),
  ('a5610000-0000-4000-8000-000000000005', 'Other Owner',   'outsider@reg.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a5620000-0000-4000-8000-00000000000a', 'register-tests', 'Register Tests', 'social_group', false, 'a5610000-0000-4000-8000-000000000001'),
  ('a5620000-0000-4000-8000-00000000000b', 'register-other', 'Register Other', 'social_group', false, 'a5610000-0000-4000-8000-000000000005');

-- A: open fixed ₦5,000 with two questions. B: managed fixed ₦5,000. C: tiers.
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   min_amount_kobo, deadline_at, status, visibility, fee_mode, created_by)
values
  ('a5650000-0000-4000-8000-000000000001', 'a5620000-0000-4000-8000-00000000000a', 'class-dues', 'Class Dues',
   'dues', 'open', 'public', 'fixed', 500000, null, null, 'active', 'unlisted', 'community_absorbs', 'a5610000-0000-4000-8000-000000000001'),
  ('a5650000-0000-4000-8000-000000000002', 'a5620000-0000-4000-8000-00000000000a', 'member-levy', 'Member Levy',
   'dues', 'managed', 'all_members', 'fixed', 500000, null, null, 'active', 'unlisted', 'community_absorbs', 'a5610000-0000-4000-8000-000000000001'),
  ('a5650000-0000-4000-8000-000000000003', 'a5620000-0000-4000-8000-00000000000a', 'dinner', 'Dinner',
   'event', 'open', 'public', 'tiers', null, null, null, 'active', 'unlisted', 'community_absorbs', 'a5610000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a5620000-0000-4000-8000-00000000000a', 'a5610000-0000-4000-8000-000000000001', 'owner',     'Reg Owner',     'created', null),
  ('a5620000-0000-4000-8000-00000000000a', 'a5610000-0000-4000-8000-000000000002', 'admin',     'Reg Admin',     'invited', null),
  ('a5620000-0000-4000-8000-00000000000a', 'a5610000-0000-4000-8000-000000000003', 'viewer',    'Reg Viewer',    'invited', null),
  ('a5620000-0000-4000-8000-00000000000a', 'a5610000-0000-4000-8000-000000000004', 'collector', 'Reg Collector', 'invited',
   '{"collection_ids": ["a5650000-0000-4000-8000-000000000002"]}'::jsonb),
  ('a5620000-0000-4000-8000-00000000000b', 'a5610000-0000-4000-8000-000000000005', 'owner',     'Other Owner',   'created', null);

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
  ('a5630000-0000-4000-8000-000000000001', 'a5620000-0000-4000-8000-00000000000a', 'Kemi Member', '+2348097775601', 'RG/0001', 'active', 'manual');

insert into public.collection_fields (collection_id, community_id, key, label, type, required, sort_order) values
  ('a5650000-0000-4000-8000-000000000001', 'a5620000-0000-4000-8000-00000000000a', 'matric', 'Matric number', 'text', true, 0),
  ('a5650000-0000-4000-8000-000000000001', 'a5620000-0000-4000-8000-00000000000a', 'level',  'Level',         'text', false, 1);

insert into public.collection_tiers (id, collection_id, community_id, name, price_kobo, sort_order) values
  ('a5640000-0000-4000-8000-000000000001', 'a5650000-0000-4000-8000-000000000003', 'a5620000-0000-4000-8000-00000000000a', 'Regular seat', 200000, 0);

create function pg_temp.ref(n integer) returns text language sql as $$
  select 'KLK-' || lpad(n::text, 26, '0')
$$;

-- ₦5,000, host absorbs: 0.5% + 1.5% = ₦100; estimate 1% = ₦50.
create function pg_temp.fixed(p_collection uuid, p_ref integer, p_member uuid, p_name text, p_email text, p_answers jsonb)
returns uuid language sql as $$
  select attempt_id from app.create_payment_attempt(
    p_collection, 'checkout-key-reg-' || p_ref, pg_temp.ref(p_ref), 'fake', p_member,
    p_name, p_email, '+2348000000056', p_answers, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000,
    'community_absorbs', '2026-11-founder')
$$;

create function pg_temp.capture(p_ref integer, p_amount bigint, p_attempt uuid) returns text language plpgsql as $$
declare
  v_result text;
begin
  perform app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), 'succeeded', 'succeeded',
    p_amount, 'NGN', null, now(), 'card', null, '{"__fake": true}'::jsonb);
  select c.status::text into v_result from app.complete_payment_capture(p_attempt) c;
  return v_result;
end;
$$;

create temporary table tmp_att (label text primary key, id uuid);
insert into tmp_att values
  ('ada1',   pg_temp.fixed('a5650000-0000-4000-8000-000000000001', 5601, null, 'Ada Guest', 'Ada@Guest.example.test',
                           '{"matric": "CSC/001", "level": "300"}'::jsonb)),
  ('ada2',   pg_temp.fixed('a5650000-0000-4000-8000-000000000001', 5602, null, 'Ada G.',    ' ada@guest.example.test ',
                           '{"matric": "CSC/001"}'::jsonb)),
  ('bola',   pg_temp.fixed('a5650000-0000-4000-8000-000000000001', 5603, null, 'Bola 100%', 'bola@guest.example.test',
                           '{"matric": "CSC/002", "level": "200"}'::jsonb)),
  ('failed', pg_temp.fixed('a5650000-0000-4000-8000-000000000001', 5604, null, 'Fail Guest', 'fail@guest.example.test', '{}'::jsonb)),
  ('review', pg_temp.fixed('a5650000-0000-4000-8000-000000000001', 5605, null, 'Short Guest', 'short@guest.example.test', '{}'::jsonb)),
  ('kemi',   pg_temp.fixed('a5650000-0000-4000-8000-000000000002', 5606, 'a5630000-0000-4000-8000-000000000001',
                           'Typed Name', 'kemi@member.example.test', '{}'::jsonb));

-- ₦2,000 seat, host absorbs: fees ₦40, estimate ₦20.
insert into tmp_att values
  ('seat', (select attempt_id from app.create_payment_attempt(
     'a5650000-0000-4000-8000-000000000003', 'checkout-key-reg-5607', pg_temp.ref(5607), 'fake', null,
     'Seat Guest', 'seat@guest.example.test', '+2348000000057', '{}'::jsonb, '{}'::text[],
     '[{"tier_id": "a5640000-0000-4000-8000-000000000001", "quantity": 1}]'::jsonb, null,
     200000, 1000, 3000, 0, 4000, 200000, 196000, 2000, 'community_absorbs', '2026-11-founder')));

create function pg_temp.att(p_label text) returns uuid language sql as $$
  select id from tmp_att where label = p_label
$$;

select is(pg_temp.capture(5601, 500000, pg_temp.att('ada1')), 'completed', 'Ada''s first payment completes');
select is(pg_temp.capture(5602, 500000, pg_temp.att('ada2')), 'completed', 'Ada''s second payment completes');
select is(pg_temp.capture(5603, 500000, pg_temp.att('bola')), 'completed', 'Bola''s payment completes');
select is(pg_temp.capture(5606, 500000, pg_temp.att('kemi')), 'completed', 'Kemi pays as a saved member');
select is(pg_temp.capture(5607, 200000, pg_temp.att('seat')), 'completed', 'the seat payment completes');

do $$
begin
  perform app.mark_payment_attempt_failed(pg_temp.att('failed'), 'abandoned');
  -- The provider reports ₦4,000 against a ₦5,000 attempt: parked, not money in any figure.
  perform app.record_provider_transaction(
    pg_temp.ref(5605), 'fake', 'FAKE_TXN_5605', pg_temp.ref(5605), 'succeeded', 'succeeded',
    400000, 'NGN', null, now(), 'card', null, '{"__fake": true}'::jsonb);
end;
$$;
select is((select status::text from public.payment_attempts where id = pg_temp.att('review')), 'needs_review',
  'a short payment is parked for review, not completed');

-- A repeated T2 for a completed attempt adds nothing.
select is((select status::text from app.complete_payment_capture(pg_temp.att('ada1'))), 'completed',
  'running capture again for Ada returns the same completion');


-- ── Overview as the owner ───────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5610000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_before as
  select * from app.collection_financial_overview('a5650000-0000-4000-8000-000000000001');

select is(
  (select total_raised_kobo::bigint || ':' || fees_deducted_kobo || ':' || net_raised_kobo || ':' || contribution_count
          || ':' || contributor_count || ':' || under_review_count from tmp_before),
  '1500000:30000:1470000:3:2:1',
  'Raised counts three applied payments gross; failed and under-review excluded; Ada with two emails spellings is one person'
);

select is(
  (select pending_kobo::bigint || ':' || available_kobo || ':' || on_hold_kobo || ':' || withdrawing_kobo || ':' || withdrawn_kobo
   from tmp_before),
  '1470000:0:0:0:0',
  'the position comes from the ledger: all of it pending, nothing released or withdrawn'
);

select is(
  (select total_raised_kobo - fees_deducted_kobo
          = pending_kobo + available_kobo + on_hold_kobo + withdrawing_kobo + withdrawn_kobo from tmp_before),
  true,
  'Raised − fees borne = pending + available + on hold + withdrawing + withdrawn'
);

select is((select can_view_balances from tmp_before), true, 'the owner sees balances');


-- ── Register ────────────────────────────────────────────────────────────────

select is(
  (select count(*)::integer from app.collection_contributors('a5650000-0000-4000-8000-000000000001')),
  3,
  'the register lists the three applied contributions only'
);

select is(
  (select max(total_count) from app.collection_contributors('a5650000-0000-4000-8000-000000000001')),
  3,
  'total_count is the filtered total'
);

select is(
  (select string_agg(contributor_name, ',' order by contributor_name)
   from app.collection_contributors('a5650000-0000-4000-8000-000000000001')),
  'Ada G.,Ada Guest,Bola 100%',
  'each payment keeps its own row and the name typed for it'
);

select is(
  (select distinct contributor_payment_count || ':' || contributor_total_kobo
   from app.collection_contributors('a5650000-0000-4000-8000-000000000001') where contributor_name like 'Ada%'),
  '2:1000000',
  'both of Ada''s rows know she paid twice, ₦10,000 in all'
);

select is(
  (select count(*)::integer from app.collection_contributors('a5650000-0000-4000-8000-000000000001')
   where email is not null or phone is not null),
  0,
  'contact details are not returned unless asked for'
);

select is(
  (select email from app.collection_contributors('a5650000-0000-4000-8000-000000000001', null, null, true)
   where contributor_name = 'Bola 100%'),
  'bola@guest.example.test',
  'the owner may ask for contact details'
);

select is(
  (select answers ->> 'matric' from app.collection_contributors('a5650000-0000-4000-8000-000000000001')
   where contributor_name = 'Bola 100%'),
  'CSC/002',
  'organiser answers come back under their keys'
);

select is(
  (select string_agg(contributor_name, ',') from app.collection_contributors('a5650000-0000-4000-8000-000000000001', 'csc/002')),
  'Bola 100%',
  'search reaches answer values, case-insensitively'
);

select is(
  (select string_agg(contributor_name, ',') from app.collection_contributors('a5650000-0000-4000-8000-000000000001', '100%')),
  'Bola 100%',
  'a typed % is a literal percent sign'
);

select is(
  (select count(*)::integer from app.collection_contributors('a5650000-0000-4000-8000-000000000001', '_')),
  0,
  'a typed _ matches no name without an underscore'
);

select is(
  (select contributor_name || ':' || is_member || ':' || member_code
   from app.collection_contributors('a5650000-0000-4000-8000-000000000002')),
  'Kemi Member:true:RG/0001',
  'a saved member is shown by their profile name and code, not the name typed at checkout'
);

select is(
  (select lines -> 0 ->> 'name' || ':' || (lines -> 0 ->> 'quantity') || ':' || (lines -> 0 ->> 'amount_kobo')
          || ':' || jsonb_typeof(lines -> 0 -> 'amount_kobo')
   from app.collection_contributors('a5650000-0000-4000-8000-000000000003')),
  'Regular seat:1:200000:string',
  'a tiered payment names its option; money in lines is a kobo string'
);

select is(
  (select count(*)::integer from app.collection_contributors('a5650000-0000-4000-8000-000000000001', null, null, false, 1, 0)),
  1,
  'the register pages in the database'
);


-- ── Acknowledgement ─────────────────────────────────────────────────────────

create temporary table tmp_ids as
  select contribution_id, contributor_name from app.collection_contributors('a5650000-0000-4000-8000-000000000001');

select is(
  app.acknowledge_contributions('a5650000-0000-4000-8000-000000000001',
    array[(select contribution_id from tmp_ids where contributor_name = 'Bola 100%')]),
  1,
  'acknowledging one contribution records one'
);

select is(
  app.acknowledge_contributions('a5650000-0000-4000-8000-000000000001',
    array[(select contribution_id from tmp_ids where contributor_name = 'Bola 100%')]),
  0,
  'acknowledging it again records nothing more'
);

select is(
  app.acknowledge_contributions('a5650000-0000-4000-8000-000000000001',
    array[(select contribution_id from app.collection_contributors('a5650000-0000-4000-8000-000000000002'))]),
  0,
  'a contribution of another collection cannot be acknowledged through this one'
);

select is(
  (select acknowledged_by_name from app.collection_contributors('a5650000-0000-4000-8000-000000000001', null, true)),
  'Reg Owner',
  'the acknowledged filter returns it, with who acknowledged it'
);

select is(
  (select count(*)::integer from app.collection_contributors('a5650000-0000-4000-8000-000000000001', null, false)),
  2,
  'the not-acknowledged filter returns the other two'
);

select is(
  (select row(o.total_raised_kobo, o.fees_deducted_kobo, o.pending_kobo, o.available_kobo, o.withdrawn_kobo,
              o.contribution_count, o.contributor_count)::text
   from app.collection_financial_overview('a5650000-0000-4000-8000-000000000001') o),
  (select row(b.total_raised_kobo, b.fees_deducted_kobo, b.pending_kobo, b.available_kobo, b.withdrawn_kobo,
              b.contribution_count, b.contributor_count)::text from tmp_before b),
  'acknowledging changes no money figure and no count'
);

select is(
  (select acknowledged_count from app.collection_financial_overview('a5650000-0000-4000-8000-000000000001')),
  1,
  'the overview counts acknowledgements'
);

select throws_like(
  $$ select app.acknowledge_contributions('a5650000-0000-4000-8000-000000000001', null, null) $$,
  'INVALID:%',
  '"acknowledge all" needs the time the list was loaded'
);

select is(
  app.acknowledge_contributions('a5650000-0000-4000-8000-000000000001', null, now() - interval '1 day'),
  0,
  '"acknowledge all" as of yesterday acknowledges nothing that appeared today'
);

select is(
  app.acknowledge_contributions('a5650000-0000-4000-8000-000000000001', null, now()),
  2,
  '"acknowledge all" as of now acknowledges the remaining two'
);

reset role;

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'contribution.acknowledge' and object_id = 'a5650000-0000-4000-8000-000000000001'),
  2,
  'one audit row per call that acknowledged something'
);

select is(
  (select count(*)::integer from public.payment_attempts
   where collection_id = 'a5650000-0000-4000-8000-000000000001' and status = 'completed'),
  3,
  'attempt states are untouched by acknowledgement'
);

select throws_ok(
  $$ insert into public.contribution_acknowledgements (contribution_id, collection_id, community_id)
     select c.id, 'a5650000-0000-4000-8000-000000000001', c.community_id
     from public.contributions c where c.collection_id = 'a5650000-0000-4000-8000-000000000002' $$,
  '23503',
  null,
  'the database refuses an acknowledgement naming a collection the contribution is not in'
);


-- ── Who may see what ────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5610000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select can_view_balances::text || ':' || pending_kobo || ':' || total_raised_kobo
   from app.collection_financial_overview('a5650000-0000-4000-8000-000000000001')),
  'true:1470000:1500000',
  'an admin holds balance.view and sees the position'
);

set local request.jwt.claims = '{"sub":"a5610000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  (select pending_kobo::bigint from app.collection_financial_overview('a5650000-0000-4000-8000-000000000001')),
  1470000::bigint,
  'a viewer holds balance.view and sees the position'
);

select throws_like(
  $$ select app.acknowledge_contributions('a5650000-0000-4000-8000-000000000002',
       array[(select contribution_id from app.collection_contributors('a5650000-0000-4000-8000-000000000002'))]) $$,
  'FORBIDDEN:%',
  'a viewer cannot acknowledge'
);

set local request.jwt.claims = '{"sub":"a5610000-0000-4000-8000-000000000004","role":"authenticated"}';

select throws_like(
  $$ select * from app.collection_financial_overview('a5650000-0000-4000-8000-000000000001') $$,
  'FORBIDDEN:%',
  'a collector cannot read a collection outside their scope'
);

select is(
  (select contributor_count || ':' || total_raised_kobo || ':' || can_view_balances || ':' || coalesce(pending_kobo::text, 'null')
   from app.collection_financial_overview('a5650000-0000-4000-8000-000000000002')),
  '1:500000:false:null',
  'a collector reads the collection they are scoped to: Raised and counts, no balances (no balance.view)'
);

select is(
  app.acknowledge_contributions('a5650000-0000-4000-8000-000000000002',
    array[(select contribution_id from app.collection_contributors('a5650000-0000-4000-8000-000000000002'))]),
  1,
  'and may acknowledge there'
);

set local request.jwt.claims = '{"sub":"a5610000-0000-4000-8000-000000000005","role":"authenticated"}';

select throws_like(
  $$ select * from app.collection_financial_overview('a5650000-0000-4000-8000-000000000001') $$,
  'FORBIDDEN:%',
  'another community''s owner cannot read the overview'
);

select throws_like(
  $$ select * from app.collection_contributors('a5650000-0000-4000-8000-000000000001') $$,
  'FORBIDDEN:%',
  'nor the register'
);

select throws_like(
  $$ select app.acknowledge_contributions('a5650000-0000-4000-8000-000000000001', null, now()) $$,
  'FORBIDDEN:%',
  'nor acknowledge anything in it'
);

reset role;

select is(
  has_function_privilege('anon', 'app.collection_contributors(uuid, text, boolean, boolean, integer, integer, uuid[])', 'execute')
  or has_function_privilege('anon', 'app.collection_financial_overview(uuid)', 'execute')
  or has_function_privilege('anon', 'app.acknowledge_contributions(uuid, uuid[], timestamptz)', 'execute'),
  false,
  'anon can execute none of the three functions'
);

select is(
  has_table_privilege('authenticated', 'public.contribution_acknowledgements', 'select')
  or has_table_privilege('authenticated', 'public.contribution_acknowledgements', 'insert'),
  false,
  'no client role reads or writes the acknowledgement table directly'
);

select is(
  (select string_agg(role::text || case when scoped then '(scoped)' else '' end, ',' order by role::text)
   from public.role_permissions where permission = 'contribution.acknowledge'),
  'admin,collector(scoped),owner,treasurer',
  'contribution.acknowledge: owner, admin, treasurer, collector within scope — not viewer'
);

select * from finish();
rollback;
