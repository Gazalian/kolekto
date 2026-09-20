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

describe("item collections", () => {
  const ITEM_BLUE = "01930000-0000-7000-8000-000000000011";
  const ITEM_GOLD = "01930000-0000-7000-8000-000000000012";

  const ordering = config({
    amountModel: "items",
    items: [
      // Both called "Aso-ebi" on purpose, for the reason the tier tests give.
      { id: ITEM_BLUE, name: "Aso-ebi", priceKobo: kobo(3_500_000), quantityAvailable: 4, maxPerOrder: 2 },
      { id: ITEM_GOLD, name: "Aso-ebi", priceKobo: kobo(5_000_000), quantityAvailable: null, maxPerOrder: null },
    ],
  });

  it("resolves by ID, not by name, and multiplies by the quantity", () => {
    const resolved = resolveContributionAmount(ordering, { itemId: ITEM_GOLD, quantity: 3 });

    assert.equal(resolved.amountKobo, 15_000_000n);
    assert.equal(resolved.itemId, ITEM_GOLD);
    assert.equal(resolved.quantity, 3);
  });

  it("treats a missing quantity as one rather than as none", () => {
    assert.equal(resolveContributionAmount(ordering, { itemId: ITEM_BLUE }).amountKobo, 3_500_000n);
  });

  it("refuses an item that is not this collection's", () => {
    assert.throws(
      () => resolveContributionAmount(ordering, { itemId: TIER_VIP }),
      (error: unknown) => error instanceof ContributionError && error.code === "UNKNOWN_ITEM",
    );
  });

  it("refuses an order with no item chosen", () => {
    assert.throws(
      () => resolveContributionAmount(ordering, {}),
      (error: unknown) => error instanceof ContributionError && error.code === "ITEM_REQUIRED",
    );
  });

  it("refuses a quantity that is not a whole number above zero", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => resolveContributionAmount(ordering, { itemId: ITEM_BLUE, quantity }),
        (error: unknown) => error instanceof ContributionError && error.code === "INVALID_QUANTITY",
      );
    }
  });

  it("refuses more than one person may take, and more than exist", () => {
    assert.throws(
      () => resolveContributionAmount(ordering, { itemId: ITEM_BLUE, quantity: 3 }),
      (error: unknown) => error instanceof ContributionError && error.code === "QUANTITY_ABOVE_LIMIT",
    );

    const scarce = config({
      amountModel: "items",
      items: [{ id: ITEM_BLUE, name: "Aso-ebi", priceKobo: kobo(100), quantityAvailable: 1, maxPerOrder: null }],
    });
    assert.throws(
      () => resolveContributionAmount(scarce, { itemId: ITEM_BLUE, quantity: 2 }),
      (error: unknown) => error instanceof ContributionError && error.code === "QUANTITY_ABOVE_LIMIT",
    );
  });
});

describe("per-member collections", () => {
  const OBLIGATION = "01930000-0000-7000-8000-000000000021";

  it("cannot be paid by a stranger — each member's amount is on their own obligation", () => {
    assert.throws(
      () => resolveContributionAmount(config({ amountModel: "per_member" }), { amountKobo: kobo(500_000) }),
      (error: unknown) => error instanceof ContributionError && error.code === "MEMBER_REQUIRED",
    );
  });

  it("charges an identified member what their obligation says, not what they sent", () => {
    const resolved = resolveContributionAmount(
      config({
        amountModel: "per_member",
        obligation: {
          id: OBLIGATION,
          expectedAmountKobo: kobo(750_000),
          waivedAmountKobo: kobo(0),
          status: "unpaid",
        },
      }),
      { amountKobo: kobo(100) },
    );

    assert.equal(resolved.amountKobo, 750_000n);
  });

  it("subtracts a waiver, because the community already forgave that part", () => {
    const resolved = resolveContributionAmount(
      config({
        amountModel: "per_member",
        obligation: {
          id: OBLIGATION,
          expectedAmountKobo: kobo(750_000),
          waivedAmountKobo: kobo(250_000),
          status: "unpaid",
        },
      }),
      {},
    );

    assert.equal(resolved.amountKobo, 500_000n);
  });

  it("refuses to charge an exempt member anything at all", () => {
    assert.throws(
      () =>
        resolveContributionAmount(
          config({
            amountModel: "per_member",
            obligation: {
              id: OBLIGATION,
              expectedAmountKobo: kobo(750_000),
              waivedAmountKobo: kobo(0),
              status: "exempt",
            },
          }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "OBLIGATION_EXEMPT",
    );
  });

  it("refuses when the whole balance was waived", () => {
    assert.throws(
      () =>
        resolveContributionAmount(
          config({
            amountModel: "per_member",
            obligation: {
              id: OBLIGATION,
              expectedAmountKobo: kobo(750_000),
              waivedAmountKobo: kobo(750_000),
              status: "unpaid",
            },
          }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "NOTHING_OWED",
    );
  });
});

describe("a fixed collection with an identified member", () => {
  it("prefers that member's obligation over the headline amount", () => {
    // The collection asks ₦5,000; this member was granted a ₦2,000 waiver.
    // Charging the headline would be charging them for a waiver they hold.
    const resolved = resolveContributionAmount(
      config({
        amountModel: "fixed",
        fixedAmountKobo: kobo(500_000),
        obligation: {
          id: "01930000-0000-7000-8000-000000000022",
          expectedAmountKobo: kobo(500_000),
          waivedAmountKobo: kobo(200_000),
          status: "unpaid",
        },
      }),
      {},
    );

    assert.equal(resolved.amountKobo, 300_000n);
  });
});
