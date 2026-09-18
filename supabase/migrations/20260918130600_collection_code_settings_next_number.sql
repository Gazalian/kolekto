-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918130600 — Phase 1.5 / M8: contributor code sequence state
--
-- Migration Architecture section 4.3 and section 15 (M8). Production tracks
-- the next contributor code per collection two ways: `collections.
-- next_contributor_number` and a dedicated `contribution_code_counters` table
-- (53 rows, one per collection using codes). Verified read-only against
-- production on 2026-09-18: max(contribution_code_counters.next_number) =
-- 7658, max(collections.next_contributor_number) = 556. Without carrying this
-- state forward, a migrated collection's codes would restart from the
-- beginning and collide with codes already printed on tickets, receipts and
-- pickup slips.
--
-- CODE-04 (PRD): "Codes are unique within the collection, never reused." A
-- restarted sequence is exactly how that promise breaks.
--
-- "Do not populate production sequence values yet" (Phase 1.5 brief, Part C,
-- M8) — this migration adds the column only. The value is carried forward by
-- the migration pipeline when it runs, not by this migration.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.collection_code_settings
  add column next_number bigint not null default 1;

alter table public.collection_code_settings
  add constraint collection_code_settings_next_number_positive
  check (next_number >= 1);

comment on column public.collection_code_settings.next_number is
  'The next sequence value to issue for CODE-02 sequential codes. Starts at 1 for every new collection. For a migrated collection, this is set by the migration pipeline to continue the old collections.next_contributor_number / contribution_code_counters.next_number sequence, so a code already printed can never be reissued (CODE-04). Not populated by this migration.';
