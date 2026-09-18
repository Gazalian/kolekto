"use server";

import {
  createOfficerInvitation,
  DatabaseError,
  endOfficerTerm,
  revokeOfficerInvitation,
  updateCommunityProfile,
} from "@kolekto/db";
import { createOfficerInvitationSchema, updateCommunityProfileSchema } from "@kolekto/validation";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../lib/caller.ts";

export interface ActionResult {
  error?: string;
  ok?: boolean;
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof DatabaseError ? error.message : fallback;
}

export async function updateCommunityProfileAction(slug: string, formData: FormData): Promise<ActionResult> {
  const parsed = updateCommunityProfileSchema.safeParse({
    communityId: formData.get("communityId"),
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    locationState: formData.get("locationState") || undefined,
    locationCity: formData.get("locationCity") || undefined,
    institution: formData.get("institution") || undefined,
    contactEmail: formData.get("contactEmail") || undefined,
    contactPhoneE164: formData.get("contactPhoneE164") || undefined,
    showOfficersPublicly: formData.get("showOfficersPublicly") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const caller = await requireCallerContext();
  try {
    await updateCommunityProfile(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not update the community profile") };
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

export async function createOfficerInvitationAction(
  slug: string,
  communityId: string,
  formData: FormData,
): Promise<ActionResult & { token?: string }> {
  const parsed = createOfficerInvitationSchema.safeParse({
    communityId,
    role: formData.get("role"),
    title: formData.get("title") || undefined,
    inviteeName: formData.get("inviteeName") || undefined,
    inviteePhoneE164: formData.get("inviteePhoneE164") || undefined,
    inviteeEmail: formData.get("inviteeEmail") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const caller = await requireCallerContext();
  try {
    const { token } = await createOfficerInvitation(caller, parsed.data);
    revalidatePath(`/c/${slug}/settings`);
    return { ok: true, token };
  } catch (error) {
    return { error: messageFrom(error, "Could not create the invitation") };
  }
}

export async function revokeOfficerInvitationAction(slug: string, invitationId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await revokeOfficerInvitation(caller, invitationId);
  } catch (error) {
    return { error: messageFrom(error, "Could not revoke the invitation") };
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

export async function endOfficerTermAction(slug: string, officerTermId: string, reason?: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await endOfficerTerm(caller, officerTermId, reason);
  } catch (error) {
    return { error: messageFrom(error, "Could not end this officer's term") };
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}
