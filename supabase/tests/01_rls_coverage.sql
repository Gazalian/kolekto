-- ─────────────────────────────────────────────────────────────────────────────
-- 01 — RLS coverage
--
-- SEC-13: "Continuous integration fails if any table in the public schema lacks
-- RLS." Had this test existed, `payment_reference_backfill_snapshot_20260811`
-- and `duplicate_void_snapshot_20260812` — 3,336 rows of payment-forensic data,
-- readable and TRUNCATE-able by anyone holding the anon key — would never have
-- reached production.
--
-- It checks two things, not one. `ENABLE ROW LEVEL SECURITY` leaves the table
-- owner exempt; `FORCE` closes that. A migration running as the owner is
-- exactly the context where an exemption goes unnoticed.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(4);

-- Every table in `public` has RLS enabled.
select is_empty(
  $$
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
    order by c.relname
  $$,
  'every table in public has row level security ENABLED (SEC-13)'
);

-- Every table in `public` has RLS forced, so the owner is not exempt.
select is_empty(
  $$
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relforcerowsecurity
    order by c.relname
  $$,
  'every table in public has row level security FORCED'
);

-- No SECURITY DEFINER views anywhere in an exposed schema. The previous system
-- had seven, all granted to anon, and they bypassed RLS on contributions,
-- deposits and pending_payment_context by design.
select is_empty(
  $$
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and coalesce(
            (select option_value
             from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'),
            'false'
          ) <> 'true'
    order by c.relname
  $$,
  'no view in public runs with definer rights — operational views belong in the private schema'
);

-- A table with RLS enabled and no policy denies everything, which is safe but
-- usually accidental: it means the table is reachable only through the service
-- role. That is a legitimate choice, so this asserts the INTENDED set rather
-- than forbidding the state. Update the list when you mean it.
select is_empty(
  $$
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not exists (
        select 1 from pg_policy p where p.polrelid = c.oid
      )
      -- The intended set. M13.3 R2 (20261109100000) made these two evidence
      -- tables policy-less on purpose: RLS forced, every client grant revoked,
      -- readable only through app.* functions. 49_m13_3_communication_policy.sql
      -- asserts they stay that way.
      and c.relname not in (
        'community_communication_attestations',
        'member_communication_choices'
      )
    order by c.relname
  $$,
  'every table in public has at least one policy — a policy-less table is reachable only by the service role, which should be a decision, not an oversight'
);

select * from finish();
rollback;
