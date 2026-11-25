"use server";

import {
  attestCommunityNotice,
  createOfficerInvitation,
  DatabaseError,
  endOfficerTerm,
  replaceWithdrawalApprover,
  revokeCommunityNotice,
  revokeOfficerInvitation,
  setCommunityPublicPage,
  setWithdrawalApprover,
  updateCommunityProfile,
} from "@kolekto/db";
import { approverErrorMessage } from "./approver-view.ts";
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

/** Owner/admin confirms the community communication notice. Re-checked by the database (communication.attest_notice). */
export async function attestCommunityNoticeAction(slug: string, communityId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await attestCommunityNotice(caller, communityId);
  } catch (error) {
    return { error: messageFrom(error, "Could not confirm the member notice") };
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

/** Withdraw the confirmation: community emails stop being queued until it is confirmed again. */
export async function revokeCommunityNoticeAction(slug: string, communityId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await revokeCommunityNotice(caller, communityId, "other");
  } catch (error) {
    return { error: messageFrom(error, "Could not withdraw the member notice") };
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

// ── Withdrawal second approver (session 39) ──────────────────────────────────
// Owner only. Every rule — owner of THIS community, eligible designee (active
// admin/owner term, active account), never the owner themself — is enforced by
// the database functions; nothing here grants authority. Inputs are checked
// only for shape.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function approverFailure(error: unknown): ActionResult {
  return { error: approverErrorMessage(error instanceof DatabaseError ? error.code : "UNKNOWN") };
}

export async function setWithdrawalApproverAction(slug: string, communityId: string, userId: string, active: boolean): Promise<ActionResult> {
  if (!UUID.test(String(communityId)) || !UUID.test(String(userId)) || typeof active !== "boolean") return { error: "Choose a person." };
  const caller = await requireCallerContext();
  try {
    await setWithdrawalApprover(caller, { communityId, userId, active });
  } catch (error) {
    return approverFailure(error);
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

export async function replaceWithdrawalApproverAction(slug: string, communityId: string, fromUserId: string, toUserId: string): Promise<ActionResult> {
  if (![communityId, fromUserId, toUserId].every((v) => UUID.test(String(v)))) return { error: "Choose a person." };
  const caller = await requireCallerContext();
  try {
    await replaceWithdrawalApprover(caller, { communityId, fromUserId, toUserId });
  } catch (error) {
    return approverFailure(error);
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

/** D-J: owner-only. The database refuses anyone else (app.set_community_public_page). */
export async function setCommunityPublicPageAction(
  slug: string,
  communityId: string,
  published: boolean,
  contactVisible: boolean,
): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await setCommunityPublicPage(caller, { communityId, published, contactVisible });
  } catch (error) {
    if (error instanceof DatabaseError && error.message.includes("FORBIDDEN")) {
      return { error: "Only the community owner can change the public page." };
    }
    return { error: messageFrom(error, "Could not update the public page") };
  }
  revalidatePath(`/c/${slug}/settings`);
  revalidatePath(`/${slug}`);
  return { ok: true };
}
