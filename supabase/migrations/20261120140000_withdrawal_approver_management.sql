-- ─────────────────────────────────────────────────────────────────────────────
-- 20261120140000 — Second-approver management for owners (session 39)
--
-- 20261120100000 created designated second approvers
-- (community_withdrawal_approvers, app.set_withdrawal_approver,
-- app.withdrawal_approvers) but owners had no application screen for them.
-- This migration adds what that screen needs, and closes one eligibility gap.
-- The approval policy itself is unchanged:
--   · nobody approves their own withdrawal;
--   · a non-owner's request is approved by a current owner;
--   · an owner's request is approved by a designated second approver who
--     holds an active admin or owner officer term at the approval time;
--   · a treasurer never qualifies by role; only an owner designates;
--   · several designations may be active at once (one per person) — the
--     policy of 20261120100000, kept.
--
-- 1. app.withdrawal_approver_candidates(community) — owner only: the people
--    an owner may designate (active admin/owner term, active account, not the
--    caller), each with whether they are designated now.
-- 2. app.withdrawal_approver_history(community) — owner only: every
--    designation, current and ended, with who made and who ended it, when,
--    and whether a current one still gives authority.
-- 3. app.replace_withdrawal_approver(community, from, to) — owner only: ends
--    one designation and starts another in ONE transaction, audited once as
--    withdrawal_approver.replaced.
-- 4. Eligibility gap: a SUSPENDED or CLOSED account (users.status) kept its
--    officer term and so could still be designated, approve or reject.
--    users.status = 'suspended' means "cannot act in any community". Now:
--      · app.set_withdrawal_approver refuses to designate such a person;
--      · app.decide_withdrawal refuses approve/reject from such a person
--        (new helper app.withdrawal_decider_basis = the approval basis AND an
--        active account);
--      · app.collection_withdrawals shows them no Approve/Reject;
--      · app.withdrawal_approvers reports them as not eligible.
--    app.withdrawal_approval_basis and app.decide_transfer_approval are NOT
--    changed: the Paystack approval-URL decision (session 38 baseline) keeps
--    judging the recorded approval by the officer term and designation at
--    the approval time.
--
-- Financial effect: none. No journal, balance, stored amount, withdrawal
-- status or recorded approval changes. Historical designations and approvals
-- are never rewritten: designations are ended, never deleted (guard trigger
-- of 20261120100000), and withdrawals.approved_by / approved_as stay
-- write-once (guard_withdrawal).
--
-- ROLLBACK (local/dev/itest only; nothing applied beyond local at writing):
--   drop function app.replace_withdrawal_approver(uuid, uuid, uuid);
--   drop function app.withdrawal_approver_history(uuid);
--   drop function app.withdrawal_approver_candidates(uuid);
--   re-run sections 2, 4 and 6 of 20261120100000 (set_withdrawal_approver,
--   withdrawal_approvers, decide_withdrawal, collection_withdrawals);
--   drop function app.withdrawal_decider_basis(public.withdrawals, uuid, timestamptz).
--   No data to migrate back: only functions change.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 0. Who may decide now: the approval basis held by an active account ─────

create or replace function app.withdrawal_decider_basis(p_w public.withdrawals, p_user uuid, p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.users u where u.id = p_user and u.status = 'active')
      then app.withdrawal_approval_basis(p_w, p_user, p_at)
  end;
$$;
revoke execute on function app.withdrawal_decider_basis(public.withdrawals, uuid, timestamptz) from public, anon, authenticated;

comment on function app.withdrawal_decider_basis(public.withdrawals, uuid, timestamptz) is
  'Session 39: app.withdrawal_approval_basis, and only for an active account (users.status = active). A suspended or closed account approves and rejects nothing.';


-- ── 1. Designate / end: as 20261120100000, plus an active account ───────────

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
                   join public.users u on u.id = ot.user_id and u.status = 'active'
                   where ot.community_id = p_community_id and ot.user_id = p_user_id
                     and ot.role in ('owner', 'admin') and ot.ended_at is null and ot.started_at <= now()) then
      raise exception 'WITHDRAWAL_APPROVER_NOT_ELIGIBLE: only a current admin or owner of this community, with an active account, can be designated'
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


-- ── 2. Replace one designation with another, atomically ─────────────────────

create or replace function app.replace_withdrawal_approver(p_community_id uuid, p_from_user_id uuid, p_to_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_old  uuid;
  v_new  uuid;
begin
  if v_uid is null or not app.is_community_owner(p_community_id) then
    raise exception 'FORBIDDEN: only a community owner designates withdrawal approvers' using errcode = '42501';
  end if;
  if p_from_user_id is null or p_to_user_id is null then
    raise exception 'INVALID_INPUT: both people are required' using errcode = '22023';
  end if;
  if p_from_user_id = p_to_user_id then
    raise exception 'INVALID_INPUT: choose a different person' using errcode = '22023';
  end if;
  if p_to_user_id = v_uid then
    raise exception 'WITHDRAWAL_APPROVER_SELF: an owner cannot designate themself' using errcode = 'P0001';
  end if;

  -- Lock the designation being replaced first; a concurrent replace or end
  -- waits here and then finds it ended.
  select id into v_old from public.community_withdrawal_approvers
  where community_id = p_community_id and user_id = p_from_user_id and ended_at is null
  for update;
  if v_old is null then
    raise exception 'WITHDRAWAL_APPROVER_NOT_DESIGNATED: that person is not a current second approver' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.officer_terms ot
                 join public.users u on u.id = ot.user_id and u.status = 'active'
                 where ot.community_id = p_community_id and ot.user_id = p_to_user_id
                   and ot.role in ('owner', 'admin') and ot.ended_at is null and ot.started_at <= now()) then
    raise exception 'WITHDRAWAL_APPROVER_NOT_ELIGIBLE: only a current admin or owner of this community, with an active account, can be designated'
      using errcode = 'P0001';
  end if;
  if exists (select 1 from public.community_withdrawal_approvers
             where community_id = p_community_id and user_id = p_to_user_id and ended_at is null) then
    raise exception 'WITHDRAWAL_APPROVER_ALREADY_DESIGNATED: that person is already a second approver' using errcode = 'P0001';
  end if;

  update public.community_withdrawal_approvers set ended_at = now(), ended_by = v_uid where id = v_old;
  insert into public.community_withdrawal_approvers (community_id, user_id, designated_by)
  values (p_community_id, p_to_user_id, v_uid) returning id into v_new;

  perform app.write_audit_log(p_community_id, 'officer', v_uid, 'withdrawal_approver.replaced',
    'withdrawal_approver', v_new,
    jsonb_build_object('user_id', p_from_user_id, 'designation_id', v_old),
    jsonb_build_object('user_id', p_to_user_id, 'designation_id', v_new), null);
  return v_new;
end;
$$;
revoke all on function app.replace_withdrawal_approver(uuid, uuid, uuid) from public;
grant execute on function app.replace_withdrawal_approver(uuid, uuid, uuid) to authenticated;


-- ── 3. Owner reads: candidates and history ──────────────────────────────────

create or replace function app.withdrawal_approver_candidates(p_community_id uuid)
returns table (user_id uuid, full_name text, officer_role text, officer_title text, officer_since timestamptz, designated boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not app.is_community_owner(p_community_id) then
    raise exception 'FORBIDDEN: only a community owner manages withdrawal approvers' using errcode = '42501';
  end if;
  return query
  select distinct on (ot.user_id)
         ot.user_id, u.full_name, ot.role::text, ot.title, ot.started_at,
         exists (select 1 from public.community_withdrawal_approvers a
                 where a.community_id = p_community_id and a.user_id = ot.user_id and a.ended_at is null)
  from public.officer_terms ot
  join public.users u on u.id = ot.user_id and u.status = 'active'
  where ot.community_id = p_community_id
    and ot.role in ('owner', 'admin') and ot.ended_at is null and ot.started_at <= now()
    and ot.user_id <> auth.uid()
  order by ot.user_id, (ot.role = 'owner') desc, ot.started_at;
end;
$$;
revoke all on function app.withdrawal_approver_candidates(uuid) from public;
grant execute on function app.withdrawal_approver_candidates(uuid) to authenticated;

create or replace function app.withdrawal_approver_history(p_community_id uuid)
returns table (
  designation_id uuid, user_id uuid, full_name text,
  designated_by_name text, started_at timestamptz,
  ended_by_name text, ended_at timestamptz,
  active boolean, eligible boolean, officer_role text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not app.is_community_owner(p_community_id) then
    raise exception 'FORBIDDEN: only a community owner manages withdrawal approvers' using errcode = '42501';
  end if;
  return query
  select a.id, a.user_id, u.full_name, d.full_name, a.started_at, e.full_name, a.ended_at,
         a.ended_at is null,
         a.ended_at is null and u.status = 'active' and t.role is not null,
         t.role
  from public.community_withdrawal_approvers a
  join public.users u on u.id = a.user_id
  join public.users d on d.id = a.designated_by
  left join public.users e on e.id = a.ended_by
  left join lateral (
    select ot.role::text as role from public.officer_terms ot
    where ot.community_id = a.community_id and ot.user_id = a.user_id
      and ot.role in ('owner', 'admin') and ot.ended_at is null and ot.started_at <= now()
    order by (ot.role = 'owner') desc limit 1) t on true
  where a.community_id = p_community_id
  order by a.ended_at is null desc, a.started_at desc;
end;
$$;
revoke all on function app.withdrawal_approver_history(uuid) from public;
grant execute on function app.withdrawal_approver_history(uuid) to authenticated;


-- ── 4. Active designations (balance.view): eligibility includes the account ─

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
         u.status = 'active'
         and exists (select 1 from public.officer_terms ot
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


-- ── 5. Decision: as 20261120100000, deciding only from an active account ────

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
    v_basis := app.withdrawal_decider_basis(v_w, v_uid, now());
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


-- ── 6. Read: a collection's withdrawals — can_decide by the decider basis ───

create or replace function app.collection_withdrawals(p_collection_id uuid)
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
          and app.withdrawal_decider_basis(w, v_uid, now()) is not null),
         (w.status in ('requested', 'approved') and (v_requester or w.requested_by = v_uid)),
         case when t.id is not null then 'paystack_transfer' else 'manual' end,
         t.reference, t.status, w.reversed_at, w.reversal_reason,
         app.withdrawal_stage(w), w.member_otp_verified_at, w.requested_by = v_uid,
         (w.status = 'requested' and app.withdrawal_decider_basis(w, v_uid, now()) is not null),
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
