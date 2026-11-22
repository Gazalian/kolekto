-- ─────────────────────────────────────────────────────────────────────────────
-- 20261122100000 — Transfer reconciliation: provider-verification grace period
--                  (session 42, owner brief 2026-11-22)
--
-- Observed 2026-11-22: the worker's reconciliation run read Paystack's
-- transfer list seconds after dispatching ktr_6a1c…, before the new transfer
-- appeared in that list, and recorded `missing_at_provider` (warning) for a
-- transfer Paystack had in fact created, approved and paid.
--
-- The comparison (packages/payments/src/transfer-reconciliation.ts) now:
--   · records a transfer sent less than the grace period ago (initially
--     5 minutes) and not yet in the list as `provider_verification_pending`
--     (info) — visible, never `missing_at_provider`;
--   · after the grace period, asks Paystack by reference (read-only verify)
--     before raising `missing_at_provider`; found → compared normally,
--     not found or unverifiable → `missing_at_provider` as before.
--
-- This migration only lets the database store that:
--   1. `provider_verification_pending` joins the allowed discrepancy kinds.
--   2. transfer_reconciliation_runs.provider_grace_seconds records the grace
--      period each run used (null = a run from before this change).
--   3. app.record_transfer_reconciliation_run stores (2). Same signature,
--      same grants, same atomic insert; nothing else is written.
--
-- Financial effect: none. No journal, balance, transfer, withdrawal or
-- existing discrepancy row is read differently, changed or resolved. A
-- pending-verification finding never fails, settles, releases or re-sends a
-- transfer; reconciliation still never initiates anything.
--
-- ROLLBACK (only while no row has kind 'provider_verification_pending' —
-- discrepancies are append-only and cannot be deleted):
--   alter table public.transfer_reconciliation_discrepancies drop constraint transfer_recon_kind;
--   alter table public.transfer_reconciliation_discrepancies add constraint transfer_recon_kind check (kind in (
--     'missing_at_provider', 'missing_in_kolekto', 'foreign_reference', 'amount_mismatch', 'reference_mismatch',
--     'recipient_mismatch', 'status_mismatch', 'stale_open', 'duplicate_provider_record', 'duplicate_approval_requests',
--     'success_not_in_ledger'));
--   re-run section 13's app.record_transfer_reconciliation_run from 20261119120000;
--   alter table public.transfer_reconciliation_runs drop column provider_grace_seconds;
-- Once such a row exists, leave the constraint widened; the previous
-- application code simply never writes the new kind.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The new kind ─────────────────────────────────────────────────────────

alter table public.transfer_reconciliation_discrepancies drop constraint transfer_recon_kind;
alter table public.transfer_reconciliation_discrepancies add constraint transfer_recon_kind check (kind in (
  'missing_at_provider', 'missing_in_kolekto', 'foreign_reference', 'amount_mismatch', 'reference_mismatch',
  'recipient_mismatch', 'status_mismatch', 'stale_open', 'duplicate_provider_record', 'duplicate_approval_requests',
  'success_not_in_ledger', 'provider_verification_pending'));

comment on column public.transfer_reconciliation_discrepancies.kind is
  'What disagreed. provider_verification_pending (info, 20261122100000): sent less than the run''s grace period ago and '
  'not yet in the provider list; re-checked by a later run, never treated as missing, failed or paid.';


-- ── 2. The grace period a run used ──────────────────────────────────────────

alter table public.transfer_reconciliation_runs
  add column provider_grace_seconds integer,
  add constraint transfer_recon_grace check (provider_grace_seconds is null or provider_grace_seconds between 0 and 86400);

comment on column public.transfer_reconciliation_runs.provider_grace_seconds is
  'Seconds after dispatch during which a transfer absent from the provider list is pending verification, not missing. '
  'Null for runs recorded before 20261122100000.';


-- ── 3. Store it ─────────────────────────────────────────────────────────────

create or replace function app.record_transfer_reconciliation_run(p_run jsonb, p_discrepancies jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := app.uuid_generate_v7();
begin
  perform app.assert_payment_operator_session();
  if jsonb_typeof(p_discrepancies) <> 'array' then
    raise exception 'INVALID_DISCREPANCIES: an array is required' using errcode = '22023';
  end if;
  insert into public.transfer_reconciliation_runs (id, started_at, window_from, window_to, provider_mode,
                                                   provider_count, kolekto_count, discrepancy_count, provider_grace_seconds)
  values (v_id, (p_run ->> 'started_at')::timestamptz, (p_run ->> 'window_from')::timestamptz,
          (p_run ->> 'window_to')::timestamptz, p_run ->> 'provider_mode',
          (p_run ->> 'provider_count')::integer, (p_run ->> 'kolekto_count')::integer,
          jsonb_array_length(p_discrepancies), (p_run ->> 'provider_grace_seconds')::integer);
  insert into public.transfer_reconciliation_discrepancies (run_id, kind, severity, reference, transfer_id,
                                                            kolekto_detail, provider_detail)
  select v_id, d ->> 'kind', d ->> 'severity', left(d ->> 'reference', 100),
         (select t.id from public.withdrawal_transfers t where t.reference = d ->> 'reference'),
         left(d ->> 'kolekto_detail', 500), left(d ->> 'provider_detail', 500)
  from jsonb_array_elements(p_discrepancies) d;
  return v_id;
end;
$$;
revoke execute on function app.record_transfer_reconciliation_run(jsonb, jsonb) from public, anon, authenticated;
