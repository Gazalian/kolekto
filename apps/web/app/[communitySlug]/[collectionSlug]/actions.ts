"use server";

import {
  findCollectionMember,
  getCollectionMemberContext,
  getPublicCollection,
  getPublicCollectionFields,
  getPublicCollectionItems,
  getPublicCollectionTiers,
  type CollectionMemberContext,
} from "@kolekto/db";
import {
  ContributionError,
  formatNaira,
  fromNaira,
  kobo,
  resolveContributionAmount,
  type ContributionItem,
  type ContributionObligation,
  type ContributionTier,
} from "@kolekto/domain";
import { buildContributorAnswersSchema, contributorContactSchema } from "@kolekto/validation";
import {
  clearContributorSession,
  readContributorSession,
  setContributorSession,
} from "../../../lib/contributor-session.ts";
import { allowLookup } from "../../../lib/lookup-throttle.ts";

/**
 * What happens when a contributor submits the form.
 *
 * Every figure is re-derived here from the database. The browser's copy of the
 * collection is a convenience for rendering and is treated as hostile input:
 * the tier is resolved by ID against the collection's own rows, the amount for
 * a fixed collection comes from the collection, and an answer to a question the
 * collection does not ask is dropped. SEC-18, applied to an anonymous caller.
 *
 * Nothing is stored. There is no contributions table, no payment attempt and no
 * Paystack call in this phase (ADR 0006 gates all three on decisions outside
 * it), so this returns a checked summary and says plainly that payment is not
 * open yet. It does not say "payment received", it does not issue a receipt,
 * and it does not record a pending contribution that a later phase would have
 * to reconcile against money that never arrived.
 */

export interface ContributionResult {
  ok?: boolean;
  error?: string;
  /** Present on success: what the server resolved, for the confirmation screen. */
  summary?: {
    amount: string;
    tierName: string | null;
    /** More than one option, each with its own quantity — "VIP × 2, Regular × 1" — when the order resolved to several lines rather than one. */
    tierLines: { name: string; quantity: number; amount: string }[] | null;
    /** One name per ticket unit, when the event asked for them (§18). Never persisted — shown on this confirmation and nowhere else. */
    attendees: string[] | null;
    /** What was ordered, and how many, when the collection sells items and the order is a single line. */
    itemName: string | null;
    quantity: number | null;
    /** Every line of a multi-item order, with its own quantity and subtotal. */
    itemLines: { name: string; quantity: number; amount: string }[] | null;
    contributorName: string;
    /** On a managed collection: the member this contribution is for, as the server resolved them. */
    memberName: string | null;
    memberCode: string | null;
    cycleLabel: string | null;
  };
}

// ── Member self-identification (§3–§5) ──────────────────────────────────────
//
// A managed collection asks named people for money, so the page has to work out
// which of them is at the keyboard before it can say what is expected.
//
// The identity that results is kept in an httpOnly signed cookie, not in the
// page: a member id in a form field is a member id a browser can change, and
// changing it means becoming somebody else on the roll. What the browser gets
// back is only what that person may see about themselves.

/** What a lookup tells the contributor. Deliberately carries no id — the identification lives in the cookie. */
export interface MemberLookupResult {
  status: "none" | "one" | "many" | "error";
  error?: string;
  /** For `one`: the person we think they are, so they can say whether that is right. */
  candidate?: {
    fullName: string;
    memberCode: string | null;
    identifierLabel: string | null;
    identifierValue: string | null;
  };
  /** For `many`: how many people answered, and what to type to tell them apart. */
  matchCount?: number;
  identifierLabel?: string | null;
}

/** The identified member and what they are being asked for. Rebuilt from the database on every call. */
export interface MemberContextResult {
  error?: string;
  member?: {
    fullName: string;
    memberCode: string | null;
    identifierLabel: string | null;
    identifierValue: string | null;
    /** The period, on a recurring collection: "1 Oct 2026 – 31 Oct 2026". */
    cycleLabel: string | null;
    cycleKey: string | null;
    /** What is expected of them, formatted. Null when they have no obligation on this collection. */
    expectedAmount: string | null;
    waivedAmount: string | null;
    /** `unpaid`, `exempt`… never invented. Only a verified payment will ever make this `paid`. */
    obligationStatus: string | null;
    dueAt: string | null;
  };
}

/** Resolves the collection the same way the page does, so a slug pair is never trusted as an id. */
async function loadCollection(communitySlug: string, collectionSlug: string) {
  return getPublicCollection(communitySlug, collectionSlug);
}

export async function findMemberAction(
  communitySlug: string,
  collectionSlug: string,
  query: string,
): Promise<MemberLookupResult> {
  const collection = await loadCollection(communitySlug, collectionSlug);
  if (!collection) return { status: "error", error: "This collection is no longer available." };
  if (collection.audience_mode === "public") {
    return { status: "error", error: "This collection is open to anyone — there is nobody to find." };
  }

  if (!(await allowLookup(collection.collection_id))) {
    return { status: "error", error: "Too many searches. Wait a minute and try again." };
  }

  let match;
  try {
    match = await findCollectionMember(collection.collection_id, query);
  } catch (error) {
    // QUERY_TOO_SHORT and QUERY_TOO_LONG are the database refusing to answer;
    // both are things the person can act on, so the wording is passed through.
    const message = error instanceof Error ? error.message : "";
    if (message.includes("QUERY_TOO_SHORT")) return { status: "error", error: "Type at least 3 characters." };
    if (message.includes("QUERY_TOO_LONG")) return { status: "error", error: "That is too long." };
    return { status: "error", error: "That search could not be completed. Try again." };
  }

  if (match.match_status === "one" && match.member_id) {
    // Remembered server-side immediately, so the id never has to travel to the
    // page and back. Nothing is shown about them beyond what is below, and the
    // contributor still has to say "yes, this is me" before anything about what
    // they owe appears.
    await setContributorSession(collection.collection_id, match.member_id);
    return {
      status: "one",
      candidate: {
        fullName: match.full_name ?? "",
        memberCode: match.member_code,
        identifierLabel: match.identifier_label,
        identifierValue: match.identifier_value,
      },
    };
  }

  if (match.match_status === "many") {
    // No names, no ids: a count, and the name of the field that tells them
    // apart. Listing candidates here would be showing a stranger the roll.
    await clearContributorSession();
    return { status: "many", matchCount: match.match_count, identifierLabel: match.identifier_label };
  }

  await clearContributorSession();
  return { status: "none", identifierLabel: match.identifier_label };
}

/**
 * The confirmed member's own context.
 *
 * Called after "yes, this is me". Eligibility is re-checked in the database, so
 * an identification does not survive the member being archived, the collection
 * closing, or the audience changing underneath it.
 */
export async function confirmMemberAction(
  communitySlug: string,
  collectionSlug: string,
): Promise<MemberContextResult> {
  const collection = await loadCollection(communitySlug, collectionSlug);
  if (!collection) return { error: "This collection is no longer available." };

  const memberId = await readContributorSession(collection.collection_id);
  if (!memberId) return { error: "Find yourself again — that identification has expired." };

  const context = await getCollectionMemberContext(collection.collection_id, memberId);
  if (!context) {
    await clearContributorSession();
    return { error: "That record can no longer contribute to this collection." };
  }

  return { member: describeMember(context) };
}

export async function forgetMemberAction(): Promise<void> {
  await clearContributorSession();
}

function describeMember(context: CollectionMemberContext): NonNullable<MemberContextResult["member"]> {
  return {
    fullName: context.full_name,
    memberCode: context.member_code,
    identifierLabel: context.identifier_label,
    identifierValue: context.identifier_value,
    cycleLabel: context.cycle_label,
    cycleKey: context.cycle_key,
    expectedAmount:
      context.expected_amount_kobo === null ? null : formatNaira(kobo(context.expected_amount_kobo), { decimals: false }),
    waivedAmount:
      context.waived_amount_kobo === null || context.waived_amount_kobo === "0"
        ? null
        : formatNaira(kobo(context.waived_amount_kobo), { decimals: false }),
    obligationStatus: context.obligation_status,
    dueAt: context.due_at === null ? null : new Date(context.due_at).toISOString(),
  };
}

/** The obligation as the domain reads it: ids and integer kobo, loaded from the database, never from the page. */
function toContributionObligation(context: CollectionMemberContext): ContributionObligation | undefined {
  if (!context.obligation_id || context.expected_amount_kobo === null) return undefined;
  return {
    id: context.obligation_id,
    expectedAmountKobo: kobo(context.expected_amount_kobo),
    waivedAmountKobo: kobo(context.waived_amount_kobo ?? "0"),
    status: context.obligation_status ?? "unpaid",
  };
}

export async function submitContributionAction(
  communitySlug: string,
  collectionSlug: string,
  input: {
    fullName: string;
    email: string;
    phone: string;
    tierId: string;
    /** Several options with quantities — a ticketed event's "VIP × 2, Regular × 1". Takes priority over `tierId` when present. */
    tierSelections?: { tierId: string; quantity: string }[];
    /** One name per ticket unit, only asked for when the event's `collect_attendee_details` is on. */
    attendeeNames?: string[];
    amount: string;
    itemId?: string;
    quantity?: string;
    /** Several items with quantities — a catalog order with more than one line. Takes priority over `itemId`. */
    itemSelections?: { itemId: string; quantity: string }[];
    answers: Record<string, string>;
  },
): Promise<ContributionResult> {
  const collection = await getPublicCollection(communitySlug, collectionSlug);
  if (!collection) return { error: "This collection is no longer available." };
  if (collection.status !== "active") {
    return {
      error:
        collection.status === "paused"
          ? "This collection is paused and is not accepting contributions right now."
          : "This collection is closed and is no longer accepting contributions.",
    };
  }

  // A managed collection asks named people. The member is resolved from the
  // signed cookie and re-checked against the database — the page never says who
  // it is, and could not be believed if it did.
  let memberContext: CollectionMemberContext | null = null;
  if (collection.audience_mode !== "public") {
    const memberId = await readContributorSession(collection.collection_id);
    if (!memberId) {
      return { error: "Find yourself on the list before continuing." };
    }
    memberContext = await getCollectionMemberContext(collection.collection_id, memberId);
    if (!memberContext) {
      await clearContributorSession();
      return { error: "That record can no longer contribute to this collection." };
    }
  }

  const contact = contributorContactSchema.safeParse({
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
  });
  if (!contact.success) return { error: contact.error.issues[0]?.message ?? "Check your details and try again" };

  const fields = await getPublicCollectionFields(collection.collection_id);
  const answers = buildContributorAnswersSchema(
    fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      options: field.options,
      required: field.required,
    })),
  ).safeParse(input.answers);
  if (!answers.success) return { error: answers.error.issues[0]?.message ?? "Check your answers and try again" };

  const tiers: ContributionTier[] =
    collection.amount_model === "tiers"
      ? (await getPublicCollectionTiers(collection.collection_id)).map((tier) => ({
          id: tier.tier_id,
          name: tier.name,
          priceKobo: kobo(tier.price_kobo),
          quantityLimit: tier.quantity_limit,
          perOrderLimit: tier.per_order_limit,
        }))
      : [];

  // Same treatment as tiers: the price, the stock and the per-order limit are
  // the database's, not the browser's. The page sends an id and a count.
  const items: ContributionItem[] =
    collection.amount_model === "items"
      ? (await getPublicCollectionItems(collection.collection_id)).map((item) => ({
          id: item.item_id,
          name: item.name,
          priceKobo: kobo(item.price_kobo),
          quantityAvailable: item.quantity_available,
          maxPerOrder: item.max_per_order,
        }))
      : [];

  let resolved;
  try {
    resolved = resolveContributionAmount(
      {
        amountModel: collection.amount_model,
        fixedAmountKobo: collection.fixed_amount_kobo === null ? null : kobo(collection.fixed_amount_kobo),
        minAmountKobo: collection.min_amount_kobo === null ? null : kobo(collection.min_amount_kobo),
        maxAmountKobo: collection.max_amount_kobo === null ? null : kobo(collection.max_amount_kobo),
        tiers,
        items,
        // Their own row, when they have one: an officer may have waived part of
        // what THIS member owes, and the headline amount would ignore that.
        ...(memberContext ? { obligation: toContributionObligation(memberContext) } : {}),
      },
      {
        ...(input.tierId ? { tierId: input.tierId } : {}),
        ...(input.tierSelections && input.tierSelections.length > 0
          ? {
              tierSelections: input.tierSelections.map((line) => ({
                tierId: line.tierId,
                // Parsed rather than trusted: "3.5" and "abc" both have to
                // reach the resolver as something it will refuse, not as a
                // silent 1.
                quantity: Number(line.quantity),
              })),
            }
          : {}),
        ...(input.amount ? { amountKobo: fromNaira(input.amount) } : {}),
        ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(input.quantity ? { quantity: Number(input.quantity) } : {}),
        ...(input.itemSelections && input.itemSelections.length > 0
          ? {
              itemSelections: input.itemSelections.map((line) => ({
                itemId: line.itemId,
                quantity: Number(line.quantity),
              })),
            }
          : {}),
      },
    );
  } catch (error) {
    if (error instanceof ContributionError) return { error: error.message };
    return { error: "That amount could not be read. Enter it in naira, for example 5000." };
  }

  // §18: one name per ticket unit, only when this event asked for it. Checked
  // against how many tickets the server actually resolved — not what the
  // browser claims — so a basket trimmed by a stock limit cannot leave a
  // mismatched attendee list unnoticed.
  let attendees: string[] | null = null;
  if (collection.collect_attendee_details && resolved.lines) {
    const ticketCount = resolved.lines.reduce((sum, line) => sum + line.quantity, 0);
    const names = (input.attendeeNames ?? []).map((name) => name.trim()).filter((name) => name !== "");
    if (names.length !== ticketCount) {
      return {
        error: `This event asks for a name per ticket — ${ticketCount} needed, ${names.length} given.`,
      };
    }
    attendees = names;
  }

  return {
    ok: true,
    summary: {
      amount: formatNaira(resolved.amountKobo, { decimals: false }),
      tierName: resolved.lines ? null : tiers.find((tier) => tier.id === resolved.tierId)?.name ?? null,
      attendees,
      tierLines:
        resolved.lines && resolved.lines.length > 1
          ? resolved.lines.map((line) => ({
              name: line.name,
              quantity: line.quantity,
              amount: formatNaira(line.amountKobo, { decimals: false }),
            }))
          : null,
      itemName: resolved.itemLines && resolved.itemLines.length > 1
        ? null
        : items.find((item) => item.id === resolved.itemId)?.name ?? null,
      quantity: resolved.quantity ?? null,
      itemLines:
        resolved.itemLines && resolved.itemLines.length > 1
          ? resolved.itemLines.map((line) => ({
              name: line.name,
              quantity: line.quantity,
              amount: formatNaira(line.amountKobo, { decimals: false }),
            }))
          : null,
      contributorName: contact.data.fullName,
      memberName: memberContext?.full_name ?? null,
      memberCode: memberContext?.member_code ?? null,
      cycleLabel: memberContext?.cycle_label ?? null,
    },
  };
}
