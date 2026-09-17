/**
 * fees.ts — the fee engine.
 *
 * PRC-12: "A single server-side fee function takes (plan, method, amount, fee
 * mode, community overrides, schedule version) and returns (contribution,
 * contributor fee, community fee, PSP fee estimate, Kolekto fee, total, net).
 * All screens and the ledger use it."
 *
 * ── STATUS: NOT WIRED TO ANYTHING ───────────────────────────────────────────
 *
 * This is a port, not a live component. Payment functionality is gated on
 * DEC-01, DEC-02 and DEC-03 (ADR 0006), and the RATES BELOW ARE PROVISIONAL:
 * they are what the previous system charged, carried across so the arithmetic
 * can be tested against known-good behaviour. The real numbers come from
 * DEC-11, after the unit-economics model is built from actual Paystack,
 * WhatsApp and SMS costs.
 *
 * It exists now for one reason: the arithmetic is the part that was wrong, and
 * proving the integer version behaves correctly is cheap to do before anything
 * depends on it, and expensive to retrofit afterwards.
 *
 * ── What changed from the previous implementation ───────────────────────────
 *
 * The behaviour is deliberately identical except for the number type. Fees are
 * calculated on the contribution amount, never on the payable; the contributor-
 * borne case adds fees on top; the organizer-borne case takes them out of the
 * net. Each fee is capped independently.
 *
 * What changed: every value is integer kobo, rates are integer basis points,
 * and rounding is half away from zero applied exactly once per fee (money.ts).
 * The old version did all of this in IEEE-754 doubles with `toFixed(2)`.
 */

import { type BasisPoints, type Kobo, ZERO, add, applyRate, bps, min, subtract } from "./money.ts";

/** Who absorbs the fees (PRC-02). Subject to DEC-12: whether fees may be passed to contributors at all is a legal question. */
export type FeeBearer = "contributor" | "community";

/**
 * A versioned fee schedule.
 *
 * PRC-09: "Each transaction stores the fee schedule version used." This is the
 * fix for the previous system's worst accounting property — balances were
 * recomputed nightly against the CURRENT constants, so changing a rate silently
 * restated every historical balance.
 */
export interface FeeSchedule {
  readonly version: string;
  readonly effectiveFrom: string;
  /** Kolekto's own fee, per collection category. */
  readonly platformRate: Readonly<Record<string, BasisPoints>>;
  readonly platformRateDefault: BasisPoints;
  /** Estimated Paystack fee. An ESTIMATE: the authoritative figure is what Paystack reports on the transaction (P9). */
  readonly gatewayRate: BasisPoints;
  /** Each fee is capped independently, as the previous implementation did. */
  readonly maxFeePerComponent: Kobo;
}

/**
 * PROVISIONAL. Carried from the previous system so behaviour can be compared.
 * Replace wholesale when DEC-11 lands; do not edit in place, because a schedule
 * is versioned and old transactions keep pointing at the version they used.
 */
export const SCHEDULE_2026_09_PROVISIONAL: FeeSchedule = {
  version: "2026-09-provisional",
  effectiveFrom: "2026-09-17",
  platformRate: {
    fundraiser: bps(100), // 1%
    dues: bps(50),
    contribution: bps(50),
    event: bps(50),
    items: bps(50),
    other: bps(50),
  },
  platformRateDefault: bps(50), // 0.5%
  gatewayRate: bps(150), // 1.5%
  maxFeePerComponent: 200_000n as Kobo, // ₦2,000 per component
};

export interface FeeBreakdown {
  /** What the collection is credited with — the organizer's money, no fees mixed in. */
  readonly contribution: Kobo;
  readonly platformFee: Kobo;
  readonly gatewayFee: Kobo;
  readonly totalFees: Kobo;
  /** What the contributor is actually charged. */
  readonly totalPayable: Kobo;
  /** What the community ends up with, after fees. */
  readonly net: Kobo;
  readonly bearer: FeeBearer;
  readonly scheduleVersion: string;
}

export interface CalculateFeesInput {
  readonly amount: Kobo;
  readonly category: string;
  readonly bearer: FeeBearer;
  readonly schedule?: FeeSchedule;
  /** PRC-02: a per-community override negotiated for a large body or partner. */
  readonly platformRateOverride?: BasisPoints;
}

/**
 * The single fee calculation. Every screen, every receipt and every ledger
 * journal calls this and nothing else (PRC-12).
 */
export function calculateFees(input: CalculateFeesInput): FeeBreakdown {
  const schedule = input.schedule ?? SCHEDULE_2026_09_PROVISIONAL;
  const { amount, category, bearer } = input;

  if (amount < ZERO) {
    throw new Error("calculateFees() received a negative amount. A contribution is never negative.");
  }

  const platformRate =
    input.platformRateOverride ?? schedule.platformRate[category] ?? schedule.platformRateDefault;

  // Fees are ALWAYS calculated on the contribution amount, never on the
  // payable. Charging a fee on a fee is how a contributor-borne total drifts
  // upward, and it is the behaviour the previous implementation was careful to
  // avoid — worth preserving explicitly rather than rediscovering.
  const platformFee = min(applyRate(amount, platformRate), schedule.maxFeePerComponent);
  const gatewayFee = min(applyRate(amount, schedule.gatewayRate), schedule.maxFeePerComponent);
  const totalFees = add(platformFee, gatewayFee);

  const totalPayable = bearer === "contributor" ? add(amount, totalFees) : amount;
  const net = bearer === "contributor" ? amount : subtract(amount, totalFees);

  return {
    contribution: amount,
    platformFee,
    gatewayFee,
    totalFees,
    totalPayable,
    net,
    bearer,
    scheduleVersion: schedule.version,
  };
}

/**
 * PRC-04: "For a ₦10,000 payment, you'll receive about ₦X."
 *
 * Shown to an officer while they are choosing a fee mode, so the trade-off is
 * visible before they publish rather than after the first payment lands.
 */
export function netForCommunity(input: CalculateFeesInput): Kobo {
  return calculateFees(input).net;
}
