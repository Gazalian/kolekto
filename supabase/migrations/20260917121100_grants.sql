-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917121100 — The grant matrix
--
-- This migration is the direct answer to the worst findings of the 2026-09-17
-- audit of the previous system, all four of which were grant problems rather
-- than policy problems:
--
--   · two tables with RLS disabled and INSERT/UPDATE/DELETE/TRUNCATE granted
--     to `anon`, holding 3,336 rows of payment-forensic data
--   · seven SECURITY DEFINER views granted full DML to `anon`, bypassing RLS
--     and exposing contributor names and emails across every community
--   · three SECURITY DEFINER functions granted EXECUTE to `anon`, letting an
--     anonymous caller drive the payment state machine
--   · policies permitting writes that only the absence of a grant prevented
--
-- The matrix below is asserted by `supabase/tests/02_grant_matrix.sql`. If a
-- future migration grants something not listed there, CI fails.
--
-- The rule: `anon` gets NOTHING. `authenticated` gets SELECT on an allowlist
-- and nothing else. Every write goes through the service role, inside a server
-- function that has already checked `app.has_permission`.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Start from zero ──────────────────────────────────────────────────────────
-- Supabase's defaults are generous. Withdraw them, then grant back by name, so
-- the privilege set is something someone decided rather than something that
-- accumulated.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- Nobody creates objects in `public` at runtime.
revoke create on schema public from public, anon, authenticated;

-- `app` and `private` are not exposed through PostgREST, and their contents are
-- reached only through explicit EXECUTE grants on named functions.
revoke all on schema app     from anon, authenticated;
revoke all on schema private from anon, authenticated;
revoke all on all tables    in schema private from anon, authenticated;
revoke all on all functions in schema app     from anon, authenticated;

-- `authenticated` needs USAGE on `app` to call the helpers its RLS policies
-- invoke. USAGE on the schema is not exposure: PostgREST serves only `public`,
-- so nothing in `app` is reachable over the REST API regardless.
grant usage on schema app to authenticated;


-- ── anon: nothing ────────────────────────────────────────────────────────────
-- Not a table, not a sequence, not a function. SEC-12: the anonymous surface is
-- `app.get_public_collection`, called by the Next.js server, never by a browser
-- holding a publishable key.
--
-- Deliberately no statements here. The absence is the policy.


-- ── authenticated: SELECT on an allowlist ────────────────────────────────────
-- Each of these tables has a SELECT policy in the previous migration, and RLS
-- decides which rows. The grant decides which tables are reachable at all.
--
-- Why grant SELECT to the client role rather than routing every read through
-- the server too: Supabase Realtime evaluates RLS for a subscribing client, and
-- the officer dashboard updates live as payments confirm (PRD 23.2). A table
-- the client cannot select cannot be subscribed to.
grant select on table public.users                          to authenticated;
grant select on table public.communities                    to authenticated;
grant select on table public.community_slug_history         to authenticated;
grant select on table public.community_labels               to authenticated;
grant select on table public.permissions                    to authenticated;
grant select on table public.role_permissions               to authenticated;
grant select on table public.leadership_terms               to authenticated;
grant select on table public.officer_terms                  to authenticated;
grant select on table public.members                        to authenticated;
grant select on table public.member_attribute_definitions   to authenticated;
grant select on table public.member_groups                  to authenticated;
grant select on table public.member_group_memberships       to authenticated;
grant select on table public.member_contacts                to authenticated;
grant select on table public.invite_links                   to authenticated;
grant select on table public.officer_invitations            to authenticated;
grant select on table public.collections                    to authenticated;
grant select on table public.collection_tiers               to authenticated;
grant select on table public.collection_fields              to authenticated;
grant select on table public.collection_code_settings       to authenticated;
grant select on table public.obligations                    to authenticated;
grant select on table public.audit_logs                     to authenticated;

-- Belt and braces on the append-only table. The policies grant no write and the
-- triggers block one, and now the privilege is gone too (DAT-02).
revoke insert, update, delete, truncate on public.audit_logs from authenticated, anon;


-- ── Function execution ───────────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC on every new function by default, which is
-- how three payment-state functions ended up callable by `anon` in the previous
-- system. Withdraw it, then grant back by name.
--
-- TWO revokes are needed, and missing either one leaves a hole:
--
--   1. A RETROACTIVE revoke, below. `alter default privileges` only affects
--      functions created AFTER it runs, so it does nothing for the seventeen
--      helpers created in the migrations before this one. Without this,
--      `anon` inherits PUBLIC's default EXECUTE on every one of them.
--      supabase/tests/02_grant_matrix.sql caught exactly that.
--
--   2. A DEFAULT-PRIVILEGE revoke, for functions added by later migrations.
--
-- Note that `revoke ... from anon, authenticated` is NOT sufficient for either:
-- the privilege is held by PUBLIC, which both roles inherit, so it has to be
-- revoked FROM PUBLIC by name.
revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema app     from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

alter default privileges in schema public  revoke execute on functions from public;
alter default privileges in schema app     revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

-- Now grant back, by name. This is the whole of the executable surface for
-- client roles, and supabase/tests/02_grant_matrix.sql asserts it exactly.
--
-- The grants live HERE rather than beside each function, because the blanket
-- revoke above would undo them wherever else they were written. One file
-- decides what a client can reach.
--
--   · has_permission / has_permission_for_collection / current_user_community_ids
--       → authenticated. Called from inside RLS policies, so the role
--         evaluating the policy must be able to execute them.
--   · get_public_collection / get_public_collection_tiers
--       → anon and authenticated. The whitelisted public collection page
--         (SEC-12), and the only thing `anon` may call anywhere.
--   · write_audit_log, and every trigger and guard function
--       → nobody. Server code reaches them through the service role, and
--         trigger functions are invoked by the trigger, not by the client.
grant execute on function app.has_permission(uuid, text)                to authenticated;
grant execute on function app.has_permission_for_collection(uuid, text) to authenticated;
grant execute on function app.current_user_community_ids()              to authenticated;
grant execute on function app.get_public_collection(text, text)         to anon, authenticated;
grant execute on function app.get_public_collection_tiers(uuid)         to anon, authenticated;


-- ── Future objects default to closed ─────────────────────────────────────────
-- A table added by a later migration is unreachable until someone grants it
-- explicitly and updates the pgTAP allowlist. The default is no.
alter default privileges in schema public  revoke all on tables    from anon, authenticated;
alter default privileges in schema public  revoke all on sequences from anon, authenticated;
alter default privileges in schema app     revoke all on tables    from anon, authenticated;
alter default privileges in schema private revoke all on tables    from anon, authenticated;


-- ── A note for whoever adds the money tables ─────────────────────────────────
-- SEC-14: contributions, installment plans, ledger entries, balance releases,
-- withdrawals, refunds and the money fields of obligations are NOT selectable,
-- let alone writable, by `authenticated`. They are served through server
-- functions that return computed, permission-checked views of the data.
--
-- When Phase 3 arrives (ADR 0006), those tables get no entry in the allowlist
-- above, and `supabase/tests/02_grant_matrix.sql` will fail the build if they do.
