-- ─────────────────────────────────────────────────────────────────────────────
-- 20261117120100 — The collection ledger, filtered by kind of movement
--
-- READS ONLY. The same rows as app.collection_ledger (20261117100300) — same
-- permission (balance.view), same collection-scope legs, platform legs never
-- shown (D-28) — with the filter applied in the database BEFORE paging, so a
-- filtered page is a true page and its total is the filtered total.
--
--   kind            source types
--   all             every journal
--   contributions   capture
--   fees            fee
--   settlement      balance_release, provider_settlement
--   withdrawals     withdrawal, payout, and any reversal of a withdrawal
--   refunds         refund, dispute_hold, chargeback
--   adjustments     adjustment, reversal (other than a withdrawal's)
--
-- Additive: app.collection_ledger is unchanged. Rollback: drop the function.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.collection_ledger_by_kind(
  p_collection_id uuid,
  p_kind          text,
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
  if p_kind is null or p_kind not in ('all', 'contributions', 'fees', 'settlement', 'withdrawals', 'refunds', 'adjustments') then
    raise exception 'INVALID_KIND: unknown ledger filter %', p_kind using errcode = '22023';
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
      and (
        p_kind = 'all'
        or (p_kind = 'contributions' and jr.source_type = 'capture')
        or (p_kind = 'fees' and jr.source_type = 'fee')
        or (p_kind = 'settlement' and jr.source_type::text in ('balance_release', 'provider_settlement'))
        or (p_kind = 'withdrawals' and (jr.source_type::text in ('withdrawal', 'payout')
              or exists (select 1 from public.withdrawals w where w.id = jr.source_id)))
        or (p_kind = 'refunds' and jr.source_type::text in ('refund', 'dispute_hold', 'chargeback'))
        or (p_kind = 'adjustments' and jr.source_type::text in ('adjustment', 'reversal')
              and not exists (select 1 from public.withdrawals w where w.id = jr.source_id))
      )
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

revoke all on function app.collection_ledger_by_kind(uuid, text, integer, integer) from public;
grant execute on function app.collection_ledger_by_kind(uuid, text, integer, integer) to authenticated;

comment on function app.collection_ledger_by_kind(uuid, text, integer, integer) is
  'app.collection_ledger with a kind-of-movement filter applied before paging. balance.view. Reads only.';
