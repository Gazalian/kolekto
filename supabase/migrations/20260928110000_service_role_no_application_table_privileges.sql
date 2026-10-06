-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928110000 — service_role holds nothing on application tables (F-1)
--
-- Decision and evidence: docs/migration/SERVICE-ROLE-PRIVILEGE-DECISION.md.
--
-- THE DRIFT. No migration ever stated service_role's table privileges, so every
-- environment inherited whatever default privileges its platform image ships
-- for tables created by `postgres`:
--
--     local CLI image    service_role=Dxtm       truncate, references, trigger, maintain
--     hosted project     service_role=arwdDxtm   everything
--
-- On the hosted staging project that meant anyone holding the service-role key
-- could read every row of every table and insert into the ledger, financial
-- events and fee schedules through the public REST API. Every test still
-- passed, because no test asserted anything about service_role.
--
-- WHY NOTHING, RATHER THAN MATCHING LOCAL. Nothing in Kolekto uses any
-- service_role table privilege:
--   · the service-role key is used only for Storage (collection-cover.ts,
--     item-image.ts), which acts on the `storage` schema;
--   · the direct database connection (packages/db) never becomes service_role —
--     it switches to `authenticated` or `anon` per transaction;
--   · no test, script or invariant sets role service_role;
--   · service_role is NOLOGIN, so migration tooling cannot use it directly.
-- Local's TRUNCATE was the most dangerous of the leftovers: TRUNCATE does not
-- fire the row-level triggers that make the ledger and imported history
-- append-only.
--
-- WHAT THIS DOES NOT TOUCH.
--   · The `storage` and `auth` schemas — platform-managed, and what the
--     service-role key is actually for.
--   · anon and authenticated — their grants are stated elsewhere and asserted by
--     02_grant_matrix.sql.
--   · Schema USAGE on `public`, which Storage and PostgREST need to resolve the
--     schema; with no table privilege, nothing in it is reachable.
--
-- Covered by supabase/tests/25_service_role_privileges.sql.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Existing objects ─────────────────────────────────────────────────────────
revoke all on all tables    in schema public, app, private, migration from service_role;
revoke all on all sequences in schema public, app, private, migration from service_role;

-- ── Future objects ───────────────────────────────────────────────────────────
-- Default privileges are recorded per grantor, which is how the hosted default
-- slipped through: it belongs to `postgres`, the role that owns every table
-- here. Name that role explicitly rather than relying on whoever runs this.
alter default privileges for role postgres in schema public    revoke all on tables    from service_role;
alter default privileges for role postgres in schema public    revoke all on sequences from service_role;
alter default privileges for role postgres in schema app       revoke all on tables    from service_role;
alter default privileges for role postgres in schema app       revoke all on sequences from service_role;
alter default privileges for role postgres in schema private   revoke all on tables    from service_role;
alter default privileges for role postgres in schema private   revoke all on sequences from service_role;
alter default privileges for role postgres in schema migration revoke all on tables    from service_role;
alter default privileges for role postgres in schema migration revoke all on sequences from service_role;
