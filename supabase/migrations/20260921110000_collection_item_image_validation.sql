-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921110000 — An item's image must be THIS collection's own object
--
-- `collection_items.image_url` (20260920160000) and `app.set_collection_items`
-- accepting `image_url` in its payload (20260920160200) both existed already;
-- nothing ever wrote to the column because no UI offered it. Wiring that up
-- means this function starts actually receiving client-supplied URLs, so it
-- needs the same guard `app.set_collection_cover` has carried since
-- 20260920160800 and for the identical reason (SEC-18): an unconstrained
-- `image_url` on a row rendered on a public page is somewhere else's content
-- served under this collection's name.
--
-- Item images reuse the `collection-covers` bucket rather than a second one —
-- "one robust media system" (the brief's own words) — under
-- `<community_id>/<collection_id>/items/…`, a sibling of the flyer's own
-- `<community_id>/<collection_id>/<timestamp>.<ext>` path.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.set_collection_items(
  p_collection_id uuid,
  p_items         jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_item       jsonb;
  v_id         uuid;
  v_name       text;
  v_price      bigint;
  v_image      text;
  v_payload_ids uuid[] := '{}';
  v_names      text[] := '{}';
  v_created_at jsonb   := '{}'::jsonb;
  v_count      integer := 0;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status <> 'draft' then
    raise exception 'ITEMS_LOCKED: items can only be changed while the collection is a draft'
      using errcode = 'P0001',
            hint = 'Hide an item instead — a sold item is hidden, never removed.';
  end if;
  if v_collection.amount_model <> 'items' then
    raise exception 'NOT_ITEM_BASED: this collection does not sell items' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'INVALID_ITEMS: an item collection needs at least one item' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_ITEMS: a collection can offer at most 50 items' using errcode = 'P0001';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_name  := nullif(trim(v_item ->> 'name'), '');
    v_price := (v_item ->> 'price_kobo')::bigint;
    v_image := nullif(trim(v_item ->> 'image_url'), '');

    if v_name is null or char_length(v_name) > 80 then
      raise exception 'INVALID_ITEMS: every item needs a name of 80 characters or fewer' using errcode = 'P0001';
    end if;
    if v_price is null or v_price <= 0 then
      raise exception 'INVALID_ITEMS: item "%" needs a price above zero', v_name using errcode = 'P0001';
    end if;
    if lower(v_name) = any (v_names) then
      raise exception 'DUPLICATE_ITEM_NAME: two items are both called "%" — give each a distinct name', v_name
        using errcode = 'P0001',
              hint = 'Two items with one name cannot be told apart on an order or a receipt.';
    end if;
    v_names := v_names || lower(v_name);

    -- Same rule as a collection's own flyer: an image must be an object this
    -- collection's own upload path produced, not an arbitrary URL rendered on
    -- a page anyone with the link can open.
    if v_image is not null
       and v_image !~ (
         '^https?://[^/]+/storage/v1/object/public/collection-covers/'
         || v_collection.community_id::text || '/' || p_collection_id::text || '/items/'
       ) then
      raise exception 'INVALID_IMAGE: item "%" image must be uploaded to this collection', v_name
        using errcode = 'P0001',
              hint = 'The image is uploaded first; only the object it produced can be attached.';
    end if;

    v_id := nullif(v_item ->> 'id', '')::uuid;
    if v_id is not null then
      if not exists (select 1 from public.collection_items where id = v_id and collection_id = p_collection_id) then
        raise exception 'NOT_FOUND: item % does not belong to this collection', v_id using errcode = 'P0002';
      end if;
      v_payload_ids := v_payload_ids || v_id;
    end if;
  end loop;

  -- Delete-then-insert, carrying created_at across, for the reason
  -- set_collection_tiers states: a unique name index makes a row-by-row rename
  -- of two items into each other's names fail halfway.
  select coalesce(jsonb_object_agg(id::text, to_jsonb(created_at)), '{}'::jsonb)
    into v_created_at
  from public.collection_items where collection_id = p_collection_id;

  delete from public.collection_items where collection_id = p_collection_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_id := coalesce(nullif(v_item ->> 'id', '')::uuid, app.uuid_generate_v7());

    insert into public.collection_items (
      id, collection_id, community_id, name, description, price_kobo,
      quantity_available, max_per_order, image_url, hidden, sort_order, created_at
    ) values (
      v_id, p_collection_id, v_collection.community_id,
      trim(v_item ->> 'name'),
      nullif(trim(v_item ->> 'description'), ''),
      (v_item ->> 'price_kobo')::bigint,
      nullif(v_item ->> 'quantity_available', '')::integer,
      nullif(v_item ->> 'max_per_order', '')::integer,
      nullif(trim(v_item ->> 'image_url'), ''),
      coalesce((v_item ->> 'hidden')::boolean, false),
      coalesce(nullif(v_item ->> 'sort_order', '')::smallint, v_count::smallint),
      coalesce((v_created_at ->> v_id::text)::timestamptz, now())
    );

    v_count := v_count + 1;
  end loop;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_items', 'collection', p_collection_id,
    null, jsonb_build_object('item_count', v_count)
  );

  return v_count;
end;
$$;

comment on function app.set_collection_items(uuid, jsonb) is
  'Full replace matched by item id, never by display name (ADR 0010 applied to items). Draft only: a published price is part of the offer. Each item''s image_url, if set, must be an object this collection''s own upload path produced (SEC-18).';
