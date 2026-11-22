-- ─────────────────────────────────────────────────────────────────────────────
-- 20261118100000 — `reversed` withdrawal status
--
-- A Paystack transfer can succeed and later be reversed by the receiving bank
-- (transfer.reversed). The withdrawal keeps its paid history and moves to
-- `reversed`; the money returns to the collection's available balance by a
-- reversal journal (20261118100100).
--
-- Its own file because a new enum value cannot be used in the transaction that
-- adds it (same pattern as 20261117100000).
--
-- Additive. Rollback: none needed while no row uses the value (Postgres cannot
-- drop an enum value; an unused value is harmless).
-- ─────────────────────────────────────────────────────────────────────────────

alter type public.withdrawal_status add value if not exists 'reversed';
