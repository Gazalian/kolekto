"use client";

import type { Collection } from "@kolekto/db";
import { Badge, EmptyState, TextField } from "@kolekto/ui";
import { Gift, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AMOUNT_MODEL_LABEL,
  describeAmount,
  formatDate,
  STATUS_LABEL,
  STATUS_TONE,
  type CollectionStatus,
} from "../../../../lib/collection-display.ts";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Open" },
  { key: "draft", label: "Drafts" },
  { key: "closed", label: "Closed" },
  { key: "archived", label: "Archived" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

/** The Button component renders a <button>; a navigation needs an anchor, so this carries the same visual weight without pretending to be one. */
function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-10 items-center justify-center gap-2 rounded-[var(--radius-md)] border border-transparent bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] transition-colors hover:bg-[var(--color-primary-strong)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
    >
      {children}
    </Link>
  );
}

function matchesFilter(collection: Collection, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return collection.status !== "archived";
    case "active":
      return collection.status === "active" || collection.status === "scheduled" || collection.status === "paused";
    case "draft":
      return collection.status === "draft";
    case "closed":
      return collection.status === "closed";
    case "archived":
      return collection.status === "archived";
  }
}

export function CollectionsClient({
  slug,
  collections,
  canCreate,
}: {
  slug: string;
  collections: Collection[];
  canCreate: boolean;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return collections.filter(
      (collection) => matchesFilter(collection, filter) && (!q || collection.name.toLowerCase().includes(q)),
    );
  }, [collections, filter, query]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Collections</h1>
        {canCreate && (
          <PrimaryLink href={`/c/${slug}/collections/new`}>
            <Plus className="h-4 w-4" aria-hidden="true" /> New collection
          </PrimaryLink>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setFilter(option.key)}
            aria-pressed={filter === option.key}
            className={
              filter === option.key
                ? "rounded-[var(--radius-chip,9999px)] bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary-fg)]"
                : "rounded-[var(--radius-chip,9999px)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      {collections.length > 0 && (
        <TextField
          label="Search"
          placeholder="Search collections by name"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={<Gift className="h-8 w-8" aria-hidden="true" />}
          title={collections.length === 0 ? "No collections yet" : "Nothing here"}
          description={
            collections.length === 0
              ? "Create your first collection to start collecting toward one purpose."
              : "No collection matches this filter."
          }
          {...(collections.length === 0 && canCreate
            ? { action: <PrimaryLink href={`/c/${slug}/collections/new`}>Create a collection</PrimaryLink> }
            : {})}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((collection) => (
            <li key={collection.id}>
              <Link
                href={`/c/${slug}/collections/${collection.slug}`}
                className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-border-strong)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-[var(--color-text)]">{collection.name}</span>
                  <Badge tone={STATUS_TONE[collection.status as CollectionStatus]}>
                    {STATUS_LABEL[collection.status as CollectionStatus]}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
                  <span>{AMOUNT_MODEL_LABEL[collection.amount_model]}</span>
                  {/* A configured amount, labelled as one. Nothing on this
                      screen says "collected" — no contribution exists yet. */}
                  <span>Contribution: {describeAmount(collection)}</span>
                  {collection.deadline_at && <span>Deadline: {formatDate(collection.deadline_at)}</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
