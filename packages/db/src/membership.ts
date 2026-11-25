/**
 * Membership foundation callers (20261123100100; product doc Part F §F4, §F6, §F9).
 *
 * Owner decision A1 (2026-11-23, migration 20261123120000): the membership ID
 * is stored as plaintext. The web server generates it (apps/web/lib/membership-id.ts)
 * and passes it here as a bind parameter; it is never interpolated into SQL
 * text, never logged, and never echoed by the SQL functions. Every function
 * re-checks permission in SQL.
 */

import type { TransactionSql } from "postgres";
import { ANONYMOUS, type CallerContext, DatabaseError, runWrite, withCallerContext } from "./client.ts";
import type { MemberStatus, OfficerRole } from "./types.ts";

function call<T>(caller: CallerContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => withCallerContext(caller, fn));
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

// ── Delegated permissions (Q2) ─────────────────────────────────────────────

export interface DelegablePermission {
  permission: string;
  description: string;
}

export interface OfficerPermissionGrant {
  officerTermId: string;
  officerName: string;
  role: OfficerRole;
  permission: string;
  grantedAt: string;
}

export async function listDelegablePermissions(caller: CallerContext): Promise<DelegablePermission[]> {
  return call(caller, (tx) => tx<DelegablePermission[]>`select permission, description from app.list_delegable_permissions()`);
}

export async function listOfficerPermissionGrants(
  caller: CallerContext,
  communityId: string,
): Promise<OfficerPermissionGrant[]> {
  const rows = await call(caller, (tx) =>
    tx<{ officer_term_id: string; officer_name: string; role: OfficerRole; permission: string; granted_at: Date }[]>`
      select * from app.list_officer_permission_grants(${communityId})`,
  );
  return rows.map((r) => ({
    officerTermId: r.officer_term_id,
    officerName: r.officer_name,
    role: r.role,
    permission: r.permission,
    grantedAt: iso(r.granted_at)!,
  }));
}

export async function grantOfficerPermission(caller: CallerContext, officerTermId: string, permission: string): Promise<void> {
  await call(caller, (tx) => tx`select app.grant_officer_permission(${officerTermId}, ${permission})`);
}

export async function revokeOfficerPermission(caller: CallerContext, officerTermId: string, permission: string): Promise<void> {
  await call(caller, (tx) => tx`select app.revoke_officer_permission(${officerTermId}, ${permission})`);
}

/** The caller's own granted permissions in a community (UI mirror only; SQL enforces). */
export async function myGrantedPermissions(caller: CallerContext, communityId: string): Promise<string[]> {
  const rows = await call(caller, (tx) => tx<{ permission: string }[]>`select permission from app.my_granted_permissions(${communityId})`);
  return rows.map((r) => r.permission);
}

// ── Format settings ────────────────────────────────────────────────────────

export interface MembershipIdSettings {
  prefix: string;
  separator: "/" | "-";
  suffixLength: number;
  enabled: boolean;
  updatedAt: string | null;
}

export async function getMembershipIdSettings(
  caller: CallerContext,
  communityId: string,
): Promise<MembershipIdSettings | null> {
  const rows = await call(caller, (tx) =>
    tx<{ prefix: string; separator: "/" | "-"; suffix_length: number; enabled: boolean; updated_at: Date | null }[]>`
      select * from app.get_membership_id_settings(${communityId})`,
  );
  const r = rows[0];
  return r
    ? { prefix: r.prefix, separator: r.separator, suffixLength: Number(r.suffix_length), enabled: r.enabled, updatedAt: iso(r.updated_at) }
    : null;
}

export async function setMembershipIdSettings(
  caller: CallerContext,
  input: { communityId: string; prefix: string; separator: "/" | "-"; suffixLength: number; enabled: boolean },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.set_membership_id_settings(${input.communityId}, ${input.prefix}, ${input.separator},
         ${input.suffixLength}::smallint, ${input.enabled})`,
  );
}

// ── Issue / replace / revoke ───────────────────────────────────────────────

/** True when the database refused because the random ID already exists in this community: regenerate and retry. */
export function isMembershipIdCollision(error: unknown): boolean {
  return error instanceof DatabaseError && error.message.includes("MEMBERSHIP_ID_COLLISION");
}

/** True when the community holds legacy fingerprint-only rows (D1) and no fingerprint was supplied. */
export function isLegacyCheckUnavailable(error: unknown): boolean {
  return error instanceof DatabaseError && error.message.includes("LEGACY_CHECK_UNAVAILABLE");
}

/** `legacyFingerprint`: see app.issue_membership_id — required only in a community with legacy fingerprint-only rows. */
export async function issueMembershipId(
  caller: CallerContext,
  memberId: string,
  membershipId: string,
  legacyFingerprint: Buffer | null,
): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string }[]>`select app.issue_membership_id(${memberId}, ${membershipId}, ${legacyFingerprint}::bytea) as id`,
  );
  return row!.id;
}

export async function rotateMembershipId(
  caller: CallerContext,
  memberId: string,
  membershipId: string,
  reason: string | null,
  legacyFingerprint: Buffer | null,
): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string }[]>`select app.rotate_membership_id(${memberId}, ${membershipId}, ${reason}, ${legacyFingerprint}::bytea) as id`,
  );
  return row!.id;
}

export async function revokeMembershipId(caller: CallerContext, memberId: string, reason: string): Promise<void> {
  await call(caller, (tx) => tx`select app.revoke_membership_id(${memberId}, ${reason})`);
}

export interface StoredMembershipId {
  membershipIdId: string;
  /** The full ID (plaintext, A1). Null only for a live legacy row not yet backfilled. */
  membershipId: string | null;
  prefix: string;
  separator: string;
  last2: string;
  issuedAt: string;
}

export async function getMemberMembershipId(caller: CallerContext, memberId: string): Promise<StoredMembershipId | null> {
  const rows = await call(caller, (tx) =>
    tx<{ membership_id_id: string; membership_id: string | null; prefix: string; separator: string; last2: string; issued_at: Date }[]>`
      select * from app.get_member_membership_id(${memberId})`,
  );
  const r = rows[0];
  return r
    ? {
        membershipIdId: r.membership_id_id,
        membershipId: r.membership_id,
        prefix: r.prefix,
        separator: r.separator,
        last2: r.last2,
        issuedAt: iso(r.issued_at)!,
      }
    : null;
}

export async function membersWithoutMembershipId(caller: CallerContext, communityId: string, limit = 200): Promise<string[]> {
  const rows = await call(caller, (tx) =>
    tx<{ member_id: string }[]>`select member_id from app.members_without_membership_id(${communityId}, ${limit})`,
  );
  return rows.map((r) => r.member_id);
}

export async function communityMembershipIdSummary(
  caller: CallerContext,
  communityId: string,
): Promise<Map<string, { masked: string; issuedAt: string }>> {
  const rows = await call(caller, (tx) =>
    tx<{ member_id: string; masked: string; issued_at: Date }[]>`select * from app.community_membership_id_summary(${communityId})`,
  );
  return new Map(rows.map((r) => [r.member_id, { masked: r.masked, issuedAt: iso(r.issued_at)! }]));
}

// ── Suspension ─────────────────────────────────────────────────────────────

export async function suspendMember(caller: CallerContext, memberId: string, reason: string): Promise<void> {
  await call(caller, (tx) => tx`select app.suspend_member(${memberId}, ${reason})`);
}

export async function reinstateMember(caller: CallerContext, memberId: string, reason: string | null): Promise<MemberStatus> {
  const [row] = await call(caller, (tx) => tx<{ status: MemberStatus }[]>`select app.reinstate_member(${memberId}, ${reason}) as status`);
  return row!.status;
}

// ── Membership pass (M9b3; anonymous; consumed by the confirmation screen) ──

export interface MembershipPassSummary {
  fullName: string;
  emailMasked: string | null;
  phoneMasked: string | null;
}

/**
 * What the confirmation screen shows after a membership ID validates.
 *
 * Returns the member's full name and masked contact details, or null when the
 * token is invalid, expired, revoked or belongs to another collection. The full
 * email and phone never leave the database on this path: masking happens in SQL
 * (`app.mask_email`, `app.mask_phone`).
 */
export async function membershipPassSummary(
  collectionId: string,
  token: string,
): Promise<MembershipPassSummary | null> {
  const rows = await call(ANONYMOUS, (tx) =>
    tx<{ full_name: string; email_masked: string | null; phone_masked: string | null }[]>`
      select * from app.membership_pass_summary(${collectionId}, ${token})`,
  );
  const r = rows[0];
  return r ? { fullName: r.full_name, emailMasked: r.email_masked, phoneMasked: r.phone_masked } : null;
}

/**
 * "Yes, continue" — the contributor confirmed their identity.
 *
 * Re-checks the pass live and writes one masked `membership.identity_confirmed`
 * audit row. Returns the member UUID to trusted server-side code, or null when
 * the token is no longer valid. The member UUID must never reach a browser-facing
 * response or log.
 */
export async function confirmMembershipPass(
  collectionId: string,
  token: string,
): Promise<string | null> {
  const rows = await call(ANONYMOUS, (tx) =>
    tx<{ member_id: string | null }[]>`select app.confirm_membership_pass(${collectionId}, ${token}) as member_id`,
  );
  return rows[0]?.member_id ?? null;
}

// ── Validation (anonymous; consumed by the members-only journey) ───────────

export interface MembershipValidationResult {
  valid: boolean;
  accessToken: string | null;
  expiresAt: string | null;
}

/** One generic answer for every failure. Never returns who the member is. */
export async function validateMembershipId(
  collectionId: string,
  typedMembershipId: string,
  clientAddressHash: Buffer,
): Promise<MembershipValidationResult> {
  const rows = await call(ANONYMOUS, (tx) =>
    tx<{ valid: boolean; access_token: string | null; expires_at: Date | null }[]>`
      select * from app.validate_membership_id(${collectionId}, ${typedMembershipId}, ${clientAddressHash})`,
  );
  const r = rows[0];
  return { valid: r?.valid === true, accessToken: r?.access_token ?? null, expiresAt: iso(r?.expires_at ?? null) };
}

/** The member a pass stands for on this collection, or null — re-checked live. */
export async function resolveMembershipAccessGrant(collectionId: string, token: string): Promise<string | null> {
  const rows = await call(ANONYMOUS, (tx) =>
    tx<{ member_id: string | null }[]>`select app.resolve_membership_access_grant(${collectionId}, ${token}) as member_id`,
  );
  return rows[0]?.member_id ?? null;
}
