import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  archiveMemberSchema,
  createMemberSchema,
  memberCodeSettingsSchema,
  memberFieldSchema,
  parseFieldOptions,
  updateMemberSchema,
} from "../src/member.ts";

describe("createMemberSchema", () => {
  it("requires a community id and a non-empty name", () => {
    assert.equal(createMemberSchema.safeParse({ communityId: "not-a-uuid", fullName: "Chidi" }).success, false);
    assert.equal(createMemberSchema.safeParse({ communityId: crypto.randomUUID(), fullName: "" }).success, false);
  });

  it("accepts a member with only a name — every other field is optional", () => {
    const result = createMemberSchema.safeParse({ communityId: crypto.randomUUID(), fullName: "Chidi Eze" });
    assert.equal(result.success, true);
  });

  it("carries the community's own fields as a key-to-value map", () => {
    const result = createMemberSchema.parse({
      communityId: crypto.randomUUID(),
      fullName: "Chidi Eze",
      attributes: { matric_number: "20/53A/021", level: "300" },
    });
    assert.deepEqual(result.attributes, { matric_number: "20/53A/021", level: "300" });
  });

  it("defaults the fields a caller should not have to think about", () => {
    const result = createMemberSchema.parse({ communityId: crypto.randomUUID(), fullName: "Chidi Eze" });
    assert.deepEqual(result.attributes, {});
    assert.deepEqual(result.groupIds, []);
    assert.equal(result.confirmPossibleDuplicate, false);
  });
});

describe("updateMemberSchema / archiveMemberSchema", () => {
  it("requires a memberId, not a communityId — tenancy is re-derived server-side (SEC-18)", () => {
    assert.equal(updateMemberSchema.safeParse({ fullName: "Chidi" }).success, false);
  });

  it("archive accepts an optional reason", () => {
    const memberId = crypto.randomUUID();
    assert.equal(archiveMemberSchema.safeParse({ memberId }).success, true);
    assert.equal(archiveMemberSchema.safeParse({ memberId, reason: "Graduated" }).success, true);
  });
});

describe("memberFieldSchema", () => {
  const base = { communityId: crypto.randomUUID(), key: "matric_number", label: "Matric number", type: "text" as const };

  it("accepts a plain text field", () => {
    assert.equal(memberFieldSchema.safeParse(base).success, true);
  });

  it("refuses a key that is not a safe identifier", () => {
    assert.equal(memberFieldSchema.safeParse({ ...base, key: "Matric Number" }).success, false);
    assert.equal(memberFieldSchema.safeParse({ ...base, key: "1st_field" }).success, false);
  });

  it("refuses a choice field with no options", () => {
    assert.equal(memberFieldSchema.safeParse({ ...base, type: "single_select" }).success, false);
    assert.equal(
      memberFieldSchema.safeParse({ ...base, type: "single_select", options: ["100", "200"] }).success,
      true,
    );
  });

  it("refuses a primary identifier that is not unique — it would identify nothing", () => {
    assert.equal(
      memberFieldSchema.safeParse({ ...base, isPrimaryIdentifier: true, isUnique: false }).success,
      false,
    );
    assert.equal(
      memberFieldSchema.safeParse({ ...base, isPrimaryIdentifier: true, isUnique: true }).success,
      true,
    );
  });
});

describe("memberCodeSettingsSchema", () => {
  const communityId = crypto.randomUUID();

  it("accepts the prefixes communities actually use", () => {
    for (const prefix of ["KWASU/", "EST/", "MEM-", "CH.2026/"]) {
      assert.equal(memberCodeSettingsSchema.safeParse({ communityId, prefix }).success, true, prefix);
    }
  });

  it("refuses a prefix with characters that would need escaping in a link or a CSV", () => {
    // Surrounding whitespace is trimmed rather than refused — someone pasting
    // "KWASU/ " meant "KWASU/". What is refused is a character that would have
    // to be escaped wherever the code ends up.
    for (const prefix of ["KW ASU", "A,B", 'x"y', "a;b"]) {
      assert.equal(memberCodeSettingsSchema.safeParse({ communityId, prefix }).success, false, prefix);
    }
    assert.equal(memberCodeSettingsSchema.parse({ communityId, prefix: "  KWASU/  " }).prefix, "KWASU/");
  });

  it("defaults the padding and leaves the sequence alone unless asked", () => {
    const result = memberCodeSettingsSchema.parse({ communityId });
    assert.equal(result.padding, 4);
    assert.equal(result.startingNumber, undefined);
  });
});

describe("parseFieldOptions", () => {
  it("reads a comma-separated list and drops the gaps", () => {
    assert.deepEqual(parseFieldOptions("100, 200 ,, 300 "), ["100", "200", "300"]);
    assert.deepEqual(parseFieldOptions(""), []);
  });
});
