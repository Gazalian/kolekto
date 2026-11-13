"use server";

import { completeOnboarding, ensurePersonalWorkspace } from "@kolekto/db";
import { redirect } from "next/navigation";
import { requireCallerContext } from "../../../lib/caller.ts";
import { createClient } from "../../../lib/supabase/server.ts";

export async function startCollectionAction(): Promise<{ error?: string }> {
  const prepared = await prepareWorkspace();
  if ("error" in prepared) return prepared;
  redirect(`/c/${prepared.slug}/collections/new`);
}

export async function skipOnboardingAction(): Promise<{ error?: string }> {
  const prepared = await prepareWorkspace();
  if ("error" in prepared) return prepared;
  redirect(`/c/${prepared.slug}`);
}

/**
 * The personal workspace both choices land in, with onboarding marked done.
 *
 * Each failure is logged with its cause before the person is shown a short
 * message: the message alone ("Could not create your workspace") said nothing
 * about whether the database was unreachable or refused, and the cause was
 * discarded. And a workspace whose slug cannot be read back is reported as a
 * failure rather than redirected to `/c/undefined/...`, which was a 404.
 */
async function prepareWorkspace(): Promise<{ slug: string } | { error: string }> {
  const caller = await requireCallerContext();
  let communityId: string;
  try {
    communityId = await ensurePersonalWorkspace(caller);
  } catch (cause) {
    console.error("welcome: ensurePersonalWorkspace failed", cause);
    return { error: "Could not create your workspace. Please try again." };
  }
  try {
    await completeOnboarding(caller);
  } catch (cause) {
    console.error("welcome: completeOnboarding failed", cause);
    return { error: "Could not complete setup. Please try again." };
  }

  const supabase = await createClient();
  const { data } = await supabase.from("communities").select("slug").eq("id", communityId).maybeSingle();
  if (!data?.slug) return { error: "Your workspace was created but could not be opened. Please try again." };
  return { slug: data.slug as string };
}
