-- ─────────────────────────────────────────────────────────────────────────────
-- 59 — Contributor references locked once a collection has active
--      contributors (20261117100400, Phase 7)
--
--   · before any confirmed payment: references can be switched on and shaped
--   · a failed checkout is not activity
--   · after a confirmed payment: switching on, creating settings, changing
--     prefix / separator / digits / start number / style, and giving a tier a
--     code prefix are refused with CONTRIBUTOR_REFERENCES_LOCKED
--   · still allowed: re-saving the same settings, switching references off,
--     clearing a tier prefix, re-saving a tier with its existing prefix
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(19);

insert into auth.users (id, instance_id, aud, role, email) values
  ('a5910000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@lock.example.test');
insert into public.users (id, full_name, email) values
  ('a5910000-0000-4000-8000-000000000001', 'Lock Owner', 'owner@lock.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a5920000-0000-4000-8000-00000000000a', 'lock-tests', 'Lock Tests', 'social_group', false, 'a5910000-0000-4000-8000-000000000001');

-- fresh: no money yet · off: codes never set up, then paid · on: codes set up, then paid
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values
  ('a5950000-0000-4000-8000-000000000001', 'a5920000-0000-4000-8000-00000000000a', 'lock-fresh', 'Lock Fresh',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a5910000-0000-4000-8000-000000000001'),
  ('a5950000-0000-4000-8000-000000000002', 'a5920000-0000-4000-8000-00000000000a', 'lock-off', 'Lock Off',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a5910000-0000-4000-8000-000000000001'),
  ('a5950000-0000-4000-8000-000000000003', 'a5920000-0000-4000-8000-00000000000a', 'lock-on', 'Lock On',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a5910000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a5920000-0000-4000-8000-00000000000a', 'a5910000-0000-4000-8000-000000000001', 'owner', 'Lock Owner', 'created', null);

create function pg_temp.attempt(p_collection uuid, p_ref integer) returns uuid language sql as $$
  select attempt_id from app.create_payment_attempt(
    p_collection, 'checkout-key-lock-' || p_ref, 'KLK-' || lpad(p_ref::text, 26, '0'), 'fake', null,
    'Payer ' || p_ref, 'payer' || p_ref || '@lock.example.test', '+2348000000059', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000, 'community_absorbs', '2026-11-founder')
$$;
create function pg_temp.capture(p_attempt uuid, p_ref integer) returns void language plpgsql as $$
begin
  perform app.record_provider_transaction(
    'KLK-' || lpad(p_ref::text, 26, '0'), 'fake', 'FAKE_TXN_' || p_ref, 'KLK-' || lpad(p_ref::text, 26, '0'),
    'succeeded', 'succeeded', 500000, 'NGN', null, now(), 'card', null, '{"__fake": true}'::jsonb);
  perform app.complete_payment_capture(p_attempt);
end;
$$;

-- A started-but-unpaid checkout on "off" is not activity.
select pg_temp.attempt('a5950000-0000-4000-8000-000000000002', 5901) is not null;
select is(app.collection_has_contributor_activity('a5950000-0000-4000-8000-000000000002'), false,
  'an unpaid checkout is not contributor activity');


-- ── Before money: references can be set up ──────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5910000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000001', true, 'FRSH', '-', 4::smallint, 1, 'sequential') $$,
  'with no confirmed payment, references can be switched on');
select lives_ok($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000001', true, 'FRESH', '/', 5::smallint, 10, 'sequential') $$,
  'and reshaped freely');
select lives_ok($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000003', true, 'ON', '-', 4::smallint, 1, 'sequential') $$,
  '"on" is set up before its first payment');

reset role;
select pg_temp.capture(pg_temp.attempt('a5950000-0000-4000-8000-000000000002', 5902), 5902) is not null;
select pg_temp.capture(pg_temp.attempt('a5950000-0000-4000-8000-000000000003', 5903), 5903) is not null;

select is(app.collection_has_contributor_activity('a5950000-0000-4000-8000-000000000002'), true,
  'a confirmed payment is contributor activity');


-- ── After money: nothing new ────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5910000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_like($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000002', true, 'LATE', '-', 4::smallint, 1, 'sequential') $$,
  'CONTRIBUTOR_REFERENCES_LOCKED:%', 'switching references on after people have paid is refused');
select throws_like($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000002', false, 'LATE', '-', 4::smallint, 1, 'sequential') $$,
  'CONTRIBUTOR_REFERENCES_LOCKED:%', 'creating a reference format after people have paid is refused, even switched off');
select is((select codes_enabled from public.collections where id = 'a5950000-0000-4000-8000-000000000002'), false,
  'the refused change left the collection as it was');

select lives_ok($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000003', true, 'ON', '-', 4::smallint, 1, 'sequential') $$,
  're-saving the same settings is allowed');
select throws_like($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000003', true, 'NEW', '-', 4::smallint, 1, 'sequential') $$,
  'CONTRIBUTOR_REFERENCES_LOCKED:%', 'a new prefix is refused');
select throws_like($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000003', true, 'ON', '/', 4::smallint, 1, 'sequential') $$,
  'CONTRIBUTOR_REFERENCES_LOCKED:%', 'a new separator is refused');
select throws_like($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000003', true, 'ON', '-', 6::smallint, 1, 'sequential') $$,
  'CONTRIBUTOR_REFERENCES_LOCKED:%', 'a new digit count is refused');
select throws_like($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000003', true, 'ON', '-', 4::smallint, 100, 'sequential') $$,
  'CONTRIBUTOR_REFERENCES_LOCKED:%', 'a new start number is refused');
select lives_ok($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000003', false, 'ON', '-', 4::smallint, 1, 'sequential') $$,
  'switching references off is allowed (it adds nothing)');
select throws_like($$ select app.set_collection_code_settings('a5950000-0000-4000-8000-000000000003', true, 'ON', '-', 4::smallint, 1, 'sequential') $$,
  'CONTRIBUTOR_REFERENCES_LOCKED:%', 'but once off they cannot be switched back on');


-- ── Tier prefixes (enforced on the table, whatever the path) ────────────────

reset role;
-- "on" becomes a tiered collection for the tier checks (the test needs one
-- that has already taken money; changing the model is fixture-only).
update public.collections set amount_model = 'tiers', fixed_amount_kobo = null where id = 'a5950000-0000-4000-8000-000000000003';

select throws_like($$ insert into public.collection_tiers (collection_id, community_id, name, price_kobo, code_prefix)
                      values ('a5950000-0000-4000-8000-000000000003', 'a5920000-0000-4000-8000-00000000000a', 'VIP', 500000, 'VIP') $$,
  'CONTRIBUTOR_REFERENCES_LOCKED:%', 'a new tier with a code prefix is refused after money arrived');
select lives_ok($$ insert into public.collection_tiers (id, collection_id, community_id, name, price_kobo)
                   values ('a5960000-0000-4000-8000-000000000002', 'a5950000-0000-4000-8000-000000000003', 'a5920000-0000-4000-8000-00000000000a', 'Plain', 500000) $$,
  'a tier without a prefix adds no references and is allowed');
select throws_like($$ update public.collection_tiers set code_prefix = 'PLN' where id = 'a5960000-0000-4000-8000-000000000002' $$,
  'CONTRIBUTOR_REFERENCES_LOCKED:%', 'giving an existing tier a prefix is refused');

-- A tier on "on" that had its prefix before the money: park-and-restore
-- (what app.set_collection_tiers does) must not be mistaken for a new prefix.
alter table public.collection_tiers disable trigger collection_tiers_prefix_reference_lock;
update public.collection_tiers set code_prefix = 'OLD' where id = 'a5960000-0000-4000-8000-000000000002';
alter table public.collection_tiers enable trigger collection_tiers_prefix_reference_lock;
select lives_ok($$ update public.collection_tiers set code_prefix = null  where id = 'a5960000-0000-4000-8000-000000000002';
                   update public.collection_tiers set code_prefix = 'OLD' where id = 'a5960000-0000-4000-8000-000000000002' $$,
  'parking a prefix and writing the same one back in one transaction is allowed');

select * from finish();
rollback;
