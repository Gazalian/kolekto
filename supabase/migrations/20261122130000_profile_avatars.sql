-- ─────────────────────────────────────────────────────────────────────────────
-- 20261122130000 — Profile photos (owner decision D-F, 2026-11-22: approved)
--
-- THE SHAPE, and why (same as collection flyers, 20260920160500):
--
--   bucket       `profile-avatars`, public, 2 MiB, JPEG/PNG/WebP only.
--   object name  {user_id}/{random uuid}.{ext}, chosen by the server, never by
--                the browser. A random name makes the URL unguessable.
--   no listing   unlike collection-covers, NO select policy is created: a
--                public bucket still serves /object/public/<path> to anyone
--                holding the exact URL, but nobody can list the bucket and
--                harvest every user's photo.
--   no client    `anon` and `authenticated` get no INSERT/UPDATE/DELETE on
--   write        storage.objects here; the only writer is the server action,
--                which checks the signed-in user, validates the bytes and
--                uploads with the service role (ADR 0008: the client proposes,
--                the server decides).
--
-- app.set_my_avatar() points users.avatar_url at an object in the CALLER's own
-- folder (or clears it) and returns the previous URL so the server can delete
-- the replaced object. The URL is client-reachable text that ends up rendered,
-- so its shape is pinned here as well as in the server.
--
-- Financial effect: none. No table is created; one column already existing
-- (users.avatar_url, unused until now) starts being written.
--
-- ROLLBACK (local/itest only): drop function app.set_my_avatar(text);
--   delete from storage.buckets where id = 'profile-avatars' (after removing its
--   objects through the storage API).
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-avatars',
  'profile-avatars',
  true,
  2097152,  -- 2 MiB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.set_my_avatar(p_avatar_url text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_previous text;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select u.avatar_url into v_previous
  from public.users u
  where u.id = v_uid and u.status = 'active'
  for update;
  if not found then
    raise exception 'FORBIDDEN: no active user' using errcode = '42501';
  end if;

  -- Setting must point at an object in this deployment's profile-avatars
  -- bucket, inside the caller's own folder, with a server-generated name.
  if p_avatar_url is not null and p_avatar_url !~ (
       '^https?://[^/?#]+/storage/v1/object/public/profile-avatars/'
       || v_uid::text
       || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
     ) then
    raise exception 'INVALID_IMAGE: a profile photo must be an image uploaded to your own profile'
      using errcode = 'P0001';
  end if;

  if p_avatar_url is not distinct from v_previous then
    return v_previous;
  end if;

  update public.users set avatar_url = p_avatar_url where id = v_uid;

  perform app.write_audit_log(
    null, 'officer', v_uid,
    case when p_avatar_url is null then 'user.remove_avatar' else 'user.set_avatar' end,
    'user', v_uid,
    jsonb_build_object('had_avatar', v_previous is not null),
    jsonb_build_object('has_avatar', p_avatar_url is not null)
  );

  return v_previous;
end;
$$;

comment on function app.set_my_avatar(text) is
  'D-F. Sets or clears the caller''s profile photo. The URL must name an object in the caller''s own folder of the profile-avatars bucket with a server-generated uuid name. Returns the previous URL so the server can delete the replaced object.';

revoke all on function app.set_my_avatar(text) from public, anon;
grant execute on function app.set_my_avatar(text) to authenticated;
