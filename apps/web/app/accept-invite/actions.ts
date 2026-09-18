"use server";

import { acceptOfficerInvitation, DatabaseError, declineOfficerInvitation } from "@kolekto/db";
import { requireCallerContext } from "../../lib/caller.ts";

export interface AcceptResult {
  error?: string;
  ok?: boolean;
}

export async function acceptInvitationAction(token: string): Promise<AcceptResult> {
  const caller = await requireCallerContext();
  try {
    await acceptOfficerInvitation(caller, token);
    return { ok: true };
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "Could not accept this invitation" };
  }
}

export async function declineInvitationAction(token: string): Promise<AcceptResult> {
  const caller = await requireCallerContext();
  try {
    await declineOfficerInvitation(caller, token);
    return { ok: true };
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "Could not decline this invitation" };
  }
}
