import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePaymentReference, isPaymentReference } from "../src/payment-reference.ts";

describe("generatePaymentReference", () => {
  it("produces the correct format", () => {
    const ref = generatePaymentReference();
    assert.ok(ref.startsWith("KLK-"), `expected KLK- prefix, got ${ref}`);
    assert.strictEqual(ref.length, 4 + 26, `expected 30 chars, got ${ref.length}`);
  });

  it("uses only Crockford base32 characters after the prefix", () => {
    const ref = generatePaymentReference();
    const body = ref.slice(4);
    assert.match(body, /^[0-9A-TV-Z]+$/, `unexpected characters in ${body}`);
  });

  it("produces unique references", () => {
    const refs = new Set(Array.from({ length: 100 }, () => generatePaymentReference()));
    assert.strictEqual(refs.size, 100, "expected 100 unique references");
  });
});

describe("isPaymentReference", () => {
  it("accepts a valid reference", () => {
    const ref = generatePaymentReference();
    assert.ok(isPaymentReference(ref));
  });

  it("rejects a contributor reference", () => {
    assert.ok(!isPaymentReference("BIO26-0042"));
  });

  it("rejects an empty string", () => {
    assert.ok(!isPaymentReference(""));
  });

  it("rejects wrong prefix", () => {
    assert.ok(!isPaymentReference("PAY-ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
  });
});
