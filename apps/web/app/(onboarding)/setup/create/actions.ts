"use server";

import { completeOnboarding, createCommunity, DatabaseError, ensurePersonalWorkspace } from "@kolekto/db";
import { createCommunitySchema } from "@kolekto/validation";
import { redirect } from "next/navigation";
import { requireCallerContext } from "../../../../lib/caller.ts";
import { createClient } from "../../../../lib/supabase/server.ts";

export interface SetupCreateState {
  error?: string;
}

export async function setupCreateCommunityAction(
  _prev: SetupCreateState,
  formData: FormData,
): Promise<SetupCreateState> {
  const parsed = createCommunitySchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type"),
    description: formData.get("description") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const caller = await requireCallerContext();

  try {
    await ensurePersonalWorkspace(caller);
  } catch {
    return { error: "Could not create your workspace. Please try again." };
  }

  let communityId: string;
  try {
    communityId = await createCommunity(caller, parsed.data);
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "Could not create the community" };
  }

  try {
    await completeOnboarding(caller);
  } catch {
    return { error: "Could not complete setup. Please try again." };
  }

  const supabase = await createClient();
  const { data } = await supabase.from("communities").select("slug").eq("id", communityId).single();

  redirect(`/c/${data?.slug ?? ""}`);
}
