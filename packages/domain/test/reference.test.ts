import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatReference,
  isValidCollectionPrefix,
  isValidTierPrefix,
  normalisePrefix,
  referenceExample,
} from "../src/reference.ts";

/**
 * These vectors are the same ones supabase/tests/16_contributor_references.sql
 * asserts against app.build_contributor_reference. Two implementations of one
 * format only stay honest if both are pinned to the same examples.
 */
describe("formatReference", () => {
  it("pads to the configured width", () => {
    assert.equal(formatReference({ prefix: "BIO26", separator: "-", digits: 4 }, 7), "BIO26-0007");
    assert.equal(formatReference({ prefix: "REG", separator: "-", digits: 4 }, 1), "REG-0001");
  });

  it("grows rather than truncating once the number outgrows the padding", () => {
    // The failure this pins: `lpad('12345', 4, '0')` in Postgres — and
    // `"12345".slice(-4)` in a careless JavaScript port — both return "1234",
    // which the 1,234th member already holds.
    assert.equal(formatReference({ prefix: "BIO26", separator: "-", digits: 4 }, 12345), "BIO26-12345");
    assert.equal(formatReference({ prefix: "A", separator: "", digits: 1 }, 99), "A99");
  });

  it("honours each separator, including none at all", () => {
    assert.equal(formatReference({ prefix: "DIN", separator: "/", digits: 3 }, 5), "DIN/005");
    assert.equal(formatReference({ prefix: "DIN", separator: ".", digits: 3 }, 5), "DIN.005");
    assert.equal(formatReference({ prefix: "DIN", separator: "", digits: 3 }, 5), "DIN005");
  });

  it("clamps an impossible digit count instead of producing nonsense", () => {
    assert.equal(formatReference({ prefix: "X1", separator: "-", digits: 0 }, 3), "X1-3");
    assert.equal(formatReference({ prefix: "X1", separator: "-", digits: 99 }, 3), "X1-00000003");
  });
});

describe("referenceExample", () => {
  it("shows the first reference the collection will issue", () => {
    assert.equal(referenceExample({ prefix: "BIO26", separator: "-", digits: 4 }, 1), "BIO26-0001");
    assert.equal(referenceExample({ prefix: "BIO26", separator: "-", digits: 4 }, 250), "BIO26-0250");
  });

  it("shows nothing at all until there is a prefix to show", () => {
    assert.equal(referenceExample({ prefix: "", separator: "-", digits: 4 }, 1), "");
  });

  it("never offers zero as a starting number", () => {
    assert.equal(referenceExample({ prefix: "BIO26", separator: "-", digits: 4 }, 0), "BIO26-0001");
  });
});

describe("normalisePrefix", () => {
  it("turns what somebody typed into something the rules accept", () => {
    assert.equal(normalisePrefix("bio 26!"), "BIO26");
    assert.equal(normalisePrefix("  dinner-2026  "), "DINNER2026");
  });

  it("stops at the length limit for the scope it is for", () => {
    assert.equal(normalisePrefix("ABCDEFGHIJKLMNOP"), "ABCDEFGHIJ");
    assert.equal(normalisePrefix("ABCDEFGHIJKLMNOP", { maxLength: 8 }), "ABCDEFGH");
  });
});

describe("prefix validity", () => {
  it("accepts what the database accepts", () => {
    assert.equal(isValidCollectionPrefix("BIO26"), true);
    assert.equal(isValidCollectionPrefix("AB"), true);
    assert.equal(isValidCollectionPrefix("ABCDEFGHIJ"), true);
    assert.equal(isValidTierPrefix("V"), true);
    assert.equal(isValidTierPrefix("VVIP"), true);
  });

  it("refuses what the database refuses", () => {
    assert.equal(isValidCollectionPrefix("A"), false, "one character is not a recognisable prefix");
    assert.equal(isValidCollectionPrefix("ABCDEFGHIJK"), false, "eleven is past the column's limit");
    assert.equal(isValidCollectionPrefix("bio26"), false, "lower case is not what gets stored");
    assert.equal(isValidCollectionPrefix("BIO-26"), false, "the separator is not part of the prefix");
    assert.equal(isValidTierPrefix(""), false);
    assert.equal(isValidTierPrefix("ABCDEFGHI"), false, "nine is past the tier column's limit");
  });
});
