-- ─────────────────────────────────────────────────────────────────────────────
-- 20261117130000 — Collection payment activity: who paid, how much, and
--                  whether it can be withdrawn yet
--
-- READS ONLY. Nothing here writes an attempt, a contribution, a settlement, a
-- withdrawal or a journal.
--
-- WHY. The Activity tab listed ledger journals ("Payment received +₦4,900
-- Pending"): no payer, and the bucket name read as if the PAYMENT were still
-- pending. This function returns one row per payment attempt (and per
-- withdrawal) with the payer's name and two separate facts:
--
--   payment_status        what happened to the payment itself
--     successful            a contribution exists: the provider confirmed the
--                           money and the backend verified and recorded it
--                           (complete_payment_capture). Final the moment it is
--                           recorded; T+1 never changes it.
--     pending               checkout started or provider result not yet known
--     under_review          money reported but parked for a human (needs_review)
--     failed                provider refused, or the checkout ended without money
--
--   eligibility           when a SUCCESSFUL payment's net can be withdrawn
--                           (contribution_settlements; null for any other row)
--     scheduled             before its T+1 release time
--     awaiting_provider     release time passed, provider settlement not yet
--                           recorded: the money is not yet fundable, so it
--                           stays out of Available
--     held                  provider settled a different amount; held, audited
--     released              moved to the available balance by the automatic
--                           release (a balance_release journal)
--
-- Withdrawals are rows of their own (kind = 'withdrawal'), only for a caller
-- with balance.view. Their status keeps the withdrawal lifecycle names.
--
-- FEES. For a successful payment the amounts are the contribution's own,
-- frozen at checkout (D-16): gross contribution, what the contributor was
-- charged, the "Processing fee" and "Kolekto fee" lines, total fees, the fee
-- bearer and the net credited to the collection. The provider's internal cost
-- to Kolekto is never returned (D-28). For a payment that did not succeed no
-- fee is returned: nothing was charged.
--
-- PERMISSIONS. transaction.view for payments (the same rows the register
-- shows); balance.view adds withdrawals. No email, phone or account number.
--
--   filter        rows
--   all           every payment attempt, plus withdrawals with balance.view
--   successful    payments with a contribution
--   pending       pending and under_review payments
--   failed        failed and expired payments
--   withdrawals   withdrawals (balance.view, else FORBIDDEN)
--
-- Additive. Rollback: drop function app.collection_payment_activity(uuid, text, integer, integer).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.collection_payment_activity(
  p_collection_id uuid,
  p_filter        text    default 'all',
  p_limit         integer default 25,
  p_offset        integer default 0
)
returns table (
  kind                 text,
  id                   uuid,
  occurred_at          timestamptz,
  name                 text,
  is_member            boolean,
  reference            text,
  payment_status       text,
  verified_at          timestamptz,
  amount_kobo          bigint,
  charged_kobo         bigint,
  processing_fee_kobo  bigint,
  kolekto_fee_kobo     bigint,
  total_fees_kobo      bigint,
  net_kobo             bigint,
  fee_bearer           text,
  eligibility          text,
  eligible_at          timestamptz,
  released_at          timestamptz,
  withdrawal_status    text,
  destination          text,
  completed_at         timestamptz,
  detail               text,
  total_count          bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_balances boolean;
begin
  if not exists (select 1 from public.collections c where c.id = p_collection_id) then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if not app.has_permission_for_collection(p_collection_id, 'transaction.view') then
    raise exception 'FORBIDDEN: missing permission transaction.view for collection %', p_collection_id
      using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 or p_offset is null or p_offset < 0 then
    raise exception 'INVALID_PAGE: limit 1..200, offset ≥ 0' using errcode = '22023';
  end if;
  if p_filter is null or p_filter not in ('all', 'successful', 'pending', 'failed', 'withdrawals') then
    raise exception 'INVALID_FILTER: unknown activity filter %', p_filter using errcode = '22023';
  end if;

  v_balances := app.has_permission_for_collection(p_collection_id, 'balance.view');
  if p_filter = 'withdrawals' and not v_balances then
    raise exception 'FORBIDDEN: missing permission balance.view for collection %', p_collection_id
      using errcode = '42501';
  end if;

  return query
  with payments as (
    select
      'payment'::text                                            as kind,
      a.id                                                       as id,
      coalesce(c.captured_at, a.created_at)                      as occurred_at,
      coalesce(m.full_name, i.contributor_name)::text            as name,
      a.member_id is not null                                    as is_member,
      a.reference                                                as reference,
      case
        when c.id is not null                         then 'successful'
        when a.status = 'needs_review'                then 'under_review'
        when a.status in ('failed', 'expired')        then 'failed'
        else 'pending'
      end                                                        as payment_status,
      c.captured_at                                              as verified_at,
      coalesce(c.contribution_kobo, a.contribution_kobo)::bigint as amount_kobo,
      c.total_charged_kobo::bigint                               as charged_kobo,
      case when c.id is not null then a.gateway_fee_kobo::bigint end  as processing_fee_kobo,
      case when c.id is not null then a.platform_fee_kobo::bigint end as kolekto_fee_kobo,
      c.total_fees_kobo::bigint                                  as total_fees_kobo,
      c.net_kobo::bigint                                         as net_kobo,
      c.fee_bearer::text                                         as fee_bearer,
      case
        when c.id is null                              then null
        when s.status = 'released'                     then 'released'
        when s.status = 'discrepancy'                  then 'held'
        when s.status = 'pending' and s.scheduled_release_at <= now()
             and s.provider_confirmed_at is null       then 'awaiting_provider'
        when s.status = 'pending'                      then 'scheduled'
        else null
      end                                                        as eligibility,
      s.scheduled_release_at                                     as eligible_at,
      s.released_at                                              as released_at,
      null::text                                                 as withdrawal_status,
      null::text                                                 as destination,
      null::timestamptz                                          as completed_at,
      null::text                                                 as detail
    from public.payment_attempts a
    join public.contribution_intents i on i.id = a.intent_id
    left join public.contributions c on c.attempt_id = a.id and c.status = 'applied'
    left join public.contribution_settlements s on s.contribution_id = c.id
    left join public.members m on m.id = a.member_id
    where a.collection_id = p_collection_id
  ),
  withdrawals as (
    select
      'withdrawal'::text,
      w.id,
      w.requested_at,
      coalesce(u.full_name, 'An officer')::text,
      false,
      w.reference,
      null::text,
      null::timestamptz,
      w.amount_kobo::bigint,
      null::bigint,
      null::bigint,
      null::bigint,
      w.fee_kobo::bigint,
      null::bigint,
      null::text,
      null::text,
      null::timestamptz,
      null::timestamptz,
      w.status::text,
      (w.destination_bank_name || ' ••••' || right(w.destination_account_number, 4))::text,
      coalesce(w.paid_at, w.failed_at, w.decided_at),
      coalesce(w.failure_reason, w.decision_reason)
    from public.withdrawals w
    left join public.users u on u.id = w.requested_by
    where w.collection_id = p_collection_id
      and v_balances
  ),
  combined as (
    select * from payments p
    where p_filter = 'all'
       or (p_filter = 'successful' and p.payment_status = 'successful')
       or (p_filter = 'pending'    and p.payment_status in ('pending', 'under_review'))
       or (p_filter = 'failed'     and p.payment_status = 'failed')
    union all
    select * from withdrawals w
    where p_filter in ('all', 'withdrawals')
  )
  select r.*, count(*) over ()
  from combined r
  order by r.occurred_at desc, r.id desc
  limit p_limit offset p_offset;
end;
$$;

revoke all     on function app.collection_payment_activity(uuid, text, integer, integer) from public;
grant  execute on function app.collection_payment_activity(uuid, text, integer, integer) to authenticated;

comment on function app.collection_payment_activity(uuid, text, integer, integer) is
  'One row per payment attempt (payer, amount, payment status, frozen fees, withdrawal eligibility) and, with balance.view, per withdrawal; newest first, filtered before paging. transaction.view. Reads only; never returns the provider''s cost (D-28), contact details or full account numbers.';
