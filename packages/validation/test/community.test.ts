import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCommunitySchema, communityNameSchema } from "../src/community.ts";

describe("communityNameSchema", () => {
  it("rejects a name shorter than the database's communities_name_length constraint", () => {
    // Mirrors 20260917120300_communities.sql: check (char_length(name) between 3 and 80).
    // A form that accepts what the database will reject is a round trip wasted.
    assert.equal(communityNameSchema.safeParse("AB").success, false);
    assert.equal(communityNameSchema.safeParse("ABC").success, true);
  });

  it("rejects a name longer than 80 characters", () => {
    assert.equal(communityNameSchema.safeParse("A".repeat(81)).success, false);
    assert.equal(communityNameSchema.safeParse("A".repeat(80)).success, true);
  });

  it("trims surrounding whitespace before checking length", () => {
    assert.equal(communityNameSchema.safeParse("  AB  ").success, false);
    assert.equal(communityNameSchema.parse("  Valid Name  "), "Valid Name");
  });
});

describe("createCommunitySchema", () => {
  it("rejects 'personal' as a type — app.create_community refuses it too (sign-up only)", () => {
    const result = createCommunitySchema.safeParse({ name: "A Real Community", type: "personal" });
    assert.equal(result.success, false);
  });

  it("accepts a minimal valid input", () => {
    const result = createCommunitySchema.safeParse({ name: "A Real Community", type: "fellowship" });
    assert.equal(result.success, true);
  });
});
