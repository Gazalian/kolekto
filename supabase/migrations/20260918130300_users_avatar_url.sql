-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918130300 — Phase 1.5 / M5: users.avatar_url
--
-- Migration Architecture section 4.1 and section 15 (M5). Production
-- `profiles.avatar_url` exists and has no Phase 1 equivalent. Small, and worth
-- doing now rather than parking: a user's own profile picture is not a legacy
-- field with an ambiguous meaning like a ticketing flag — it maps one-to-one
-- and there is no product reason to defer it.
--
-- "Map this to profiles.avatar_url during the future migration. Do not migrate
-- the value now." (Phase 1.5 brief, Part C, M5.) This migration adds the
-- column only. No row is touched — public.users has zero rows outside pgTAP
-- fixtures at this point in the project.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.users
  add column avatar_url text;

comment on column public.users.avatar_url is
  'A signed URL or storage path to the user''s profile picture. Maps to profiles.avatar_url in the old schema (Migration Architecture section 4.1). Populated by the migration pipeline when it runs, or by the user directly — never defaulted or invented.';
