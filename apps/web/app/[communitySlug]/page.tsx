import { getPublicCommunity, listPublicCommunityCollections, type PublicCommunityCollection } from "@kolekto/db";
import { BadgeCheck, CalendarDays, Mail, MapPin, Phone, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { describeAmount, formatDate } from "../../lib/collection-display.ts";
import { communityTypeLabel, initials } from "../../lib/community-display.ts";

/**
 * The public community page (D-J), at /[communitySlug] beside the existing
 * collection pages at /[communitySlug]/[collectionSlug].
 *
 * Anonymous, like the collection page: no session, no table read. Everything
 * shown comes from app.get_public_community / _collections (20261122140000),
 * which return whitelisted fields of a PUBLISHED community and only the
 * collections its officers chose to list. Unpublished, personal, suspended or
 * unknown communities are all the same 404. No member, officer, verification
 * evidence, bank detail or money figure is ever on this page.
 */

type Params = { params: Promise<{ communitySlug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { communitySlug } = await params;
  const community = await getPublicCommunity(communitySlug);
  if (!community) return { title: "Not found" };
  const description = community.description ?? `${community.name} collects contributions on Kolekto.`;
  return {
    title: community.name,
    description,
    openGraph: {
      title: community.name,
      description,
      type: "website",
      ...(isHttpsImage(community.logo_url) ? { images: [{ url: community.logo_url }] } : {}),
    },
  };
}

function isHttpsImage(url: string | null): url is string {
  return typeof url === "string" && url.startsWith("https://");
}

export default async function PublicCommunityPage({ params }: Params) {
  const { communitySlug } = await params;
  const community = await getPublicCommunity(communitySlug);
  if (!community) notFound();
  const collections = await listPublicCommunityCollections(communitySlug);

  const verified = community.verification_status === "verified";
  const location = [community.location_city, community.location_state].filter(Boolean).join(", ");
  const open = collections.filter((c) => c.status !== "closed");
  const ended = collections.filter((c) => c.status === "closed");

  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="h-24 bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-primary-strong)] sm:h-32" aria-hidden="true" />
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 pb-6 sm:px-6">
          <div className="-mt-10 flex items-end gap-4 sm:-mt-12">
            {isHttpsImage(community.logo_url) ? (
              // A community-supplied logo on an external host.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={community.logo_url}
                alt={`${community.name} logo`}
                referrerPolicy="no-referrer"
                className="h-20 w-20 shrink-0 rounded-[var(--radius-lg)] border-4 border-[var(--color-surface)] bg-[var(--color-surface)] object-cover sm:h-24 sm:w-24"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-20 w-20 shrink-0 items-center justify-center rounded-[var(--radius-lg)] border-4 border-[var(--color-surface)] bg-[var(--color-primary)] text-2xl font-semibold text-[var(--color-primary-fg)] sm:h-24 sm:w-24"
              >
                {initials(community.name)}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-text)] sm:text-3xl">{community.name}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-[var(--color-text-muted)]">
              <span>{communityTypeLabel(community.type)}</span>
              {community.institution && <span>· {community.institution}</span>}
              {location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  {location}
                </span>
              )}
              {verified ? (
                <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-success-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-success)]">
                  <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  Verified by Kolekto
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-warning-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-warning)]">
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  Not yet verified
                </span>
              )}
            </div>
            {community.description && (
              <p className="max-w-2xl whitespace-pre-line text-sm leading-relaxed text-[var(--color-text)]">{community.description}</p>
            )}
            {(community.contact_email || community.contact_phone_e164) && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {community.contact_email && (
                  <a href={`mailto:${community.contact_email}`} className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline">
                    <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                    {community.contact_email}
                  </a>
                )}
                {community.contact_phone_e164 && (
                  <a href={`tel:${community.contact_phone_e164}`} className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline">
                    <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                    {community.contact_phone_e164}
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6">
        {!verified && (
          <p className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-muted)]">
            Kolekto has not yet verified who runs this community. Payments go to the collection you choose and are recorded
            against it, but check that you know the organisers before you pay.
          </p>
        )}

        <section aria-labelledby="open-heading" className="flex flex-col gap-3">
          <h2 id="open-heading" className="text-base font-semibold text-[var(--color-text)]">
            Collections
          </h2>
          {open.length === 0 ? (
            <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
              {community.name} has no public collections open right now.
            </p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {open.map((collection) => (
                <CollectionCard key={collection.slug} communitySlug={community.slug} collection={collection} />
              ))}
            </ul>
          )}
        </section>

        {ended.length > 0 && (
          <section aria-labelledby="ended-heading" className="flex flex-col gap-3">
            <h2 id="ended-heading" className="text-sm font-semibold text-[var(--color-text-muted)]">
              Ended
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {ended.map((collection) => (
                <CollectionCard key={collection.slug} communitySlug={community.slug} collection={collection} />
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-muted)]">
        Powered by{" "}
        <Link href="/" className="font-semibold text-[var(--color-primary)] hover:underline">
          Kolekto
        </Link>
      </footer>
    </div>
  );
}

function CollectionCard({ communitySlug, collection }: { communitySlug: string; collection: PublicCommunityCollection }) {
  const state =
    collection.status === "active" ? null : collection.status === "paused" ? "Paused" : "Ended";
  const when = collection.event_starts_at ?? collection.deadline_at;
  return (
    <li>
      <Link
        href={`/${communitySlug}/${collection.slug}`}
        className="flex h-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-border-strong)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
      >
        {collection.cover_image_url ? (
          // A flyer from this deployment's collection-covers bucket.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={collection.cover_image_url} alt="" className="h-36 w-full object-cover" />
        ) : (
          <div className="h-2 bg-[var(--color-primary)]" aria-hidden="true" />
        )}
        <div className="flex flex-1 flex-col gap-1.5 p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold text-[var(--color-text)]">{collection.name}</h3>
            {state && (
              <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-1.5 py-0.5 text-xs text-[var(--color-text-muted)]">
                {state}
              </span>
            )}
          </div>
          {collection.description && (
            <p className="line-clamp-2 text-sm text-[var(--color-text-muted)]">{collection.description}</p>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-sm">
            <span className="font-medium text-[var(--color-text)]">
              {describeAmount({ ...collection, max_amount_kobo: null })}
            </span>
            {when && (
              <span className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                {collection.event_starts_at ? formatDate(when) : `Until ${formatDate(when)}`}
              </span>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}
