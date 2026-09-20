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
  amount_model: "fixed" | "open_amount" | "tiers" | "per_member";
  payment_plan: "full_only" | "installments_allowed";
  fixed_amount_kobo: string | null;
  min_amount_kobo: string | null;
  max_amount_kobo: string | null;
  target_amount_kobo: string | null;
  deadline_at: Date | null;
  status: "active" | "paused" | "closed";
  display_options: Record<string, boolean>;
  fee_mode: "community_absorbs" | "contributor_pays";
  thank_you_message: string | null;
  community_name: string;
  community_logo_url: string | null;
  community_verified: "unverified" | "pending" | "verified" | "rejected" | "expired";
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

export async function getPublicCollectionFields(collectionId: string): Promise<PublicCollectionField[]> {
  const rows = await withCallerContext(ANONYMOUS, (tx) =>
    tx<PublicCollectionField[]>`select * from app.get_public_collection_fields(${collectionId})`,
  );
  return [...rows];
}
