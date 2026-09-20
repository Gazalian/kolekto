-- ─────────────────────────────────────────────────────────────────────────────
-- 02 — The grant matrix
--
-- The single highest-value test in this repository.
--
-- Every one of the three CRITICAL findings in the 2026-09-17 audit of the
-- previous system was a grant that nobody had looked at:
--   · anon holding INSERT/UPDATE/DELETE/TRUNCATE on two financial tables
--   · anon holding full DML on seven SECURITY DEFINER views
--   · anon holding EXECUTE on three functions that drove the payment state
--     machine
--
-- None of them required a subtle exploit. Each needed only the publishable
-- anon key, which ships in the JavaScript bundle of every page.
--
-- This test asserts the allowlist in `20260917121100_grants.sql` exactly. Add a
-- table, add it here, or the build fails — which is the point.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(7);

-- ── anon holds nothing at all ────────────────────────────────────────────────

select is_empty(
  $$
    select table_name || ':' || privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'
    order by 1
  $$,
  'anon has NO privilege on any table in public (SEC-12: the public surface is a function, not a table)'
);

select is_empty(
  $$
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
    order by 1
  $$,
  'anon can execute NO function in public'
);

-- anon may execute exactly the whitelisted public functions in `app`, and
-- nothing else. Naming them means adding one more is a visible decision.
-- Phase 2 (20260918140200) adds redeem_invite_link: MEM-05's one anonymous
-- write path, for a member who joins with no Kolekto account. Phase 3
-- (20260919120100) adds get_public_collection_fields, the third read the
-- published collection page needs — the questions the form asks.
select bag_eq(
  $$
    select p.proname::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  $$,
  $$ values ('get_public_collection'), ('get_public_collection_tiers'),
            ('get_public_collection_fields'), ('redeem_invite_link'),
            ('get_public_invite'), ('get_public_collection_items'),
            -- M7: contributor self-identification. Both are read-only, scoped
            -- to one collection's audience, and neither can list anybody.
            -- app.resolve_collection_audience, which CAN, stays ungranted.
            ('find_collection_member'), ('get_collection_member_context') $$,
  'anon can execute exactly the whitelisted public-collection-page functions plus redeem_invite_link (MEM-05)'
);

-- ── authenticated holds SELECT, and only SELECT ──────────────────────────────

select is_empty(
  $$
    select table_name || ':' || privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee = 'authenticated'
      and privilege_type <> 'SELECT'
    order by 1
  $$,
  'authenticated has no INSERT, UPDATE, DELETE or TRUNCATE anywhere in public — every write goes through a server function (SEC-14, ADR 0008)'
);

-- The allowlist, spelled out. A new table is unreachable until someone adds it
-- here on purpose.
select bag_eq(
  $$
    select table_name::text
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee = 'authenticated'
      and privilege_type = 'SELECT'
  $$,
  $$ values
      ('users'), ('communities'), ('community_slug_history'), ('community_labels'),
      ('permissions'), ('role_permissions'), ('leadership_terms'), ('officer_terms'),
      ('members'), ('member_attribute_definitions'), ('member_attribute_values'),
      ('member_groups'), ('member_group_memberships'), ('member_contacts'),
      ('community_member_code_settings'),
      ('invite_links'), ('officer_invitations'),
      ('collections'), ('collection_tiers'), ('collection_fields'),
      ('collection_code_settings'), ('collection_audience_groups'),
      ('collection_items'), ('collection_recurrences'), ('collection_cycles'),
      ('obligations'), ('audit_logs')
  $$,
  'authenticated can SELECT exactly the allowlisted tables and no others'
);

-- ── Append-only really is append-only ────────────────────────────────────────

select ok(
  not has_table_privilege('authenticated', 'public.audit_logs', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.audit_logs', 'DELETE')
  and not has_table_privilege('anon', 'public.audit_logs', 'SELECT'),
  'audit_logs is append-only for client roles and invisible to anon (AUD-01, DAT-02)'
);

-- ── No SECURITY DEFINER function is callable by PUBLIC ───────────────────────
-- Postgres grants EXECUTE to PUBLIC on every new function by default. That
-- default is how `record_payment_capture` became an anonymous write path into
-- the payment ledger of a live fintech.
select is_empty(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app', 'private')
      and p.prosecdef
      and has_function_privilege('public', p.oid, 'EXECUTE')
    order by 1
  $$,
  'no SECURITY DEFINER function is executable by PUBLIC'
);

select * from finish();
rollback;
