-- ─────────────────────────────────────────────────────────────────────────────
-- 20261119100000 — catch-up for payments stuck on the provider-confirmed rule
-- (owner decision 2026-11-19, financial-decisions.md §21).
--
-- WHY. Payments captured before 2026-11-18 were scheduled under
-- `2026-11-t1-0500-lagos`, which releases pending → available only after a
-- provider settlement has been recorded with app.record_provider_settlement.
-- Nothing records those automatically (there is no Paystack settlement sync),
-- so every such payment stayed pending after its 05:00 WAT release time. The
-- 2026-11-18 verified-charge schedule fixed this only for new captures,
-- because a settlement row's schedule never changes.
--
-- WHAT. An operator approves, per payment, that a verified Paystack charge
-- may be released on its T+1 time without a provider settlement record, the
-- same rule every capture from 2026-11-18 already follows. The approval is a
-- new write-once column, not a fake provider confirmation:
-- provider_confirmed_at keeps meaning "Paystack reported a settlement", so
-- platform_reconciliation's provider_receivable_vs_unconfirmed identity is
-- unchanged. The release itself is still app.release_due_settlements: one
-- balance_release journal per payment, row locks, unique journal key.
--
-- A payment is approved only when ALL hold: settlement pending, due, not
-- provider-confirmed, not already approved, schedule requires provider
-- confirmation; payment attempt `completed` with a non-fake provider;
-- a provider transaction for it mapped `succeeded` for exactly the amount
-- charged; provider fee basis `reported` (Paystack's verify answered).
-- Fake-provider (seed) and unverified payments are reported, never approved.
--
-- EFFECT ON MONEY. No stored amount changes. Approved payments move from the
-- collection's pending to available account on the next release run, for
-- exactly their recorded net_kobo. Approval is audited per payment.
--
-- Additive: one nullable column, one function; the settlement guard and the
-- release function are re-created with one extra condition each.
--
-- ROLLBACK (before any approval is used, or to stop further approvals):
--   revoke all on function app.approve_verified_charge_settlements(boolean, integer) from public;
--   drop function app.approve_verified_charge_settlements(boolean, integer);
--   re-create app.release_due_settlements(integer) and
--   app.guard_contribution_settlement() from 20261117100100.
--   The column may stay (nullable, unused). Releases already made are ledger
--   journals and are never deleted; undoing one is a reversing journal.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.contribution_settlements
  add column verified_charge_approved_at timestamptz;

comment on column public.contribution_settlements.verified_charge_approved_at is
  'Set once by app.approve_verified_charge_settlements: an operator approved releasing this pre-2026-11-18 payment on its verified Paystack charge, without a provider settlement record (owner decision 2026-11-19). Not a provider confirmation.';


-- The guard as in 20261117100100, plus: the approval is written once, only on
-- a pending, unconfirmed payment.
create or replace function app.guard_contribution_settlement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'SETTLEMENT_IS_PERMANENT: contribution_settlements rows are never deleted'
      using errcode = 'P0001';
  end if;

  if new.contribution_id        is distinct from old.contribution_id
     or new.collection_id       is distinct from old.collection_id
     or new.community_id        is distinct from old.community_id
     or new.schedule_version    is distinct from old.schedule_version
     or new.net_kobo            is distinct from old.net_kobo
     or new.expected_provider_kobo is distinct from old.expected_provider_kobo
     or new.captured_at         is distinct from old.captured_at
     or new.scheduled_release_at is distinct from old.scheduled_release_at
     or new.created_at          is distinct from old.created_at then
    raise exception 'SETTLEMENT_FACTS_IMMUTABLE: a payment''s amount and schedule cannot change'
      using errcode = 'P0001';
  end if;

  if old.status = 'released' then
    raise exception 'SETTLEMENT_ALREADY_RELEASED: contribution % was released at %', old.contribution_id, old.released_at
      using errcode = 'P0001';
  end if;
  if old.status = 'discrepancy' and new.status <> 'discrepancy' then
    raise exception 'SETTLEMENT_DISCREPANCY_OPEN: resolving a discrepancy needs its own reviewed function'
      using errcode = 'P0001';
  end if;

  if old.provider_confirmed_at is not null and (
       new.provider_confirmed_at   is distinct from old.provider_confirmed_at
    or new.provider_settled_kobo   is distinct from old.provider_settled_kobo
    or new.provider_settlement_ref is distinct from old.provider_settlement_ref
    or new.provider_journal_id     is distinct from old.provider_journal_id) then
    raise exception 'SETTLEMENT_CONFIRMATION_IMMUTABLE: provider confirmation for % is already recorded', old.contribution_id
      using errcode = 'P0001';
  end if;

  if new.verified_charge_approved_at is distinct from old.verified_charge_approved_at then
    if old.verified_charge_approved_at is not null then
      raise exception 'SETTLEMENT_APPROVAL_IMMUTABLE: release approval for % is already recorded', old.contribution_id
        using errcode = 'P0001';
    end if;
    if old.status <> 'pending' or old.provider_confirmed_at is not null then
      raise exception 'SETTLEMENT_APPROVAL_NOT_ALLOWED: only a pending, unconfirmed payment can be approved for release'
        using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'released' and new.release_journal_id is null and new.net_kobo > 0 then
    raise exception 'SETTLEMENT_RELEASE_NEEDS_JOURNAL: a release of a non-zero amount must name its journal'
      using errcode = 'P0001';
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_contribution_settlement() from public, anon, authenticated;


-- The release as in 20261117100100, plus: an operator-approved verified charge
-- counts as confirmed, and is not reported as awaiting the provider.
create or replace function app.release_due_settlements(p_limit integer default 500)
returns table (released integer, released_kobo bigint, awaiting_provider integer, awaiting_provider_kobo bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now      timestamptz := now();
  v_row      record;
  v_pending  uuid;
  v_avail    uuid;
  v_journal  uuid;
  v_count    integer := 0;
  v_kobo     bigint  := 0;
begin
  perform app.assert_payment_operator_session();
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'INVALID_LIMIT: between 1 and 5000' using errcode = '22023';
  end if;

  for v_row in
    select s.contribution_id, s.collection_id, s.community_id, s.net_kobo, s.scheduled_release_at, a.reference
    from public.contribution_settlements s
    join public.settlement_schedules sch on sch.version = s.schedule_version
    join public.contributions c on c.id = s.contribution_id
    join public.payment_attempts a on a.id = c.attempt_id
    where s.status = 'pending'
      and s.scheduled_release_at <= v_now
      and (s.provider_confirmed_at is not null
           or s.verified_charge_approved_at is not null
           or not sch.requires_provider_confirmation)
    order by s.scheduled_release_at, s.contribution_id
    limit p_limit
    for update of s skip locked
  loop
    v_journal := null;
    if v_row.net_kobo > 0 then
      v_pending := app.ensure_ledger_account(v_row.community_id, v_row.collection_id, 'collection_pending');
      v_avail   := app.ensure_ledger_account(v_row.community_id, v_row.collection_id, 'collection_available');
      v_journal := app.post_payment_journal(
        v_row.community_id, v_row.collection_id, v_now, 'balance_release', v_row.contribution_id,
        'T+1 release of payment ' || v_row.reference || ' (due '
          || to_char(v_row.scheduled_release_at at time zone 'Africa/Lagos', 'YYYY-MM-DD HH24:MI') || ' WAT)',
        null, 'balance_release:' || v_row.contribution_id,
        jsonb_build_array(
          jsonb_build_object('account_id', v_pending, 'direction', 'debit',  'amount_kobo', v_row.net_kobo),
          jsonb_build_object('account_id', v_avail,   'direction', 'credit', 'amount_kobo', v_row.net_kobo)));
    end if;

    update public.contribution_settlements s
    set status = 'released', released_at = v_now, release_journal_id = v_journal
    where s.contribution_id = v_row.contribution_id;

    v_count := v_count + 1;
    v_kobo  := v_kobo + v_row.net_kobo;
  end loop;

  return query
  select v_count, v_kobo,
         count(*)::integer, coalesce(sum(s.net_kobo), 0)::bigint
  from public.contribution_settlements s
  join public.settlement_schedules sch on sch.version = s.schedule_version
  where s.status = 'pending'
    and s.scheduled_release_at <= v_now
    and s.provider_confirmed_at is null
    and s.verified_charge_approved_at is null
    and sch.requires_provider_confirmation;
end;
$$;
revoke execute on function app.release_due_settlements(integer) from public, anon, authenticated;

comment on function app.release_due_settlements(integer) is
  'D-09/D-09c: posts one balance_release journal (Dr collection_pending, Cr collection_available, net) per payment whose scheduled_release_at has passed AND whose provider settlement is confirmed, or whose verified charge an operator approved (20261119100000), when the schedule requires it. Idempotent. Returns what it released and what is due but still awaiting the provider.';


-- ── The catch-up ────────────────────────────────────────────────────────────
--
-- p_apply = false: dry run. Lists every due, unconfirmed, unapproved payment
--   on a provider-confirmed schedule with what would happen to it. Writes
--   nothing.
-- p_apply = true: approves the `eligible` ones (one audit entry each) and
--   returns the same list with `approved`. Run app.release_due_settlements
--   afterwards (the worker does it every 5 minutes) to move them to available.
--
-- outcome: eligible | approved | skipped_fake_provider | skipped_unverified_charge

create or replace function app.approve_verified_charge_settlements(
  p_apply boolean default false,
  p_limit integer default 500
)
returns table (
  outcome              text,
  contribution_id      uuid,
  collection_id        uuid,
  reference            text,
  provider             text,
  net_kobo             bigint,
  captured_at          timestamptz,
  scheduled_release_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := now();
  v_row record;
  v_outcome text;
begin
  perform app.assert_payment_operator_session();
  if p_apply is null then
    raise exception 'INVALID_ARGUMENT: p_apply must be true or false' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'INVALID_LIMIT: between 1 and 5000' using errcode = '22023';
  end if;

  for v_row in
    select s.contribution_id, s.collection_id, s.community_id, s.net_kobo::bigint as net_kobo,
           s.captured_at, s.scheduled_release_at, s.schedule_version,
           a.reference, a.provider,
           (a.status = 'completed'
            and c.provider_fee_basis = 'reported'
            and exists (select 1 from public.provider_transactions pt
                        where pt.attempt_id = a.id
                          and pt.provider = a.provider
                          and pt.status_mapped = 'succeeded'
                          and pt.amount_kobo = c.total_charged_kobo::bigint)) as charge_verified
    from public.contribution_settlements s
    join public.settlement_schedules sch on sch.version = s.schedule_version
    join public.contributions c on c.id = s.contribution_id
    join public.payment_attempts a on a.id = c.attempt_id
    where s.status = 'pending'
      and s.scheduled_release_at <= v_now
      and s.provider_confirmed_at is null
      and s.verified_charge_approved_at is null
      and sch.requires_provider_confirmation
    order by s.scheduled_release_at, s.contribution_id
    limit p_limit
    for update of s skip locked
  loop
    if v_row.provider = 'fake' then
      v_outcome := 'skipped_fake_provider';
    elsif not v_row.charge_verified then
      v_outcome := 'skipped_unverified_charge';
    elsif not p_apply then
      v_outcome := 'eligible';
    else
      update public.contribution_settlements s
      set verified_charge_approved_at = v_now
      where s.contribution_id = v_row.contribution_id;

      perform app.write_audit_log(
        v_row.community_id, 'system', null, 'settlement.verified_charge_approved', 'contribution',
        v_row.contribution_id, null,
        jsonb_build_object('reference', v_row.reference, 'net_kobo', v_row.net_kobo,
                           'schedule_version', v_row.schedule_version,
                           'scheduled_release_at', v_row.scheduled_release_at),
        'Owner decision 2026-11-19: verified Paystack charge released on its T+1 time without a provider settlement record',
        null, null);
      v_outcome := 'approved';
    end if;

    return query select v_outcome, v_row.contribution_id, v_row.collection_id, v_row.reference,
                        v_row.provider, v_row.net_kobo, v_row.captured_at, v_row.scheduled_release_at;
  end loop;
end;
$$;
revoke execute on function app.approve_verified_charge_settlements(boolean, integer) from public, anon, authenticated;

comment on function app.approve_verified_charge_settlements(boolean, integer) is
  'Operator (owner decision 2026-11-19): for due, unconfirmed payments on a provider-confirmed schedule, approve release on the verified Paystack charge (write-once verified_charge_approved_at, audited). p_apply=false is a dry run. Fake-provider and unverified payments are skipped. The release itself is app.release_due_settlements.';
