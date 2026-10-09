-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009100000 — Delivery status values for the email sender (M13.2 P2)
--
-- Adds the two states the email delivery state machine needs and M13.1 does not
-- have (docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md §10.2):
--
--   sending  the sender has claimed the row and holds a lease on it. A row left
--            in `sending` with an expired lease is reclaimable (crash recovery).
--   dead     retries are exhausted, or the failure is permanent. The row is
--            kept for the record and is never retried.
--
-- This is its own migration, and nothing else is in it, because a value added by
-- ALTER TYPE ... ADD VALUE cannot be used (in a constraint, a default, an index
-- predicate) in the same transaction that adds it. The migration that uses these
-- values is 20261009100100. The same split is used for officer_term_start_reason
-- (20260918130100).
--
-- Purely additive. No row changes, nothing is renamed, existing values and their
-- order are untouched, and nothing uses the new values until the sender exists
-- (P5), so applying this to a database that holds data is safe and is rolled back
-- by simply not using the values (Postgres cannot drop an enum value, which is why
-- there is no down-migration — an unused value is inert).
-- ─────────────────────────────────────────────────────────────────────────────

alter type public.notification_delivery_status add value if not exists 'sending';
alter type public.notification_delivery_status add value if not exists 'dead';
