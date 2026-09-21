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
import { ANONYMOUS, type CallerContext, runWrite, withCallerContext } from "./client.ts";
import type {
  AmountModel,
  CollectionCategory,
  CollectionSchedule,
  CollectionStatus,
  CollectionVisibility,
  CommunityType,
  InviteStatus,
  MemberAttributeType,
  MemberDuplicate,
  MemberStatus,
  OfficerRole,
  ParticipationMode,
  PaymentPlan,
} from "./types.ts";

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

/**
 * `attributes` is a map of the community's own field keys to values — the same
 * shape the old `members.attributes` column held, now validated against
 * `member_attribute_definitions` and stored as rows. The community's identifying
 * field (matric number, house number) is one of these keys; there is no separate
 * identifier argument, because which field identifies a person is the
 * community's decision, not the schema's.
 *
 * `confirmPossibleDuplicate` is the answer to a warning the caller has already
 * been shown. An *exact* duplicate — the community's unique field already
 * belongs to somebody — is refused whatever this says.
 */
export async function createMember(
  caller: CallerContext,
  input: {
    communityId: string;
    fullName: string;
    phoneE164?: string | undefined;
    email?: string | undefined;
    attributes?: MemberAttributes | undefined;
    groupIds?: string[] | undefined;
    confirmPossibleDuplicate?: boolean | undefined;
  },
): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string }[]>`select app.create_member(
      ${input.communityId}, ${input.fullName}, ${input.phoneE164 ?? null}, ${input.email ?? null},
      ${tx.json(input.attributes ?? {})}, ${input.groupIds ?? []}, ${input.confirmPossibleDuplicate ?? false}
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
    attributes?: MemberAttributes | undefined;
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.update_member(
      ${input.memberId}, ${input.fullName}, ${input.phoneE164 ?? null}, ${input.email ?? null},
      ${tx.json(input.attributes ?? {})}
    )`,
  );
}

export async function archiveMember(caller: CallerContext, input: { memberId: string; reason?: string | undefined }): Promise<void> {
  await call(caller, (tx) => tx`select app.archive_member(${input.memberId}, ${input.reason ?? null})`);
}

/** §42: the other half of archiving. Returns the status the member came back as — `active` only if they still have the phone number that status means (PRD 3.3). */
export async function restoreMember(
  caller: CallerContext,
  input: { memberId: string; reason?: string | undefined },
): Promise<MemberStatus> {
  const [row] = await call(caller, (tx) =>
    tx<{ status: MemberStatus }[]>`select app.restore_member(${input.memberId}, ${input.reason ?? null}) as status`,
  );
  return row!.status;
}

/** Asked before a member is created, so a person can be shown the existing record and decide. Creation asks again — a check the client performed is not a check. */
export async function findMemberDuplicates(
  caller: CallerContext,
  input: {
    communityId: string;
    fullName?: string | undefined;
    phoneE164?: string | undefined;
    email?: string | undefined;
    attributes?: MemberAttributes | undefined;
    excludeMemberId?: string | undefined;
  },
): Promise<MemberDuplicate[]> {
  const rows = await call(caller, (tx) =>
    tx<MemberDuplicate[]>`select * from app.find_member_duplicates(
      ${input.communityId}, ${input.fullName ?? null}, ${input.phoneE164 ?? null}, ${input.email ?? null},
      ${tx.json(input.attributes ?? {})}, ${input.excludeMemberId ?? null}
    )`,
  );
  return [...rows];
}

// ── Community member profile configuration ─────────────────────────────────

export async function updateMemberCodeSettings(
  caller: CallerContext,
  input: { communityId: string; prefix?: string | undefined; padding?: number | undefined; startingNumber?: number | undefined },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.update_member_code_settings(
      ${input.communityId}, ${input.prefix ?? null}, ${input.padding ?? 4}, ${input.startingNumber ?? null}
    )`,
  );
}

export async function upsertMemberAttributeDefinition(
  caller: CallerContext,
  input: {
    communityId: string;
    key: string;
    label: string;
    type: MemberAttributeType;
    options?: readonly string[] | undefined;
    requiredAtJoin?: boolean | undefined;
    isUnique?: boolean | undefined;
    isPrimaryIdentifier?: boolean | undefined;
    sortOrder?: number | undefined;
    definitionId?: string | undefined;
  },
): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string }[]>`select app.upsert_member_attribute_definition(
      ${input.communityId}, ${input.key}, ${input.label}, ${input.type},
      ${input.options ? [...input.options] : null}, ${input.requiredAtJoin ?? false},
      ${input.isUnique ?? false}, ${input.isPrimaryIdentifier ?? false},
      ${input.sortOrder ?? 0}, ${input.definitionId ?? null}
    ) as id`,
  );
  return row!.id;
}

export async function deleteMemberAttributeDefinition(caller: CallerContext, definitionId: string): Promise<void> {
  await call(caller, (tx) => tx`select app.delete_member_attribute_definition(${definitionId})`);
}

// ── Member groups (20260920130000) ─────────────────────────────────────────
//
// Groups are how a collection later says who it is for, so they are not merely
// labels: archiving keeps a group and its memberships, and deleting is possible
// only while nobody has ever been in it.

export async function createMemberGroup(
  caller: CallerContext,
  input: {
    communityId: string;
    name: string;
    description?: string | undefined;
    pickableAtJoin?: boolean | undefined;
    sortOrder?: number | undefined;
  },
): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string }[]>`select app.create_member_group(
      ${input.communityId}, ${input.name}, ${input.description ?? null},
      ${input.pickableAtJoin ?? false}, ${input.sortOrder ?? 0}
    ) as id`,
  );
  return row!.id;
}

export async function updateMemberGroup(
  caller: CallerContext,
  input: {
    groupId: string;
    name: string;
    description?: string | undefined;
    pickableAtJoin?: boolean | undefined;
    sortOrder?: number | undefined;
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.update_member_group(
      ${input.groupId}, ${input.name}, ${input.description ?? null},
      ${input.pickableAtJoin ?? false}, ${input.sortOrder ?? 0}
    )`,
  );
}

export async function setMemberGroupArchived(
  caller: CallerContext,
  input: { groupId: string; archived: boolean; reason?: string | undefined },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.set_member_group_archived(${input.groupId}, ${input.archived}, ${input.reason ?? null})`,
  );
}

/** Only a group nobody has ever been in. Anything else is archived, because who was in a group is how a past audience is read. */
export async function deleteMemberGroup(caller: CallerContext, groupId: string): Promise<void> {
  await call(caller, (tx) => tx`select app.delete_member_group(${groupId})`);
}

/** Returns how many memberships were created; members already in the group, and ids from another community, add nothing. */
export async function addMembersToGroup(
  caller: CallerContext,
  input: { groupId: string; memberIds: readonly string[] },
): Promise<number> {
  const [row] = await call(caller, (tx) =>
    tx<{ count: number }[]>`select app.add_members_to_group(${input.groupId}, ${[...input.memberIds]}) as count`,
  );
  return row!.count;
}

export async function removeMemberFromGroup(
  caller: CallerContext,
  input: { groupId: string; memberId: string },
): Promise<void> {
  await call(caller, (tx) => tx`select app.remove_member_from_group(${input.groupId}, ${input.memberId})`);
}

/** Full replace of one member's groups. Archived groups they already belong to are left alone — the form does not offer them, so their absence is not an instruction. */
export async function setMemberGroups(
  caller: CallerContext,
  input: { memberId: string; groupIds: readonly string[] },
): Promise<number> {
  const [row] = await call(caller, (tx) =>
    tx<{ count: number }[]>`select app.set_member_groups(${input.memberId}, ${[...input.groupIds]}) as count`,
  );
  return row!.count;
}

// ── Member invite links (MEM-05) ──────────────────────────────────────────

/**
 * `askedAttributeKeys` are the community's own member fields the join form
 * shows; `requiredAttributeKeys` must be a subset of them. Both are enforced by
 * the database at redemption, so a joiner cannot skip a required answer by
 * leaving it out of the request, or write a field the invitation never asked
 * for.
 */
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
    askedAttributeKeys?: readonly string[] | undefined;
    requiredAttributeKeys?: readonly string[] | undefined;
  },
): Promise<{ id: string; token: string }> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string; token: string }[]>`select * from app.create_invite_link(
      ${input.communityId}, ${input.groupIds ?? []}, ${input.allowGroupChoice ?? false},
      ${input.allowMultiGroup ?? false}, ${input.approveJoiners ?? false}, ${input.expiresAt ?? null},
      ${input.maxUses ?? null}, ${input.label ?? null},
      ${input.askedAttributeKeys ? [...input.askedAttributeKeys] : []},
      ${input.requiredAttributeKeys ? [...input.requiredAttributeKeys] : []}
    )`,
  );
  return row!;
}

export async function revokeInviteLink(caller: CallerContext, inviteLinkId: string): Promise<void> {
  await call(caller, (tx) => tx`select app.revoke_invite_link(${inviteLinkId})`);
}

/**
 * The one function ever called with `ANONYMOUS` (MEM-05).
 *
 * Returns the community member code, because the person who just joined should
 * be told who they now are (§16) rather than left to ask an officer.
 */
export async function redeemInviteLink(
  caller: CallerContext,
  input: {
    token: string;
    fullName: string;
    phoneE164: string;
    email?: string | undefined;
    groupIds?: string[] | undefined;
    attributes?: MemberAttributes | undefined;
  },
): Promise<{ memberId: string; status: MemberStatus; memberCode: string }> {
  const [row] = await call(caller, (tx) =>
    tx<{ member_id: string; status: MemberStatus; member_code: string }[]>`select * from app.redeem_invite_link(
      ${input.token}, ${input.fullName}, ${input.phoneE164}, ${input.email ?? null}, ${input.groupIds ?? []},
      ${tx.json(input.attributes ?? {})}
    )`,
  );
  return { memberId: row!.member_id, status: row!.status, memberCode: row!.member_code };
}

/** What an invite link shows the person opening it: the community, the groups they will land in, and the fields to ask. `null` when the link is unknown, revoked, expired or used up. */
export interface PublicInvite {
  community_name: string;
  community_logo_url: string | null;
  label: string | null;
  approve_joiners: boolean;
  allow_group_choice: boolean;
  allow_multi_group: boolean;
  preset_group_names: string[];
  /** The groups a joiner may additionally choose from — only populated when `allow_group_choice` is true. */
  pickable_groups: { id: string; name: string }[];
  fields: {
    key: string;
    label: string;
    type: MemberAttributeType;
    options: string[] | null;
    required: boolean;
  }[];
}

export async function getPublicInvite(token: string): Promise<PublicInvite | null> {
  const rows = await withCallerContext(ANONYMOUS, (tx) =>
    tx<PublicInvite[]>`select * from app.get_public_invite(${token})`,
  );
  return rows[0] ?? null;
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

// ── Collections (20260919120000) ───────────────────────────────────────────
//
// Every amount is a `bigint` of kobo, converted from what a person typed by
// `@kolekto/domain`'s `fromNaira` in the server action before it reaches here.
// Nothing in this file parses, rounds or adds money.

export interface CollectionConfigInput {
  name: string;
  category: CollectionCategory;
  description?: string | undefined;
  paymentPlan?: PaymentPlan | undefined;
  fixedAmountKobo?: bigint | undefined;
  minAmountKobo?: bigint | undefined;
  maxAmountKobo?: bigint | undefined;
  targetAmountKobo?: bigint | undefined;
  startsAt?: string | undefined;
  deadlineAt?: string | undefined;
  visibility?: CollectionVisibility | undefined;
  allowNonMembers?: boolean | undefined;
  allowAnonymous?: boolean | undefined;
  thankYouMessage?: string | undefined;
}

export async function createCollection(
  caller: CallerContext,
  input: CollectionConfigInput & {
    communityId: string;
    participationMode: ParticipationMode;
    amountModel: AmountModel;
    schedule?: CollectionSchedule | undefined;
  },
): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ id: string }[]>`select app.create_collection(
      ${input.communityId}, ${input.name}, ${input.category},
      ${input.participationMode}, ${input.amountModel}, ${input.description ?? null},
      ${input.paymentPlan ?? "full_only"}, ${input.schedule ?? "one_time"},
      ${input.fixedAmountKobo?.toString() ?? null}, ${input.minAmountKobo?.toString() ?? null},
      ${input.maxAmountKobo?.toString() ?? null}, ${input.targetAmountKobo?.toString() ?? null},
      ${input.startsAt ?? null}, ${input.deadlineAt ?? null},
      ${input.visibility ?? "unlisted"}, ${input.allowNonMembers ?? false},
      ${input.allowAnonymous ?? false}, ${input.thankYouMessage ?? null}
    ) as id`,
  );
  return row!.id;
}

/** Full-replace, like updateCommunityProfile. The slug is not editable: a shared link is a promise (COM-04's reasoning, applied to collections). */
export async function updateCollection(
  caller: CallerContext,
  input: CollectionConfigInput & {
    collectionId: string;
    amountModel?: AmountModel | undefined;
    participationMode?: ParticipationMode | undefined;
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.update_collection(
      ${input.collectionId}, ${input.name}, ${input.category}, ${input.description ?? null},
      ${input.amountModel ?? null}, ${input.participationMode ?? null}, ${input.paymentPlan ?? null},
      ${input.fixedAmountKobo?.toString() ?? null}, ${input.minAmountKobo?.toString() ?? null},
      ${input.maxAmountKobo?.toString() ?? null}, ${input.targetAmountKobo?.toString() ?? null},
      ${input.startsAt ?? null}, ${input.deadlineAt ?? null},
      ${input.visibility ?? "unlisted"}, ${input.allowNonMembers ?? false},
      ${input.allowAnonymous ?? false}, ${input.thankYouMessage ?? null}
    )`,
  );
}

export async function deleteDraftCollection(caller: CallerContext, collectionId: string): Promise<void> {
  await call(caller, (tx) => tx`select app.delete_draft_collection(${collectionId})`);
}

/**
 * STM-01. `expected` is the status the caller believes the collection is in;
 * a concurrent change fails the call rather than applying to a state the
 * operator never saw. Returns the status the collection actually reached —
 * publishing a collection with a future start date resolves to `scheduled`,
 * which is the database's decision, not the caller's.
 */
export async function transitionCollectionStatus(
  caller: CallerContext,
  input: { collectionId: string; expected: CollectionStatus; target: CollectionStatus; reason?: string | undefined },
): Promise<CollectionStatus> {
  const [row] = await call(caller, (tx) =>
    tx<{ status: CollectionStatus }[]>`select app.transition_collection_status(
      ${input.collectionId}, ${input.expected}, ${input.target}, ${input.reason ?? null}
    ) as status`,
  );
  return row!.status;
}

// ── Collection audience (20260920150000) ───────────────────────────────────
//
// Audience is configuration; an obligation is a record. These two never merge:
// setting an audience creates nothing, and syncing obligations is a deliberate
// act someone performs, never a consequence of a member joining a group.

export type CollectionAudienceMode = "all_members" | "groups" | "selected_members" | "public";

export async function setCollectionAudience(
  caller: CallerContext,
  input: { collectionId: string; audienceMode: CollectionAudienceMode; groupIds?: readonly string[] | undefined },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.set_collection_audience(
      ${input.collectionId}, ${input.audienceMode}, ${input.groupIds ? [...input.groupIds] : []}
    )`,
  );
}

/** `awaiting` is what the "N newly eligible members" prompt counts — eligible, with no obligation yet. */
export async function countCollectionAudience(
  caller: CallerContext,
  collectionId: string,
): Promise<{ eligible: number; with_obligation: number; awaiting: number }> {
  const [row] = await call(caller, (tx) =>
    tx<{ eligible: number; with_obligation: number; awaiting: number }[]>`
      select * from app.count_collection_audience(${collectionId})`,
  );
  return row ?? { eligible: 0, with_obligation: 0, awaiting: 0 };
}

/**
 * Returns how many obligations were created. Idempotent, and it never deletes one.
 *
 * `cycleKey` names the period the obligations belong to, and a recurring
 * collection refuses the call without one: October's charge and November's are
 * two separate debts, and an obligation belonging to no particular month could
 * not be told apart from either.
 */
export async function syncCollectionObligations(
  caller: CallerContext,
  input: {
    collectionId: string;
    expectedAmountKobo?: bigint | undefined;
    dueAt?: string | undefined;
    cycleKey?: string | undefined;
  },
): Promise<number> {
  const [row] = await call(caller, (tx) =>
    tx<{ count: number }[]>`select app.sync_collection_obligations(
      ${input.collectionId}, ${input.expectedAmountKobo?.toString() ?? null}, ${input.dueAt ?? null},
      ${input.cycleKey ?? null}
    ) as count`,
  );
  return row!.count;
}

export interface TierPayload {
  /** Present for an existing option. ADR 0010: identity is the id, never the name. */
  id?: string | undefined;
  name: string;
  description?: string | undefined;
  priceKobo: bigint;
  quantityLimit?: number | undefined;
  perOrderLimit?: number | undefined;
  codePrefix?: string | undefined;
  hidden?: boolean | undefined;
  sortOrder?: number | undefined;
}

export async function setCollectionTiers(
  caller: CallerContext,
  input: { collectionId: string; tiers: readonly TierPayload[] },
): Promise<number> {
  // price_kobo crosses as a string, not a JSON number: `JSON.stringify` cannot
  // represent a bigint at all, and a number would be a silent precision
  // decision in a money path (ADR 0003). The function casts it back to bigint.
  const payload = input.tiers.map((tier, index) => ({
    id: tier.id ?? null,
    name: tier.name,
    description: tier.description ?? null,
    price_kobo: tier.priceKobo.toString(),
    quantity_limit: tier.quantityLimit ?? null,
    per_order_limit: tier.perOrderLimit ?? null,
    code_prefix: tier.codePrefix ?? null,
    hidden: tier.hidden ?? false,
    sort_order: tier.sortOrder ?? index,
  }));

  const [row] = await call(caller, (tx) =>
    tx<{ count: number }[]>`select app.set_collection_tiers(${input.collectionId}, ${tx.json(payload)}) as count`,
  );
  return row!.count;
}

export async function setTierHidden(caller: CallerContext, tierId: string, hidden: boolean): Promise<void> {
  await call(caller, (tx) => tx`select app.set_tier_hidden(${tierId}, ${hidden})`);
}

// ── Type-specific configuration (20260920160100–160200) ────────────────────
//
// One collection type per function rather than one generic "settings" blob.
// Each of these writes named columns or rows the database can check, so an
// item's price is a bigint the money invariant sees and a recurrence is a
// schedule Postgres can step forward — not JSON nobody can constrain.

export interface CollectionItemPayload {
  /** Present for an existing item. ADR 0010 applied to items: identity is the id, never the name. */
  id?: string | undefined;
  name: string;
  description?: string | undefined;
  priceKobo: bigint;
  quantityAvailable?: number | undefined;
  maxPerOrder?: number | undefined;
  imageUrl?: string | undefined;
  hidden?: boolean | undefined;
  sortOrder?: number | undefined;
}

/** Full replace, matched by id. Draft only — a published item's price is part of the offer. */
export async function setCollectionItems(
  caller: CallerContext,
  input: { collectionId: string; items: readonly CollectionItemPayload[] },
): Promise<number> {
  const payload = input.items.map((item, index) => ({
    id: item.id ?? null,
    name: item.name,
    description: item.description ?? null,
    // As in setCollectionTiers: kobo crosses as a string, because JSON has no
    // bigint and a number here would be a silent precision decision (ADR 0003).
    price_kobo: item.priceKobo.toString(),
    quantity_available: item.quantityAvailable ?? null,
    max_per_order: item.maxPerOrder ?? null,
    image_url: item.imageUrl ?? null,
    hidden: item.hidden ?? false,
    sort_order: item.sortOrder ?? index,
  }));

  const [row] = await call(caller, (tx) =>
    tx<{ count: number }[]>`select app.set_collection_items(${input.collectionId}, ${tx.json(payload)}) as count`,
  );
  return row!.count;
}

export async function setItemHidden(caller: CallerContext, itemId: string, hidden: boolean): Promise<void> {
  await call(caller, (tx) => tx`select app.set_item_hidden(${itemId}, ${hidden})`);
}

/** The date and place a ticketed collection is for. Editable after publication: a venue moves, a price does not. */
export async function setCollectionEvent(
  caller: CallerContext,
  input: {
    collectionId: string;
    eventStartsAt?: string | undefined;
    eventEndsAt?: string | undefined;
    venue?: string | undefined;
    /** §18: ask the public form for one name per ticket unit ordered, not only the buyer's. */
    collectAttendeeDetails?: boolean | undefined;
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.set_collection_event(
      ${input.collectionId}, ${input.eventStartsAt ?? null}, ${input.eventEndsAt ?? null}, ${input.venue ?? null},
      ${input.collectAttendeeDetails ?? false}
    )`,
  );
}

/** Prompts on a fundraiser's page. They are suggestions only — the contributor's amount is still their own. */
export async function setCollectionSuggestedAmounts(
  caller: CallerContext,
  input: { collectionId: string; amountsKobo: readonly bigint[] },
): Promise<void> {
  const amounts = input.amountsKobo.map((amount) => amount.toString());
  await call(caller, (tx) => tx`select app.set_collection_suggested_amounts(${input.collectionId}, ${amounts})`);
}

export type RecurrenceFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

/** Draft only: members agreed to a monthly charge, and one that quietly became weekly would be charging them something else. */
export async function setCollectionRecurrence(
  caller: CallerContext,
  input: {
    collectionId: string;
    frequency: RecurrenceFrequency;
    intervalCount?: number | undefined;
    startsOn?: string | undefined;
    dueAfterDays?: number | undefined;
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.set_collection_recurrence(
      ${input.collectionId}, ${input.frequency}, ${input.intervalCount ?? 1},
      ${input.startsOn ?? null}, ${input.dueAfterDays ?? 0}
    )`,
  );
}

/** §5/§19. Refused by the database on any collection whose category is not `fundraiser`. */
export async function setCollectionStory(
  caller: CallerContext,
  input: {
    collectionId: string;
    storyWhat?: string | undefined;
    storyWhy?: string | undefined;
    storyImpact?: string | undefined;
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.set_collection_story(
      ${input.collectionId}, ${input.storyWhat ?? null}, ${input.storyWhy ?? null}, ${input.storyImpact ?? null}
    )`,
  );
}

export interface CollectionCycle {
  cycle_id: string;
  cycle_key: string;
  period_start: string;
  period_end: string;
}

/**
 * Opens the next period of a recurring collection.
 *
 * Manual on purpose (§38): the obligations a new month brings are money people
 * owe, and nothing in this phase creates that while no one is looking.
 */
export async function openCollectionCycle(caller: CallerContext, collectionId: string): Promise<CollectionCycle> {
  const [row] = await call(caller, (tx) =>
    tx<CollectionCycle[]>`select * from app.open_collection_cycle(${collectionId})`,
  );
  return row!;
}

/**
 * Points a collection at a flyer already uploaded to this deployment's own
 * bucket, or clears it with `undefined`.
 *
 * The bytes never come through here — the upload is a storage call in the web
 * app, made with the service role on the server. This records the result, and
 * the database re-checks that the URL is one of ours before storing it.
 */
export async function setCollectionCover(
  caller: CallerContext,
  input: { collectionId: string; coverImageUrl?: string | undefined },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.set_collection_cover(${input.collectionId}, ${input.coverImageUrl ?? null})`,
  );
}

export interface CollectionFieldPayload {
  key: string;
  label: string;
  type: MemberAttributeType;
  options?: readonly string[] | undefined;
  required?: boolean | undefined;
  sortOrder?: number | undefined;
}

export async function setCollectionFields(
  caller: CallerContext,
  input: { collectionId: string; fields: readonly CollectionFieldPayload[] },
): Promise<number> {
  const payload = input.fields.map((field, index) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options ?? null,
    required: field.required ?? false,
    sort_order: field.sortOrder ?? index,
  }));

  const [row] = await call(caller, (tx) =>
    tx<{ count: number }[]>`select app.set_collection_fields(${input.collectionId}, ${tx.json(payload)}) as count`,
  );
  return row!.count;
}

// ── Obligations (20260919120000) ───────────────────────────────────────────

/**
 * Returns how many obligations were created. Members who already have one are
 * skipped by the unique index rather than by a prior read, so two officers
 * assigning the same list at the same time cannot produce duplicates.
 *
 * `expectedAmountKobo` is read only for a per-member collection. Everywhere
 * else the collection states the amount and the function uses it, whatever is
 * passed here.
 */
export async function assignObligations(
  caller: CallerContext,
  input: {
    collectionId: string;
    /** Required on a recurring collection: an obligation belongs to a period. */
    cycleKey?: string | undefined;
    memberIds: readonly string[];
    expectedAmountKobo?: bigint | undefined;
    dueAt?: string | undefined;
    /** Which option, on a tiered collection. The tier supplies the amount; a caller-supplied figure is not a second source of truth for a price (ADR 0010). */
    tierId?: string | undefined;
  },
): Promise<number> {
  const [row] = await call(caller, (tx) =>
    tx<{ count: number }[]>`select app.assign_obligations(
      ${input.collectionId}, ${[...input.memberIds]}, ${input.expectedAmountKobo?.toString() ?? null},
      ${input.dueAt ?? null}, ${input.cycleKey ?? null}, ${input.tierId ?? null}
    ) as count`,
  );
  return row!.count;
}

export async function updateObligationAmount(
  caller: CallerContext,
  input: { obligationId: string; expectedAmountKobo: bigint },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.update_obligation_amount(${input.obligationId}, ${input.expectedAmountKobo.toString()})`,
  );
}

export async function cancelObligation(
  caller: CallerContext,
  input: { obligationId: string; reason?: string | undefined },
): Promise<void> {
  await call(caller, (tx) => tx`select app.cancel_obligation(${input.obligationId}, ${input.reason ?? null})`);
}

/** OBL-07. Not a payment: an exemption says this member is not expected to pay, and why. */
export async function exemptObligation(
  caller: CallerContext,
  input: { obligationId: string; reason: string },
): Promise<void> {
  await call(caller, (tx) => tx`select app.exempt_obligation(${input.obligationId}, ${input.reason})`);
}

/** OBL-08. Also not a payment: part of the balance is forgiven, and the record says so. */
export async function waiveObligationAmount(
  caller: CallerContext,
  input: { obligationId: string; waivedAmountKobo: bigint; reason: string },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.waive_obligation_amount(${input.obligationId}, ${input.waivedAmountKobo.toString()}, ${input.reason})`,
  );
}

// ── Event operations (M7.5) ─────────────────────────────────────────────────
//
// Admitting somebody at a door. The obligation is the guest list entry — no
// purchase is recorded anywhere in this phase (ADR 0006/0012), so what can
// honestly be checked in is the roll an officer created. Both calls are
// idempotent: the database returns the existing visit rather than raising
// when somebody is already inside, because a second tap at a busy entrance
// must not produce an error an operator has to read.

/** Admits the member an obligation belongs to. Returns the visit's id — the existing one when they are already inside. */
export async function checkInObligation(caller: CallerContext, obligationId: string): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ check_in_obligation: string }[]>`select app.check_in_obligation(${obligationId})`,
  );
  return row!.check_in_obligation;
}

/** Records that somebody admitted earlier has left. Does nothing if they are already outside. */
export async function checkOutObligation(caller: CallerContext, obligationId: string): Promise<void> {
  await call(caller, (tx) => tx`select app.check_out_obligation(${obligationId})`);
}

// ── Contributor references (M7.6) ───────────────────────────────────────────
//
// "BIO26-0042". Every one of these is a call into a SECURITY DEFINER function
// that re-checks the permission and derives tenancy from the row, because a
// reference is an identifier people act on — it goes on a receipt, and it is
// what somebody reads out when they ring up to ask about their money.

/** The format an organiser chose. Refused by the database once references have been issued, because those are already on paper somewhere. */
export async function setCollectionCodeSettings(
  caller: CallerContext,
  input: {
    collectionId: string;
    enabled: boolean;
    prefix: string | null;
    separator: string;
    digits: number;
    startNumber: number;
    style: "sequential" | "random";
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.set_collection_code_settings(
      ${input.collectionId}, ${input.enabled}, ${input.prefix}, ${input.separator},
      ${input.digits}, ${input.startNumber}, ${input.style}
    )`,
  );
}

/** Issues (or returns) the reference for one participation. Idempotent. */
export async function issueContributorReference(caller: CallerContext, obligationId: string): Promise<string> {
  const [row] = await call(caller, (tx) =>
    tx<{ issue_contributor_reference: string }[]>`select app.issue_contributor_reference(${obligationId})`,
  );
  return row!.issue_contributor_reference;
}

/** Gives a reference to everyone on the roll who has not got one. Returns how many were issued. */
export async function issueContributorReferencesForCollection(
  caller: CallerContext,
  collectionId: string,
): Promise<number> {
  const [row] = await call(caller, (tx) =>
    tx<{ count: number }[]>`select app.issue_contributor_references_for_collection(${collectionId}) as count`,
  );
  return row!.count;
}

/**
 * Records that member data left the system (part Z).
 *
 * The column names are logged, never a value out of any row: an audit trail
 * of an export must not become a second copy of the personal data it is
 * auditing (SEC-26).
 */
export async function recordCollectionExport(
  caller: CallerContext,
  input: {
    collectionId: string;
    subject: string;
    format: string;
    rowCount: number;
    fields: readonly string[];
  },
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.record_collection_export(
      ${input.collectionId}, ${input.subject}, ${input.format}, ${input.rowCount}, ${[...input.fields]}
    )`,
  );
}

/** M7.6 part A4: remembers how far through the wizard a draft got, so reopening it lands where the organiser left off. */
export async function setCollectionDraftStep(
  caller: CallerContext,
  input: { collectionId: string; step: number },
): Promise<void> {
  await call(caller, (tx) => tx`select app.set_collection_draft_step(${input.collectionId}, ${input.step})`);
}
