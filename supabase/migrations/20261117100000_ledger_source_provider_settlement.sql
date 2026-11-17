-- ─────────────────────────────────────────────────────────────────────────────
-- 20261117100000 — ledger source type `provider_settlement`
--
-- Its own file because a new enum value cannot be used in the transaction that
-- adds it. 20261117100100 uses it.
--
-- `provider_settlement`: the payment provider confirmed that it settled one
-- captured payment to Kolekto (Dr provider_settled_funds, Cr
-- provider_receivable). Platform legs only; carries the collection the payment
-- belongs to so the attribution CHECK holds and a platform reconciliation can
-- still group by collection.
--
-- Additive. Rollback: an enum value cannot be dropped in place; it is harmless
-- unused. (Recreate the type only if it must go, after removing every user.)
-- ─────────────────────────────────────────────────────────────────────────────

alter type public.ledger_source_type add value if not exists 'provider_settlement';
