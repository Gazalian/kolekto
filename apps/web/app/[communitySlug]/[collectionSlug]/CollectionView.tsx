import { naira } from "../../../lib/collection-display.ts";
import { ContributeForm } from "./ContributeForm.tsx";

/**
 * The published collection, as a contributor reads it.
 *
 * Extracted from the public page so the organiser's preview can render the
 * same thing rather than a summary that drifts away from it (M7.5 part B).
 * There is one of these, and both callers use it:
 *
 *   /[communitySlug]/[collectionSlug]   the real page, `mode = "live"`
 *   /c/[slug]/collections/…/preview     the organiser's view, `mode = "preview"`
 *
 * The only difference between the two is the contribution form. In preview it
 * is not rendered, and a plain note stands in its place: a preview that could
 * submit would be a contribution the organiser made to their own collection,
 * and in a later phase a payment attempt. Everything above the form — the
 * cover, the framing sentence, the story, the event block, the description —
 * is the same component tree in both.
 */

export type CollectionViewMode = "live" | "preview";

export interface CollectionViewData {
  collection_id: string;
  collection_name: string;
  description: string | null;
  cover_image_url: string | null;
  category: string;
  audience_mode: "all_members" | "groups" | "selected_members" | "public";
  amount_model: "fixed" | "open_amount" | "tiers" | "per_member" | "items";
  schedule: "one_time" | "recurring";
  fixed_amount_kobo: string | null;
  min_amount_kobo: string | null;
  max_amount_kobo: string | null;
  target_amount_kobo: string | null;
  suggested_amounts_kobo: string[];
  deadline_at: Date | string | null;
  event_starts_at: Date | string | null;
  venue: string | null;
  collect_attendee_details: boolean;
  story_what: string | null;
  story_why: string | null;
  story_impact: string | null;
  status: "active" | "paused" | "closed";
  thank_you_message: string | null;
  community_name: string;
  community_verified: string;
  /** How often this repeats, on a recurring collection. Null everywhere else. */
  recurrence_frequency?: "weekly" | "monthly" | "quarterly" | "yearly" | null;
  recurrence_interval?: number | null;
  recurrence_due_after_days?: number | null;
}

export interface CollectionViewTier {
  id: string;
  name: string;
  description: string | null;
  price_kobo: string;
  quantity_limit: number | null;
  per_order_limit: number | null;
}

export interface CollectionViewItem {
  id: string;
  name: string;
  description: string | null;
  price_kobo: string;
  quantity_available: number | null;
  max_per_order: number | null;
  image_url: string | null;
}

export interface CollectionViewField {
  key: string;
  label: string;
  type: "text" | "number" | "single_select" | "date";
  options: string[] | null;
  required: boolean;
}

/**
 * "every month", "every 2 weeks". Written out rather than shown as
 * "monthly × 2", which is a database row read aloud.
 */
function everyHowOften(collection: CollectionViewData): string {
  const interval = collection.recurrence_interval ?? 1;
  const unit = { weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" }[
    collection.recurrence_frequency ?? "monthly"
  ];
  return interval > 1 ? `every ${interval} ${unit}s` : `every ${unit}`;
}

export function CollectionView({
  mode,
  communitySlug,
  collectionSlug,
  collection,
  tiers,
  items,
  fields,
}: {
  mode: CollectionViewMode;
  communitySlug: string;
  collectionSlug: string;
  collection: CollectionViewData;
  tiers: CollectionViewTier[];
  items: CollectionViewItem[];
  fields: CollectionViewField[];
}) {
  const deadline = collection.deadline_at ? new Date(collection.deadline_at) : null;
  // When the event is, which is a different date from when the collection stops
  // selling tickets for it.
  const eventStart = collection.event_starts_at ? new Date(collection.event_starts_at) : null;

  /**
   * One sentence naming what this collection is, in the vocabulary of its own
   * type. Deliberately not a badge or a colour — a contributor reads words.
   * A ticketed event and a fundraiser are left out: both already lead with
   * something better than a sentence (the event block, the story block).
   */
  const leadLine = (() => {
    if (collection.category === "event" || collection.category === "fundraiser") return null;
    if (collection.schedule === "recurring") {
      return `A recurring charge, ${everyHowOften(collection)}. Each period is asked for separately — paying one does not settle the next.`;
    }
    if (collection.amount_model === "items") {
      return items.length === 1
        ? "An order. Choose how many you want."
        : `An order. ${items.length} items to choose from, each with its own quantity.`;
    }
    if (collection.amount_model === "tiers") {
      return tiers.length === 1 ? "One package to choose." : `${tiers.length} packages — choose the one that suits you.`;
    }
    if (collection.amount_model === "open_amount") return "Give what you can. You choose the amount.";
    if (collection.amount_model === "fixed") return "One set amount, the same for everyone.";
    return null;
  })();

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
          {deadline && (
            <span>
              Closes {deadline.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
            </span>
          )}
          {collection.target_amount_kobo && <span>Target: {naira(collection.target_amount_kobo)}</span>}
        </div>
      </header>

      {/* §10/§25: what kind of thing this is, in its own terms, before the
          contributor reads anything else. */}
      {leadLine && (
        <p className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm font-medium text-[var(--color-text)]">
          {leadLine}
        </p>
      )}

      {/* §5/§19/§25: a fundraiser reads cause/story first. */}
      {collection.category === "fundraiser" &&
        (collection.story_what || collection.story_why || collection.story_impact) && (
          <div className="flex flex-col gap-4">
            {collection.story_what && (
              <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--color-text)]">
                {collection.story_what}
              </p>
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

      {/* §V: a recurring collection has to answer "how often, how much, and
          by when" before anybody agrees to it. "This repeats" does not. */}
      {collection.schedule === "recurring" && (
        <dl className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--color-text-muted)]">How often</dt>
            <dd className="font-medium text-[var(--color-text)]">{everyHowOften(collection)}</dd>
          </div>
          {collection.fixed_amount_kobo && (
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Each period</dt>
              <dd className="font-medium text-[var(--color-text)]">{naira(collection.fixed_amount_kobo)}</dd>
            </div>
          )}
          {typeof collection.recurrence_due_after_days === "number" && (
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Due</dt>
              <dd className="font-medium text-[var(--color-text)]">
                {collection.recurrence_due_after_days === 0
                  ? "When the period opens"
                  : `${collection.recurrence_due_after_days} days after the period opens`}
              </dd>
            </div>
          )}
        </dl>
      )}

      {/* §V: a fundraiser leads with what it is working toward. What has been
          raised is deliberately not here — nothing is recorded yet, and a
          progress bar at zero is a claim about how the appeal is going. */}
      {collection.category === "fundraiser" && collection.target_amount_kobo && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">Working toward</p>
          <p className="text-2xl font-semibold text-[var(--color-text)]">{naira(collection.target_amount_kobo)}</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {collection.community_name} will show what has been raised once online giving is switched on.
          </p>
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

      {mode === "live" && collection.status === "active" && (
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
            id: tier.id,
            name: tier.name,
            description: tier.description,
            price: naira(tier.price_kobo),
            quantityLimit: tier.quantity_limit,
            perOrderLimit: tier.per_order_limit,
          }))}
          items={items.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            price: naira(item.price_kobo),
            quantityAvailable: item.quantity_available,
            maxPerOrder: item.max_per_order,
            imageUrl: item.image_url,
          }))}
          fields={fields}
          thankYouMessage={collection.thank_you_message}
          organiser={collection.community_name}
        />
      )}

      {/* The preview shows what the contributor will be asked for without
          being able to ask it. Submitting here would be the organiser
          contributing to their own collection — and, once payments exist, a
          payment attempt against it. */}
      {mode === "preview" && (
        <PreviewContributionSummary
          amountModel={collection.amount_model}
          audienceMode={collection.audience_mode}
          collectAttendeeDetails={collection.collect_attendee_details}
          isEvent={collection.category === "event"}
          tiers={tiers}
          items={items}
          fields={fields}
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

/**
 * What the contribution step will ask for, listed rather than rendered as a
 * working form. Reads from the same configuration the live form reads, so a
 * tier added in the wizard shows up here and an item's stock reads the same.
 */
function PreviewContributionSummary({
  amountModel,
  audienceMode,
  collectAttendeeDetails,
  isEvent,
  tiers,
  items,
  fields,
  organiser,
}: {
  amountModel: CollectionViewData["amount_model"];
  audienceMode: CollectionViewData["audience_mode"];
  collectAttendeeDetails: boolean;
  isEvent: boolean;
  tiers: CollectionViewTier[];
  items: CollectionViewItem[];
  fields: CollectionViewField[];
  organiser: string;
}) {
  const choices =
    amountModel === "tiers"
      ? tiers.map((tier) => ({
          id: tier.id,
          name: tier.name,
          description: tier.description,
          price: naira(tier.price_kobo),
          left: tier.quantity_limit,
          image: null as string | null,
        }))
      : amountModel === "items"
        ? items.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            price: naira(item.price_kobo),
            left: item.quantity_available,
            image: item.image_url,
          }))
        : [];

  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] p-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">
          {isEvent ? "Which tickets?" : amountModel === "items" ? "What are you ordering?" : "What contributors choose"}
        </h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          This is the preview, so nothing here can be submitted. On the published page this is where a contributor
          chooses and continues.
        </p>
      </div>

      {audienceMode !== "public" && (
        <p className="text-sm text-[var(--color-text-muted)]">
          Contributors are asked to find themselves on {organiser}&apos;s list before anything else.
        </p>
      )}

      {choices.length > 0 && (
        <ul className="flex flex-col gap-2">
          {choices.map((choice) => (
            <li
              key={choice.id}
              className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
            >
              {choice.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={choice.image}
                  alt=""
                  className="h-14 w-14 flex-shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] object-cover"
                />
              )}
              <span className="flex flex-1 flex-col">
                <span className="flex items-center justify-between gap-3">
                  <span className="font-medium text-[var(--color-text)]">{choice.name}</span>
                  <span className="text-sm font-medium text-[var(--color-text)]">{choice.price}</span>
                </span>
                {choice.description && (
                  <span className="text-sm text-[var(--color-text-muted)]">{choice.description}</span>
                )}
                {choice.left !== null && (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {choice.left === 0 ? "Sold out" : `${choice.left} left`}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {amountModel === "open_amount" && (
        <p className="text-sm text-[var(--color-text-muted)]">Contributors type their own amount.</p>
      )}
      {amountModel === "fixed" && (
        <p className="text-sm text-[var(--color-text-muted)]">Everyone is asked for the amount shown above.</p>
      )}
      {amountModel === "per_member" && (
        <p className="text-sm text-[var(--color-text-muted)]">
          Each member is asked for the amount recorded against their own name.
        </p>
      )}

      {isEvent && collectAttendeeDetails && (
        <p className="text-sm text-[var(--color-text-muted)]">One attendee name is asked for per ticket bought.</p>
      )}

      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">Contributors are asked for</p>
        <ul className="mt-1 list-inside list-disc text-sm text-[var(--color-text-muted)]">
          <li>Their name, and an email address or phone number</li>
          {fields.map((field) => (
            <li key={field.key}>
              {field.label}
              {field.required ? " (required)" : ""}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
