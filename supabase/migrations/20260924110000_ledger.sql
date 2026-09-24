-- ─────────────────────────────────────────────────────────────────────────────
-- 20260924110000 — M8.1 steps 5 to 9: the ledger
--
-- Double entry, append-only, collection-scoped. The financial source of truth.
--
-- ADR 0006 deferred this, correctly, until the settlement model was chosen,
-- because the chart of accounts follows from the model and building it twice
-- was the risk. ADR 0015 closes that: the model is subaccount custody with
-- Kolekto-controlled settlement, and financial ownership sits at the
-- COLLECTION, not the community.
--
-- ── WHAT A BALANCE IS ───────────────────────────────────────────────────────
--
-- A sum over `ledger_entries`. Never a column. There is no balance column in
-- this migration and there will not be one, because the previous system had
-- five per collection —`gross_payment`, `net_payment`, `ledger_balance`,
-- `available_balance`, `pending_balance` — rewritten nightly by
-- `settlement_recompute_wallets()`, and the identifier `ledger_balance` named
-- a cache with no entries behind it. Nothing recorded WHY a balance changed.
-- `wallet += delta` produced negative stored balances in production.
--
-- ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
--
-- Nothing posts. There is no function in this migration that writes a journal,
-- because every legitimate writer of a journal — capture, fee posting, balance
-- release, withdrawal, payout, refund — belongs to a later milestone and to a
-- provider integration that does not exist. What is here is the RECORD, its
-- invariants, and the protections that make those invariants true whatever a
-- future writer does.
--
-- Three tables, one trigger that makes a journal balance, and two triggers per
-- table that make history permanent.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Enums ───────────────────────────────────────────────────────────────────

create type public.ledger_account_type as enum (
  'asset',
  'liability',
  'income',
  'expense',
  'equity'
);

create type public.ledger_direction as enum (
  'debit',
  'credit'
);

-- What caused a journal. Named rather than free text so a reconciliation can
-- group by cause, and so the CHECK that demands collection attribution can be
-- written against it (step 11).
--
-- Every value a later milestone will need is listed now. That is deliberate:
-- adding an enum value is a migration, and a writer that cannot name its own
-- cause would otherwise be tempted to borrow one that nearly fits.
create type public.ledger_source_type as enum (
  'capture',               -- a contributor's payment was captured
  'fee',                   -- platform and provider fees taken from a capture
  'balance_release',       -- T+1: pending became available (D-09)
  'withdrawal',            -- an organiser's withdrawal was posted
  'payout',                -- a provider transfer executed a withdrawal
  'refund',                -- money returned to a contributor (DEFERRED, D-18)
  'dispute_hold',          -- an amount held pending a dispute (D-20)
  'chargeback',            -- a dispute was lost (D-20)
  'reversal',              -- a correcting journal (see reverses_journal_id)
  'adjustment'             -- an operator correction, with a reason, never an edit
);


-- ── Accounts ────────────────────────────────────────────────────────────────
--
-- Three scopes, expressed by which of the two tenancy columns are set:
--
--   platform     community_id null, collection_id null
--   community    community_id set,  collection_id null
--   collection   community_id set,  collection_id set
--
-- `nulls not distinct` on the unique index is what makes this work: without
-- it, two platform accounts with the same code would both be permitted,
-- because in SQL NULL is never equal to NULL.

create table public.ledger_accounts (
  id            uuid primary key default gen_random_uuid(),

  community_id  uuid references public.communities (id) on delete restrict,
  collection_id uuid references public.collections  (id) on delete restrict,

  code          text                          not null,
  type          public.ledger_account_type     not null,
  currency      text                           not null default 'NGN',

  created_at    timestamptz                    not null default now(),

  -- A collection-scoped account must name its community too. An account
  -- scoped to a collection but not a community would be an orphan whose
  -- tenancy could only be discovered by a join.
  constraint ledger_accounts_collection_implies_community
    check (collection_id is null or community_id is not null),

  constraint ledger_accounts_code_not_blank
    check (length(btrim(code)) > 0),

  -- Kolekto is NGN-only today. The column exists because a currency is part of
  -- every serious ledger's identity, and a CHECK is how "we only do naira" is
  -- a statement rather than an omission.
  constraint ledger_accounts_currency_is_ngn
    check (currency = 'NGN')
);

comment on table public.ledger_accounts is
  'ADR 0015: the chart of accounts, scoped to platform, community or COLLECTION. A balance is a sum over ledger_entries for an account — never a column on this table.';
comment on column public.ledger_accounts.collection_id is
  'D-02: set for every account holding an organiser''s money, because financial ownership is the collection. There is no community wallet and there never will be.';

create unique index ledger_accounts_scope_code_key
  on public.ledger_accounts (community_id, collection_id, code)
  nulls not distinct;

create index ledger_accounts_collection_idx on public.ledger_accounts (collection_id)
  where collection_id is not null;
create index ledger_accounts_community_idx  on public.ledger_accounts (community_id)
  where community_id is not null;

alter table public.ledger_accounts enable row level security;
alter table public.ledger_accounts force  row level security;


-- ── Journals ────────────────────────────────────────────────────────────────
--
-- A journal is a financial event. Its entries must sum to zero (step 8), it
-- carries WHY it happened, and its `idempotency_key` is what makes a duplicate
-- provider event a no-op rather than a second credit.

create table public.ledger_journals (
  id                   uuid primary key default gen_random_uuid(),

  community_id         uuid                        not null
                       references public.communities (id) on delete restrict,
  -- Step 11. Nullable only because a platform-only journal (Kolekto's own
  -- economics, with no organiser money in it) has no collection. Which
  -- source types MAY leave it null is enforced by a CHECK below, so the
  -- nullability is a narrow exception rather than a general one.
  collection_id        uuid
                       references public.collections (id) on delete restrict,

  occurred_at          timestamptz                 not null,
  posted_at            timestamptz                 not null default now(),

  source_type          public.ledger_source_type   not null,
  source_id            uuid,
  reason               text                        not null,

  -- Who, snapshotted. HND-04: a historical action is never reattributed
  -- because somebody left.
  actor_type           public.audit_actor_type     not null,
  actor_user_id        uuid references public.users (id) on delete restrict,
  actor_name_snapshot  text,

  -- D-13: which fee schedule priced this. Present on the journal as well as on
  -- the money rows, so a balance can be explained without joining out to the
  -- transaction that produced it.
  fee_schedule_version text references public.fee_schedules (version) on delete restrict,

  -- D-25: an idempotency key is a UNIQUE INDEX, never a lookup-then-insert.
  -- Every "check if it exists, then insert" in the old code was a race.
  idempotency_key      text                        not null,

  -- A correction is a reversing journal pointing at what it reverses. This is
  -- the ONLY correction mechanism: nothing is edited and nothing is deleted.
  reverses_journal_id  uuid references public.ledger_journals (id) on delete restrict,

  constraint ledger_journals_reason_not_blank
    check (length(btrim(reason)) > 0),

  constraint ledger_journals_idempotency_key_not_blank
    check (length(btrim(idempotency_key)) > 0),

  -- A journal cannot reverse itself.
  constraint ledger_journals_no_self_reversal
    check (reverses_journal_id is null or reverses_journal_id <> id),

  -- ── Step 11: collection attribution is mandatory where it applies ─────────
  --
  -- This is the structural answer to the failure that produced roughly ₦19.8m
  -- of legacy deposits with no collection attribution. Money cannot be
  -- recorded as an organiser's without naming whose collection it is.
  --
  -- The exceptions are exactly two, and both are cases where there IS no
  -- collection rather than cases where naming one is inconvenient:
  --   · 'fee'       — Kolekto's own income and the provider's expense
  --   · 'adjustment'— an operator correction that may be platform-level
  -- Everything else must name its collection.
  constraint ledger_journals_collection_attribution
    check (
      collection_id is not null
      or source_type in ('fee', 'adjustment')
    )
);

comment on table public.ledger_journals is
  'A financial event. Its entries balance to zero (asserted at commit), it records why it happened and who caused it, and it is unique on idempotency_key so a duplicated provider event has no second effect. Append-only.';
comment on column public.ledger_journals.idempotency_key is
  'D-25: the identity of the operation that produced this journal — a provider event id, a payment reference, a transfer reference. Enforced as a unique index, because a read-then-insert is a race.';
comment on column public.ledger_journals.collection_id is
  'D-02: which collection this money belongs to. Mandatory for every source type except platform-only fee and adjustment journals, enforced by ledger_journals_collection_attribution. The absence of this enforcement is how the legacy unattributed set happened.';
comment on column public.ledger_journals.reverses_journal_id is
  'The journal this one corrects. A reversing journal repeats the original''s entries with directions swapped; both remain for ever. This is the only correction mechanism in the ledger.';

create unique index ledger_journals_idempotency_key
  on public.ledger_journals (idempotency_key);

create index ledger_journals_collection_time_idx
  on public.ledger_journals (collection_id, occurred_at desc)
  where collection_id is not null;
create index ledger_journals_community_time_idx
  on public.ledger_journals (community_id, occurred_at desc);
create index ledger_journals_source_idx
  on public.ledger_journals (source_type, source_id)
  where source_id is not null;
create index ledger_journals_reverses_idx
  on public.ledger_journals (reverses_journal_id)
  where reverses_journal_id is not null;

alter table public.ledger_journals enable row level security;
alter table public.ledger_journals force  row level security;


-- ── Entries ─────────────────────────────────────────────────────────────────
--
-- One debit or one credit against one account. The only thing a balance is
-- ever computed from.

create table public.ledger_entries (
  id          uuid primary key default gen_random_uuid(),

  journal_id  uuid                     not null
              references public.ledger_journals (id) on delete restrict,
  account_id  uuid                     not null
              references public.ledger_accounts (id) on delete restrict,

  direction   public.ledger_direction  not null,

  -- Always POSITIVE. The direction carries the sign. A negative amount with a
  -- direction is two ways of saying the same thing, and two ways of saying it
  -- is how a sum ends up wrong.
  amount_kobo app.kobo                 not null,

  currency    text                     not null default 'NGN',
  created_at  timestamptz              not null default now(),

  constraint ledger_entries_amount_positive
    check (amount_kobo > 0),
  constraint ledger_entries_currency_is_ngn
    check (currency = 'NGN')
);

comment on table public.ledger_entries is
  'One debit or one credit. Append-only, immutable, and the only source a balance is computed from. amount_kobo is always positive; the direction carries the sign.';

create index ledger_entries_journal_idx on public.ledger_entries (journal_id);
-- The index that makes a balance a cheap sum rather than a table scan.
create index ledger_entries_account_idx on public.ledger_entries (account_id, created_at desc);

alter table public.ledger_entries enable row level security;
alter table public.ledger_entries force  row level security;


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 8: every journal balances
--
-- A CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, so the check runs once
-- at commit rather than after each row. This is not an optimisation: a journal
-- is written as several INSERTs, and a per-row check would refuse the first
-- one — a single debit, with its credit not yet written, never balances.
--
-- Checking at commit means a transaction can build a journal in any order and
-- still be refused if it ends up lopsided.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.assert_journal_balances()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_journal_id uuid := coalesce(new.journal_id, old.journal_id);
  v_debits     bigint;
  v_credits    bigint;
  v_entries    integer;
begin
  select
    coalesce(sum(case when e.direction = 'debit'  then e.amount_kobo else 0 end), 0),
    coalesce(sum(case when e.direction = 'credit' then e.amount_kobo else 0 end), 0),
    count(*)
  into v_debits, v_credits, v_entries
  from public.ledger_entries e
  where e.journal_id = v_journal_id;

  -- A journal with no entries at all is not a balanced journal, it is an empty
  -- one, and an empty financial event is a bug rather than a no-op.
  if v_entries = 0 then
    raise exception
      'JOURNAL_IS_EMPTY: journal % has no entries. A financial event with no debits and no credits records nothing.',
      v_journal_id
      using errcode = 'P0001';
  end if;

  if v_debits <> v_credits then
    raise exception
      'JOURNAL_DOES_NOT_BALANCE: journal % has debits of % kobo against credits of % kobo (difference % kobo)',
      v_journal_id, v_debits, v_credits, v_debits - v_credits
      using errcode = 'P0001',
            hint = 'Every journal must satisfy SUM(debits) = SUM(credits). Post the balancing entry in the same transaction.';
  end if;

  return null;
end;
$$;

comment on function app.assert_journal_balances() is
  'Step 8: asserts SUM(debits) = SUM(credits) for a journal, at COMMIT. Deferred because a journal is written as several rows and a per-row check would refuse the first one.';

create constraint trigger ledger_entries_journal_balances
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function app.assert_journal_balances();

-- A journal must also not be left with no entries at all. The trigger above
-- only fires when an entry is inserted, so a journal inserted alone would
-- otherwise commit empty.
create or replace function app.assert_journal_has_entries()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_entries integer;
begin
  select count(*) into v_entries
  from public.ledger_entries e
  where e.journal_id = new.id;

  if v_entries = 0 then
    raise exception
      'JOURNAL_IS_EMPTY: journal % was committed with no entries',
      new.id
      using errcode = 'P0001',
            hint = 'Write the journal and its entries in one transaction. A journal is the grouping of its entries, not a record in its own right.';
  end if;

  return null;
end;
$$;

comment on function app.assert_journal_has_entries() is
  'Refuses a journal committed with no entries. Paired with assert_journal_balances(), which cannot fire when no entry is written at all.';

create constraint trigger ledger_journals_have_entries
  after insert on public.ledger_journals
  deferrable initially deferred
  for each row execute function app.assert_journal_has_entries();


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 9: append-only, enforced twice (DAT-02)
--
-- Once by withholding the privilege, once by a trigger. Two mechanisms because
-- a privilege can be granted by a future migration in a hurry, and a trigger
-- makes that grant useless rather than dangerous.
--
-- This is the same pair that already protects `audit_logs` and
-- `contributor_references`.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.block_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'LEDGER_IS_APPEND_ONLY: %.% cannot be % (LED-03, DAT-02)',
    tg_table_schema, tg_table_name, lower(tg_op)
    using errcode = 'P0001',
          hint = 'A correction is a reversing journal pointing at the journal it corrects — never an edit, and never a delete. Both rows remain, and the history explains itself.';
  return null;
end;
$$;

comment on function app.block_ledger_mutation() is
  'Step 9: refuses any UPDATE or DELETE on the ledger, for every role including the owner. The only correction is a reversing journal.';

create trigger ledger_accounts_no_update
  before update on public.ledger_accounts
  for each row execute function app.block_ledger_mutation();

create trigger ledger_accounts_no_delete
  before delete on public.ledger_accounts
  for each row execute function app.block_ledger_mutation();

create trigger ledger_journals_no_update
  before update on public.ledger_journals
  for each row execute function app.block_ledger_mutation();

create trigger ledger_journals_no_delete
  before delete on public.ledger_journals
  for each row execute function app.block_ledger_mutation();

create trigger ledger_entries_no_update
  before update on public.ledger_entries
  for each row execute function app.block_ledger_mutation();

create trigger ledger_entries_no_delete
  before delete on public.ledger_entries
  for each row execute function app.block_ledger_mutation();


-- ── Reads ───────────────────────────────────────────────────────────────────
--
-- The ledger is readable by whoever may see a community's balances, which is
-- the permission that already exists for exactly this purpose: `balance.view`,
-- held by owner, admin, treasurer and viewer. A collector never sees money.
--
-- No write is granted to any client role. Every future writer is an `app.*`
-- SECURITY DEFINER function in a reviewed migration.

create policy ledger_accounts_select_officer
  on public.ledger_accounts for select to authenticated
  using (community_id is not null and app.has_permission(community_id, 'balance.view'));

create policy ledger_journals_select_officer
  on public.ledger_journals for select to authenticated
  using (app.has_permission(community_id, 'balance.view'));

-- An entry is visible when its journal is. Scoping the entry through the
-- journal rather than duplicating tenancy onto the entry keeps one answer to
-- "who may see this", at the cost of a join the planner handles with
-- ledger_entries_journal_idx.
create policy ledger_entries_select_officer
  on public.ledger_entries for select to authenticated
  using (
    exists (
      select 1
      from public.ledger_journals j
      where j.id = public.ledger_entries.journal_id
        and app.has_permission(j.community_id, 'balance.view')
    )
  );

grant select on table public.ledger_accounts to authenticated;
grant select on table public.ledger_journals to authenticated;
grant select on table public.ledger_entries  to authenticated;

revoke insert, update, delete, truncate on public.ledger_accounts from authenticated, anon;
revoke insert, update, delete, truncate on public.ledger_journals from authenticated, anon;
revoke insert, update, delete, truncate on public.ledger_entries  from authenticated, anon;
