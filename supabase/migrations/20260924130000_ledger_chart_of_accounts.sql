-- ─────────────────────────────────────────────────────────────────────────────
-- 20260924130000 — M8.1 step 11a: the chart of accounts, as a vocabulary
--
-- `ledger_accounts.code` was free text. This makes it a reference, so that a
-- typo cannot invent an account.
--
-- WHY THIS MATTERS MORE THAN IT LOOKS. An account code is the thing a balance
-- is grouped by. `collection_availabe` (sic) would create a second, empty,
-- plausible-looking account, and the money in the real one would simply not
-- appear in a total that filtered on the correct spelling. Nothing would error.
-- A financial report would just be quietly wrong — which is the exact shape of
-- the failures this rebuild exists to remove.
--
-- The chart itself comes from ADR 0015: subaccount custody with
-- Kolekto-controlled settlement, and financial ownership at the COLLECTION.
--
-- Additive and safe: `ledger_accounts` is empty, so the foreign key and the
-- scope check have nothing to conflict with.
-- ─────────────────────────────────────────────────────────────────────────────


-- Which tenancy scope an account code is allowed to be used at. Part of the
-- vocabulary rather than a convention, because "platform income, accidentally
-- created per collection" is a reporting error nobody would see.
create type public.ledger_account_scope as enum (
  'platform',    -- community_id null, collection_id null
  'community',   -- community_id set,  collection_id null
  'collection'   -- community_id set,  collection_id set
);


create table public.ledger_account_codes (
  code        text                       primary key,
  scope       public.ledger_account_scope not null,
  type        public.ledger_account_type  not null,
  description text                        not null,

  constraint ledger_account_codes_code_not_blank
    check (length(btrim(code)) > 0),
  constraint ledger_account_codes_description_not_blank
    check (length(btrim(description)) > 0)
);

comment on table public.ledger_account_codes is
  'The chart of accounts as a closed vocabulary (ADR 0015). A code names its permitted tenancy scope and its accounting type, so an account cannot be created at the wrong scope or with the wrong type, and a misspelled code cannot silently become a new account.';

alter table public.ledger_account_codes enable row level security;
alter table public.ledger_account_codes force  row level security;

create policy ledger_account_codes_select_all
  on public.ledger_account_codes for select to authenticated
  using (true);

grant select on table public.ledger_account_codes to authenticated;
revoke insert, update, delete, truncate on public.ledger_account_codes from authenticated, anon;


-- ── The chart ───────────────────────────────────────────────────────────────
--
-- Money's path through it, for one contribution:
--
--   capture          provider_receivable  →  collection_pending
--   fees             collection_pending   →  platform_fee_income
--                    collection_pending   →  provider_fee_expense
--   T+1 release      collection_pending   →  collection_available   (D-09)
--   withdrawal       collection_available →  collection_withdrawing
--   payout settled   collection_withdrawing → collection_withdrawn
--
-- Every line is explainable, every line is reversible, and no line is an
-- update.
--
-- ── WHY THIS CHART SURVIVES PA-04 BEING FALSE ───────────────────────────────
--
-- D-01 assumes Paystack subaccount settlement timing is controllable by
-- Kolekto. That is PA-04, and it is UNVERIFIED. If it turns out false, Kolekto
-- falls back to Paystack settling each organiser directly, and this chart does
-- not change: `collection_withdrawing` and `collection_withdrawn` simply become
-- states no journal ever reaches, and the settlement is recorded against
-- `collection_available` by the provider rather than by a withdrawal. A chart
-- with two unreached accounts is a smaller problem than a chart built twice.
insert into public.ledger_account_codes (code, scope, type, description) values
  -- ── Platform ──────────────────────────────────────────────────────────────
  ('provider_receivable',      'platform',   'asset',
   'Money a contributor has paid that the provider has not yet settled to a bank. Debited at capture.'),
  ('platform_fee_income',      'platform',   'income',
   'Kolekto''s own fee. 1.5%, capped at ₦5,000 per transaction (D-10).'),
  ('provider_fee_expense',     'platform',   'expense',
   'The payment provider''s fee. Modeled at 1.5% until the provider reports the actual figure, which is then the truth (D-11).'),
  ('vat_payable',              'platform',   'liability',
   'VAT collected on Kolekto''s fee and owed onward. Zero under the current schedule (D-14); the account exists so a future non-zero VAT is a schedule version rather than a migration.'),
  ('suspense',                 'platform',   'liability',
   'Captured money with no resolvable collection. Exists so that capture NEVER waits for attribution — the old system''s rejection paths discarded money rather than parking it. A non-zero balance here is somebody''s job (O-9).'),

  -- ── Collection ────────────────────────────────────────────────────────────
  ('collection_pending',       'collection', 'liability',
   'Captured and attributed to this collection, not yet available. Becomes available at 05:00 Africa/Lagos on the following calendar day (D-09).'),
  ('collection_available',     'collection', 'liability',
   'Released and withdrawable. A balance_release journal put it here; no clock comparison did (D-09c).'),
  ('collection_on_hold',       'collection', 'liability',
   'Held against a dispute (D-20). Only the disputed amount is held; the rest of the collection stays available.'),
  ('collection_withdrawing',   'collection', 'liability',
   'A withdrawal has been posted and a payout is in flight. A failed payout returns it to available by a reversing journal, never by an edit.'),
  ('collection_withdrawn',     'collection', 'liability',
   'Successfully transferred to the organiser''s bank.'),
  ('collection_refund_reserve','collection', 'liability',
   'Set aside against a refund. Refunds are DEFERRED (D-18); the account exists so that adding them later is a posting rather than a schema change.'),
  ('collection_chargeback',    'collection', 'liability',
   'A lost dispute charged back against this collection. May leave the collection owing, which future incoming funds satisfy before anything becomes available again (D-20).');


-- ── Wire the vocabulary to the accounts ─────────────────────────────────────

alter table public.ledger_accounts
  add constraint ledger_accounts_code_fkey
  foreign key (code) references public.ledger_account_codes (code) on delete restrict;

-- The scope declared by the code must match the scope the row actually has.
-- Without this, `platform_fee_income` could be created per collection, and a
-- platform income total would silently depend on which rows somebody happened
-- to sum.
create or replace function app.assert_ledger_account_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_code public.ledger_account_codes%rowtype;
  v_scope public.ledger_account_scope;
begin
  select * into v_code
  from public.ledger_account_codes
  where code = new.code;

  -- The foreign key already guarantees this, so reaching here means the FK was
  -- dropped. Refuse rather than assume.
  if v_code.code is null then
    raise exception 'UNKNOWN_LEDGER_ACCOUNT_CODE: % is not in the chart of accounts', new.code
      using errcode = 'P0001';
  end if;

  v_scope := case
    when new.community_id is null and new.collection_id is null then 'platform'
    when new.collection_id is null                              then 'community'
    else 'collection'
  end;

  if v_scope <> v_code.scope then
    raise exception
      'LEDGER_ACCOUNT_SCOPE_MISMATCH: % is a % account but was created at % scope',
      new.code, v_code.scope, v_scope
      using errcode = 'P0001',
            hint = 'A platform account carries no community and no collection. A collection account carries both.';
  end if;

  if new.type <> v_code.type then
    raise exception
      'LEDGER_ACCOUNT_TYPE_MISMATCH: % is a % account, not a %',
      new.code, v_code.type, new.type
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function app.assert_ledger_account_scope() is
  'Step 11a: an account''s tenancy scope and accounting type must match what its code declares. Stops platform income being created per collection, or a liability being created as an asset.';

create trigger ledger_accounts_scope_matches_code
  before insert on public.ledger_accounts
  for each row execute function app.assert_ledger_account_scope();
