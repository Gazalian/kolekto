"use server";

import { setContactVerified } from "@kolekto/db";
import { requireCallerContext } from "../../../lib/caller.ts";

export async function setContactVerifiedAction(): Promise<{ error?: string }> {
  const caller = await requireCallerContext();
  try {
    await setContactVerified(caller);
  } catch {
    return { error: "Could not update verification status" };
  }
  return {};
}
