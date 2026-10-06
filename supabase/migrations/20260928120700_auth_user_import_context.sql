-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928120700 — The sign-up trigger stands aside for an import, and only then
--
-- Import Foundations, Phase 8. Decision: docs/migration/IMPORT-FOUNDATIONS-REPORT.md §7.
-- Tests: supabase/tests/29_auth_user_import_context.sql (Part 1 characterised
-- today's behaviour and passed BEFORE this migration existed).
--
-- WHAT app.handle_new_auth_user DOES — AFTER INSERT on every auth.users row, as
-- `postgres` (SECURITY DEFINER):
--   1. public.users — name from auth metadata, else the email's local part;
--      phone from auth.users.phone; ON CONFLICT (id) DO NOTHING
--   2. a NEW personal community, every time, with a generated unique slug
--   3. an owner term, start_reason 'created'
--
-- WHY THAT IS WRONG FOR AN IMPORT, and cannot be repaired afterwards:
--   · the name and phone would come from auth metadata, not the legacy profile —
--     F-M1 says the phone comes from profiles.phone_number;
--   · every imported owner term would say 'created', indistinguishable from a
--     real sign-up, where the enum already has 'migration' for exactly this;
--   · nothing would record that the import made these rows;
--   · correcting any of it needs UPDATE, which the importer does not hold.
--
-- WHAT WAS CONSIDERED AND REJECTED
--   · session_replication_role = replica — disables EVERY trigger, including the
--     immutability and validation triggers the import most needs.
--   · Let it run, fix up afterwards — needs UPDATE; and the slugs, names and
--     phones it produced would still be the wrong ones first.
--   · Insert public.users before auth.users so ON CONFLICT keeps ours —
--     impossible: public.users.id references auth.users.
--
-- THE DECISION: an explicit, transaction-local import context.
--
--     select set_config('kolekto.import_run_id', '<running run id>', true);
--
-- While it names a RUNNING import run, the trigger creates nothing. The importer
-- then creates the user (from the legacy profile, F-M1), the personal community
-- (F-L1 / COM-01 — one per imported user, exactly as a sign-up would have) and the
-- owner term (start_reason 'migration'), and records each in
-- migration.imported_objects.
--
--   · unset or empty              ordinary sign-up, unchanged — every real sign-up
--   · names a running run         the trigger stands aside
--   · set, but malformed, unknown REFUSED. Falling back to ordinary behaviour
--     or finished                 would create exactly the uncontrolled objects the
--                                 context exists to prevent.
--
-- It cannot be switched on from outside. Using it takes the right to insert into
-- auth.users AND the right to open an import run — together, owner-level access.
-- No client role holds either (29, Part 4). The `true` in set_config makes it end
-- with the transaction, so it cannot leak into a later one.
--
-- Everything below the context check is the function exactly as it was.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_full_name    text;
  v_phone        text;
  v_community_id uuid;
  v_import_run   text := nullif(current_setting('kolekto.import_run_id', true), '');
begin
  -- ── Import context ─────────────────────────────────────────────────────────
  if v_import_run is not null then
    if v_import_run !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (
         select 1 from migration.import_runs r
         where r.id = v_import_run::uuid and r.status = 'running'
       ) then
      raise exception 'IMPORT_CONTEXT_INVALID: kolekto.import_run_id is set to % but that is not a running import run', v_import_run
        using errcode = 'P0001',
              hint = 'Clear it (set_config(''kolekto.import_run_id'', '''', true)) for an ordinary sign-up, or open the run first.';
    end if;
    -- The importer creates this user's public.users row, personal community and
    -- owner term itself, from the legacy profile, and registers them.
    return new;
  end if;

  -- ── Ordinary sign-up — unchanged ───────────────────────────────────────────
  v_full_name := nullif(trim(new.raw_user_meta_data ->> 'full_name'), '');
  if v_full_name is null then
    -- No name yet — sign-up is OTP-only and collects no name up front. The
    -- person completes their profile from Settings; this is a placeholder
    -- that satisfies users_full_name_length, never a guess presented as real.
    v_full_name := coalesce(split_part(new.email::text, '@', 1), 'New member');
  end if;
  -- users_full_name_length caps at 120; leave room below for "'s collections"
  -- (14 chars) against communities_name_length's 80-character cap.
  v_full_name := left(v_full_name, 66);

  v_phone := app.normalise_phone(new.phone);

  insert into public.users (id, full_name, phone_e164, email)
  values (new.id, v_full_name, v_phone, new.email)
  on conflict (id) do nothing;

  v_community_id := app.uuid_generate_v7();

  insert into public.communities (id, slug, name, type, is_personal, created_by)
  values (
    v_community_id,
    app.generate_unique_community_slug(coalesce(v_full_name, 'my') || '-collections'),
    left(v_full_name || '''s collections', 80),
    'personal',
    true,
    new.id
  );

  insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason)
  values (v_community_id, new.id, 'owner', v_full_name, 'created');

  return new;
end;
$$;

-- Reachability, stated: it is a trigger function, fired by auth.users, never
-- called. Stating it removes it from the sixth invariant's grandfather list.
revoke execute on function app.handle_new_auth_user() from public, anon, authenticated;
