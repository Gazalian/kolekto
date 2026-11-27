"use server";

import { DatabaseError, setMyAvatar } from "@kolekto/db";
import { revalidatePath } from "next/cache";
import { requireUser } from "../../lib/auth.ts";
import { requireCallerContext } from "../../lib/caller.ts";
import { removeProfileAvatar, uploadProfileAvatar } from "../../lib/profile-avatar.ts";

export interface AvatarActionResult {
  url?: string | null;
  error?: string;
}

/**
 * Upload → point the profile at it → delete the replaced photo. If the
 * database refuses, the just-uploaded object is taken back out so nothing is
 * left that nobody can see or delete.
 */
export async function uploadAvatarAction(formData: FormData): Promise<AvatarActionResult> {
  const user = await requireUser();
  const file = formData.get("avatar");
  if (!(file instanceof File)) return { error: "Choose a photo to upload." };

  const uploaded = await uploadProfileAvatar(user.id, file);
  if (uploaded.error || !uploaded.url) return { error: uploaded.error ?? "The photo could not be uploaded." };

  const caller = await requireCallerContext();
  let previous: string | null;
  try {
    previous = await setMyAvatar(caller, uploaded.url);
  } catch (error) {
    await removeProfileAvatar(user.id, uploaded.url);
    return { error: error instanceof DatabaseError ? "The photo could not be saved." : "Something went wrong." };
  }

  if (previous && previous !== uploaded.url) await removeProfileAvatar(user.id, previous);
  revalidatePath("/", "layout");
  return { url: uploaded.url };
}

export async function removeAvatarAction(): Promise<AvatarActionResult> {
  const user = await requireUser();
  const caller = await requireCallerContext();
  let previous: string | null;
  try {
    previous = await setMyAvatar(caller, null);
  } catch {
    return { error: "The photo could not be removed." };
  }
  // The row is cleared first: a stray object is wasted storage, a row pointing
  // at a deleted object is a broken image.
  if (previous) await removeProfileAvatar(user.id, previous);
  revalidatePath("/", "layout");
  return { url: null };
}
