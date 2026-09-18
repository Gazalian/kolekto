import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { archiveMemberSchema, createMemberSchema, updateMemberSchema } from "../src/member.ts";

describe("createMemberSchema", () => {
  it("requires a community id and a non-empty name", () => {
    assert.equal(createMemberSchema.safeParse({ communityId: "not-a-uuid", fullName: "Chidi" }).success, false);
    assert.equal(createMemberSchema.safeParse({ communityId: crypto.randomUUID(), fullName: "" }).success, false);
  });

  it("accepts a member with only a name — every other field is optional", () => {
    const result = createMemberSchema.safeParse({ communityId: crypto.randomUUID(), fullName: "Chidi Eze" });
    assert.equal(result.success, true);
  });

  it("defaults attributes and groupIds so the caller never has to think about them", () => {
    const result = createMemberSchema.parse({ communityId: crypto.randomUUID(), fullName: "Chidi Eze" });
    assert.deepEqual(result.attributes, {});
    assert.deepEqual(result.groupIds, []);
  });
});

describe("updateMemberSchema / archiveMemberSchema", () => {
  it("requires a memberId, not a communityId — tenancy is re-derived server-side (SEC-18)", () => {
    const withoutMemberId = updateMemberSchema.safeParse({ fullName: "Chidi" });
    assert.equal(withoutMemberId.success, false);
  });

  it("archive accepts an optional reason", () => {
    const result = archiveMemberSchema.safeParse({ memberId: crypto.randomUUID() });
    assert.equal(result.success, true);
  });
});
