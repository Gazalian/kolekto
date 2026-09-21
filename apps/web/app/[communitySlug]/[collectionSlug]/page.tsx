import {
  getPublicCollection,
  getPublicCollectionFields,
  getPublicCollectionItems,
  getPublicCollectionTiers,
} from "@kolekto/db";
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

  const [tiers, items, fields] = await Promise.all([
    collection.amount_model === "tiers" ? getPublicCollectionTiers(collection.collection_id) : Promise.resolve([]),
    collection.amount_model === "items" ? getPublicCollectionItems(collection.collection_id) : Promise.resolve([]),
    getPublicCollectionFields(collection.collection_id),
  ]);

  /**
   * One sentence naming what this collection is, in the vocabulary of its own
   * type. Deliberately not a badge or a colour — a contributor reads words.
   * A ticketed event and a fundraiser are left out: both already lead with
   * something better than a sentence (the event block, the story block).
   */
  const leadLine = (() => {
    if (collection.category === "event" || collection.category === "fundraiser") return null;
    if (collection.schedule === "recurring") {
      return "A recurring charge. Each period is asked for separately — paying one does not settle the next.";
    }
    if (collection.amount_model === "items") {
      return items.length === 1
        ? "An order. Choose how many you want."
        : `An order. ${items.length} items to choose from, each with its own quantity.`;
    }
    if (collection.amount_model === "tiers") {
      return tiers.length === 1 ? "One package to choose." : `${tiers.length} packages — choose the one that suits you.`;
    }
    if (collection.amount_model === "open_amount") {
      return "Give what you can. You choose the amount.";
    }
    if (collection.amount_model === "fixed") {
      return "One set amount, the same for everyone.";
    }
    return null;
  })();

  const deadline = collection.deadline_at ? new Date(collection.deadline_at) : null;
  // When the event is, which is a different date from when the collection stops
  // selling tickets for it.
  const eventStart = collection.event_starts_at ? new Date(collection.event_starts_at) : null;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      {collection.cover_image_url && (
        // An uploaded image on the storage host, not a bundled asset.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={collection.cover_image_url}
          alt=""
          className="max-h-80 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] object-cover"
        />
      )}

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

        {/* WHO IS THIS FOR — answered before the contributor scrolls, because
            it decides whether they are about to be asked to find themselves. */}
        <p className="text-sm text-[var(--color-text-muted)]">
          {collection.audience_mode === "public"
            ? "Open to anyone with this link."
            : `For members of ${collection.community_name}. You will be asked to find yourself on the list.`}
        </p>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--color-text-muted)]">
          {collection.amount_model === "fixed" && collection.fixed_amount_kobo && (
            <span className="font-medium text-[var(--color-text)]">{naira(collection.fixed_amount_kobo)}</span>
          )}
          {deadline && <span>Closes {deadline.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</span>}
          {collection.target_amount_kobo && <span>Target: {naira(collection.target_amount_kobo)}</span>}
        </div>
      </header>

      {/* §10/§25: what kind of thing this is, in its own terms, before the
          contributor reads anything else. A ticketed event leads with its
          date and venue (the block below), a fundraiser with its story (the
          block after that); everything else says plainly what it is asking
          for, because "Alumni Dinner 2026" alone does not tell a contributor
          whether they are buying, ordering, joining or giving. */}
      {leadLine && (
        <p className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm font-medium text-[var(--color-text)]">
          {leadLine}
        </p>
      )}

      {/* §5/§19/§25: a fundraiser reads cause/story first, ahead of the event
          block (which is empty here — fundraisers have no event) and the
          generic description, which fundraisers do not set (StoryEditor
          replaces it in the creation flow). */}
      {collection.category === "fundraiser" && (collection.story_what || collection.story_why || collection.story_impact) && (
        <div className="flex flex-col gap-4">
          {collection.story_what && (
            <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--color-text)]">{collection.story_what}</p>
          )}
          {collection.story_why && (
            <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--color-text-muted)]">
              {collection.story_why}
            </p>
          )}
          {collection.story_impact && (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                What your gift funds
              </p>
              <p className="whitespace-pre-line text-sm text-[var(--color-text)]">{collection.story_impact}</p>
            </div>
          )}
        </div>
      )}

      {(eventStart || collection.venue) && (
        <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm">
          {eventStart && (
            <p className="font-medium text-[var(--color-text)]">
              {eventStart.toLocaleString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
          )}
          {collection.venue && <p className="text-[var(--color-text-muted)]">{collection.venue}</p>}
        </div>
      )}

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
          audienceMode={collection.audience_mode}
          amountModel={collection.amount_model}
          allowMultipleTiers={collection.category === "event"}
          collectAttendeeDetails={collection.collect_attendee_details}
          fixedAmount={collection.fixed_amount_kobo ? naira(collection.fixed_amount_kobo) : null}
          minAmount={collection.min_amount_kobo ? naira(collection.min_amount_kobo) : null}
          maxAmount={collection.max_amount_kobo ? naira(collection.max_amount_kobo) : null}
          suggestedAmounts={collection.suggested_amounts_kobo.map((amount) => naira(amount))}
          tiers={tiers.map((tier) => ({
            id: tier.tier_id,
            name: tier.name,
            description: tier.description,
            price: naira(tier.price_kobo),
            quantityLimit: tier.quantity_limit,
            perOrderLimit: tier.per_order_limit,
          }))}
          items={items.map((item) => ({
            id: item.item_id,
            name: item.name,
            description: item.description,
            price: naira(item.price_kobo),
            quantityAvailable: item.quantity_available,
            maxPerOrder: item.max_per_order,
            imageUrl: item.image_url,
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
