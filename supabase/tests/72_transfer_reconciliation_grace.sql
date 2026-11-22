-- ─────────────────────────────────────────────────────────────────────────────
-- 72 — Transfer reconciliation: provider-verification grace period
--      (20261122100000; session 42, owner brief 2026-11-22)
--
--   · `provider_verification_pending` is an accepted discrepancy kind; an
--     unknown kind is still refused
--   · each run records the grace period it used; null when the caller
--     omits it (runs from before the change); out-of-range values refused
--   · a new run never changes, closes or acknowledges an existing open
--     discrepancy (older `missing_at_provider` warnings stay open)
--   · duplicate runs are separate append-only rows and move no money:
--     no journal, transfer or withdrawal changes
--   · still not callable by a client; row level security still forced
--
-- The comparison itself (when a transfer is pending, when Paystack is asked
-- again, what a webhook in between does) is proved in
-- packages/payments/test/reconciliation-and-approval.test.ts.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(21);

-- ── Snapshot of everything a run must not touch ─────────────────────────────

create temporary table tmp_before as select
  (select count(*) from public.ledger_journals) as journals,
  (select count(*) from public.ledger_entries) as entries,
  (select coalesce(md5(string_agg(t::text, '|' order by t.id)), '') from public.withdrawal_transfers t) as transfers,
  (select coalesce(md5(string_agg(w::text, '|' order by w.id)), '') from public.withdrawals w) as withdrawals,
  (select coalesce(md5(string_agg(d::text, '|' order by d.id)), '') from public.transfer_reconciliation_discrepancies d) as discrepancies,
  (select count(*) from public.transfer_reconciliation_runs) as runs;

create function pg_temp.run_json(p_grace integer) returns jsonb language sql as $$
  select jsonb_build_object('started_at', now(), 'window_from', now() - interval '7 days', 'window_to', now(),
                            'provider_mode', 'fake', 'provider_count', 0, 'kolekto_count', 1)
         || case when p_grace is null then '{}'::jsonb else jsonb_build_object('provider_grace_seconds', p_grace) end
$$;


-- ── Schema ──────────────────────────────────────────────────────────────────

select has_column('public', 'transfer_reconciliation_runs', 'provider_grace_seconds', 'runs record the grace period they used');
select col_type_is('public', 'transfer_reconciliation_runs', 'provider_grace_seconds', 'integer', 'in whole seconds');
select col_is_null('public', 'transfer_reconciliation_runs', 'provider_grace_seconds', 'nullable: runs from before the change have none');


-- ── An older open warning, recorded the way the 20 November one was ─────────

create temporary table tmp_old as select app.record_transfer_reconciliation_run(
    pg_temp.run_json(null),
    jsonb_build_array(jsonb_build_object('kind', 'missing_at_provider', 'severity', 'warning',
                                         'reference', 'ktr_00000000000000000000bb67',
                                         'kolekto_detail', 'status=pending withdrawal=processing',
                                         'provider_detail', 'no transfer with this reference in the provider list'))) as id;
create temporary table tmp_old_rows as
  select md5(string_agg(d::text, '|' order by d.id)) as digest
  from public.transfer_reconciliation_discrepancies d where run_id = (select id from tmp_old);
select is((select provider_grace_seconds from public.transfer_reconciliation_runs where id = (select id from tmp_old)), null::integer,
  'a run recorded without a grace period stores null (as every run before the change)');


-- ── The new kind and the grace period ───────────────────────────────────────

create temporary table tmp_new as select app.record_transfer_reconciliation_run(
    pg_temp.run_json(300),
    jsonb_build_array(jsonb_build_object('kind', 'provider_verification_pending', 'severity', 'info',
                                         'reference', 'ktr_00000000000000000000a001',
                                         'kolekto_detail', 'status=pending withdrawal=processing sent 12s ago',
                                         'provider_detail', 'not yet in the provider list; within the 300s grace period, re-checked by a later run'))) as id;
select is((select provider_grace_seconds from public.transfer_reconciliation_runs where id = (select id from tmp_new)), 300,
  'the grace period a run used is stored');
select is((select kind || ':' || severity || ':' || resolution_status
           from public.transfer_reconciliation_discrepancies where run_id = (select id from tmp_new)),
  'provider_verification_pending:info:open', 'a pending-verification finding is stored as info, open');

select throws_ok(format($$ select app.record_transfer_reconciliation_run(%L::jsonb, '[]'::jsonb) $$, pg_temp.run_json(86401)),
  '23514', null, 'a grace period over 24 hours is refused');
select throws_ok(format($$ select app.record_transfer_reconciliation_run(%L::jsonb, '[]'::jsonb) $$, pg_temp.run_json(-1)),
  '23514', null, 'a negative grace period is refused');
select throws_ok(format($$ select app.record_transfer_reconciliation_run(%L::jsonb, '[{"kind":"made_up","severity":"info"}]'::jsonb) $$,
                        pg_temp.run_json(300)),
  '23514', null, 'an unknown discrepancy kind is still refused');
select throws_ok(format($$ select app.record_transfer_reconciliation_run(%L::jsonb, '[{"kind":"provider_verification_pending","severity":"urgent"}]'::jsonb) $$,
                        pg_temp.run_json(300)),
  '23514', null, 'severities are unchanged');


-- ── Older warnings are left exactly as they were ────────────────────────────

select is((select md5(string_agg(d::text, '|' order by d.id)) from public.transfer_reconciliation_discrepancies d
           where run_id = (select id from tmp_old)),
  (select digest from tmp_old_rows), 'a later run leaves an older missing_at_provider row byte-for-byte unchanged');
select is((select resolution_status from public.transfer_reconciliation_discrepancies where run_id = (select id from tmp_old)), 'open',
  'and still open: nothing is closed or acknowledged automatically');
select is((select coalesce(md5(string_agg(d::text, '|' order by d.id)), '') from public.transfer_reconciliation_discrepancies d
           where run_id not in ((select id from tmp_old), (select id from tmp_new))),
  (select discrepancies from tmp_before), 'every discrepancy that existed before this test is unchanged');


-- ── Duplicate runs ──────────────────────────────────────────────────────────

create temporary table tmp_dup (id uuid);
insert into tmp_dup select app.record_transfer_reconciliation_run(pg_temp.run_json(300),
  jsonb_build_array(jsonb_build_object('kind', 'provider_verification_pending', 'severity', 'info', 'reference', 'ktr_00000000000000000000a002')));
insert into tmp_dup select app.record_transfer_reconciliation_run(pg_temp.run_json(300),
  jsonb_build_array(jsonb_build_object('kind', 'provider_verification_pending', 'severity', 'info', 'reference', 'ktr_00000000000000000000a002')));
select is((select count(distinct id)::integer from tmp_dup), 2, 'two identical runs are two separate run rows');
select is((select count(*)::integer from public.transfer_reconciliation_discrepancies where run_id in (select id from tmp_dup)), 2,
  'each with its own snapshot of the finding');
select is((select count(*) from public.transfer_reconciliation_runs) - (select runs from tmp_before), 4::bigint,
  'only the four runs recorded here were added');


-- ── No money moved, nothing changed state ───────────────────────────────────

select ok((select journals from tmp_before) = (select count(*) from public.ledger_journals)
          and (select entries from tmp_before) = (select count(*) from public.ledger_entries),
  'no journal or ledger entry was posted');
select is((select coalesce(md5(string_agg(t::text, '|' order by t.id)), '') from public.withdrawal_transfers t), (select transfers from tmp_before),
  'no withdrawal transfer changed');
select is((select coalesce(md5(string_agg(w::text, '|' order by w.id)), '') from public.withdrawals w), (select withdrawals from tmp_before),
  'no withdrawal changed');


-- ── Still server-only ───────────────────────────────────────────────────────

select ok(not has_function_privilege('authenticated', 'app.record_transfer_reconciliation_run(jsonb, jsonb)', 'execute')
          and not has_function_privilege('anon', 'app.record_transfer_reconciliation_run(jsonb, jsonb)', 'execute'),
  'the recorder is not callable by a client');
select is((select count(*)::integer from pg_class
           where oid in ('public.transfer_reconciliation_runs'::regclass, 'public.transfer_reconciliation_discrepancies'::regclass)
             and relrowsecurity and relforcerowsecurity),
  2, 'row level security is still enabled and forced on both tables');

select * from finish();
rollback;
