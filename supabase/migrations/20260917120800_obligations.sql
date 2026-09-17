-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120800 — Obligations
--
-- What ONE member is expected to pay toward ONE collection (PRD 0.3, section 5).
-- This is the table the previous system never had: it recorded who *did* pay
-- and never who *should*, which is why "who hasn't paid" required a treasurer
-- with a spreadsheet and a bank app.
--
-- ADR 0006 boundary: there is no `amount_paid` column and no status transition
-- into 'paid' in this phase. Money has not arrived yet. `amount_paid` will be
-- DERIVED from contributions (OBL-01), never stored and edited — the previous
-- system's mutable `wallets` numbers are exactly what we are not rebuilding.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.obligations (
  id                  uuid primary key default app.uuid_generate_v7(),
  community_id        uuid not null references public.communities (id) on delete restrict,
  collection_id       uuid not null references public.collections (id) on delete restrict,
  member_id           uuid not null references public.members (id)     on delete restrict,

  -- PRD 5.7: recurring collections create one cycle per period. NULL for
  -- one-time collections. The cycles table arrives with recurring support in
  -- Phase 5; the column exists now so the unique index below is correct from
  -- the start rather than being widened later under data.
  cycle_key           text,

  -- ADR 0003: bigint kobo.
  expected_amount_kobo app.kobo not null,

  -- OBL-08: a discount approved by officers, with a reason. NOT a payment, and
  -- never counted as money collected (CASH-02).
  waived_amount_kobo   app.kobo not null default 0,
  waived_reason        text,
  waived_by            uuid references public.users (id) on delete set null,
  waived_at            timestamptz,

  due_at              timestamptz,

  -- OBL-07: exempting requires a reason, and is visible to viewers.
  exempt              boolean not null default false,
  exempt_reason       text,
  exempt_by           uuid references public.users (id) on delete set null,
  exempt_at           timestamptz,

  -- PRD 5.2. Derived from the balance and the due date once contributions
  -- exist; until then every row is 'unpaid', 'exempt' or 'cancelled'.
  status              public.obligation_status not null default 'unpaid',

  -- OBL-12: a signed, non-guessable token for the member's personal payment
  -- link (/o/{token}). Hashed, like every other token here (SEC-20b).
  -- PRD 14.3 requires these to be STABLE per member so an estate can print them
  -- on a paper bill — so the token is issued once and not rotated casually.
  link_token_prefix   text,
  link_token_hash     text,

  -- Optimistic concurrency for the compare-and-set transitions in STM-01.
  version             integer not null default 0,

  assigned_by         uuid references public.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  cancelled_at        timestamptz,

  constraint obligations_expected_positive
    check (expected_amount_kobo > 0),
  constraint obligations_waived_not_negative
    check (waived_amount_kobo >= 0),
  constraint obligations_waived_within_expected
    check (waived_amount_kobo <= expected_amount_kobo),
  constraint obligations_waived_has_reason
    check ((waived_amount_kobo = 0) or (waived_reason is not null and waived_by is not null)),
  constraint obligations_exempt_has_reason
    check (not exempt or (exempt_reason is not null and exempt_at is not null)),
  constraint obligations_exempt_status_agrees
    check ((status = 'exempt') = exempt),
  constraint obligations_cancelled_has_timestamp
    check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint obligations_link_token_paired
    check ((link_token_prefix is null) = (link_token_hash is null)),
  constraint obligations_link_token_format
    check (link_token_prefix is null
           or (link_token_prefix ~ '^[A-Za-z0-9_-]{8,16}$' and link_token_hash ~ '^[a-f0-9]{64}$'))
);

comment on table public.obligations is
  'PRD section 5: what one member is expected to pay toward one collection. amount_paid is deliberately absent — it is derived from contributions (OBL-01), never stored.';
comment on column public.obligations.cycle_key is
  'PRD 5.7: the period label for a recurring collection, e.g. 2026-10. NULL for one-time collections.';
comment on column public.obligations.link_token_hash is
  'OBL-12 / EST-05: the member personal payment link. Stable per member so it can be printed on a bill, and stored hashed (SEC-20b).';

-- One obligation per member per collection per cycle. The PRD states this as a
-- unique constraint and it is the row that makes "who hasn't paid" answerable.
-- NULLS NOT DISTINCT so a one-time collection (cycle_key IS NULL) is covered by
-- the same index rather than needing a second partial one.
create unique index obligations_unique_member_cycle
  on public.obligations (collection_id, member_id, cycle_key)
  nulls not distinct;

create unique index obligations_link_token_prefix_key
  on public.obligations (link_token_prefix)
  where link_token_prefix is not null;

-- OBL-14: the member status table must stay responsive at 5,000 members and
-- filter in under a second (NFR-08). These are the access paths it uses.
create index obligations_collection_status_idx on public.obligations (collection_id, status);
create index obligations_member_idx            on public.obligations (member_id);
create index obligations_community_idx         on public.obligations (community_id);
create index obligations_overdue_idx           on public.obligations (due_at)
  where status in ('unpaid', 'in_installments');

create trigger obligations_set_updated_at
  before update on public.obligations
  for each row execute function app.set_updated_at();

alter table public.obligations enable row level security;
alter table public.obligations force row level security;


-- ── Tenancy consistency ──────────────────────────────────────────────────────
-- An obligation's collection and member must belong to the same community as
-- the obligation. SEC-18 says a client-supplied ID never implies tenancy; this
-- is the database making that true rather than trusting every call site.
create or replace function app.assert_obligation_tenancy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_collection_community uuid;
  v_member_community     uuid;
begin
  select community_id into v_collection_community
  from public.collections where id = new.collection_id;

  select community_id into v_member_community
  from public.members where id = new.member_id;

  if v_collection_community is distinct from new.community_id
     or v_member_community is distinct from new.community_id then
    raise exception
      'TENANCY_MISMATCH: obligation community %, collection community %, member community %',
      new.community_id, v_collection_community, v_member_community
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger obligations_assert_tenancy
  before insert or update on public.obligations
  for each row execute function app.assert_obligation_tenancy();


-- ── OBL-05: a member who has paid cannot be removed ─────────────────────────
-- In this phase nothing has been paid, so the guard only blocks deleting an
-- obligation outright — cancelling is the supported route, and it keeps the
-- row. When contributions arrive, this function gains the paid check and a
-- pgTAP test asserts it did.
create or replace function app.enforce_obligation_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'OBLIGATION_NOT_DELETABLE: obligation % cannot be deleted (OBL-05). Cancel or exempt it instead.',
    old.id
    using errcode = 'P0001',
          hint = 'Set status to cancelled, or exempt the member with a reason. The record is kept either way.';
  return null;
end;
$$;

create trigger obligations_delete_guard
  before delete on public.obligations
  for each row execute function app.enforce_obligation_delete_guard();


-- ── Deferred guards from earlier migrations ──────────────────────────────────
-- These read `obligations`, so they could only be attached once it existed.
create trigger members_delete_guard
  before delete on public.members
  for each row execute function app.enforce_member_delete_guard();

create trigger collections_delete_guard
  before delete on public.collections
  for each row execute function app.enforce_collection_delete_guard();


-- ── SEC-20a / CASH-02: there is no way to mark an obligation paid ───────────
-- No function in this schema transitions an obligation to 'paid'. The only
-- route will be an applied, Paystack-verified contribution, through a money
-- function that does not exist yet (ADR 0006).
--
-- This trigger makes the absence load-bearing rather than merely true: any
-- attempt to set status = 'paid' from a client role fails loudly. When the
-- money functions arrive they will run as a restricted role that this check
-- exempts, and the pgTAP suite asserts that no OTHER path can.
create or replace function app.block_manual_paid_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    raise exception
      'NO_MANUAL_PAID: an obligation becomes paid only through a Paystack-verified contribution (CASH-02, SEC-20a)'
      using errcode = 'P0001',
            hint = 'Kolekto is cashless. To clear a balance without payment, exempt the member or waive the amount, with a reason.';
  end if;
  return new;
end;
$$;

create trigger obligations_block_manual_paid
  before update on public.obligations
  for each row execute function app.block_manual_paid_status();

comment on function app.block_manual_paid_status() is
  'CASH-02 / SEC-20a: nobody, including owners and Kolekto staff, can mark an obligation paid. Exemptions and waivers are the only non-payment adjustments, and they are labelled as such.';
