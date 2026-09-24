-- ─────────────────────────────────────────────────────────────────────────────
-- 18 — Who bears the fees (M7.7 §5, §30, §31)
--
-- `collections.fee_mode` has existed since the first migration and until now
-- nothing could change it. M7.7 adds `app.set_collection_fee_mode`, and this
-- is what decides whether it behaves: who may call it, when it refuses, what
-- it records, and — the part that matters most for a milestone that is not
-- Phase 4 — what it does NOT create.
--
-- The last section is a gate, NARROWED BY M8.1. It originally asserted that
-- nothing in Phase 4's territory existed at all. M8.1 built the ledger, by the
-- decision in ADR 0015, so the gate now asserts the boundary that is still
-- closed: no payment, contribution, wallet, withdrawal, payout or refund, and
-- nothing anywhere that can write to the ledger. The reasoning is at the
-- section itself.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(28);

-- ── The role matrix ─────────────────────────────────────────────────────────
--
-- Shaping a collection is `collection.draft`. Who bears the fees is a
-- decision about the collection's shape, not about moving money, so it sits
-- behind the same permission as setting its amount rather than behind a new
-- one nobody has been granted.

select bag_eq(
  $$ select role::text from public.role_permissions where permission = 'collection.draft' $$,
  $$ values ('owner'), ('admin'), ('treasurer') $$,
  'drafting a collection is held by owner, admin and treasurer'
);

select has_function(
  'app', 'set_collection_fee_mode', array['uuid', 'public.fee_mode'],
  'M7.7 adds a way to answer "who pays the fees?" for one collection'
);

select is(
  (select prosecdef from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'set_collection_fee_mode'),
  true,
  'it is SECURITY DEFINER, like every other app.* write'
);

-- SEC-18: a function that writes must not be reachable by an unauthenticated
-- caller, whatever the screen in front of it does.
select is(
  has_function_privilege('anon', 'app.set_collection_fee_mode(uuid, public.fee_mode)', 'execute'),
  false,
  'anon cannot call it'
);

select is(
  has_function_privilege('authenticated', 'app.set_collection_fee_mode(uuid, public.fee_mode)', 'execute'),
  true,
  'a signed-in caller can, and the function then decides'
);


-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('e1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@fees.example.test'),
  ('e1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@fees.example.test'),
  ('e1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@fees.example.test');

insert into public.users (id, full_name, email) values
  ('e1000000-0000-4000-8000-000000000001', 'Fees Owner',    'owner@fees.example.test'),
  ('e1000000-0000-4000-8000-000000000002', 'Fees Viewer',   'viewer@fees.example.test'),
  ('e1000000-0000-4000-8000-000000000003', 'Fees Outsider', 'outsider@fees.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('e2000000-0000-4000-8000-00000000000a', 'fee-tests',       'Fee Tests',  'social_group', false, 'e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-00000000000b', 'fee-tests-other', 'Other Fees', 'social_group', false, 'e1000000-0000-4000-8000-000000000003');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('e2000000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-000000000001', 'owner',  'Fees Owner',    'created'),
  ('e2000000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-000000000002', 'viewer', 'Fees Viewer',   'invited'),
  ('e2000000-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-000000000003', 'owner',  'Fees Outsider', 'created');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_dinner as
  select app.create_collection(
    'e2000000-0000-4000-8000-00000000000a', 'Founders Dinner', 'event', 'open', 'tiers',
    null, 'full_only', 'one_time', null
  ) as id;

reset role;
grant select on tmp_dinner to authenticated, anon;


-- ── The starting position ───────────────────────────────────────────────────

select is(
  (select fee_mode from public.collections where id = (select id from tmp_dinner)),
  'community_absorbs'::public.fee_mode,
  'a new collection starts on the community default, which is the conservative answer (DEC-12)'
);

select is(
  (select default_fee_mode from public.communities where id = 'e2000000-0000-4000-8000-00000000000a'),
  'community_absorbs'::public.fee_mode,
  'and the community default is itself community_absorbs until counsel rules'
);


-- ── Setting it ──────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  $f$ select app.set_collection_fee_mode((select id from tmp_dinner), 'contributor_pays') $f$,
  'the owner decides the contributor bears them'
);

select is(
  (select fee_mode from public.collections where id = (select id from tmp_dinner)),
  'contributor_pays'::public.fee_mode,
  'and the collection says so'
);

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'collection.fee_mode_set' and object_id = (select id from tmp_dinner)),
  1,
  'the change is audited once'
);

select is(
  (select before_state ->> 'fee_mode' from public.audit_logs
   where action = 'collection.fee_mode_set' and object_id = (select id from tmp_dinner)
   order by created_at desc limit 1),
  'community_absorbs',
  'the audit row records what it was'
);

select is(
  (select after_state ->> 'fee_mode' from public.audit_logs
   where action = 'collection.fee_mode_set' and object_id = (select id from tmp_dinner)
   order by created_at desc limit 1),
  'contributor_pays',
  'and what it became'
);

-- A wizard step that saves itself on every Continue will re-send the same
-- answer repeatedly. That must not fill the audit log with changes that did
-- not happen.
select lives_ok(
  $f$ select app.set_collection_fee_mode((select id from tmp_dinner), 'contributor_pays') $f$,
  'setting the same answer again is accepted'
);

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'collection.fee_mode_set' and object_id = (select id from tmp_dinner)),
  1,
  'and writes no second audit row — an unchanged value is not a change'
);

select lives_ok(
  $f$ select app.set_collection_fee_mode((select id from tmp_dinner), 'community_absorbs') $f$,
  'the organiser may change their mind while it is still a draft'
);

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'collection.fee_mode_set' and object_id = (select id from tmp_dinner)),
  2,
  'which is audited as the second change it is'
);


-- ── Who may not ─────────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok(
  $f$ select app.set_collection_fee_mode((select id from tmp_dinner), 'contributor_pays') $f$,
  '42501',
  null,
  'a viewer cannot change who bears the fees'
);

-- The tenancy check is the row's, never the caller's claim about it (SEC-18).
-- Another community's owner is an outsider here and is refused for the same
-- reason a stranger would be.
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  $f$ select app.set_collection_fee_mode((select id from tmp_dinner), 'contributor_pays') $f$,
  '42501',
  null,
  'another community''s owner cannot reach into this one'
);

-- The refusal is the second line, not the first. To an outsider's session the
-- collection does not exist at all: RLS scopes it to the communities they hold
-- a role in, so the row they tried to change is not one they can even read.
select is(
  (select fee_mode from public.collections where id = (select id from tmp_dinner)),
  null,
  'and the outsider cannot so much as read the row they were refused'
);

set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select fee_mode from public.collections where id = (select id from tmp_dinner)),
  'community_absorbs'::public.fee_mode,
  'and neither refusal moved it'
);

select throws_ok(
  $f$ select app.set_collection_fee_mode('e2000000-0000-4000-8000-0000000000ff', 'contributor_pays') $f$,
  'P0002',
  null,
  'a collection that does not exist is not found, whoever is asking'
);


-- ── When it refuses ─────────────────────────────────────────────────────────
--
-- Once a collection is closed its terms are history. Changing who bore the
-- fees after the fact would restate what people were told they were paying.

reset role;
update public.collections set status = 'closed' where id = (select id from tmp_dinner);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  $f$ select app.set_collection_fee_mode((select id from tmp_dinner), 'contributor_pays') $f$,
  'P0001',
  null,
  'a closed collection cannot have its fee split rewritten'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- The Phase 4 gate — NARROWED BY M8.1, deliberately and on the record
--
-- This gate originally asserted that NOTHING in Phase 4's territory existed,
-- including the ledger. M8.1 built the ledger, so that half of the gate is
-- crossed on purpose: ADR 0006 deferred the ledger until the settlement model
-- was chosen, and ADR 0015 chose it (D-01). The ledger's own invariants are
-- decided by 20_ledger.sql, which did not exist when this gate was written.
--
-- What is NOT crossed, and is still asserted here, is everything that records
-- or moves an actual payment. M8.1 built the RECORD and its invariants; it built
-- no payment, no contribution, no withdrawal, no payout, no refund, no provider
-- call, and nothing that posts a journal.
--
-- The distinction that makes this a narrowing rather than a removal: the ledger
-- exists and is empty, and nothing in the database can write to it.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*)::integer from information_schema.tables
   where table_schema = 'public'
     and table_name in (
       'payment_attempts', 'payments', 'contributions', 'contribution_intents',
       'contribution_lines', 'provider_transactions', 'tickets',
       'wallets', 'withdrawals', 'withdrawal_accounts', 'payouts',
       'settlements', 'provider_settlements', 'balance_releases',
       'refunds', 'disputes', 'holds', 'webhook_events'
     )),
  0,
  'no payment, contribution, wallet, withdrawal, payout, settlement or refund table exists — M8.1 built the ledger, not the money movement'
);

-- D-02/ADR 0015: there is no community wallet, under any name, ever.
select hasnt_column('public', 'communities', 'balance_kobo',
  'a community carries no balance (D-02): financial ownership is the collection, and a community wallet is forbidden rather than merely absent');

select is(
  (select count(*)::integer from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app'
     and (p.proname like '%payment%' or p.proname like '%payout%'
          or p.proname like '%withdraw%' or p.proname like '%settle%'
          or p.proname like '%refund%'   or p.proname like '%contribution%')),
  0,
  'and no app.* function initiates a payment, settles, withdraws, pays out or refunds'
);

-- The ledger exists. Nothing writes to it. Every future writer is an app.*
-- SECURITY DEFINER function in a reviewed migration, and none has been written,
-- so the guard functions that REFUSE writes are the only ledger code there is.
select is_empty(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app', 'private')
      and p.prosrc ~* 'insert\s+into\s+public\.ledger_'
    order by 1
  $$,
  'no database function posts a journal — M8.1 built the record and its invariants, not a writer (the capture, fee, release, withdrawal and payout writers are later milestones)'
);

select is(
  (select count(*)::integer from public.ledger_entries)
  + (select count(*)::integer from public.ledger_journals),
  0,
  'and the ledger is empty: no opening balances, no imported history, nothing asserted that nobody can trace (D-23)'
);

-- The fee split is configuration. It says how a future payment WOULD be
-- divided; it does not divide one, and nothing on the collection records an
-- amount anybody has paid.
select hasnt_column(
  'public', 'collections', 'amount_collected_kobo',
  'a collection carries no running total, because nothing has been collected'
);

select * from finish();
rollback;
