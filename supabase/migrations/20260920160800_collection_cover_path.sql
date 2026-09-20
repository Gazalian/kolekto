-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920160800 — A flyer must be THIS collection's object
--
-- 20260920160600 accepted any URL inside the collection-covers bucket. That is
-- weaker than the rule the uploader already follows: every object it writes is
-- named `<community_id>/<collection_id>/<timestamp>.<ext>`, so a URL that does
-- not carry those two ids is not an object this application produced for this
-- collection.
--
-- The gap it closes is a tenancy one (SEC-18): without the ids, a caller who
-- can edit collection A could point it at community B's flyer object, and the
-- page would serve B's image under A's name.
--
-- The host is still not pinned, because the database does not know what this
-- deployment's storage host is called. What remains is therefore an officer
-- being able to point at a same-shaped path on another host — an off-site image
-- on their own collection's page, not access to anybody else's data. Pinning it
-- properly means storing the object path and building the URL in the
-- application, which is a change to how every image column in the schema works
-- and does not belong in this migration.
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

  -- Clearing is always allowed. Setting must name an object in this
  -- collection's own folder of the collection-covers bucket.
  if p_cover_image_url is not null
     and p_cover_image_url !~ (
       '^https?://[^/]+/storage/v1/object/public/collection-covers/'
       || v_collection.community_id::text || '/' || p_collection_id::text || '/'
     ) then
    raise exception 'INVALID_IMAGE: a flyer must be an image uploaded to this collection'
      using errcode = 'P0001',
            hint = 'The image is uploaded first; only the object it produced can be attached.';
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
