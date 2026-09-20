import { getPublicCollection, getPublicCollectionFields, getPublicCollectionTiers } from "@kolekto/db";
import { notFound } from "next/navigation";
import { ContributeForm } from "./ContributeForm.tsx";
import { naira } from "../../../lib/collection-display.ts";

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

  const [tiers, fields] = await Promise.all([
    collection.amount_model === "tiers" ? getPublicCollectionTiers(collection.collection_id) : Promise.resolve([]),
    getPublicCollectionFields(collection.collection_id),
  ]);

  const deadline = collection.deadline_at ? new Date(collection.deadline_at) : null;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          {/* Who is asking. A contributor's first question, so it is the first
              thing on the page (section 19: WHO). */}
          <span className="font-medium text-[var(--color-text)]">{collection.community_name}</span>
          {collection.community_verified === "verified" && (
            <span className="rounded-[var(--radius-sm)] bg-[var(--color-success-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-success)]">
              Verified
            </span>
          )}
        </div>

        <h1 className="text-2xl font-semibold text-[var(--color-text)]">{collection.collection_name}</h1>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--color-text-muted)]">
          {collection.amount_model === "fixed" && collection.fixed_amount_kobo && (
            <span className="font-medium text-[var(--color-text)]">{naira(collection.fixed_amount_kobo)}</span>
          )}
          {deadline && <span>Closes {deadline.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</span>}
          {collection.target_amount_kobo && <span>Target: {naira(collection.target_amount_kobo)}</span>}
        </div>
      </header>

      {collection.description && (
        <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--color-text-muted)]">
          {collection.description}
        </p>
      )}

      {collection.status === "paused" && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-warning-bg)] px-4 py-3 text-sm text-[var(--color-text)]">
          {collection.community_name} has paused this collection. It is not accepting contributions right now.
        </div>
      )}

      {collection.status === "closed" && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-sm text-[var(--color-text)]">
          This collection is closed and is no longer accepting contributions.
        </div>
      )}

      {collection.status === "active" && (
        <ContributeForm
          communitySlug={communitySlug}
          collectionSlug={collectionSlug}
          amountModel={collection.amount_model}
          fixedAmount={collection.fixed_amount_kobo ? naira(collection.fixed_amount_kobo) : null}
          minAmount={collection.min_amount_kobo ? naira(collection.min_amount_kobo) : null}
          maxAmount={collection.max_amount_kobo ? naira(collection.max_amount_kobo) : null}
          tiers={tiers.map((tier) => ({
            id: tier.tier_id,
            name: tier.name,
            description: tier.description,
            price: naira(tier.price_kobo),
          }))}
          fields={fields.map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            options: field.options,
            required: field.required,
          }))}
          thankYouMessage={collection.thank_you_message}
          organiser={collection.community_name}
        />
      )}

      <footer className="border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-text-muted)]">
        Collected by {collection.community_name} through Kolekto. Kolekto never asks for your card PIN or your bank
        password.
      </footer>
    </main>
  );
}
