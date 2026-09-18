-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918140000 — Phase 2: sign-up bootstrap
--
-- COM-01 (ADR 0004): every user gets a personal community at sign-up. The
-- previous phases built the schema that makes this possible (communities,
-- officer_terms) but nothing yet creates the rows. This migration is that
-- wiring, plus the slug helpers every community-creating path needs.
--
-- The trigger fires on `auth.users` INSERT, which is the one moment a Kolekto
-- login is guaranteed to exist and not yet have a `public.users` row. Doing
-- this in the database rather than in application code means a user can never
-- exist without a personal community and an owner term for it — there is no
-- window where a signed-in person has nowhere to act, and no second code path
-- (e.g. a retried client request) that could create it twice.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Slug helpers ─────────────────────────────────────────────────────────────
-- Shared by the sign-up bootstrap below and by app.create_community
-- (20260918140100_application_write_functions.sql). One implementation, so a
-- slug is never allocated two different ways.

create or replace function app.slugify(p_input text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    -- communities_slug_format (20260917120300) requires 3-50 characters,
    -- [a-z0-9] at each end. A name that slugifies to nothing or to something
    -- too short is padded with a short random suffix rather than rejected —
    -- sign-up must never fail because of someone's choice of community name.
    when length(regexp_replace(trim(both '-' from regexp_replace(lower(p_input), '[^a-z0-9]+', '-', 'g')), '^-+|-+$', '', 'g')) >= 3
      then left(regexp_replace(trim(both '-' from regexp_replace(lower(p_input), '[^a-z0-9]+', '-', 'g')), '^-+|-+$', '', 'g'), 50)
    else
      left(
        trim(both '-' from (
          regexp_replace(trim(both '-' from regexp_replace(lower(p_input), '[^a-z0-9]+', '-', 'g')), '^-+|-+$', '', 'g')
          || '-' || encode(extensions.gen_random_bytes(4), 'hex')
        )),
        50
      )
  end;
$$;

comment on function app.slugify(text) is
  'Lowercase, hyphenated slug from a display name, padded with a random suffix when the name alone would be too short for communities_slug_format (COM-04).';

-- Appends -2, -3, ... until the slug is free, checked against both the live
-- table and community_slug_history (COM-04: a released slug is never
-- reissued). Capped so a pathological collision run cannot loop forever.
create or replace function app.generate_unique_community_slug(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_base       text := app.slugify(p_name);
  v_candidate  text := v_base;
  v_suffix     integer := 1;
begin
  loop
    exit when not exists (
      select 1 from public.communities where slug = v_candidate
      union all
      select 1 from public.community_slug_history where slug = v_candidate
    );

    v_suffix := v_suffix + 1;
    v_candidate := left(v_base, 50 - length('-' || v_suffix::text)) || '-' || v_suffix::text;

    if v_suffix > 500 then
      raise exception 'SLUG_ALLOCATION_FAILED: could not allocate a unique slug for % after 500 attempts', p_name
        using errcode = 'P0001';
    end if;
  end loop;

  return v_candidate;
end;
$$;

revoke all on function app.slugify(text)                       from public;
revoke all on function app.generate_unique_community_slug(text) from public;


-- ── Sign-up bootstrap ────────────────────────────────────────────────────────
-- SECURITY DEFINER: runs as the function owner because it writes public.users
-- and public.communities directly, ahead of any officer_term existing to
-- satisfy has_permission. It is not reachable by any client role (no EXECUTE
-- grant to anon or authenticated anywhere) — the only caller is the trigger
-- below, fired by Supabase Auth's own insert into auth.users, which runs as a
-- superuser-equivalent role.
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
begin
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

comment on function app.handle_new_auth_user() is
  'COM-01: creates the login''s public.users row, personal community and owner officer_term in one transaction. Fired by the trigger below; never callable directly by a client role.';

revoke all on function app.handle_new_auth_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();
