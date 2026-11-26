import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ── Constants ──────────────────────────────────────────────────────────────

const COMMUNITY_SLUG = "test-community";
const COLLECTION_SLUG = "test-collection";
const COLLECTION_ID = "c0000000-0000-4000-8000-000000000001";
const MEMBER_UUID = "m0000000-0000-4000-8000-000000000001";

// ── Mock state ─────────────────────────────────────────────────────────────

let mockCollection: Record<string, unknown> | null = { collection_id: COLLECTION_ID, status: "active" };
let mockStartResult: { valid: boolean; unavailable?: true } = { valid: true };
let mockSummaryResult: { fullName: string; emailMasked: string | null; phoneMasked: string | null } | null = {
  fullName: "Aisha Ibrahim",
  emailMasked: "a•••@gmail.com",
  phoneMasked: "+234 ••• ••• •567",
};
let mockCompleteResult: string | null = MEMBER_UUID;
let mockMemberContext: Record<string, unknown> | null = {
  full_name: "Aisha Ibrahim",
  member_code: "MEM-001",
  identifier_label: null,
  identifier_value: null,
  cycle_label: null,
  cycle_key: null,
  expected_amount_kobo: "500000",
  waived_amount_kobo: "0",
  obligation_status: "unpaid",
  due_at: null,
  contributor_reference: null,
  obligation_id: null,
};
let contributorSessionCleared = false;
let membershipPassCleared = false;
let rejectPassCalled = false;

vi.mock("@kolekto/db", () => ({
  getPublicCollection: async () => mockCollection,
  getCollectionMemberContext: async () => mockMemberContext,
  getPublicCollectionFields: async () => [],
  getPublicCollectionItems: async () => [],
  getPublicCollectionTiers: async () => [],
}));

vi.mock("@kolekto/domain", () => ({
  ContributionError: class extends Error {},
  formatNaira: (v: unknown) => `₦${v}`,
  fromNaira: (v: string) => Number(v) * 100,
  kobo: (v: string) => Number(v),
  resolveContributionAmount: () => ({ amountKobo: 500000 }),
}));

vi.mock("@kolekto/validation", () => ({
  buildContributorAnswersSchema: () => ({ safeParse: () => ({ success: true, data: {} }) }),
  contributorContactSchema: { safeParse: () => ({ success: true, data: {} }) },
}));

vi.mock("@kolekto/payments", () => ({
  startCheckout: async () => ({ outcome: "misconfigured", reason: "test" }),
}));

vi.mock("../../../lib/contributor-session.ts", () => ({
  clearContributorSession: async () => {
    contributorSessionCleared = true;
  },
  readContributorSession: async () => null,
}));

vi.mock("../../../lib/membership-pass-helpers.ts", () => ({
  startMembershipPass: async () => mockStartResult,
  loadMembershipPassSummary: async () => mockSummaryResult,
  completeMembershipPass: async () => mockCompleteResult,
  rejectMembershipPass: async () => {
    rejectPassCalled = true;
  },
}));

vi.mock("../../../lib/membership-pass.ts", () => ({
  clearMembershipPass: async () => {
    membershipPassCleared = true;
  },
  // M10: submitContributionAction reads it; checkout behaviour is covered in checkout-membership-pass.test.ts.
  readMembershipPass: async () => null,
}));

vi.mock("../../../lib/payments/provider-factory.ts", () => ({
  getPaymentContext: () => null,
  contributorCheckoutUrl: () => "",
}));

const {
  validateMembershipIdAction,
  membershipPassSummaryAction,
  confirmMembershipPassAction,
  rejectMembershipPassAction,
  forgetMemberAction,
} = await import("./actions.ts");

// ── Tests ──────────────────────────────────────────────────────────────────

describe("validateMembershipIdAction()", () => {
  beforeEach(() => {
    mockCollection = { collection_id: COLLECTION_ID, status: "active" };
    mockStartResult = { valid: true };
  });

  it("returns valid when the membership ID validates", async () => {
    const result = await validateMembershipIdAction(COMMUNITY_SLUG, COLLECTION_SLUG, "IDS/K7P9Q");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns invalid with a generic error when the ID fails", async () => {
    mockStartResult = { valid: false };
    const result = await validateMembershipIdAction(COMMUNITY_SLUG, COLLECTION_SLUG, "BAD/ID000");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("passes 'unavailable' through with a generic message when the caller address is unavailable", async () => {
    mockStartResult = { valid: false, unavailable: true };
    const result = await validateMembershipIdAction(COMMUNITY_SLUG, COLLECTION_SLUG, "IDS/K7P9Q");
    expect(result).toEqual({
      valid: false,
      unavailable: true,
      error: "Membership ID checks are temporarily unavailable. Please try again in a few minutes.",
    });
    expect(JSON.stringify(result)).not.toMatch(/forwarded|vercel|header|proxy|KOLEKTO_/i);
  });

  it("rejects empty input", async () => {
    const result = await validateMembershipIdAction(COMMUNITY_SLUG, COLLECTION_SLUG, "");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/enter/i);
  });

  it("rejects whitespace-only input", async () => {
    const result = await validateMembershipIdAction(COMMUNITY_SLUG, COLLECTION_SLUG, "   ");
    expect(result.valid).toBe(false);
  });

  it("returns error when collection is not found", async () => {
    mockCollection = null;
    const result = await validateMembershipIdAction(COMMUNITY_SLUG, COLLECTION_SLUG, "IDS/K7P9Q");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no longer available/i);
  });
});

describe("membershipPassSummaryAction()", () => {
  beforeEach(() => {
    mockCollection = { collection_id: COLLECTION_ID, status: "active" };
    mockSummaryResult = {
      fullName: "Aisha Ibrahim",
      emailMasked: "a•••@gmail.com",
      phoneMasked: "+234 ••• ••• •567",
    };
  });

  it("returns masked summary when pass is valid", async () => {
    const result = await membershipPassSummaryAction(COMMUNITY_SLUG, COLLECTION_SLUG);
    expect(result.summary).toEqual({
      fullName: "Aisha Ibrahim",
      emailMasked: "a•••@gmail.com",
      phoneMasked: "+234 ••• ••• •567",
    });
    expect(result.error).toBeUndefined();
  });

  it("returns error when pass has expired", async () => {
    mockSummaryResult = null;
    const result = await membershipPassSummaryAction(COMMUNITY_SLUG, COLLECTION_SLUG);
    expect(result.error).toMatch(/expired/i);
    expect(result.summary).toBeUndefined();
  });

  it("returns error when collection is not found", async () => {
    mockCollection = null;
    const result = await membershipPassSummaryAction(COMMUNITY_SLUG, COLLECTION_SLUG);
    expect(result.error).toMatch(/no longer available/i);
  });
});

describe("confirmMembershipPassAction()", () => {
  beforeEach(() => {
    mockCollection = { collection_id: COLLECTION_ID, status: "active" };
    mockCompleteResult = MEMBER_UUID;
    mockMemberContext = {
      full_name: "Aisha Ibrahim",
      member_code: "MEM-001",
      identifier_label: null,
      identifier_value: null,
      cycle_label: null,
      cycle_key: null,
      expected_amount_kobo: "500000",
      waived_amount_kobo: "0",
      obligation_status: "unpaid",
      due_at: null,
      contributor_reference: null,
      obligation_id: null,
    };
    contributorSessionCleared = false;
  });

  it("returns member context on success", async () => {
    const result = await confirmMembershipPassAction(COMMUNITY_SLUG, COLLECTION_SLUG);
    expect(result.member).toBeDefined();
    expect(result.member!.fullName).toBe("Aisha Ibrahim");
    expect(result.error).toBeUndefined();
  });

  it("returns error when pass has expired", async () => {
    mockCompleteResult = null;
    const result = await confirmMembershipPassAction(COMMUNITY_SLUG, COLLECTION_SLUG);
    expect(result.error).toMatch(/expired/i);
    expect(result.member).toBeUndefined();
  });

  it("clears contributor session when member is no longer eligible", async () => {
    mockMemberContext = null;
    const result = await confirmMembershipPassAction(COMMUNITY_SLUG, COLLECTION_SLUG);
    expect(result.error).toMatch(/no longer contribute/i);
    expect(contributorSessionCleared).toBe(true);
  });

  it("returns error when collection is not found", async () => {
    mockCollection = null;
    const result = await confirmMembershipPassAction(COMMUNITY_SLUG, COLLECTION_SLUG);
    expect(result.error).toMatch(/no longer available/i);
  });
});

describe("rejectMembershipPassAction()", () => {
  beforeEach(() => {
    rejectPassCalled = false;
  });

  it("delegates to rejectMembershipPass", async () => {
    await rejectMembershipPassAction();
    expect(rejectPassCalled).toBe(true);
  });
});

describe("forgetMemberAction() (updated)", () => {
  beforeEach(() => {
    contributorSessionCleared = false;
    membershipPassCleared = false;
  });

  it("clears both contributor session and membership pass", async () => {
    await forgetMemberAction();
    expect(contributorSessionCleared).toBe(true);
    expect(membershipPassCleared).toBe(true);
  });
});
