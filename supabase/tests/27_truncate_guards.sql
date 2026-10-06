-- ─────────────────────────────────────────────────────────────────────────────
-- 27 — TRUNCATE cannot empty append-only or immutable tables (F-4)
--
-- Coverage for 20260928120500_truncate_guards.sql.
--
-- Every attempt below runs as `postgres` — the table OWNER, which holds TRUNCATE
-- by ownership. That is the point: the guard is a trigger, part of the table, so
-- it holds for the role no grant can restrict.
--
-- CASCADE is used deliberately. Without it, a table referenced by a foreign key
-- fails Postgres's own FK check before any trigger runs, and the test would pass
-- for the wrong reason. With CASCADE the FK check is skipped and the guard is
-- what refuses. The whole file runs in one transaction and rolls back, so even an
-- unguarded table would be restored — nothing here can lose data.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(25);

-- Exactly these tables carry the guard. A shrinking list fails here, not in production.
select set_eq(
  $$ select c.relnamespace::regnamespace || '.' || c.relname
     from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
     where p.proname = 'block_truncate' and not t.tgisinternal $$,
  $$ values
     ('public.ledger_accounts'), ('public.ledger_journals'), ('public.ledger_entries'),
     ('public.financial_events'), ('public.financial_event_processing_attempts'),
     ('public.financial_operation_claims'), ('public.audit_logs'),
     ('public.fee_schedules'), ('public.fee_schedule_category_rates'),
     ('public.withdrawal_fee_schedules'), ('public.withdrawal_fee_brackets'),
     ('public.collections'), ('public.members'), ('public.contributor_references'),
     ('migration.import_runs'), ('migration.legacy_profile'), ('migration.legacy_collection'),
     ('migration.legacy_contribution'), ('migration.legacy_deposit'),
     ('migration.unattributed_payments'), ('migration.legacy_withdrawal'),
     ('migration.legacy_overflow'), ('migration.imported_objects') $$,
  'exactly the 23 append-only and immutable tables are guarded against TRUNCATE'
);

select throws_like($$ truncate public.ledger_accounts cascade $$,                     '%TRUNCATE_REFUSED%', 'ledger_accounts');
select throws_like($$ truncate public.ledger_journals cascade $$,                     '%TRUNCATE_REFUSED%', 'ledger_journals');
select throws_like($$ truncate public.ledger_entries cascade $$,                      '%TRUNCATE_REFUSED%', 'ledger_entries');
select throws_like($$ truncate public.financial_events cascade $$,                    '%TRUNCATE_REFUSED%', 'financial_events');
select throws_like($$ truncate public.financial_event_processing_attempts cascade $$, '%TRUNCATE_REFUSED%', 'financial_event_processing_attempts');
select throws_like($$ truncate public.financial_operation_claims cascade $$,          '%TRUNCATE_REFUSED%', 'financial_operation_claims');
select throws_like($$ truncate public.audit_logs cascade $$,                          '%TRUNCATE_REFUSED%', 'audit_logs');
select throws_like($$ truncate public.fee_schedules cascade $$,                       '%TRUNCATE_REFUSED%', 'fee_schedules');
select throws_like($$ truncate public.fee_schedule_category_rates cascade $$,         '%TRUNCATE_REFUSED%', 'fee_schedule_category_rates');
select throws_like($$ truncate public.withdrawal_fee_schedules cascade $$,            '%TRUNCATE_REFUSED%', 'withdrawal_fee_schedules');
select throws_like($$ truncate public.withdrawal_fee_brackets cascade $$,             '%TRUNCATE_REFUSED%', 'withdrawal_fee_brackets');
select throws_like($$ truncate public.collections cascade $$,                         '%TRUNCATE_REFUSED%', 'collections (holds immutable imported rows)');
select throws_like($$ truncate public.members cascade $$,                             '%TRUNCATE_REFUSED%', 'members (holds immutable imported rows)');
select throws_like($$ truncate public.contributor_references cascade $$,              '%TRUNCATE_REFUSED%', 'contributor_references (issued references are immutable)');
select throws_like($$ truncate migration.import_runs cascade $$,                      '%TRUNCATE_REFUSED%', 'migration.import_runs');
select throws_like($$ truncate migration.legacy_profile cascade $$,                   '%TRUNCATE_REFUSED%', 'migration.legacy_profile');
select throws_like($$ truncate migration.legacy_collection cascade $$,                '%TRUNCATE_REFUSED%', 'migration.legacy_collection');
select throws_like($$ truncate migration.legacy_contribution cascade $$,              '%TRUNCATE_REFUSED%', 'migration.legacy_contribution');
select throws_like($$ truncate migration.legacy_deposit cascade $$,                   '%TRUNCATE_REFUSED%', 'migration.legacy_deposit');
select throws_like($$ truncate migration.unattributed_payments cascade $$,            '%TRUNCATE_REFUSED%', 'migration.unattributed_payments');
select throws_like($$ truncate migration.legacy_withdrawal cascade $$,                '%TRUNCATE_REFUSED%', 'migration.legacy_withdrawal');
select throws_like($$ truncate migration.legacy_overflow cascade $$,                  '%TRUNCATE_REFUSED%', 'migration.legacy_overflow');
select throws_like($$ truncate migration.imported_objects cascade $$,                 '%TRUNCATE_REFUSED%', 'migration.imported_objects');

-- The guard is targeted, not a global ban: an ordinary table still truncates.
create temporary table tmp_truncate_control (id int);
insert into tmp_truncate_control values (1), (2);
truncate tmp_truncate_control;
select is(
  (select count(*)::integer from tmp_truncate_control),
  0,
  'a table outside the guarded set still truncates — the guard adds no broad behaviour'
);

select * from finish();
rollback;
