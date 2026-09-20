-- ─────────────────────────────────────────────────────────────────────────────
-- 03 — Money invariants
--
-- ADR 0003: money is `bigint` kobo, end to end. The previous system stored
-- `numeric(12,2)` and did its arithmetic in JavaScript IEEE-754 doubles, which
-- produced a ₦3.59 unexplainable gap between `sum(wallets.net_payment)` and
-- `sum(contributions.amount)` — against a stated tolerance of zero kobo.
--
-- These tests hold even while there are no money tables (ADR 0006). They are
-- written now so that the day Phase 3 adds `ledger_entries`, a `numeric` column
-- fails the build rather than quietly starting a new drift.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(5);

-- No floating point anywhere. Not in a money column, not anywhere at all —
-- there is no legitimate use for `real` or `double precision` in this schema,
-- and allowing one "just for a percentage" is how the previous engine's
-- rounding became non-deterministic.
select is_empty(
  $$
    select c.relname || '.' || a.attname || ' is ' || format_type(a.atttypid, a.atttypmod)
    from pg_attribute a
    join pg_class c     on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attnum > 0
      and not a.attisdropped
      and format_type(a.atttypid, a.atttypmod) in ('real', 'double precision', 'money')
    order by 1
  $$,
  'no column in public uses real, double precision or money (ADR 0003)'
);

-- Anything that looks like an amount is bigint kobo. The naming convention is
-- load-bearing: a money column ends in `_kobo`, which makes a review of "is
-- this money?" a grep rather than a judgement call.
-- Domains are resolved to their base type rather than matched by name. The
-- money columns are declared as `app.kobo`, so format_type() reports "kobo",
-- and a name comparison against 'bigint' fails on correct code. What matters is
-- what the value actually IS underneath, which is what this checks — and it
-- keeps working whether a column is declared bigint or app.kobo.
select is_empty(
  $$
    select c.relname || '.' || a.attname || ' is ' || format_type(a.atttypid, a.atttypmod)
    from pg_attribute a
    join pg_class c     on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_type t      on t.oid = a.atttypid
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attnum > 0
      and not a.attisdropped
      and a.attname like '%\_kobo'
      -- An array of money is still money: suggested_amounts_kobo holds several
      -- amounts and each one is a bigint. Resolve through the element type so
      -- bigint[] passes and numeric[] would not — the rule is that a monetary
      -- value is an integer, not that it must be scalar.
      and coalesce(
            nullif(t.typbasetype, 0),
            nullif(t.typelem, 0),
            t.oid
          ) <> 'pg_catalog.int8'::regtype
    order by 1
  $$,
  'every *_kobo column resolves to bigint — declared bigint, app.kobo, or an array of them (ADR 0003)'
);

-- The inverse: a column that holds money must say so. Catches
-- `amount numeric(12,2)` sneaking in under a name the first test does not see.
--
-- Only NUMERIC-family types are flagged. An earlier version of this test
-- checked an allowlist of "safe" types instead, and flagged
-- `communities.default_fee_mode` — an enum whose name merely contains "fee".
-- A test that fails on correct code gets suppressed, so it has to be precise
-- about what it forbids: a money value held as numeric, decimal or a float.
select is_empty(
  $$
    select c.relname || '.' || a.attname || ' is ' || format_type(a.atttypid, a.atttypmod)
    from pg_attribute a
    join pg_class c     on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.attnum > 0
      and not a.attisdropped
      and a.attname ~ '(amount|balance|price|fee|total|gross|net|payable)'
      and a.attname not like '%\_kobo'
      and format_type(a.atttypid, a.atttypmod) ~ '^(numeric|decimal|double precision|real|money)'
    order by 1
  $$,
  'no money-sounding column is held as numeric or floating point — money is named *_kobo and typed bigint'
);

-- CASH-02 / SEC-20a: there is no path that marks an obligation paid without a
-- Paystack-verified contribution. Asserted as the absence of any function whose
-- body writes that status, so adding one is a test failure rather than a quiet
-- product change.
select is_empty(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')
      and p.prosrc ~* 'status\s*(:?=|,)\s*''paid'''
      and p.proname <> 'block_manual_paid_status'
    order by 1
  $$,
  'no function sets an obligation to paid — money is the only route (CASH-02, SEC-20a)'
);

-- The kobo domain exists and is bigint-backed, so `app.kobo` cannot silently
-- become a numeric alias in a later migration.
select is(
  (select format_type(t.typbasetype, t.typtypmod)
   from pg_type t
   join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'app' and t.typname = 'kobo'),
  'bigint',
  'the app.kobo domain is backed by bigint'
);

select * from finish();
rollback;
