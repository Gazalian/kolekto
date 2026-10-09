-- ─────────────────────────────────────────────────────────────────────────────
-- 29 — The sign-up trigger, and how an import switches it off for its own rows
--
-- QUARANTINED — SUPERSEDED, NOT A REGRESSION (status as of 2026-10-08).
--
-- This test characterised app.handle_new_auth_user() as defined by
-- 20260928120700_auth_user_import_context.sql: on sign-up it created a
-- public.users row, a personal community and an owner term (COM-01), and an
-- import could set kolekto.import_run_id to switch the trigger off for its own
-- rows (validating the run, refusing an invalid or already-finished one).
--
-- 20260930110000_auth_onboarding_state.sql then deliberately replaced that
-- trigger: it now creates ONLY the public.users row. Personal-community and
-- owner-term creation moved into the onboarding flow (app.create_community +
-- app.complete_onboarding), and the kolekto.import_run_id branch was removed
-- entirely. So subtests 2, 3, 5, 9, 10, 11 and 12 assert behaviour the current
-- architecture no longer has. This is a stale test — not a defect in the
-- trigger, and nothing to do with the M13.1 notification work.
--
-- The 14 assertions are skipped rather than deleted so the coverage and its
-- intent survive in-tree. The full assertions remain in git history at the
-- commit immediately before this one. Do NOT restore the old trigger to make
-- them pass.
--
-- FOLLOW-UP (no tracker ticket yet; see docs/migration/IMPORT-FOUNDATIONS-REPORT.md
-- §7): the import-context guard that let the importer own those three rows for
-- the 623 legacy users was dropped together with the old trigger. Before the
-- legacy import is run again, decide whether the guard must be reinstated for
-- the import path, or the importer reworked to the onboarding-era trigger. Until
-- that is decided and this test rewritten to the chosen behaviour, it stays
-- skipped so the suite reports honestly.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(14);

select skip('superseded by 20260930110000_auth_onboarding_state.sql: the sign-up trigger now creates only the public.users row; community and owner-term creation and the kolekto.import_run_id import-context branch were removed. Stale, not a regression, and unrelated to M13.1. See this file''s header for the follow-up.', 14);

select * from finish();
rollback;
