import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  amountWholeDigits,
  canonicalAmount,
  formatAmountDisplay,
  formatAmountInput,
  nairaInputFromKobo,
} from "../src/amount-input.ts";
import { fromNaira } from "../src/money.ts";

describe("canonicalAmount()", () => {
  it("keeps digits and one point, with at most two decimals", () => {
    assert.equal(canonicalAmount("1000"), "1000");
    assert.equal(canonicalAmount("1,234,567"), "1234567");
    assert.equal(canonicalAmount("₦1,234,567.89"), "1234567.89");
    assert.equal(canonicalAmount("1 234 567"), "1234567");
    assert.equal(canonicalAmount("1234.567"), "1234.56");
    assert.equal(canonicalAmount("12.3.4"), "12.34");
  });

  it("drops letters and minus signs rather than guessing", () => {
    assert.equal(canonicalAmount("-5000"), "5000");
    assert.equal(canonicalAmount("abc"), "");
    assert.equal(canonicalAmount("5a0b0"), "500");
  });

  it("strips leading zeros but keeps a lone zero and a typed point", () => {
    assert.equal(canonicalAmount("0012"), "12");
    assert.equal(canonicalAmount("000"), "0");
    assert.equal(canonicalAmount("."), "0.");
    assert.equal(canonicalAmount(".5"), "0.5");
    assert.equal(canonicalAmount("12."), "12.");
  });

  it("expands the k shorthand by moving the point, never by floating point", () => {
    assert.equal(canonicalAmount("5k"), "5000");
    assert.equal(canonicalAmount("5K"), "5000");
    assert.equal(canonicalAmount("1.5k"), "1500");
    assert.equal(canonicalAmount("₦2.25k"), "2250");
    assert.equal(canonicalAmount("1.23456k"), "1234.56");
    assert.equal(canonicalAmount("k"), "");
  });

  it("produces exactly the kobo fromNaira would have read from the raw text", () => {
    for (const raw of ["20000", "20,000", "₦20,000.50", "5k", "1.5k", "0.75", "1,234,567.89"]) {
      assert.equal(fromNaira(canonicalAmount(raw)), fromNaira(raw), raw);
    }
  });
});

describe("formatAmountDisplay()", () => {
  it("groups whole naira in threes", () => {
    assert.equal(formatAmountDisplay("1000"), "1,000");
    assert.equal(formatAmountDisplay("1234567"), "1,234,567");
    assert.equal(formatAmountDisplay("999"), "999");
    assert.equal(formatAmountDisplay("1234.5"), "1,234.5");
    assert.equal(formatAmountDisplay("1234."), "1,234.");
    assert.equal(formatAmountDisplay(""), "");
  });

  it("always yields text the server's amount pattern accepts", () => {
    const NAIRA_PATTERN = /^₦?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?k?$/i;
    for (const value of ["1", "12", "1234", "1234567", "1234567.5", "100000000000000"]) {
      assert.match(formatAmountDisplay(value), NAIRA_PATTERN, value);
    }
  });
});

describe("formatAmountInput() keeps the cursor beside what was typed", () => {
  it("leaves the cursor at the end when typing at the end", () => {
    assert.deepEqual(formatAmountInput("1000", 4), { value: "1000", display: "1,000", caret: 5 });
    assert.deepEqual(formatAmountInput("1,0000", 6), { value: "10000", display: "10,000", caret: 6 });
  });

  it("keeps the cursor after a digit inserted in the middle", () => {
    // "1,000" with the cursor after the 1, then "2" typed.
    assert.deepEqual(formatAmountInput("12,000", 2), { value: "12000", display: "12,000", caret: 2 });
    // "1,000" with the cursor after the comma, then "5" typed.
    assert.deepEqual(formatAmountInput("1,5000", 3), { value: "15000", display: "15,000", caret: 2 });
  });

  it("keeps the cursor in place when a separator disappears", () => {
    // "10,000" → delete the 1 → ",000" with the cursor at 0.
    assert.deepEqual(formatAmountInput("0,000", 0), { value: "0", display: "0", caret: 0 });
    // "1,234" → delete the 2 → "1,34" with the cursor after the comma.
    assert.deepEqual(formatAmountInput("1,34", 2), { value: "134", display: "134", caret: 1 });
  });

  it("ignores a character that is not part of an amount", () => {
    // "1,000" with the cursor at the end, then "x" typed.
    assert.deepEqual(formatAmountInput("1,000x", 6), { value: "1000", display: "1,000", caret: 5 });
  });

  it("handles a leading point and a third decimal", () => {
    assert.deepEqual(formatAmountInput(".", 1), { value: "0.", display: "0.", caret: 2 });
    assert.deepEqual(formatAmountInput("1.234", 5), { value: "1.23", display: "1.23", caret: 4 });
  });

  it("moves the cursor to the end after expanding k", () => {
    assert.deepEqual(formatAmountInput("25k", 3), { value: "25000", display: "25,000", caret: 6 });
  });
});

describe("amountWholeDigits()", () => {
  it("counts only the naira digits", () => {
    assert.equal(amountWholeDigits("1234567.89"), 7);
    assert.equal(amountWholeDigits(""), 0);
  });
});

describe("nairaInputFromKobo()", () => {
  it("never loses the kobo", () => {
    assert.equal(nairaInputFromKobo(500050), "5000.50");
    assert.equal(nairaInputFromKobo(500005), "5000.05");
    assert.equal(nairaInputFromKobo(500000), "5000");
    assert.equal(nairaInputFromKobo(99), "0.99");
    assert.equal(nairaInputFromKobo(12_345_678_901_234n), "123456789012.34");
  });

  it("round-trips through fromNaira", () => {
    for (const kobo of [1, 99, 100, 500050, 2_000_000, 123_456_789]) {
      assert.equal(fromNaira(nairaInputFromKobo(kobo)), BigInt(kobo));
    }
  });

  it("leaves an absent amount empty", () => {
    assert.equal(nairaInputFromKobo(null), "");
    assert.equal(nairaInputFromKobo(undefined), "");
  });
});
