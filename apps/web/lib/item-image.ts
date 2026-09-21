import "server-only";

import { loadConfig, loadServiceRoleKey } from "@kolekto/config";
import { createClient } from "@supabase/supabase-js";

/**
 * Uploading and removing an item's image (§4/§16/§21).
 *
 * Same shape as `collection-cover.ts`, on purpose — "one robust media
 * system" rather than a second bespoke upload path: server-only, service
 * role, validated type and size, a storage path the caller cannot choose.
 * The only difference is where the object lands — a collection has one
 * flyer; a collection can have up to 50 items, each with its own image, so
 * the path carries `items/` and a random suffix rather than just a
 * timestamp, and `app.set_collection_items` (20260921110000) enforces the
 * same "only an object this collection's own upload produced" rule
 * `app.set_collection_cover` enforces for the flyer.
 *
 * Reuses the `collection-covers` bucket rather than a new one: the type,
 * size and public-read policy an item image needs are identical to a
 * flyer's, and a second bucket would only be a second place to keep both
 * policies in sync.
 */

const BUCKET = "collection-covers";

const ALLOWED = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

const MAX_BYTES = 5 * 1024 * 1024;

export interface ItemImageUploadResult {
  url?: string;
  error?: string;
}

function serviceClient() {
  return createClient(loadConfig().supabaseUrl, loadServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function uploadItemImage(
  communityId: string,
  collectionId: string,
  file: File,
): Promise<ItemImageUploadResult> {
  const extension = ALLOWED.get(file.type);
  if (!extension) {
    return { error: "Upload a JPG, PNG or WebP image." };
  }
  if (file.size === 0) {
    return { error: "That file is empty." };
  }
  if (file.size > MAX_BYTES) {
    return { error: "That image is larger than 5 MB. Try a smaller one." };
  }

  // Not named after the item id: an item being added has none yet (it is
  // assigned when the whole item list is saved), and a row that already
  // exists may still be mid-edit. A timestamp plus a short random suffix is
  // enough to keep two images uploaded in the same second apart.
  const suffix = Math.random().toString(36).slice(2, 8);
  const path = `${communityId}/${collectionId}/items/${Date.now()}-${suffix}.${extension}`;
  const supabase = serviceClient();

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    cacheControl: "3600",
    upsert: false,
  });

  if (error) {
    return { error: "The image could not be uploaded. Try again." };
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl };
}

/**
 * Removes an item image this collection owns. Called both when an officer
 * explicitly removes one and when a replaced or dropped image would
 * otherwise be storage nothing points at any more.
 */
export async function removeItemImage(
  communityId: string,
  collectionId: string,
  url: string,
): Promise<{ error?: string }> {
  const marker = `/${BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return { error: "That image does not belong to this collection." };

  const path = url.slice(index + marker.length);
  if (!path.startsWith(`${communityId}/${collectionId}/items/`)) {
    return { error: "That image does not belong to this collection." };
  }

  const { error } = await serviceClient().storage.from(BUCKET).remove([path]);
  if (error) return { error: "The image could not be removed. Try again." };
  return {};
}
