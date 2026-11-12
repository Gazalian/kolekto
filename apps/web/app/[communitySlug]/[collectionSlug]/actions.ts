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
  type FeeBearer,
} from "@kolekto/domain";
import { buildContributorAnswersSchema, contributorContactSchema } from "@kolekto/validation";
import {
  clearContributorSession,
  readContributorSession,
  setContributorSession,
} from "../../../lib/contributor-session.ts";
import { allowLookup } from "../../../lib/lookup-throttle.ts";
import { startCheckout } from "@kolekto/payments";
import { contributorCheckoutUrl, getPaymentContext } from "../../../lib/payments/provider-factory.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Codes raised by app.create_payment_attempt (20261111100100), as copy a
 * contributor can act on. Database messages are never shown: they carry ids.
 * Codes absent here mean a bug on Kolekto's side and get the generic message.
 */
const CHECKOUT_ERROR_MESSAGES: Record<string, string> = {
  COLLECTION_NOT_FOUND: "This collection is no longer available.",
  COLLECTION_NOT_ACTIVE: "This collection is not accepting contributions right now.",
  COLLECTION_IMPORTED: "This collection cannot take payments here. Contact the organiser.",
  COLLECTION_NOT_YET_OPEN: "This collection is not open for contributions yet.",
  COLLECTION_WINDOW_CLOSED: "This collection has closed and is no longer accepting contributions.",
  TARGET_REACHED: "This collection has reached its target and is no longer accepting contributions.",
  MEMBER_REQUIRED: "Find yourself on the list before continuing.",
  MEMBER_NOT_ELIGIBLE: "That record can no longer contribute to this collection.",
  NOTHING_OWED: "There is nothing for you to pay on this collection.",
  ALREADY_PAID: "You have already paid this in full.",
  OBLIGATION_EXEMPT: "You have been exempted from this collection. There is nothing to pay.",
  INSTALLMENTS_NOT_SUPPORTED: "Part payments are not available yet.",
  AMOUNT_REQUIRED: "Enter an amount.",
  AMOUNT_BELOW_MINIMUM: "That amount is below the minimum for this collection.",
  AMOUNT_ABOVE_MAXIMUM: "That amount is above the maximum for this collection.",
  TIER_NOT_AVAILABLE: "One of the options you chose is no longer available.",
  ITEM_NOT_AVAILABLE: "One of the items you chose is no longer available.",
  SOLD_OUT: "One of the options you chose has sold out. Check your order and try again.",
  PER_ORDER_LIMIT: "You chose more than one order allows. Lower the quantity and try again.",
  ATTENDEE_COUNT_MISMATCH: "Enter one name for each ticket.",
  AMOUNT_MISMATCH: "Prices on this page have changed. Refresh the page and try again.",
  FEE_SCHEDULE_NOT_CURRENT: "Fees have just changed. Refresh the page and try again.",
  PAYMENT_ABOVE_CEILING: "This amount is above the limit for a single payment.",
  CONTACT_REQUIRED: "Enter your name, email address and phone number.",
  PAYMENT_IN_PROGRESS: "A payment for this is already in progress. Finish it, or wait a little while and try again.",
  CHECKOUT_KEY_REUSED: "Your order changed since you last pressed Pay. Press Pay again to continue.",
};

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
  /** The checkout key is spent (its attempt ended or the order changed). The form must generate a new one before retrying. */
  restartCheckout?: boolean;
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
  /** Present when a payment attempt was created and the provider initialized. */
  payment?: {
    reference: string;
    checkoutUrl: string;
    /** True when the contributor pays the fees on top (fee_mode contributor_pays); false when the community absorbs them. */
    feesAddedToTotal: boolean;
    fees: {
      contribution: string;
      platformFee: string;
      gatewayFee: string;
      totalFees: string;
      totalPayable: string;
      net: string;
    };
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
    /** "BIO26-0042" — this person's reference for this collection, when it issues them (M7.6 part N). */
    reference: string | null;
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
    reference: context.contributor_reference,
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
    /** Generated once per checkout by the form (crypto.randomUUID). A double-click resends it and gets the same attempt back (D-25). */
    checkoutKey: string;
  },
): Promise<ContributionResult> {
  if (typeof input.checkoutKey !== "string" || !UUID.test(input.checkoutKey)) {
    return { error: "Refresh the page and try again.", restartCheckout: true };
  }

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
  let memberId: string | null = null;
  if (collection.audience_mode !== "public") {
    memberId = await readContributorSession(collection.collection_id);
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

  const feeBearer: FeeBearer = collection.fee_mode === "contributor_pays" ? "contributor" : "community";

  const payments = getPaymentContext();
  if (!payments) return { error: "Payments are not available right now. Please try again later." };

  const checkoutResult = await startCheckout(payments, {
    environment: payments.environment,
    appOrigin: payments.appOrigin,
    collectionId: collection.collection_id,
    collectionCategory: collection.category,
    collectionSlug,
    communitySlug,
    amountModel: collection.amount_model,
    feeBearer,
    resolved,
    memberId,
    contributorName: contact.data.fullName,
    contributorEmail: contact.data.email,
    contributorPhone: contact.data.phone,
    answers: answers.data,
    attendeeNames: attendees ?? [],
    checkoutIdempotencyKey: input.checkoutKey,
  });

  switch (checkoutResult.outcome) {
    case "db_error": {
      const message = CHECKOUT_ERROR_MESSAGES[checkoutResult.code];
      if (!message) console.error(JSON.stringify({ msg: "checkout_refused_unmapped", code: checkoutResult.code }));
      return {
        error: message ?? "This payment could not be started. Please try again, or contact the organiser.",
        ...(checkoutResult.code === "CHECKOUT_KEY_REUSED" ? { restartCheckout: true } : {}),
      };
    }
    case "checkout_ended":
      return { error: "That checkout has ended. Press Pay again to start a new one.", restartCheckout: true };
    case "already_paid":
      return { error: "This payment has already been received. Check your email for the receipt.", restartCheckout: true };
    case "provider_refused":
      return { error: "The payment could not be started. Please try again.", restartCheckout: true };
    case "provider_unavailable":
      // Same key on retry: it resumes this attempt rather than creating another (D-27).
      return { error: "The payment service did not respond. Wait a moment and press Pay again." };
    case "misconfigured":
      console.error(JSON.stringify({ msg: "checkout_misconfigured", reason: checkoutResult.reason }));
      return { error: "Payments are not available right now. Please try again later." };
  }

  const fees = checkoutResult.fees;

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
    payment: {
      reference: checkoutResult.reference,
      checkoutUrl: contributorCheckoutUrl(
        payments.provider,
        checkoutResult.checkoutUrl,
        communitySlug,
        collectionSlug,
        checkoutResult.reference,
      ),
      feesAddedToTotal: fees.bearer === "contributor",
      fees: {
        contribution: formatNaira(fees.contribution, { decimals: false }),
        platformFee: formatNaira(fees.platformFee, { decimals: false }),
        gatewayFee: formatNaira(fees.gatewayFee, { decimals: false }),
        totalFees: formatNaira(fees.totalFees, { decimals: false }),
        totalPayable: formatNaira(fees.totalPayable, { decimals: false }),
        net: formatNaira(fees.net, { decimals: false }),
      },
    },
  };
}
