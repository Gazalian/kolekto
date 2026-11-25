"use client";

import { Banner, Button } from "@kolekto/ui";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { setCommunityPublicPageAction } from "./actions.ts";

/**
 * Owner-only switch for the public community page at /[slug] (D-J). The page
 * shows the community's name, type, location, description, verification
 * status and only the collections set to "Listed publicly". Whether the caller
 * is the owner decides only that this is rendered; the database refuses
 * anyone else.
 */
export function PublicPageControl({
  slug,
  communityId,
  published,
  contactVisible,
  verified,
}: {
  slug: string;
  communityId: string;
  published: boolean;
  contactVisible: boolean;
  verified: boolean;
}) {
  const [isPublished, setPublished] = useState(published);
  const [showContact, setShowContact] = useState(contactVisible);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function save(nextPublished: boolean, nextContact: boolean) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await setCommunityPublicPageAction(slug, communityId, nextPublished, nextContact);
      if (result.error) {
        setError(result.error);
        return;
      }
      setPublished(nextPublished);
      setShowContact(nextContact);
      setSaved(true);
    });
  }

  return (
    <section
      aria-labelledby="public-page-heading"
      className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="public-page-heading" className="text-base font-semibold text-[var(--color-text)]">
            Public page
          </h2>
          <p className="mt-1 max-w-xl text-sm text-[var(--color-text-muted)]">
            A page anyone can open at <span className="font-mono text-[var(--color-text)]">/{slug}</span>, showing this
            community and the collections you set to <strong>Listed publicly</strong>. Link-only collections stay off
            it. Members, officers, bank details and balances are never shown.
          </p>
        </div>
        {isPublished && (
          <Link
            href={`/${slug}`}
            target="_blank"
            className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-primary)] hover:underline"
          >
            View page <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>

      {!verified && (
        <p className="text-xs text-[var(--color-text-muted)]">
          This community is not verified yet, so the page will say &quot;Not yet verified&quot;. Publishing does not change
          any limit or permission.
        </p>
      )}

      <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
        <input
          type="checkbox"
          checked={showContact}
          disabled={isPending}
          onChange={(event) => save(isPublished, event.target.checked)}
        />
        Show the community&apos;s contact email and phone on the page
      </label>

      {error && <Banner tone="danger">{error}</Banner>}
      {saved && !error && <p className="text-xs text-[var(--color-success)]">Saved.</p>}

      <div>
        <Button
          type="button"
          variant={isPublished ? "secondary" : "primary"}
          size="sm"
          disabled={isPending}
          onClick={() => save(!isPublished, showContact)}
        >
          {isPublished ? "Unpublish page" : "Publish page"}
        </Button>
      </div>
    </section>
  );
}
