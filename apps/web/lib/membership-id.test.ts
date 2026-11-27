import { describe, expect, it } from "vitest";
import {
  CROCKFORD_ALPHABET,
  canonicalMembershipId,
  generateSuffix,
  hashClientAddress,
  hashMembershipId,
  maskMembershipId,
  newMembershipId,
  prefixProblem,
} from "./membership-id.ts";

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const COMMUNITY = "a7520000-0000-4000-8000-00000000000a";

describe("membership ID format", () => {
  it("uses Crockford base32 without I, L, O or U", () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it("generates suffixes of the configured length from the alphabet, always with a letter", () => {
    for (const length of [5, 6, 7, 8]) {
      for (let i = 0; i < 200; i += 1) {
        const suffix = generateSuffix(length);
        expect(suffix).toHaveLength(length);
        expect([...suffix].every((c) => CROCKFORD_ALPHABET.includes(c))).toBe(true);
        expect(suffix).toMatch(/[A-Z]/);
      }
    }
  });

  it("re-draws an all-digit suffix, so an ID can never equal a numeric member number", () => {
    const draws = [0, 1, 2, 3, 4, /* then a letter */ 0, 1, 2, 3, 10];
    let i = 0;
    expect(generateSuffix(5, () => draws[i++] ?? 0)).toBe("0123A");
  });

  it("refuses lengths outside 5–8", () => {
    expect(() => generateSuffix(4)).toThrow();
    expect(() => generateSuffix(9)).toThrow();
  });

  it("validates prefixes like the database", () => {
    expect(prefixProblem("ids")).toBeNull();
    expect(prefixProblem(" kwasu ")).toBeNull();
    expect(prefixProblem("I")).not.toBeNull();
    expect(prefixProblem("1DS")).not.toBeNull();
    expect(prefixProblem("ID$")).not.toBeNull();
    expect(prefixProblem("ABCDEFGHIJK")).not.toBeNull();
    expect(prefixProblem("km")).toMatch(/reserved/);
  });

  it("canonicalises what people type: case, spaces, separators, O/0 and I/L/1", () => {
    // The whole string is mapped, prefix included (IDS → 1DS), the same way at
    // issue and at check, so the stored hash and the typed ID always agree.
    expect(canonicalMembershipId("ids/k7p9o")).toBe("1DSK7P90");
    expect(canonicalMembershipId(" IDS - K7P90 ")).toBe("1DSK7P90");
    expect(canonicalMembershipId("abu/x6nlk")).toBe("ABUX6N1K");
    expect(canonicalMembershipId("ABU/X6N1K")).toBe("ABUX6N1K");
  });

  it("masks to the last two characters", () => {
    expect(maskMembershipId("IDS", "/", "9Q")).toBe("IDS/•••9Q");
  });
});

describe("membership ID hashing", () => {
  it("is deterministic, 32 bytes, tolerant of typing differences", () => {
    const a = hashMembershipId(SECRET, COMMUNITY, "IDS/K7P90");
    expect(a).toHaveLength(32);
    expect(hashMembershipId(SECRET, COMMUNITY, "ids k7p9o").equals(a)).toBe(true);
  });

  it("differs by community and by secret", () => {
    const a = hashMembershipId(SECRET, COMMUNITY, "IDS/K7P90");
    expect(hashMembershipId(SECRET, "a7520000-0000-4000-8000-00000000000b", "IDS/K7P90").equals(a)).toBe(false);
    expect(hashMembershipId(`${SECRET}x`, COMMUNITY, "IDS/K7P90").equals(a)).toBe(false);
  });

  it("hashes client addresses with a separate key", () => {
    const ip = hashClientAddress(SECRET, "203.0.113.9");
    expect(ip).toHaveLength(32);
    expect(ip.equals(hashMembershipId(SECRET, COMMUNITY, "203.0.113.9"))).toBe(false);
  });
});

describe("new membership IDs (plaintext, owner decision A1)", () => {
  it("are in the configured format with a random suffix of the configured length", () => {
    const id = newMembershipId({ prefix: "AHS", separator: "-", suffixLength: 6 });
    expect(id).toMatch(/^AHS-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(id.slice(4)).toMatch(/[A-Z]/);
  });

  it("match the database's stored-format rule and canonical rule", () => {
    // membership_ids_plaintext_format and app.canonical_membership_id (20261123120000).
    for (let i = 0; i < 200; i += 1) {
      const id = newMembershipId({ prefix: "UAL", separator: "/", suffixLength: 5 });
      expect(id).toMatch(/^[A-Z][A-Z0-9]{1,9}[/-][0-9A-HJKMNP-TV-Z]{5,8}$/);
      expect(canonicalMembershipId(id)).toBe(id.replace("/", "").replace(/O/g, "0").replace(/[IL]/g, "1"));
    }
  });

  it("do not repeat in practice", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(newMembershipId({ prefix: "IDS", separator: "/", suffixLength: 8 }));
    expect(seen.size).toBe(1000);
  });
});
