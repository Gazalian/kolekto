import { notFound } from "next/navigation";
import Link from "next/link";
import { CollectionView } from "../../../../../[communitySlug]/[collectionSlug]/CollectionView.tsx";
import { getCommunityAccess, hasPermission } from "../../../../../../lib/permissions.ts";
import { createClient } from "../../../../../../lib/supabase/server.ts";

/**
 * Preview as a contributor (M7.5 part B).
 *
 * The organiser's question is "what will people actually see?", and the only
 * answer worth giving is the real thing — so this renders `CollectionView`,
 * the same component the published page renders, from the draft's own rows.
 * A summary that lists the fields back would drift from the page within a
 * milestone; this cannot, because there is only one of it.
 *
 * Two deliberate differences from the live page:
 *
 *   · It reads through the officer's own session (RLS scopes it to
 *     communities they hold a role in) rather than `app.get_public_collection`,
 *     because a draft is invisible to that function on purpose — a draft has
 *     no public face yet, which is the whole reason a preview exists.
 *   · `mode="preview"` renders the contribution step as a description of what
 *     will be asked instead of a working form. Submitting a preview would be
 *     the organiser contributing to their own collection, and in a later
 *     phase a payment attempt against it.
 */

export const metadata = { title: "Preview" };

export default async function CollectionPreviewPage({
  params,
}: {
  params: Promise<{ slug: string; collectionSlug: string }>;
}) {
  const { slug, collectionSlug } = await params;
  const supabase = await createClient();

  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();

  const { data: collection } = await supabase
    .from("collections")
    .select("*")
    .eq("community_id", community.id)
    .eq("slug", collectionSlug)
    .maybeSingle();
  if (!collection) notFound();

  // Previewing is reading your own draft. `collection.draft` is the permission
  // that lets someone see and shape one, so it is the permission that lets
  // them look at it as a contributor would.
  const access = await getCommunityAccess(community.id);
  if (!hasPermission(access, "collection.draft")) notFound();

  const [{ data: tiers }, { data: items }, { data: fields }] = await Promise.all([
    supabase.from("collection_tiers").select("*").eq("collection_id", collection.id).order("sort_order"),
    supabase.from("collection_items").select("*").eq("collection_id", collection.id).order("sort_order"),
    supabase.from("collection_fields").select("*").eq("collection_id", collection.id).order("sort_order"),
  ]);

  const kobo = (value: number | null): string | null => (value === null ? null : String(value));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-[var(--color-text)]">Preview as a contributor</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {collection.status === "draft"
              ? "This is what people will see once you publish. Nothing here can be submitted."
              : "This is what people see on the public page. Nothing here can be submitted."}
          </p>
        </div>
        <Link
          href={`/c/${slug}/collections/${collectionSlug}`}
          className="text-sm font-medium text-[var(--color-primary)] hover:underline"
        >
          ← Back to the collection
        </Link>
      </div>

      <CollectionView
        mode="preview"
        communitySlug={slug}
        collectionSlug={collectionSlug}
        collection={{
          collection_id: collection.id,
          collection_name: collection.name,
          description: collection.description,
          cover_image_url: collection.cover_image_url,
          category: collection.category,
          audience_mode: collection.audience_mode,
          amount_model: collection.amount_model,
          schedule: collection.schedule,
          fixed_amount_kobo: kobo(collection.fixed_amount_kobo),
          min_amount_kobo: kobo(collection.min_amount_kobo),
          max_amount_kobo: kobo(collection.max_amount_kobo),
          target_amount_kobo: kobo(collection.target_amount_kobo),
          suggested_amounts_kobo: (collection.suggested_amounts_kobo ?? []).map((amount: number) => String(amount)),
          deadline_at: collection.deadline_at,
          event_starts_at: collection.event_starts_at,
          venue: collection.venue,
          collect_attendee_details: collection.collect_attendee_details,
          story_what: collection.story_what,
          story_why: collection.story_why,
          story_impact: collection.story_impact,
          // A draft has no contributor-facing status of its own; it previews
          // as the page it will become.
          status: collection.status === "draft" ? "active" : (collection.status as "active" | "paused" | "closed"),
          thank_you_message: collection.thank_you_message,
          community_name: community.name,
          community_verified: community.verification_status,
        }}
        tiers={(tiers ?? []).map((tier) => ({
          id: tier.id,
          name: tier.name,
          description: tier.description,
          price_kobo: String(tier.price_kobo),
          quantity_limit: tier.quantity_limit,
          per_order_limit: tier.per_order_limit,
        }))}
        items={(items ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          price_kobo: String(item.price_kobo),
          quantity_available: item.quantity_available,
          max_per_order: item.max_per_order,
          image_url: item.image_url,
        }))}
        fields={(fields ?? []).map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          options: field.options,
          required: field.required,
        }))}
      />
    </div>
  );
}
