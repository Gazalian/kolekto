-- ---------------------------------------------------------------------------
-- 20260930110000 -- Authentication & onboarding architecture
--
-- Three changes in one migration, all additive:
--
--   1. Add onboarding_completed_at to public.users so the application can
--      distinguish new users (NULL) from users who completed first-time
--      setup (non-NULL). Existing users are backfilled from their
--      created_at so they are never forced through onboarding.
--
--   2. Replace handle_new_auth_user() so it creates only the public.users
--      row, without auto-creating a personal community or owner term.
--      Community creation moves into the onboarding flow (app.create_community).
--
--   3. Add app.complete_onboarding() — sets onboarding_completed_at for
--      the calling user. Called after the user creates their first community
--      during the onboarding flow.
--
--   4. Add app.update_user_profile() — lets a user update their own
--      full_name and phone_e164 through the account settings page.
--
-- Existing users, communities, officer terms, RLS, and RBAC are unchanged.
-- ---------------------------------------------------------------------------


-- 1. Add onboarding_completed_at column
alter table public.users
  add column if not exists onboarding_completed_at timestamptz;

comment on column public.users.onboarding_completed_at is
  'NULL means the user has not completed first-time onboarding. Set when they create their first community during the onboarding flow.';


-- 2. Backfill: every existing user who has a personal community is already
--    "onboarded" — use their created_at as a safe historical timestamp.
update public.users
set onboarding_completed_at = users.created_at
where onboarding_completed_at is null
  and exists (
    select 1 from public.communities
    where communities.created_by = users.id
      and communities.is_personal = true
  );


-- 3. Replace bootstrap trigger function.
--    The trigger on auth.users INSERT still fires, but now it only creates
--    the public.users row — no community, no officer term. Those are created
--    during onboarding via the existing app.create_community function.
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_full_name    text;
  v_phone        text;
begin
  v_full_name := nullif(trim(new.raw_user_meta_data ->> 'full_name'), '');
  if v_full_name is null then
    v_full_name := coalesce(
      nullif(trim(split_part(new.email::text, '@', 1)), ''),
      'New member'
    );
  end if;
  v_full_name := left(v_full_name, 120);

  v_phone := app.normalise_phone(
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'phone_e164'), ''),
      new.phone
    )
  );

  insert into public.users (id, full_name, phone_e164, email)
  values (new.id, v_full_name, v_phone, new.email)
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function app.handle_new_auth_user() is
  'Creates the public.users row from auth.users. Community and officer term creation moved to onboarding (app.create_community).';


-- 4. Onboarding completion function.
--    Called after the user creates their first community during onboarding.
--    Idempotent: a second call is a no-op (already onboarded).
create or replace function app.complete_onboarding()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  update public.users
  set onboarding_completed_at = now()
  where id = v_user_id
    and onboarding_completed_at is null;
end;
$$;

comment on function app.complete_onboarding() is
  'Marks the calling user as having completed first-time onboarding. Idempotent.';

revoke all on function app.complete_onboarding() from public;
grant execute on function app.complete_onboarding() to authenticated;


-- 5. User profile update function.
--    Lets a user update their own name and phone. Uses the same
--    write-through-DB-function pattern as every other write.
create or replace function app.update_user_profile(
  p_full_name      text,
  p_phone_e164     text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_phone   text;
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if p_full_name is null or char_length(trim(p_full_name)) < 1 then
    raise exception 'INVALID_NAME: full name is required' using errcode = 'P0001';
  end if;
  if char_length(p_full_name) > 120 then
    raise exception 'INVALID_NAME: full name must be at most 120 characters' using errcode = 'P0001';
  end if;

  v_phone := app.normalise_phone(p_phone_e164);
  if p_phone_e164 is not null and v_phone is null then
    raise exception 'INVALID_PHONE: could not normalise phone number' using errcode = 'P0001';
  end if;

  update public.users
  set full_name = trim(p_full_name),
      phone_e164 = v_phone
  where id = v_user_id;
end;
$$;

comment on function app.update_user_profile(text, text) is
  'Lets a user update their own name and phone. Phone is normalised to E.164.';

revoke all on function app.update_user_profile(text, text) from public;
grant execute on function app.update_user_profile(text, text) to authenticated;


-- 6. Function to set identity_level to contact_verified after email verification.
create or replace function app.set_contact_verified()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  update public.users
  set identity_level = 'contact_verified'
  where id = v_user_id
    and identity_level = 'none';
end;
$$;

comment on function app.set_contact_verified() is
  'Sets identity_level to contact_verified after email OTP verification. Idempotent — only upgrades from none.';

revoke all on function app.set_contact_verified() from public;
grant execute on function app.set_contact_verified() to authenticated;
