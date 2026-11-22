-- ─────────────────────────────────────────────────────────────────────────────
-- 20261120100000 — No self-approval; designated second approver; stricter
-- Paystack approval-URL decision (owner brief 2026-11-20, session 35)
--
-- 1. Self-approval ends. Nobody approves their own withdrawal. Before this
--    migration an owner could approve their own request (recorded as
--    owner_self_approved). Now:
--      · a request by someone who is NOT a community owner is approved by a
--        current owner (unchanged);
--      · a request by an OWNER is approved by a DESIGNATED SECOND APPROVER: a
--        person the owner explicitly designated (community_withdrawal_approvers)
--        who holds an active admin or owner officer term. A treasurer's
--        withdrawal.approve, an undesignated admin, another community's
--        officer and the requester themself never qualify.
--    The basis of every approval is recorded write-once (withdrawals.approved_as).
--    The guard trigger refuses approved_by = requested_by on any write.
--
-- 2. app.decide_transfer_approval gains three inputs from the parsed Paystack
--    payload: currency (must be NGN — every Kolekto amount is NGN kobo),
--    Paystack's transfer code (must equal Kolekto's when Kolekto already has
--    one) and a payload rejection (a parser verdict such as
--    payload_mismatch, recorded instead of being disguised as
--    unknown_reference). It also re-checks the approval basis (no
--    self-approval; owner or designated approver at the approval time) and
--    refuses a withdrawal that already has a payout. The 4-argument version is
--    dropped so no caller can skip the new checks.
--
-- Financial effect: none. No journal, balance or stored amount changes. The
-- functions decide who may approve and when Paystack is told yes.
--
-- Existing rows: historical self-approved withdrawals keep their recorded
-- facts. One that is still approved-but-unclaimed or processing would be
-- refused at the approval URL (self_approved) → Paystack rejects → the normal
-- verify path fails it and releases the hold once. On dev on 2026-11-20 none
-- exists (pre-flight query in the session-35 report).
--
-- ROLLBACK (local/dev only; never applied beyond local/itest at writing):
--   drop function app.decide_transfer_approval(text, bigint, text, text, text, text, text);
--   restore app.decide_transfer_approval(text, bigint, text, text),
--   app.decide_withdrawal, app.guard_withdrawal, app.collection_withdrawals
--   from 20261119120000; drop functions app.withdrawal_approval_basis,
--   app.set_withdrawal_approver, app.withdrawal_approvers; drop table
--   community_withdrawal_approvers; drop column withdrawals.approved_as.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Approval basis, recorded write-once ──────────────────────────────────

alter table public.withdrawals
  add column approved_as text;
alter table public.withdrawals add constraint withdrawals_approved_as
  check (approved_as is null or approved_as in ('owner', 'second_approver'));

comment on column public.withdrawals.approved_as is
  'Why approved_by could approve (2026-11-20): owner = a current community owner approving a non-owner''s request; second_approver = a designated second approver approving an owner''s request. Null for approvals before this column existed. Write-once.';


-- ── 2. Designated second approvers ──────────────────────────────────────────

create table public.community_withdrawal_approvers (
  id             uuid primary key default app.uuid_generate_v7(),
  community_id   uuid not null references public.communities (id) on delete restrict,
  user_id        uuid not null references public.users (id) on delete restrict,
  designated_by  uuid not null references public.users (id) on delete restrict,
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,
  ended_by       uuid references public.users (id) on delete restrict,
  constraint withdrawal_approver_dates check (ended_at is null or ended_at >= started_at),
  constraint withdrawal_approver_end_shape check ((ended_at is null) = (ended_by is null)),
  constraint withdrawal_approver_not_self check (user_id <> designated_by)
);
comment on table public.community_withdrawal_approvers is
  'Owner decision 2026-11-20: who may approve a withdrawal requested by a community owner. Designated by an owner, time-bounded, never deleted. Holding the designation needs an active admin or owner officer term at approval time.';

create unique index community_withdrawal_approvers_one_active
  on public.community_withdrawal_approvers (community_id, user_id) where ended_at is null;
create index community_withdrawal_approvers_history
  on public.community_withdrawal_approvers (community_id, user_id, started_at);

alter table public.community_withdrawal_approvers enable row level security;
alter table public.community_withdrawal_approvers force  row level security;
create policy withdrawal_approvers_no_client_read on public.community_withdrawal_approvers
  for select to authenticated using (false);
revoke all on public.community_withdrawal_approvers from anon, authenticated;

create or replace function app.guard_withdrawal_approver()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'WITHDRAWAL_APPROVER_IS_PERMANENT: designations are ended, never deleted' using errcode = 'P0001';
  end if;
  if new.id is distinct from old.id or new.community_id is distinct from old.community_id
     or new.user_id is distinct from old.user_id or new.designated_by is distinct from old.designated_by
     or new.started_at is distinct from old.started_at
     or (old.ended_at is not null and (new.ended_at is distinct from old.ended_at or new.ended_by is distinct from old.ended_by)) then
    raise exception 'WITHDRAWAL_APPROVER_FACTS_IMMUTABLE: a designation can only be ended, once' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function app.guard_withdrawal_approver() from public, anon, authenticated;

create trigger community_withdrawal_approvers_guard
  before update or delete on public.community_withdrawal_approvers
  for each row execute function app.guard_withdrawal_approver();


-- The single rule for who may approve (or reject) a withdrawal, at a time.
-- Returns 'owner', 'second_approver' or null (no authority).
create or replace function app.withdrawal_approval_basis(p_w public.withdrawals, p_user uuid, p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with requester_owner as (
    select exists (
      select 1 from public.officer_terms ot
      where ot.community_id = p_w.community_id and ot.user_id = p_w.requested_by and ot.role = 'owner'
        and ((ot.started_at <= p_w.requested_at and (ot.ended_at is null or ot.ended_at > p_w.requested_at))
          or (ot.started_at <= p_at and (ot.ended_at is null or ot.ended_at > p_at)))) as yes
  )
  select case
    when p_user is null or p_w.id is null or p_user = p_w.requested_by then null
    when not (select yes from requester_owner) then
      case when exists (
        select 1 from public.officer_terms ot
        where ot.community_id = p_w.community_id and ot.user_id = p_user and ot.role = 'owner'
          and ot.started_at <= p_at and (ot.ended_at is null or ot.ended_at > p_at)) then 'owner' end
    else
      case when exists (
             select 1 from public.community_withdrawal_approvers a
             where a.community_id = p_w.community_id and a.user_id = p_user
               and a.started_at <= p_at and (a.ended_at is null or a.ended_at > p_at))
           and exists (
             select 1 from public.officer_terms ot
             where ot.community_id = p_w.community_id and ot.user_id = p_user and ot.role in ('owner', 'admin')
               and ot.started_at <= p_at and (ot.ended_at is null or ot.ended_at > p_at))
           then 'second_approver' end
  end;
$$;
revoke execute on function app.withdrawal_approval_basis(public.withdrawals, uuid, timestamptz) from public, anon, authenticated;

comment on function app.withdrawal_approval_basis(public.withdrawals, uuid, timestamptz) is
  'Owner decision 2026-11-20: nobody approves their own withdrawal; a non-owner''s request needs a current owner; an owner''s request needs a designated second approver holding an active admin or owner term. A treasurer role never qualifies.';


-- Designate or end a designation. Owners only; the designee must hold an
-- active admin or owner term in the same community and cannot be the caller.
create or replace function app.set_withdrawal_approver(p_community_id uuid, p_user_id uuid, p_active boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null or not app.is_community_owner(p_community_id) then
    raise exception 'FORBIDDEN: only a community owner designates withdrawal approvers' using errcode = '42501';
  end if;
  if p_user_id is null or p_active is null then
    raise exception 'INVALID_INPUT: user and active are required' using errcode = '22023';
  end if;
  if p_user_id = v_uid then
    raise exception 'WITHDRAWAL_APPROVER_SELF: an owner cannot designate themself' using errcode = 'P0001';
  end if;

  select id into v_id from public.community_withdrawal_approvers
  where community_id = p_community_id and user_id = p_user_id and ended_at is null
  for update;

  if p_active then
    if not exists (select 1 from public.officer_terms ot
                   where ot.community_id = p_community_id and ot.user_id = p_user_id
                     and ot.role in ('owner', 'admin') and ot.ended_at is null and ot.started_at <= now()) then
      raise exception 'WITHDRAWAL_APPROVER_NOT_ELIGIBLE: only a current admin or owner of this community can be designated'
        using errcode = 'P0001';
    end if;
    if v_id is not null then
      return false;   -- already designated
    end if;
    insert into public.community_withdrawal_approvers (community_id, user_id, designated_by)
    values (p_community_id, p_user_id, v_uid) returning id into v_id;
    perform app.write_audit_log(p_community_id, 'officer', v_uid, 'withdrawal_approver.designated',
      'withdrawal_approver', v_id, null, jsonb_build_object('user_id', p_user_id), null);
    return true;
  end if;

  if v_id is null then
    return false;     -- nothing to end
  end if;
  update public.community_withdrawal_approvers set ended_at = now(), ended_by = v_uid where id = v_id;
  perform app.write_audit_log(p_community_id, 'officer', v_uid, 'withdrawal_approver.ended',
    'withdrawal_approver', v_id, null, jsonb_build_object('user_id', p_user_id), null);
  return true;
end;
$$;
revoke all on function app.set_withdrawal_approver(uuid, uuid, boolean) from public;
grant execute on function app.set_withdrawal_approver(uuid, uuid, boolean) to authenticated;

-- Active designations, for owners and the designees themselves.
create or replace function app.withdrawal_approvers(p_community_id uuid)
returns table (user_id uuid, full_name text, started_at timestamptz, designated_by_name text, eligible boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not app.has_permission(p_community_id, 'balance.view') then
    raise exception 'FORBIDDEN: missing permission balance.view' using errcode = '42501';
  end if;
  return query
  select a.user_id, u.full_name, a.started_at, d.full_name,
         exists (select 1 from public.officer_terms ot
                 where ot.community_id = a.community_id and ot.user_id = a.user_id
                   and ot.role in ('owner', 'admin') and ot.ended_at is null)
  from public.community_withdrawal_approvers a
  join public.users u on u.id = a.user_id
  join public.users d on d.id = a.designated_by
  where a.community_id = p_community_id and a.ended_at is null
  order by a.started_at;
end;
$$;
revoke all on function app.withdrawal_approvers(uuid) from public;
grant execute on function app.withdrawal_approvers(uuid) to authenticated;


-- ── 3. Guard: as 20261119120000, plus no self-approval and approved_as ──────

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
                                          or new.owner_self_approved is distinct from old.owner_self_approved
                                          or new.approved_as is distinct from old.approved_as))
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
    if new.approved_by is null or new.approved_at is null or new.approved_as is null then
      raise exception 'WITHDRAWAL_APPROVAL_UNRECORDED: an approval names who gave it and on what basis' using errcode = 'P0001';
    end if;
    if new.approved_by = new.requested_by or new.owner_self_approved then
      raise exception 'WITHDRAWAL_SELF_APPROVAL: nobody approves their own withdrawal' using errcode = 'P0001';
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


-- ── 4. Decision: as 20261119120000, with the approval basis ─────────────────
-- approve / reject: only a person app.withdrawal_approval_basis names (never
-- the requester). cancel: unchanged.

create or replace function app.decide_withdrawal(p_withdrawal_id uuid, p_decision text, p_reason text default null)
returns public.withdrawal_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_w     public.withdrawals%rowtype;
  v_bank  public.user_bank_accounts%rowtype;
  v_rel   uuid;
  v_basis text;
begin
  select * into v_w from public.withdrawals where id = p_withdrawal_id for update;
  if v_w.id is null then
    raise exception 'NOT_FOUND: withdrawal % does not exist', p_withdrawal_id using errcode = 'P0002';
  end if;
  if p_decision not in ('approve', 'reject', 'cancel') then
    raise exception 'INVALID_DECISION: approve, reject or cancel' using errcode = '22023';
  end if;

  if p_decision in ('approve', 'reject') then
    if v_uid is not null and v_uid = v_w.requested_by then
      raise exception 'FORBIDDEN: nobody approves or rejects their own withdrawal (the requester may cancel it)' using errcode = '42501';
    end if;
    v_basis := app.withdrawal_approval_basis(v_w, v_uid, now());
    if v_basis is null then
      raise exception 'FORBIDDEN: only a community owner, or for an owner''s own request a designated second approver, approves or rejects a withdrawal'
        using errcode = '42501';
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
    set status = 'approved', approved_by = v_uid, approved_at = now(), approved_as = v_basis, owner_self_approved = false
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
    jsonb_build_object('reference', v_w.reference, 'decision', p_decision, 'approval_basis', v_basis),
    left(nullif(btrim(p_reason), ''), 500));

  return (select w.status from public.withdrawals w where w.id = v_w.id);
end;
$$;
revoke all on function app.decide_withdrawal(uuid, text, text) from public;
grant execute on function app.decide_withdrawal(uuid, text, text) to authenticated;


-- ── 5. Paystack approval URL: payload facts + approval basis ────────────────

drop function app.decide_transfer_approval(text, bigint, text, text);

create function app.decide_transfer_approval(
  p_reference         text,
  p_amount_kobo       bigint,
  p_recipient_code    text,
  p_signature         text,
  p_currency          text,
  p_transfer_code     text,
  p_payload_rejection text
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
  if p_payload_rejection is not null and p_payload_rejection !~ '^payload_[a-z_]{1,50}$' then
    raise exception 'INVALID_PAYLOAD_REJECTION: payload_<reason>' using errcode = '22023';
  end if;

  if p_reference is not null and char_length(p_reference) <= 100 then
    select * into v_t from public.withdrawal_transfers where reference = p_reference for update;
  end if;

  if v_t.id is null then
    -- A payload the parser refused is recorded as such even when its
    -- reference is unknown or unreadable.
    v_reason := coalesce(p_payload_rejection, 'unknown_reference');
  else
    select * into v_w from public.withdrawals where id = v_t.withdrawal_id for share;
    select * into v_b from public.user_bank_accounts where id = v_w.bank_account_id;
    select c.community_id into v_comm from public.collections c where c.id = v_w.collection_id;
    v_wd_bal := app.ledger_account_balance(
      app.ensure_ledger_account(v_w.community_id, v_w.collection_id, 'collection_withdrawing'));

    v_reason := case
      when p_payload_rejection is not null then p_payload_rejection
      when v_t.status not in ('initiating', 'pending', 'otp', 'unknown') then 'transfer_already_final'
      when v_w.payout_journal_id is not null or v_w.paid_at is not null
           or exists (select 1 from public.ledger_journals j where j.idempotency_key = 'payout:' || v_w.id) then 'already_paid'
      when v_w.status <> 'processing' then 'withdrawal_not_processing'
      when p_amount_kobo is null or p_amount_kobo <> v_t.amount_kobo or v_t.amount_kobo <> v_w.amount_kobo then 'amount_mismatch'
      when p_currency is distinct from 'NGN' then 'currency_mismatch'
      when p_recipient_code is null or v_t.recipient_code is null or btrim(p_recipient_code) <> v_t.recipient_code then 'recipient_mismatch'
      when p_transfer_code is null or (v_t.transfer_code is not null and p_transfer_code <> v_t.transfer_code) then 'transfer_code_mismatch'
      when v_b.id is null or v_b.recipient_code is distinct from v_t.recipient_code then 'recipient_not_selected_account'
      when v_b.user_id <> v_w.requested_by then 'account_not_requesters'
      when v_b.status <> 'verified' or v_b.usable_from > now() then 'account_not_verified'
      when v_comm is distinct from v_w.community_id then 'collection_community_mismatch'
      when v_w.member_otp_verified_at is null
           or not exists (select 1 from public.withdrawal_otp_challenges c
                          where c.id = v_w.member_otp_challenge_id and c.withdrawal_id = v_w.id
                            and c.user_id = v_w.requested_by and c.status = 'verified') then 'member_not_verified'
      when v_w.approved_by is null or v_w.approved_at is null then 'owner_not_approved'
      when v_w.approved_by = v_w.requested_by or v_w.owner_self_approved then 'self_approved'
      when v_w.approved_as is null
           or app.withdrawal_approval_basis(v_w, v_w.approved_by, v_w.approved_at) is distinct from v_w.approved_as then 'approver_not_authorised'
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
revoke execute on function app.decide_transfer_approval(text, bigint, text, text, text, text, text) from public, anon, authenticated;

comment on function app.decide_transfer_approval(text, bigint, text, text, text, text, text) is
  'Paystack server approval (owner decisions 2026-11-19, 2026-11-20): approve (HTTP 200) only when the parsed payload is consistent, the reference is a Kolekto transfer still open and unpaid, the amount, NGN currency, recipient and (when known) transfer code match, the destination is the requester''s own verified account, the member''s code was verified, the approval came from someone other than the requester on a valid basis (owner, or designated second approver for an owner''s request), the withdrawal is not under manual review and its funds are still reserved. Otherwise reject (HTTP 400). Logged per request.';


-- ── 6. Read: a collection's withdrawals — can_decide / can_reject by basis ──

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
  account_status text, account_cooling_off boolean, transfer_escalated boolean,
  approved_as text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_collection public.collections%rowtype;
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
  v_requester := app.has_permission_for_collection(p_collection_id, 'withdrawal.request');

  return query
  select w.id, w.reference, w.amount_kobo::bigint, w.fee_kobo::bigint, w.status, w.is_first, w.requires_manual_review,
         w.destination_account_name, right(w.destination_account_number, 4), w.destination_bank_name,
         u.full_name, w.requested_at, w.approved_at, w.decided_at, w.decision_reason, w.paid_at, w.payout_reference,
         w.failed_at, w.failure_reason,
         (w.status = 'requested' and (w.bank_account_id is null or w.member_otp_verified_at is not null)
          and app.withdrawal_approval_basis(w, v_uid, now()) is not null),
         (w.status in ('requested', 'approved') and (v_requester or w.requested_by = v_uid)),
         case when t.id is not null then 'paystack_transfer' else 'manual' end,
         t.reference, t.status, w.reversed_at, w.reversal_reason,
         app.withdrawal_stage(w), w.member_otp_verified_at, w.requested_by = v_uid,
         (w.status = 'requested' and app.withdrawal_approval_basis(w, v_uid, now()) is not null),
         ap.full_name, w.owner_self_approved, w.available_before_kobo,
         b.status, coalesce(b.usable_from > now(), false), t.escalated_at is not null,
         w.approved_as
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
