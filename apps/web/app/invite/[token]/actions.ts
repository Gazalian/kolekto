"use server";

import { ANONYMOUS, DatabaseError, getPublicInvite, type MemberStatus, redeemInviteLink } from "@kolekto/db";
import { redeemInviteLinkSchema } from "@kolekto/validation";

export interface JoinResult {
  error?: string;
  // app.redeem_invite_link only ever produces 'unclaimed' or 'pending_approval'
  // (see its comment), but the typed return is the full MemberStatus enum —
  // narrowing here would be a claim the type system cannot back up.
  status?: MemberStatus;
  /** Shown to the person who just joined: this is who they now are (§16). */
  memberCode?: string;
}

export async function redeemInviteLinkAction(token: string, formData: FormData): Promise<JoinResult> {
  // Which fields this invitation asks for is the invitation's decision, read
  // back from the server rather than inferred from whatever the form posted.
  // The database filters again on redemption; this is so a stray input cannot
  // even be offered to it.
  const invite = await getPublicInvite(token);
  if (!invite) return { error: "This invite link is no longer valid" };

  const attributes: Record<string, string> = {};
  for (const field of invite.fields) {
    const value = formData.get(`attr:${field.key}`);
    if (typeof value === "string" && value.trim() !== "") attributes[field.key] = value;
  }

  const parsed = redeemInviteLinkSchema.safeParse({
    token,
    fullName: formData.get("fullName"),
    phoneE164: formData.get("phoneE164"),
    email: formData.get("email") || undefined,
    attributes,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    // ANONYMOUS: this is the one action in the app performed with no signed-in
    // user (MEM-05) — the database function itself is what limits what it can
    // do, not a session. It decides the groups, validates the required answers
    // and issues the member code.
    const { status, memberCode } = await redeemInviteLink(ANONYMOUS, parsed.data);
    return { status, memberCode };
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "This invite link could not be used" };
  }
}
