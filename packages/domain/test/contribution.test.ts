import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type ContributionConfig,
  ContributionError,
  resolveContributionAmount,
} from "../src/contribution.ts";
import { kobo } from "../src/money.ts";

const TIER_STANDARD = "01930000-0000-7000-8000-000000000001";
const TIER_VIP = "01930000-0000-7000-8000-000000000002";

function config(overrides: Partial<ContributionConfig>): ContributionConfig {
  return {
    amountModel: "fixed",
    fixedAmountKobo: null,
    minAmountKobo: null,
    maxAmountKobo: null,
    tiers: [],
    ...overrides,
  };
}

describe("fixed collections", () => {
  it("charges the collection's amount, whatever the browser sent", () => {
    const resolved = resolveContributionAmount(
      config({ amountModel: "fixed", fixedAmountKobo: kobo(500_000) }),
      { amountKobo: kobo(100) },
    );

    assert.equal(resolved.amountKobo, 500_000n);
    assert.equal(resolved.tierId, null);
  });

  it("refuses a collection with no amount set rather than charging zero", () => {
    assert.throws(
      () => resolveContributionAmount(config({ amountModel: "fixed", fixedAmountKobo: null }), {}),
      (error: unknown) => error instanceof ContributionError && error.code === "MISCONFIGURED",
    );
  });
});

describe("tiered collections", () => {
  const tiered = config({
    amountModel: "tiers",
    tiers: [
      { id: TIER_STANDARD, name: "Standard", priceKobo: kobo(500_000) },
      { id: TIER_VIP, name: "Standard", priceKobo: kobo(2_000_000) },
    ],
  });

  it("resolves by ID even when two options share a display name (the 2026-08-06 incident)", () => {
    // Both tiers here are called "Standard" on purpose. The previous system's
    // `.find()` matched on ID *or* name and charged the first one for both.
    const resolved = resolveContributionAmount(tiered, { tierId: TIER_VIP });

    assert.equal(resolved.amountKobo, 2_000_000n);
    assert.equal(resolved.tierId, TIER_VIP);
  });

  it("never takes a price from the browser", () => {
    const resolved = resolveContributionAmount(tiered, { tierId: TIER_STANDARD, amountKobo: kobo(1) });

    assert.equal(resolved.amountKobo, 500_000n);
  });

  it("requires a choice", () => {
    assert.throws(
      () => resolveContributionAmount(tiered, {}),
      (error: unknown) => error instanceof ContributionError && error.code === "TIER_REQUIRED",
    );
  });

  it("refuses an option that does not belong to this collection", () => {
    assert.throws(
      () => resolveContributionAmount(tiered, { tierId: "01930000-0000-7000-8000-00000000ffff" }),
      (error: unknown) => error instanceof ContributionError && error.code === "UNKNOWN_TIER",
    );
  });
});

describe("open-amount collections", () => {
  const open = config({
    amountModel: "open_amount",
    minAmountKobo: kobo(100_000),
    maxAmountKobo: kobo(10_000_000),
  });

  it("accepts an amount inside the range", () => {
    assert.equal(resolveContributionAmount(open, { amountKobo: kobo(250_000) }).amountKobo, 250_000n);
  });

  it("accepts the boundaries themselves", () => {
    assert.equal(resolveContributionAmount(open, { amountKobo: kobo(100_000) }).amountKobo, 100_000n);
    assert.equal(resolveContributionAmount(open, { amountKobo: kobo(10_000_000) }).amountKobo, 10_000_000n);
  });

  it("rejects an amount below the minimum and above the maximum", () => {
    assert.throws(
      () => resolveContributionAmount(open, { amountKobo: kobo(99_999) }),
      (error: unknown) => error instanceof ContributionError && error.code === "AMOUNT_BELOW_MINIMUM",
    );
    assert.throws(
      () => resolveContributionAmount(open, { amountKobo: kobo(10_000_001) }),
      (error: unknown) => error instanceof ContributionError && error.code === "AMOUNT_ABOVE_MAXIMUM",
    );
  });

  it("rejects zero, a negative amount and a missing one", () => {
    for (const selection of [{ amountKobo: kobo(0) }, { amountKobo: kobo(-500) }, {}]) {
      assert.throws(
        () => resolveContributionAmount(open, selection),
        (error: unknown) => error instanceof ContributionError && error.code === "AMOUNT_REQUIRED",
      );
    }
  });

  it("applies no range when the collection sets none", () => {
    const unbounded = config({ amountModel: "open_amount" });
    assert.equal(resolveContributionAmount(unbounded, { amountKobo: kobo(1) }).amountKobo, 1n);
  });
});

describe("per-member collections", () => {
  it("cannot be paid from the public page — each member's amount is on their obligation", () => {
    assert.throws(
      () => resolveContributionAmount(config({ amountModel: "per_member" }), { amountKobo: kobo(500_000) }),
      (error: unknown) => error instanceof ContributionError && error.code === "NOT_OPEN_TO_CONTRIBUTORS",
    );
  });
});
