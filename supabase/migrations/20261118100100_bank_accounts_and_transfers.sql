-- ─────────────────────────────────────────────────────────────────────────────
-- 20261118100100 — Saved bank accounts, Paystack transfers, verified-charge T+1
--
-- Audit and decisions: docs/phase-4/withdrawals-transfers-audit-2026-11-18.md
-- Owner decisions 2026-11-18 (financial-decisions.md §20):
--   Q1 fee model D-28 unchanged.
--   Q2 a payment is released at T+1 05:00 Africa/Lagos once its charge is
--      verified (the capture). Provider settlement confirmation is no longer
--      required for captures from 2026-11-18. Before each transfer the worker
--      checks the Paystack balance covers it.
--   Q3 a saved bank account whose Paystack-resolved name matches the profile
--      name replaces the identity_verified gate for withdrawals.
--   Q4 Kolekto absorbs Paystack's transfer fee; no Kolekto withdrawal fee;
--      every withdrawal is allowed (not only the first).
--
-- WHAT THIS ADDS
--   1. Settlement schedule version 2026-11-18-t1-0500-lagos-verified-charge
--      (requires_provider_confirmation = false). Appended, never edited
--      (D-09e): captures before 2026-11-18 keep the provider-confirmed rule.
--   2. transfer_fee_expense — platform expense for Paystack transfer fees,
--      separate from payment processing fees (provider_fee_expense).
--   3. user_bank_accounts — per profile, several allowed, one default.
--      Paystack-resolved account name, name-match result, status, recipient
--      code, D-08 cooling-off (48 h for any account added after the first).
--   4. withdrawals gains bank_account_id / destination_bank_code and the
--      `reversed` shape; guard allows paid → reversed.
--   5. withdrawal_transfers — one Paystack transfer per withdrawal, our own
--      reference (D-27: a timeout is unknown, resolved by verify, never a
--      blind retry), status, transfer code, fee.
--   6. Functions
--        authenticated: my_bank_accounts, set_default_bank_account,
--          disable_bank_account, request_withdrawal_to_account
--        operator only: register_bank_account, set_bank_account_recipient,
--          review_bank_account, claim_withdrawal_transfers,
--          record_withdrawal_transfer_state, settle_withdrawal_transfer,
--          withdrawal_transfers_to_check
--   7. Manual operator payout functions refuse a withdrawal that has a
--      transfer (no double payout across the two paths).
--   8. Reconciliation knows reversed withdrawals and transfers paid from the
--      Paystack balance (provider_receivable).
--
-- MONEY (all journals balanced, collection-attributed, unique keys)
--   transfer success  payout   Dr collection_withdrawing   amount+fee
--                              Cr collection_withdrawn     amount
--                              Cr platform_fee_income      fee (0 today)
--                              Dr organiser_payouts        amount
--                              Cr provider_receivable      amount   (paid from the Paystack balance)
--   transfer fee      payout   Dr transfer_fee_expense     fee
--                              Cr provider_receivable      fee
--   transfer failed   reversal hold released (existing release_withdrawal_hold)
--   transfer reversed reversal Dr collection_withdrawn     amount
--                              Cr collection_available     amount
--                              Dr provider_receivable      amount
--                              Cr organiser_payouts        amount
--
-- Additive. No existing row is edited or deleted. Two check constraints on
-- withdrawals are replaced by wider ones that every existing row satisfies.
-- Rollback (only while no transfer or saved account exists):
--   revert the replaced functions to 20261117100200 / 20261117100300 bodies;
--   drop the new functions; drop table public.withdrawal_transfers;
--   alter table public.withdrawals drop the five new columns and restore the
--   two constraints; drop table public.user_bank_accounts;
--   the settlement schedule row and account code stay (append-only; harmless
--   once nothing references them — a new version restores the old rule).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Settlement rule: verified charge + T+1 (Q2) ──────────────────────────

insert into public.settlement_schedules (
  version, effective_from, timezone, release_day_offset, release_time, requires_provider_confirmation, notes
) values (
  '2026-11-18-t1-0500-lagos-verified-charge', '2026-11-18 00:00:00+01', 'Africa/Lagos', 1, time '05:00', false,
  'D-09: 05:00 Africa/Lagos on the following calendar day, every day. Owner decision 2026-11-18 (Q2): released once the charge is verified (captured); provider settlement confirmation is not required. Transfers check the Paystack balance before paying out.'
);


-- ── 2. Chart of accounts ────────────────────────────────────────────────────

insert into public.ledger_account_codes (code, scope, type, description) values
  ('transfer_fee_expense', 'platform', 'expense',
   'Paystack''s fee for an outgoing transfer (withdrawal payout). Borne by Kolekto (owner decision 2026-11-18, Q4). Kept apart from provider_fee_expense, which is the payment processing cost.');


-- ── 3. Saved bank accounts ──────────────────────────────────────────────────

create table public.user_bank_accounts (
  id                    uuid primary key default app.uuid_generate_v7(),
  user_id               uuid not null references public.users (id) on delete restrict,

  bank_code             text not null,
  bank_name             text not null,
  account_number        text not null,
  -- The name Paystack's account resolution returned. Never typed by a person.
  account_name          text not null,
  -- The profile name it was compared with, as it was at that moment.
  profile_name_snapshot text not null,
  name_matched          boolean not null,

  status                text not null,
  is_default            boolean not null default false,

  recipient_code        text,
  recipient_created_at  timestamptz,

  -- D-08: an account added after the first cannot receive a payout for 48 h.
  usable_from           timestamptz not null,
  verified_at           timestamptz,
  reviewed_by           text,
  reviewed_at           timestamptz,
  review_note           text,
  disabled_at           timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint user_bank_accounts_status        check (status in ('verified', 'needs_review', 'rejected', 'disabled')),
  constraint user_bank_accounts_number        check (account_number ~ '^[0-9]{10}$'),
  constraint user_bank_accounts_bank_code     check (bank_code ~ '^[0-9A-Za-z_-]{2,20}$'),
  constraint user_bank_accounts_bank_name     check (char_length(btrim(bank_name)) between 2 and 80),
  constraint user_bank_accounts_account_name  check (char_length(btrim(account_name)) between 2 and 120),
  constraint user_bank_accounts_profile_name  check (char_length(btrim(profile_name_snapshot)) between 1 and 120),
  constraint user_bank_accounts_recipient     check (recipient_code is null or recipient_code ~ '^RCP_[0-9A-Za-z]{4,40}$'),
  constraint user_bank_accounts_verified_shape check ((status = 'verified') <= (verified_at is not null)),
  constraint user_bank_accounts_default_only_verified check (not is_default or status = 'verified'),
  constraint user_bank_accounts_disabled_shape check ((status = 'disabled') = (disabled_at is not null))
);

comment on table public.user_bank_accounts is
  'A profile''s saved payout destinations (owner decisions 2026-11-18, Q3). Account name comes from Paystack resolution only; status verified only when it matches the profile name or an operator approved it. Only the last four digits ever leave the database through client functions.';

create unique index user_bank_accounts_active_key
  on public.user_bank_accounts (user_id, bank_code, account_number)
  where status in ('verified', 'needs_review');
create unique index user_bank_accounts_one_default
  on public.user_bank_accounts (user_id) where is_default;
create index user_bank_accounts_user_idx on public.user_bank_accounts (user_id, created_at desc);

alter table public.user_bank_accounts enable row level security;
alter table public.user_bank_accounts force  row level security;
create policy user_bank_accounts_no_client_read on public.user_bank_accounts for select to authenticated using (false);
revoke all on public.user_bank_accounts from anon, authenticated;

create or replace function app.guard_user_bank_account()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'BANK_ACCOUNT_IS_PERMANENT: saved bank accounts are disabled, never deleted' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.bank_code is distinct from old.bank_code or new.bank_name is distinct from old.bank_name
     or new.account_number is distinct from old.account_number or new.account_name is distinct from old.account_name
     or new.profile_name_snapshot is distinct from old.profile_name_snapshot
     or new.name_matched is distinct from old.name_matched
     or new.usable_from is distinct from old.usable_from or new.created_at is distinct from old.created_at then
    raise exception 'BANK_ACCOUNT_FACTS_IMMUTABLE: a saved account''s bank, number and resolved name never change; add a new account instead'
      using errcode = 'P0001';
  end if;
  if old.recipient_code is not null and new.recipient_code is distinct from old.recipient_code then
    raise exception 'BANK_ACCOUNT_RECIPIENT_IMMUTABLE: the Paystack recipient is already recorded' using errcode = 'P0001';
  end if;
  if old.status <> new.status and not (
       (old.status = 'needs_review' and new.status in ('verified', 'rejected', 'disabled'))
    or (old.status = 'verified'     and new.status = 'disabled')) then
    raise exception 'BANK_ACCOUNT_INVALID_TRANSITION: % → %', old.status, new.status using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_user_bank_account() from public, anon, authenticated;

create trigger user_bank_accounts_guard
  before update or delete on public.user_bank_accounts
  for each row execute function app.guard_user_bank_account();


-- Operator: record an account the server resolved with Paystack and compared
-- with the profile name (packages/domain bank-name-match.ts). p_user_id comes
-- from the signed-in session on the server, never from the browser.
--
-- outcome: verified | needs_review | reused
create or replace function app.register_bank_account(
  p_user_id        uuid,
  p_bank_code      text,
  p_bank_name      text,
  p_account_number text,
  p_resolved_name  text,
  p_profile_name   text,
  p_name_matched   boolean
)
returns table (bank_account_id uuid, status text, outcome text, usable_from timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_max_active   constant integer := 5;
  c_max_per_day  constant integer := 10;
  v_user         public.users%rowtype;
  v_existing     public.user_bank_accounts%rowtype;
  v_has_prior    boolean;
  v_has_default  boolean;
  v_status       text;
  v_usable       timestamptz;
  v_id           uuid := app.uuid_generate_v7();
begin
  perform app.assert_payment_operator_session();

  select * into v_user from public.users u where u.id = p_user_id;
  if v_user.id is null or v_user.status <> 'active' then
    raise exception 'FORBIDDEN: no active user %', p_user_id using errcode = '42501';
  end if;
  if p_account_number is null or btrim(p_account_number) !~ '^[0-9]{10}$' then
    raise exception 'INVALID_ACCOUNT_NUMBER: a 10-digit account number is required' using errcode = '22023';
  end if;
  if p_bank_code is null or btrim(p_bank_code) !~ '^[0-9A-Za-z_-]{2,20}$' then
    raise exception 'INVALID_BANK: the bank is required' using errcode = '22023';
  end if;
  if p_bank_name is null or char_length(btrim(p_bank_name)) not between 2 and 80 then
    raise exception 'INVALID_BANK: the bank name is required' using errcode = '22023';
  end if;
  if p_resolved_name is null or char_length(btrim(p_resolved_name)) not between 2 and 120 then
    raise exception 'INVALID_ACCOUNT_NAME: the resolved account name is required' using errcode = '22023';
  end if;
  if p_name_matched is null then
    raise exception 'INVALID_NAME_MATCH: the name comparison result is required' using errcode = '22023';
  end if;
  -- The comparison must have used the name the profile has now.
  if p_profile_name is null or btrim(p_profile_name) <> btrim(v_user.full_name) then
    raise exception 'PROFILE_NAME_CHANGED: the profile name changed while the account was being checked; try again'
      using errcode = 'P0001';
  end if;

  -- One registration at a time per user.
  perform pg_advisory_xact_lock(hashtextextended('bank_account:' || p_user_id::text, 0));

  select * into v_existing from public.user_bank_accounts b
  where b.user_id = p_user_id and b.bank_code = btrim(p_bank_code) and b.account_number = btrim(p_account_number)
    and b.status in ('verified', 'needs_review');
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.status, 'reused'::text, v_existing.usable_from;
    return;
  end if;

  if (select count(*) from public.user_bank_accounts b
      where b.user_id = p_user_id and b.status in ('verified', 'needs_review')) >= c_max_active then
    raise exception 'TOO_MANY_BANK_ACCOUNTS: at most % saved accounts; remove one first', c_max_active using errcode = 'P0001';
  end if;
  if (select count(*) from public.user_bank_accounts b
      where b.user_id = p_user_id and b.created_at > now() - interval '24 hours') >= c_max_per_day then
    raise exception 'BANK_ACCOUNT_RATE_LIMITED: too many accounts added today; try again tomorrow' using errcode = 'P0001';
  end if;

  select exists (select 1 from public.user_bank_accounts b
                 where b.user_id = p_user_id and b.status in ('verified', 'disabled'))
    into v_has_prior;
  select exists (select 1 from public.user_bank_accounts b where b.user_id = p_user_id and b.is_default)
    into v_has_default;

  v_status := case when p_name_matched then 'verified' else 'needs_review' end;
  -- D-08: the first account is a setup, not a change; any later one waits 48 h.
  v_usable := case when v_has_prior then now() + interval '48 hours' else now() end;

  insert into public.user_bank_accounts (
    id, user_id, bank_code, bank_name, account_number, account_name, profile_name_snapshot, name_matched,
    status, is_default, usable_from, verified_at
  ) values (
    v_id, p_user_id, btrim(p_bank_code), btrim(p_bank_name), btrim(p_account_number), btrim(p_resolved_name),
    btrim(p_profile_name), p_name_matched,
    v_status, (v_status = 'verified' and not v_has_default), v_usable,
    case when v_status = 'verified' then now() end
  );

  perform app.write_audit_log(
    null, 'officer', p_user_id, 'bank_account.add', 'user_bank_account', v_id, null,
    jsonb_build_object('bank_code', btrim(p_bank_code), 'account_last4', right(btrim(p_account_number), 4),
                       'status', v_status, 'name_matched', p_name_matched, 'usable_from', v_usable));

  return query select v_id, v_status, v_status, v_usable;
end;
$$;
revoke execute on function app.register_bank_account(uuid, text, text, text, text, text, boolean) from public, anon, authenticated;

comment on function app.register_bank_account(uuid, text, text, text, text, text, boolean) is
  'Operator (server): save a bank account resolved through Paystack for the signed-in user. Name matched → verified; otherwise needs_review for an operator. Accounts after the first wait 48 h (D-08). Idempotent per (user, bank, number). Audited with the last four digits only.';


create or replace function app.set_bank_account_recipient(p_bank_account_id uuid, p_recipient_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b public.user_bank_accounts%rowtype;
begin
  perform app.assert_payment_operator_session();
  if p_recipient_code is null or btrim(p_recipient_code) !~ '^RCP_[0-9A-Za-z]{4,40}$' then
    raise exception 'INVALID_RECIPIENT: a Paystack recipient code is required' using errcode = '22023';
  end if;
  select * into v_b from public.user_bank_accounts where id = p_bank_account_id for update;
  if v_b.id is null then
    raise exception 'NOT_FOUND: bank account % does not exist', p_bank_account_id using errcode = 'P0002';
  end if;
  if v_b.recipient_code = btrim(p_recipient_code) then
    return;
  end if;
  if v_b.status <> 'verified' then
    raise exception 'BANK_ACCOUNT_NOT_VERIFIED: a recipient is created only for a verified account' using errcode = 'P0001';
  end if;
  update public.user_bank_accounts
  set recipient_code = btrim(p_recipient_code), recipient_created_at = now()
  where id = v_b.id;
end;
$$;
revoke execute on function app.set_bank_account_recipient(uuid, text) from public, anon, authenticated;


-- Operator: decide an account whose resolved name did not match the profile.
create or replace function app.review_bank_account(p_bank_account_id uuid, p_decision text, p_reviewer text, p_note text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b           public.user_bank_accounts%rowtype;
  v_has_default boolean;
begin
  perform app.assert_payment_operator_session();
  if p_decision not in ('approve', 'reject') then
    raise exception 'INVALID_DECISION: approve or reject' using errcode = '22023';
  end if;
  if p_reviewer is null or char_length(btrim(p_reviewer)) not between 2 and 120 then
    raise exception 'INVALID_REVIEWER: name the operator who reviewed it' using errcode = '22023';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 3 and 500 then
    raise exception 'INVALID_REASON: say why' using errcode = '22023';
  end if;
  select * into v_b from public.user_bank_accounts where id = p_bank_account_id for update;
  if v_b.id is null then
    raise exception 'NOT_FOUND: bank account % does not exist', p_bank_account_id using errcode = 'P0002';
  end if;
  if v_b.status <> 'needs_review' then
    raise exception 'BANK_ACCOUNT_NOT_IN_REVIEW: account is %', v_b.status using errcode = 'P0001';
  end if;
  select exists (select 1 from public.user_bank_accounts b where b.user_id = v_b.user_id and b.is_default)
    into v_has_default;

  update public.user_bank_accounts
  set status = case when p_decision = 'approve' then 'verified' else 'rejected' end,
      verified_at = case when p_decision = 'approve' then now() end,
      is_default = (p_decision = 'approve' and not v_has_default),
      reviewed_by = btrim(p_reviewer), reviewed_at = now(), review_note = btrim(p_note)
  where id = v_b.id;

  perform app.write_audit_log(
    null, 'system', null, 'bank_account.review', 'user_bank_account', v_b.id,
    jsonb_build_object('status', v_b.status),
    jsonb_build_object('decision', p_decision, 'reviewer', btrim(p_reviewer), 'account_last4', right(v_b.account_number, 4)),
    btrim(p_note));
  return case when p_decision = 'approve' then 'verified' else 'rejected' end;
end;
$$;
revoke execute on function app.review_bank_account(uuid, text, text, text) from public, anon, authenticated;


-- Signed-in user: their own saved accounts, masked.
create or replace function app.my_bank_accounts()
returns table (
  id uuid, bank_code text, bank_name text, account_last4 text, account_name text,
  status text, name_matched boolean, is_default boolean, usable_from timestamptz,
  verified_at timestamptz, review_note text, created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  -- The bank-reported name is shown only once the account is verified. A
  -- mismatched account (needs_review / rejected) keeps it hidden, so adding
  -- someone else's account number is not a way to learn whose it is.
  select b.id, b.bank_code, b.bank_name, right(b.account_number, 4),
         case when b.status = 'verified' then b.account_name end,
         b.status, b.name_matched, b.is_default, b.usable_from, b.verified_at,
         case when b.status = 'rejected' then b.review_note end, b.created_at
  from public.user_bank_accounts b
  where b.user_id = auth.uid() and b.status <> 'disabled'
  order by b.is_default desc, b.created_at desc;
$$;
revoke all on function app.my_bank_accounts() from public;
grant execute on function app.my_bank_accounts() to authenticated;


create or replace function app.set_default_bank_account(p_bank_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_b   public.user_bank_accounts%rowtype;
begin
  select * into v_b from public.user_bank_accounts where id = p_bank_account_id for update;
  if v_uid is null or v_b.id is null or v_b.user_id <> v_uid then
    raise exception 'NOT_FOUND: bank account % does not exist', p_bank_account_id using errcode = 'P0002';
  end if;
  if v_b.status <> 'verified' then
    raise exception 'BANK_ACCOUNT_NOT_VERIFIED: only a verified account can be the default' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bank_account:' || v_uid::text, 0));
  update public.user_bank_accounts set is_default = false where user_id = v_uid and is_default and id <> v_b.id;
  update public.user_bank_accounts set is_default = true where id = v_b.id and not is_default;
end;
$$;
revoke all on function app.set_default_bank_account(uuid) from public;
grant execute on function app.set_default_bank_account(uuid) to authenticated;


create or replace function app.disable_bank_account(p_bank_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_b   public.user_bank_accounts%rowtype;
  v_next uuid;
begin
  select * into v_b from public.user_bank_accounts where id = p_bank_account_id for update;
  if v_uid is null or v_b.id is null or v_b.user_id <> v_uid then
    raise exception 'NOT_FOUND: bank account % does not exist', p_bank_account_id using errcode = 'P0002';
  end if;
  if v_b.status = 'disabled' then
    return;
  end if;
  if v_b.status = 'rejected' then
    raise exception 'BANK_ACCOUNT_INVALID_TRANSITION: a rejected account stays on record' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.withdrawals w
             where w.bank_account_id = v_b.id and w.status in ('requested', 'approved', 'processing')) then
    raise exception 'BANK_ACCOUNT_IN_USE: a withdrawal to this account is still in progress' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bank_account:' || v_uid::text, 0));

  update public.user_bank_accounts set status = 'disabled', disabled_at = now(), is_default = false where id = v_b.id;

  if v_b.is_default then
    select b.id into v_next from public.user_bank_accounts b
    where b.user_id = v_uid and b.status = 'verified' order by b.created_at desc limit 1;
    if v_next is not null then
      update public.user_bank_accounts set is_default = true where id = v_next;
    end if;
  end if;

  perform app.write_audit_log(null, 'officer', v_uid, 'bank_account.disable', 'user_bank_account', v_b.id,
    jsonb_build_object('status', v_b.status), jsonb_build_object('account_last4', right(v_b.account_number, 4)));
end;
$$;
revoke all on function app.disable_bank_account(uuid) from public;
grant execute on function app.disable_bank_account(uuid) to authenticated;


-- ── 4. Withdrawals: saved destination and the reversed shape ────────────────

alter table public.withdrawals
  add column bank_account_id       uuid references public.user_bank_accounts (id) on delete restrict,
  add column destination_bank_code text,
  add column reversed_at           timestamptz,
  add column reversal_reason       text,
  add column reversal_journal_id   uuid references public.ledger_journals (id) on delete restrict;

-- A reversed withdrawal was paid first: it keeps its paid facts.
alter table public.withdrawals drop constraint withdrawals_paid_shape;
alter table public.withdrawals add constraint withdrawals_paid_shape
  check ((status in ('paid', 'reversed')) = (paid_at is not null and payout_journal_id is not null));
alter table public.withdrawals add constraint withdrawals_reversed_shape
  check ((status = 'reversed') = (reversed_at is not null and reversal_journal_id is not null));
alter table public.withdrawals add constraint withdrawals_saved_destination_shape
  check (bank_account_id is null or destination_bank_code is not null);

create index withdrawals_bank_account_idx on public.withdrawals (bank_account_id) where bank_account_id is not null;

create or replace function app.guard_withdrawal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'WITHDRAWAL_IS_PERMANENT: withdrawals are never deleted' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id or new.community_id is distinct from old.community_id
     or new.collection_id is distinct from old.collection_id or new.reference is distinct from old.reference
     or new.amount_kobo is distinct from old.amount_kobo or new.fee_kobo is distinct from old.fee_kobo
     or new.is_first is distinct from old.is_first
     or new.destination_account_name is distinct from old.destination_account_name
     or new.destination_account_number is distinct from old.destination_account_number
     or new.destination_bank_name is distinct from old.destination_bank_name
     or new.destination_bank_code is distinct from old.destination_bank_code
     or new.bank_account_id is distinct from old.bank_account_id
     or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at
     or new.hold_journal_id is distinct from old.hold_journal_id
     or (old.status = 'paid' and (new.paid_at is distinct from old.paid_at
                                  or new.payout_journal_id is distinct from old.payout_journal_id
                                  or new.payout_reference is distinct from old.payout_reference)) then
    raise exception 'WITHDRAWAL_FACTS_IMMUTABLE: amount, destination and requester never change' using errcode = 'P0001';
  end if;
  if old.status <> new.status and not (
       (old.status = 'requested'  and new.status in ('approved', 'rejected', 'cancelled'))
    or (old.status = 'approved'   and new.status in ('processing', 'cancelled', 'failed'))
    or (old.status = 'processing' and new.status in ('paid', 'failed'))
    or (old.status = 'paid'       and new.status = 'reversed')) then
    raise exception 'WITHDRAWAL_INVALID_TRANSITION: % → %', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status in ('failed', 'rejected', 'cancelled', 'reversed')
     or (old.status = 'paid' and new.status <> 'reversed') then
    raise exception 'WITHDRAWAL_FINAL: withdrawal % is %', old.reference, old.status using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_withdrawal() from public, anon, authenticated;


-- ── 5. Request a withdrawal to a saved account ──────────────────────────────
--
-- Same locking, balance, idempotency, daily limit (D-07), review flag (D-06)
-- and owner approval as app.request_withdrawal. Differences (2026-11-18):
--   · destination is one of the requester's own verified saved accounts,
--     past its D-08 cooling-off, instead of typed details (Q3 replaces the
--     identity_verified gate);
--   · no Kolekto withdrawal fee and no first-only rule (Q4). is_first is
--     still recorded.

create or replace function app.request_withdrawal_to_account(
  p_collection_id   uuid,
  p_amount_kobo     bigint,
  p_bank_account_id uuid,
  p_idempotency_key text
)
returns table (withdrawal_id uuid, reference text, status public.withdrawal_status, fee_kobo bigint, reused boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_daily_limit constant bigint := 100000000;  -- ₦1,000,000 (D-07)
  c_review_over constant bigint := 100000000;  -- ₦1,000,000 (D-06)
  v_uid        uuid := auth.uid();
  v_collection public.collections%rowtype;
  v_community  public.communities%rowtype;
  v_existing   public.withdrawals%rowtype;
  v_bank       public.user_bank_accounts%rowtype;
  v_avail_acct uuid;
  v_wd_acct    uuid;
  v_available  bigint;
  v_first      boolean;
  v_today      date := (now() at time zone 'Africa/Lagos')::date;
  v_today_sum  bigint;
  v_id         uuid := app.uuid_generate_v7();
  v_ref        text;
  v_owner      boolean;
  v_journal    uuid;
  v_status     public.withdrawal_status;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if v_uid is null or not app.has_permission_for_collection(p_collection_id, 'withdrawal.request') then
    raise exception 'FORBIDDEN: missing permission withdrawal.request for collection %', p_collection_id
      using errcode = '42501';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 120 then
    raise exception 'INVALID_IDEMPOTENCY_KEY: 8 to 120 characters' using errcode = '22023';
  end if;

  select * into v_existing from public.withdrawals w
  where w.collection_id = p_collection_id and w.requested_by = v_uid and w.idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.reference, v_existing.status, v_existing.fee_kobo::bigint, true;
    return;
  end if;

  if not exists (select 1 from public.users u where u.id = v_uid and u.status = 'active') then
    raise exception 'FORBIDDEN: the requester''s account is not active' using errcode = '42501';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'INVALID_AMOUNT: a withdrawal must be more than zero' using errcode = '22023';
  end if;

  select * into v_bank from public.user_bank_accounts b where b.id = p_bank_account_id for share;
  if v_bank.id is null or v_bank.user_id <> v_uid then
    raise exception 'BANK_ACCOUNT_NOT_FOUND: choose one of your saved bank accounts' using errcode = 'P0001';
  end if;
  if v_bank.status <> 'verified' then
    raise exception 'BANK_ACCOUNT_NOT_VERIFIED: this bank account is %', v_bank.status using errcode = 'P0001';
  end if;
  if v_bank.usable_from > now() then
    raise exception 'BANK_ACCOUNT_COOLING_OFF: a newly added bank account can receive withdrawals from % (D-08)',
      to_char(v_bank.usable_from at time zone 'Africa/Lagos', 'YYYY-MM-DD HH24:MI') || ' WAT'
      using errcode = 'P0001';
  end if;

  -- Serialise every withdrawal of this collection on its available account,
  -- and every withdrawal of the community for the daily limit.
  v_avail_acct := app.ensure_ledger_account(v_collection.community_id, p_collection_id, 'collection_available');
  v_wd_acct    := app.ensure_ledger_account(v_collection.community_id, p_collection_id, 'collection_withdrawing');
  perform 1 from public.ledger_accounts where id = v_avail_acct for update;
  perform pg_advisory_xact_lock(hashtextextended('withdrawal_daily:' || v_collection.community_id::text, 0));

  -- Read after the lock: a concurrent request that committed first is seen.
  v_available := app.ledger_account_balance(v_avail_acct);

  select not exists (
    select 1 from public.withdrawals w
    where w.collection_id = p_collection_id and w.status in ('requested', 'approved', 'processing', 'paid', 'reversed'))
  into v_first;

  if p_amount_kobo > v_available then
    raise exception 'INSUFFICIENT_AVAILABLE_BALANCE: % kobo available, % kobo requested', v_available, p_amount_kobo
      using errcode = 'P0001';
  end if;

  select * into v_community from public.communities where id = v_collection.community_id;
  if v_community.verification_status is distinct from 'verified' then
    select coalesce(sum(w.amount_kobo), 0) into v_today_sum
    from public.withdrawals w
    where w.community_id = v_collection.community_id
      and (w.requested_at at time zone 'Africa/Lagos')::date = v_today
      and w.status in ('requested', 'approved', 'processing', 'paid', 'reversed');
    if v_today_sum + p_amount_kobo > c_daily_limit then
      raise exception 'DAILY_WITHDRAWAL_LIMIT: unverified communities may withdraw up to ₦1,000,000 per day; % kobo already requested today',
        v_today_sum using errcode = 'P0001';
    end if;
  end if;

  v_ref    := 'KWD-' || upper(substr(md5(v_id::text || clock_timestamp()::text), 1, 16));
  v_owner  := app.is_community_owner(v_collection.community_id);
  v_status := case when v_owner then 'approved' else 'requested' end;

  v_journal := app.post_ledger_journal(
    v_collection.community_id, p_collection_id, now(), 'withdrawal', v_id,
    'Withdrawal ' || v_ref || ' requested: funds held', 'withdrawal_hold:' || v_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_avail_acct, 'direction', 'debit',  'amount_kobo', p_amount_kobo),
      jsonb_build_object('account_id', v_wd_acct,    'direction', 'credit', 'amount_kobo', p_amount_kobo)),
    'officer', v_uid);

  insert into public.withdrawals (
    id, community_id, collection_id, reference, amount_kobo, fee_kobo, withdrawal_fee_version, is_first,
    requires_manual_review, status, destination_account_name, destination_account_number, destination_bank_name,
    destination_bank_code, bank_account_id,
    requested_by, idempotency_key, approved_by, approved_at, hold_journal_id
  ) values (
    v_id, v_collection.community_id, p_collection_id, v_ref, p_amount_kobo, 0, null, v_first,
    p_amount_kobo > c_review_over, v_status, v_bank.account_name, v_bank.account_number, v_bank.bank_name,
    v_bank.bank_code, v_bank.id,
    v_uid, p_idempotency_key,
    case when v_owner then v_uid end, case when v_owner then now() end, v_journal
  );

  perform app.write_audit_log(
    v_collection.community_id, 'officer', v_uid, 'withdrawal.request', 'withdrawal', v_id, null,
    jsonb_build_object('reference', v_ref, 'collection_id', p_collection_id, 'amount_kobo', p_amount_kobo,
                       'fee_kobo', 0, 'status', v_status::text, 'bank_account_id', v_bank.id,
                       'account_last4', right(v_bank.account_number, 4)));

  return query select v_id, v_ref, v_status, 0::bigint, false;
end;
$$;
revoke all on function app.request_withdrawal_to_account(uuid, bigint, uuid, text) from public;
grant execute on function app.request_withdrawal_to_account(uuid, bigint, uuid, text) to authenticated;

comment on function app.request_withdrawal_to_account(uuid, bigint, uuid, text) is
  'D-03, D-06, D-07, D-08; owner decisions 2026-11-18: request a withdrawal from one collection to one of the requester''s own verified saved bank accounts. Locks the collection''s available account, sums ledger entries, refuses above available, posts the hold journal in the same transaction. No withdrawal fee. Idempotent per (collection, requester, key).';

-- Typed destinations bypass resolution and name matching; clients may no
-- longer use them (the function stays for the record and for tests run as
-- the operator).
revoke execute on function app.request_withdrawal(uuid, bigint, text, text, text, text) from authenticated;


-- ── 6. Transfers ────────────────────────────────────────────────────────────

create table public.withdrawal_transfers (
  id                   uuid primary key default app.uuid_generate_v7(),
  withdrawal_id        uuid not null references public.withdrawals (id) on delete restrict,
  -- Kolekto's own reference, sent to Paystack. Lowercase: Paystack accepts
  -- lowercase letters, digits, '-' and '_'.
  reference            text not null,
  amount_kobo          app.kobo not null,
  recipient_code       text,
  status               text not null default 'initiating',
  transfer_code        text,
  provider_transfer_id text,
  provider_fee_kobo    app.kobo,
  fee_journal_id       uuid references public.ledger_journals (id) on delete restrict,
  failure_reason       text,
  attempts             integer not null default 0,
  initiated_at         timestamptz,
  last_checked_at      timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint withdrawal_transfers_status    check (status in ('initiating', 'pending', 'otp', 'unknown', 'success', 'failed', 'reversed')),
  constraint withdrawal_transfers_reference check (reference ~ '^ktr_[0-9a-f]{24}$'),
  constraint withdrawal_transfers_amount    check (amount_kobo > 0),
  constraint withdrawal_transfers_code      check (transfer_code is null or transfer_code ~ '^TRF_[0-9A-Za-z]{4,40}$'),
  constraint withdrawal_transfers_final_shape check ((status in ('success', 'failed', 'reversed')) = (completed_at is not null))
);

comment on table public.withdrawal_transfers is
  'One Paystack transfer per withdrawal (owner decision 2026-11-17 §18, built 2026-11-18). The withdrawal row is the workflow, the ledger is the money, this row is the provider evidence. A timeout is `unknown` and is resolved by verifying the reference, never by sending again under a new reference (D-27).';

create unique index withdrawal_transfers_withdrawal_key on public.withdrawal_transfers (withdrawal_id);
create unique index withdrawal_transfers_reference_key  on public.withdrawal_transfers (reference);
create unique index withdrawal_transfers_code_key       on public.withdrawal_transfers (transfer_code) where transfer_code is not null;
create index withdrawal_transfers_open_idx on public.withdrawal_transfers (status, updated_at)
  where status in ('initiating', 'pending', 'otp', 'unknown');

alter table public.withdrawal_transfers enable row level security;
alter table public.withdrawal_transfers force  row level security;
create policy withdrawal_transfers_no_client_read on public.withdrawal_transfers for select to authenticated using (false);
revoke all on public.withdrawal_transfers from anon, authenticated;

create or replace function app.guard_withdrawal_transfer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'TRANSFER_IS_PERMANENT: transfer records are never deleted' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id or new.withdrawal_id is distinct from old.withdrawal_id
     or new.reference is distinct from old.reference or new.amount_kobo is distinct from old.amount_kobo
     or new.created_at is distinct from old.created_at
     or (old.transfer_code is not null and new.transfer_code is distinct from old.transfer_code)
     or (old.fee_journal_id is not null and new.fee_journal_id is distinct from old.fee_journal_id) then
    raise exception 'TRANSFER_FACTS_IMMUTABLE: reference, amount and transfer code never change' using errcode = 'P0001';
  end if;
  if old.status <> new.status and not (
       (old.status in ('initiating', 'pending', 'otp', 'unknown')
          and new.status in ('initiating', 'pending', 'otp', 'unknown', 'success', 'failed', 'reversed'))
    or (old.status = 'success' and new.status = 'reversed')) then
    raise exception 'TRANSFER_INVALID_TRANSITION: % → %', old.status, new.status using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_withdrawal_transfer() from public, anon, authenticated;

create trigger withdrawal_transfers_guard
  before update or delete on public.withdrawal_transfers
  for each row execute function app.guard_withdrawal_transfer();


-- Worker: take approved withdrawals to saved, verified accounts and open a
-- transfer for each. The withdrawal moves to processing and its transfer row
-- is born `initiating` in the same transaction, so a crash before the API
-- call leaves a row the check stage resolves by reference. Manual-review
-- withdrawals (D-06, > ₦1,000,000) are left for operations.
create or replace function app.claim_withdrawal_transfers(p_limit integer default 10)
returns table (
  withdrawal_id uuid, withdrawal_reference text, transfer_reference text, amount_kobo bigint,
  bank_account_id uuid, recipient_code text, bank_code text, account_number text, account_name text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row record;
  v_ref text;
begin
  perform app.assert_payment_operator_session();
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_LIMIT: between 1 and 100' using errcode = '22023';
  end if;

  for v_row in
    select w.id, w.reference, w.amount_kobo, w.community_id, b.id as bank_id, b.recipient_code, b.bank_code,
           b.account_number, b.account_name
    from public.withdrawals w
    join public.user_bank_accounts b on b.id = w.bank_account_id
    where w.status = 'approved'
      and not w.requires_manual_review
      and b.status = 'verified'
      and b.usable_from <= now()
      and not exists (select 1 from public.withdrawal_transfers t where t.withdrawal_id = w.id)
    order by w.approved_at, w.id
    limit p_limit
    for update of w skip locked
  loop
    v_ref := 'ktr_' || substr(replace(app.uuid_generate_v7()::text, '-', ''), 9, 24);
    insert into public.withdrawal_transfers (withdrawal_id, reference, amount_kobo, recipient_code)
    values (v_row.id, v_ref, v_row.amount_kobo, v_row.recipient_code);
    update public.withdrawals set status = 'processing', processing_at = now() where id = v_row.id;
    perform app.write_audit_log(v_row.community_id, 'system', null, 'withdrawal.processing', 'withdrawal', v_row.id,
      null, jsonb_build_object('reference', v_row.reference, 'transfer_reference', v_ref), null);

    withdrawal_id := v_row.id; withdrawal_reference := v_row.reference; transfer_reference := v_ref;
    amount_kobo := v_row.amount_kobo; bank_account_id := v_row.bank_id; recipient_code := v_row.recipient_code;
    bank_code := v_row.bank_code; account_number := v_row.account_number; account_name := v_row.account_name;
    return next;
  end loop;
end;
$$;
revoke execute on function app.claim_withdrawal_transfers(integer) from public, anon, authenticated;


-- Worker: record a non-final provider state (or the recipient / transfer code
-- learned on the way). Final outcomes go through settle_withdrawal_transfer.
create or replace function app.record_withdrawal_transfer_state(
  p_reference            text,
  p_status               text,
  p_recipient_code       text,
  p_transfer_code        text,
  p_provider_transfer_id text,
  p_note                 text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.withdrawal_transfers%rowtype;
begin
  perform app.assert_payment_operator_session();
  if p_status not in ('initiating', 'pending', 'otp', 'unknown') then
    raise exception 'INVALID_STATUS: only a non-final state is recorded here' using errcode = '22023';
  end if;
  select * into v_t from public.withdrawal_transfers where reference = p_reference for update;
  if v_t.id is null then
    raise exception 'UNKNOWN_TRANSFER_REFERENCE: %', p_reference using errcode = 'P0002';
  end if;
  if v_t.status in ('success', 'failed', 'reversed') then
    return v_t.status;    -- a final state already arrived (webhook first); keep it
  end if;
  update public.withdrawal_transfers
  set status = p_status,
      recipient_code = coalesce(v_t.recipient_code, nullif(btrim(p_recipient_code), '')),
      transfer_code = coalesce(v_t.transfer_code, nullif(btrim(p_transfer_code), '')),
      provider_transfer_id = coalesce(v_t.provider_transfer_id, nullif(btrim(p_provider_transfer_id), '')),
      failure_reason = left(nullif(btrim(p_note), ''), 500),
      attempts = v_t.attempts + case when p_status = 'initiating' then 0 else 1 end,
      initiated_at = coalesce(v_t.initiated_at, case when p_status <> 'initiating' then now() end),
      last_checked_at = now()
  where id = v_t.id;
  return p_status;
end;
$$;
revoke execute on function app.record_withdrawal_transfer_state(text, text, text, text, text, text) from public, anon, authenticated;


-- Worker / webhook: a FINAL provider outcome, as confirmed by Paystack's
-- verify endpoint (never the webhook body alone). Idempotent.
--
-- outcome:
--   paid / already_paid
--   failed / already_failed
--   reversed / already_reversed
--   amount_mismatch   provider amount differs: nothing changes, audited
--   conflict          contradicts a recorded final state: nothing changes, audited
create or replace function app.settle_withdrawal_transfer(
  p_reference     text,
  p_outcome       text,
  p_amount_kobo   bigint,
  p_transfer_code text,
  p_fee_kobo      bigint,
  p_reason        text,
  p_at            timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t        public.withdrawal_transfers%rowtype;
  v_w        public.withdrawals%rowtype;
  v_at       timestamptz := least(coalesce(p_at, now()), now());
  v_wd       uuid;
  v_done     uuid;
  v_avail    uuid;
  v_income   uuid;
  v_payouts  uuid;
  v_paystack uuid;
  v_feeexp   uuid;
  v_journal  uuid;
  v_rel      uuid;
  v_fee_j    uuid;
begin
  perform app.assert_payment_operator_session();
  if p_outcome not in ('success', 'failed', 'reversed') then
    raise exception 'INVALID_OUTCOME: success, failed or reversed' using errcode = '22023';
  end if;
  if p_fee_kobo is not null and p_fee_kobo < 0 then
    raise exception 'INVALID_FEE: a transfer fee is zero or more kobo' using errcode = '22023';
  end if;

  select * into v_t from public.withdrawal_transfers where reference = p_reference for update;
  if v_t.id is null then
    raise exception 'UNKNOWN_TRANSFER_REFERENCE: %', p_reference using errcode = 'P0002';
  end if;
  select * into v_w from public.withdrawals where id = v_t.withdrawal_id for update;

  if p_amount_kobo is not null and p_amount_kobo <> v_t.amount_kobo then
    perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.transfer_amount_mismatch', 'withdrawal', v_w.id,
      null, jsonb_build_object('reference', v_w.reference, 'transfer_reference', p_reference,
                               'expected_kobo', v_t.amount_kobo, 'provider_kobo', p_amount_kobo, 'outcome', p_outcome),
      'Paystack reported a different transfer amount; nothing changed');
    return 'amount_mismatch';
  end if;

  if p_transfer_code is not null and v_t.transfer_code is not null and v_t.transfer_code <> btrim(p_transfer_code) then
    perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.transfer_conflict', 'withdrawal', v_w.id,
      null, jsonb_build_object('transfer_reference', p_reference, 'recorded_code', v_t.transfer_code,
                               'new_code', btrim(p_transfer_code)), 'Different transfer code for one reference');
    return 'conflict';
  end if;

  -- ── success ──
  if p_outcome = 'success' then
    if v_t.status = 'success' then
      return 'already_paid';
    end if;
    if v_t.status in ('failed', 'reversed') or v_w.status <> 'processing' then
      perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.transfer_conflict', 'withdrawal', v_w.id,
        null, jsonb_build_object('transfer_reference', p_reference, 'recorded', v_t.status, 'withdrawal', v_w.status::text,
                                 'new', p_outcome), 'Success arrived for a transfer already decided');
      return 'conflict';
    end if;

    v_wd       := app.ensure_ledger_account(v_w.community_id, v_w.collection_id, 'collection_withdrawing');
    v_done     := app.ensure_ledger_account(v_w.community_id, v_w.collection_id, 'collection_withdrawn');
    v_income   := app.ensure_ledger_account(null, null, 'platform_fee_income');
    v_payouts  := app.ensure_ledger_account(null, null, 'organiser_payouts');
    v_paystack := app.ensure_ledger_account(null, null, 'provider_receivable');

    v_journal := app.post_ledger_journal(
      v_w.community_id, v_w.collection_id, v_at, 'payout', v_w.id,
      'Withdrawal ' || v_w.reference || ' paid by Paystack transfer ' || coalesce(btrim(p_transfer_code), v_t.transfer_code, p_reference),
      'payout:' || v_w.id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_wd,       'direction', 'debit',  'amount_kobo', v_w.amount_kobo + v_w.fee_kobo),
        jsonb_build_object('account_id', v_done,     'direction', 'credit', 'amount_kobo', v_w.amount_kobo),
        jsonb_build_object('account_id', v_income,   'direction', 'credit', 'amount_kobo', v_w.fee_kobo),
        jsonb_build_object('account_id', v_payouts,  'direction', 'debit',  'amount_kobo', v_w.amount_kobo),
        jsonb_build_object('account_id', v_paystack, 'direction', 'credit', 'amount_kobo', v_w.amount_kobo)),
      'system', null);

    if coalesce(p_fee_kobo, 0) > 0 then
      v_feeexp := app.ensure_ledger_account(null, null, 'transfer_fee_expense');
      v_fee_j := app.post_ledger_journal(
        v_w.community_id, v_w.collection_id, v_at, 'payout', v_w.id,
        'Paystack transfer fee for withdrawal ' || v_w.reference || ' (borne by Kolekto)',
        'transfer_fee:' || v_w.id,
        jsonb_build_array(
          jsonb_build_object('account_id', v_feeexp,   'direction', 'debit',  'amount_kobo', p_fee_kobo),
          jsonb_build_object('account_id', v_paystack, 'direction', 'credit', 'amount_kobo', p_fee_kobo)),
        'system', null);
    end if;

    update public.withdrawals
    set status = 'paid', paid_at = v_at,
        payout_reference = coalesce(btrim(p_transfer_code), v_t.transfer_code, p_reference),
        payout_journal_id = v_journal
    where id = v_w.id;
    update public.withdrawal_transfers
    set status = 'success', completed_at = v_at, last_checked_at = now(),
        transfer_code = coalesce(v_t.transfer_code, btrim(p_transfer_code)),
        provider_fee_kobo = coalesce(p_fee_kobo, v_t.provider_fee_kobo),
        fee_journal_id = coalesce(v_t.fee_journal_id, v_fee_j),
        failure_reason = null
    where id = v_t.id;

    perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.paid', 'withdrawal', v_w.id,
      null, jsonb_build_object('reference', v_w.reference, 'amount_kobo', v_w.amount_kobo,
                               'transfer_reference', p_reference, 'transfer_fee_kobo', coalesce(p_fee_kobo, 0)), null);
    return 'paid';
  end if;

  -- ── failed ──
  if p_outcome = 'failed' then
    if v_t.status = 'failed' then
      return 'already_failed';
    end if;
    if v_t.status in ('success', 'reversed') then
      perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.transfer_conflict', 'withdrawal', v_w.id,
        null, jsonb_build_object('transfer_reference', p_reference, 'recorded', v_t.status, 'new', p_outcome),
        'Failure arrived for a transfer already decided');
      return 'conflict';
    end if;
    -- Fall through to the shared "never paid" ending below.
  end if;

  -- ── reversed ──
  if p_outcome = 'reversed' then
    if v_t.status = 'reversed' then
      return 'already_reversed';
    end if;
    if v_t.status = 'failed' then
      return 'already_failed';
    end if;
    if v_t.status = 'success' then
      v_done     := app.ensure_ledger_account(v_w.community_id, v_w.collection_id, 'collection_withdrawn');
      v_avail    := app.ensure_ledger_account(v_w.community_id, v_w.collection_id, 'collection_available');
      v_payouts  := app.ensure_ledger_account(null, null, 'organiser_payouts');
      v_paystack := app.ensure_ledger_account(null, null, 'provider_receivable');
      v_journal := app.post_ledger_journal(
        v_w.community_id, v_w.collection_id, v_at, 'reversal', v_w.id,
        'Withdrawal ' || v_w.reference || ' reversed by the bank: funds returned to available',
        'payout_reversal:' || v_w.id,
        jsonb_build_array(
          jsonb_build_object('account_id', v_done,     'direction', 'debit',  'amount_kobo', v_w.amount_kobo),
          jsonb_build_object('account_id', v_avail,    'direction', 'credit', 'amount_kobo', v_w.amount_kobo),
          jsonb_build_object('account_id', v_paystack, 'direction', 'debit',  'amount_kobo', v_w.amount_kobo),
          jsonb_build_object('account_id', v_payouts,  'direction', 'credit', 'amount_kobo', v_w.amount_kobo)),
        'system', null, v_w.payout_journal_id);

      update public.withdrawals
      set status = 'reversed', reversed_at = v_at,
          reversal_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Transfer reversed'), 500),
          reversal_journal_id = v_journal
      where id = v_w.id;
      update public.withdrawal_transfers
      set status = 'reversed', completed_at = v_at, last_checked_at = now(),
          failure_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Transfer reversed'), 500)
      where id = v_t.id;
      perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.reversed', 'withdrawal', v_w.id,
        jsonb_build_object('status', 'paid'), jsonb_build_object('reference', v_w.reference, 'transfer_reference', p_reference),
        left(coalesce(nullif(btrim(p_reason), ''), 'Transfer reversed'), 500));
      return 'reversed';
    end if;
    -- Reversed before it ever succeeded: it was never paid. Same as failed.
  end if;

  -- ── never paid (failed, or reversed before success): release the hold ──
  if v_w.status not in ('approved', 'processing') then
    perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.transfer_conflict', 'withdrawal', v_w.id,
      null, jsonb_build_object('transfer_reference', p_reference, 'withdrawal', v_w.status::text, 'new', p_outcome),
      'Failure arrived for a withdrawal that is not in progress');
    return 'conflict';
  end if;
  v_rel := app.release_withdrawal_hold(v_w, 'system', null, 'failed');
  update public.withdrawals
  set status = 'failed', failed_at = now(),
      failure_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Transfer failed'), 500),
      release_journal_id = v_rel
  where id = v_w.id;
  update public.withdrawal_transfers
  set status = case when p_outcome = 'reversed' then 'reversed' else 'failed' end,
      completed_at = v_at, last_checked_at = now(),
      transfer_code = coalesce(v_t.transfer_code, nullif(btrim(p_transfer_code), '')),
      failure_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Transfer failed'), 500)
  where id = v_t.id;
  perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.failed', 'withdrawal', v_w.id,
    jsonb_build_object('status', v_w.status::text),
    jsonb_build_object('reference', v_w.reference, 'transfer_reference', p_reference),
    left(coalesce(nullif(btrim(p_reason), ''), 'Transfer failed'), 500));
  return 'failed';
end;
$$;
revoke execute on function app.settle_withdrawal_transfer(text, text, bigint, text, bigint, text, timestamptz)
  from public, anon, authenticated;

comment on function app.settle_withdrawal_transfer(text, text, bigint, text, bigint, text, timestamptz) is
  'Operator/worker: apply Paystack''s FINAL transfer outcome (from the verify endpoint). success → payout journal paid from the Paystack balance (provider_receivable) + transfer fee journal (transfer_fee_expense, Kolekto); failed → hold released; reversed after success → reversal journal back to available, withdrawal reversed. Idempotent; contradictions and amount mismatches change nothing and are audited.';


-- Worker: open transfers to check against Paystack (stale first).
create or replace function app.withdrawal_transfers_to_check(p_older_than interval, p_limit integer default 20)
returns table (transfer_reference text, status text, transfer_code text, amount_kobo bigint,
               recipient_code text, bank_account_id uuid, attempts integer, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_payment_operator_session();
  return query
  select t.reference, t.status, t.transfer_code, t.amount_kobo::bigint, t.recipient_code, w.bank_account_id,
         t.attempts, t.created_at
  from public.withdrawal_transfers t
  join public.withdrawals w on w.id = t.withdrawal_id
  where t.status in ('initiating', 'pending', 'otp', 'unknown')
    and coalesce(t.last_checked_at, t.created_at) <= now() - p_older_than
  order by coalesce(t.last_checked_at, t.created_at)
  limit greatest(1, least(coalesce(p_limit, 20), 100));
end;
$$;
revoke execute on function app.withdrawal_transfers_to_check(interval, integer) from public, anon, authenticated;


-- ── 7. Manual payout path refuses transfer-paid withdrawals ─────────────────
-- Bodies as 20261117100200 plus the guard at the top.

create or replace function app.assert_withdrawal_not_transferred(p_withdrawal_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.withdrawal_transfers t where t.withdrawal_id = p_withdrawal_id) then
    raise exception 'WITHDRAWAL_PAID_BY_TRANSFER: this withdrawal is being paid by a Paystack transfer; its outcome is recorded from Paystack'
      using errcode = 'P0001';
  end if;
end;
$$;
revoke execute on function app.assert_withdrawal_not_transferred(uuid) from public, anon, authenticated;

create or replace function app.mark_withdrawal_processing(p_withdrawal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w public.withdrawals%rowtype;
begin
  perform app.assert_payment_operator_session();
  select * into v_w from public.withdrawals where id = p_withdrawal_id for update;
  if v_w.id is null then
    raise exception 'NOT_FOUND: withdrawal % does not exist', p_withdrawal_id using errcode = 'P0002';
  end if;
  perform app.assert_withdrawal_not_transferred(v_w.id);
  if v_w.status = 'processing' then
    return;
  end if;
  if v_w.status <> 'approved' then
    raise exception 'WITHDRAWAL_NOT_APPROVED: withdrawal % is %', v_w.reference, v_w.status using errcode = 'P0001';
  end if;
  update public.withdrawals set status = 'processing', processing_at = now() where id = v_w.id;
  perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.processing', 'withdrawal', v_w.id,
    null, jsonb_build_object('reference', v_w.reference), null);
end;
$$;
revoke execute on function app.mark_withdrawal_processing(uuid) from public, anon, authenticated;

create or replace function app.complete_withdrawal(p_withdrawal_id uuid, p_payout_reference text, p_paid_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w        public.withdrawals%rowtype;
  v_wd       uuid;
  v_done     uuid;
  v_income   uuid;
  v_payouts  uuid;
  v_cash     uuid;
  v_journal  uuid;
begin
  perform app.assert_payment_operator_session();
  if p_payout_reference is null or char_length(btrim(p_payout_reference)) not between 3 and 200 then
    raise exception 'INVALID_PAYOUT_REFERENCE: the bank or provider transfer reference is required' using errcode = '22023';
  end if;
  if p_paid_at is null or p_paid_at > now() + interval '5 minutes' then
    raise exception 'INVALID_PAID_AT: a payout cannot be in the future' using errcode = '22023';
  end if;

  select * into v_w from public.withdrawals where id = p_withdrawal_id for update;
  if v_w.id is null then
    raise exception 'NOT_FOUND: withdrawal % does not exist', p_withdrawal_id using errcode = 'P0002';
  end if;
  perform app.assert_withdrawal_not_transferred(v_w.id);
  if v_w.status = 'paid' then
    if v_w.payout_reference = btrim(p_payout_reference) then
      return v_w.payout_journal_id;   -- same confirmation again
    end if;
    raise exception 'WITHDRAWAL_ALREADY_PAID: % was paid with reference %', v_w.reference, v_w.payout_reference
      using errcode = 'P0001';
  end if;
  if v_w.status <> 'processing' then
    raise exception 'WITHDRAWAL_NOT_PROCESSING: withdrawal % is %', v_w.reference, v_w.status using errcode = 'P0001';
  end if;

  v_wd      := app.ensure_ledger_account(v_w.community_id, v_w.collection_id, 'collection_withdrawing');
  v_done    := app.ensure_ledger_account(v_w.community_id, v_w.collection_id, 'collection_withdrawn');
  v_income  := app.ensure_ledger_account(null, null, 'platform_fee_income');
  v_payouts := app.ensure_ledger_account(null, null, 'organiser_payouts');
  v_cash    := app.ensure_ledger_account(null, null, 'provider_settled_funds');

  v_journal := app.post_ledger_journal(
    v_w.community_id, v_w.collection_id, p_paid_at, 'payout', v_w.id,
    'Withdrawal ' || v_w.reference || ' paid out (transfer ' || btrim(p_payout_reference) || ')',
    'payout:' || v_w.id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_wd,      'direction', 'debit',  'amount_kobo', v_w.amount_kobo + v_w.fee_kobo),
      jsonb_build_object('account_id', v_done,    'direction', 'credit', 'amount_kobo', v_w.amount_kobo),
      jsonb_build_object('account_id', v_income,  'direction', 'credit', 'amount_kobo', v_w.fee_kobo),
      jsonb_build_object('account_id', v_payouts, 'direction', 'debit',  'amount_kobo', v_w.amount_kobo),
      jsonb_build_object('account_id', v_cash,    'direction', 'credit', 'amount_kobo', v_w.amount_kobo)),
    'system', null);

  update public.withdrawals
  set status = 'paid', paid_at = p_paid_at, payout_reference = btrim(p_payout_reference), payout_journal_id = v_journal
  where id = v_w.id;

  perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.paid', 'withdrawal', v_w.id,
    null, jsonb_build_object('reference', v_w.reference, 'amount_kobo', v_w.amount_kobo, 'fee_kobo', v_w.fee_kobo), null);
  return v_journal;
end;
$$;
revoke execute on function app.complete_withdrawal(uuid, text, timestamptz) from public, anon, authenticated;

create or replace function app.fail_withdrawal(p_withdrawal_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w   public.withdrawals%rowtype;
  v_rel uuid;
begin
  perform app.assert_payment_operator_session();
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'INVALID_REASON: say why the payout failed' using errcode = '22023';
  end if;
  select * into v_w from public.withdrawals where id = p_withdrawal_id for update;
  if v_w.id is null then
    raise exception 'NOT_FOUND: withdrawal % does not exist', p_withdrawal_id using errcode = 'P0002';
  end if;
  perform app.assert_withdrawal_not_transferred(v_w.id);
  if v_w.status = 'failed' then
    return;
  end if;
  if v_w.status not in ('approved', 'processing') then
    raise exception 'WITHDRAWAL_NOT_FAILABLE: withdrawal % is %', v_w.reference, v_w.status using errcode = 'P0001';
  end if;

  v_rel := app.release_withdrawal_hold(v_w, 'system', null, 'failed');
  update public.withdrawals
  set status = 'failed', failed_at = now(), failure_reason = btrim(p_reason), release_journal_id = v_rel
  where id = v_w.id;

  perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.failed', 'withdrawal', v_w.id,
    jsonb_build_object('status', v_w.status::text), jsonb_build_object('reference', v_w.reference), btrim(p_reason));
end;
$$;
revoke execute on function app.fail_withdrawal(uuid, text) from public, anon, authenticated;


-- ── 8. Reads ────────────────────────────────────────────────────────────────

-- Same as 20261117100200 plus the transfer and reversal facts. Return type
-- grows, so drop and re-create (no view or function depends on it).
drop function app.collection_withdrawals(uuid);
create function app.collection_withdrawals(p_collection_id uuid)
returns table (
  id uuid, reference text, amount_kobo bigint, fee_kobo bigint, status public.withdrawal_status,
  is_first boolean, requires_manual_review boolean,
  account_name text, account_last4 text, bank_name text,
  requested_by_name text, requested_at timestamptz, approved_at timestamptz,
  decided_at timestamptz, decision_reason text, paid_at timestamptz, payout_reference text,
  failed_at timestamptz, failure_reason text,
  can_decide boolean, can_cancel boolean,
  payout_method text, transfer_reference text, transfer_status text,
  reversed_at timestamptz, reversal_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_collection public.collections%rowtype;
  v_owner      boolean;
  v_requester  boolean;
begin
  select * into v_collection from public.collections where public.collections.id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if not app.has_permission_for_collection(p_collection_id, 'balance.view') then
    raise exception 'FORBIDDEN: missing permission balance.view for collection %', p_collection_id using errcode = '42501';
  end if;
  v_owner     := app.is_community_owner(v_collection.community_id);
  v_requester := app.has_permission_for_collection(p_collection_id, 'withdrawal.request');

  return query
  select w.id, w.reference, w.amount_kobo::bigint, w.fee_kobo::bigint, w.status, w.is_first, w.requires_manual_review,
         w.destination_account_name, right(w.destination_account_number, 4), w.destination_bank_name,
         u.full_name, w.requested_at, w.approved_at, w.decided_at, w.decision_reason, w.paid_at, w.payout_reference,
         w.failed_at, w.failure_reason,
         (v_owner and w.status = 'requested'),
         (w.status in ('requested', 'approved') and (v_requester or w.requested_by = auth.uid())),
         case when t.id is not null then 'paystack_transfer' else 'manual' end,
         t.reference, t.status, w.reversed_at, w.reversal_reason
  from public.withdrawals w
  left join public.users u on u.id = w.requested_by
  left join public.withdrawal_transfers t on t.withdrawal_id = w.id
  where w.collection_id = p_collection_id
  order by w.requested_at desc;
end;
$$;
revoke all on function app.collection_withdrawals(uuid) from public;
grant execute on function app.collection_withdrawals(uuid) to authenticated;


-- ── 9. Reconciliation ───────────────────────────────────────────────────────
-- Collection: a reversed withdrawal's amount is back in available, so it is
-- neither withdrawing nor withdrawn; any fee it carried stays earned.

create or replace function app.collection_reconciliation_checks(p_collection_id uuid)
returns table (check_name text, expected_kobo bigint, ledger_kobo bigint, difference_kobo bigint, ok boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with pos as (
    select * from public.v_collection_position p where p.collection_id = p_collection_id
  ),
  st as (
    select
      coalesce(sum(s.net_kobo) filter (where s.status in ('pending', 'discrepancy')), 0)::bigint as unreleased,
      coalesce(sum(s.net_kobo) filter (where s.status = 'released'), 0)::bigint as released
    from public.contribution_settlements s where s.collection_id = p_collection_id
  ),
  wd as (
    select
      coalesce(sum(w.amount_kobo + w.fee_kobo) filter (where w.status in ('requested', 'approved', 'processing')), 0)::bigint as open_kobo,
      coalesce(sum(w.amount_kobo) filter (where w.status = 'paid'), 0)::bigint as paid_kobo,
      coalesce(sum(w.fee_kobo) filter (where w.status in ('paid', 'reversed')), 0)::bigint as paid_fees
    from public.withdrawals w where w.collection_id = p_collection_id
  ),
  cn as (
    select coalesce(sum(c.net_kobo), 0)::bigint as net,
           count(*) as n,
           count(*) filter (where not exists (select 1 from public.contribution_settlements s where s.contribution_id = c.id)) as missing
    from public.contributions c where c.collection_id = p_collection_id and c.status = 'applied'
  ),
  imb as (
    select count(*)::bigint as n from public.v_ledger_imbalances i where i.collection_id = p_collection_id
  ),
  rows as (
    select 'pending'::text as check_name, st.unreleased as expected, pos.pending_kobo::bigint as ledger from st, pos
    union all
    select 'released_position', st.released - wd.paid_fees,
           (pos.available_kobo + pos.on_hold_kobo + pos.withdrawing_kobo + pos.withdrawn_kobo
            + pos.chargeback_kobo + pos.refund_reserve_kobo)::bigint
    from st, wd, pos
    union all
    select 'withdrawing', wd.open_kobo, pos.withdrawing_kobo::bigint from wd, pos
    union all
    select 'withdrawn', wd.paid_kobo, pos.withdrawn_kobo::bigint from wd, pos
    union all
    select 'net_raised', cn.net,
           (pos.pending_kobo + pos.available_kobo + pos.on_hold_kobo + pos.withdrawing_kobo + pos.withdrawn_kobo
            + pos.chargeback_kobo + pos.refund_reserve_kobo)::bigint + wd.paid_fees
    from cn, wd, pos
    union all
    select 'settlement_rows', cn.n, cn.n - cn.missing from cn
    union all
    select 'unbalanced_journals', 0::bigint, imb.n from imb
  )
  select r.check_name, r.expected, r.ledger, r.ledger - r.expected, r.ledger = r.expected from rows r;
$$;
revoke execute on function app.collection_reconciliation_checks(uuid) from public, anon, authenticated;

-- Platform: transfers are paid from the Paystack balance (provider_receivable),
-- and under the 2026-11-18 rule a payment can be available before any
-- provider settlement is recorded. The coverage check therefore counts money
-- held at Paystack AND money settled to Kolekto against every organiser
-- liability still held (pending + available + withdrawing).
create or replace function app.platform_reconciliation()
returns table (check_name text, expected_kobo bigint, ledger_kobo bigint, difference_kobo bigint, ok boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_payment_operator_session();

  return query
  with bal as (
    select v.code, coalesce(sum(v.balance_kobo), 0)::bigint as kobo
    from public.v_ledger_account_balances v group by v.code
  ),
  b as (
    select
      coalesce((select kobo from bal where code = 'provider_receivable'), 0)     as receivable,
      coalesce((select kobo from bal where code = 'provider_settled_funds'), 0)  as settled_funds,
      coalesce((select kobo from bal where code = 'organiser_payouts'), 0)       as payouts,
      coalesce((select kobo from bal where code = 'transfer_fee_expense'), 0)    as transfer_fees,
      coalesce((select kobo from bal where code = 'collection_pending'), 0)      as pending,
      coalesce((select kobo from bal where code = 'collection_available'), 0)    as available,
      coalesce((select kobo from bal where code = 'collection_withdrawing'), 0)  as withdrawing,
      coalesce((select kobo from bal where code = 'collection_withdrawn'), 0)    as withdrawn
  ),
  st as (
    select
      coalesce(sum(s.expected_provider_kobo) filter (where s.provider_confirmed_at is null), 0)::bigint as unconfirmed_expected,
      coalesce(sum(s.net_kobo) filter (where s.status in ('pending', 'discrepancy')), 0)::bigint as unreleased
    from public.contribution_settlements s
  ),
  tr as (
    select
      coalesce(sum(t.amount_kobo) filter (where t.status = 'success'), 0)::bigint as paid_out,
      coalesce(sum(t.provider_fee_kobo) filter (where t.fee_journal_id is not null), 0)::bigint as fees
    from public.withdrawal_transfers t
  ),
  wd as (
    select coalesce(sum(w.amount_kobo) filter (where w.status = 'paid'), 0)::bigint as paid_kobo
    from public.withdrawals w
  ),
  rows as (
    select 'provider_receivable_vs_unconfirmed'::text as check_name,
           st.unconfirmed_expected - tr.paid_out - tr.fees as expected, b.receivable as ledger from st, tr, b
    union all
    select 'collection_pending_vs_unreleased', st.unreleased, b.pending from st, b
    union all
    select 'withdrawn_vs_paid_withdrawals', wd.paid_kobo, b.withdrawn from wd, b
    union all
    select 'organiser_payouts_vs_withdrawn', b.withdrawn, b.payouts from b
    union all
    select 'transfer_fees_vs_transfers', tr.fees, b.transfer_fees from tr, b
    -- Never show more than Kolekto holds: money at Paystack plus money
    -- settled to Kolekto must cover every organiser liability still held.
    union all
    select 'held_funds_cover_organiser_liabilities', b.pending + b.available + b.withdrawing,
           b.receivable + b.settled_funds from b
    union all
    select 'contributions_without_settlement_row', 0::bigint,
           (select count(*) from public.contributions c
             where not exists (select 1 from public.contribution_settlements s where s.contribution_id = c.id))::bigint
    union all
    select 'unbalanced_journals', 0::bigint, (select count(*) from public.v_ledger_imbalances)::bigint
    union all
    select 'collections_with_negative_available', 0::bigint,
           (select count(*) from public.v_collection_position p where p.available_kobo < 0)::bigint
  )
  select r.check_name, r.expected, r.ledger, r.ledger - r.expected,
         case when r.check_name = 'held_funds_cover_organiser_liabilities' then r.ledger >= r.expected
              else r.ledger = r.expected end
  from rows r;
end;
$$;
revoke execute on function app.platform_reconciliation() from public, anon, authenticated;

comment on function app.platform_reconciliation() is
  'Operator: platform-wide ledger identities — receivable vs unconfirmed provider settlements less transfers paid from the Paystack balance, pending vs unreleased settlements, withdrawn vs paid withdrawals vs payouts contra, transfer fees vs transfer records, held funds covering pending + available + withdrawing, every contribution scheduled, every journal balanced, no negative available balance.';
