import {
  getPublicCollection,
  getPublicCollectionFields,
  getPublicCollectionItems,
  getPublicCollectionTiers,
} from "@kolekto/db";
import { notFound } from "next/navigation";
import { CollectionView } from "./CollectionView.tsx";

/**
 * The published collection page — the one screen in Kolekto a contributor ever
 * sees, and the only anonymous surface in the product.
 *
 * It is rendered from `app.get_public_collection` and its two companions, which
 * return a whitelist of columns for published collections only (SEC-12). There
 * is no Supabase session here and no table read: `anon` holds SELECT on nothing
 * at all, by design. A draft, an unknown slug and a members-only collection are
 * all a 404, which is what keeps a link from confirming what exists.
 *
 * What it deliberately does not show: any figure about money received. Progress
 * bars, contributor counts and amounts raised are configured in
 * `display_options` and stay unrendered until contributions exist (ADR 0006) —
 * an empty progress bar is a claim, and this page makes none.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ communitySlug: string; collectionSlug: string }>;
}) {
  const { communitySlug, collectionSlug } = await params;
  const collection = await getPublicCollection(communitySlug, collectionSlug);
  if (!collection) return { title: "Not found" };
  return {
    title: `${collection.collection_name} · ${collection.community_name}`,
    description: collection.description ?? undefined,
  };
}

export default async function PublicCollectionPage({
  params,
}: {
  params: Promise<{ communitySlug: string; collectionSlug: string }>;
}) {
  const { communitySlug, collectionSlug } = await params;

  const collection = await getPublicCollection(communitySlug, collectionSlug);
  if (!collection) notFound();

  const [tiers, items, fields] = await Promise.all([
    collection.amount_model === "tiers" ? getPublicCollectionTiers(collection.collection_id) : Promise.resolve([]),
    collection.amount_model === "items" ? getPublicCollectionItems(collection.collection_id) : Promise.resolve([]),
    getPublicCollectionFields(collection.collection_id),
  ]);

  return (
    <CollectionView
      mode="live"
      communitySlug={communitySlug}
      collectionSlug={collectionSlug}
      collection={collection}
      tiers={tiers.map((tier) => ({
        id: tier.tier_id,
        name: tier.name,
        description: tier.description,
        price_kobo: tier.price_kobo,
        quantity_limit: tier.quantity_limit,
        per_order_limit: tier.per_order_limit,
      }))}
      items={items.map((item) => ({
        id: item.item_id,
        name: item.name,
        description: item.description,
        price_kobo: item.price_kobo,
        quantity_available: item.quantity_available,
        max_per_order: item.max_per_order,
        image_url: item.image_url,
      }))}
      fields={fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        options: field.options,
        required: field.required,
      }))}
    />
  );
}
