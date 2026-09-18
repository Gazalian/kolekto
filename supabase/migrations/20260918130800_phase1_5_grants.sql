-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918130800 — Phase 1.5 grants: what a client role can reach
--
-- Following 20260917121100_grants.sql's own stated discipline: "The grants
-- live HERE rather than beside each function [or table]... One file decides
-- what a client can reach." Every object created in this Phase 1.5 batch
-- (20260918130000 through 20260918130700) is reachable by neither `anon` nor
-- `authenticated` unless explicitly stated below — and nothing below grants
-- anything. This file exists to make that a checked, asserted fact rather
-- than an assumption resting on Phase 1's default-privilege settings still
-- applying three migrations later.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── M1: the migration schema is not reachable at all ─────────────────────────
-- Belt and suspenders alongside Phase 1's `alter default privileges in schema
-- public revoke all on tables from anon, authenticated` (20260917121100),
-- which already covers future `public` tables created by the same role. This
-- statement is the equivalent guarantee for the NEW `migration` schema, which
-- that earlier statement — scoped to `public` — cannot reach.
revoke all on schema migration from anon, authenticated, public;
revoke all on all tables    in schema migration from anon, authenticated, public;
revoke all on all sequences in schema migration from anon, authenticated, public;
revoke all on all functions in schema migration from anon, authenticated, public;

alter default privileges in schema migration revoke all on tables    from anon, authenticated;
alter default privileges in schema migration revoke all on sequences from anon, authenticated;
alter default privileges in schema migration revoke execute on functions from public;

-- `authenticated` gets USAGE on `migration` for nothing beyond what its own
-- `using (false)` policies already deny — no SELECT, no INSERT, no EXECUTE.
-- Not even granting USAGE: there is no legitimate reason for a client
-- connection to reference this schema by name at all, and PostgREST does not
-- expose it regardless (config.toml `api.schemas = ["public"]`).


-- ── M6: legacy_links is server-side routing data, not client data ───────────
-- public.legacy_links sits in `public` (so PostgREST's schema restriction
-- alone does not protect it — `public` IS the exposed schema), which is why
-- this table needed its own `using (false)` policy in 20260918130400 in
-- addition to this revoke. Two independent layers: no grant, and a policy
-- that denies even if a grant were ever added by mistake.
revoke all on public.legacy_links from anon, authenticated, public;


-- ── M9: the immutability functions are trigger functions, never called directly ──
-- app.enforce_imported_row_immutability() and app.block_row_mutation() are
-- invoked internally by Postgres when their attached triggers fire — never by
-- a client issuing `select app.enforce_imported_row_immutability()` or an
-- RPC call. Neither is SECURITY DEFINER (trigger functions do not need it:
-- see this migration's companion, 20260918130700, for why), so neither
-- appears in the anon/authenticated SECURITY DEFINER surface at all. Revoked
-- from PUBLIC anyway, for the same reason every function in this schema is:
-- the default should never be trusted to be correct on its own.
revoke execute on function app.enforce_imported_row_immutability() from public, anon, authenticated;
revoke execute on function app.block_row_mutation()                from public, anon, authenticated;


-- ── What is deliberately UNCHANGED ───────────────────────────────────────────
-- public.collections and public.members already carry `authenticated:SELECT`
-- from Phase 1 (20260917121100_grants.sql). The new columns this batch adds
-- to both tables (is_imported, source_system, source_table, source_id,
-- imported_at, import_run_id) are covered by that existing table-level grant
-- automatically — Phase 1 did not use column-level grants, so a new column on
-- an already-granted table needs no new grant statement. This is intentional:
-- Migration Architecture section 8 requires imported records to be
-- "distinguishable on sight everywhere this column is selected," which means
-- authenticated officers reading their own community's collections and
-- members MUST be able to see is_imported and its provenance. Existing RLS
-- policies on collections and members (has_permission-scoped) continue to
-- decide which ROWS are visible; this file only confirms no new grant was
-- needed to make the new COLUMNS visible within those same rows.
