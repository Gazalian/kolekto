-- ─────────────────────────────────────────────────────────────────────────────
-- 20261117100300 — Ledger activity, settlement summary and reconciliation reads
--
-- Design: docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md §5
--
-- READS ONLY. Nothing here writes.
--
--   app.collection_settlement_summary(collection)  balance.view
--       Pending split into "scheduled" (not yet due), "awaiting provider" (due,
--       provider settlement not confirmed) and "discrepancy"; released total;
--       next release time; whether the collection reconciles.
--   app.collection_ledger(collection, limit, offset)  balance.view
--       One row per journal that moved this collection's money, with the
--       signed effect on each collection account and the collection-scope
--       legs only. Platform-only journals (the provider's own fee, the
--       provider's settlement to Kolekto) are NOT returned and platform legs
--       are never shown: Paystack's cost to Kolekto is never shown (D-28).
--   app.collection_reconciliation(collection)  balance.view
--       Each displayed figure against an independent derivation from the
--       source records, with the difference.
--   app.platform_reconciliation()  operator session only
--       The same identities across every collection plus the platform
--       accounts (receivable, settled funds, payouts).
--
-- Additive. Rollback: drop the four functions.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Settlement summary ───────────────────────────────────────────────────

create or replace function app.collection_settlement_summary(p_collection_id uuid)
returns table (
  scheduled_kobo           bigint,
  scheduled_count          integer,
  awaiting_provider_kobo   bigint,
  awaiting_provider_count  integer,
  discrepancy_kobo         bigint,
  discrepancy_count        integer,
  released_kobo            bigint,
  released_count           integer,
  next_release_at          timestamptz,
  last_release_at          timestamptz,
  schedule_version         text,
  schedule_timezone        text,
  schedule_release_time    time,
  schedule_day_offset      smallint,
  requires_provider_confirmation boolean,
  reconciled               boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := now();
begin
  if not exists (select 1 from public.collections c where c.id = p_collection_id) then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if not app.has_permission_for_collection(p_collection_id, 'balance.view') then
    raise exception 'FORBIDDEN: missing permission balance.view for collection %', p_collection_id using errcode = '42501';
  end if;

  return query
  with s as (
    select s.*, sch.requires_provider_confirmation as needs_conf
    from public.contribution_settlements s
    join public.settlement_schedules sch on sch.version = s.schedule_version
    where s.collection_id = p_collection_id
  ),
  cur as (
    select sch.* from public.settlement_schedules sch
    where sch.version = app.settlement_schedule_version_at(v_now)
  )
  select
    coalesce(sum(s.net_kobo) filter (where s.status = 'pending' and s.scheduled_release_at > v_now), 0)::bigint,
    (count(*) filter (where s.status = 'pending' and s.scheduled_release_at > v_now))::integer,
    coalesce(sum(s.net_kobo) filter (where s.status = 'pending' and s.scheduled_release_at <= v_now), 0)::bigint,
    (count(*) filter (where s.status = 'pending' and s.scheduled_release_at <= v_now))::integer,
    coalesce(sum(s.net_kobo) filter (where s.status = 'discrepancy'), 0)::bigint,
    (count(*) filter (where s.status = 'discrepancy'))::integer,
    coalesce(sum(s.net_kobo) filter (where s.status = 'released'), 0)::bigint,
    (count(*) filter (where s.status = 'released'))::integer,
    min(s.scheduled_release_at) filter (where s.status = 'pending' and s.scheduled_release_at > v_now),
    max(s.released_at),
    (select cur.version from cur),
    (select cur.timezone from cur),
    (select cur.release_time from cur),
    (select cur.release_day_offset from cur),
    (select cur.requires_provider_confirmation from cur),
    not exists (select 1 from app.collection_reconciliation_checks(p_collection_id) r where not r.ok)
  from s;
end;
$$;


-- ── 2. Reconciliation checks (internal, no permission check) ────────────────
--
-- Identities, each true by construction when every writer is correct:
--   pending      ledger collection_pending      = Σ net of settlements pending/discrepancy
--   released     ledger available + on_hold + withdrawing + withdrawn
--                + chargeback + refund_reserve   = Σ net released − Σ fees of paid withdrawals
--   withdrawing  ledger collection_withdrawing  = Σ (amount + fee) of open withdrawals
--   withdrawn    ledger collection_withdrawn    = Σ amount of paid withdrawals
--   raised       Σ applied contribution_kobo − Σ (contribution − net)
--                                               = ledger pending + released position
--                                                 + Σ fees of paid withdrawals
--   settlements  every applied contribution has a settlement row
--   balanced     every journal of the collection balances

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
      coalesce(sum(w.fee_kobo) filter (where w.status = 'paid'), 0)::bigint as paid_fees
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

create or replace function app.collection_reconciliation(p_collection_id uuid)
returns table (check_name text, expected_kobo bigint, ledger_kobo bigint, difference_kobo bigint, ok boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.collections c where c.id = p_collection_id) then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if not app.has_permission_for_collection(p_collection_id, 'balance.view') then
    raise exception 'FORBIDDEN: missing permission balance.view for collection %', p_collection_id using errcode = '42501';
  end if;
  return query select * from app.collection_reconciliation_checks(p_collection_id);
end;
$$;

revoke all on function app.collection_settlement_summary(uuid) from public;
revoke all on function app.collection_reconciliation(uuid)     from public;
grant execute on function app.collection_settlement_summary(uuid) to authenticated;
grant execute on function app.collection_reconciliation(uuid)     to authenticated;


-- ── 3. Ledger activity for organisers ───────────────────────────────────────

create or replace function app.collection_ledger(
  p_collection_id uuid,
  p_limit         integer default 50,
  p_offset        integer default 0
)
returns table (
  journal_id          uuid,
  occurred_at         timestamptz,
  posted_at           timestamptz,
  source_type         text,
  reason              text,
  reference           text,
  pending_change      bigint,
  available_change    bigint,
  withdrawing_change  bigint,
  withdrawn_change    bigint,
  other_change        bigint,
  entries             jsonb,
  reverses_journal_id uuid,
  total_count         bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not exists (select 1 from public.collections c where c.id = p_collection_id) then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if not app.has_permission_for_collection(p_collection_id, 'balance.view') then
    raise exception 'FORBIDDEN: missing permission balance.view for collection %', p_collection_id using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 or p_offset is null or p_offset < 0 then
    raise exception 'INVALID_PAGE: limit 1..200, offset ≥ 0' using errcode = '22023';
  end if;

  return query
  with legs as (
    -- Collection-scope legs only, signed by the liability's natural balance
    -- (credit increases what the collection holds).
    select e.journal_id, a.code,
           case when e.direction = 'credit' then e.amount_kobo else -e.amount_kobo end::bigint as signed,
           e.direction::text as direction, e.amount_kobo::bigint as amount
    from public.ledger_entries e
    join public.ledger_accounts a on a.id = e.account_id
    where a.collection_id = p_collection_id
  ),
  j as (
    select jr.*, count(*) over () as total
    from public.ledger_journals jr
    where jr.collection_id = p_collection_id
      and exists (select 1 from legs l where l.journal_id = jr.id)
  ),
  page as (
    select * from j order by j.occurred_at desc, j.posted_at desc, j.id desc
    limit p_limit offset p_offset
  )
  select
    p.id, p.occurred_at, p.posted_at, p.source_type::text, p.reason,
    coalesce(
      (select a.reference from public.contributions c join public.payment_attempts a on a.id = c.attempt_id
        where c.id = p.source_id),
      (select w.reference from public.withdrawals w where w.id = p.source_id)),
    coalesce((select sum(l.signed) from legs l where l.journal_id = p.id and l.code = 'collection_pending'), 0)::bigint,
    coalesce((select sum(l.signed) from legs l where l.journal_id = p.id and l.code = 'collection_available'), 0)::bigint,
    coalesce((select sum(l.signed) from legs l where l.journal_id = p.id and l.code = 'collection_withdrawing'), 0)::bigint,
    coalesce((select sum(l.signed) from legs l where l.journal_id = p.id and l.code = 'collection_withdrawn'), 0)::bigint,
    coalesce((select sum(l.signed) from legs l where l.journal_id = p.id
               and l.code not in ('collection_pending', 'collection_available', 'collection_withdrawing', 'collection_withdrawn')), 0)::bigint,
    (select jsonb_agg(jsonb_build_object('account', l.code, 'direction', l.direction, 'amount_kobo', l.amount::text)
                      order by l.direction desc, l.code)
       from legs l where l.journal_id = p.id),
    p.reverses_journal_id,
    p.total
  from page p
  order by p.occurred_at desc, p.posted_at desc, p.id desc;
end;
$$;

revoke all on function app.collection_ledger(uuid, integer, integer) from public;
grant execute on function app.collection_ledger(uuid, integer, integer) to authenticated;

comment on function app.collection_ledger(uuid, integer, integer) is
  'balance.view: the journals that moved this collection''s money, newest first, with the signed change to pending / available / withdrawing / withdrawn and the collection-scope legs. Platform legs (fee income, provider cost, provider receivable, settled funds, payouts) are never returned.';


-- ── 4. Platform reconciliation (operators) ──────────────────────────────────

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
  wd as (
    select coalesce(sum(w.amount_kobo) filter (where w.status = 'paid'), 0)::bigint as paid_kobo
    from public.withdrawals w
  ),
  rows as (
    select 'provider_receivable_vs_unconfirmed'::text as check_name, st.unconfirmed_expected as expected, b.receivable as ledger from st, b
    union all
    select 'collection_pending_vs_unreleased', st.unreleased, b.pending from st, b
    union all
    select 'withdrawn_vs_paid_withdrawals', wd.paid_kobo, b.withdrawn from wd, b
    union all
    select 'organiser_payouts_vs_withdrawn', b.withdrawn, b.payouts from b
    -- Released organiser money still held must be covered by money the
    -- provider has confirmed: the system must never show more available than
    -- it actually holds. Ledger column = settled funds; expected = what it
    -- must at least cover. ok when covered.
    union all
    select 'settled_funds_cover_released_liabilities', b.available + b.withdrawing, b.settled_funds from b
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
         case when r.check_name = 'settled_funds_cover_released_liabilities' then r.ledger >= r.expected
              else r.ledger = r.expected end
  from rows r;
end;
$$;
revoke execute on function app.platform_reconciliation() from public, anon, authenticated;

comment on function app.platform_reconciliation() is
  'Operator: platform-wide ledger identities — receivable vs unconfirmed provider settlements, pending vs unreleased settlements, withdrawn vs paid withdrawals vs payouts contra, settled funds covering available + withdrawing, every contribution scheduled, every journal balanced, no negative available balance.';
