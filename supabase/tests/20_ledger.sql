-- ─────────────────────────────────────────────────────────────────────────────
-- 20 — The ledger (M8.1 steps 5 to 9, and 11)
--
-- The financial source of truth. This file decides whether the invariants are
-- real:
--
--   · every journal balances, or it does not commit
--   · nothing is ever edited or deleted
--   · a correction is a reversing journal
--   · a duplicate financial event has no second effect
--   · every movement of an organiser's money names its collection
--   · a balance is a sum over entries, and there is no balance column
--   · one community cannot see another's ledger, and a collector sees no money
--
-- ── ON TESTING A DEFERRED CONSTRAINT ────────────────────────────────────────
--
-- `ledger_entries_journal_balances` is DEFERRABLE INITIALLY DEFERRED: it fires
-- at COMMIT, because a journal is written as several rows and a per-row check
-- would refuse the first one. pgTAP runs inside a transaction it rolls back, so
-- there is no commit to observe.
--
-- `SET CONSTRAINTS ALL IMMEDIATE` is what makes it observable: it forces every
-- pending deferred check to run at that point. So the pattern below is "write
-- the journal, then ask the database to check now", which is exactly what
-- COMMIT would do.
--
-- Order matters. Once constraints are IMMEDIATE they stay immediate, and the
-- first entry of a balanced pair would then fail on its own — so each block
-- restores DEFERRED afterwards.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(50);

-- ── Structure ───────────────────────────────────────────────────────────────

select has_table('public', 'ledger_accounts', 'the chart of accounts');
select has_table('public', 'ledger_journals', 'financial events');
select has_table('public', 'ledger_entries',  'debits and credits');

select col_type_is('public', 'ledger_entries', 'amount_kobo', 'app.kobo',
  'an entry amount is integer kobo (ADR 0003)');

-- D-02 / ADR 0015: financial ownership is the collection.
select has_column('public', 'ledger_accounts', 'collection_id',
  'an account can be scoped to a collection, because that is where financial ownership sits (D-02)');
select has_column('public', 'ledger_journals', 'collection_id',
  'and a journal names the collection whose money moved');

-- D-25: idempotency is a unique index, not a lookup.
select has_index('public', 'ledger_journals', 'ledger_journals_idempotency_key',
  'the idempotency key is a UNIQUE INDEX, so a duplicate is refused by the database rather than by a handler (D-25)');

-- The invariant that must never be reachable: a stored balance.
select hasnt_column('public', 'ledger_accounts', 'balance_kobo',
  'an account carries no balance column — a balance is a sum over entries, and the previous system''s five mutable numbers per collection are what this replaces');
select hasnt_column('public', 'communities', 'balance_kobo',
  'and a community carries no balance at all (D-02): there is no community wallet');
select hasnt_column('public', 'communities', 'wallet_balance_kobo',
  'under any name');


-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@ledger.example.test'),
  ('a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@ledger.example.test'),
  ('a1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@ledger.example.test'),
  ('a1000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@ledger.example.test');

insert into public.users (id, full_name, email) values
  ('a1000000-0000-4000-8000-000000000001', 'Ledger Owner',     'owner@ledger.example.test'),
  ('a1000000-0000-4000-8000-000000000002', 'Ledger Viewer',    'viewer@ledger.example.test'),
  ('a1000000-0000-4000-8000-000000000003', 'Ledger Collector', 'collector@ledger.example.test'),
  ('a1000000-0000-4000-8000-000000000004', 'Ledger Outsider',  'outsider@ledger.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a2000000-0000-4000-8000-00000000000a', 'ledger-tests',  'Ledger Tests',  'social_group', false, 'a1000000-0000-4000-8000-000000000001'),
  ('a2000000-0000-4000-8000-00000000000b', 'ledger-others', 'Ledger Others', 'social_group', false, 'a1000000-0000-4000-8000-000000000004');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 'owner',     'Ledger Owner',     'created'),
  ('a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000002', 'viewer',    'Ledger Viewer',    'invited'),
  ('a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000003', 'collector', 'Ledger Collector', 'invited'),
  ('a2000000-0000-4000-8000-00000000000b', 'a1000000-0000-4000-8000-000000000004', 'owner',     'Ledger Outsider',  'created');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_ledger_collection as
  select app.create_collection(
    'a2000000-0000-4000-8000-00000000000a', 'Ledger Dinner', 'event', 'open', 'fixed',
    p_fixed_amount_kobo => 500000
  ) as id;

reset role;
grant select on tmp_ledger_collection to authenticated, anon;

-- The accounts this collection's money moves through.
insert into public.ledger_accounts (id, community_id, collection_id, code, type) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', (select id from tmp_ledger_collection), 'collection_pending',   'liability'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-00000000000a', (select id from tmp_ledger_collection), 'collection_available', 'liability');

insert into public.ledger_accounts (id, community_id, collection_id, code, type) values
  ('a3000000-0000-4000-8000-000000000003', null, null, 'provider_receivable', 'asset'),
  ('a3000000-0000-4000-8000-000000000004', null, null, 'platform_fee_income', 'income');


-- ── The chart of accounts is a closed vocabulary ────────────────────────────

select throws_ok(
  $$ insert into public.ledger_accounts (community_id, collection_id, code, type)
     values ('a2000000-0000-4000-8000-00000000000a', null, 'collection_availabe', 'liability') $$,
  'P0001',
  null,
  'a misspelled account code is refused rather than silently creating a second, empty, plausible account'
);

select throws_ok(
  $$ insert into public.ledger_accounts (community_id, collection_id, code, type)
     values ('a2000000-0000-4000-8000-00000000000a', null, 'collection_pending', 'liability') $$,
  'P0001',
  null,
  'a collection-scoped code cannot be created at community scope (D-02: which collection?)'
);

select throws_ok(
  $$ insert into public.ledger_accounts (community_id, collection_id, code, type)
     values (null, null, 'platform_fee_income', 'liability') $$,
  'P0001',
  null,
  'and an account cannot contradict its code''s accounting type'
);

select throws_ok(
  $$ insert into public.ledger_accounts (community_id, collection_id, code, type)
     values (null, null, 'provider_receivable', 'asset') $$,
  '23505',
  null,
  'one account per code per scope — `nulls not distinct`, so two platform accounts with the same code cannot both exist'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 8: every journal balances
-- ─────────────────────────────────────────────────────────────────────────────

-- A balanced capture: ₦5,000 owed by the provider, credited to the collection.
insert into public.ledger_journals
  (id, community_id, collection_id, occurred_at, source_type, reason, actor_type, fee_schedule_version, idempotency_key)
values
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a',
   (select id from tmp_ledger_collection), now(), 'capture', 'a contributor paid ₦5,000',
   'system', '2026-09-founder', 'capture:test-reference-0001');

insert into public.ledger_entries (journal_id, account_id, direction, amount_kobo) values
  ('a4000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000003', 'debit',  500000),
  ('a4000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'credit', 500000);

select lives_ok(
  $$ set constraints all immediate $$,
  'a balanced journal passes the check COMMIT would run'
);

select is(
  (select count(*)::integer from public.v_ledger_imbalances),
  0,
  'and nothing appears in the imbalance view, which should be empty for ever'
);

reset role;
set constraints all deferred;

-- Unbalanced: one side only.
savepoint before_unbalanced;

insert into public.ledger_journals
  (id, community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key)
values
  ('a4000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-00000000000a',
   (select id from tmp_ledger_collection), now(), 'capture', 'a debit with no credit',
   'system', 'capture:unbalanced-0001');

insert into public.ledger_entries (journal_id, account_id, direction, amount_kobo) values
  ('a4000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000003', 'debit', 100000);

select throws_ok(
  $$ set constraints all immediate $$,
  'P0001',
  null,
  'an unbalanced journal cannot commit: SUM(debits) must equal SUM(credits)'
);

rollback to savepoint before_unbalanced;
set constraints all deferred;

-- Off by one kobo. The interesting case, because it is the one a rounding bug
-- produces rather than a typo.
savepoint before_one_kobo;

insert into public.ledger_journals
  (id, community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key)
values
  ('a4000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-00000000000a',
   (select id from tmp_ledger_collection), now(), 'capture', 'one kobo out',
   'system', 'capture:one-kobo-0001');

insert into public.ledger_entries (journal_id, account_id, direction, amount_kobo) values
  ('a4000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000003', 'debit',  100000),
  ('a4000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000001', 'credit', 99999);

select throws_ok(
  $$ set constraints all immediate $$,
  'P0001',
  null,
  'a journal one kobo out is refused — the tolerance is zero kobo, which is what the old ₦3.59 gap violated'
);

rollback to savepoint before_one_kobo;
set constraints all deferred;

-- A journal with no entries at all.
savepoint before_empty;

insert into public.ledger_journals
  (id, community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key)
values
  ('a4000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-00000000000a',
   (select id from tmp_ledger_collection), now(), 'capture', 'nothing at all',
   'system', 'capture:empty-0001');

select throws_ok(
  $$ set constraints all immediate $$,
  'P0001',
  null,
  'an empty journal is refused — a financial event with no debits and no credits records nothing'
);

rollback to savepoint before_empty;
set constraints all deferred;


-- ── Entry sanity ────────────────────────────────────────────────────────────

select throws_ok(
  $$ insert into public.ledger_entries (journal_id, account_id, direction, amount_kobo)
     values ('a4000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'credit', 0) $$,
  '23514',
  null,
  'a zero-amount entry is refused — it records nothing and would pass a balance check'
);

select throws_ok(
  $$ insert into public.ledger_entries (journal_id, account_id, direction, amount_kobo)
     values ('a4000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'credit', -100) $$,
  '23514',
  null,
  'and a negative amount is refused: the DIRECTION carries the sign, and two ways of saying it is how a sum goes wrong'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 9: append-only
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ update public.ledger_entries set amount_kobo = 1 where journal_id = 'a4000000-0000-4000-8000-000000000001' $$,
  'P0001',
  null,
  'an entry cannot be edited (LED-03)'
);

select throws_ok(
  $$ delete from public.ledger_entries where journal_id = 'a4000000-0000-4000-8000-000000000001' $$,
  'P0001',
  null,
  'and it cannot be deleted'
);

select throws_ok(
  $$ update public.ledger_journals set reason = 'something else' where id = 'a4000000-0000-4000-8000-000000000001' $$,
  'P0001',
  null,
  'a journal cannot be edited either — not even its reason'
);

select throws_ok(
  $$ delete from public.ledger_journals where id = 'a4000000-0000-4000-8000-000000000001' $$,
  'P0001',
  null,
  'nor deleted'
);

select throws_ok(
  $$ update public.ledger_accounts set code = 'collection_available' where id = 'a3000000-0000-4000-8000-000000000001' $$,
  'P0001',
  null,
  'and an account cannot be repointed at another code, which would silently restate every entry against it'
);

select is(
  (select amount_kobo::bigint from public.ledger_entries
   where journal_id = 'a4000000-0000-4000-8000-000000000001' and direction = 'credit'),
  500000::bigint,
  'and after five refusals the entry is exactly as it was posted'
);

select ok(
  not has_table_privilege('authenticated', 'public.ledger_entries', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.ledger_entries', 'DELETE')
  and not has_table_privilege('authenticated', 'public.ledger_entries', 'INSERT'),
  'the privilege is withheld as well, so the trigger is the second lock and not the only one (DAT-02)'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Corrections are reversing journals
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.ledger_journals
  (id, community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key, reverses_journal_id)
values
  ('a4000000-0000-4000-8000-00000000000f', 'a2000000-0000-4000-8000-00000000000a',
   (select id from tmp_ledger_collection), now(), 'reversal', 'the capture was attributed to the wrong collection',
   'staff', 'reversal:capture:test-reference-0001', 'a4000000-0000-4000-8000-000000000001');

-- The same entries, directions swapped.
insert into public.ledger_entries (journal_id, account_id, direction, amount_kobo) values
  ('a4000000-0000-4000-8000-00000000000f', 'a3000000-0000-4000-8000-000000000003', 'credit', 500000),
  ('a4000000-0000-4000-8000-00000000000f', 'a3000000-0000-4000-8000-000000000001', 'debit',  500000);

select lives_ok(
  $$ set constraints all immediate $$,
  'a reversing journal balances like any other'
);

reset role;
set constraints all deferred;

select is(
  (select balance_kobo::bigint from public.v_ledger_account_balances
   where account_id = 'a3000000-0000-4000-8000-000000000001'),
  0::bigint,
  'and the balance is back to zero — by a second journal, not by deleting the first'
);

select is(
  (select count(*)::integer from public.ledger_journals
   where id in ('a4000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-00000000000f')),
  2,
  'both journals remain, so "why is this zero?" has an answer'
);

select is(
  (select reverses_journal_id from public.ledger_journals where id = 'a4000000-0000-4000-8000-00000000000f'),
  'a4000000-0000-4000-8000-000000000001'::uuid,
  'and the correction says what it corrected'
);

select throws_ok(
  $$ insert into public.ledger_journals
       (id, community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key, reverses_journal_id)
     values ('a4000000-0000-4000-8000-0000000000ee', 'a2000000-0000-4000-8000-00000000000a',
             (select id from tmp_ledger_collection), now(), 'reversal', 'reverses itself',
             'staff', 'reversal:self', 'a4000000-0000-4000-8000-0000000000ee') $$,
  '23514',
  null,
  'a journal cannot reverse itself'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 10 applied to the ledger: a duplicate event has no second effect
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ insert into public.ledger_journals
       (community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key)
     values ('a2000000-0000-4000-8000-00000000000a', (select id from tmp_ledger_collection),
             now(), 'capture', 'the same provider event, delivered twice',
             'system', 'capture:test-reference-0001') $$,
  '23505',
  null,
  'the same idempotency key cannot post twice — Paystack retries for up to 72 hours (D-26) and this is what makes that safe'
);

-- The pattern the application must use: the insert is attempted and the conflict
-- IS the answer. No read-then-write, because every read-then-write is a race.
select lives_ok(
  $$ insert into public.ledger_journals
       (community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key)
     values ('a2000000-0000-4000-8000-00000000000a', (select id from tmp_ledger_collection),
             now(), 'capture', 'delivered twice', 'system', 'capture:test-reference-0001')
     on conflict (idempotency_key) do nothing $$,
  'and `on conflict do nothing` turns the second delivery into a no-op rather than an error (D-25)'
);

select is(
  (select count(*)::integer from public.ledger_journals where idempotency_key = 'capture:test-reference-0001'),
  1,
  'leaving exactly one journal for that event'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 11: collection attribution is mandatory where it applies
--
-- This is the structural answer to roughly ₦19.8m of legacy deposits that had
-- no collection attribution. Money cannot be recorded as an organiser's without
-- naming whose collection it is.
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ insert into public.ledger_journals
       (community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key)
     values ('a2000000-0000-4000-8000-00000000000a', null, now(), 'capture',
             'a capture with nowhere to belong', 'system', 'capture:unattributed-0001') $$,
  '23514',
  null,
  'a capture with no collection is refused — this is what makes a second unattributed set impossible (D-02)'
);

select throws_ok(
  $$ insert into public.ledger_journals
       (community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key)
     values ('a2000000-0000-4000-8000-00000000000a', null, now(), 'withdrawal',
             'a withdrawal from nothing', 'system', 'withdrawal:unattributed-0001') $$,
  '23514',
  null,
  'and so is a withdrawal, because a withdrawal is always from one collection (D-03)'
);

select throws_ok(
  $$ insert into public.ledger_journals
       (community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key)
     values ('a2000000-0000-4000-8000-00000000000a', null, now(), 'balance_release',
             'a release of nothing', 'system', 'release:unattributed-0001') $$,
  '23514',
  null,
  'and a balance release'
);

-- The two exceptions, and they are cases where there IS no collection rather
-- than cases where naming one is inconvenient.
insert into public.ledger_journals
  (id, community_id, collection_id, occurred_at, source_type, reason, actor_type, idempotency_key)
values
  ('a4000000-0000-4000-8000-0000000000aa', 'a2000000-0000-4000-8000-00000000000a', null, now(), 'fee',
   'Kolekto''s own income', 'system', 'fee:platform-0001');

insert into public.ledger_entries (journal_id, account_id, direction, amount_kobo) values
  ('a4000000-0000-4000-8000-0000000000aa', 'a3000000-0000-4000-8000-000000000001', 'debit',  7500),
  ('a4000000-0000-4000-8000-0000000000aa', 'a3000000-0000-4000-8000-000000000004', 'credit', 7500);

select lives_ok(
  $$ set constraints all immediate $$,
  'a platform fee journal may have no collection — Kolekto''s own economics are not an organiser''s money'
);

reset role;
set constraints all deferred;


-- ─────────────────────────────────────────────────────────────────────────────
-- Balances are sums, and they are per collection
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select pending_kobo::bigint from public.v_collection_position
   where collection_id = (select id from tmp_ledger_collection)),
  (-7500)::bigint,
  'the collection''s pending balance is the sum of its entries — here negative, because the fee was taken after the capture was reversed, which is a real state and not a sign error'
);

select is(
  (select count(*)::integer from public.v_collection_position
   where collection_id = (select id from tmp_ledger_collection)),
  1,
  'every collection has a position, including one with no money, so a screen never distinguishes "nothing yet" from "not found"'
);

select is_empty(
  $$ select 1 from information_schema.views
     where table_schema = 'public' and table_name like 'v_community%balance%' $$,
  'there is no community balance view — a community total is a report, never the thing money is authorised against (D-02)'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Security: who may see money
-- ─────────────────────────────────────────────────────────────────────────────

set local role authenticated;

-- A viewer holds balance.view, per the role matrix.
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer from public.ledger_journals
   where community_id = 'a2000000-0000-4000-8000-00000000000a'),
  3,
  'a viewer holds balance.view and sees this community''s journals'
);

-- A collector never touches money. No screen decides that; the policy does.
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  (select count(*)::integer from public.ledger_journals),
  0,
  'a collector holds no balance.view and sees no journal at all — a collector never touches money'
);

select is(
  (select count(*)::integer from public.ledger_entries),
  0,
  'and no entry, because an entry is visible only when its journal is'
);

-- Another community's owner is an outsider here, refused for the same reason a
-- stranger would be (SEC-18).
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000004","role":"authenticated"}';

select is(
  (select count(*)::integer from public.ledger_journals),
  0,
  'another community''s owner sees nothing of this community''s ledger'
);

select is(
  (select count(*)::integer from public.v_collection_position
   where collection_id = (select id from tmp_ledger_collection)),
  0,
  'and the balance view is scoped by the same RLS, because it runs with the caller''s rights (security_invoker)'
);

select is(
  (select count(*)::integer from public.ledger_accounts),
  0,
  'and cannot even enumerate the chart of accounts for a community they do not hold a role in'
);

reset role;

select ok(
  not has_table_privilege('anon', 'public.ledger_entries', 'SELECT')
  and not has_table_privilege('anon', 'public.ledger_journals', 'SELECT')
  and not has_table_privilege('anon', 'public.ledger_accounts', 'SELECT'),
  'anon holds nothing on the ledger, as everywhere (SEC-12)'
);

select * from finish();
rollback;
