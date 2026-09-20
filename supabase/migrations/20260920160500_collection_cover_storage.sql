-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920160500 — Storage for collection flyers
--
-- A bucket, and the policies that decide who may write to it (§33).
--
-- THE SHAPE, and why:
--
--   public read     a flyer is shown on a page anyone with the link can open.
--                   There is nothing private in it, and a signed URL per view
--                   would make the public page slower for no benefit.
--
--   no client write at all. `anon` and `authenticated` get no INSERT, UPDATE or
--                   DELETE on storage.objects for this bucket. Uploads go
--                   through a server action that checks the caller holds
--                   collection.draft in the owning community, validates the
--                   file, and writes with the service role — the same shape as
--                   every other write in this schema (ADR 0008): the client
--                   proposes, the server decides.
--
-- The alternative — a client-side upload with a storage policy keyed on the
-- path — was rejected because the policy would have to parse a community id out
-- of an object name and trust it. SEC-18 says a client-supplied id never
-- implies tenancy, and a path is a client-supplied id.
--
-- Limits are enforced twice: here, where the bucket refuses anything larger or
-- of another type, and in the server action, which fails with a sentence a
-- person can act on rather than a storage error.
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'collection-covers',
  'collection-covers',
  true,
  5242880,  -- 5 MiB, matching supabase/config.toml's storage limit
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Read is open, because the bucket is public and the flyer appears on a page
-- that needs no account. Everything else is absent on purpose: no policy grants
-- a client role INSERT, UPDATE or DELETE here, so the only writer is the
-- service role used by the server action.
drop policy if exists collection_covers_public_read on storage.objects;

create policy collection_covers_public_read
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'collection-covers');
