-- ─────────────────────────────────────────────────────────────────────────────
-- 19 — Fee schedules (M8.1 step 3)
--
-- A fee rate is a row, versioned and effective-dated, and a version is never
-- edited. This decides that the append-only protection actually holds, that the
-- founder's rates (D-10) are what the database says they are, and — the
-- assertion that matters most for keeping one fee implementation — that no SQL
-- function multiplies an amount by a rate.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(30);

-- ── Structure ───────────────────────────────────────────────────────────────

select has_table('public', 'fee_schedules',               'fee schedules are rows, not constants');
select has_table('public', 'fee_schedule_category_rates', 'a schedule may vary its platform rate by category');
select has_table('public', 'withdrawal_fee_schedules',    'withdrawal fees are versioned too (D-04)');
select has_table('public', 'withdrawal_fee_brackets',     'and their brackets are data');

select col_type_is('public', 'fee_schedules', 'max_platform_fee_kobo', 'app.kobo',
  'a cap is money, so it is app.kobo like every other amount (ADR 0003)');
select col_type_is('public', 'fee_schedules', 'max_gateway_fee_kobo', 'app.kobo',
  'and so is the provider cap');

-- D-14. The column is the decision: VAT was considered and it is zero.
select has_column('public', 'fee_schedules', 'vat_rate_bps',
  'VAT is represented explicitly, so "zero" is distinguishable from "not considered" (D-14)');


-- ── The founder's schedule (D-10) ───────────────────────────────────────────

select is(
  (select count(*)::integer from public.fee_schedules where version = '2026-09-founder'),
  1,
  'Kolekto''s schedule exists as a row'
);

select results_eq(
  $$ select platform_rate_default_bps, gateway_rate_bps, vat_rate_bps
     from public.fee_schedules where version = '2026-09-founder' $$,
  $$ values (150, 150, 0) $$,
  'platform 1.5%, modeled provider 1.5%, VAT 0 (D-10, D-14)'
);

select results_eq(
  $$ select max_platform_fee_kobo::bigint, max_gateway_fee_kobo::bigint
     from public.fee_schedules where version = '2026-09-founder' $$,
  $$ values (500000::bigint, 200000::bigint) $$,
  'the caps are asymmetric on purpose: ₦5,000 for Kolekto''s fee, ₦2,000 for the provider model (D-10)'
);

-- A-3: one rate for every category. The override table exists for schedules that
-- vary, and this schedule does not.
select is(
  (select count(*)::integer from public.fee_schedule_category_rates
   where schedule_version = '2026-09-founder'),
  0,
  'no per-category override — one rate for everything (A-3), so the default applies'
);


-- ── D-04a: the withdrawal brackets are NOT decided, so they are NOT here ────
--
-- This is an assertion that something is absent, which is unusual and
-- deliberate. A guessed bracket inside the stated ₦100–₦500 range would be
-- indistinguishable later from a decision somebody made.

select is(
  (select count(*)::integer from public.withdrawal_fee_schedules),
  0,
  'no withdrawal fee schedule version exists — the brackets are OPEN (O-2) and a fee nobody chose must not be computable'
);

select is(
  (select count(*)::integer from public.withdrawal_fee_brackets),
  0,
  'and therefore no bracket rows either (D-04a)'
);


-- ── Append-only (D-13) ──────────────────────────────────────────────────────
--
-- The whole reason a schedule is versioned: the previous system recomputed
-- balances nightly against the CURRENT constants, so changing a rate silently
-- restated every historical balance. Editing a version would reintroduce that
-- exactly.

select throws_ok(
  $$ update public.fee_schedules set platform_rate_default_bps = 200 where version = '2026-09-founder' $$,
  'P0001',
  null,
  'a schedule cannot be edited — a rate change is a new version (D-13)'
);

select throws_ok(
  $$ delete from public.fee_schedules where version = '2026-09-founder' $$,
  'P0001',
  null,
  'and it cannot be deleted, because money rows point at the version they used'
);

select is(
  (select platform_rate_default_bps from public.fee_schedules where version = '2026-09-founder'),
  150,
  'and neither refusal changed it'
);

-- Both mechanisms, not one. The trigger is what makes a careless future GRANT
-- useless rather than dangerous.
select has_function('app', 'block_fee_schedule_mutation', 'the blocking trigger function exists (DAT-02)');

-- Counts the guard triggers themselves — those running block_fee_schedule_mutation
-- — not every trigger on the tables. These tables also carry a TRUNCATE guard
-- (20260928120500, asserted in 27_truncate_guards.sql), which is a separate rule.
select is(
  (select count(*)::integer from pg_trigger t
   join pg_class c on c.oid = t.tgrelid
   join pg_namespace n on n.oid = c.relnamespace
   join pg_proc p on p.oid = t.tgfoid
   where n.nspname = 'public'
     and c.relname in ('fee_schedules', 'fee_schedule_category_rates',
                       'withdrawal_fee_schedules', 'withdrawal_fee_brackets')
     and p.proname = 'block_fee_schedule_mutation'
     and not t.tgisinternal),
  8,
  'every fee-schedule table has both an update and a delete guard'
);

select ok(
  not has_table_privilege('authenticated', 'public.fee_schedules', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.fee_schedules', 'DELETE')
  and not has_table_privilege('authenticated', 'public.fee_schedules', 'INSERT'),
  'and the privilege is withheld as well as the trigger blocking (DAT-02)'
);


-- ── Constraints ─────────────────────────────────────────────────────────────

select throws_ok(
  $$ insert into public.fee_schedules
       (version, effective_from, platform_rate_default_bps, gateway_rate_bps, vat_rate_bps)
     values ('bad-rate', current_date, 10001, 150, 0) $$,
  '23514',
  null,
  'a rate above 100% is refused — basis points are 0 to 10000'
);

select throws_ok(
  $$ insert into public.fee_schedules
       (version, effective_from, platform_rate_default_bps, gateway_rate_bps, vat_rate_bps)
     values ('bad-negative', current_date, -1, 150, 0) $$,
  '23514',
  null,
  'and a negative rate is refused'
);

select throws_ok(
  $$ insert into public.fee_schedules
       (version, effective_from, platform_rate_default_bps, gateway_rate_bps, vat_rate_bps,
        max_platform_fee_kobo)
     values ('bad-cap', current_date, 150, 150, 0, -1) $$,
  '23514',
  null,
  'a negative cap is refused — app.kobo permits negatives, so the column says so itself'
);

select lives_ok(
  $$ insert into public.fee_schedules
       (version, effective_from, platform_rate_default_bps, gateway_rate_bps, vat_rate_bps,
        max_platform_fee_kobo, max_gateway_fee_kobo)
     values ('uncapped-example', current_date, 150, 150, 0, null, null) $$,
  'a NULL cap is permitted and means uncapped, which is not the same as zero'
);

select throws_ok(
  $$ insert into public.withdrawal_fee_brackets (schedule_version, min_amount_kobo, max_amount_kobo, fee_kobo)
     values ('no-such-version', 0, 100000, 10000) $$,
  '23503',
  null,
  'a bracket cannot belong to a schedule version that does not exist'
);


-- ── Reads ───────────────────────────────────────────────────────────────────
-- A fee schedule is not secret: an organiser is shown the rates before they
-- publish, and an officer is entitled to know what was charged. Same reasoning
-- as the permission catalogue.

select ok(
  has_table_privilege('authenticated', 'public.fee_schedules', 'SELECT'),
  'a signed-in caller may read the schedule, so a screen can name the rates it is quoting'
);

select ok(
  not has_table_privilege('anon', 'public.fee_schedules', 'SELECT'),
  'anon holds nothing, here as everywhere (SEC-12)'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- The assertion that keeps ONE fee implementation (D-12)
--
-- The largest single drift bucket in the previous system was two
-- implementations of "net": the live Edge writer summed raw amounts while the
-- Node writers deducted fees. The difference WAS the fees.
--
-- So fee arithmetic lives in exactly one place — `calculateFees()` in
-- `packages/domain/src/fees.ts` — and the database deliberately holds none. A
-- SQL function that multiplied an amount by a rate would be the second
-- implementation, and it would be invisible to the source-tree invariants that
-- scan TypeScript.
-- ─────────────────────────────────────────────────────────────────────────────

select is_empty(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app', 'private')
      and p.prosrc ~* '(platform_rate|gateway_rate|vat_rate|_bps)\s*(\*|/)'
    order by 1
  $$,
  'no SQL function multiplies or divides by a fee rate — the fee engine is packages/domain/src/fees.ts and nothing else (D-12)'
);

select is_empty(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app', 'private')
      and p.prosrc ~* '(10000|10_000)\s*(\*|/)|/\s*(10000|10_000)'
      and p.proname not like '%kobo%'
    order by 1
  $$,
  'and none divides by a basis-point divisor, which is what a hand-rolled fee calculation would do'
);

-- A fee is never stored on a collection as a running total either. The
-- collection is configuration; the ledger is money.
select hasnt_column('public', 'collections', 'platform_fee_kobo',
  'a collection carries no fee total — a fee belongs to a transaction, not to configuration');


-- ── The schedule row and the domain constant say the same thing ─────────────
--
-- Two sources for one set of rates is exactly the shape of the L3 drift, so this
-- pins them together. `SCHEDULE_2026_09_FOUNDER` in packages/domain/src/fees.ts
-- carries these numbers; if either side moves without the other, this fails.

select results_eq(
  $$ select version, platform_rate_default_bps, gateway_rate_bps, vat_rate_bps,
            max_platform_fee_kobo::bigint, max_gateway_fee_kobo::bigint
     from public.fee_schedules where version = '2026-09-founder' $$,
  $$ values ('2026-09-founder', 150, 150, 0, 500000::bigint, 200000::bigint) $$,
  'the row matches SCHEDULE_2026_09_FOUNDER in packages/domain/src/fees.ts exactly'
);

select * from finish();
rollback;
