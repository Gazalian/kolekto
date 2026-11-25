import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ── Constants ──────────────────────────────────────────────────────────────

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const COL_ID = "c0000000-0000-4000-8000-000000000001";
const TYPED_ID = "IDS/K7P9Q";
const ACCESS_TOKEN = "grant-token-abc123";
const MEMBER_UUID = "m0000000-0000-4000-8000-000000000001";

// ── Mock state ─────────────────────────────────────────────────────────────

let mockValidateResult: { valid: boolean; accessToken: string | null; expiresAt: string | null } = {
  valid: true,
  accessToken: ACCESS_TOKEN,
  expiresAt: null,
};
let mockPassSummaryResult: { fullName: string; emailMasked: string | null; phoneMasked: string | null } | null = {
  fullName: "Aisha Ibrahim",
  emailMasked: "a•••@gmail.com",
  phoneMasked: "+234 ••• ••• •567",
};
let mockConfirmResult: string | null = MEMBER_UUID;
let passToken: string | null = null;
let contributorCollectionId: string | null = null;
let contributorMemberId: string | null = null;

vi.mock("@kolekto/config", () => ({
  loadSessionSecret: () => SECRET,
  loadMembershipIdSecret: () => SECRET,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: () => {},
    get: () => (passToken ? { value: passToken } : undefined),
    delete: () => {
      passToken = null;
    },
  }),
  headers: async () => ({
    get: (name: string) => {
      if (name === "x-forwarded-for") return "203.0.113.5";
      return null;
    },
  }),
}));

vi.mock("@kolekto/db", () => ({
  validateMembershipId: async (_col: string, _id: string, _hash: Buffer) => mockValidateResult,
  membershipPassSummary: async (_col: string, _token: string) => mockPassSummaryResult,
  confirmMembershipPass: async (_col: string, _token: string) => mockConfirmResult,
}));

vi.mock("./membership-pass.ts", () => ({
  setMembershipPass: async (collectionId: string, token: string) => {
    passToken = `${collectionId}:${token}`;
  },
  readMembershipPass: async (collectionId: string) => {
    if (!passToken) return null;
    const [storedCol, storedToken] = passToken.split(":");
    return storedCol === collectionId ? storedToken ?? null : null;
  },
  clearMembershipPass: async () => {
    passToken = null;
  },
}));

vi.mock("./contributor-session.ts", () => ({
  setContributorSession: async (collectionId: string, memberId: string) => {
    contributorCollectionId = collectionId;
    contributorMemberId = memberId;
  },
}));

const {
  startMembershipPass,
  loadMembershipPassSummary,
  completeMembershipPass,
  rejectMembershipPass,
} = await import("./membership-pass-helpers.ts");

// ── Tests ──────────────────────────────────────────────────────────────────

describe("startMembershipPass()", () => {
  beforeEach(() => {
    passToken = null;
    contributorCollectionId = null;
    contributorMemberId = null;
    mockValidateResult = { valid: true, accessToken: ACCESS_TOKEN, expiresAt: null };
  });

  it("returns valid and stores the token when the ID validates", async () => {
    const result = await startMembershipPass(COL_ID, TYPED_ID);
    expect(result.valid).toBe(true);
    expect(passToken).not.toBeNull();
  });

  it("returns invalid and stores no token when the ID fails", async () => {
    mockValidateResult = { valid: false, accessToken: null, expiresAt: null };
    const result = await startMembershipPass(COL_ID, TYPED_ID);
    expect(result.valid).toBe(false);
    expect(passToken).toBeNull();
  });

  it("returns invalid when the DB returns valid but no access token", async () => {
    mockValidateResult = { valid: true, accessToken: null, expiresAt: null };
    const result = await startMembershipPass(COL_ID, TYPED_ID);
    expect(result.valid).toBe(false);
  });
});

describe("loadMembershipPassSummary()", () => {
  beforeEach(() => {
    passToken = `${COL_ID}:${ACCESS_TOKEN}`;
    mockPassSummaryResult = {
      fullName: "Aisha Ibrahim",
      emailMasked: "a•••@gmail.com",
      phoneMasked: "+234 ••• ••• •567",
    };
  });

  it("returns masked summary when cookie and token are valid", async () => {
    const result = await loadMembershipPassSummary(COL_ID);
    expect(result).toEqual({
      fullName: "Aisha Ibrahim",
      emailMasked: "a•••@gmail.com",
      phoneMasked: "+234 ••• ••• •567",
    });
  });

  it("returns null when no cookie is set", async () => {
    passToken = null;
    const result = await loadMembershipPassSummary(COL_ID);
    expect(result).toBeNull();
  });

  it("returns null when the DB returns no summary", async () => {
    mockPassSummaryResult = null;
    const result = await loadMembershipPassSummary(COL_ID);
    expect(result).toBeNull();
  });
});

describe("completeMembershipPass()", () => {
  beforeEach(() => {
    passToken = `${COL_ID}:${ACCESS_TOKEN}`;
    contributorCollectionId = null;
    contributorMemberId = null;
    mockConfirmResult = MEMBER_UUID;
  });

  it("sets contributor session and KEEPS the pass for checkout on success (M10)", async () => {
    const result = await completeMembershipPass(COL_ID);
    expect(result).toBe(MEMBER_UUID);
    expect(contributorCollectionId).toBe(COL_ID);
    expect(contributorMemberId).toBe(MEMBER_UUID);
    // Checkout sends this token to app.create_payment_attempt, which
    // re-resolves it; clearing it here would refuse every managed checkout.
    expect(passToken).toBe(`${COL_ID}:${ACCESS_TOKEN}`);
  });

  it("returns null when no cookie is set", async () => {
    passToken = null;
    const result = await completeMembershipPass(COL_ID);
    expect(result).toBeNull();
    expect(contributorMemberId).toBeNull();
  });

  it("returns null when the DB rejects the token", async () => {
    mockConfirmResult = null;
    const result = await completeMembershipPass(COL_ID);
    expect(result).toBeNull();
    expect(contributorMemberId).toBeNull();
  });

  it("does not set contributor session when the DB rejects", async () => {
    mockConfirmResult = null;
    await completeMembershipPass(COL_ID);
    expect(contributorCollectionId).toBeNull();
  });
});

describe("rejectMembershipPass()", () => {
  beforeEach(() => {
    passToken = `${COL_ID}:${ACCESS_TOKEN}`;
  });

  it("clears the membership pass cookie", async () => {
    await rejectMembershipPass();
    expect(passToken).toBeNull();
  });
});
