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

export type AmountModel = "fixed" | "open_amount" | "tiers" | "per_member";

/** A tier as the public page sees it. `id` is the identity; `name` is a label (ADR 0010). */
export interface ContributionTier {
  readonly id: string;
  readonly name: string;
  readonly priceKobo: Kobo;
}

/** The authoritative configuration, loaded from the database by the server. */
export interface ContributionConfig {
  readonly amountModel: AmountModel;
  readonly fixedAmountKobo: Kobo | null;
  readonly minAmountKobo: Kobo | null;
  readonly maxAmountKobo: Kobo | null;
  readonly tiers: readonly ContributionTier[];
}

/** What the contributor's browser sent. Both fields are untrusted. */
export interface ContributionSelection {
  readonly tierId?: string | undefined;
  readonly amountKobo?: Kobo | undefined;
}

export interface ResolvedContribution {
  readonly amountKobo: Kobo;
  /** The tier this contribution is for, resolved by ID. Null when the collection has no tiers. */
  readonly tierId: string | null;
}

export type ContributionErrorCode =
  | "TIER_REQUIRED"
  | "UNKNOWN_TIER"
  | "AMOUNT_REQUIRED"
  | "AMOUNT_BELOW_MINIMUM"
  | "AMOUNT_ABOVE_MAXIMUM"
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

export function resolveContributionAmount(
  config: ContributionConfig,
  selection: ContributionSelection,
): ResolvedContribution {
  switch (config.amountModel) {
    case "fixed": {
      if (config.fixedAmountKobo === null || config.fixedAmountKobo <= ZERO) {
        throw new ContributionError("MISCONFIGURED", "This collection has no contribution amount set.");
      }
      // A submitted amount is not consulted at all. On a fixed collection the
      // price is the collection's, and accepting the browser's figure here is
      // how a ₦5,000 due becomes a ₦5 payment.
      return { amountKobo: config.fixedAmountKobo, tierId: null };
    }

    case "tiers": {
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

    case "per_member": {
      // Each member owes a different amount, recorded on their obligation.
      // There is nothing for an anonymous contributor to resolve against.
      throw new ContributionError(
        "NOT_OPEN_TO_CONTRIBUTORS",
        "This collection is for a specific list of members, each with their own amount.",
      );
    }
  }
}
