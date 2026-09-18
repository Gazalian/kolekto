/**
 * write.ts — typed callers for every function in
 * 20260918140100_application_write_functions.sql.
 *
 * Each one opens a transaction impersonating the caller (`withCallerContext`)
 * and calls exactly one `app.*` function. No other SQL belongs in this file —
 * a second statement here would be a write happening outside the function the
 * database was built to make load-bearing (ADR 0008, SEC-14, SEC-17). Reads
 * belong to the browser's own Supabase client against `public` tables with
 * RLS (see apps/web/lib/supabase), not here.
 */

import type { TransactionSql } from "postgres";
import { type CallerContext, runWrite, withCallerContext } from "./client.ts";
import type { CommunityType, InviteStatus, MemberStatus, OfficerRole } from "./types.ts";

async function call<T>(caller: CallerContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => withCallerContext(caller, fn));
}

/** Shaped to match `member_attribute_type` (text, number, single_select, date — the last two stored as text): plain JSON scalars only, never a nested object array `postgres`'s `JSONValue` cannot describe as `unknown`. */
export type MemberAttributes = Record<string, string | number | boolean | null>;

// ── Communities ────────────────────────────────────────────────────────────

export async function createCommunity(
  caller: CallerContext,
  input: { name: string; type: Exclude<CommunityType, "personal">; description?: string | undefined },
): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string }[]>`select app.create_community(${input.name}, ${input.type}, ${input.description ?? null}) as id`,
  );
  return row!.id;
}

export async function updateCommunityProfile(
  caller: CallerContext,
  input: {
    communityId: string;
    name: string;
    description?: string | undefined;
    logoUrl?: string | undefined;
    locationState?: string | undefined;
    locationCity?: string | undefined;
    institution?: string | undefined;
    contactEmail?: string | undefined;
    contactPhoneE164?: string | undefined;
    showOfficersPublicly: boolean;
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.update_community_profile(
      ${input.communityId}, ${input.name}, ${input.description ?? null}, ${input.logoUrl ?? null},
      ${input.locationState ?? null}, ${input.locationCity ?? null}, ${input.institution ?? null},
      ${input.contactEmail ?? null}, ${input.contactPhoneE164 ?? null}, ${input.showOfficersPublicly}
    )`,
  );
}

// ── Members ────────────────────────────────────────────────────────────────

export async function createMember(
  caller: CallerContext,
  input: {
    communityId: string;
    fullName: string;
    phoneE164?: string | undefined;
    email?: string | undefined;
    identifier?: string | undefined;
    attributes?: MemberAttributes | undefined;
    groupIds?: string[] | undefined;
  },
): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string }[]>`select app.create_member(
      ${input.communityId}, ${input.fullName}, ${input.phoneE164 ?? null}, ${input.email ?? null},
      ${input.identifier ?? null}, ${tx.json(input.attributes ?? {})}, ${input.groupIds ?? []}
    ) as id`,
  );
  return row!.id;
}

export async function updateMember(
  caller: CallerContext,
  input: {
    memberId: string;
    fullName: string;
    phoneE164?: string | undefined;
    email?: string | undefined;
    identifier?: string | undefined;
    attributes?: MemberAttributes | undefined;
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.update_member(
      ${input.memberId}, ${input.fullName}, ${input.phoneE164 ?? null}, ${input.email ?? null},
      ${input.identifier ?? null}, ${tx.json(input.attributes ?? {})}
    )`,
  );
}

export async function archiveMember(caller: CallerContext, input: { memberId: string; reason?: string | undefined }): Promise<void> {
  await call(caller, (tx) => tx`select app.archive_member(${input.memberId}, ${input.reason ?? null})`);
}

// ── Member invite links (MEM-05) ──────────────────────────────────────────

export async function createInviteLink(
  caller: CallerContext,
  input: {
    communityId: string;
    groupIds?: string[] | undefined;
    allowGroupChoice?: boolean | undefined;
    allowMultiGroup?: boolean | undefined;
    approveJoiners?: boolean | undefined;
    expiresAt?: string | undefined;
    maxUses?: number | undefined;
    label?: string | undefined;
  },
): Promise<{ id: string; token: string }> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string; token: string }[]>`select * from app.create_invite_link(
      ${input.communityId}, ${input.groupIds ?? []}, ${input.allowGroupChoice ?? false},
      ${input.allowMultiGroup ?? false}, ${input.approveJoiners ?? false}, ${input.expiresAt ?? null},
      ${input.maxUses ?? null}, ${input.label ?? null}
    )`,
  );
  return row!;
}

export async function revokeInviteLink(caller: CallerContext, inviteLinkId: string): Promise<void> {
  await call(caller, (tx) => tx`select app.revoke_invite_link(${inviteLinkId})`);
}

/** The one function ever called with `ANONYMOUS` (MEM-05). */
export async function redeemInviteLink(
  caller: CallerContext,
  input: { token: string; fullName: string; phoneE164: string; email?: string | undefined; groupIds?: string[] | undefined },
): Promise<{ memberId: string; status: MemberStatus }> {
  const [row] = await call(caller, (tx) =>
    tx<{ member_id: string; status: MemberStatus }[]>`select * from app.redeem_invite_link(
      ${input.token}, ${input.fullName}, ${input.phoneE164}, ${input.email ?? null}, ${input.groupIds ?? []}
    )`,
  );
  return { memberId: row!.member_id, status: row!.status };
}

export async function approvePendingMember(caller: CallerContext, memberId: string): Promise<void> {
  await call(caller, (tx) => tx`select app.approve_pending_member(${memberId})`);
}

export async function rejectPendingMember(caller: CallerContext, memberId: string, reason?: string | undefined): Promise<void> {
  await call(caller, (tx) => tx`select app.reject_pending_member(${memberId}, ${reason ?? null})`);
}

// ── Officer invitations (OFF-01) ──────────────────────────────────────────

export async function createOfficerInvitation(
  caller: CallerContext,
  input: {
    communityId: string;
    role: OfficerRole;
    title?: string | undefined;
    inviteeName?: string | undefined;
    inviteePhoneE164?: string | undefined;
    inviteeEmail?: string | undefined;
  },
): Promise<{ id: string; token: string }> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string; token: string }[]>`select * from app.create_officer_invitation(
      ${input.communityId}, ${input.role}, ${input.title ?? null}, null,
      ${input.inviteeName ?? null}, ${input.inviteePhoneE164 ?? null}, ${input.inviteeEmail ?? null}
    )`,
  );
  return row!;
}

export async function revokeOfficerInvitation(caller: CallerContext, invitationId: string): Promise<void> {
  await call(caller, (tx) => tx`select app.revoke_officer_invitation(${invitationId})`);
}

export async function acceptOfficerInvitation(caller: CallerContext, token: string): Promise<string> {
  const [row] = await call(caller, (tx) => tx<{ id: string }[]>`select app.accept_officer_invitation(${token}) as id`);
  return row!.id;
}

export async function declineOfficerInvitation(caller: CallerContext, token: string): Promise<void> {
  await call(caller, (tx) => tx`select app.decline_officer_invitation(${token})`);
}

// ── Officer terms ──────────────────────────────────────────────────────────

export async function endOfficerTerm(caller: CallerContext, officerTermId: string, reason?: string | undefined): Promise<void> {
  await call(caller, (tx) => tx`select app.end_officer_term(${officerTermId}, ${reason ?? null})`);
}
