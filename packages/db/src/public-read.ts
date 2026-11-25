/**
 * public-read.ts — the anonymous read path for a published collection page.
 *
 * write.ts states the rule this file is the exception to, and the exception is
 * structural rather than convenient. Ordinary reads go through the browser's
 * own Supabase client against `public` tables under RLS. A contributor has no
 * session, `anon` holds SELECT on no table at all (20260917121100: "anon gets
 * NOTHING"), and the entire anonymous surface is three SECURITY DEFINER
 * functions in the `app` schema — which PostgREST does not serve (ADR 0011).
 *
 * So the only way to read a public collection page is this: the Next.js server
 * calls those functions over the direct connection, as `anon`, and renders the
 * result. The connection is privileged; the role it runs as is not, and the
 * functions return whitelisted columns whatever the role.
 *
 * MONEY ARRIVES AS A STRING. `postgres` returns int8 as text rather than a
 * lossy JS number (see client.ts), and it is kept that way here: the caller
 * passes it to `@kolekto/domain`'s `kobo()`, which is where a monetary value
 * becomes a number of any kind (ADR 0003).
 */

import { ANONYMOUS, withCallerContext } from "./client.ts";

export interface PublicCollection {
  collection_id: string;
  collection_name: string;
  description: string | null;
  cover_image_url: string | null;
  category: string;
  participation_mode: "open" | "managed";
  amount_model: "fixed" | "open_amount" | "tiers" | "per_member" | "items";
  /** Whether this collection repeats. A recurring charge reads differently from a one-off on the public page (§10). */
  schedule: "one_time" | "recurring";
  /** Whether this collection is for anyone with the link, or for a named list of members. Who those members are never travels. */
  audience_mode: "all_members" | "groups" | "selected_members" | "public";
  payment_plan: "full_only" | "installments_allowed";
  fixed_amount_kobo: string | null;
  min_amount_kobo: string | null;
  max_amount_kobo: string | null;
  target_amount_kobo: string | null;
  /** One-tap choices on an open collection. A suggestion, never a charge — the amount is still resolved server-side. */
  suggested_amounts_kobo: string[];
  deadline_at: Date | null;
  /** When the event is, as opposed to when the collection closes. */
  event_starts_at: Date | null;
  event_ends_at: Date | null;
  venue: string | null;
  /** §18: whether the public form asks for one name per ticket unit ordered, not only the buyer's. */
  collect_attendee_details: boolean;
  /** §5/§19. Null on every collection whose category is not `fundraiser`. */
  story_what: string | null;
  story_why: string | null;
  story_impact: string | null;
  status: "active" | "paused" | "closed";
  display_options: Record<string, boolean>;
  fee_mode: "community_absorbs" | "contributor_pays";
  thank_you_message: string | null;
  community_name: string;
  community_logo_url: string | null;
  community_verified: "unverified" | "pending" | "verified" | "rejected" | "expired";
  /** How often a recurring collection repeats. Null on every collection that does not (M7.6 part V). */
  recurrence_frequency: "weekly" | "monthly" | "quarterly" | "yearly" | null;
  /** "every 2 months" is interval 2 on a monthly frequency. */
  recurrence_interval: number | null;
  /** How many days after a period opens the charge is due. */
  recurrence_due_after_days: number | null;
}

export interface PublicCollectionTier {
  tier_id: string;
  name: string;
  description: string | null;
  price_kobo: string;
  quantity_limit: number | null;
  per_order_limit: number | null;
  sort_order: number;
}

export interface PublicCollectionItem {
  item_id: string;
  name: string;
  description: string | null;
  price_kobo: string;
  /** How many are left to sell. `null` is unlimited, which is not the same as none. */
  quantity_available: number | null;
  max_per_order: number | null;
  image_url: string | null;
  sort_order: number;
}

export interface PublicCollectionField {
  field_id: string;
  key: string;
  label: string;
  type: "text" | "number" | "single_select" | "date";
  options: string[] | null;
  required: boolean;
  sort_order: number;
}

/** `null` when no published collection lives at that address — a draft, an unknown slug and a members-only collection are deliberately indistinguishable (SEC-12). */
export async function getPublicCollection(
  communitySlug: string,
  collectionSlug: string,
): Promise<PublicCollection | null> {
  const rows = await withCallerContext(ANONYMOUS, (tx) =>
    tx<PublicCollection[]>`select * from app.get_public_collection(${communitySlug}, ${collectionSlug})`,
  );
  return rows[0] ?? null;
}

export async function getPublicCollectionTiers(collectionId: string): Promise<PublicCollectionTier[]> {
  const rows = await withCallerContext(ANONYMOUS, (tx) =>
    tx<PublicCollectionTier[]>`select * from app.get_public_collection_tiers(${collectionId})`,
  );
  return [...rows];
}

/** What an item collection offers. Hidden items never appear, and identity travels as `item_id` — the page sends back an id, never a name or a price. */
export async function getPublicCollectionItems(collectionId: string): Promise<PublicCollectionItem[]> {
  const rows = await withCallerContext(ANONYMOUS, (tx) =>
    tx<PublicCollectionItem[]>`select * from app.get_public_collection_items(${collectionId})`,
  );
  return [...rows];
}

// ── Contributor self-identification (20260920170000) ───────────────────────
//
// findCollectionMember was removed in A2.2 (M9b3 revoked anon/authenticated
// execution of app.find_collection_member — owner decision D4). The membership
// pass flow (membershipPassSummary / confirmMembershipPass in membership.ts)
// replaces it.

export interface CollectionMemberContext {
  member_id: string;
  full_name: string;
  member_code: string | null;
  identifier_label: string | null;
  identifier_value: string | null;
  /** Null when this member has no obligation on this collection — they may still contribute if the collection lets them. */
  obligation_id: string | null;
  cycle_key: string | null;
  cycle_label: string | null;
  expected_amount_kobo: string | null;
  waived_amount_kobo: string | null;
  obligation_status: "unpaid" | "in_installments" | "overdue" | "paid" | "exempt" | "cancelled" | null;
  due_at: Date | null;
  /** "BIO26-0042" — this participation's reference, when the collection issues them (M7.6 part N). */
  contributor_reference: string | null;
}

/**
 * What an identified contributor is being asked for.
 *
 * `null` when the answer is no — a member who was archived since the lookup, an
 * id from another community, a collection that has closed. The reason is never
 * given, because every reason is a fact about somebody else.
 */
export async function getCollectionMemberContext(
  collectionId: string,
  memberId: string,
): Promise<CollectionMemberContext | null> {
  const rows = await withCallerContext(ANONYMOUS, (tx) =>
    tx<CollectionMemberContext[]>`select * from app.get_collection_member_context(${collectionId}, ${memberId})`,
  );
  return rows[0] ?? null;
}

export async function getPublicCollectionFields(collectionId: string): Promise<PublicCollectionField[]> {
  const rows = await withCallerContext(ANONYMOUS, (tx) =>
    tx<PublicCollectionField[]>`select * from app.get_public_collection_fields(${collectionId})`,
  );
  return [...rows];
}

// ── Public community page (20261122140000, D-H / D-J) ───────────────────────

export interface PublicCommunity {
  community_id: string;
  slug: string;
  name: string;
  type: string;
  description: string | null;
  logo_url: string | null;
  location_state: string | null;
  location_city: string | null;
  institution: string | null;
  verification_status: string;
  /** Only present when the owner chose to show contact details. */
  contact_email: string | null;
  contact_phone_e164: string | null;
  published_at: Date;
}

export interface PublicCommunityCollection {
  slug: string;
  name: string;
  description: string | null;
  cover_image_url: string | null;
  category: string;
  status: "active" | "paused" | "closed";
  amount_model: string;
  fixed_amount_kobo: string | null;
  min_amount_kobo: string | null;
  starts_at: Date | null;
  deadline_at: Date | null;
  event_starts_at: Date | null;
  published_at: Date | null;
}

/** A published, active, non-personal community's public identity, or null (the page is a 404). */
export async function getPublicCommunity(communitySlug: string): Promise<PublicCommunity | null> {
  const rows = await withCallerContext(ANONYMOUS, (tx) =>
    tx<PublicCommunity[]>`select * from app.get_public_community(${communitySlug})`,
  );
  return rows[0] ?? null;
}

/** The collections that community LISTS publicly (visibility = public). Never link-only or members-only. */
export async function listPublicCommunityCollections(communitySlug: string): Promise<PublicCommunityCollection[]> {
  const rows = await withCallerContext(ANONYMOUS, (tx) =>
    tx<PublicCommunityCollection[]>`select * from app.get_public_community_collections(${communitySlug})`,
  );
  return [...rows];
}
