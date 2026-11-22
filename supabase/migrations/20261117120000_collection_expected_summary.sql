-- ─────────────────────────────────────────────────────────────────────────────
-- 20261117120000 — Who is expected to pay, who has, and what is still owed
--
-- READS ONLY. Nothing here writes, and no figure here is money received: the
-- outstanding amount is what members are still EXPECTED to pay, shown beside
-- (never added to) the ledger figures of the financial overview.
--
--   app.collection_expected_summary(collection)  transaction.view
--
-- Scope: a managed, member-audience, one-time collection — the only kind with
-- a list of people expected to pay. Recurring collections expect per period
-- and are reported as unsupported until a per-cycle read exists. Open-link
-- collections have no expected list at all.
--
-- Method (integer kobo throughout):
--   · each non-cancelled, non-exempt obligation expects
--     expected_amount_kobo − waived_amount_kobo (a waiver is not money, CASH-02);
--   · "received against it" = Σ applied contributions naming that obligation,
--     capped at what it expects, so an overpayment by one member never hides
--     another member's debt;
--   · paid = received ≥ expected; partly paid = 0 < received < expected;
--     not paid = nothing received;
--   · audience members with no obligation yet are not paid; they expect the
--     fixed amount on a fixed-amount collection. On any other amount model
--     their amount is unknown, so outstanding_complete is false and the screen
--     says "at least".
--
-- Additive. Rollback: drop the function.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.collection_expected_summary(p_collection_id uuid)
returns table (
  supported            boolean,
  unsupported_reason   text,
  expected_count       integer,
  paid_count           integer,
  partly_paid_count    integer,
  unpaid_count         integer,
  exempt_count         integer,
  expected_kobo        bigint,
  received_kobo        bigint,
  outstanding_kobo     bigint,
  outstanding_complete boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_c public.collections%rowtype;
  v_awaiting integer;
begin
  select * into v_c from public.collections c where c.id = p_collection_id;
  if v_c.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if not app.has_permission_for_collection(p_collection_id, 'transaction.view') then
    raise exception 'FORBIDDEN: missing permission transaction.view for collection %', p_collection_id using errcode = '42501';
  end if;

  if v_c.participation_mode <> 'managed' or v_c.audience_mode = 'public' then
    return query select false, 'no_member_list'::text, 0, 0, 0, 0, 0, 0::bigint, 0::bigint, 0::bigint, true;
    return;
  end if;
  if v_c.schedule = 'recurring' then
    return query select false, 'recurring_collection'::text, 0, 0, 0, 0, 0, 0::bigint, 0::bigint, 0::bigint, true;
    return;
  end if;

  select count(*)::integer into v_awaiting
  from app.resolve_collection_audience(p_collection_id) a
  where not exists (
    select 1 from public.obligations o
    where o.collection_id = p_collection_id and o.member_id = a.member_id and o.status <> 'cancelled');

  return query
  with obl as (
    select o.id, o.exempt,
           (o.expected_amount_kobo - o.waived_amount_kobo)::bigint as due
    from public.obligations o
    where o.collection_id = p_collection_id and o.status <> 'cancelled'
  ),
  got as (
    select c.obligation_id, sum(c.contribution_kobo)::bigint as amount
    from public.contributions c
    where c.collection_id = p_collection_id and c.status = 'applied' and c.obligation_id is not null
    group by c.obligation_id
  ),
  r as (
    select o.exempt, o.due, least(coalesce(g.amount, 0), o.due)::bigint as received
    from obl o left join got g on g.obligation_id = o.id
  ),
  fixed as (
    select case when v_c.amount_model = 'fixed' and v_c.fixed_amount_kobo is not null
                then v_c.fixed_amount_kobo::bigint end as each
  )
  select
    true,
    null::text,
    ((select count(*) from r where not r.exempt) + v_awaiting)::integer,
    (select count(*) from r where not r.exempt and r.received >= r.due)::integer,
    (select count(*) from r where not r.exempt and r.received > 0 and r.received < r.due)::integer,
    ((select count(*) from r where not r.exempt and r.received = 0 and r.due > 0) + v_awaiting)::integer,
    (select count(*) from r where r.exempt)::integer,
    ((select coalesce(sum(r.due), 0) from r where not r.exempt)
       + v_awaiting * coalesce((select each from fixed), 0))::bigint,
    (select coalesce(sum(r.received), 0) from r where not r.exempt)::bigint,
    ((select coalesce(sum(r.due - r.received), 0) from r where not r.exempt)
       + v_awaiting * coalesce((select each from fixed), 0))::bigint,
    (v_awaiting = 0 or (select each from fixed) is not null);
end;
$$;

comment on function app.collection_expected_summary(uuid) is
  'Expected-payer counts and the amount members are still expected to pay. Not money received; never part of a balance. Reads only.';

revoke all on function app.collection_expected_summary(uuid) from public;
grant execute on function app.collection_expected_summary(uuid) to authenticated;
