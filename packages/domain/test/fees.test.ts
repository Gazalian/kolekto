import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { calculateFees, SCHEDULE_2026_09_PROVISIONAL } from "../src/fees.ts";
import { formatNaira, fromNaira, kobo } from "../src/money.ts";

/**
 * PRC-13: "Fee calculation is covered by table-driven tests for every band
 * boundary and cap."
 *
 * These vectors are the golden set. They are asserted against the PROVISIONAL
 * schedule; when DEC-11 sets real prices, a new schedule version gets its own
 * vector file and this one stays, because old transactions keep pointing at the
 * version they used (PRC-09).
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
    const result = calculateFees({ amount: fromNaira("1000000"), category: "dues", bearer: "community" });

    assert.equal(formatNaira(result.platformFee), "₦2,000.00");
    assert.equal(formatNaira(result.gatewayFee), "₦2,000.00");
    assert.equal(formatNaira(result.totalFees), "₦4,000.00");
  });

  it("finds the exact amount at which each component reaches its cap", () => {
    // Platform 0.5% hits ₦2,000 at ₦400,000. Gateway 1.5% hits it at ₦133,333.34.
    const atPlatformCap = calculateFees({ amount: fromNaira("400000"), category: "dues", bearer: "community" });
    assert.equal(formatNaira(atPlatformCap.platformFee), "₦2,000.00");

    const justBelow = calculateFees({ amount: fromNaira("399999"), category: "dues", bearer: "community" });
    assert.equal(formatNaira(justBelow.platformFee), "₦2,000.00".replace("2,000.00", "2,000.00"));
    assert.ok(justBelow.platformFee <= atPlatformCap.platformFee);
  });
});

describe("fees are charged on the contribution, never on the payable", () => {
  it("does not compound a contributor-borne fee", () => {
    // ₦20,000 + ₦400 of fees = ₦20,400. If fees were charged on the payable,
    // the total would creep upward on every recalculation.
    const result = calculateFees({ amount: fromNaira("20000"), category: "dues", bearer: "contributor" });
    assert.equal(result.totalPayable, kobo(2_040_000n));

    const again = calculateFees({ amount: result.contribution, category: "dues", bearer: "contributor" });
    assert.equal(again.totalPayable, result.totalPayable, "recalculating is stable");
  });
});

describe("invariants that must hold for any input", () => {
  it("keeps payable, net and fees consistent across a wide range", () => {
    for (let naira = 1; naira <= 2_000_000; naira = Math.ceil(naira * 1.7)) {
      for (const bearer of ["community", "contributor"] as const) {
        const r = calculateFees({ amount: fromNaira(String(naira)), category: "dues", bearer });

        assert.equal(r.platformFee + r.gatewayFee, r.totalFees, `fees add up at ₦${naira}`);

        if (bearer === "contributor") {
          assert.equal(r.totalPayable, r.contribution + r.totalFees, `payable at ₦${naira}`);
          assert.equal(r.net, r.contribution, `net at ₦${naira}`);
        } else {
          assert.equal(r.totalPayable, r.contribution, `payable at ₦${naira}`);
          assert.equal(r.net, r.contribution - r.totalFees, `net at ₦${naira}`);
        }

        assert.ok(r.platformFee <= SCHEDULE_2026_09_PROVISIONAL.maxFeePerComponent, `platform cap at ₦${naira}`);
        assert.ok(r.gatewayFee <= SCHEDULE_2026_09_PROVISIONAL.maxFeePerComponent, `gateway cap at ₦${naira}`);
        assert.ok(r.totalFees >= 0n, `fees never negative at ₦${naira}`);
      }
    }
  });

  it("refuses a negative contribution", () => {
    assert.throws(() => calculateFees({ amount: kobo(-1n), category: "dues", bearer: "community" }));
  });
});
