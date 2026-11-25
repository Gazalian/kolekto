"use server";

import { ConfigError } from "@kolekto/config";
import {
  DatabaseError,
  grantOfficerPermission,
  membersWithoutMembershipId,
  reinstateMember,
  revokeMembershipId,
  revokeOfficerPermission,
  setMembershipIdSettings,
  suspendMember,
} from "@kolekto/db";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../lib/caller.ts";
import { MEMBERSHIP_ID_SEPARATORS, MAX_SUFFIX_LENGTH, MIN_SUFFIX_LENGTH, normalisePrefix, prefixProblem } from "../../../../lib/membership-id.ts";
import { issueOrReplaceMembershipId, MembershipIdUnavailable } from "../../../../lib/membership-id-server.ts";

/**
 * Membership foundation actions (product doc Part F; M9b). Every one of these
 * is re-checked in SQL by app.has_permission — the checks here only turn bad
 * input into a readable message before a round trip.
 */

export interface MembershipActionResult {
  error?: string;
  ok?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 500;
/** One click issues at most this many, so a large roll never runs into a request timeout. */
const BULK_ISSUE_LIMIT = 100;

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof MembershipIdUnavailable) return error.message;
  if (error instanceof ConfigError) return "Membership IDs are not set up on this server yet.";
  return error instanceof DatabaseError ? error.message : fallback;
}

function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim();
  return reason === "" ? null : reason.slice(0, MAX_REASON);
}

function revalidateMember(slug: string, memberId: string): void {
  revalidatePath(`/c/${slug}/members`);
  revalidatePath(`/c/${slug}/members/${memberId}`);
}

// ── One member ─────────────────────────────────────────────────────────────

export async function issueMembershipIdAction(
  slug: string,
  memberId: string,
): Promise<MembershipActionResult & { fullId?: string }> {
  if (!UUID.test(memberId)) return { error: "Invalid member" };
  const caller = await requireCallerContext();
  try {
    const fullId = await issueOrReplaceMembershipId(caller, memberId, "issue");
    revalidateMember(slug, memberId);
    return { ok: true, fullId };
  } catch (error) {
    return { error: messageFrom(error, "Could not issue a membership ID") };
  }
}

export async function replaceMembershipIdAction(
  slug: string,
  memberId: string,
  reason: unknown,
): Promise<MembershipActionResult & { fullId?: string }> {
  if (!UUID.test(memberId)) return { error: "Invalid member" };
  const caller = await requireCallerContext();
  try {
    const fullId = await issueOrReplaceMembershipId(caller, memberId, "replace", cleanReason(reason));
    revalidateMember(slug, memberId);
    return { ok: true, fullId };
  } catch (error) {
    return { error: messageFrom(error, "Could not replace the membership ID") };
  }
}

export async function revokeMembershipIdAction(slug: string, memberId: string, reason: unknown): Promise<MembershipActionResult> {
  if (!UUID.test(memberId)) return { error: "Invalid member" };
  const why = cleanReason(reason);
  if (!why) return { error: "Say why the ID is being revoked. It is kept in the audit log." };
  const caller = await requireCallerContext();
  try {
    await revokeMembershipId(caller, memberId, why);
  } catch (error) {
    return { error: messageFrom(error, "Could not revoke the membership ID") };
  }
  revalidateMember(slug, memberId);
  return { ok: true };
}

export async function suspendMemberAction(slug: string, memberId: string, reason: unknown): Promise<MembershipActionResult> {
  if (!UUID.test(memberId)) return { error: "Invalid member" };
  const why = cleanReason(reason);
  if (!why) return { error: "Say why the member is being suspended. It is kept in the audit log." };
  const caller = await requireCallerContext();
  try {
    await suspendMember(caller, memberId, why);
  } catch (error) {
    return { error: messageFrom(error, "Could not suspend the member") };
  }
  revalidateMember(slug, memberId);
  return { ok: true };
}

export async function reinstateMemberAction(
  slug: string,
  memberId: string,
  reason: unknown,
): Promise<MembershipActionResult & { status?: string }> {
  if (!UUID.test(memberId)) return { error: "Invalid member" };
  const caller = await requireCallerContext();
  try {
    const status = await reinstateMember(caller, memberId, cleanReason(reason));
    revalidateMember(slug, memberId);
    return { ok: true, status };
  } catch (error) {
    return { error: messageFrom(error, "Could not reinstate the member") };
  }
}

// ── Community settings ─────────────────────────────────────────────────────

export async function saveMembershipIdSettingsAction(
  slug: string,
  input: { communityId: string; prefix: string; separator: string; suffixLength: number; enabled: boolean },
): Promise<MembershipActionResult> {
  if (!UUID.test(input.communityId)) return { error: "Invalid community" };
  const problem = prefixProblem(input.prefix ?? "");
  if (problem) return { error: problem };
  const separator = MEMBERSHIP_ID_SEPARATORS.find((s) => s === input.separator);
  if (!separator) return { error: "Choose / or - as the separator." };
  const suffixLength = Number(input.suffixLength);
  if (!Number.isInteger(suffixLength) || suffixLength < MIN_SUFFIX_LENGTH || suffixLength > MAX_SUFFIX_LENGTH) {
    return { error: `The random part must be ${MIN_SUFFIX_LENGTH} to ${MAX_SUFFIX_LENGTH} characters.` };
  }
  const caller = await requireCallerContext();
  try {
    await setMembershipIdSettings(caller, {
      communityId: input.communityId,
      prefix: normalisePrefix(input.prefix),
      separator,
      suffixLength,
      enabled: input.enabled === true,
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not save the membership ID format") };
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

/**
 * Issues IDs to members in good standing who have none, up to BULK_ISSUE_LIMIT
 * per click. Each issue is its own transaction, so one failure never undoes the
 * others; the count of what was left is returned so the officer can click again.
 */
export async function issueMissingMembershipIdsAction(
  slug: string,
  communityId: string,
): Promise<MembershipActionResult & { issued?: number; failed?: number; remaining?: boolean }> {
  if (!UUID.test(communityId)) return { error: "Invalid community" };
  const caller = await requireCallerContext();
  let memberIds: string[];
  try {
    memberIds = await membersWithoutMembershipId(caller, communityId, BULK_ISSUE_LIMIT + 1);
  } catch (error) {
    return { error: messageFrom(error, "Could not list members without an ID") };
  }
  const batch = memberIds.slice(0, BULK_ISSUE_LIMIT);
  let issued = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const memberId of batch) {
    try {
      await issueOrReplaceMembershipId(caller, memberId, "issue");
      issued += 1;
    } catch (error) {
      failed += 1;
      firstError ??= messageFrom(error, "Could not issue a membership ID");
      // Settings off, secret missing or no permission will fail every member the same way: stop.
      if (error instanceof MembershipIdUnavailable || error instanceof ConfigError) break;
    }
  }
  revalidatePath(`/c/${slug}/settings`);
  revalidatePath(`/c/${slug}/members`);
  if (issued === 0 && firstError) return { error: firstError };
  return { ok: true, issued, failed, remaining: memberIds.length > BULK_ISSUE_LIMIT };
}

// ── Delegated permissions (owner) ──────────────────────────────────────────

export async function grantOfficerPermissionAction(
  slug: string,
  officerTermId: string,
  permission: string,
): Promise<MembershipActionResult> {
  if (!UUID.test(officerTermId) || typeof permission !== "string" || permission.length > 100) return { error: "Invalid input" };
  const caller = await requireCallerContext();
  try {
    await grantOfficerPermission(caller, officerTermId, permission);
  } catch (error) {
    return { error: messageFrom(error, "Could not grant the permission") };
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}

export async function revokeOfficerPermissionAction(
  slug: string,
  officerTermId: string,
  permission: string,
): Promise<MembershipActionResult> {
  if (!UUID.test(officerTermId) || typeof permission !== "string" || permission.length > 100) return { error: "Invalid input" };
  const caller = await requireCallerContext();
  try {
    await revokeOfficerPermission(caller, officerTermId, permission);
  } catch (error) {
    return { error: messageFrom(error, "Could not remove the permission") };
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true };
}
