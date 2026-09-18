-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918130100 — Phase 1.5 / M2: 'migration' as an officer-term start reason
--
-- Migration Architecture section 4.2 and section 15 (M2). 113 old organizers
-- will eventually each need an owner officer_term whose start_reason correctly
-- says how that authority began — not 'created' (nobody founded this community
-- through the new sign-up flow) and not 'invited' (nobody sent them an
-- invitation). Both existing values would misrepresent history.
--
-- This migration makes the schema CAPABLE of representing that. It creates NO
-- officer_terms rows and grants NO authority to anyone — the brief is explicit:
-- "Do not create the data yet." Verified against the current enum
-- (20260917120100_enums.sql): 'created', 'invited', 'handover', 'recovery'.
-- 'migration' is a genuinely new fifth case, not a duplicate of any existing one.
--
-- ALTER TYPE ... ADD VALUE runs outside an explicit transaction block here
-- (no BEGIN/COMMIT in this file) because a newly added enum value cannot be
-- used in the same transaction that adds it — PostgreSQL enforces this
-- regardless of version. Supabase applies each migration file as its own
-- transaction, so keeping this addition in its own file, with nothing in the
-- same file that could reference the new value, is what makes this safe rather
-- than merely convenient.
-- ─────────────────────────────────────────────────────────────────────────────

alter type public.officer_term_start_reason add value 'migration';

comment on type public.officer_term_start_reason is
  'How an officer term began. ''migration'' (added 2026-09-18, Phase 1.5 / M2) represents authority carried forward from the old Kolekto platform during the eventual data migration — distinct from ''created'' (founded through sign-up) and ''invited'' (sent an invitation), neither of which describes a migrated owner correctly.';
