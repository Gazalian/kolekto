-- ─────────────────────────────────────────────────────────────────────────────
-- 20260924100000 — M8.1 step 3: fee schedules
--
-- A fee rate becomes a ROW, effective-dated and versioned, instead of a
-- constant compiled into an application.
--
-- WHY THIS SHAPE. The previous system's worst accounting property was that
-- `settlement_recompute_wallets()` rebuilt every balance nightly against the
-- CURRENT fee constants. Changing a rate therefore silently restated every
-- historical balance — money people had already been told they would receive.
-- The fix is not care; it is structure. A schedule is a version, every money
-- row stores the version it used, and a version is never edited.
--
-- So these tables are APPEND-ONLY. A rate change is a new version. There is no
-- UPDATE path and no DELETE path, for any role, enforced by withheld
-- privileges AND a blocking trigger — the same pair that protects
-- `audit_logs` and `contributor_references` (DAT-02).
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
--
-- No fee is charged, computed or recorded here. There is deliberately NO SQL
-- function in this migration that multiplies an amount by a rate. Fee
-- arithmetic has exactly one implementation — `calculateFees()` in
-- `packages/domain/src/fees.ts` — because the largest single drift bucket in
-- the old system was two implementations of "net" that disagreed by exactly
-- the fees. These tables are the RECORD of a schedule; the domain is the
-- CALCULATOR. A pgTAP assertion in 19_fee_schedules.sql keeps it that way.
--
-- Decisions implemented: D-10 (rates and caps), D-13 (versioned, never
-- edited), D-14 (VAT explicit and zero), D-04a (withdrawal fee brackets are
-- OPEN and therefore seeded with no rows).
-- See docs/phase-4/financial-decisions.md.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Collection fee schedules ────────────────────────────────────────────────

create table public.fee_schedules (
  version                   text        primary key,
  effective_from            date        not null,

  -- Rates are integer basis points. 100 bps = 1%. There is no float anywhere
  -- in Kolekto's money path, including in a rate: a float rate multiplied by
  -- an integer amount reintroduces exactly the problem the integer amount
  -- exists to prevent (ADR 0003).
  platform_rate_default_bps integer     not null,
  gateway_rate_bps          integer     not null,
  vat_rate_bps              integer     not null,

  -- Each component is capped independently, and the caps are ASYMMETRIC by
  -- decision (D-10): Kolekto's own fee caps higher than the modeled provider
  -- fee. NULL means uncapped, which is a different statement from zero.
  max_platform_fee_kobo     app.kobo,
  max_gateway_fee_kobo      app.kobo,

  notes                     text,
  created_at                timestamptz not null default now(),
  created_by                uuid        references public.users (id) on delete restrict,

  constraint fee_schedules_platform_rate_is_bps
    check (platform_rate_default_bps between 0 and 10000),
  constraint fee_schedules_gateway_rate_is_bps
    check (gateway_rate_bps between 0 and 10000),
  constraint fee_schedules_vat_rate_is_bps
    check (vat_rate_bps between 0 and 10000),
  constraint fee_schedules_caps_not_negative
    check (coalesce(max_platform_fee_kobo, 0) >= 0
       and coalesce(max_gateway_fee_kobo, 0)  >= 0)
);

comment on table public.fee_schedules is
  'D-13: a versioned, effective-dated fee schedule. Append-only — a rate change is a new version, never an edit, because every money row stores the version it used and editing one would restate history. The arithmetic lives in packages/domain/src/fees.ts, never here.';
comment on column public.fee_schedules.vat_rate_bps is
  'D-14: VAT, explicitly. Zero today. Present as a column rather than absent so that "we considered VAT and it is zero" is distinguishable from "nobody thought about VAT", and so reintroducing it is a new schedule version rather than a schema change.';
comment on column public.fee_schedules.max_platform_fee_kobo is
  'D-10: Kolekto''s own fee caps at this figure per transaction. NULL means uncapped.';
comment on column public.fee_schedules.max_gateway_fee_kobo is
  'D-10: the MODELED provider fee caps at this figure. The model is never the truth once the provider reports an actual fee (D-11).';

create index fee_schedules_effective_idx on public.fee_schedules (effective_from desc);

alter table public.fee_schedules enable row level security;
alter table public.fee_schedules force  row level security;


-- ── Per-category platform rates ─────────────────────────────────────────────
-- A schedule may charge a different platform rate per collection category. The
-- founder's current schedule (D-10) charges one rate for everything, so this
-- table is created and left empty for that version — the default on the
-- schedule is what applies. It exists because the previous schedule DID vary
-- by category, and a shape that cannot express the past cannot be compared
-- against it.

create table public.fee_schedule_category_rates (
  schedule_version  text                       not null
                    references public.fee_schedules (version) on delete restrict,
  category          public.collection_category not null,
  platform_rate_bps integer                    not null,

  primary key (schedule_version, category),

  constraint fee_schedule_category_rates_is_bps
    check (platform_rate_bps between 0 and 10000)
);

comment on table public.fee_schedule_category_rates is
  'Optional per-category platform rate override within one fee schedule version. Absent means the schedule''s platform_rate_default_bps applies. Append-only, like its parent.';

alter table public.fee_schedule_category_rates enable row level security;
alter table public.fee_schedule_category_rates force  row level security;


-- ── Withdrawal fee schedules ────────────────────────────────────────────────
-- D-04: the first withdrawal from a collection is free; a subsequent one
-- carries a fee between ₦100 and ₦500 by amount.
--
-- D-04a: THE BRACKETS ARE NOT DECIDED. So no bracket row is created here.
-- Seeding a guess inside the stated range would be indistinguishable, six
-- months from now, from a decision somebody made — and a withdrawal fee that
-- nobody chose is worse than a withdrawal fee that cannot yet be computed.
-- The structure is versioned and effective-dated so the brackets can land as
-- data, with no migration, once the founder sets them.

create table public.withdrawal_fee_schedules (
  version        text        primary key,
  effective_from date        not null,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid        references public.users (id) on delete restrict
);

comment on table public.withdrawal_fee_schedules is
  'D-04/D-04a: versioned withdrawal fee schedule. Deliberately holds NO version in M8.1 — the ₦100–₦500 brackets are OPEN (O-2) and a fee nobody chose must not be computable.';

alter table public.withdrawal_fee_schedules enable row level security;
alter table public.withdrawal_fee_schedules force  row level security;


create table public.withdrawal_fee_brackets (
  schedule_version text     not null
                   references public.withdrawal_fee_schedules (version) on delete restrict,
  -- Half-open interval [min, max): `max_amount_kobo` NULL is the top bracket.
  min_amount_kobo  app.kobo not null,
  max_amount_kobo  app.kobo,
  fee_kobo         app.kobo not null,

  primary key (schedule_version, min_amount_kobo),

  constraint withdrawal_fee_brackets_min_not_negative check (min_amount_kobo >= 0),
  constraint withdrawal_fee_brackets_fee_not_negative check (fee_kobo        >= 0),
  constraint withdrawal_fee_brackets_ordered
    check (max_amount_kobo is null or max_amount_kobo > min_amount_kobo)
);

comment on table public.withdrawal_fee_brackets is
  'A withdrawal fee bracket, [min_amount_kobo, max_amount_kobo). Empty in M8.1 by decision (D-04a). The first withdrawal from a collection is free regardless of any bracket — that is a property of the withdrawal, not of this table.';

alter table public.withdrawal_fee_brackets enable row level security;
alter table public.withdrawal_fee_brackets force  row level security;


-- ── Append-only, enforced twice (DAT-02) ────────────────────────────────────
-- Once by withholding the privilege, once by a trigger. Two mechanisms because
-- a privilege can be granted by a future migration in a hurry, and a trigger
-- makes that grant useless rather than dangerous.

create or replace function app.block_fee_schedule_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'FEE_SCHEDULE_IS_APPEND_ONLY: %.% cannot be % (D-13)',
    tg_table_schema, tg_table_name, lower(tg_op)
    using errcode = 'P0001',
          hint = 'A rate change is a new schedule version. Editing a version would restate every transaction that stored it.';
  return null;
end;
$$;

comment on function app.block_fee_schedule_mutation() is
  'D-13: refuses any UPDATE or DELETE on a fee schedule or its brackets. A schedule is replaced wholesale by a new version, never edited, because historical money rows point at the version they used.';

create trigger fee_schedules_no_update
  before update on public.fee_schedules
  for each row execute function app.block_fee_schedule_mutation();

create trigger fee_schedules_no_delete
  before delete on public.fee_schedules
  for each row execute function app.block_fee_schedule_mutation();

create trigger fee_schedule_category_rates_no_update
  before update on public.fee_schedule_category_rates
  for each row execute function app.block_fee_schedule_mutation();

create trigger fee_schedule_category_rates_no_delete
  before delete on public.fee_schedule_category_rates
  for each row execute function app.block_fee_schedule_mutation();

create trigger withdrawal_fee_schedules_no_update
  before update on public.withdrawal_fee_schedules
  for each row execute function app.block_fee_schedule_mutation();

create trigger withdrawal_fee_schedules_no_delete
  before delete on public.withdrawal_fee_schedules
  for each row execute function app.block_fee_schedule_mutation();

create trigger withdrawal_fee_brackets_no_update
  before update on public.withdrawal_fee_brackets
  for each row execute function app.block_fee_schedule_mutation();

create trigger withdrawal_fee_brackets_no_delete
  before delete on public.withdrawal_fee_brackets
  for each row execute function app.block_fee_schedule_mutation();


-- ── Reads ───────────────────────────────────────────────────────────────────
-- A fee schedule is not secret. An organiser is shown the rates before they
-- publish a collection, and an officer is entitled to know what was charged.
-- Same reasoning as `permissions` and `role_permissions`, which are readable
-- by any signed-in caller so the UI can mirror the server's rules.
--
-- Writes are not granted to anybody. A schedule version is inserted by a
-- migration, which is reviewed and versioned, exactly like the permission
-- catalogue.

create policy fee_schedules_select_all
  on public.fee_schedules for select to authenticated
  using (true);

create policy fee_schedule_category_rates_select_all
  on public.fee_schedule_category_rates for select to authenticated
  using (true);

create policy withdrawal_fee_schedules_select_all
  on public.withdrawal_fee_schedules for select to authenticated
  using (true);

create policy withdrawal_fee_brackets_select_all
  on public.withdrawal_fee_brackets for select to authenticated
  using (true);

grant select on table public.fee_schedules                to authenticated;
grant select on table public.fee_schedule_category_rates  to authenticated;
grant select on table public.withdrawal_fee_schedules     to authenticated;
grant select on table public.withdrawal_fee_brackets      to authenticated;

revoke update, delete, truncate on public.fee_schedules               from authenticated, anon;
revoke update, delete, truncate on public.fee_schedule_category_rates from authenticated, anon;
revoke update, delete, truncate on public.withdrawal_fee_schedules    from authenticated, anon;
revoke update, delete, truncate on public.withdrawal_fee_brackets     from authenticated, anon;


-- ── The founder's schedule (D-10) ───────────────────────────────────────────
--
--   Kolekto platform fee   1.5%  (150 bps), all categories, capped at ₦5,000
--   Provider fee, modeled  1.5%  (150 bps),                 capped at ₦2,000
--   VAT                    0%
--
-- The modeled provider rate is an ESTIMATE and is labelled as one everywhere.
-- The founder's current understanding is that Paystack charges nearer 1%, but
-- the model stays at 1.5% until actual transaction data says otherwise — and
-- once Paystack reports a fee, the REPORTED figure is the financial truth and
-- the model is not consulted again for that transaction (D-11).
--
-- `SCHEDULE_2026_09_PROVISIONAL` in packages/domain is NOT replaced by this. It
-- carried the old system's rates so the arithmetic could be compared against
-- known behaviour, it is pinned by golden vectors, and no transaction has ever
-- referenced it. It stays as a test fixture; this is the schedule Kolekto means.
insert into public.fee_schedules (
  version, effective_from,
  platform_rate_default_bps, gateway_rate_bps, vat_rate_bps,
  max_platform_fee_kobo, max_gateway_fee_kobo,
  notes
) values (
  '2026-09-founder', date '2026-09-24',
  150, 150, 0,
  500000, 200000,
  'M8.1 / D-10. Kolekto 1.5% capped at ₦5,000; modeled provider fee 1.5% capped at ₦2,000; VAT 0%. The provider rate is a model — Paystack''s reported fee is the truth (D-11). One rate for every category (assumption A-3).'
);
