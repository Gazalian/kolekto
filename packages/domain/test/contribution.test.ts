import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type ContributionConfig,
  ContributionError,
  type ItemSelectionLine,
  resolveContributionAmount,
  type TierSelectionLine,
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
      { id: TIER_STANDARD, name: "Standard", priceKobo: kobo(500_000), quantityLimit: null, perOrderLimit: null },
      { id: TIER_VIP, name: "Standard", priceKobo: kobo(2_000_000), quantityLimit: null, perOrderLimit: null },
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

describe("a ticketed event's tier basket — several options, each with a quantity", () => {
  const REGULAR = "01930000-0000-7000-8000-000000000031";
  const VIP = "01930000-0000-7000-8000-000000000032";

  const tickets = config({
    amountModel: "tiers",
    tiers: [
      { id: REGULAR, name: "Regular", priceKobo: kobo(1_000_000), quantityLimit: null, perOrderLimit: null },
      { id: VIP, name: "VIP", priceKobo: kobo(2_500_000), quantityLimit: 5, perOrderLimit: 3 },
    ],
  });

  function order(lines: TierSelectionLine[]) {
    return resolveContributionAmount(tickets, { tierSelections: lines });
  }

  it("sums VIP × 2 and Regular × 1 into one total, never from the browser", () => {
    const resolved = order([
      { tierId: VIP, quantity: 2 },
      { tierId: REGULAR, quantity: 1 },
    ]);

    // 2 × ₦25,000 + 1 × ₦10,000
    assert.equal(resolved.amountKobo, 6_000_000n);
    assert.equal(resolved.tierId, null); // more than one line — no single answer
    assert.equal(resolved.lines?.length, 2);
    assert.equal(resolved.lines?.find((line) => line.tierId === VIP)?.amountKobo, 5_000_000n);
    assert.equal(resolved.lines?.find((line) => line.tierId === REGULAR)?.amountKobo, 1_000_000n);
  });

  it("resolves a single-line basket the same as the plain single-choice shape", () => {
    const resolved = order([{ tierId: REGULAR, quantity: 1 }]);
    assert.equal(resolved.amountKobo, 1_000_000n);
    assert.equal(resolved.tierId, REGULAR);
  });

  it("enforces a per-order limit per line", () => {
    assert.throws(
      () => order([{ tierId: VIP, quantity: 4 }]),
      (error: unknown) => error instanceof ContributionError && error.code === "TIER_QUANTITY_ABOVE_LIMIT",
    );
  });

  it("enforces the tier's own remaining quantity", () => {
    const scarce = config({
      amountModel: "tiers",
      tiers: [{ id: VIP, name: "VIP", priceKobo: kobo(2_500_000), quantityLimit: 2, perOrderLimit: null }],
    });
    assert.throws(
      () => resolveContributionAmount(scarce, { tierSelections: [{ tierId: VIP, quantity: 3 }] }),
      (error: unknown) => error instanceof ContributionError && error.code === "TIER_QUANTITY_ABOVE_LIMIT",
    );
  });

  it("refuses a non-whole or non-positive quantity", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => order([{ tierId: REGULAR, quantity }]),
        (error: unknown) => error instanceof ContributionError && error.code === "INVALID_TIER_QUANTITY",
      );
    }
  });

  it("refuses an empty basket", () => {
    assert.throws(
      () => order([]),
      (error: unknown) => error instanceof ContributionError && error.code === "TIER_REQUIRED",
    );
  });

  it("refuses a tier chosen twice rather than silently combining it", () => {
    assert.throws(
      () => order([{ tierId: REGULAR, quantity: 1 }, { tierId: REGULAR, quantity: 2 }]),
      (error: unknown) => error instanceof ContributionError && error.code === "UNKNOWN_TIER",
    );
  });

  it("refuses an option that does not belong to this collection", () => {
    assert.throws(
      () => order([{ tierId: "01930000-0000-7000-8000-00000000ffff", quantity: 1 }]),
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

describe("an item order with more than one line", () => {
  const BLUE = "01930000-0000-7000-8000-000000000041";
  const GOLD = "01930000-0000-7000-8000-000000000042";

  const catalog = config({
    amountModel: "items",
    items: [
      { id: BLUE, name: "Blue", priceKobo: kobo(3_500_000), quantityAvailable: 40, maxPerOrder: 4 },
      { id: GOLD, name: "Gold", priceKobo: kobo(5_000_000), quantityAvailable: null, maxPerOrder: null },
    ],
  });

  function order(lines: ItemSelectionLine[]) {
    return resolveContributionAmount(catalog, { itemSelections: lines });
  }

  it("sums two different items into one authoritative total", () => {
    const resolved = order([
      { itemId: BLUE, quantity: 2 },
      { itemId: GOLD, quantity: 4 },
    ]);

    // 2 × ₦35,000 + 4 × ₦50,000
    assert.equal(resolved.amountKobo, 27_000_000n);
    assert.equal(resolved.itemLines?.length, 2);
    assert.equal(resolved.itemLines?.find((line) => line.itemId === BLUE)?.amountKobo, 7_000_000n);
    assert.equal(resolved.itemLines?.find((line) => line.itemId === GOLD)?.amountKobo, 20_000_000n);
    // More than one line — there is no single item this order "is for".
    assert.equal(resolved.itemId, null);
  });

  it("still names the item when the basket holds exactly one line", () => {
    const resolved = order([{ itemId: GOLD, quantity: 3 }]);
    assert.equal(resolved.amountKobo, 15_000_000n);
    assert.equal(resolved.itemId, GOLD);
    assert.equal(resolved.quantity, 3);
  });

  it("enforces each line's own per-order limit", () => {
    assert.throws(
      () => order([{ itemId: BLUE, quantity: 5 }]),
      (error: unknown) => error instanceof ContributionError && error.code === "QUANTITY_ABOVE_LIMIT",
    );
  });

  it("enforces each line's own remaining stock", () => {
    const scarce = config({
      amountModel: "items",
      items: [{ id: BLUE, name: "Blue", priceKobo: kobo(100), quantityAvailable: 1, maxPerOrder: null }],
    });
    assert.throws(
      () => resolveContributionAmount(scarce, { itemSelections: [{ itemId: BLUE, quantity: 2 }] }),
      (error: unknown) => error instanceof ContributionError && error.code === "QUANTITY_ABOVE_LIMIT",
    );
  });

  it("refuses a non-whole or non-positive quantity on any line", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => order([{ itemId: GOLD, quantity }]),
        (error: unknown) => error instanceof ContributionError && error.code === "INVALID_QUANTITY",
      );
    }
  });

  it("refuses an item chosen twice rather than silently combining it", () => {
    assert.throws(
      () => order([{ itemId: GOLD, quantity: 1 }, { itemId: GOLD, quantity: 2 }]),
      (error: unknown) => error instanceof ContributionError && error.code === "UNKNOWN_ITEM",
    );
  });

  it("refuses an item that does not belong to this collection", () => {
    assert.throws(
      () => order([{ itemId: "01930000-0000-7000-8000-00000000ffff", quantity: 1 }]),
      (error: unknown) => error instanceof ContributionError && error.code === "UNKNOWN_ITEM",
    );
  });

  it("refuses an empty basket", () => {
    assert.throws(
      () => order([]),
      (error: unknown) => error instanceof ContributionError && error.code === "ITEM_REQUIRED",
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

  it("refuses to charge a member whose obligation is already paid", () => {
    for (const amountModel of ["per_member", "fixed"] as const) {
      assert.throws(
        () =>
          resolveContributionAmount(
            config({
              amountModel,
              fixedAmountKobo: kobo(750_000),
              obligation: {
                id: OBLIGATION,
                expectedAmountKobo: kobo(750_000),
                waivedAmountKobo: kobo(0),
                status: "paid",
              },
            }),
            {},
          ),
        (error: unknown) => error instanceof ContributionError && error.code === "NOTHING_OWED",
      );
    }
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

// ── M8.3b resolver hardening ──────────────────────────────────────────────

describe("single-tier stock check (M8.3b)", () => {
  // The basket path already refuses a quantity above `quantityLimit`. The
  // single-tier path (quantity always 1) must still refuse `quantityLimit = 0`
  // — a sold-out tier is sold out whichever UI shape chose it.
  it("refuses a single-tier pick on a tier whose stock is exhausted", () => {
    const soldOut = config({
      amountModel: "tiers",
      tiers: [
        { id: TIER_STANDARD, name: "Standard", priceKobo: kobo(500_000), quantityLimit: 0, perOrderLimit: null },
      ],
    });
    assert.throws(
      () => resolveContributionAmount(soldOut, { tierId: TIER_STANDARD }),
      (error: unknown) =>
        error instanceof ContributionError &&
        error.code === "TIER_QUANTITY_ABOVE_LIMIT" &&
        /sold out/i.test(error.message),
    );
  });

  it("still allows a single-tier pick when stock remains (one unit for the one pick)", () => {
    const limitedButAvailable = config({
      amountModel: "tiers",
      tiers: [
        { id: TIER_STANDARD, name: "Standard", priceKobo: kobo(500_000), quantityLimit: 1, perOrderLimit: null },
      ],
    });
    const resolved = resolveContributionAmount(limitedButAvailable, { tierId: TIER_STANDARD });
    assert.equal(resolved.amountKobo, 500_000n);
  });

  it("leaves unlimited-stock tiers unchanged", () => {
    const unlimited = config({
      amountModel: "tiers",
      tiers: [
        { id: TIER_STANDARD, name: "Standard", priceKobo: kobo(500_000), quantityLimit: null, perOrderLimit: null },
      ],
    });
    const resolved = resolveContributionAmount(unlimited, { tierId: TIER_STANDARD });
    assert.equal(resolved.amountKobo, 500_000n);
  });
});

describe("amountOwed = expected − waived − applied (M8.3b)", () => {
  const obligationId = "01930000-0000-7000-8000-000000000031";

  it("subtracts already-applied contributions from what remains to pay", () => {
    // Expected ₦10,000, no waiver, ₦4,000 already paid → ₦6,000 left.
    const resolved = resolveContributionAmount(
      config({
        amountModel: "fixed",
        fixedAmountKobo: kobo(1_000_000),
        obligation: {
          id: obligationId,
          expectedAmountKobo: kobo(1_000_000),
          waivedAmountKobo: kobo(0),
          appliedKobo: kobo(400_000),
          status: "unpaid",
        },
      }),
      {},
    );
    assert.equal(resolved.amountKobo, 600_000n);
  });

  it("treats a missing `appliedKobo` as zero (backwards compatible)", () => {
    const resolved = resolveContributionAmount(
      config({
        amountModel: "fixed",
        fixedAmountKobo: kobo(1_000_000),
        obligation: {
          id: obligationId,
          expectedAmountKobo: kobo(1_000_000),
          waivedAmountKobo: kobo(0),
          status: "unpaid",
        },
      }),
      {},
    );
    assert.equal(resolved.amountKobo, 1_000_000n);
  });

  it("refuses NOTHING_OWED when applied has met the balance", () => {
    // The capture function should have flipped the obligation to `paid`, but
    // if it has not (audit §4.6 reconciliation gap) the resolver still
    // refuses rather than offering the full amount again.
    assert.throws(
      () =>
        resolveContributionAmount(
          config({
            amountModel: "fixed",
            obligation: {
              id: obligationId,
              expectedAmountKobo: kobo(500_000),
              waivedAmountKobo: kobo(0),
              appliedKobo: kobo(500_000),
              status: "unpaid",
            },
          }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "NOTHING_OWED",
    );
  });

  it("refuses MISCONFIGURED on a negative applied amount rather than inflating owed", () => {
    assert.throws(
      () =>
        resolveContributionAmount(
          config({
            amountModel: "fixed",
            obligation: {
              id: obligationId,
              expectedAmountKobo: kobo(500_000),
              waivedAmountKobo: kobo(0),
              appliedKobo: kobo(-100) as unknown as ReturnType<typeof kobo>,
              status: "unpaid",
            },
          }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "MISCONFIGURED",
    );
  });
});

describe("obligation status mapping (M8.3b)", () => {
  const obligationId = "01930000-0000-7000-8000-000000000041";
  const base = {
    id: obligationId,
    expectedAmountKobo: kobo(500_000),
    waivedAmountKobo: kobo(0),
  } as const;

  it("accepts `unpaid`", () => {
    const resolved = resolveContributionAmount(
      config({ amountModel: "fixed", obligation: { ...base, status: "unpaid" } }),
      {},
    );
    assert.equal(resolved.amountKobo, 500_000n);
  });

  it("accepts `overdue` — a late payment is still accepted, the window check is separate", () => {
    const resolved = resolveContributionAmount(
      config({ amountModel: "fixed", obligation: { ...base, status: "overdue" } }),
      {},
    );
    assert.equal(resolved.amountKobo, 500_000n);
  });

  it("refuses `in_installments` with the specific code — partial payments are deferred (D-19)", () => {
    assert.throws(
      () =>
        resolveContributionAmount(
          config({ amountModel: "fixed", obligation: { ...base, status: "in_installments" } }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "INSTALLMENTS_NOT_SUPPORTED",
    );
  });

  it("refuses `exempt` with OBLIGATION_EXEMPT", () => {
    assert.throws(
      () =>
        resolveContributionAmount(
          config({ amountModel: "fixed", obligation: { ...base, status: "exempt" } }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "OBLIGATION_EXEMPT",
    );
  });

  it("refuses `cancelled` with NOTHING_OWED", () => {
    assert.throws(
      () =>
        resolveContributionAmount(
          config({ amountModel: "fixed", obligation: { ...base, status: "cancelled" } }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "NOTHING_OWED",
    );
  });

  it("refuses `paid` with NOTHING_OWED", () => {
    assert.throws(
      () =>
        resolveContributionAmount(
          config({ amountModel: "fixed", obligation: { ...base, status: "paid" } }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "NOTHING_OWED",
    );
  });
});

describe("the single-payment ceiling (M8.3b, §14.5)", () => {
  // MAX_PAYMENT_KOBO = 500_000_000 kobo = ₦5,000,000. The resolver refuses
  // anything above it regardless of which model produced the figure.

  it("accepts a payment exactly at the ceiling", () => {
    const resolved = resolveContributionAmount(
      config({ amountModel: "fixed", fixedAmountKobo: kobo(500_000_000) }),
      {},
    );
    assert.equal(resolved.amountKobo, 500_000_000n);
  });

  it("refuses a fixed collection whose headline exceeds the ceiling", () => {
    assert.throws(
      () =>
        resolveContributionAmount(
          config({ amountModel: "fixed", fixedAmountKobo: kobo(500_000_001) }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "PAYMENT_ABOVE_CEILING",
    );
  });

  it("refuses an open-amount submission above the ceiling", () => {
    assert.throws(
      () =>
        resolveContributionAmount(
          config({ amountModel: "open_amount", minAmountKobo: null, maxAmountKobo: null }),
          { amountKobo: kobo(600_000_000) },
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "PAYMENT_ABOVE_CEILING",
    );
  });

  it("refuses a tiered basket whose SUM exceeds the ceiling, even when each line is under it", () => {
    // Two tiers at ₦3,000,000 each, one line of each — ₦6,000,000 total.
    const expensive = config({
      amountModel: "tiers",
      tiers: [
        { id: TIER_STANDARD, name: "A", priceKobo: kobo(300_000_000), quantityLimit: null, perOrderLimit: null },
        { id: TIER_VIP, name: "B", priceKobo: kobo(300_000_000), quantityLimit: null, perOrderLimit: null },
      ],
    });
    const lines: TierSelectionLine[] = [
      { tierId: TIER_STANDARD, quantity: 1 },
      { tierId: TIER_VIP, quantity: 1 },
    ];
    assert.throws(
      () => resolveContributionAmount(expensive, { tierSelections: lines }),
      (error: unknown) => error instanceof ContributionError && error.code === "PAYMENT_ABOVE_CEILING",
    );
  });

  it("refuses an items order whose SUM exceeds the ceiling", () => {
    const ITEM = "01930000-0000-7000-8000-000000000051";
    const items = config({
      amountModel: "items",
      items: [{ id: ITEM, name: "Bulk order", priceKobo: kobo(100_000_000), quantityAvailable: null, maxPerOrder: null }],
    });
    const lines: ItemSelectionLine[] = [{ itemId: ITEM, quantity: 6 }];
    assert.throws(
      () => resolveContributionAmount(items, { itemSelections: lines }),
      (error: unknown) => error instanceof ContributionError && error.code === "PAYMENT_ABOVE_CEILING",
    );
  });

  it("refuses an obligation whose remaining balance exceeds the ceiling", () => {
    // A ₦6,000,000 obligation is not payable in one shot, by design.
    assert.throws(
      () =>
        resolveContributionAmount(
          config({
            amountModel: "fixed",
            obligation: {
              id: "01930000-0000-7000-8000-000000000061",
              expectedAmountKobo: kobo(600_000_000),
              waivedAmountKobo: kobo(0),
              status: "unpaid",
            },
          }),
          {},
        ),
      (error: unknown) => error instanceof ContributionError && error.code === "PAYMENT_ABOVE_CEILING",
    );
  });
});
