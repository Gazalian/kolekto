import "server-only";

import { loadConfig, loadServiceRoleKey } from "@kolekto/config";
import { createClient } from "@supabase/supabase-js";
import { avatarExtensionFor, AVATAR_MAX_BYTES } from "./avatar-file.ts";

/**
 * Uploading and removing a profile photo (D-F, migration 20261122130000).
 *
 * SERVER ONLY: writing to the bucket uses the service role. The browser hands
 * over bytes; this file decides the object name, checks the bytes really are
 * a JPEG, PNG or WebP image (not just that the browser said so), and checks
 * the size. The database then re-checks the URL shape before storing it.
 */

const BUCKET = "profile-avatars";

export interface AvatarUploadResult {
  url?: string;
  error?: string;
}

function serviceClient() {
  return createClient(loadConfig().supabaseUrl, loadServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function uploadProfileAvatar(userId: string, file: File): Promise<AvatarUploadResult> {
  if (file.size === 0) return { error: "That file is empty." };
  if (file.size > AVATAR_MAX_BYTES) return { error: "That image is larger than 2 MB. Try a smaller one." };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension = avatarExtensionFor(file.type, bytes);
  if (!extension) return { error: "Upload a JPG, PNG or WebP image." };

  const path = `${userId}/${crypto.randomUUID()}.${extension}`;
  const supabase = serviceClient();
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: file.type,
    cacheControl: "3600",
    upsert: false,
  });
  if (error) return { error: "The photo could not be uploaded. Try again." };

  return { url: supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
}

/** Removes a photo only if it sits in this user's own folder; a URL is client-reachable text. */
export async function removeProfileAvatar(userId: string, url: string): Promise<{ error?: string }> {
  const marker = `/${BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return { error: "That photo does not belong to you." };
  const path = url.slice(index + marker.length);
  if (!path.startsWith(`${userId}/`) || path.includes("..")) return { error: "That photo does not belong to you." };

  const { error } = await serviceClient().storage.from(BUCKET).remove([path]);
  if (error) return { error: "The old photo could not be removed." };
  return {};
}
