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
  /** Kolekto's own fee, per collection category. The "Kolekto fee" line shown to contributors (D-28). */
  readonly platformRate: Readonly<Record<string, BasisPoints>>;
  readonly platformRateDefault: BasisPoints;
  /**
   * The "Processing fee" line **shown to contributors** (D-28). This is a
   * number Kolekto charges, not the actual cost of goods sold — on D-28
   * schedules the two differ. The authoritative figure for the provider's
   * actual cost is what Paystack reports on the transaction (D-11), compared
   * against `providerCostRate` below.
   */
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
   * Caps on the lines shown to contributors. Each is independent; `null` means
   * uncapped, which is different from zero. On the 2026-09 schedules these
   * cap Kolekto's shown fees at Paystack's own cap figures. On D-28 and after
   * (2026-11-founder), the shown fees are **uncapped** — see that schedule's
   * comment for why.
   */
  readonly maxPlatformFee: Kobo | null;
  readonly maxGatewayFee: Kobo | null;
  /**
   * The **internal** estimate of what the payment provider will actually
   * charge Kolekto on this transaction (D-28). Separate from `gatewayRate`
   * because the "processing fee" line shown to contributors and the real
   * provider cost need not be the same number — under the negotiated
   * Paystack pricing, the shown rate is 1.5% uncapped while the real cost
   * is 1% capped at ₦2,000. Still an **estimate**: the reported `fees` field
   * on the provider's verify response remains authoritative (D-11), compared
   * against this figure for reconciliation (`providerFeeVariance`).
   *
   * When omitted, `gatewayRate` is used, preserving the behaviour of every
   * schedule written before D-28 where the two were the same number.
   */
  readonly providerCostRate?: BasisPoints;
  readonly maxProviderCost?: Kobo | null;
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

/**
 * Kolekto's live schedule. **D-28**, decided 2026-11-11, supersedes D-10.
 *
 *   "Processing fee" shown to contributor   1.5%, uncapped
 *   "Kolekto fee"    shown to contributor   0.5%, uncapped
 *   VAT                                      0%
 *
 *   internal Paystack cost estimate         1.0%, capped at ₦2,000
 *
 * ── THE DIFFERENCE BETWEEN THE SHOWN LINES AND THE INTERNAL COST ────────────
 *
 * This is the first schedule where the "processing fee" line **shown to
 * contributors** and the actual cost Paystack charges Kolekto are deliberately
 * different numbers. Paystack has agreed a **1% capped at ₦2,000** rate with
 * Kolekto; everything above that, up to the 1.5% Kolekto displays, is Kolekto's
 * margin on the processing line. The 0.5% "Kolekto fee" is a second margin
 * line, shown as such.
 *
 * Both shown lines are **uncapped by owner decision**. Paystack's own cost to
 * Kolekto remains capped at ₦2,000 (`maxProviderCost`), so on large payments
 * the processing fee shown to the contributor diverges from what Paystack
 * actually charges Kolekto.
 *
 * `fundraiser` carries no override: every category pays the same 0.5% (owner
 * decision 2026-11-11).
 *
 * ── WHAT KOLEKTO KEEPS ──────────────────────────────────────────────────────
 *
 *   platformFee + gatewayFee − authoritativeProviderFee(providerFee)
 *
 * where `authoritativeProviderFee` is the actual `fees` figure from Paystack's
 * verify response if present, else `providerCostEstimate` from this schedule.
 * See `kolektoRevenue` below.
 *
 * ── IF THE 1% TURNS OUT NOT TO BE CAPPED AT ₦2,000 ──────────────────────────
 *
 * The owner's statement and this schedule assume Paystack's negotiated 1% is
 * capped at ₦2,000 (matching Paystack's public cap). If sandbox or live data
 * shows otherwise — a transaction where `actual_provider_fee_kobo` exceeds
 * `maxProviderCost` — a new schedule version is cut, not this row edited (D-13).
 *
 * Mirrored by a new row to be added to `fee_schedules` by the next payments
 * migration; a pgTAP assertion will keep the row and these numbers in step.
 */
export const SCHEDULE_2026_11_FOUNDER: FeeSchedule = {
  version: "2026-11-founder",
  effectiveFrom: "2026-11-11",
  platformRate: {}, // one rate for every category — fundraiser included (owner, 2026-11-11)
  platformRateDefault: bps(50), // 0.5% — "Kolekto fee"
  gatewayRate: bps(150), // 1.5% — "Processing fee" shown to contributor
  vatRate: bps(0), // D-14
  maxPlatformFee: null, // uncapped (owner, 2026-11-11)
  maxGatewayFee: null, // uncapped (owner, 2026-11-11)
  providerCostRate: bps(100), // 1% — Paystack's negotiated rate to Kolekto
  maxProviderCost: 200_000n as Kobo, // ₦2,000 — Paystack's own cap
};

export interface FeeBreakdown {
  /** What the collection is credited with — the organizer's money, no fees mixed in. */
  readonly contribution: Kobo;
  /** The "Kolekto fee" line shown to contributors. */
  readonly platformFee: Kobo;
  /**
   * The "Processing fee" line shown to contributors (D-28). On 2026-11-founder
   * and after, this is a figure Kolekto charges, **not** the actual cost of
   * goods sold — compare with `providerCostEstimate`. On earlier schedules the
   * two are equal.
   */
  readonly gatewayFee: Kobo;
  /**
   * Kolekto's **internal** estimate of what the payment provider will charge
   * on this transaction (D-28). Never shown to contributors. On older schedules
   * where the schedule did not separate the two, this equals `gatewayFee`.
   *
   * At capture time, the provider's reported `fees` figure takes authority
   * over this (D-11, `authoritativeProviderFee`).
   */
  readonly providerCostEstimate: Kobo;
  /** D-14: VAT on the platform fee. Zero under the current schedule. */
  readonly vat: Kobo;
  /** Sum of the lines shown to contributors (platformFee + gatewayFee + vat). What the host absorbs under `community`. */
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
  // Kolekto's live schedule is the default. A caller that wants an older
  // schedule — the golden vectors, and nothing else in production — must name it.
  const schedule = input.schedule ?? SCHEDULE_2026_11_FOUNDER;
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
  // Each component is capped independently. The cap is applied to the fee
  // itself, before VAT.
  const platformFee = cap(applyRate(amount, platformRate), schedule.maxPlatformFee);
  const gatewayFee = cap(applyRate(amount, schedule.gatewayRate), schedule.maxGatewayFee);

  // The internal estimate of the provider's actual cost to Kolekto (D-28). On
  // schedules that don't separate the shown line from the cost, `providerCostRate`
  // and `maxProviderCost` fall back to `gatewayRate` and `maxGatewayFee`, so
  // `providerCostEstimate === gatewayFee` and nothing older changes.
  const providerCostRate = schedule.providerCostRate ?? schedule.gatewayRate;
  const providerCostCap = schedule.maxProviderCost === undefined ? schedule.maxGatewayFee : schedule.maxProviderCost;
  const providerCostEstimate = cap(applyRate(amount, providerCostRate), providerCostCap);

  // VAT is charged on Kolekto's own fee — the platform fee is the taxable
  // service — and never on the contribution or on the provider's fee. Zero
  // today (D-14), and rounded by the same single rule as every other rate so
  // that a future non-zero VAT does not introduce a second rounding behaviour.
  const vat = applyRate(platformFee, schedule.vatRate);

  // totalFees is what the CONTRIBUTOR sees / what the HOST absorbs. The internal
  // provider-cost estimate is NOT part of it — it is a cost Kolekto bears out of
  // what it collected, never an extra line charged to anyone.
  const totalFees = add(add(platformFee, gatewayFee), vat);

  const totalPayable = bearer === "contributor" ? add(amount, totalFees) : amount;
  const net = bearer === "contributor" ? amount : subtract(amount, totalFees);

  return {
    contribution: amount,
    platformFee,
    gatewayFee,
    providerCostEstimate,
    vat,
    totalFees,
    totalPayable,
    net,
    bearer,
    scheduleVersion: schedule.version,
  };
}

/**
 * What Kolekto keeps on a transaction, given the breakdown and the provider's
 * eventual fee report. Reporting only — never shown to a contributor or a host.
 *
 *   platformFee + gatewayFee − authoritativeProviderFee(providerFee)
 *
 * When Paystack has not yet reported, `providerFee.actual` is `null` and the
 * estimate is used; once it reports, the real figure replaces it (D-11). The
 * difference between the two is `providerFeeVariance`, a reconciliation input.
 */
export function kolektoRevenue(breakdown: FeeBreakdown, providerFee: ProviderFee): Kobo {
  return subtract(add(breakdown.platformFee, breakdown.gatewayFee), authoritativeProviderFee(providerFee));
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
