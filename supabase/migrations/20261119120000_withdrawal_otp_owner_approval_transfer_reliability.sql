-- ─────────────────────────────────────────────────────────────────────────────
-- 20261119120000 — Member OTP, mandatory community-owner approval, Paystack
--                  server approval, transfer reliability (PA-08 / PA-09)
--
-- Owner decisions 2026-11-19 (financial-decisions.md §22):
--   · Collection-level ownership kept; PA-04 (organiser subaccounts) is not
--     applicable. Payouts stay Kolekto-controlled Paystack transfers.
--   · A withdrawal goes to the REQUESTING member's own verified bank account.
--   · The requesting member confirms the request with a Kolekto one-time code
--     sent to their verified email (Option A: 10 minutes, 5 attempts, single
--     use, only a keyed hash stored).
--   · The community owner approves EVERY withdrawal, as a separate recorded
--     decision. Treasurer `withdrawal.approve` does not substitute for it.
--   · Paystack's per-transfer dashboard OTP is to be replaced by Paystack's
--     server approval (approval URL). Kolekto answers 200 only for a transfer
--     that matches a fully authorised, reserved withdrawal.
--
-- FLOW (each step is a database fact; none of them is "paid")
--   request ─► hold journal posted, OTP challenge created (pending_delivery)
--           ─► worker generates the code, stores HMAC(secret, challenge:code),
--              emails it (the code exists only in worker memory and the email)
--           ─► member enters the code: verify_withdrawal_otp (atomic: attempt
--              count, expiry, single use, withdrawal.member_otp_verified_at)
--           ─► owner approves (decide_withdrawal) — refused until the member
--              has verified; the owner cannot change the destination
--           ─► worker claims (requires OTP + owner approval + same verified
--              account of the requester) → transfer row `initiating`, leased
--           ─► initiate_requested_at committed BEFORE POST /transfer
--           ─► Paystack asks the approval URL → decide_transfer_approval
--           ─► verify by reference → settle (only provider-confirmed outcomes)
--
-- PA-08 / PA-09 (transfer reliability)
--   P8-1  A NOT FOUND never releases a reservation by itself. A hold is
--         released without a provider-confirmed failure only through
--         app.release_withdrawal_transfer_never_sent, which requires either
--         (a) the transfer was provably never sent (initiate_requested_at is
--             null: it is committed before every POST), or
--         (b) Paystack refused it synchronously with a code other than
--             duplicate_transfer_reference, Paystack never asked the approval
--             URL about it, and N consecutive verify calls over a minimum
--             window (policy) all said NOT FOUND.
--         An `unknown` (timeout / 5xx) is never released automatically.
--   P8-2  Open transfers are claimed with a lease (FOR UPDATE SKIP LOCKED,
--         claimed_until, claim_token). A stale token cannot change state.
--   P9    Bounded backoff from a versioned policy row, every check logged in
--         withdrawal_transfer_checks, escalation to manual reconciliation
--         after a window or a check count. Escalation never releases funds.
--   P8-4  Read-only reconciliation against Paystack's transfer list; its
--         report is stored (transfer_reconciliation_runs / _discrepancies).
--         Nothing in it changes a balance.
--
-- Additive. New columns, tables and functions; replaced function bodies keep
-- their signatures except claim_withdrawal_transfers and
-- collection_withdrawals (return types grow; dropped and re-created).
-- No stored amount changes. Backfill: initiate_requested_at for existing
-- transfer rows is set conservatively (anything that may have been sent is
-- treated as sent); next_check_at = now() for open rows.
--
-- Behaviour change for existing rows: an `approved` withdrawal to a saved
-- account that has no member OTP verification is no longer claimed for
-- transfer (there is no backfill of OTP verification). Operations either
-- fails it (app.fail_withdrawal, hold released) or the requester cancels.
--
-- ROLLBACK (local/dev only while no new-style withdrawal exists):
--   restore app.request_withdrawal_to_account, app.decide_withdrawal,
--   app.guard_withdrawal, app.guard_withdrawal_transfer,
--   app.claim_withdrawal_transfers, app.collection_withdrawals from
--   20261118100100; drop the functions created below; drop tables
--   transfer_reconciliation_discrepancies, transfer_reconciliation_runs,
--   withdrawal_transfer_approval_requests, withdrawal_transfer_checks,
--   withdrawal_transfer_check_policies, withdrawal_otp_challenges; drop the
--   new columns on withdrawal_transfers and withdrawals. Ledger journals are
--   never touched by this migration, so nothing financial needs reversing.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Withdrawals: member verification and owner-approval facts ────────────

alter table public.withdrawals
  add column member_otp_verified_at  timestamptz,
  add column member_otp_challenge_id uuid,
  add column owner_self_approved     boolean not null default false,
  -- The collection's available balance read under the lock, before this hold.
  add column available_before_kobo   bigint;

alter table public.withdrawals add constraint withdrawals_member_otp_shape
  check ((member_otp_verified_at is null) = (member_otp_challenge_id is null));
alter table public.withdrawals add constraint withdrawals_available_before_shape
  check (available_before_kobo is null or available_before_kobo >= amount_kobo + fee_kobo);


-- ── 2. One-time codes for the requesting member ─────────────────────────────

create table public.withdrawal_otp_challenges (
  id                  uuid primary key default app.uuid_generate_v7(),
  withdrawal_id       uuid not null references public.withdrawals (id) on delete restrict,
  -- The requesting member. The only person who may verify it.
  user_id             uuid not null references public.users (id) on delete restrict,
  channel             text not null default 'email',
  status              text not null default 'pending_delivery',
  -- HMAC-SHA256(server secret, challenge id || ':' || code), hex. Never the code.
  code_hash           text,
  attempts            integer not null default 0,
  max_attempts        integer not null default 5,
  created_at          timestamptz not null default now(),
  delivery_claimed_at timestamptz,
  issued_at           timestamptz,
  sent_at             timestamptz,
  expires_at          timestamptz,
  last_attempt_at     timestamptz,
  verified_at         timestamptz,
  closed_at           timestamptz,
  delivery_error      text,
  updated_at          timestamptz not null default now(),

  constraint withdrawal_otp_channel      check (channel = 'email'),
  constraint withdrawal_otp_status       check (status in ('pending_delivery', 'sending', 'sent', 'delivery_failed',
                                                           'verified', 'locked', 'expired', 'superseded', 'cancelled')),
  constraint withdrawal_otp_hash_format  check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  constraint withdrawal_otp_issued_shape check ((code_hash is null) = (issued_at is null)
                                                and (issued_at is null) = (expires_at is null)),
  constraint withdrawal_otp_attempts     check (attempts >= 0 and attempts <= max_attempts and max_attempts between 1 and 10),
  constraint withdrawal_otp_verified_shape check ((status = 'verified') = (verified_at is not null)),
  constraint withdrawal_otp_verified_issued check (status <> 'verified' or code_hash is not null),
  constraint withdrawal_otp_error_len    check (delivery_error is null or char_length(delivery_error) <= 200)
);

comment on table public.withdrawal_otp_challenges is
  'Owner decision 2026-11-19 (Option A): a Kolekto one-time code that confirms the requesting member made a withdrawal request. Bound to one withdrawal and one member; 10-minute validity from issue; 5 attempts; single use; only an HMAC of the code is stored (the key is a server secret outside the database). Verifying it is NOT owner approval and NOT payment.';

create unique index withdrawal_otp_one_open on public.withdrawal_otp_challenges (withdrawal_id)
  where status in ('pending_delivery', 'sending', 'sent');
create index withdrawal_otp_delivery_idx on public.withdrawal_otp_challenges (created_at)
  where status in ('pending_delivery', 'sending');
create index withdrawal_otp_user_idx on public.withdrawal_otp_challenges (user_id, created_at desc);
create index withdrawal_otp_withdrawal_idx on public.withdrawal_otp_challenges (withdrawal_id, created_at desc);

alter table public.withdrawal_otp_challenges enable row level security;
alter table public.withdrawal_otp_challenges force  row level security;
create policy withdrawal_otp_no_client_read on public.withdrawal_otp_challenges for select to authenticated using (false);
revoke all on public.withdrawal_otp_challenges from anon, authenticated;

alter table public.withdrawals add constraint withdrawals_member_otp_challenge_fk
  foreign key (member_otp_challenge_id) references public.withdrawal_otp_challenges (id) on delete restrict;

create or replace function app.guard_withdrawal_otp_challenge()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'OTP_CHALLENGE_IS_PERMANENT: one-time code records are never deleted' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id or new.withdrawal_id is distinct from old.withdrawal_id
     or new.user_id is distinct from old.user_id or new.channel is distinct from old.channel
     or new.created_at is distinct from old.created_at or new.max_attempts is distinct from old.max_attempts
     or (old.code_hash is not null and new.code_hash is distinct from old.code_hash)
     or (old.expires_at is not null and new.expires_at is distinct from old.expires_at)
     or new.attempts < old.attempts then
    raise exception 'OTP_CHALLENGE_FACTS_IMMUTABLE: a code is issued once, for one withdrawal and one member' using errcode = 'P0001';
  end if;
  if old.status <> new.status and not (
       (old.status = 'pending_delivery' and new.status in ('sending', 'delivery_failed', 'superseded', 'cancelled'))
    or (old.status = 'sending' and new.status in ('pending_delivery', 'sent', 'delivery_failed', 'verified', 'locked',
                                                  'expired', 'superseded', 'cancelled'))
    or (old.status = 'sent' and new.status in ('verified', 'locked', 'expired', 'superseded', 'cancelled'))) then
    raise exception 'OTP_CHALLENGE_INVALID_TRANSITION: % → %', old.status, new.status using errcode = 'P0001';
  end if;
  -- Back to pending_delivery only when the worker crashed before issuing a code.
  if old.status = 'sending' and new.status = 'pending_delivery' and old.code_hash is not null then
    raise exception 'OTP_CHALLENGE_INVALID_TRANSITION: an issued code is never re-issued under the same challenge' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_withdrawal_otp_challenge() from public, anon, authenticated;

create trigger withdrawal_otp_challenges_guard
  before update or delete on public.withdrawal_otp_challenges
  for each row execute function app.guard_withdrawal_otp_challenge();


-- ── 3. Withdrawal guard: member verification and owner approval facts ───────
-- As 20261118100100, plus: OTP facts and the reserved balance snapshot are
-- write-once, and requested → approved needs an approver, and (for a saved
-- account withdrawal) the member's verified code.

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
     or new.available_before_kobo is distinct from old.available_before_kobo
     or (old.member_otp_verified_at is not null and (new.member_otp_verified_at is distinct from old.member_otp_verified_at
                                                     or new.member_otp_challenge_id is distinct from old.member_otp_challenge_id))
     or (old.approved_at is not null and (new.approved_at is distinct from old.approved_at
                                          or new.approved_by is distinct from old.approved_by
                                          or new.owner_self_approved is distinct from old.owner_self_approved))
     or (old.status = 'paid' and (new.paid_at is distinct from old.paid_at
                                  or new.payout_journal_id is distinct from old.payout_journal_id
                                  or new.payout_reference is distinct from old.payout_reference)) then
    raise exception 'WITHDRAWAL_FACTS_IMMUTABLE: amount, destination, requester and recorded approvals never change' using errcode = 'P0001';
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
  if old.status = 'requested' and new.status = 'approved' then
    if new.approved_by is null or new.approved_at is null then
      raise exception 'WITHDRAWAL_APPROVAL_UNRECORDED: an approval names the owner who gave it' using errcode = 'P0001';
    end if;
    if new.bank_account_id is not null and new.member_otp_verified_at is null then
      raise exception 'WITHDRAWAL_AWAITING_MEMBER_VERIFICATION: the requesting member has not confirmed the request' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_withdrawal() from public, anon, authenticated;


-- ── 4. OTP helpers ──────────────────────────────────────────────────────────

-- Opens a fresh challenge for a withdrawal, superseding any open one.
-- Callers hold the withdrawal row lock. Rate limits are the caller's.
create or replace function app.open_withdrawal_otp_challenge(p_withdrawal_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := app.uuid_generate_v7();
begin
  update public.withdrawal_otp_challenges
  set status = 'superseded', closed_at = now()
  where withdrawal_id = p_withdrawal_id and status in ('pending_delivery', 'sending', 'sent');
  insert into public.withdrawal_otp_challenges (id, withdrawal_id, user_id) values (v_id, p_withdrawal_id, p_user_id);
  return v_id;
end;
$$;
revoke execute on function app.open_withdrawal_otp_challenge(uuid, uuid) from public, anon, authenticated;

-- Closes every open challenge of a withdrawal (cancel / reject).
create or replace function app.close_withdrawal_otp_challenges(p_withdrawal_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.withdrawal_otp_challenges
  set status = 'cancelled', closed_at = now()
  where withdrawal_id = p_withdrawal_id and status in ('pending_delivery', 'sending', 'sent');
$$;
revoke execute on function app.close_withdrawal_otp_challenges(uuid) from public, anon, authenticated;

-- The requester's sign-in email, only when Supabase Auth has confirmed it.
create or replace function app.verified_account_email(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.email::text from auth.users a
  where a.id = p_user_id and a.email is not null and a.email_confirmed_at is not null;
$$;
revoke execute on function app.verified_account_email(uuid) from public, anon, authenticated;

-- Stage of a withdrawal in the two-approval flow, for screens.
create or replace function app.withdrawal_stage(p_w public.withdrawals)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_w.status = 'requested' and p_w.bank_account_id is not null and p_w.member_otp_verified_at is null
      then 'awaiting_member_verification'
    when p_w.status = 'requested' then 'awaiting_owner_approval'
    when p_w.status = 'approved' then 'ready_for_transfer'
    else p_w.status::text
  end;
$$;
revoke execute on function app.withdrawal_stage(public.withdrawals) from public, anon, authenticated;


-- ── 5. Request a withdrawal (replaces 20261118100100) ───────────────────────
-- Same locking, balance, idempotency, daily limit (D-07), review flag (D-06),
-- destination rules (own verified account, D-08 cooling-off). Changes:
--   · every request starts `requested`, the owner's included (owner approval
--     is now its own recorded step, after the member's code);
--   · the requester's sign-in email must be confirmed (the code goes there);
--   · the available balance read under the lock is recorded;
--   · the first one-time code challenge is opened in the same transaction.

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
  v_journal    uuid;
  v_challenge  uuid;
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
  if app.verified_account_email(v_uid) is null then
    raise exception 'EMAIL_NOT_VERIFIED: confirm your email address first; the withdrawal code is sent there'
      using errcode = 'P0001';
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

  v_avail_acct := app.ensure_ledger_account(v_collection.community_id, p_collection_id, 'collection_available');
  v_wd_acct    := app.ensure_ledger_account(v_collection.community_id, p_collection_id, 'collection_withdrawing');
  perform 1 from public.ledger_accounts where id = v_avail_acct for update;
  perform pg_advisory_xact_lock(hashtextextended('withdrawal_daily:' || v_collection.community_id::text, 0));

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

  v_ref := 'KWD-' || upper(substr(md5(v_id::text || clock_timestamp()::text), 1, 16));

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
    destination_bank_code, bank_account_id, requested_by, idempotency_key, hold_journal_id, available_before_kobo
  ) values (
    v_id, v_collection.community_id, p_collection_id, v_ref, p_amount_kobo, 0, null, v_first,
    p_amount_kobo > c_review_over, 'requested', v_bank.account_name, v_bank.account_number, v_bank.bank_name,
    v_bank.bank_code, v_bank.id, v_uid, p_idempotency_key, v_journal, v_available
  );

  v_challenge := app.open_withdrawal_otp_challenge(v_id, v_uid);

  perform app.write_audit_log(
    v_collection.community_id, 'officer', v_uid, 'withdrawal.request', 'withdrawal', v_id, null,
    jsonb_build_object('reference', v_ref, 'collection_id', p_collection_id, 'amount_kobo', p_amount_kobo,
                       'fee_kobo', 0, 'status', 'requested', 'bank_account_id', v_bank.id,
                       'account_last4', right(v_bank.account_number, 4), 'available_before_kobo', v_available,
                       'otp_challenge_id', v_challenge));

  return query select v_id, v_ref, 'requested'::public.withdrawal_status, 0::bigint, false;
end;
$$;
revoke all on function app.request_withdrawal_to_account(uuid, bigint, uuid, text) from public;
grant execute on function app.request_withdrawal_to_account(uuid, bigint, uuid, text) to authenticated;

comment on function app.request_withdrawal_to_account(uuid, bigint, uuid, text) is
  'D-03, D-06, D-07, D-08; owner decisions 2026-11-18 and 2026-11-19: request a withdrawal from one collection to one of the requester''s own verified saved bank accounts. Locks the collection''s available account, sums ledger entries, refuses above available, posts the hold journal and opens the member''s one-time code challenge in the same transaction. Always starts `requested`: the member confirms with the code, then the community owner approves. Idempotent per (collection, requester, key).';


-- ── 6. Member OTP: resend, state, verify (signed-in requester) ──────────────

create or replace function app.request_withdrawal_otp(p_withdrawal_id uuid)
returns table (challenge_id uuid, resend_available_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_cooldown          constant interval := interval '60 seconds';
  c_max_per_withdrawal constant integer := 5;
  c_max_per_user_hour constant integer := 10;
  v_uid  uuid := auth.uid();
  v_w    public.withdrawals%rowtype;
  v_last timestamptz;
  v_id   uuid;
begin
  select * into v_w from public.withdrawals w where w.id = p_withdrawal_id for update;
  if v_uid is null or v_w.id is null or v_w.requested_by <> v_uid then
    raise exception 'NOT_FOUND: withdrawal % does not exist', p_withdrawal_id using errcode = 'P0002';
  end if;
  if v_w.status <> 'requested' or v_w.bank_account_id is null then
    raise exception 'WITHDRAWAL_NOT_AWAITING_VERIFICATION: withdrawal % is %', v_w.reference, v_w.status using errcode = 'P0001';
  end if;
  if v_w.member_otp_verified_at is not null then
    raise exception 'WITHDRAWAL_ALREADY_VERIFIED: this request is already confirmed' using errcode = 'P0001';
  end if;
  if app.verified_account_email(v_uid) is null then
    raise exception 'EMAIL_NOT_VERIFIED: confirm your email address first' using errcode = 'P0001';
  end if;

  select max(c.created_at) into v_last from public.withdrawal_otp_challenges c where c.withdrawal_id = v_w.id;
  if v_last is not null and v_last > now() - c_cooldown then
    raise exception 'OTP_RESEND_TOO_SOON: a new code can be requested from %', v_last + c_cooldown using errcode = 'P0001';
  end if;
  if (select count(*) from public.withdrawal_otp_challenges c where c.withdrawal_id = v_w.id) >= c_max_per_withdrawal then
    raise exception 'OTP_TOO_MANY_CODES: too many codes for this request; cancel it and start again' using errcode = 'P0001';
  end if;
  if (select count(*) from public.withdrawal_otp_challenges c
      where c.user_id = v_uid and c.created_at > now() - interval '1 hour') >= c_max_per_user_hour then
    raise exception 'OTP_RATE_LIMITED: too many codes requested; try again later' using errcode = 'P0001';
  end if;

  v_id := app.open_withdrawal_otp_challenge(v_w.id, v_uid);
  perform app.write_audit_log(v_w.community_id, 'officer', v_uid, 'withdrawal.otp_resend', 'withdrawal', v_w.id,
    null, jsonb_build_object('reference', v_w.reference, 'otp_challenge_id', v_id));
  return query select v_id, now() + c_cooldown;
end;
$$;
revoke all on function app.request_withdrawal_otp(uuid) from public;
grant execute on function app.request_withdrawal_otp(uuid) to authenticated;


create or replace function app.withdrawal_otp_state(p_withdrawal_id uuid)
returns table (
  challenge_id uuid, challenge_status text, sent_at timestamptz, expires_at timestamptz,
  attempts_remaining integer, resend_available_at timestamptz, email_hint text,
  member_verified boolean, stage text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid   uuid := auth.uid();
  v_w     public.withdrawals%rowtype;
  v_c     public.withdrawal_otp_challenges%rowtype;
  v_email text;
  v_last  timestamptz;
begin
  select * into v_w from public.withdrawals w where w.id = p_withdrawal_id;
  if v_uid is null or v_w.id is null or v_w.requested_by <> v_uid then
    raise exception 'NOT_FOUND: withdrawal % does not exist', p_withdrawal_id using errcode = 'P0002';
  end if;
  select * into v_c from public.withdrawal_otp_challenges c
  where c.withdrawal_id = v_w.id order by c.created_at desc, c.id desc limit 1;
  select max(c.created_at) into v_last from public.withdrawal_otp_challenges c where c.withdrawal_id = v_w.id;
  v_email := app.verified_account_email(v_uid);

  return query select
    v_c.id,
    -- An issued code past its time reads as expired before anyone tries it.
    case when v_c.status in ('sending', 'sent') and v_c.expires_at is not null and v_c.expires_at <= now() then 'expired'
         else v_c.status end,
    v_c.sent_at, v_c.expires_at,
    case when v_c.id is null then null else v_c.max_attempts - v_c.attempts end,
    case when v_last is null then now() else v_last + interval '60 seconds' end,
    case when v_email is null then null
         else left(split_part(v_email, '@', 1), 1) || '•••@' || split_part(v_email, '@', 2) end,
    v_w.member_otp_verified_at is not null,
    app.withdrawal_stage(v_w);
end;
$$;
revoke all on function app.withdrawal_otp_state(uuid) from public;
grant execute on function app.withdrawal_otp_state(uuid) to authenticated;


-- outcome: verified | already_verified | incorrect | locked | expired |
--          superseded | not_sent | withdrawal_closed
-- Returned, never raised, so a wrong attempt is counted (a raise would roll
-- the count back). The code itself never reaches the database: the server
-- sends HMAC(secret, challenge id || ':' || code).
create or replace function app.verify_withdrawal_otp(p_withdrawal_id uuid, p_challenge_id uuid, p_code_hash text)
returns table (outcome text, attempts_remaining integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_w   public.withdrawals%rowtype;
  v_c   public.withdrawal_otp_challenges%rowtype;
  v_attempts integer;
begin
  -- Lock order everywhere: withdrawal, then challenge.
  select * into v_w from public.withdrawals w where w.id = p_withdrawal_id for update;
  if v_uid is null or v_w.id is null or v_w.requested_by <> v_uid then
    raise exception 'NOT_FOUND: withdrawal % does not exist', p_withdrawal_id using errcode = 'P0002';
  end if;
  select * into v_c from public.withdrawal_otp_challenges c where c.id = p_challenge_id for update;
  -- A code for another withdrawal, or another member's code, is never usable here.
  if v_c.id is null or v_c.withdrawal_id <> v_w.id or v_c.user_id <> v_uid then
    raise exception 'OTP_CHALLENGE_MISMATCH: that code does not belong to this request' using errcode = 'P0001';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_CODE: enter the 6-digit code' using errcode = '22023';
  end if;

  if v_w.member_otp_verified_at is not null then
    return query select 'already_verified'::text, null::integer;
    return;
  end if;
  if v_w.status <> 'requested' then
    return query select 'withdrawal_closed'::text, null::integer;
    return;
  end if;
  if v_c.status = 'superseded' or v_c.status = 'cancelled' then
    return query select 'superseded'::text, null::integer;
    return;
  end if;
  if v_c.status = 'locked' then
    return query select 'locked'::text, 0;
    return;
  end if;
  if v_c.status = 'expired' then
    return query select 'expired'::text, null::integer;
    return;
  end if;
  if v_c.status not in ('sending', 'sent') or v_c.code_hash is null then
    return query select 'not_sent'::text, null::integer;
    return;
  end if;
  if v_c.expires_at <= now() then
    update public.withdrawal_otp_challenges set status = 'expired', closed_at = now() where id = v_c.id;
    return query select 'expired'::text, null::integer;
    return;
  end if;

  if v_c.code_hash = p_code_hash then
    update public.withdrawal_otp_challenges
    set status = 'verified', verified_at = now(), closed_at = now(), last_attempt_at = now(), attempts = v_c.attempts + 1
    where id = v_c.id;
    update public.withdrawals
    set member_otp_verified_at = now(), member_otp_challenge_id = v_c.id
    where id = v_w.id;
    perform app.write_audit_log(v_w.community_id, 'officer', v_uid, 'withdrawal.member_verified', 'withdrawal', v_w.id,
      jsonb_build_object('stage', 'awaiting_member_verification'),
      jsonb_build_object('reference', v_w.reference, 'otp_challenge_id', v_c.id, 'stage', 'awaiting_owner_approval'));
    return query select 'verified'::text, null::integer;
    return;
  end if;

  v_attempts := v_c.attempts + 1;
  update public.withdrawal_otp_challenges
  set attempts = v_attempts, last_attempt_at = now(),
      status = case when v_attempts >= v_c.max_attempts then 'locked' else v_c.status end,
      closed_at = case when v_attempts >= v_c.max_attempts then now() end
  where id = v_c.id;
  if v_attempts >= v_c.max_attempts then
    perform app.write_audit_log(v_w.community_id, 'officer', v_uid, 'withdrawal.otp_locked', 'withdrawal', v_w.id,
      null, jsonb_build_object('reference', v_w.reference, 'otp_challenge_id', v_c.id, 'attempts', v_attempts));
    return query select 'locked'::text, 0;
    return;
  end if;
  return query select 'incorrect'::text, v_c.max_attempts - v_attempts;
end;
$$;
revoke all on function app.verify_withdrawal_otp(uuid, uuid, text) from public;
grant execute on function app.verify_withdrawal_otp(uuid, uuid, text) to authenticated;


-- ── 7. Member OTP: delivery (operator / worker) ─────────────────────────────

-- Claims codes to send. Also takes back a challenge whose worker crashed
-- before issuing a code (sending, no hash, claimed > 2 minutes ago), and
-- closes challenges nobody could deliver within the validity window.
create or replace function app.claim_withdrawal_otp_deliveries(p_limit integer default 10)
returns table (
  challenge_id uuid, withdrawal_id uuid, email text, recipient_name text, withdrawal_reference text,
  amount_kobo bigint, collection_name text, community_name text, bank_name text, account_last4 text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row record;
begin
  perform app.assert_payment_operator_session();
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_LIMIT: between 1 and 100' using errcode = '22023';
  end if;

  update public.withdrawal_otp_challenges c
  set status = 'delivery_failed', delivery_error = 'not_sent_within_validity', closed_at = now()
  where c.status in ('pending_delivery', 'sending') and c.code_hash is null and c.created_at < now() - interval '10 minutes';

  for v_row in
    select c.id, c.withdrawal_id, c.user_id
    from public.withdrawal_otp_challenges c
    join public.withdrawals w on w.id = c.withdrawal_id
    where (c.status = 'pending_delivery'
           or (c.status = 'sending' and c.code_hash is null and c.delivery_claimed_at < now() - interval '2 minutes'))
      and w.status = 'requested'
    order by c.created_at
    limit p_limit
    for update of c skip locked
  loop
    update public.withdrawal_otp_challenges set status = 'sending', delivery_claimed_at = now() where id = v_row.id;
    return query
    select v_row.id, v_row.withdrawal_id, app.verified_account_email(v_row.user_id), u.full_name, w.reference,
           w.amount_kobo::bigint, col.name, com.name, w.destination_bank_name, right(w.destination_account_number, 4)
    from public.withdrawals w
    join public.users u on u.id = v_row.user_id
    join public.collections col on col.id = w.collection_id
    join public.communities com on com.id = w.community_id
    where w.id = v_row.withdrawal_id;
  end loop;
end;
$$;
revoke execute on function app.claim_withdrawal_otp_deliveries(integer) from public, anon, authenticated;

-- Records the keyed hash of the code the worker generated, BEFORE the email
-- is sent, so a delivered code is always verifiable. Write-once.
create or replace function app.record_withdrawal_otp_issued(p_challenge_id uuid, p_code_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.withdrawal_otp_challenges%rowtype;
begin
  perform app.assert_payment_operator_session();
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_CODE_HASH: a 64-character hex HMAC is required' using errcode = '22023';
  end if;
  select * into v_c from public.withdrawal_otp_challenges where id = p_challenge_id for update;
  if v_c.id is null or v_c.status <> 'sending' or v_c.code_hash is not null then
    return false;   -- superseded, cancelled, or already issued: do not send
  end if;
  update public.withdrawal_otp_challenges
  set code_hash = p_code_hash, issued_at = now(), expires_at = now() + interval '10 minutes'
  where id = v_c.id;
  return true;
end;
$$;
revoke execute on function app.record_withdrawal_otp_issued(uuid, text) from public, anon, authenticated;

create or replace function app.record_withdrawal_otp_delivery(p_challenge_id uuid, p_delivered boolean, p_error text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.withdrawal_otp_challenges%rowtype;
begin
  perform app.assert_payment_operator_session();
  select * into v_c from public.withdrawal_otp_challenges where id = p_challenge_id for update;
  if v_c.id is null then
    raise exception 'NOT_FOUND: challenge % does not exist', p_challenge_id using errcode = 'P0002';
  end if;
  if v_c.status <> 'sending' then
    return v_c.status;   -- already verified / superseded / cancelled meanwhile
  end if;
  if p_delivered then
    update public.withdrawal_otp_challenges set status = 'sent', sent_at = now() where id = v_c.id;
    return 'sent';
  end if;
  update public.withdrawal_otp_challenges
  set status = 'delivery_failed', closed_at = now(), delivery_error = left(coalesce(nullif(btrim(p_error), ''), 'send_failed'), 200)
  where id = v_c.id;
  return 'delivery_failed';
end;
$$;
revoke execute on function app.record_withdrawal_otp_delivery(uuid, boolean, text) from public, anon, authenticated;


-- ── 8. Owner decision, requester cancel (replaces 20261117100200) ───────────
-- approve: a current community OWNER only (a treasurer's withdrawal.approve
--   does not substitute); only after the requesting member's code is
--   verified; only while the destination is still the requester's own
--   verified account past cooling-off (a changed account blocks approval;
--   the owner can reject). An owner approving their own request is allowed
--   (D-06: owner approval; it was automatic before) and is recorded as
--   owner_self_approved. D-06 manual review over ₦1,000,000 is unchanged:
--   the worker never claims such a withdrawal.
-- reject: owner only, at any time while requested, with a reason.
-- cancel: the requester or a withdrawal.request holder while requested or
--   approved (not yet claimed for transfer).

create or replace function app.decide_withdrawal(p_withdrawal_id uuid, p_decision text, p_reason text default null)
returns public.withdrawal_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_w    public.withdrawals%rowtype;
  v_bank public.user_bank_accounts%rowtype;
  v_rel  uuid;
begin
  select * into v_w from public.withdrawals where id = p_withdrawal_id for update;
  if v_w.id is null then
    raise exception 'NOT_FOUND: withdrawal % does not exist', p_withdrawal_id using errcode = 'P0002';
  end if;
  if p_decision not in ('approve', 'reject', 'cancel') then
    raise exception 'INVALID_DECISION: approve, reject or cancel' using errcode = '22023';
  end if;

  if p_decision in ('approve', 'reject') then
    if v_uid is null or not app.is_community_owner(v_w.community_id) then
      raise exception 'FORBIDDEN: only the community owner approves or rejects a withdrawal' using errcode = '42501';
    end if;
    if v_w.status <> 'requested' then
      raise exception 'WITHDRAWAL_NOT_PENDING: withdrawal % is %', v_w.reference, v_w.status using errcode = 'P0001';
    end if;
    if p_decision = 'reject' and coalesce(btrim(p_reason), '') = '' then
      raise exception 'INVALID_REASON: say why the withdrawal is rejected' using errcode = '22023';
    end if;
    if p_decision = 'approve' then
      if v_w.bank_account_id is not null and v_w.member_otp_verified_at is null then
        raise exception 'WITHDRAWAL_AWAITING_MEMBER_VERIFICATION: the requesting member has not confirmed this request with their code yet'
          using errcode = 'P0001';
      end if;
      if v_w.bank_account_id is not null then
        select * into v_bank from public.user_bank_accounts where id = v_w.bank_account_id;
        if v_bank.user_id is distinct from v_w.requested_by or v_bank.status <> 'verified' or v_bank.usable_from > now() then
          raise exception 'WITHDRAWAL_BANK_ACCOUNT_CHANGED: the destination account is no longer a verified account of the requester (%); reject this request',
            coalesce(v_bank.status, 'missing') using errcode = 'P0001';
        end if;
      end if;
    end if;
  else
    if v_uid is null or not (v_uid = v_w.requested_by
                             or app.has_permission_for_collection(v_w.collection_id, 'withdrawal.request')) then
      raise exception 'FORBIDDEN: missing permission withdrawal.request' using errcode = '42501';
    end if;
    if v_w.status not in ('requested', 'approved') then
      raise exception 'WITHDRAWAL_NOT_CANCELLABLE: withdrawal % is % and can no longer be cancelled', v_w.reference, v_w.status
        using errcode = 'P0001';
    end if;
  end if;

  if p_decision = 'approve' then
    update public.withdrawals
    set status = 'approved', approved_by = v_uid, approved_at = now(), owner_self_approved = (v_uid = v_w.requested_by)
    where id = v_w.id;
  else
    v_rel := app.release_withdrawal_hold(v_w, 'officer', v_uid, case when p_decision = 'reject' then 'rejected' else 'cancelled' end);
    perform app.close_withdrawal_otp_challenges(v_w.id);
    update public.withdrawals
    set status = case when p_decision = 'reject' then 'rejected'::public.withdrawal_status else 'cancelled' end,
        decided_by = v_uid, decided_at = now(), decision_reason = left(nullif(btrim(p_reason), ''), 500),
        release_journal_id = v_rel
    where id = v_w.id;
  end if;

  perform app.write_audit_log(
    v_w.community_id, 'officer', v_uid, 'withdrawal.' || p_decision, 'withdrawal', v_w.id,
    jsonb_build_object('status', v_w.status::text, 'member_verified', v_w.member_otp_verified_at is not null),
    jsonb_build_object('reference', v_w.reference, 'decision', p_decision,
                       'owner_self_approved', p_decision = 'approve' and v_uid = v_w.requested_by),
    left(nullif(btrim(p_reason), ''), 500));

  return (select w.status from public.withdrawals w where w.id = v_w.id);
end;
$$;
revoke all on function app.decide_withdrawal(uuid, text, text) from public;
grant execute on function app.decide_withdrawal(uuid, text, text) to authenticated;


-- ── 9. Transfers: reliability columns, policy, check log ────────────────────

alter table public.withdrawal_transfers
  -- Committed immediately before every POST /transfer. Null = provably never sent.
  add column initiate_requested_at   timestamptz,
  add column next_check_at           timestamptz,
  add column check_count             integer not null default 0,
  -- Consecutive verify answers of NOT FOUND (reset by any found answer).
  add column not_found_count         integer not null default 0,
  add column ambiguous_since         timestamptz,
  add column refused_at              timestamptz,
  add column refusal_code            text,
  -- Paystack asked the approval URL and Kolekto said yes (first time).
  add column provider_approved_at    timestamptz,
  add column provider_approval_count integer not null default 0,
  add column escalated_at            timestamptz,
  add column escalation_reason       text,
  add column claimed_by              text,
  add column claimed_until           timestamptz,
  add column claim_token             uuid;

alter table public.withdrawal_transfers add constraint withdrawal_transfers_counts
  check (check_count >= 0 and not_found_count >= 0 and provider_approval_count >= 0);
alter table public.withdrawal_transfers add constraint withdrawal_transfers_claim_shape
  check ((claim_token is null) = (claimed_until is null) and (claim_token is null) = (claimed_by is null));
alter table public.withdrawal_transfers add constraint withdrawal_transfers_escalation_shape
  check ((escalated_at is null) = (escalation_reason is null));

-- Conservative backfill: anything that may have reached Paystack is "sent".
-- An `initiating` row with no recipient never called Paystack (the recipient
-- is always pinned before the call), so it stays unsent.
update public.withdrawal_transfers
set initiate_requested_at = coalesce(initiated_at, created_at)
where initiate_requested_at is null
  and (status <> 'initiating' or recipient_code is not null or transfer_code is not null);
update public.withdrawal_transfers
set next_check_at = now()
where status in ('initiating', 'pending', 'otp', 'unknown') and next_check_at is null;

create index withdrawal_transfers_due_idx on public.withdrawal_transfers (next_check_at)
  where status in ('initiating', 'pending', 'otp', 'unknown');

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
     or (old.fee_journal_id is not null and new.fee_journal_id is distinct from old.fee_journal_id)
     or (old.initiate_requested_at is not null and new.initiate_requested_at is distinct from old.initiate_requested_at)
     or (old.provider_approved_at is not null and new.provider_approved_at is distinct from old.provider_approved_at)
     or (old.escalated_at is not null and new.escalated_at is distinct from old.escalated_at)
     or (old.refused_at is not null and new.refused_at is distinct from old.refused_at)
     or new.check_count < old.check_count or new.provider_approval_count < old.provider_approval_count then
    raise exception 'TRANSFER_FACTS_IMMUTABLE: reference, amount, transfer code and recorded provider facts never change' using errcode = 'P0001';
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


create table public.withdrawal_transfer_check_policies (
  version                         text primary key,
  effective_from                  timestamptz not null,
  -- Delay before check n+1 after check n (index 1 = after the first check).
  -- The first check runs immediately after the ambiguous result.
  intervals_seconds               integer[] not null,
  max_interval_seconds            integer not null,
  -- Open this long (from first send) → escalated to manual reconciliation.
  escalate_after_seconds          integer not null,
  -- Parked at Paystack's dashboard OTP this long → escalated.
  escalate_otp_after_seconds      integer not null,
  max_auto_checks                 integer not null,
  -- Re-send under the SAME reference only after this many NOT FOUND answers.
  resend_after_not_found          integer not null,
  -- A synchronous refusal releases the hold only after this many consecutive
  -- NOT FOUND answers spanning at least this long.
  refused_release_min_not_found   integer not null,
  refused_release_min_age_seconds integer not null,
  lease_seconds                   integer not null,
  notes                           text not null,
  created_at                      timestamptz not null default now(),
  constraint transfer_check_policy_intervals check (cardinality(intervals_seconds) between 1 and 20
                                                    and 0 < all (intervals_seconds)),
  constraint transfer_check_policy_positive check (max_interval_seconds > 0 and escalate_after_seconds > 0
    and escalate_otp_after_seconds > 0 and max_auto_checks > 0 and resend_after_not_found >= 1
    and refused_release_min_not_found >= 2 and refused_release_min_age_seconds >= 300 and lease_seconds between 30 and 1800)
);
comment on table public.withdrawal_transfer_check_policies is
  'PA-09: versioned, append-only verification schedule for open transfers. Operational defaults chosen by Kolekto (owner brief 2026-11-19), not a statement about Paystack''s settlement timing. Escalation never releases funds.';

alter table public.withdrawal_transfer_check_policies enable row level security;
alter table public.withdrawal_transfer_check_policies force  row level security;
create policy withdrawal_transfer_check_policies_no_client_read on public.withdrawal_transfer_check_policies
  for select to authenticated using (false);
revoke all on public.withdrawal_transfer_check_policies from anon, authenticated;

create or replace function app.block_transfer_check_policy_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'TRANSFER_CHECK_POLICY_APPEND_ONLY: add a new version instead' using errcode = 'P0001';
end;
$$;
revoke execute on function app.block_transfer_check_policy_mutation() from public, anon, authenticated;
create trigger withdrawal_transfer_check_policies_append_only
  before update or delete on public.withdrawal_transfer_check_policies
  for each row execute function app.block_transfer_check_policy_mutation();

insert into public.withdrawal_transfer_check_policies (
  version, effective_from, intervals_seconds, max_interval_seconds, escalate_after_seconds, escalate_otp_after_seconds,
  max_auto_checks, resend_after_not_found, refused_release_min_not_found, refused_release_min_age_seconds,
  lease_seconds, notes
) values (
  '2026-11-19-default', '2026-11-19 00:00:00+01',
  -- after check 1: 2 min, then 5, 10, 30 min, 1 h, 2 h, 4 h; then every 6 h.
  array[120, 300, 600, 1800, 3600, 7200, 14400], 21600,
  86400, 7200, 40, 2, 3, 1800, 120,
  'Owner brief 2026-11-19 §6: immediate, 2, 5, 10 minutes, then progressively longer, capped at 6 hours. Escalate after 24 h open (2 h at dashboard OTP) or 40 checks.'
);

create or replace function app.current_transfer_check_policy()
returns public.withdrawal_transfer_check_policies
language sql
stable
security definer
set search_path = ''
as $$
  select p from public.withdrawal_transfer_check_policies p
  where p.effective_from <= now() order by p.effective_from desc limit 1;
$$;
revoke execute on function app.current_transfer_check_policy() from public, anon, authenticated;


create table public.withdrawal_transfer_checks (
  id              uuid primary key default app.uuid_generate_v7(),
  transfer_id     uuid not null references public.withdrawal_transfers (id) on delete restrict,
  checked_at      timestamptz not null default now(),
  source          text not null,
  worker          text,
  check_number    integer not null,
  provider_result text not null,
  provider_status text,
  provider_code   text,
  outcome         text not null,
  next_check_at   timestamptz,
  note            text,
  constraint withdrawal_transfer_checks_source check (source in ('dispatch', 'check', 'webhook', 'approval', 'reconciliation', 'operator')),
  constraint withdrawal_transfer_checks_result check (provider_result in ('ok', 'not_found', 'unavailable', 'refused', 'not_called')),
  constraint withdrawal_transfer_checks_note   check (note is null or char_length(note) <= 500)
);
comment on table public.withdrawal_transfer_checks is
  'PA-09: every look at a transfer''s provider state (dispatch, scheduled check, webhook) with what Paystack said and what Kolekto did. Append-only.';
create index withdrawal_transfer_checks_transfer_idx on public.withdrawal_transfer_checks (transfer_id, checked_at);

alter table public.withdrawal_transfer_checks enable row level security;
alter table public.withdrawal_transfer_checks force  row level security;
create policy withdrawal_transfer_checks_no_client_read on public.withdrawal_transfer_checks for select to authenticated using (false);
revoke all on public.withdrawal_transfer_checks from anon, authenticated;

create or replace function app.block_append_only_row_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'APPEND_ONLY: % rows are never updated or deleted', tg_table_name using errcode = 'P0001';
end;
$$;
revoke execute on function app.block_append_only_row_mutation() from public, anon, authenticated;
create trigger withdrawal_transfer_checks_append_only
  before update or delete on public.withdrawal_transfer_checks
  for each row execute function app.block_append_only_row_mutation();


-- ── 10. Claim approved withdrawals for transfer (replaces 20261118100100) ───
-- Adds the two approval conditions and the requester's-own-account check,
-- and leases the new transfer row to the dispatching worker.

drop function app.claim_withdrawal_transfers(integer);
create function app.claim_withdrawal_transfers(p_limit integer default 10, p_worker text default 'dispatch')
returns table (
  withdrawal_id uuid, withdrawal_reference text, transfer_reference text, amount_kobo bigint,
  bank_account_id uuid, recipient_code text, bank_code text, account_number text, account_name text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row    record;
  v_ref    text;
  v_token  uuid;
  v_policy public.withdrawal_transfer_check_policies;
begin
  perform app.assert_payment_operator_session();
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_LIMIT: between 1 and 100' using errcode = '22023';
  end if;
  v_policy := app.current_transfer_check_policy();

  for v_row in
    select w.id, w.reference, w.amount_kobo, w.community_id, b.id as bank_id, b.recipient_code, b.bank_code,
           b.account_number, b.account_name
    from public.withdrawals w
    join public.user_bank_accounts b on b.id = w.bank_account_id
    where w.status = 'approved'
      and not w.requires_manual_review
      -- Both approvals, independently recorded (owner decision 2026-11-19).
      and w.member_otp_verified_at is not null
      and w.approved_by is not null and w.approved_at is not null
      -- The requester's own account, still verified and past cooling-off.
      and b.user_id = w.requested_by
      and b.status = 'verified'
      and b.usable_from <= now()
      and w.release_journal_id is null
      and not exists (select 1 from public.withdrawal_transfers t where t.withdrawal_id = w.id)
    order by w.approved_at, w.id
    limit p_limit
    for update of w skip locked
  loop
    v_ref   := 'ktr_' || substr(replace(app.uuid_generate_v7()::text, '-', ''), 9, 24);
    v_token := app.uuid_generate_v7();
    insert into public.withdrawal_transfers (withdrawal_id, reference, amount_kobo, recipient_code,
                                             claimed_by, claimed_until, claim_token, next_check_at)
    values (v_row.id, v_ref, v_row.amount_kobo, v_row.recipient_code,
            left(coalesce(p_worker, 'dispatch'), 80), now() + make_interval(secs => v_policy.lease_seconds), v_token,
            now() + make_interval(secs => v_policy.lease_seconds));
    update public.withdrawals set status = 'processing', processing_at = now() where id = v_row.id;
    perform app.write_audit_log(v_row.community_id, 'system', null, 'withdrawal.processing', 'withdrawal', v_row.id,
      null, jsonb_build_object('reference', v_row.reference, 'transfer_reference', v_ref), null);

    withdrawal_id := v_row.id; withdrawal_reference := v_row.reference; transfer_reference := v_ref;
    amount_kobo := v_row.amount_kobo; bank_account_id := v_row.bank_id; recipient_code := v_row.recipient_code;
    bank_code := v_row.bank_code; account_number := v_row.account_number; account_name := v_row.account_name;
    claim_token := v_token;
    return next;
  end loop;
end;
$$;
revoke execute on function app.claim_withdrawal_transfers(integer, text) from public, anon, authenticated;


-- ── 11. Claim open transfers for a check (P8-2) ─────────────────────────────

create or replace function app.claim_withdrawal_transfers_to_check(p_worker text, p_limit integer default 20)
returns table (
  transfer_reference text, status text, transfer_code text, amount_kobo bigint, recipient_code text,
  bank_account_id uuid, check_count integer, not_found_count integer, initiate_requested_at timestamptz,
  refused_at timestamptz, refusal_code text, escalated_at timestamptz, created_at timestamptz,
  claim_token uuid, withdrawal_reference text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row    public.withdrawal_transfers%rowtype;
  v_token  uuid;
  v_policy public.withdrawal_transfer_check_policies;
  v_wref   text;
  v_bank   uuid;
begin
  perform app.assert_payment_operator_session();
  if p_worker is null or char_length(btrim(p_worker)) not between 1 and 80 then
    raise exception 'INVALID_WORKER: name the worker' using errcode = '22023';
  end if;
  v_policy := app.current_transfer_check_policy();

  for v_row in
    select t.* from public.withdrawal_transfers t
    where t.status in ('initiating', 'pending', 'otp', 'unknown')
      and coalesce(t.next_check_at, t.created_at) <= now()
      and (t.claimed_until is null or t.claimed_until < now())
    order by coalesce(t.next_check_at, t.created_at), t.id
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update of t skip locked
  loop
    v_token := app.uuid_generate_v7();
    update public.withdrawal_transfers
    set claimed_by = btrim(p_worker), claimed_until = now() + make_interval(secs => v_policy.lease_seconds), claim_token = v_token
    where id = v_row.id;
    select w.reference, w.bank_account_id into v_wref, v_bank from public.withdrawals w where w.id = v_row.withdrawal_id;

    transfer_reference := v_row.reference; status := v_row.status; transfer_code := v_row.transfer_code;
    amount_kobo := v_row.amount_kobo; recipient_code := v_row.recipient_code; bank_account_id := v_bank;
    check_count := v_row.check_count; not_found_count := v_row.not_found_count;
    initiate_requested_at := v_row.initiate_requested_at; refused_at := v_row.refused_at;
    refusal_code := v_row.refusal_code; escalated_at := v_row.escalated_at; created_at := v_row.created_at;
    claim_token := v_token; withdrawal_reference := v_wref;
    return next;
  end loop;
end;
$$;
revoke execute on function app.claim_withdrawal_transfers_to_check(text, integer) from public, anon, authenticated;


-- Committed immediately before POST /transfer. Only the holder of a live
-- claim may mark it; after this the row counts as possibly sent forever.
create or replace function app.mark_withdrawal_transfer_initiating(p_reference text, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.withdrawal_transfers%rowtype;
begin
  perform app.assert_payment_operator_session();
  select * into v_t from public.withdrawal_transfers where reference = p_reference for update;
  if v_t.id is null then
    raise exception 'UNKNOWN_TRANSFER_REFERENCE: %', p_reference using errcode = 'P0002';
  end if;
  if p_claim_token is null or v_t.claim_token is distinct from p_claim_token or v_t.claimed_until < now()
     or v_t.status not in ('initiating', 'unknown') or v_t.recipient_code is null then
    return false;
  end if;
  update public.withdrawal_transfers
  set initiate_requested_at = coalesce(v_t.initiate_requested_at, now()),
      ambiguous_since = coalesce(v_t.ambiguous_since, case when v_t.initiate_requested_at is not null then now() end)
  where id = v_t.id;
  return true;
end;
$$;
revoke execute on function app.mark_withdrawal_transfer_initiating(text, uuid) from public, anon, authenticated;


-- One record per look at the provider (P9). Updates the open state, the
-- counters and the schedule, escalates when the policy says so, logs the
-- check and releases the caller's claim. A stale claim changes nothing but
-- the log. Final outcomes are applied by settle_withdrawal_transfer first;
-- this then only logs and releases.
--
-- p_provider_result: ok | not_found | unavailable | refused | not_called
create or replace function app.record_withdrawal_transfer_check(
  p_reference            text,
  p_claim_token          uuid,
  p_source               text,
  p_worker               text,
  p_provider_result      text,
  p_provider_status      text,
  p_provider_code        text,
  p_new_status           text,
  p_recipient_code       text,
  p_transfer_code        text,
  p_provider_transfer_id text,
  p_outcome              text,
  p_note                 text,
  -- false: keep the caller's claim because it acts next (release, re-send);
  -- it then ends with app.release_withdrawal_transfer_claim or another record.
  p_release_claim        boolean default true
)
returns table (
  status text, check_count integer, not_found_count integer, next_check_at timestamptz,
  escalated boolean, resend_allowed boolean, release_eligible boolean, stale boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_t       public.withdrawal_transfers%rowtype;
  v_w       public.withdrawals%rowtype;
  v_policy  public.withdrawal_transfer_check_policies;
  v_called  boolean := p_provider_result in ('ok', 'not_found', 'unavailable', 'refused');
  v_open    boolean;
  v_count   integer;
  v_nf      integer;
  v_status  text;
  v_next    timestamptz;
  v_delay   integer;
  v_esc     text;
  v_mine    boolean;
  v_drop    boolean;
  v_since   timestamptz;
  v_refused timestamptz;
  v_rcode   text;
begin
  perform app.assert_payment_operator_session();
  if p_source not in ('dispatch', 'check', 'webhook', 'approval', 'reconciliation', 'operator') then
    raise exception 'INVALID_SOURCE: %', p_source using errcode = '22023';
  end if;
  if p_provider_result not in ('ok', 'not_found', 'unavailable', 'refused', 'not_called') then
    raise exception 'INVALID_PROVIDER_RESULT: %', p_provider_result using errcode = '22023';
  end if;
  if p_new_status is not null and p_new_status not in ('initiating', 'pending', 'otp', 'unknown') then
    raise exception 'INVALID_STATUS: only a non-final state is recorded here' using errcode = '22023';
  end if;
  if p_outcome is null or char_length(p_outcome) not between 1 and 60 then
    raise exception 'INVALID_OUTCOME: name what Kolekto did' using errcode = '22023';
  end if;

  select * into v_t from public.withdrawal_transfers where reference = p_reference for update;
  if v_t.id is null then
    raise exception 'UNKNOWN_TRANSFER_REFERENCE: %', p_reference using errcode = 'P0002';
  end if;
  v_policy := app.current_transfer_check_policy();
  v_open := v_t.status in ('initiating', 'pending', 'otp', 'unknown');

  -- A claim holder whose lease was taken over changes nothing.
  if p_claim_token is not null and v_t.claim_token is distinct from p_claim_token then
    insert into public.withdrawal_transfer_checks (transfer_id, source, worker, check_number, provider_result,
                                                   provider_status, provider_code, outcome, next_check_at, note)
    values (v_t.id, p_source, left(p_worker, 80), v_t.check_count, p_provider_result, left(p_provider_status, 40),
            left(p_provider_code, 80), 'stale_claim', v_t.next_check_at, left(p_note, 500));
    return query select v_t.status, v_t.check_count, v_t.not_found_count, v_t.next_check_at, v_t.escalated_at is not null,
                        false, false, true;
    return;
  end if;
  v_mine := p_claim_token is not null;
  v_drop := v_mine and coalesce(p_release_claim, true);

  v_count := v_t.check_count + case when v_called then 1 else 0 end;
  v_nf := case p_provider_result when 'not_found' then v_t.not_found_count + 1
                                 when 'ok' then 0 else v_t.not_found_count end;
  v_status := case when v_open then coalesce(p_new_status, v_t.status) else v_t.status end;
  v_since := case when v_status = 'unknown' then coalesce(v_t.ambiguous_since, now()) else v_t.ambiguous_since end;
  v_refused := v_t.refused_at;
  v_rcode := v_t.refusal_code;
  if p_provider_result = 'refused' and v_refused is null then
    v_refused := now();
    v_rcode := left(coalesce(nullif(btrim(p_provider_code), ''), 'refused'), 80);
  end if;

  if v_open then
    -- Backoff: the n-th check is followed by intervals[n] (capped).
    v_delay := least(coalesce(v_policy.intervals_seconds[greatest(v_count, 1)], v_policy.max_interval_seconds),
                     v_policy.max_interval_seconds);
    -- A row that was never sent and is waiting (e.g. for balance) retries on the same curve.
    v_next := now() + make_interval(secs => v_delay);

    if v_t.escalated_at is null then
      v_esc := case
        when v_status = 'otp' and now() - coalesce(v_t.initiated_at, v_t.created_at) > make_interval(secs => v_policy.escalate_otp_after_seconds)
          then 'awaiting Paystack dashboard OTP longer than the policy allows'
        when v_t.initiate_requested_at is not null
             and now() - v_t.initiate_requested_at > make_interval(secs => v_policy.escalate_after_seconds)
          then 'open longer than the policy allows; outcome not confirmed by Paystack'
        when v_count >= v_policy.max_auto_checks
          then 'automatic verification attempts exhausted'
        else null end;
    end if;

    update public.withdrawal_transfers
    set status = v_status,
        recipient_code = coalesce(v_t.recipient_code, nullif(btrim(p_recipient_code), '')),
        transfer_code = coalesce(v_t.transfer_code, nullif(btrim(p_transfer_code), '')),
        provider_transfer_id = coalesce(v_t.provider_transfer_id, nullif(btrim(p_provider_transfer_id), '')),
        failure_reason = coalesce(left(nullif(btrim(p_note), ''), 500), v_t.failure_reason),
        attempts = v_t.attempts + case when v_called then 1 else 0 end,
        initiated_at = coalesce(v_t.initiated_at, case when p_provider_result = 'ok' and v_status in ('pending', 'otp') then now() end),
        last_checked_at = case when v_called then now() else v_t.last_checked_at end,
        check_count = v_count,
        not_found_count = v_nf,
        ambiguous_since = v_since,
        refused_at = v_refused,
        refusal_code = v_rcode,
        next_check_at = case when v_mine or v_t.claim_token is null then v_next else v_t.next_check_at end,
        escalated_at = coalesce(v_t.escalated_at, case when v_esc is not null then now() end),
        escalation_reason = coalesce(v_t.escalation_reason, v_esc),
        claimed_by = case when v_drop then null else v_t.claimed_by end,
        claimed_until = case when v_drop then null else v_t.claimed_until end,
        claim_token = case when v_drop then null else v_t.claim_token end
    where id = v_t.id;

    if v_esc is not null then
      select * into v_w from public.withdrawals where id = v_t.withdrawal_id;
      perform app.write_audit_log(v_w.community_id, 'system', null, 'withdrawal.transfer_escalated', 'withdrawal', v_w.id,
        null, jsonb_build_object('reference', v_w.reference, 'transfer_reference', v_t.reference, 'status', v_status,
                                 'check_count', v_count, 'not_found_count', v_nf),
        v_esc || '. Funds stay reserved; manual reconciliation required.');
    end if;
  else
    v_next := null;
    update public.withdrawal_transfers
    set check_count = v_count,
        last_checked_at = case when v_called then now() else v_t.last_checked_at end,
        next_check_at = null,
        claimed_by = case when v_drop then null else v_t.claimed_by end,
        claimed_until = case when v_drop then null else v_t.claimed_until end,
        claim_token = case when v_drop then null else v_t.claim_token end
    where id = v_t.id;
  end if;

  insert into public.withdrawal_transfer_checks (transfer_id, source, worker, check_number, provider_result,
                                                 provider_status, provider_code, outcome, next_check_at, note)
  values (v_t.id, p_source, left(p_worker, 80), v_count, p_provider_result, left(p_provider_status, 40),
          left(p_provider_code, 80), p_outcome, v_next, left(p_note, 500));

  return query select
    v_status, v_count, v_nf, v_next,
    (v_t.escalated_at is not null or v_esc is not null),
    -- Same reference again, only after repeated NOT FOUND, never after a refusal
    -- other than a transient one, never once Paystack asked for approval.
    (v_open and v_status in ('initiating', 'unknown') and v_nf >= v_policy.resend_after_not_found
       and v_t.provider_approved_at is null and v_t.transfer_code is null
       and v_t.escalated_at is null and v_esc is null
       and (v_rcode is null or v_rcode in ('insufficient_balance', 'http_429'))),
    app.transfer_release_eligible(v_t.id),
    false;
end;
$$;


-- P8-1: the only way a hold is released without Paystack confirming a
-- failure. Eligibility is decided here, not by the worker.
create or replace function app.transfer_release_eligible(p_transfer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with p as (select * from app.current_transfer_check_policy())
  select coalesce((
    select t.status in ('initiating', 'unknown', 'pending')
       and t.transfer_code is null
       and t.provider_approved_at is null
       and (
         -- (a) provably never sent
         t.initiate_requested_at is null
         -- (b) refused synchronously (not as a duplicate), then NOT FOUND
         --     repeatedly over at least the minimum window
         or (t.refused_at is not null
             and t.refusal_code not in ('duplicate_transfer_reference', 'insufficient_balance', 'http_429')
             and t.not_found_count >= p.refused_release_min_not_found
             and now() - t.refused_at >= make_interval(secs => p.refused_release_min_age_seconds)))
    from public.withdrawal_transfers t, p where t.id = p_transfer_id), false);
$$;
revoke execute on function app.transfer_release_eligible(uuid) from public, anon, authenticated;
revoke execute on function app.record_withdrawal_transfer_check(text, uuid, text, text, text, text, text, text, text, text, text, text, text, boolean)
  from public, anon, authenticated;

-- Ends a claim kept with p_release_claim => false. A stale token does nothing.
create or replace function app.release_withdrawal_transfer_claim(p_reference text, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_payment_operator_session();
  update public.withdrawal_transfers
  set claimed_by = null, claimed_until = null, claim_token = null
  where reference = p_reference and claim_token = p_claim_token;
  return found;
end;
$$;
revoke execute on function app.release_withdrawal_transfer_claim(text, uuid) from public, anon, authenticated;


create or replace function app.release_withdrawal_transfer_never_sent(p_reference text, p_claim_token uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.withdrawal_transfers%rowtype;
begin
  perform app.assert_payment_operator_session();
  select * into v_t from public.withdrawal_transfers where reference = p_reference for update;
  if v_t.id is null then
    raise exception 'UNKNOWN_TRANSFER_REFERENCE: %', p_reference using errcode = 'P0002';
  end if;
  if p_claim_token is null or v_t.claim_token is distinct from p_claim_token then
    return 'stale_claim';
  end if;
  if not app.transfer_release_eligible(v_t.id) then
    return 'not_eligible';
  end if;
  return app.settle_withdrawal_transfer(
    p_reference, 'failed', null, null, null,
    left(coalesce(nullif(btrim(p_reason), ''),
      case when v_t.initiate_requested_at is null then 'The transfer was never sent to Paystack. Nothing was paid; the amount is available again.'
           else 'Paystack refused the transfer and has no record of it after repeated checks. Nothing was paid; the amount is available again.' end), 500),
    null);
end;
$$;
revoke execute on function app.release_withdrawal_transfer_never_sent(text, uuid, text) from public, anon, authenticated;


-- ── 12. Paystack server approval (approval URL) ─────────────────────────────

create table public.withdrawal_transfer_approval_requests (
  id                   uuid primary key default app.uuid_generate_v7(),
  received_at          timestamptz not null default now(),
  reference            text,
  transfer_id          uuid references public.withdrawal_transfers (id) on delete restrict,
  decision             text not null,
  reason_code          text not null,
  provider_amount_kobo bigint,
  provider_recipient   text,
  signature            text not null,
  constraint transfer_approval_decision  check (decision in ('approve', 'reject')),
  constraint transfer_approval_signature check (signature in ('valid', 'absent')),
  constraint transfer_approval_reference check (reference is null or char_length(reference) <= 100),
  constraint transfer_approval_recipient check (provider_recipient is null or char_length(provider_recipient) <= 60),
  constraint transfer_approval_reason    check (char_length(reason_code) between 1 and 60)
);
comment on table public.withdrawal_transfer_approval_requests is
  'Every Paystack approval-URL request and Kolekto''s answer (200 approve / 400 reject). Approval is not payment: only a verified provider success settles a withdrawal. Append-only.';
create index transfer_approval_reference_idx on public.withdrawal_transfer_approval_requests (reference, received_at);

alter table public.withdrawal_transfer_approval_requests enable row level security;
alter table public.withdrawal_transfer_approval_requests force  row level security;
create policy transfer_approval_no_client_read on public.withdrawal_transfer_approval_requests for select to authenticated using (false);
revoke all on public.withdrawal_transfer_approval_requests from anon, authenticated;
create trigger withdrawal_transfer_approval_requests_append_only
  before update or delete on public.withdrawal_transfer_approval_requests
  for each row execute function app.block_append_only_row_mutation();


-- Approve only a transfer that matches a fully authorised, reserved
-- withdrawal. Every reason to say no is checked; the first that applies is
-- recorded. Deterministic: a duplicate request gets the same answer while
-- nothing has changed.
create or replace function app.decide_transfer_approval(
  p_reference      text,
  p_amount_kobo    bigint,
  p_recipient_code text,
  p_signature      text
)
returns table (decision text, reason_code text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_t      public.withdrawal_transfers%rowtype;
  v_w      public.withdrawals%rowtype;
  v_b      public.user_bank_accounts%rowtype;
  v_comm   uuid;
  v_reason text;
  v_wd_bal bigint;
  v_dec    text;
begin
  perform app.assert_payment_operator_session();
  if p_signature not in ('valid', 'absent') then
    raise exception 'INVALID_SIGNATURE_STATE: valid or absent' using errcode = '22023';
  end if;

  if p_reference is not null and char_length(p_reference) <= 100 then
    select * into v_t from public.withdrawal_transfers where reference = p_reference for update;
  end if;

  if v_t.id is null then
    v_reason := 'unknown_reference';
  else
    select * into v_w from public.withdrawals where id = v_t.withdrawal_id for share;
    select * into v_b from public.user_bank_accounts where id = v_w.bank_account_id;
    select c.community_id into v_comm from public.collections c where c.id = v_w.collection_id;
    v_wd_bal := app.ledger_account_balance(
      app.ensure_ledger_account(v_w.community_id, v_w.collection_id, 'collection_withdrawing'));

    v_reason := case
      when v_t.status not in ('initiating', 'pending', 'otp', 'unknown') then 'transfer_already_final'
      when v_w.status <> 'processing' then 'withdrawal_not_processing'
      when p_amount_kobo is null or p_amount_kobo <> v_t.amount_kobo or v_t.amount_kobo <> v_w.amount_kobo then 'amount_mismatch'
      when p_recipient_code is null or v_t.recipient_code is null or btrim(p_recipient_code) <> v_t.recipient_code then 'recipient_mismatch'
      when v_b.id is null or v_b.recipient_code is distinct from v_t.recipient_code then 'recipient_not_selected_account'
      when v_b.user_id <> v_w.requested_by then 'account_not_requesters'
      when v_b.status <> 'verified' or v_b.usable_from > now() then 'account_not_verified'
      when v_comm is distinct from v_w.community_id then 'collection_community_mismatch'
      when v_w.member_otp_verified_at is null
           or not exists (select 1 from public.withdrawal_otp_challenges c
                          where c.id = v_w.member_otp_challenge_id and c.withdrawal_id = v_w.id
                            and c.user_id = v_w.requested_by and c.status = 'verified') then 'member_not_verified'
      when v_w.approved_by is null or v_w.approved_at is null then 'owner_not_approved'
      when not exists (select 1 from public.officer_terms ot
                       where ot.community_id = v_w.community_id and ot.user_id = v_w.approved_by and ot.role = 'owner'
                         and ot.started_at <= v_w.approved_at
                         and (ot.ended_at is null or ot.ended_at > v_w.approved_at)) then 'approver_not_owner'
      when v_w.requires_manual_review then 'manual_review_required'
      when v_w.hold_journal_id is null or v_w.release_journal_id is not null
           or exists (select 1 from public.ledger_journals j where j.reverses_journal_id = v_w.hold_journal_id)
           or v_wd_bal < v_w.amount_kobo + v_w.fee_kobo then 'funds_not_reserved'
      else null end;
  end if;

  v_dec := case when v_reason is null then 'approve' else 'reject' end;

  insert into public.withdrawal_transfer_approval_requests (reference, transfer_id, decision, reason_code,
                                                            provider_amount_kobo, provider_recipient, signature)
  values (left(p_reference, 100), v_t.id, v_dec, coalesce(v_reason, 'authorised'), p_amount_kobo,
          left(p_recipient_code, 60), p_signature);

  if v_t.id is not null then
    update public.withdrawal_transfers
    set provider_approval_count = v_t.provider_approval_count + 1,
        provider_approved_at = case when v_dec = 'approve' then coalesce(v_t.provider_approved_at, now()) else v_t.provider_approved_at end
    where id = v_t.id;
    if v_dec = 'reject' or v_t.provider_approved_at is null then
      perform app.write_audit_log(v_w.community_id, 'system', null,
        case when v_dec = 'approve' then 'withdrawal.transfer_approved_by_kolekto' else 'withdrawal.transfer_approval_refused' end,
        'withdrawal', v_w.id, null,
        jsonb_build_object('reference', v_w.reference, 'transfer_reference', v_t.reference,
                           'reason', coalesce(v_reason, 'authorised'), 'signature', p_signature), null);
    end if;
  end if;

  return query select v_dec, coalesce(v_reason, 'authorised');
end;
$$;
revoke execute on function app.decide_transfer_approval(text, bigint, text, text) from public, anon, authenticated;

comment on function app.decide_transfer_approval(text, bigint, text, text) is
  'Paystack server approval (owner decision 2026-11-19): approve (HTTP 200) only when the reference is a Kolekto transfer still open, the amount and recipient match, the destination is the requester''s own verified account, the member''s code was verified, a community owner approved, the withdrawal is not under manual review and its funds are still reserved. Otherwise reject (HTTP 400). Logged per request.';


-- ── 13. Transfer reconciliation report (P8-4) ───────────────────────────────

create table public.transfer_reconciliation_runs (
  id                 uuid primary key default app.uuid_generate_v7(),
  started_at         timestamptz not null,
  finished_at        timestamptz not null default now(),
  window_from        timestamptz not null,
  window_to          timestamptz not null,
  provider_mode      text not null,
  provider_count     integer not null,
  kolekto_count      integer not null,
  discrepancy_count  integer not null,
  constraint transfer_recon_mode check (provider_mode in ('test', 'live', 'fake')),
  constraint transfer_recon_window check (window_from <= window_to),
  constraint transfer_recon_counts check (provider_count >= 0 and kolekto_count >= 0 and discrepancy_count >= 0)
);
comment on table public.transfer_reconciliation_runs is
  'P8-4: one read-only comparison of Kolekto''s transfer records with Paystack''s transfer list. It never initiates a transfer and never changes a balance.';

create table public.transfer_reconciliation_discrepancies (
  id                uuid primary key default app.uuid_generate_v7(),
  run_id            uuid not null references public.transfer_reconciliation_runs (id) on delete restrict,
  kind              text not null,
  severity          text not null,
  reference         text,
  transfer_id       uuid references public.withdrawal_transfers (id) on delete restrict,
  kolekto_detail    text,
  provider_detail   text,
  resolution_status text not null default 'open',
  resolved_by       text,
  resolved_at       timestamptz,
  resolution_note   text,
  created_at        timestamptz not null default now(),
  constraint transfer_recon_kind check (kind in (
    'missing_at_provider', 'missing_in_kolekto', 'foreign_reference', 'amount_mismatch', 'reference_mismatch',
    'recipient_mismatch', 'status_mismatch', 'stale_open', 'duplicate_provider_record', 'duplicate_approval_requests',
    'success_not_in_ledger')),
  constraint transfer_recon_severity check (severity in ('critical', 'warning', 'info')),
  constraint transfer_recon_resolution check (resolution_status in ('open', 'acknowledged', 'resolved')),
  constraint transfer_recon_resolved_shape check ((resolution_status = 'open') = (resolved_at is null)),
  constraint transfer_recon_details check ((kolekto_detail is null or char_length(kolekto_detail) <= 500)
                                           and (provider_detail is null or char_length(provider_detail) <= 500)
                                           and (reference is null or char_length(reference) <= 100))
);
create index transfer_recon_open_idx on public.transfer_reconciliation_discrepancies (created_at) where resolution_status = 'open';

alter table public.transfer_reconciliation_runs enable row level security;
alter table public.transfer_reconciliation_runs force  row level security;
create policy transfer_recon_runs_no_client_read on public.transfer_reconciliation_runs for select to authenticated using (false);
revoke all on public.transfer_reconciliation_runs from anon, authenticated;
alter table public.transfer_reconciliation_discrepancies enable row level security;
alter table public.transfer_reconciliation_discrepancies force  row level security;
create policy transfer_recon_disc_no_client_read on public.transfer_reconciliation_discrepancies for select to authenticated using (false);
revoke all on public.transfer_reconciliation_discrepancies from anon, authenticated;

create trigger transfer_reconciliation_runs_append_only
  before update or delete on public.transfer_reconciliation_runs
  for each row execute function app.block_append_only_row_mutation();

create or replace function app.guard_transfer_reconciliation_discrepancy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'APPEND_ONLY: discrepancies are resolved, never deleted' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id or new.run_id is distinct from old.run_id or new.kind is distinct from old.kind
     or new.severity is distinct from old.severity or new.reference is distinct from old.reference
     or new.transfer_id is distinct from old.transfer_id or new.kolekto_detail is distinct from old.kolekto_detail
     or new.provider_detail is distinct from old.provider_detail or new.created_at is distinct from old.created_at then
    raise exception 'DISCREPANCY_FACTS_IMMUTABLE: only the resolution changes' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function app.guard_transfer_reconciliation_discrepancy() from public, anon, authenticated;
create trigger transfer_reconciliation_discrepancies_guard
  before update or delete on public.transfer_reconciliation_discrepancies
  for each row execute function app.guard_transfer_reconciliation_discrepancy();


-- Kolekto's side of the comparison: every transfer created in the window,
-- plus every transfer still open whatever its age.
create or replace function app.transfer_reconciliation_kolekto_rows(p_from timestamptz, p_to timestamptz)
returns table (
  transfer_id uuid, reference text, transfer_code text, amount_kobo bigint, recipient_code text, status text,
  withdrawal_status text, withdrawal_amount_kobo bigint, payout_journal boolean, initiate_requested_at timestamptz,
  created_at timestamptz, updated_at timestamptz, escalated boolean, approval_requests integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_payment_operator_session();
  return query
  select t.id, t.reference, t.transfer_code, t.amount_kobo::bigint, t.recipient_code, t.status, w.status::text,
         w.amount_kobo::bigint, w.payout_journal_id is not null, t.initiate_requested_at, t.created_at, t.updated_at,
         t.escalated_at is not null,
         (select count(*)::integer from public.withdrawal_transfer_approval_requests a where a.transfer_id = t.id)
  from public.withdrawal_transfers t
  join public.withdrawals w on w.id = t.withdrawal_id
  where (t.created_at between p_from and p_to) or t.status in ('initiating', 'pending', 'otp', 'unknown')
  order by t.created_at;
end;
$$;
revoke execute on function app.transfer_reconciliation_kolekto_rows(timestamptz, timestamptz) from public, anon, authenticated;

-- Stores one run and its discrepancies atomically. Writes nothing else.
create or replace function app.record_transfer_reconciliation_run(p_run jsonb, p_discrepancies jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := app.uuid_generate_v7();
begin
  perform app.assert_payment_operator_session();
  if jsonb_typeof(p_discrepancies) <> 'array' then
    raise exception 'INVALID_DISCREPANCIES: an array is required' using errcode = '22023';
  end if;
  insert into public.transfer_reconciliation_runs (id, started_at, window_from, window_to, provider_mode,
                                                   provider_count, kolekto_count, discrepancy_count)
  values (v_id, (p_run ->> 'started_at')::timestamptz, (p_run ->> 'window_from')::timestamptz,
          (p_run ->> 'window_to')::timestamptz, p_run ->> 'provider_mode',
          (p_run ->> 'provider_count')::integer, (p_run ->> 'kolekto_count')::integer,
          jsonb_array_length(p_discrepancies));
  insert into public.transfer_reconciliation_discrepancies (run_id, kind, severity, reference, transfer_id,
                                                            kolekto_detail, provider_detail)
  select v_id, d ->> 'kind', d ->> 'severity', left(d ->> 'reference', 100),
         (select t.id from public.withdrawal_transfers t where t.reference = d ->> 'reference'),
         left(d ->> 'kolekto_detail', 500), left(d ->> 'provider_detail', 500)
  from jsonb_array_elements(p_discrepancies) d;
  return v_id;
end;
$$;
revoke execute on function app.record_transfer_reconciliation_run(jsonb, jsonb) from public, anon, authenticated;

create or replace function app.resolve_transfer_reconciliation_discrepancy(
  p_id uuid, p_status text, p_resolved_by text, p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d public.transfer_reconciliation_discrepancies%rowtype;
begin
  perform app.assert_payment_operator_session();
  if p_status not in ('acknowledged', 'resolved') then
    raise exception 'INVALID_RESOLUTION: acknowledged or resolved' using errcode = '22023';
  end if;
  if p_resolved_by is null or char_length(btrim(p_resolved_by)) not between 2 and 120
     or p_note is null or char_length(btrim(p_note)) not between 3 and 500 then
    raise exception 'INVALID_REASON: name the operator and say why' using errcode = '22023';
  end if;
  select * into v_d from public.transfer_reconciliation_discrepancies where id = p_id for update;
  if v_d.id is null then
    raise exception 'NOT_FOUND: discrepancy % does not exist', p_id using errcode = 'P0002';
  end if;
  update public.transfer_reconciliation_discrepancies
  set resolution_status = p_status, resolved_by = btrim(p_resolved_by), resolved_at = now(), resolution_note = btrim(p_note)
  where id = p_id;
  perform app.write_audit_log(null, 'system', null, 'transfer_reconciliation.resolve', 'transfer_reconciliation_discrepancy', p_id,
    jsonb_build_object('resolution_status', v_d.resolution_status),
    jsonb_build_object('resolution_status', p_status, 'kind', v_d.kind, 'reference', v_d.reference, 'by', btrim(p_resolved_by)),
    btrim(p_note));
end;
$$;
revoke execute on function app.resolve_transfer_reconciliation_discrepancy(uuid, text, text, text) from public, anon, authenticated;


-- Operator: transfers that need a person (escalated, or open past policy).
create or replace function app.withdrawal_transfers_needing_attention()
returns table (
  transfer_reference text, withdrawal_reference text, status text, amount_kobo bigint, check_count integer,
  not_found_count integer, escalated_at timestamptz, escalation_reason text, initiate_requested_at timestamptz,
  last_checked_at timestamptz, next_check_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.assert_payment_operator_session();
  return query
  select t.reference, w.reference, t.status, t.amount_kobo::bigint, t.check_count, t.not_found_count, t.escalated_at,
         t.escalation_reason, t.initiate_requested_at, t.last_checked_at, t.next_check_at
  from public.withdrawal_transfers t join public.withdrawals w on w.id = t.withdrawal_id
  where t.status in ('initiating', 'pending', 'otp', 'unknown') and t.escalated_at is not null
  order by t.escalated_at;
end;
$$;
revoke execute on function app.withdrawal_transfers_needing_attention() from public, anon, authenticated;


-- ── 14. Read: a collection's withdrawals (replaces 20261118100100) ──────────
-- Adds the two-approval stage and what the owner needs to review a request.
-- can_decide (approve) only once the member has verified; can_reject while
-- requested. Only the last four digits of an account ever leave.

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
  reversed_at timestamptz, reversal_reason text,
  stage text, member_verified_at timestamptz, is_mine boolean, can_reject boolean,
  approved_by_name text, owner_self_approved boolean, available_before_kobo bigint,
  account_status text, account_cooling_off boolean, transfer_escalated boolean
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
  v_uid        uuid := auth.uid();
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
         (v_owner and w.status = 'requested' and (w.bank_account_id is null or w.member_otp_verified_at is not null)),
         (w.status in ('requested', 'approved') and (v_requester or w.requested_by = v_uid)),
         case when t.id is not null then 'paystack_transfer' else 'manual' end,
         t.reference, t.status, w.reversed_at, w.reversal_reason,
         app.withdrawal_stage(w), w.member_otp_verified_at, w.requested_by = v_uid,
         (v_owner and w.status = 'requested'),
         ap.full_name, w.owner_self_approved, w.available_before_kobo,
         b.status, coalesce(b.usable_from > now(), false), t.escalated_at is not null
  from public.withdrawals w
  left join public.users u on u.id = w.requested_by
  left join public.users ap on ap.id = w.approved_by
  left join public.user_bank_accounts b on b.id = w.bank_account_id
  left join public.withdrawal_transfers t on t.withdrawal_id = w.id
  where w.collection_id = p_collection_id
  order by w.requested_at desc;
end;
$$;
revoke all on function app.collection_withdrawals(uuid) from public;
grant execute on function app.collection_withdrawals(uuid) to authenticated;
