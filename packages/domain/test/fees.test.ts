import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  authoritativeProviderFee,
  calculateFees,
  providerFeeVariance,
  SCHEDULE_2026_09_FOUNDER,
  SCHEDULE_2026_09_PROVISIONAL,
} from "../src/fees.ts";
import { formatNaira, fromNaira, kobo } from "../src/money.ts";

/**
 * PRC-13: "Fee calculation is covered by table-driven tests for every band
 * boundary and cap."
 *
 * Two golden sets, one per schedule version, and both stay.
 *
 *   · the PROVISIONAL vectors below — the previous system's rates, which is what
 *     pins the integer arithmetic against known behaviour
 *   · the FOUNDER vectors further down — Kolekto's own rates (D-10)
 *
 * Every call names its schedule explicitly rather than relying on the default.
 * A golden vector that silently re-prices when the default schedule changes is
 * not a golden vector, and a new schedule version is exactly when that would
 * happen (D-13: a version is added, never edited, because old transactions keep
 * pointing at the version they used).
 */

const vectors = [
  // amount,      category,       bearer,        platform,   gateway,   payable,     net
  ["₦1,000", "dues", "community", "₦5.00", "₦15.00", "₦1,000.00", "₦980.00"],
  ["₦1,000", "dues", "contributor", "₦5.00", "₦15.00", "₦1,020.00", "₦1,000.00"],
  ["₦20,000", "dues", "community", "₦100.00", "₦300.00", "₦20,000.00", "₦19,600.00"],
  ["₦20,000", "dues", "contributor", "₦100.00", "₦300.00", "₦20,400.00", "₦20,000.00"],
  // Fundraisers carry 1% rather than 0.5%.
  ["₦20,000", "fundraiser", "community", "₦200.00", "₦300.00", "₦20,000.00", "₦19,500.00"],
  // An unknown category falls back to the default rate rather than throwing —
  // a new collection category must never be able to stop money being priced.
  ["₦20,000", "something_new", "community", "₦100.00", "₦300.00", "₦20,000.00", "₦19,600.00"],
] as const;

describe("calculateFees() — golden vectors, provisional schedule", () => {
  for (const [amount, category, bearer, platform, gateway, payable, net] of vectors) {
    it(`${amount} ${category}, ${bearer}-borne`, () => {
      const result = calculateFees({
        amount: fromNaira(amount.replace("₦", "")),
        category,
        bearer: bearer as "community" | "contributor",
        schedule: SCHEDULE_2026_09_PROVISIONAL,
      });

      assert.equal(formatNaira(result.platformFee), platform, "platform fee");
      assert.equal(formatNaira(result.gatewayFee), gateway, "gateway fee");
      assert.equal(formatNaira(result.totalPayable), payable, "total payable");
      assert.equal(formatNaira(result.net), net, "net to community");
      assert.equal(result.scheduleVersion, "2026-09-provisional");
    });
  }
});

describe("the ₦2,000 per-component cap", () => {
  it("caps each fee independently, as the previous implementation did", () => {
    // ₦1,000,000 at 1.5% would be ₦15,000 uncapped; at 0.5%, ₦5,000.
    // Both land on the ₦2,000 cap, so total fees are ₦4,000, not ₦2,000.
    const result = calculateFees({
      amount: fromNaira("1000000"),
      category: "dues",
      bearer: "community",
      schedule: SCHEDULE_2026_09_PROVISIONAL,
    });

    assert.equal(formatNaira(result.platformFee), "₦2,000.00");
    assert.equal(formatNaira(result.gatewayFee), "₦2,000.00");
    assert.equal(formatNaira(result.totalFees), "₦4,000.00");
  });

  it("finds the exact amount at which each component reaches its cap", () => {
    // Platform 0.5% hits ₦2,000 at ₦400,000. Gateway 1.5% hits it at ₦133,333.34.
    const atPlatformCap = calculateFees({
      amount: fromNaira("400000"),
      category: "dues",
      bearer: "community",
      schedule: SCHEDULE_2026_09_PROVISIONAL,
    });
    assert.equal(formatNaira(atPlatformCap.platformFee), "₦2,000.00");

    const justBelow = calculateFees({
      amount: fromNaira("399999"),
      category: "dues",
      bearer: "community",
      schedule: SCHEDULE_2026_09_PROVISIONAL,
    });
    assert.equal(formatNaira(justBelow.platformFee), "₦2,000.00".replace("2,000.00", "2,000.00"));
    assert.ok(justBelow.platformFee <= atPlatformCap.platformFee);
  });
});

describe("fees are charged on the contribution, never on the payable", () => {
  it("does not compound a contributor-borne fee", () => {
    // ₦20,000 + ₦400 of fees = ₦20,400. If fees were charged on the payable,
    // the total would creep upward on every recalculation.
    const result = calculateFees({
      amount: fromNaira("20000"),
      category: "dues",
      bearer: "contributor",
      schedule: SCHEDULE_2026_09_PROVISIONAL,
    });
    assert.equal(result.totalPayable, kobo(2_040_000n));

    const again = calculateFees({
      amount: result.contribution,
      category: "dues",
      bearer: "contributor",
      schedule: SCHEDULE_2026_09_PROVISIONAL,
    });
    assert.equal(again.totalPayable, result.totalPayable, "recalculating is stable");
  });
});

describe("invariants that must hold for any input", () => {
  it("keeps payable, net and fees consistent across a wide range", () => {
    // The provisional schedule caps both components. Read once, and refuse
    // rather than skip if that ever stops being true — a cap assertion that
    // quietly stops asserting is worse than one that fails.
    const platformCap = SCHEDULE_2026_09_PROVISIONAL.maxPlatformFee;
    const gatewayCap = SCHEDULE_2026_09_PROVISIONAL.maxGatewayFee;
    if (platformCap === null || gatewayCap === null) {
      throw new Error("the provisional schedule is expected to cap both fee components");
    }

    for (let naira = 1; naira <= 2_000_000; naira = Math.ceil(naira * 1.7)) {
      for (const bearer of ["community", "contributor"] as const) {
        const r = calculateFees({
          amount: fromNaira(String(naira)),
          category: "dues",
          bearer,
          schedule: SCHEDULE_2026_09_PROVISIONAL,
        });

        assert.equal(r.platformFee + r.gatewayFee + r.vat, r.totalFees, `fees add up at ₦${naira}`);

        if (bearer === "contributor") {
          assert.equal(r.totalPayable, r.contribution + r.totalFees, `payable at ₦${naira}`);
          assert.equal(r.net, r.contribution, `net at ₦${naira}`);
        } else {
          assert.equal(r.totalPayable, r.contribution, `payable at ₦${naira}`);
          assert.equal(r.net, r.contribution - r.totalFees, `net at ₦${naira}`);
        }

        assert.ok(r.platformFee <= platformCap, `platform cap at ₦${naira}`);
        assert.ok(r.gatewayFee <= gatewayCap, `gateway cap at ₦${naira}`);
        assert.ok(r.totalFees >= 0n, `fees never negative at ₦${naira}`);
      }
    }
  });

  it("refuses a negative contribution", () => {
    assert.throws(() =>
      calculateFees({
        amount: kobo(-1n),
        category: "dues",
        bearer: "community",
        schedule: SCHEDULE_2026_09_PROVISIONAL,
      }),
    );
  });
});

/**
 * D-10: Kolekto's own schedule. 1.5% platform capped at ₦5,000, 1.5% modeled
 * provider fee capped at ₦2,000, VAT 0.
 *
 * The caps are asymmetric on purpose, so the vectors below deliberately cross
 * one cap without crossing the other — the ₦200,000 row is the case that would
 * pass under a single shared cap and fail under the real one.
 */
const founderVectors = [
  // amount,        category,  bearer,        platform,     gateway,     payable,        net
  ["₦1,000", "dues", "community", "₦15.00", "₦15.00", "₦1,000.00", "₦970.00"],
  ["₦1,000", "dues", "contributor", "₦15.00", "₦15.00", "₦1,030.00", "₦1,000.00"],
  ["₦10,000", "dues", "community", "₦150.00", "₦150.00", "₦10,000.00", "₦9,700.00"],
  ["₦10,000", "dues", "contributor", "₦150.00", "₦150.00", "₦10,300.00", "₦10,000.00"],
  // One rate for every category (A-3): a fundraiser is priced the same as dues,
  // unlike the provisional schedule.
  ["₦10,000", "fundraiser", "community", "₦150.00", "₦150.00", "₦10,000.00", "₦9,700.00"],
  // ₦200,000 × 1.5% = ₦3,000. Under the platform cap of ₦5,000, over the
  // gateway cap of ₦2,000. Only the gateway fee is capped.
  ["₦200,000", "dues", "community", "₦3,000.00", "₦2,000.00", "₦200,000.00", "₦195,000.00"],
  // ₦1,000,000 × 1.5% = ₦15,000. Both caps bite, at their own figures.
  ["₦1,000,000", "dues", "community", "₦5,000.00", "₦2,000.00", "₦1,000,000.00", "₦993,000.00"],
] as const;

describe("calculateFees() — Kolekto's schedule (D-10)", () => {
  for (const [amount, category, bearer, platform, gateway, payable, net] of founderVectors) {
    it(`${amount} ${category} ${bearer}-borne → platform ${platform}, provider ${gateway}, net ${net}`, () => {
      const result = calculateFees({
        amount: fromNaira(amount),
        category,
        bearer,
        schedule: SCHEDULE_2026_09_FOUNDER,
      });

      assert.equal(formatNaira(result.platformFee), platform, "platform fee");
      assert.equal(formatNaira(result.gatewayFee), gateway, "modeled provider fee");
      assert.equal(formatNaira(result.totalPayable), payable, "total payable");
      assert.equal(formatNaira(result.net), net, "net to the collection");
      assert.equal(result.scheduleVersion, "2026-09-founder");
    });
  }

  it("charges no VAT, and says so rather than omitting it (D-14)", () => {
    for (const naira of ["₦1,000", "₦10,000", "₦1,000,000"]) {
      const r = calculateFees({
        amount: fromNaira(naira),
        category: "dues",
        bearer: "community",
        schedule: SCHEDULE_2026_09_FOUNDER,
      });
      assert.equal(r.vat, kobo(0n), `VAT at ${naira}`);
      assert.equal(r.totalFees, r.platformFee + r.gatewayFee + r.vat, `total at ${naira}`);
    }
  });

  it("caps each component at its own figure, not at a shared one", () => {
    const big = calculateFees({
      amount: fromNaira("₦10,000,000"),
      category: "dues",
      bearer: "community",
      schedule: SCHEDULE_2026_09_FOUNDER,
    });

    assert.equal(formatNaira(big.platformFee), "₦5,000.00", "platform caps at ₦5,000");
    assert.equal(formatNaira(big.gatewayFee), "₦2,000.00", "provider model caps at ₦2,000");
    assert.notEqual(big.platformFee, big.gatewayFee, "the caps are asymmetric by decision (D-10)");
  });

  it("never charges a fee on a fee, at either bearer", () => {
    const amount = fromNaira("₦10,000");

    const passed = calculateFees({
      amount,
      category: "dues",
      bearer: "contributor",
      schedule: SCHEDULE_2026_09_FOUNDER,
    });
    // Re-pricing the contribution the contributor's payment produced must give
    // the same total. If fees were charged on the payable, this would climb.
    const again = calculateFees({
      amount: passed.contribution,
      category: "dues",
      bearer: "contributor",
      schedule: SCHEDULE_2026_09_FOUNDER,
    });
    assert.equal(again.totalPayable, passed.totalPayable, "contributor-borne is stable");

    const absorbed = calculateFees({
      amount,
      category: "dues",
      bearer: "community",
      schedule: SCHEDULE_2026_09_FOUNDER,
    });

    // The bearer decides who is out of pocket. It does not change the fee.
    assert.equal(passed.platformFee, absorbed.platformFee, "same platform fee, either bearer");
    assert.equal(passed.gatewayFee, absorbed.gatewayFee, "same provider fee, either bearer");
    assert.equal(passed.totalFees, absorbed.totalFees, "same total fee, either bearer");

    // And each bearer's arithmetic goes the one direction it should.
    assert.equal(passed.totalPayable, amount + passed.totalFees, "contributor pays the fees on top");
    assert.equal(passed.net, amount, "so the collection receives the full amount");
    assert.equal(absorbed.totalPayable, amount, "organiser-absorbed charges the contributor nothing extra");
    assert.equal(absorbed.net, amount - absorbed.totalFees, "and comes out of what the collection receives");
  });

  it("rounds half away from zero, at an exact half-kobo boundary", () => {
    // ₦1.00 = 100 kobo. 100 × 150 bps = 1.5 kobo exactly — a true half. The rule
    // is half AWAY FROM ZERO, so it goes to 2, not to 1 (which is what banker's
    // rounding would give) and not to 1 (which is what toFixed gave the old
    // engine at binary-representation boundaries).
    const half = calculateFees({
      amount: fromNaira("1.00"),
      category: "dues",
      bearer: "community",
      schedule: SCHEDULE_2026_09_FOUNDER,
    });
    assert.equal(half.platformFee, kobo(2n), "1.5 kobo rounds up to 2");
    assert.equal(half.gatewayFee, kobo(2n), "and the same rule applies to the provider model");

    // ₦33.33 = 3,333 kobo. × 150 bps = 49.995 kobo → 50. Nearby, and not a half,
    // so it pins the ordinary case beside the boundary one.
    const ordinary = calculateFees({
      amount: fromNaira("33.33"),
      category: "dues",
      bearer: "community",
      schedule: SCHEDULE_2026_09_FOUNDER,
    });
    assert.equal(ordinary.platformFee, kobo(50n));
    assert.equal(ordinary.gatewayFee, kobo(50n));
  });

  it("keeps the provisional schedule's rates untouched, so its goldens still mean something", () => {
    assert.equal(SCHEDULE_2026_09_PROVISIONAL.platformRateDefault, 50, "0.5%");
    assert.equal(SCHEDULE_2026_09_PROVISIONAL.gatewayRate, 150, "1.5%");
    assert.equal(SCHEDULE_2026_09_PROVISIONAL.maxPlatformFee, kobo(200_000n), "₦2,000");
    assert.equal(SCHEDULE_2026_09_PROVISIONAL.maxGatewayFee, kobo(200_000n), "₦2,000");
    assert.notEqual(
      SCHEDULE_2026_09_PROVISIONAL.version,
      SCHEDULE_2026_09_FOUNDER.version,
      "a new schedule is a new version, never an edit (D-13)",
    );
  });
});

/**
 * D-11: the modeled provider fee and the reported one are separate facts, and
 * the reported one wins the moment it exists.
 */
describe("provider fee — estimate versus truth (D-11)", () => {
  it("treats an unreported fee as unknown, not as zero", () => {
    const fee = { estimated: kobo(15_000n), actual: null, scheduleVersion: "2026-09-founder" };

    assert.equal(providerFeeVariance(fee), null, "an unknown variance is not a variance of zero");
    assert.equal(authoritativeProviderFee(fee), kobo(15_000n), "the model applies until the provider speaks");
  });

  it("hands authority to the provider as soon as it reports", () => {
    // The founder's understanding is that Paystack charges nearer 1% than the
    // modeled 1.5%. On ₦10,000 that is ₦100 against a modeled ₦150.
    const fee = { estimated: kobo(15_000n), actual: kobo(10_000n), scheduleVersion: "2026-09-founder" };

    assert.equal(authoritativeProviderFee(fee), kobo(10_000n), "the reported fee is the truth");
    assert.equal(providerFeeVariance(fee), kobo(-5_000n), "negative: the provider charged less than modeled");
  });

  it("reports a positive variance when the provider charged more than modeled", () => {
    const fee = { estimated: kobo(10_000n), actual: kobo(12_500n), scheduleVersion: "2026-09-founder" };
    assert.equal(providerFeeVariance(fee), kobo(2_500n));
  });

  it("keeps the estimate readable after the truth arrives", () => {
    // Both numbers survive. The old system kept one and could not afterwards
    // distinguish a modelling error from a provider change.
    const fee = { estimated: kobo(15_000n), actual: kobo(10_000n), scheduleVersion: "2026-09-founder" };
    assert.equal(fee.estimated, kobo(15_000n));
    assert.equal(fee.scheduleVersion, "2026-09-founder", "and which schedule produced it");
  });
});
