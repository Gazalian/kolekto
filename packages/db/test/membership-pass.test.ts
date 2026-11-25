/**
 * membership-pass.test.ts — unit tests for the membership pass wrappers
 * (A2.2: membershipPassSummary, confirmMembershipPass) and the removal of
 * findCollectionMember.
 *
 * The database layer is mocked so these run without a live Postgres connection.
 * Integration coverage of the SQL functions themselves lives in the pgTAP suite
 * (supabase/tests/).
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Mock setup (before any import of the module under test) ──────────────

let fakeRows: Record<string, unknown>[] = [];
let fakeShouldThrow: Error | null = null;
let capturedCaller: { userId: string | null } | null = null;

class FakeDatabaseError extends Error {
  readonly code: string;
  readonly sqlState: string | undefined;
  constructor(pgError: unknown) {
    const raw = pgError instanceof Error ? pgError.message : String(pgError);
    const m = /^([A-Z_]+):\s*(.*)$/s.exec(raw);
    super(m ? m[2]! : raw);
    this.name = "DatabaseError";
    this.code = m ? m[1]! : "UNKNOWN";
    this.sqlState = (pgError as { code?: string })?.code;
  }
}

mock.module("../src/client.ts", {
  namedExports: {
    ANONYMOUS: Object.freeze({ userId: null }),
    DatabaseError: FakeDatabaseError,
    runWrite: async (fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } catch (error) {
        throw new FakeDatabaseError(error);
      }
    },
    withCallerContext: async (
      caller: { userId: string | null },
      fn: (tx: (...args: unknown[]) => Promise<unknown[]>) => Promise<unknown>,
    ) => {
      capturedCaller = caller;
      if (fakeShouldThrow) throw fakeShouldThrow;
      return fn((..._args: unknown[]) => Promise.resolve(fakeRows));
    },
  },
});

mock.module("@kolekto/config", {
  namedExports: { loadDatabaseUrl: () => "postgresql://test@localhost/test" },
});

const { membershipPassSummary, confirmMembershipPass } = await import("../src/membership.ts");

// ── membershipPassSummary ────────────────────────────────────────────────

describe("membershipPassSummary()", () => {
  beforeEach(() => {
    fakeRows = [];
    fakeShouldThrow = null;
    capturedCaller = null;
  });

  it("returns masked summary for a valid token", async () => {
    fakeRows = [{
      full_name: "Aisha Ibrahim",
      email_masked: "a•••@gmail.com",
      phone_masked: "+234 ••• ••• •567",
    }];
    const result = await membershipPassSummary("col-1", "valid-token");
    assert.deepStrictEqual(result, {
      fullName: "Aisha Ibrahim",
      emailMasked: "a•••@gmail.com",
      phoneMasked: "+234 ••• ••• •567",
    });
  });

  it("returns null for an invalid token", async () => {
    fakeRows = [];
    const result = await membershipPassSummary("col-1", "bad-token");
    assert.strictEqual(result, null);
  });

  it("returns null for an expired or revoked token", async () => {
    fakeRows = [];
    const result = await membershipPassSummary("col-1", "expired-token");
    assert.strictEqual(result, null);
  });

  it("returns null for wrong collection/token combination", async () => {
    fakeRows = [];
    const result = await membershipPassSummary("wrong-col", "valid-for-other-col");
    assert.strictEqual(result, null);
  });

  it("propagates database errors as DatabaseError", async () => {
    fakeShouldThrow = new Error("CONNECTION_DESTROYED: pool died");
    await assert.rejects(
      () => membershipPassSummary("col-1", "token"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, "DatabaseError");
        return true;
      },
    );
  });

  it("never returns unmasked email or phone", async () => {
    fakeRows = [{
      full_name: "Chukwuemeka Obi",
      email_masked: "c•••@yahoo.com",
      phone_masked: "+234 ••• ••• •890",
    }];
    const result = await membershipPassSummary("col-1", "token");
    assert.ok(result);
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ["emailMasked", "fullName", "phoneMasked"]);
    assert.ok(
      !result.emailMasked || result.emailMasked.includes("•"),
      "emailMasked must contain mask characters",
    );
    assert.ok(
      !result.phoneMasked || result.phoneMasked.includes("•"),
      "phoneMasked must contain mask characters",
    );
  });

  it("handles null email and phone gracefully", async () => {
    fakeRows = [{ full_name: "Name Only", email_masked: null, phone_masked: null }];
    const result = await membershipPassSummary("col-1", "token");
    assert.ok(result);
    assert.strictEqual(result.emailMasked, null);
    assert.strictEqual(result.phoneMasked, null);
  });

  it("uses the anonymous caller context", async () => {
    fakeRows = [];
    await membershipPassSummary("col-1", "token");
    assert.deepStrictEqual(capturedCaller, { userId: null });
  });
});

// ── confirmMembershipPass ────────────────────────────────────────────────

describe("confirmMembershipPass()", () => {
  beforeEach(() => {
    fakeRows = [];
    fakeShouldThrow = null;
    capturedCaller = null;
  });

  it("returns member UUID for a valid token", async () => {
    const memberId = "11111111-1111-1111-1111-111111111111";
    fakeRows = [{ member_id: memberId }];
    const result = await confirmMembershipPass("col-1", "valid-token");
    assert.strictEqual(result, memberId);
  });

  it("returns null for an invalid token", async () => {
    fakeRows = [{ member_id: null }];
    const result = await confirmMembershipPass("col-1", "bad-token");
    assert.strictEqual(result, null);
  });

  it("returns null for an expired or revoked token", async () => {
    fakeRows = [{ member_id: null }];
    const result = await confirmMembershipPass("col-1", "expired-token");
    assert.strictEqual(result, null);
  });

  it("returns null for wrong collection/token combination", async () => {
    fakeRows = [{ member_id: null }];
    const result = await confirmMembershipPass("wrong-col", "valid-for-other-col");
    assert.strictEqual(result, null);
  });

  it("propagates database errors as DatabaseError", async () => {
    fakeShouldThrow = new Error("INTERNAL_ERROR: something broke");
    await assert.rejects(
      () => confirmMembershipPass("col-1", "token"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, "DatabaseError");
        return true;
      },
    );
  });

  it("returns only a plain string UUID, not a member object", async () => {
    fakeRows = [{ member_id: "22222222-2222-2222-2222-222222222222" }];
    const result = await confirmMembershipPass("col-1", "token");
    assert.strictEqual(typeof result, "string");
  });

  it("returns null when the database returns no rows", async () => {
    fakeRows = [];
    const result = await confirmMembershipPass("col-1", "token");
    assert.strictEqual(result, null);
  });

  it("uses the anonymous caller context", async () => {
    fakeRows = [{ member_id: null }];
    await confirmMembershipPass("col-1", "token");
    assert.deepStrictEqual(capturedCaller, { userId: null });
  });
});

// ── findCollectionMember removal ─────────────────────────────────────────

describe("findCollectionMember removal (A2.2)", () => {
  it("findCollectionMember is no longer exported from public-read", async () => {
    const publicRead = await import("../src/public-read.ts");
    assert.strictEqual("findCollectionMember" in publicRead, false,
      "findCollectionMember should have been removed from public-read.ts");
  });

  it("CollectionMemberMatch is no longer exported from public-read", async () => {
    const publicRead = await import("../src/public-read.ts");
    assert.strictEqual("CollectionMemberMatch" in publicRead, false,
      "CollectionMemberMatch interface should have been removed from public-read.ts");
  });
});
