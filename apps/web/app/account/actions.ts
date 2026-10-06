"use server";

import { DatabaseError, updateUserProfile } from "@kolekto/db";
import { requireCallerContext } from "../../lib/caller.ts";
import { createClient } from "../../lib/supabase/server.ts";

export interface UpdateProfileState {
  error?: string;
  success?: boolean;
}

export interface SetPasswordState {
  error?: string;
  success?: boolean;
}

export async function updateProfileAction(_prev: UpdateProfileState, formData: FormData): Promise<UpdateProfileState> {
  const fullName = (formData.get("fullName") as string | null)?.trim();
  const phoneE164 = (formData.get("phoneE164") as string | null)?.trim() || undefined;

  if (!fullName || fullName.length < 1 || fullName.length > 120) {
    return { error: "Full name must be between 1 and 120 characters." };
  }

  const caller = await requireCallerContext();
  try {
    await updateUserProfile(caller, { fullName, phoneE164 });
  } catch (error) {
    if (error instanceof DatabaseError) {
      if (error.message.includes("INVALID_PHONE")) return { error: "Please enter a valid Nigerian phone number." };
      if (error.message.includes("duplicate") || error.message.includes("unique")) return { error: "This phone number is already in use by another account." };
      return { error: error.message };
    }
    return { error: "Could not update profile." };
  }
  return { success: true };
}

export async function setPasswordAction(_prev: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
  const password = formData.get("password") as string | null;
  const confirmPassword = formData.get("confirmPassword") as string | null;

  if (!password || password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: error.message };
  }
  return { success: true };
}
