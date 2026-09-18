"use server";

import { ANONYMOUS, DatabaseError, type MemberStatus, redeemInviteLink } from "@kolekto/db";
import { redeemInviteLinkSchema } from "@kolekto/validation";

export interface JoinResult {
  error?: string;
  // app.redeem_invite_link only ever produces 'unclaimed' or 'pending_approval'
  // (see its comment in 20260918140100), but the typed return is the full
  // MemberStatus enum — narrowing here would be a claim the type system
  // cannot back up.
  status?: MemberStatus;
}

export async function redeemInviteLinkAction(token: string, formData: FormData): Promise<JoinResult> {
  const parsed = redeemInviteLinkSchema.safeParse({
    token,
    fullName: formData.get("fullName"),
    phoneE164: formData.get("phoneE164"),
    email: formData.get("email") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    // ANONYMOUS: this is the one action in the app performed with no signed-in
    // user (MEM-05) — the database function itself is what limits what it can
    // do, not a session.
    const { status } = await redeemInviteLink(ANONYMOUS, parsed.data);
    return { status };
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "This invite link could not be used" };
  }
}
