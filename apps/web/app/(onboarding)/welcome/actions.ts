"use server";

import { completeOnboarding, ensurePersonalWorkspace } from "@kolekto/db";
import { redirect } from "next/navigation";
import { requireCallerContext } from "../../../lib/caller.ts";
import { createClient } from "../../../lib/supabase/server.ts";

export async function startCollectionAction(): Promise<{ error?: string }> {
  const caller = await requireCallerContext();
  let communityId: string;
  try {
    communityId = await ensurePersonalWorkspace(caller);
  } catch {
    return { error: "Could not create your workspace." };
  }
  try {
    await completeOnboarding(caller);
  } catch {
    return { error: "Could not complete setup. Please try again." };
  }

  const supabase = await createClient();
  const { data } = await supabase.from("communities").select("slug").eq("id", communityId).single();
  redirect(`/c/${data?.slug}/collections/new`);
}

export async function skipOnboardingAction(): Promise<{ error?: string }> {
  const caller = await requireCallerContext();
  let communityId: string;
  try {
    communityId = await ensurePersonalWorkspace(caller);
  } catch {
    return { error: "Could not create your workspace." };
  }
  try {
    await completeOnboarding(caller);
  } catch {
    return { error: "Could not complete setup. Please try again." };
  }

  const supabase = await createClient();
  const { data } = await supabase.from("communities").select("slug").eq("id", communityId).single();
  redirect(`/c/${data?.slug}`);
}
