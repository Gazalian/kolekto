import "server-only";

import { loadConfig, loadServiceRoleKey } from "@kolekto/config";
import { createClient } from "@supabase/supabase-js";

/**
 * Uploading and removing a collection's flyer (§33).
 *
 * SERVER ONLY, and the file is what makes that non-negotiable: writing to the
 * bucket uses the service role, which bypasses RLS entirely. It never reaches a
 * browser — `loadConfig` reads it from a server-only variable, and the
 * `server-only` import above turns a mistaken client import into a build error
 * rather than a leaked key.
 *
 * The client's part is to hand over bytes. Everything that decides anything —
 * whether the caller may touch this collection, whether the file is an image,
 * whether it is small enough, and what it ends up being called — happens here.
 */

const BUCKET = "collection-covers";

/** Matches the bucket's own allowed_mime_types (20260920160500). Declared twice on purpose: this one produces a sentence, the bucket produces a guarantee. */
const ALLOWED = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

const MAX_BYTES = 5 * 1024 * 1024;

export interface CoverUploadResult {
  url?: string;
  error?: string;
}

function serviceClient() {
  // loadServiceRoleKey throws if it is ever reached from a browser (SEC-15).
  // Obtaining the key is a deliberate act here rather than a field on the
  // configuration object every page already reads.
  return createClient(loadConfig().supabaseUrl, loadServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Validates and stores a flyer, returning its public URL.
 *
 * The object is named after the collection and a timestamp rather than the
 * uploaded filename: a filename is client-supplied text that would otherwise
 * decide a storage path, and "quarterly report.jpg" from two communities must
 * not be able to collide or traverse.
 */
export async function uploadCollectionCover(
  communityId: string,
  collectionId: string,
  file: File,
): Promise<CoverUploadResult> {
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

  const path = `${communityId}/${collectionId}/${Date.now()}.${extension}`;
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
 * Removes a flyer that this collection owns.
 *
 * The path is derived from the stored URL and checked against the collection it
 * is supposed to belong to before anything is deleted — a URL is client-supplied
 * text, and deleting by whatever path it names would let one collection remove
 * another's image.
 */
export async function removeCollectionCover(
  communityId: string,
  collectionId: string,
  url: string,
): Promise<{ error?: string }> {
  const marker = `/${BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return { error: "That image does not belong to this collection." };

  const path = url.slice(index + marker.length);
  if (!path.startsWith(`${communityId}/${collectionId}/`)) {
    return { error: "That image does not belong to this collection." };
  }

  const { error } = await serviceClient().storage.from(BUCKET).remove([path]);
  if (error) return { error: "The image could not be removed. Try again." };
  return {};
}
