/**
 * fees.ts — the fee engine.
 *
 * PRC-12: "A single server-side fee function takes (plan, method, amount, fee
 * mode, community overrides, schedule version) and returns (contribution,
 * contributor fee, community fee, PSP fee estimate, Kolekto fee, total, net).
 * All screens and the ledger use it."
 *
 * ── STATUS: STILL NOT WIRED TO A PAYMENT ────────────────────────────────────
 *
 * M8.1 settled the rates (D-10) but built nothing that charges them. There is
 * no payment attempt, no contribution and no provider call, so the only caller
 * today is an organiser-facing preview.
 *
 * Two schedules therefore live here, and the difference matters:
 *
 *   · SCHEDULE_2026_09_FOUNDER      — what Kolekto charges. 1.5% / 1.5% / 0.
 *   · SCHEDULE_2026_09_PROVISIONAL  — what the PREVIOUS system charged, kept
 *                                     as a test fixture. Its golden vectors
 *                                     pin the arithmetic against known
 *                                     behaviour. Nothing has ever referenced
 *                                     it as a real schedule, and nothing
 *                                     should start.
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
  /** Estimated Paystack fee. An ESTIMATE: the authoritative figure is what Paystack reports on the transaction (D-11). */
  readonly gatewayRate: BasisPoints;
  /**
   * D-14: VAT, explicitly. Zero under the current decision.
   *
   * Present as a field rather than absent so that "VAT was considered and it is
   * zero" is distinguishable from "nobody thought about VAT". Charged on
   * Kolekto's own fee — the platform fee is the taxable service — and never on
   * the contribution or on the provider's fee.
   */
  readonly vatRate: BasisPoints;
  /**
   * Each fee is capped independently, and the caps are ASYMMETRIC by decision
   * (D-10): Kolekto's own fee caps higher than the modeled provider fee.
   * `null` means uncapped, which is a different statement from zero.
   */
  readonly maxPlatformFee: Kobo | null;
  readonly maxGatewayFee: Kobo | null;
}

/**
 * The PREVIOUS system's rates, kept as a test fixture and nothing else.
 *
 * Superseded as Kolekto's schedule by SCHEDULE_2026_09_FOUNDER (D-10). It is
 * not deleted because its golden vectors are what prove the integer arithmetic
 * reproduces known behaviour, and because a versioned schedule is never edited
 * in place — old transactions keep pointing at the version they used. No
 * transaction has ever pointed at this one.
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
  vatRate: bps(0),
  maxPlatformFee: 200_000n as Kobo, // ₦2,000
  maxGatewayFee: 200_000n as Kobo, // ₦2,000
};

/**
 * Kolekto's schedule. D-10, decided 2026-09-24.
 *
 *   platform fee   1.5%, every category, capped at ₦5,000
 *   provider fee   1.5%, a MODEL only,   capped at ₦2,000
 *   VAT            0%
 *
 * One rate for every category (assumption A-3, `platformRate` deliberately
 * empty so the default applies to all of them).
 *
 * The provider rate is an estimate. The founder's current understanding is that
 * Paystack charges nearer 1%, and this stays at 1.5% until real transaction data
 * says otherwise — but the moment Paystack reports a fee for a transaction, the
 * REPORTED figure is that transaction's truth and this model is not consulted
 * for it again (D-11, and `ProviderFee` below).
 *
 * Mirrored by the row inserted in `20260924100000_fee_schedules.sql`. The table
 * is the record; this is the calculator. A pgTAP assertion keeps the row and
 * these numbers in step.
 */
export const SCHEDULE_2026_09_FOUNDER: FeeSchedule = {
  version: "2026-09-founder",
  effectiveFrom: "2026-09-24",
  platformRate: {},
  platformRateDefault: bps(150), // 1.5%
  gatewayRate: bps(150), // 1.5%, modeled
  vatRate: bps(0), // D-14
  maxPlatformFee: 500_000n as Kobo, // ₦5,000
  maxGatewayFee: 200_000n as Kobo, // ₦2,000
};

export interface FeeBreakdown {
  /** What the collection is credited with — the organizer's money, no fees mixed in. */
  readonly contribution: Kobo;
  readonly platformFee: Kobo;
  /** The MODELED provider fee. An estimate until the provider reports one (D-11). */
  readonly gatewayFee: Kobo;
  /** D-14: VAT on the platform fee. Zero under the current schedule. */
  readonly vat: Kobo;
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
  // Kolekto's own schedule is the default. A caller that wants the previous
  // system's rates — only the golden vectors do — must name them.
  const schedule = input.schedule ?? SCHEDULE_2026_09_FOUNDER;
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
  //
  // Each component is capped independently, and the caps differ (D-10). The cap
  // is applied to the fee itself, before VAT.
  const platformFee = cap(applyRate(amount, platformRate), schedule.maxPlatformFee);
  const gatewayFee = cap(applyRate(amount, schedule.gatewayRate), schedule.maxGatewayFee);

  // VAT is charged on Kolekto's own fee — the platform fee is the taxable
  // service — and never on the contribution or on the provider's fee. Zero
  // today (D-14), and rounded by the same single rule as every other rate so
  // that a future non-zero VAT does not introduce a second rounding behaviour.
  const vat = applyRate(platformFee, schedule.vatRate);

  const totalFees = add(add(platformFee, gatewayFee), vat);

  const totalPayable = bearer === "contributor" ? add(amount, totalFees) : amount;
  const net = bearer === "contributor" ? amount : subtract(amount, totalFees);

  return {
    contribution: amount,
    platformFee,
    gatewayFee,
    vat,
    totalFees,
    totalPayable,
    net,
    bearer,
    scheduleVersion: schedule.version,
  };
}

/** Apply a per-component cap. `null` means uncapped, which is not the same as zero. */
function cap(fee: Kobo, ceiling: Kobo | null): Kobo {
  return ceiling === null ? fee : min(fee, ceiling);
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

/**
 * The provider's fee, as two separate facts (D-11).
 *
 * The distinction is the whole point. `estimated` is Kolekto's model, frozen at
 * attempt time from the schedule. `actual` is what the provider said it charged,
 * and it is the financial truth for that transaction the moment it exists.
 *
 * Neither ever overwrites the other. The old system kept one number and could
 * not afterwards answer whether a discrepancy was a modelling error, a provider
 * change, or a bug — because there was nothing to compare against.
 *
 * `actual` is `null` until the provider reports. `null` means "not yet known",
 * never "zero".
 */
export interface ProviderFee {
  /** Kolekto's model, from the fee schedule. Never authoritative once `actual` is set. */
  readonly estimated: Kobo;
  /** What the provider reported. Authoritative. `null` until it does. */
  readonly actual: Kobo | null;
  /** The schedule version the estimate came from, so a variance can be explained. */
  readonly scheduleVersion: string;
}

/**
 * How far the model was out, positive when the provider charged MORE than
 * modeled. `null` while the provider has not reported — an unknown variance is
 * not a variance of zero.
 *
 * This is a reconciliation input, not an error. It exists as a function so that
 * nobody writes the subtraction inline and picks the opposite sign convention.
 */
export function providerFeeVariance(fee: ProviderFee): Kobo | null {
  return fee.actual === null ? null : subtract(fee.actual, fee.estimated);
}

/** Which figure a ledger posting must use: the provider's if it has spoken, ours until then. */
export function authoritativeProviderFee(fee: ProviderFee): Kobo {
  return fee.actual ?? fee.estimated;
}
