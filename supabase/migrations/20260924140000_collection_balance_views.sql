-- ─────────────────────────────────────────────────────────────────────────────
-- 20260924140000 — M8.1 step 11b: balances, as views over entries
--
-- A balance is a SUM. It is not a column, it is not a cache, and it is not
-- refreshed.
--
-- The previous system's `wallets` table held five mutable numbers per
-- collection, rewritten nightly by `settlement_recompute_wallets()`. A missing
-- wallet row produced a `console.warn` and an early return — no throw, no
-- retry, no alert — so a balance could silently stop being updated. Production
-- measured ₦3.59 of unexplainable difference between `sum(wallets.net_payment)`
-- and `sum(contributions.amount)` against a stated tolerance of zero kobo.
--
-- Delete every view in this file and every balance in Kolekto is still
-- recoverable by summing `ledger_entries`. That is the test of a source of
-- truth, and `wallets` failed it.
--
-- ── security_invoker ────────────────────────────────────────────────────────
--
-- Every view here runs with the caller's rights, so the RLS on
-- `ledger_journals` and `ledger_entries` still decides which rows a caller
-- sees. The previous system had seven SECURITY DEFINER views, all granted to
-- anon, and they bypassed RLS on contributions and deposits by design.
-- `01_rls_coverage.sql` fails the build if a definer-rights view appears here.
--
-- ── No withdrawal checks a view ─────────────────────────────────────────────
--
-- These exist for screens and reports. A withdrawal asserts availability
-- against the entries themselves, inside its own transaction, with the
-- collection's account rows locked (ADR 0015). A view is a convenience; it is
-- never the thing that authorises money.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Per-account balances ────────────────────────────────────────────────────
--
-- The natural-balance rule, stated once so nobody re-derives it per query:
--
--   asset, expense               debits increase  → balance = debits − credits
--   liability, income, equity    credits increase → balance = credits − debits
--
-- The result is positive when an account holds what it normally holds. A
-- negative figure is therefore meaningful rather than a sign convention: a
-- negative `collection_available` would mean the collection owes money, which
-- is exactly the state a lost chargeback after a withdrawal produces (D-20).

create view public.v_ledger_account_balances
with (security_invoker = true) as
select
  a.id                  as account_id,
  a.community_id,
  a.collection_id,
  a.code,
  a.type,
  a.currency,
  coalesce(sum(case when e.direction = 'debit'  then e.amount_kobo else 0 end), 0)::app.kobo as debits_kobo,
  coalesce(sum(case when e.direction = 'credit' then e.amount_kobo else 0 end), 0)::app.kobo as credits_kobo,
  (
    case
      when a.type in ('asset', 'expense')
        then coalesce(sum(case when e.direction = 'debit'  then e.amount_kobo else -e.amount_kobo end), 0)
      else coalesce(sum(case when e.direction = 'credit' then e.amount_kobo else -e.amount_kobo end), 0)
    end
  )::app.kobo           as balance_kobo,
  count(e.id)           as entry_count,
  max(e.created_at)     as last_entry_at
from public.ledger_accounts a
left join public.ledger_entries e on e.account_id = a.id
group by a.id, a.community_id, a.collection_id, a.code, a.type, a.currency;

comment on view public.v_ledger_account_balances is
  'A balance per account, summed from ledger_entries under the natural-balance rule. Never written, never cached. A negative balance is meaningful, not a sign error — it means the account owes.';


-- ── Per-collection position ─────────────────────────────────────────────────
--
-- The figures a Money screen wants, for one collection, derived rather than
-- stored. Every collection appears, including one that has never received a
-- payment: a collection with no entries reports zeros rather than no row, so a
-- screen never has to distinguish "nothing yet" from "not found".

create view public.v_collection_position
with (security_invoker = true) as
select
  c.id                as collection_id,
  c.community_id,
  coalesce(b.pending_kobo,      0)::app.kobo as pending_kobo,
  coalesce(b.available_kobo,    0)::app.kobo as available_kobo,
  coalesce(b.on_hold_kobo,      0)::app.kobo as on_hold_kobo,
  coalesce(b.withdrawing_kobo,  0)::app.kobo as withdrawing_kobo,
  coalesce(b.withdrawn_kobo,    0)::app.kobo as withdrawn_kobo,
  coalesce(b.chargeback_kobo,   0)::app.kobo as chargeback_kobo,
  coalesce(b.refund_reserve_kobo, 0)::app.kobo as refund_reserve_kobo
from public.collections c
left join (
  select
    v.collection_id,
    sum(case when v.code = 'collection_pending'        then v.balance_kobo else 0 end) as pending_kobo,
    sum(case when v.code = 'collection_available'      then v.balance_kobo else 0 end) as available_kobo,
    sum(case when v.code = 'collection_on_hold'        then v.balance_kobo else 0 end) as on_hold_kobo,
    sum(case when v.code = 'collection_withdrawing'    then v.balance_kobo else 0 end) as withdrawing_kobo,
    sum(case when v.code = 'collection_withdrawn'      then v.balance_kobo else 0 end) as withdrawn_kobo,
    sum(case when v.code = 'collection_chargeback'     then v.balance_kobo else 0 end) as chargeback_kobo,
    sum(case when v.code = 'collection_refund_reserve' then v.balance_kobo else 0 end) as refund_reserve_kobo
  from public.v_ledger_account_balances v
  where v.collection_id is not null
  group by v.collection_id
) b on b.collection_id = c.id;

comment on view public.v_collection_position is
  'D-02: one collection''s financial position, derived from ledger entries. There is no community-level equivalent and there must not be one — a community total is a report, never a thing money is authorised against.';


-- ── Journals that do not balance ────────────────────────────────────────────
--
-- Should always be empty. The deferred constraint trigger refuses an unbalanced
-- journal at commit, so a row here means the trigger was dropped, disabled, or
-- bypassed by a superuser session.
--
-- It exists because "the constraint guarantees it" is a claim worth being able
-- to check cheaply, in production, at 3am, without reasoning about triggers.

create view public.v_ledger_imbalances
with (security_invoker = true) as
select
  j.id            as journal_id,
  j.community_id,
  j.collection_id,
  j.source_type,
  j.occurred_at,
  coalesce(sum(case when e.direction = 'debit'  then e.amount_kobo else 0 end), 0)::app.kobo as debits_kobo,
  coalesce(sum(case when e.direction = 'credit' then e.amount_kobo else 0 end), 0)::app.kobo as credits_kobo,
  (
    coalesce(sum(case when e.direction = 'debit'  then e.amount_kobo else 0 end), 0)
    - coalesce(sum(case when e.direction = 'credit' then e.amount_kobo else 0 end), 0)
  )::app.kobo as difference_kobo
from public.ledger_journals j
left join public.ledger_entries e on e.journal_id = j.id
group by j.id, j.community_id, j.collection_id, j.source_type, j.occurred_at
having coalesce(sum(case when e.direction = 'debit'  then e.amount_kobo else 0 end), 0)
    <> coalesce(sum(case when e.direction = 'credit' then e.amount_kobo else 0 end), 0);

comment on view public.v_ledger_imbalances is
  'Always empty by construction. A row means the balancing constraint was dropped or bypassed. Cheap to check, and the check does not require trusting the trigger.';


grant select on public.v_ledger_account_balances to authenticated;
grant select on public.v_collection_position     to authenticated;
grant select on public.v_ledger_imbalances       to authenticated;
