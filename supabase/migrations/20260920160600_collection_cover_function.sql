-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920160600 — Attaching a flyer to a collection
--
-- The upload itself happens in the application, because storage is not
-- Postgres. What belongs here is the same thing that belongs here for every
-- other field: the permission check, the tenancy derivation, and the audit row.
--
-- The URL is accepted rather than constructed, which makes it client-supplied
-- text — so it is constrained to the bucket this deployment actually serves.
-- Without that, "cover_image_url" would be an open redirect painted onto a
-- community's public page.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.set_collection_cover(
  p_collection_id   uuid,
  p_cover_image_url text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status in ('closed', 'archived', 'suspended') then
    raise exception 'COLLECTION_NOT_EDITABLE: a % collection cannot be edited', v_collection.status
      using errcode = 'P0001';
  end if;

  -- Clearing is always allowed. Setting must point into the collection-covers
  -- bucket of this deployment's own storage: a flyer is rendered on a public
  -- page, and an arbitrary URL there is somebody else's content served under
  -- this community's name.
  if p_cover_image_url is not null
     and p_cover_image_url !~ '^https?://[^/]+/storage/v1/object/public/collection-covers/' then
    raise exception 'INVALID_IMAGE: a flyer must be an image uploaded to this collection'
      using errcode = 'P0001';
  end if;

  update public.collections set cover_image_url = p_cover_image_url where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(),
    case when p_cover_image_url is null then 'collection.remove_cover' else 'collection.set_cover' end,
    'collection', p_collection_id,
    jsonb_build_object('had_cover', v_collection.cover_image_url is not null),
    jsonb_build_object('has_cover', p_cover_image_url is not null)
  );
end;
$$;

comment on function app.set_collection_cover(uuid, text) is
  '§33. Points a collection at a flyer already uploaded to this deployment''s collection-covers bucket, or clears it. The URL is constrained because it is client-supplied text rendered on a public page.';

revoke execute on function app.set_collection_cover(uuid, text) from public;
grant  execute on function app.set_collection_cover(uuid, text) to authenticated;
