"use server";

import {
  approvePendingMember,
  archiveMember,
  createInviteLink,
  createMember,
  DatabaseError,
  rejectPendingMember,
  revokeInviteLink,
  updateMember,
} from "@kolekto/db";
import { archiveMemberSchema, createMemberSchema, updateMemberSchema } from "@kolekto/validation";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../lib/caller.ts";

export interface ActionResult {
  error?: string;
  ok?: boolean;
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof DatabaseError ? error.message : fallback;
}

export async function createMemberAction(slug: string, formData: FormData): Promise<ActionResult> {
  const parsed = createMemberSchema.safeParse({
    communityId: formData.get("communityId"),
    fullName: formData.get("fullName"),
    phoneE164: formData.get("phoneE164") || undefined,
    email: formData.get("email") || undefined,
    identifier: formData.get("identifier") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const caller = await requireCallerContext();
  try {
    await createMember(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not create the member") };
  }
  revalidatePath(`/c/${slug}/members`);
  return { ok: true };
}

export async function updateMemberAction(slug: string, formData: FormData): Promise<ActionResult> {
  const parsed = updateMemberSchema.safeParse({
    memberId: formData.get("memberId"),
    fullName: formData.get("fullName"),
    phoneE164: formData.get("phoneE164") || undefined,
    email: formData.get("email") || undefined,
    identifier: formData.get("identifier") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const caller = await requireCallerContext();
  try {
    await updateMember(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not update the member") };
  }
  revalidatePath(`/c/${slug}/members`);
  return { ok: true };
}

export async function archiveMemberAction(slug: string, formData: FormData): Promise<ActionResult> {
  const parsed = archiveMemberSchema.safeParse({
    memberId: formData.get("memberId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const caller = await requireCallerContext();
  try {
    await archiveMember(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not archive the member") };
  }
  revalidatePath(`/c/${slug}/members`);
  return { ok: true };
}

export async function approveMemberAction(slug: string, memberId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await approvePendingMember(caller, memberId);
  } catch (error) {
    return { error: messageFrom(error, "Could not approve this join request") };
  }
  revalidatePath(`/c/${slug}/members`);
  return { ok: true };
}

export async function rejectMemberAction(slug: string, memberId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await rejectPendingMember(caller, memberId);
  } catch (error) {
    return { error: messageFrom(error, "Could not reject this join request") };
  }
  revalidatePath(`/c/${slug}/members`);
  return { ok: true };
}

export async function createInviteLinkAction(
  slug: string,
  communityId: string,
  input: { approveJoiners: boolean; maxUses?: number | undefined; label?: string | undefined },
): Promise<ActionResult & { token?: string }> {
  const caller = await requireCallerContext();
  try {
    const { token } = await createInviteLink(caller, { communityId, ...input });
    revalidatePath(`/c/${slug}/members`);
    return { ok: true, token };
  } catch (error) {
    return { error: messageFrom(error, "Could not create the invite link") };
  }
}

export async function revokeInviteLinkAction(slug: string, inviteLinkId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await revokeInviteLink(caller, inviteLinkId);
  } catch (error) {
    return { error: messageFrom(error, "Could not revoke the invite link") };
  }
  revalidatePath(`/c/${slug}/members`);
  return { ok: true };
}
