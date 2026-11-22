-- ─────────────────────────────────────────────────────────────────────────────
-- 20261117100200 — Withdrawals: the ledger and database lifecycle
--
-- Design: docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md §4
-- Owner decision 2026-11-17: build the ledger + database lifecycle; payouts
-- are executed by operations (a bank transfer, as production does today) and
-- recorded here. No Paystack Transfers, no saved bank-account screen yet.
--
-- LIFECYCLE
--   requested ──approve (owner)──► approved ──operator──► processing ──► paid
--       │                            │                        │
--       ├─reject (owner)─► rejected  ├─cancel─► cancelled     └──► failed
--       └─cancel─► cancelled         └─operator fail─► failed
--   A request by an owner is approved as it is made (D-06: owner approval).
--
-- MONEY (all journals balanced, collection-attributed, unique keys)
--   request   withdrawal   Dr collection_available   Cr collection_withdrawing   amount+fee
--   paid      payout       Dr collection_withdrawing  Cr collection_withdrawn     amount
--                          Dr collection_withdrawing  Cr platform_fee_income     fee (if any)
--                          Dr organiser_payouts       Cr provider_settled_funds  amount
--   rejected / cancelled / failed
--             reversal     Dr collection_withdrawing  Cr collection_available   amount+fee
--                          (reverses_journal_id = the hold)
--   So a failed payout never counts as withdrawn and its hold is released.
--
-- CHECKS AT REQUEST, all in the database, in one transaction:
--   · withdrawal.request on the collection; requester identity_verified (PRD
--     10.1 — DEC-04 checks are not built, so in practice nobody passes until
--     they are; tests set the level directly);
--   · the collection's collection_available account row is locked FOR UPDATE,
--     then the balance is summed from ledger_entries (never a view, never a
--     column): two concurrent requests serialise and the second sees the
--     first's hold;
--   · D-04: first withdrawal of a collection is free; a later one needs a
--     withdrawal fee schedule (O-2 OPEN, none exists) — refused until then;
--   · D-07: unverified communities ₦1,000,000 per Lagos calendar day, across
--     the community, serialised by an advisory lock;
--   · D-06: > ₦1,000,000 is flagged requires_manual_review (the "security
--     checks" and "manual review" of D-06 are O-3 OPEN; operations reviews).
--
-- Destination: the requester types the account (name, 10-digit NUBAN, bank).
-- D-08's 48-hour cooling-off belongs to a saved withdrawal account, which
-- does not exist yet; owner approval of every non-owner request is the control
-- meanwhile. Flagged in the design doc.
--
-- Additive. Rollback: drop the functions below, drop table public.withdrawals,
-- drop type public.withdrawal_status. Journals already posted stay.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. A journal writer that records who acted ──────────────────────────────
-- app.post_payment_journal always records the system actor; withdrawals are
-- officer actions. Same single-statement shape (journal and entries together).

create or replace function app.post_ledger_journal(
  p_community_id   uuid,
  p_collection_id  uuid,
  p_occurred_at    timestamptz,
  p_source_type    public.ledger_source_type,
  p_source_id      uuid,
  p_reason         text,
  p_idempotency    text,
  p_entries        jsonb,
  p_actor_type     public.audit_actor_type,
  p_actor_user_id  uuid,
  p_reverses       uuid default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  with j as (
    insert into public.ledger_journals (community_id, collection_id, occurred_at, source_type, source_id, reason,
                                        actor_type, actor_user_id, actor_name_snapshot, idempotency_key,
                                        reverses_journal_id)
    values (p_community_id, p_collection_id, p_occurred_at, p_source_type, p_source_id, p_reason,
            p_actor_type, p_actor_user_id,
            coalesce((select u.full_name from public.users u where u.id = p_actor_user_id), 'Kolekto operations'),
            p_idempotency, p_reverses)
    returning id
  ), e as (
    insert into public.ledger_entries (journal_id, account_id, direction, amount_kobo)
    select j.id, (x ->> 'account_id')::uuid, (x ->> 'direction')::public.ledger_direction, (x ->> 'amount_kobo')::bigint
    from j cross join jsonb_array_elements(p_entries) x
    where (x ->> 'amount_kobo')::bigint > 0
    returning 1
  )
  select j.id from j;
$$;
revoke execute on function app.post_ledger_journal(
  uuid, uuid, timestamptz, public.ledger_source_type, uuid, text, text, jsonb, public.audit_actor_type, uuid, uuid
) from public, anon, authenticated;

-- A collection-scope account's natural balance, summed from entries. The
-- caller locks first when it authorises money.
create or replace function app.ledger_account_balance(p_account_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case
           when a.type in ('asset', 'expense') then case when e.direction = 'debit' then e.amount_kobo else -e.amount_kobo end
           else case when e.direction = 'credit' then e.amount_kobo else -e.amount_kobo end
         end), 0)::bigint
  from public.ledger_accounts a
  left join public.ledger_entries e on e.account_id = a.id
  where a.id = p_account_id;
$$;
revoke execute on function app.ledger_account_balance(uuid) from public, anon, authenticated;


-- ── 2. The withdrawal record ────────────────────────────────────────────────

create type public.withdrawal_status as enum (
  'requested', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled'
);

create table public.withdrawals (
  id                         uuid primary key default app.uuid_generate_v7(),
  community_id               uuid not null references public.communities (id) on delete restrict,
  collection_id              uuid not null references public.collections (id) on delete restrict,
  reference                  text not null,

  amount_kobo                app.kobo not null,
  fee_kobo                   app.kobo not null default 0,
  withdrawal_fee_version     text references public.withdrawal_fee_schedules (version) on delete restrict,
  is_first                   boolean not null,
  requires_manual_review     boolean not null,

  status                     public.withdrawal_status not null default 'requested',

  destination_account_name   text not null,
  destination_account_number text not null,
  destination_bank_name      text not null,

  requested_by               uuid not null references public.users (id) on delete restrict,
  requested_at               timestamptz not null default now(),
  idempotency_key            text not null,

  approved_by                uuid references public.users (id) on delete restrict,
  approved_at                timestamptz,
  decided_by                 uuid references public.users (id) on delete restrict,  -- rejected / cancelled by
  decided_at                 timestamptz,
  decision_reason            text,
  processing_at              timestamptz,
  paid_at                    timestamptz,
  payout_reference           text,
  failed_at                  timestamptz,
  failure_reason             text,

  hold_journal_id            uuid references public.ledger_journals (id) on delete restrict,
  payout_journal_id          uuid references public.ledger_journals (id) on delete restrict,
  release_journal_id         uuid references public.ledger_journals (id) on delete restrict,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint withdrawals_amount_positive     check (amount_kobo > 0),
  constraint withdrawals_fee_not_negative    check (fee_kobo >= 0),
  constraint withdrawals_first_is_free       check (not is_first or fee_kobo = 0),
  constraint withdrawals_reference_format    check (reference ~ '^KWD-[0-9A-F]{16}$'),
  constraint withdrawals_account_number      check (destination_account_number ~ '^[0-9]{10}$'),
  constraint withdrawals_account_name        check (char_length(btrim(destination_account_name)) between 2 and 120),
  constraint withdrawals_bank_name           check (char_length(btrim(destination_bank_name)) between 2 and 80),
  constraint withdrawals_idempotency_key     check (char_length(idempotency_key) between 8 and 120),
  constraint withdrawals_paid_shape          check ((status = 'paid') = (paid_at is not null and payout_journal_id is not null)),
  constraint withdrawals_failed_shape        check ((status = 'failed') = (failed_at is not null)),
  constraint withdrawals_released_shape
    check ((status in ('failed', 'rejected', 'cancelled')) = (release_journal_id is not null))
);

comment on table public.withdrawals is
  'D-03: a withdrawal is from one collection. Its money is the ledger: a hold journal at request, a payout journal when paid, a reversal when it ends any other way. This row is the workflow and the evidence; a balance is never read from it.';

create unique index withdrawals_reference_key   on public.withdrawals (reference);
create unique index withdrawals_idempotency_key on public.withdrawals (collection_id, requested_by, idempotency_key);
create index withdrawals_collection_idx on public.withdrawals (collection_id, requested_at desc);
create index withdrawals_community_day_idx on public.withdrawals (community_id, requested_at);
create index withdrawals_open_idx on public.withdrawals (status) where status in ('requested', 'approved', 'processing');

alter table public.withdrawals enable row level security;
alter table public.withdrawals force  row level security;
create policy withdrawals_no_client_read on public.withdrawals for select to authenticated using (false);
revoke all on public.withdrawals from anon, authenticated;

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
     or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at
     or new.hold_journal_id is distinct from old.hold_journal_id then
    raise exception 'WITHDRAWAL_FACTS_IMMUTABLE: amount, destination and requester never change' using errcode = 'P0001';
  end if;
  if old.status <> new.status and not (
       (old.status = 'requested'  and new.status in ('approved', 'rejected', 'cancelled'))
    or (old.status = 'approved'   and new.status in ('processing', 'cancelled', 'failed'))
    or (old.status = 'processing' and new.status in ('paid', 'failed'))) then
    raise exception 'WITHDRAWAL_INVALID_TRANSITION: % → %', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status in ('paid', 'failed', 'rejected', 'cancelled') then
    raise exception 'WITHDRAWAL_FINAL: withdrawal % is %', old.reference, old.status using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_withdrawal() from public, anon, authenticated;

create trigger withdrawals_guard
  before update or delete on public.withdrawals
  for each row execute function app.guard_withdrawal();


-- ── 3. Helpers ──────────────────────────────────────────────────────────────

create or replace function app.is_community_owner(p_community_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.officer_terms ot
    where ot.community_id = p_community_id and ot.user_id = auth.uid()
      and ot.role = 'owner' and ot.ended_at is null and ot.started_at <= now());
$$;
revoke execute on function app.is_community_owner(uuid) from public, anon, authenticated;

-- Release a hold back to available (reject / cancel / fail). One reversal per
-- withdrawal (unique key), pointing at the hold it reverses.
create or replace function app.release_withdrawal_hold(
  p_withdrawal   public.withdrawals,
  p_actor_type   public.audit_actor_type,
  p_actor        uuid,
  p_why          text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_avail uuid;
  v_wd    uuid;
begin
  v_avail := app.ensure_ledger_account(p_withdrawal.community_id, p_withdrawal.collection_id, 'collection_available');
  v_wd    := app.ensure_ledger_account(p_withdrawal.community_id, p_withdrawal.collection_id, 'collection_withdrawing');
  return app.post_ledger_journal(
    p_withdrawal.community_id, p_withdrawal.collection_id, now(), 'reversal', p_withdrawal.id,
    'Withdrawal ' || p_withdrawal.reference || ' ' || p_why || ': hold released',
    'withdrawal_release:' || p_withdrawal.id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_wd,    'direction', 'debit',  'amount_kobo', p_withdrawal.amount_kobo + p_withdrawal.fee_kobo),
      jsonb_build_object('account_id', v_avail, 'direction', 'credit', 'amount_kobo', p_withdrawal.amount_kobo + p_withdrawal.fee_kobo)),
    p_actor_type, p_actor, p_withdrawal.hold_journal_id);
end;
$$;
revoke execute on function app.release_withdrawal_hold(public.withdrawals, public.audit_actor_type, uuid, text)
  from public, anon, authenticated;


-- ── 4. Request ──────────────────────────────────────────────────────────────

create or replace function app.request_withdrawal(
  p_collection_id   uuid,
  p_amount_kobo     bigint,
  p_account_name    text,
  p_account_number  text,
  p_bank_name       text,
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
  v_avail_acct uuid;
  v_wd_acct    uuid;
  v_available  bigint;
  v_first      boolean;
  v_fee        bigint := 0;
  v_fee_ver    text;
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

  -- A repeated submission returns the first one, whatever its state now.
  select * into v_existing from public.withdrawals w
  where w.collection_id = p_collection_id and w.requested_by = v_uid and w.idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.reference, v_existing.status, v_existing.fee_kobo::bigint, true;
    return;
  end if;

  if not exists (select 1 from public.users u where u.id = v_uid and u.status = 'active'
                 and u.identity_level = 'identity_verified') then
    raise exception 'IDENTITY_VERIFICATION_REQUIRED: withdrawals need an identity-verified officer (PRD 10.1)'
      using errcode = 'P0001';
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'INVALID_AMOUNT: a withdrawal must be more than zero' using errcode = '22023';
  end if;
  if p_account_number is null or btrim(p_account_number) !~ '^[0-9]{10}$' then
    raise exception 'INVALID_ACCOUNT_NUMBER: a 10-digit account number is required' using errcode = '22023';
  end if;
  if p_account_name is null or char_length(btrim(p_account_name)) not between 2 and 120 then
    raise exception 'INVALID_ACCOUNT_NAME: the account name is required' using errcode = '22023';
  end if;
  if p_bank_name is null or char_length(btrim(p_bank_name)) not between 2 and 80 then
    raise exception 'INVALID_BANK: the bank is required' using errcode = '22023';
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
    where w.collection_id = p_collection_id and w.status in ('requested', 'approved', 'processing', 'paid'))
  into v_first;

  if not v_first then
    select s.version into v_fee_ver from public.withdrawal_fee_schedules s
    where s.effective_from <= v_today order by s.effective_from desc limit 1;
    select b.fee_kobo into v_fee from public.withdrawal_fee_brackets b
    where b.schedule_version = v_fee_ver
      and b.min_amount_kobo <= p_amount_kobo
      and (b.max_amount_kobo is null or p_amount_kobo < b.max_amount_kobo);
    if v_fee_ver is null or v_fee is null then
      raise exception 'WITHDRAWAL_FEE_NOT_CONFIGURED: only the first withdrawal of a collection is free, and no withdrawal fee schedule exists yet (O-2)'
        using errcode = 'P0001';
    end if;
  end if;

  if p_amount_kobo + v_fee > v_available then
    raise exception 'INSUFFICIENT_AVAILABLE_BALANCE: % kobo available, % kobo requested (including a % kobo fee)',
      v_available, p_amount_kobo + v_fee, v_fee
      using errcode = 'P0001';
  end if;

  select * into v_community from public.communities where id = v_collection.community_id;
  if v_community.verification_status is distinct from 'verified' then
    select coalesce(sum(w.amount_kobo), 0) into v_today_sum
    from public.withdrawals w
    where w.community_id = v_collection.community_id
      and (w.requested_at at time zone 'Africa/Lagos')::date = v_today
      and w.status in ('requested', 'approved', 'processing', 'paid');
    if v_today_sum + p_amount_kobo > c_daily_limit then
      raise exception 'DAILY_WITHDRAWAL_LIMIT: unverified communities may withdraw up to ₦1,000,000 per day; % kobo already requested today',
        v_today_sum using errcode = 'P0001';
    end if;
  end if;

  v_ref   := 'KWD-' || upper(substr(md5(v_id::text || clock_timestamp()::text), 1, 16));
  v_owner := app.is_community_owner(v_collection.community_id);
  v_status := case when v_owner then 'approved' else 'requested' end;

  -- The hold first (its source_id is the id the row is about to take), so the
  -- row is born naming its hold and the guard never has to allow setting it.
  v_journal := app.post_ledger_journal(
    v_collection.community_id, p_collection_id, now(), 'withdrawal', v_id,
    'Withdrawal ' || v_ref || ' requested: funds held', 'withdrawal_hold:' || v_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_avail_acct, 'direction', 'debit',  'amount_kobo', p_amount_kobo + v_fee),
      jsonb_build_object('account_id', v_wd_acct,    'direction', 'credit', 'amount_kobo', p_amount_kobo + v_fee)),
    'officer', v_uid);

  insert into public.withdrawals (
    id, community_id, collection_id, reference, amount_kobo, fee_kobo, withdrawal_fee_version, is_first,
    requires_manual_review, status, destination_account_name, destination_account_number, destination_bank_name,
    requested_by, idempotency_key, approved_by, approved_at, hold_journal_id
  ) values (
    v_id, v_collection.community_id, p_collection_id, v_ref, p_amount_kobo, v_fee, v_fee_ver, v_first,
    p_amount_kobo > c_review_over, v_status, btrim(p_account_name), btrim(p_account_number), btrim(p_bank_name),
    v_uid, p_idempotency_key,
    case when v_owner then v_uid end, case when v_owner then now() end, v_journal
  );

  perform app.write_audit_log(
    v_collection.community_id, 'officer', v_uid, 'withdrawal.request', 'withdrawal', v_id, null,
    jsonb_build_object('reference', v_ref, 'collection_id', p_collection_id, 'amount_kobo', p_amount_kobo,
                       'fee_kobo', v_fee, 'status', v_status::text,
                       'account_last4', right(btrim(p_account_number), 4)));

  return query select v_id, v_ref, v_status, v_fee, false;
end;
$$;
revoke all on function app.request_withdrawal(uuid, bigint, text, text, text, text) from public;
grant execute on function app.request_withdrawal(uuid, bigint, text, text, text, text) to authenticated;

comment on function app.request_withdrawal(uuid, bigint, text, text, text, text) is
  'D-03..D-07: request a withdrawal from one collection. Locks the collection''s available account, sums its ledger entries, enforces first-free / fee schedule, daily limit for unverified communities, identity verification, and posts the hold journal in the same transaction. Owner requests are approved as made. Idempotent per (collection, requester, key).';


-- ── 5. Owner decision, requester cancel ─────────────────────────────────────

create or replace function app.decide_withdrawal(p_withdrawal_id uuid, p_decision text, p_reason text default null)
returns public.withdrawal_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_w   public.withdrawals%rowtype;
  v_rel uuid;
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
      raise exception 'FORBIDDEN: only a community owner approves or rejects a withdrawal (D-06)' using errcode = '42501';
    end if;
    if v_w.status <> 'requested' then
      raise exception 'WITHDRAWAL_NOT_PENDING: withdrawal % is %', v_w.reference, v_w.status using errcode = 'P0001';
    end if;
    if p_decision = 'reject' and coalesce(btrim(p_reason), '') = '' then
      raise exception 'INVALID_REASON: say why the withdrawal is rejected' using errcode = '22023';
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
    update public.withdrawals set status = 'approved', approved_by = v_uid, approved_at = now() where id = v_w.id;
  else
    v_rel := app.release_withdrawal_hold(v_w, 'officer', v_uid, case when p_decision = 'reject' then 'rejected' else 'cancelled' end);
    update public.withdrawals
    set status = case when p_decision = 'reject' then 'rejected'::public.withdrawal_status else 'cancelled' end,
        decided_by = v_uid, decided_at = now(), decision_reason = left(nullif(btrim(p_reason), ''), 500),
        release_journal_id = v_rel
    where id = v_w.id;
  end if;

  perform app.write_audit_log(
    v_w.community_id, 'officer', v_uid, 'withdrawal.' || p_decision, 'withdrawal', v_w.id,
    jsonb_build_object('status', v_w.status::text),
    jsonb_build_object('reference', v_w.reference, 'decision', p_decision), left(nullif(btrim(p_reason), ''), 500));

  return (select w.status from public.withdrawals w where w.id = v_w.id);
end;
$$;
revoke all on function app.decide_withdrawal(uuid, text, text) from public;
grant execute on function app.decide_withdrawal(uuid, text, text) to authenticated;


-- ── 6. Operations: processing, paid, failed (operator session only) ─────────

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


-- ── 7. Read: a collection's withdrawals (balance.view) ──────────────────────

create or replace function app.collection_withdrawals(p_collection_id uuid)
returns table (
  id uuid, reference text, amount_kobo bigint, fee_kobo bigint, status public.withdrawal_status,
  is_first boolean, requires_manual_review boolean,
  account_name text, account_last4 text, bank_name text,
  requested_by_name text, requested_at timestamptz, approved_at timestamptz,
  decided_at timestamptz, decision_reason text, paid_at timestamptz, payout_reference text,
  failed_at timestamptz, failure_reason text,
  can_decide boolean, can_cancel boolean
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
         (w.status in ('requested', 'approved') and (v_requester or w.requested_by = auth.uid()))
  from public.withdrawals w
  left join public.users u on u.id = w.requested_by
  where w.collection_id = p_collection_id
  order by w.requested_at desc;
end;
$$;
revoke all on function app.collection_withdrawals(uuid) from public;
grant execute on function app.collection_withdrawals(uuid) to authenticated;
