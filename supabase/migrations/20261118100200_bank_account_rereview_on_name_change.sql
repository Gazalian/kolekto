-- ─────────────────────────────────────────────────────────────────────────────
-- 20261118100200 — a profile name change sends verified bank accounts back to
-- review (owner decision 2026-11-18, audit doc §14).
--
-- WHY. A saved account is verified because the name the bank reports matches
-- the profile name (20261118100100). The profile name is editable, so without
-- this anyone could rename themselves to match another person's account,
-- register it as verified, and pay collection money to it. Now any change to
-- users.full_name (ignoring case and spacing) moves every VERIFIED account of
-- that user to needs_review; an operator approves or rejects it again with
-- app.review_bank_account.
--
-- EFFECT ON MONEY. None on any stored amount. While an account is in review:
--   · new withdrawals to it are refused (request_withdrawal_to_account needs
--     verified),
--   · an approved withdrawal to it is not claimed for transfer (the claim
--     needs verified); it waits for the review. If the account is rejected,
--     operations fail it with app.fail_withdrawal, which returns the held
--     amount to the collection's available balance.
--   · a withdrawal already claimed (processing) finishes: its transfer may
--     already have left, and stopping it would not bring the money back.
--
-- Additive: one transition added to the guard, one trigger.
--
-- ROLLBACK:
--   drop trigger users_rereview_bank_accounts on public.users;
--   drop function app.rereview_bank_accounts_on_name_change();
--   and re-create app.guard_user_bank_account() from 20261118100100 (without
--   the verified → needs_review transition). Accounts already moved to review
--   stay there until an operator decides; nothing else changes.
-- ─────────────────────────────────────────────────────────────────────────────

-- The guard as in 20261118100100, plus verified → needs_review.
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
    or (old.status = 'verified'     and new.status in ('disabled', 'needs_review'))) then
    raise exception 'BANK_ACCOUNT_INVALID_TRANSITION: % → %', old.status, new.status using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_user_bank_account() from public, anon, authenticated;


create or replace function app.rereview_bank_accounts_on_name_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b public.user_bank_accounts%rowtype;
begin
  for v_b in
    select * from public.user_bank_accounts b
    where b.user_id = new.id and b.status = 'verified'
    order by b.created_at
    for update
  loop
    update public.user_bank_accounts
    set status = 'needs_review',
        is_default = false,
        review_note = 'Profile name changed; the account must be checked again'
    where id = v_b.id;

    -- Last four digits only; names are not copied into the audit trail.
    perform app.write_audit_log(
      null, 'system', null, 'bank_account.rereview', 'user_bank_account', v_b.id,
      jsonb_build_object('status', 'verified'),
      jsonb_build_object('status', 'needs_review', 'account_last4', right(v_b.account_number, 4)),
      'profile name changed');
  end loop;
  return null;
end;
$$;
revoke execute on function app.rereview_bank_accounts_on_name_change() from public, anon, authenticated;

comment on function app.rereview_bank_accounts_on_name_change() is
  'Owner decision 2026-11-18: a profile name change moves the user''s verified bank accounts to needs_review, because verification rests on the bank name matching the profile name.';

create trigger users_rereview_bank_accounts
  after update of full_name on public.users
  for each row
  when (lower(regexp_replace(btrim(old.full_name), '\s+', ' ', 'g'))
        is distinct from lower(regexp_replace(btrim(new.full_name), '\s+', ' ', 'g')))
  execute function app.rereview_bank_accounts_on_name_change();
