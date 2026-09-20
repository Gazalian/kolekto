/**
 * collection-display.ts — how a collection reads on screen.
 *
 * Presentation only, and client-safe (no `server-only`, no database import).
 * Two rules it exists to keep:
 *
 *   1. Money is formatted through `@kolekto/domain`, never with `toFixed` or
 *      `toLocaleString` on a float (ADR 0003).
 *   2. A configured amount is labelled as a configured amount. Nothing here
 *      produces a "raised", "collected" or "paid" figure, because no such
 *      figure exists until contributions do (ADR 0006).
 */

import type { BadgeTone } from "@kolekto/ui";
import { formatNaira, kobo } from "@kolekto/domain";

export type CollectionStatus =
  | "draft"
  | "scheduled"
  | "active"
  | "paused"
  | "closed"
  | "suspended"
  | "archived";

export type ObligationStatus = "unpaid" | "in_installments" | "overdue" | "paid" | "exempt" | "cancelled";

export const STATUS_TONE: Record<CollectionStatus, BadgeTone> = {
  draft: "neutral",
  scheduled: "info",
  active: "success",
  paused: "warning",
  closed: "neutral",
  suspended: "danger",
  archived: "neutral",
};

export const STATUS_LABEL: Record<CollectionStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  active: "Open",
  paused: "Paused",
  closed: "Closed",
  suspended: "Suspended",
  archived: "Archived",
};

export const OBLIGATION_TONE: Record<ObligationStatus, BadgeTone> = {
  unpaid: "neutral",
  in_installments: "info",
  overdue: "danger",
  paid: "success",
  exempt: "warning",
  cancelled: "neutral",
};

export const OBLIGATION_LABEL: Record<ObligationStatus, string> = {
  unpaid: "Not yet paid",
  in_installments: "Paying in installments",
  overdue: "Overdue",
  paid: "Paid",
  exempt: "Exempt",
  cancelled: "Cancelled",
};

export const AMOUNT_MODEL_LABEL: Record<string, string> = {
  fixed: "Everyone pays the same",
  open_amount: "Contributors choose the amount",
  tiers: "Options to choose from",
  per_member: "A different amount per member",
  items: "Items with their own prices",
};

export const PARTICIPATION_LABEL: Record<string, string> = {
  open: "Anyone with the link",
  managed: "A named list of members",
};

export const CATEGORY_LABEL: Record<string, string> = {
  dues: "Dues",
  contribution: "Contribution",
  event: "Event",
  fundraiser: "Fundraiser",
  items: "Items",
  other: "Other",
};

/** Formats a kobo value from any of the shapes it arrives in: a PostgREST JSON number, a `postgres` int8 string, or a bigint. */
export function naira(value: number | string | bigint | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return formatNaira(kobo(typeof value === "number" ? BigInt(value) : value), { decimals: false });
}

/** A one-line answer to "what does this collection ask for?", from its configuration alone. */
export function describeAmount(collection: {
  amount_model: string;
  fixed_amount_kobo: number | string | null;
  min_amount_kobo: number | string | null;
  max_amount_kobo: number | string | null;
}): string {
  switch (collection.amount_model) {
    case "fixed":
      return naira(collection.fixed_amount_kobo);
    case "open_amount": {
      if (collection.min_amount_kobo && collection.max_amount_kobo) {
        return `${naira(collection.min_amount_kobo)} – ${naira(collection.max_amount_kobo)}`;
      }
      if (collection.min_amount_kobo) return `From ${naira(collection.min_amount_kobo)}`;
      if (collection.max_amount_kobo) return `Up to ${naira(collection.max_amount_kobo)}`;
      return "Any amount";
    }
    case "tiers":
      return "Options to choose from";
    case "items":
      return "Priced per item";
    case "per_member":
      return "Set per member";
    default:
      return "—";
  }
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The public address of a collection: /{community-slug}/{collection-slug}. One shape, everywhere (section 20/21 of the Phase 3 brief). */
export function collectionPath(communitySlug: string, collectionSlug: string): string {
  return `/${communitySlug}/${collectionSlug}`;
}
