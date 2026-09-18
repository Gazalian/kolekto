"use server";

import { createCommunity, DatabaseError } from "@kolekto/db";
import { createCommunitySchema } from "@kolekto/validation";
import { redirect } from "next/navigation";
import { requireCallerContext } from "../../../lib/caller.ts";
import { createClient } from "../../../lib/supabase/server.ts";

export interface CreateCommunityState {
  error?: string;
}

export async function createCommunityAction(_prev: CreateCommunityState, formData: FormData): Promise<CreateCommunityState> {
  const parsed = createCommunitySchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type"),
    description: formData.get("description") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const caller = await requireCallerContext();
  let communityId: string;
  try {
    communityId = await createCommunity(caller, parsed.data);
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "Could not create the community" };
  }

  const supabase = await createClient();
  const { data } = await supabase.from("communities").select("slug").eq("id", communityId).single();

  redirect(`/c/${data?.slug ?? ""}`);
}
