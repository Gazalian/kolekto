/**
 * contribution.ts — what one contributor's selection is worth, in kobo.
 *
 * The contributor's browser posts a choice: a tier, or an amount they typed.
 * This module turns that choice into an amount, using the collection's own
 * configuration as loaded from the database — never the figure the browser
 * sent.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE. The previous system resolved a tiered
 * payment in the request handler, by matching the submitted tier against a
 * jsonb array with a single `.find()` that compared on ID *or* name. Two tiers
 * called "Standard" collapsed onto whichever came first, and a contributor who
 * picked the ₦20,000 option was charged ₦5,000 (incident 2026-08-06). The rule
 * that prevents it is one line — match on ID, and only on ID — and it is worth
 * having somewhere it can be read, tested and reused rather than retyped at
 * each call site.
 *
 * Nothing here talks to Paystack, records anything, or knows that money will
 * eventually move. It answers one question: given this collection and this
 * selection, how much is owed? Phase 4's payment initialisation is a caller of
 * this function, not a replacement for it.
 */

import { type Kobo, ZERO } from "./money.ts";

export type AmountModel = "fixed" | "open_amount" | "tiers" | "per_member" | "items";

/**
 * A tier as the public page sees it. `id` is the identity; `name` is a label
 * (ADR 0010).
 *
 * `quantityLimit` and `perOrderLimit` exist on `collection_tiers` since the
 * very first collections migration (COL-13, CODE-02) — provisioned for
 * ticketing before ticketing had a UI. They are read here for the same
 * reason `ContributionItem` reads its own stock and per-order limit: a
 * quantity multiplies a price, which puts it on the money path, so it is
 * bounded against the collection's own row rather than trusted from a
 * contributor's browser.
 */
export interface ContributionTier {
  readonly id: string;
  readonly name: string;
  readonly priceKobo: Kobo;
  /** How many of this option remain. `null` is unlimited. */
  readonly quantityLimit: number | null;
  /** Most of this option one order may take. `null` is unbounded. */
  readonly perOrderLimit: number | null;
}

/**
 * An item as the public page sees it.
 *
 * Same identity rule as a tier, and one thing a tier does not have: a quantity.
 * An order is a price multiplied by a count, which makes the count part of the
 * money path — it is bounded here rather than trusted.
 */
export interface ContributionItem {
  readonly id: string;
  readonly name: string;
  readonly priceKobo: Kobo;
  /** How many remain. `null` is unlimited, which is not the same as none. */
  readonly quantityAvailable: number | null;
  readonly maxPerOrder: number | null;
}

/** The authoritative configuration, loaded from the database by the server. */
export interface ContributionConfig {
  readonly amountModel: AmountModel;
  readonly fixedAmountKobo: Kobo | null;
  readonly minAmountKobo: Kobo | null;
  readonly maxAmountKobo: Kobo | null;
  readonly tiers: readonly ContributionTier[];
  readonly items?: readonly ContributionItem[] | undefined;
  /**
   * What an identified member owes on this collection, from their obligation
   * row. Present only after the contributor has identified themselves on a
   * managed collection; loaded by the server from the database, never sent by
   * the browser.
   */
  readonly obligation?: ContributionObligation | undefined;
}

/**
 * The obligation an identified member is paying against.
 *
 * `expectedAmountKobo` is what they were asked for and `waivedAmountKobo` is
 * what the community forgave (OBL-08) — a waiver reduces what is owed without
 * anybody paying it, and is never counted as money collected. What remains to
 * pay is the difference, computed here rather than anywhere a browser can see.
 */
export interface ContributionObligation {
  readonly id: string;
  readonly expectedAmountKobo: Kobo;
  readonly waivedAmountKobo: Kobo;
  readonly status: "unpaid" | "in_installments" | "overdue" | "paid" | "exempt" | "cancelled";
}

/** One line of a multi-option order: this tier, this many. */
export interface TierSelectionLine {
  readonly tierId: string;
  readonly quantity: number;
}

/** One line of a multi-item order: this item, this many — the aso-ebi case, "2 yards blue, 4 yards gold". */
export interface ItemSelectionLine {
  readonly itemId: string;
  readonly quantity: number;
}

/** What the contributor's browser sent. Every field is untrusted. */
export interface ContributionSelection {
  /** A single option, quantity always one — the plain "choose one" shape most tiered collections still use. */
  readonly tierId?: string | undefined;
  /**
   * Several options, each with its own quantity — "VIP × 2, Regular × 1" — the
   * shape a ticketed event needs. Takes priority over `tierId` when both are
   * present, which a well-behaved caller never does; it exists so the two UIs
   * can share one resolver rather than one each.
   */
  readonly tierSelections?: readonly TierSelectionLine[] | undefined;
  readonly amountKobo?: Kobo | undefined;
  /** A single item, quantity given separately — the original "choose one thing" shape. */
  readonly itemId?: string | undefined;
  readonly quantity?: number | undefined;
  /**
   * Several items, each with its own quantity — an order with more than one
   * line, the same relationship `tierSelections` has to `tierId`. Takes
   * priority over `itemId` when both are present.
   */
  readonly itemSelections?: readonly ItemSelectionLine[] | undefined;
}

/** One resolved line of a multi-option order, for a receipt or a confirmation screen. */
export interface ResolvedTierLine {
  readonly tierId: string;
  readonly name: string;
  readonly quantity: number;
  readonly amountKobo: Kobo;
}

/** One resolved line of a multi-item order. */
export interface ResolvedItemLine {
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number;
  readonly amountKobo: Kobo;
}

export interface ResolvedContribution {
  readonly amountKobo: Kobo;
  /** The tier this contribution is for, resolved by ID. Null when the collection has no tiers, or when it resolved as several lines instead (see `lines`). */
  readonly tierId: string | null;
  /** The item this order is for, resolved by ID, and how many of it. Null on every other kind of collection. */
  readonly itemId?: string | null;
  readonly quantity?: number | null;
  /** Present only when `tierSelections` resolved more than one line — the per-tier breakdown `amountKobo` is the sum of. */
  readonly lines?: readonly ResolvedTierLine[] | undefined;
  /** Present only when `itemSelections` resolved the order — the per-item breakdown `amountKobo` is the sum of. */
  readonly itemLines?: readonly ResolvedItemLine[] | undefined;
}

export type ContributionErrorCode =
  | "TIER_REQUIRED"
  | "UNKNOWN_TIER"
  | "INVALID_TIER_QUANTITY"
  | "TIER_QUANTITY_ABOVE_LIMIT"
  | "AMOUNT_REQUIRED"
  | "AMOUNT_BELOW_MINIMUM"
  | "AMOUNT_ABOVE_MAXIMUM"
  | "ITEM_REQUIRED"
  | "UNKNOWN_ITEM"
  | "INVALID_QUANTITY"
  | "QUANTITY_ABOVE_LIMIT"
  | "MEMBER_REQUIRED"
  | "NOTHING_OWED"
  | "OBLIGATION_EXEMPT"
  | "NOT_OPEN_TO_CONTRIBUTORS"
  | "MISCONFIGURED";

export class ContributionError extends Error {
  readonly code: ContributionErrorCode;

  constructor(code: ContributionErrorCode, message: string) {
    super(message);
    this.name = "ContributionError";
    this.code = code;
  }
}

/**
 * What is left to pay on an obligation.
 *
 * Nothing is subtracted for money received, because no money has been received
 * anywhere in this phase (ADR 0006). A waiver is the one reduction that exists,
 * and it is a decision an officer recorded, not a payment.
 */
function amountOwed(obligation: ContributionObligation): Kobo {
  if (obligation.status === "exempt") {
    throw new ContributionError(
      "OBLIGATION_EXEMPT",
      "You have been exempted from this collection. There is nothing to pay.",
    );
  }
  if (obligation.status === "cancelled") {
    throw new ContributionError("NOTHING_OWED", "This is no longer being asked of you.");
  }

  const owed = (obligation.expectedAmountKobo - obligation.waivedAmountKobo) as Kobo;
  if (owed <= ZERO) {
    throw new ContributionError("NOTHING_OWED", "Your balance on this collection has been fully waived.");
  }
  return owed;
}

/**
 * Several tier lines, each with its own quantity, summed into one order —
 * "VIP × 2, Regular × 1, total ₦60,000". Every check `resolveContributionAmount`
 * already applies to a single item's quantity (whole number, above zero, at
 * most `perOrderLimit`, at most `quantityLimit` remaining) applies here per
 * line, because a quantity multiplies a price whichever kind of option it is
 * attached to.
 */
function resolveTierBasket(
  tiers: readonly ContributionTier[],
  lines: readonly TierSelectionLine[],
): ResolvedContribution {
  const seen = new Set<string>();
  const resolved: ResolvedTierLine[] = [];
  let total = ZERO;

  for (const line of lines) {
    const tier = tiers.find((candidate) => candidate.id === line.tierId);
    if (!tier) {
      throw new ContributionError("UNKNOWN_TIER", "One of the options chosen is no longer available.");
    }
    if (seen.has(tier.id)) {
      // A repeat is the same mistake at the receipt layer that a duplicate
      // display name is at the tier layer: two lines for one option cannot be
      // told apart, so the second is refused rather than silently added.
      throw new ContributionError("UNKNOWN_TIER", `"${tier.name}" was chosen more than once. Combine it into one line.`);
    }
    seen.add(tier.id);

    if (tier.priceKobo <= ZERO) {
      throw new ContributionError("MISCONFIGURED", `"${tier.name}" has no price set.`);
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new ContributionError("INVALID_TIER_QUANTITY", `Enter how many of "${tier.name}" you want, as a whole number.`);
    }
    if (tier.perOrderLimit !== null && line.quantity > tier.perOrderLimit) {
      throw new ContributionError(
        "TIER_QUANTITY_ABOVE_LIMIT",
        `You can take at most ${tier.perOrderLimit} of "${tier.name}" in one order.`,
      );
    }
    if (tier.quantityLimit !== null && line.quantity > tier.quantityLimit) {
      throw new ContributionError(
        "TIER_QUANTITY_ABOVE_LIMIT",
        tier.quantityLimit === 0 ? `"${tier.name}" is sold out.` : `Only ${tier.quantityLimit} of "${tier.name}" are left.`,
      );
    }

    const amountKobo = (tier.priceKobo * BigInt(line.quantity)) as Kobo;
    total = (total + amountKobo) as Kobo;
    resolved.push({ tierId: tier.id, name: tier.name, quantity: line.quantity, amountKobo });
  }

  if (resolved.length === 0) {
    throw new ContributionError("TIER_REQUIRED", "Choose at least one option before continuing.");
  }

  return { amountKobo: total, tierId: resolved.length === 1 ? resolved[0]!.tierId : null, lines: resolved };
}

/**
 * Several item lines, each with its own quantity, summed into one order — an
 * aso-ebi order with both the blue and the gold, or a food order with jollof
 * and a drink. Same shape and same checks as `resolveTierBasket`: a quantity
 * multiplies a price, so it is bounded against the item's own row (stock,
 * per-order limit) rather than trusted from the browser, whichever kind of
 * option it is attached to.
 */
function resolveItemBasket(
  items: readonly ContributionItem[],
  lines: readonly ItemSelectionLine[],
): ResolvedContribution {
  const seen = new Set<string>();
  const resolved: ResolvedItemLine[] = [];
  let total = ZERO;

  for (const line of lines) {
    const item = items.find((candidate) => candidate.id === line.itemId);
    if (!item) {
      throw new ContributionError("UNKNOWN_ITEM", "One of the items chosen is no longer available.");
    }
    if (seen.has(item.id)) {
      throw new ContributionError("UNKNOWN_ITEM", `"${item.name}" was chosen more than once. Combine it into one line.`);
    }
    seen.add(item.id);

    if (item.priceKobo <= ZERO) {
      throw new ContributionError("MISCONFIGURED", `"${item.name}" has no price set.`);
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new ContributionError("INVALID_QUANTITY", `Enter how many of "${item.name}" you want, as a whole number.`);
    }
    if (item.maxPerOrder !== null && line.quantity > item.maxPerOrder) {
      throw new ContributionError(
        "QUANTITY_ABOVE_LIMIT",
        `You can take at most ${item.maxPerOrder} of "${item.name}" in one order.`,
      );
    }
    if (item.quantityAvailable !== null && line.quantity > item.quantityAvailable) {
      throw new ContributionError(
        "QUANTITY_ABOVE_LIMIT",
        item.quantityAvailable === 0
          ? `"${item.name}" is sold out.`
          : `Only ${item.quantityAvailable} of "${item.name}" are left.`,
      );
    }

    const amountKobo = (item.priceKobo * BigInt(line.quantity)) as Kobo;
    total = (total + amountKobo) as Kobo;
    resolved.push({ itemId: item.id, name: item.name, quantity: line.quantity, amountKobo });
  }

  if (resolved.length === 0) {
    throw new ContributionError("ITEM_REQUIRED", "Choose at least one item before continuing.");
  }

  return {
    amountKobo: total,
    tierId: null,
    itemId: resolved.length === 1 ? resolved[0]!.itemId : null,
    quantity: resolved.length === 1 ? resolved[0]!.quantity : null,
    itemLines: resolved,
  };
}

export function resolveContributionAmount(
  config: ContributionConfig,
  selection: ContributionSelection,
): ResolvedContribution {
  switch (config.amountModel) {
    case "fixed": {
      // An identified member's own obligation wins over the collection's
      // headline amount: an officer may have waived part of what THEY owe, and
      // charging the headline would be charging them for a waiver they were
      // granted.
      if (config.obligation) {
        return { amountKobo: amountOwed(config.obligation), tierId: null };
      }
      if (config.fixedAmountKobo === null || config.fixedAmountKobo <= ZERO) {
        throw new ContributionError("MISCONFIGURED", "This collection has no contribution amount set.");
      }
      // A submitted amount is not consulted at all. On a fixed collection the
      // price is the collection's, and accepting the browser's figure here is
      // how a ₦5,000 due becomes a ₦5 payment.
      return { amountKobo: config.fixedAmountKobo, tierId: null };
    }

    case "tiers": {
      // The basket shape — several options, each with a quantity — is what a
      // ticketed event needs ("VIP × 2, Regular × 1"). It takes priority when
      // present; a plain "choose one" collection never sends it.
      if (selection.tierSelections && selection.tierSelections.length > 0) {
        return resolveTierBasket(config.tiers, selection.tierSelections);
      }

      if (!selection.tierId) {
        throw new ContributionError("TIER_REQUIRED", "Choose an option before continuing.");
      }
      // By ID. Never by name — see this file's header.
      const tier = config.tiers.find((candidate) => candidate.id === selection.tierId);
      if (!tier) {
        throw new ContributionError("UNKNOWN_TIER", "That option is no longer available. Choose another.");
      }
      if (tier.priceKobo <= ZERO) {
        throw new ContributionError("MISCONFIGURED", "That option has no price set.");
      }
      return { amountKobo: tier.priceKobo, tierId: tier.id };
    }

    case "open_amount": {
      const amount = selection.amountKobo;
      if (amount === undefined || amount <= ZERO) {
        throw new ContributionError("AMOUNT_REQUIRED", "Enter how much you would like to contribute.");
      }
      if (config.minAmountKobo !== null && amount < config.minAmountKobo) {
        throw new ContributionError("AMOUNT_BELOW_MINIMUM", "That is below the smallest contribution this collection accepts.");
      }
      if (config.maxAmountKobo !== null && amount > config.maxAmountKobo) {
        throw new ContributionError("AMOUNT_ABOVE_MAXIMUM", "That is above the largest contribution this collection accepts.");
      }
      return { amountKobo: amount, tierId: null };
    }

    case "items": {
      // The basket shape — several items, each with a quantity — is a catalog
      // order with more than one line ("2 yards blue, 4 yards gold"). It takes
      // priority when present; a single-item order never sends it.
      if (selection.itemSelections && selection.itemSelections.length > 0) {
        return resolveItemBasket(config.items ?? [], selection.itemSelections);
      }

      if (!selection.itemId) {
        throw new ContributionError("ITEM_REQUIRED", "Choose what you are paying for before continuing.");
      }
      // By ID, for the reason in this file's header: two items called "Blue"
      // must not be able to collapse onto whichever one comes first.
      const item = (config.items ?? []).find((candidate) => candidate.id === selection.itemId);
      if (!item) {
        throw new ContributionError("UNKNOWN_ITEM", "That item is no longer available. Choose another.");
      }
      if (item.priceKobo <= ZERO) {
        throw new ContributionError("MISCONFIGURED", "That item has no price set.");
      }

      // A quantity multiplies a price, so it is part of the money path and is
      // bounded here rather than taken as sent. Fractions and zero are refused
      // outright; the browser's copy of the limits decides nothing.
      const quantity = selection.quantity ?? 1;
      if (!Number.isSafeInteger(quantity) || quantity < 1) {
        throw new ContributionError("INVALID_QUANTITY", "Enter how many you want, as a whole number.");
      }
      if (item.maxPerOrder !== null && quantity > item.maxPerOrder) {
        throw new ContributionError(
          "QUANTITY_ABOVE_LIMIT",
          `You can take at most ${item.maxPerOrder} of that in one order.`,
        );
      }
      if (item.quantityAvailable !== null && quantity > item.quantityAvailable) {
        throw new ContributionError(
          "QUANTITY_ABOVE_LIMIT",
          item.quantityAvailable === 0
            ? "That item is sold out."
            : `Only ${item.quantityAvailable} of that are left.`,
        );
      }

      return {
        amountKobo: (item.priceKobo * BigInt(quantity)) as Kobo,
        tierId: null,
        itemId: item.id,
        quantity,
      };
    }

    case "per_member": {
      // Each member owes a different amount, recorded on their obligation. An
      // anonymous contributor has nothing to resolve against — but one who has
      // identified themselves on the roll does, and it is their own row.
      if (!config.obligation) {
        throw new ContributionError(
          "MEMBER_REQUIRED",
          "This collection is for a specific list of members, each with their own amount. Find yourself first.",
        );
      }
      return { amountKobo: amountOwed(config.obligation), tierId: null };
    }
  }
}
