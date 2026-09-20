"use server";

import {
  approvePendingMember,
  archiveMember,
  createInviteLink,
  createMember,
  DatabaseError,
  deleteMemberAttributeDefinition,
  findMemberDuplicates,
  type MemberDuplicate,
  rejectPendingMember,
  restoreMember,
  revokeInviteLink,
  updateMember,
  updateMemberCodeSettings,
  upsertMemberAttributeDefinition,
} from "@kolekto/db";
import {
  archiveMemberSchema,
  createMemberSchema,
  findMemberDuplicatesSchema,
  memberCodeSettingsSchema,
  memberFieldSchema,
  restoreMemberSchema,
  updateMemberSchema,
} from "@kolekto/validation";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../lib/caller.ts";

export interface ActionResult {
  error?: string;
  ok?: boolean;
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof DatabaseError ? error.message : fallback;
}

function revalidateMembers(slug: string): void {
  revalidatePath(`/c/${slug}/members`);
}

/** Reads the community's own field keys out of the form. Everything not a known system field is a community-defined attribute. */
function attributesFrom(formData: FormData, fieldKeys: readonly string[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const key of fieldKeys) {
    const value = formData.get(`attr:${key}`);
    if (typeof value === "string") attributes[key] = value;
  }
  return attributes;
}

/**
 * Asked before the member is created, so the person filling the form sees the
 * existing record and decides. `app.create_member` asks again and refuses on
 * its own terms — this is for the human, not for the database.
 */
export async function findDuplicatesAction(
  input: unknown,
): Promise<{ duplicates?: MemberDuplicate[]; error?: string }> {
  const parsed = findMemberDuplicatesSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const caller = await requireCallerContext();
  try {
    return { duplicates: await findMemberDuplicates(caller, parsed.data) };
  } catch (error) {
    return { error: messageFrom(error, "Could not check for existing members") };
  }
}

export async function createMemberAction(
  slug: string,
  fieldKeys: string[],
  formData: FormData,
): Promise<ActionResult & { memberCode?: string }> {
  const parsed = createMemberSchema.safeParse({
    communityId: formData.get("communityId"),
    fullName: formData.get("fullName"),
    phoneE164: formData.get("phoneE164") || undefined,
    email: formData.get("email") || undefined,
    attributes: attributesFrom(formData, fieldKeys),
    groupIds: formData.getAll("groupIds").filter((value): value is string => typeof value === "string"),
    confirmPossibleDuplicate: formData.get("confirmPossibleDuplicate") === "true",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const caller = await requireCallerContext();
  try {
    await createMember(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not create the member") };
  }
  revalidateMembers(slug);
  return { ok: true };
}

export async function updateMemberAction(slug: string, fieldKeys: string[], formData: FormData): Promise<ActionResult> {
  const parsed = updateMemberSchema.safeParse({
    memberId: formData.get("memberId"),
    fullName: formData.get("fullName"),
    phoneE164: formData.get("phoneE164") || undefined,
    email: formData.get("email") || undefined,
    attributes: attributesFrom(formData, fieldKeys),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const caller = await requireCallerContext();
  try {
    await updateMember(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not update the member") };
  }
  revalidateMembers(slug);
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
  revalidateMembers(slug);
  return { ok: true };
}

/** §42: archiving is reversible. The status a member comes back as depends on what they still satisfy, which is the database's call, not this form's. */
export async function restoreMemberAction(slug: string, memberId: string): Promise<ActionResult & { status?: string }> {
  const parsed = restoreMemberSchema.safeParse({ memberId });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const caller = await requireCallerContext();
  try {
    const status = await restoreMember(caller, parsed.data);
    revalidateMembers(slug);
    return { ok: true, status };
  } catch (error) {
    return { error: messageFrom(error, "Could not restore the member") };
  }
}

export async function approveMemberAction(slug: string, memberId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await approvePendingMember(caller, memberId);
  } catch (error) {
    return { error: messageFrom(error, "Could not approve this join request") };
  }
  revalidateMembers(slug);
  return { ok: true };
}

export async function rejectMemberAction(slug: string, memberId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await rejectPendingMember(caller, memberId);
  } catch (error) {
    return { error: messageFrom(error, "Could not reject this join request") };
  }
  revalidateMembers(slug);
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
    revalidateMembers(slug);
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
  revalidateMembers(slug);
  return { ok: true };
}

// ── Community member profile configuration ─────────────────────────────────

export async function saveMemberFieldAction(slug: string, input: unknown): Promise<ActionResult> {
  const parsed = memberFieldSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the field and try again" };

  const caller = await requireCallerContext();
  try {
    await upsertMemberAttributeDefinition(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not save the field") };
  }
  revalidateMembers(slug);
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

export async function deleteMemberFieldAction(slug: string, definitionId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await deleteMemberAttributeDefinition(caller, definitionId);
  } catch (error) {
    return { error: messageFrom(error, "Could not remove the field") };
  }
  revalidateMembers(slug);
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

export async function saveMemberCodeSettingsAction(slug: string, input: unknown): Promise<ActionResult> {
  const parsed = memberCodeSettingsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings and try again" };

  const caller = await requireCallerContext();
  try {
    await updateMemberCodeSettings(caller, {
      communityId: parsed.data.communityId,
      prefix: parsed.data.prefix || undefined,
      padding: parsed.data.padding,
      ...(parsed.data.startingNumber === undefined ? {} : { startingNumber: parsed.data.startingNumber }),
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not save the member ID format") };
  }
  revalidateMembers(slug);
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}
