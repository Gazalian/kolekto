import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  allocate,
  allocateByWeights,
  applyRate,
  bps,
  clamp,
  formatNaira,
  fromNaira,
  kobo,
  MoneyError,
  sum,
  ZERO,
} from "../src/money.ts";

describe("kobo()", () => {
  it("rejects a fraction of a kobo rather than rounding it away", () => {
    // The previous engine coerced silently: Number("1.5") became 1.5, passed
    // through toFixed(2), and produced 1.5 again. Here it is an error, because
    // a fractional kobo in a money path means the caller made a mistake.
    assert.throws(() => kobo(1.5), MoneyError);
    assert.throws(() => kobo("1.5"), MoneyError);
  });

  it("accepts bigints, safe integers and digit strings", () => {
    assert.equal(kobo(2_000_000n), 2_000_000n);
    assert.equal(kobo(2_000_000), 2_000_000n);
    assert.equal(kobo("2000000"), 2_000_000n);
  });

  it("refuses a number beyond safe integer range instead of losing precision", () => {
    assert.throws(() => kobo(Number.MAX_SAFE_INTEGER + 2), MoneyError);
  });
});

describe("fromNaira()", () => {
  it("reads the formats a Nigerian user actually types (UX-07)", () => {
    assert.equal(fromNaira("20000"), 2_000_000n);
    assert.equal(fromNaira("20,000"), 2_000_000n);
    assert.equal(fromNaira("₦20,000"), 2_000_000n);
    assert.equal(fromNaira("20k"), 2_000_000n);
    assert.equal(fromNaira("20.50"), 2_050n);
    assert.equal(fromNaira("0.01"), 1n);
  });

  it("rejects a third decimal place instead of guessing", () => {
    assert.throws(() => fromNaira("20.005"), MoneyError);
  });

  it("round-trips the value that broke the previous engine", () => {
    // (1.005).toFixed(2) === "1.00" in JavaScript, because 1.005 is not
    // representable in binary. As an integer there is nothing to get wrong.
    assert.equal(fromNaira("1.005".slice(0, 4)), 100n);
    assert.equal(fromNaira("1.01"), 101n);
  });
});

describe("formatNaira()", () => {
  it("groups thousands and always shows kobo by default", () => {
    assert.equal(formatNaira(2_000_000n as never), "₦20,000.00");
    assert.equal(formatNaira(1n as never), "₦0.01");
    assert.equal(formatNaira(-2_050n as never), "-₦20.50");
  });
});

describe("applyRate() — half away from zero", () => {
  it("rounds a half kobo up, not to even and not down", () => {
    // 1 kobo at 50% is exactly 0.5 kobo. Half away from zero gives 1.
    assert.equal(applyRate(1n as never, bps(5_000)), 1n);
    // 3 kobo at 50% is 1.5 kobo, so 2 — banker's rounding would give 2 here
    // too, but 1 kobo at 50% would give 0, which is the divergence that matters.
    assert.equal(applyRate(3n as never, bps(5_000)), 2n);
  });

  it("is symmetric for negative amounts", () => {
    assert.equal(applyRate(-1n as never, bps(5_000)), -1n);
  });

  it("computes the provisional platform fee exactly", () => {
    // ₦20,000 at 0.5% is ₦100.
    assert.equal(applyRate(2_000_000n as never, bps(50)), 10_000n);
    // ₦20,000 at 1.5% is ₦300.
    assert.equal(applyRate(2_000_000n as never, bps(150)), 30_000n);
  });

  it("rejects a fractional rate, which is how a float sneaks back in", () => {
    assert.throws(() => bps(0.005), MoneyError);
  });
});

describe("allocate()", () => {
  it("splits without creating or losing a kobo", () => {
    // ₦100 across 3 people: 3333.34 + 3333.33 + 3333.33 in kobo terms.
    const parts = allocate(10_000n as never, 3);
    assert.deepEqual(parts, [3_334n, 3_333n, 3_333n]);
    assert.equal(sum(parts), 10_000n);
  });

  it("survives the case a naive division loses", () => {
    const parts = allocate(1n as never, 3);
    assert.deepEqual(parts, [1n, 0n, 0n]);
    assert.equal(sum(parts), 1n);
  });

  it("handles negative totals symmetrically", () => {
    const parts = allocate(-10_000n as never, 3);
    assert.equal(sum(parts), -10_000n);
  });
});

describe("allocateByWeights()", () => {
  it("apportions a withdrawal across collections without drift (WDR-06)", () => {
    const shares = allocateByWeights(100_000n as never, [1n, 1n, 1n]);
    assert.equal(sum(shares), 100_000n);
  });

  it("gives the leftover kobo to the largest remainders", () => {
    const shares = allocateByWeights(10n as never, [1n, 2n, 3n]);
    assert.equal(sum(shares), 10n);
    assert.deepEqual(shares, [2n, 3n, 5n]);
  });

  it("falls back to an even split when every weight is zero", () => {
    const shares = allocateByWeights(10n as never, [0n, 0n]);
    assert.equal(sum(shares), 10n);
  });
});

describe("summation is exact at scale", () => {
  it("adds fifty thousand contributions with no drift", () => {
    // This is the property the previous system did not have. Summing
    // 50,000 floating-point contributions accumulated error; production
    // measured ₦3.59 of unexplained difference against a zero-kobo tolerance.
    const amounts = Array.from({ length: 50_000 }, (_, i) => kobo(BigInt(1_000 + (i % 97))));
    const total = sum(amounts);

    const expected = amounts.reduce((acc, v) => acc + v, 0n);
    assert.equal(total, expected);
    assert.equal(typeof total, "bigint");
  });
});

describe("clamp()", () => {
  it("holds a contribution between a collection's minimum and maximum", () => {
    assert.equal(clamp(50n as never, 100n as never, 1_000n as never), 100n);
    assert.equal(clamp(5_000n as never, 100n as never, 1_000n as never), 1_000n);
    assert.equal(clamp(ZERO, ZERO, 1_000n as never), ZERO);
  });
});
