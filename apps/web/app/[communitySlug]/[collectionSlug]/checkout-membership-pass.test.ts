import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// M10: submitContributionAction sends the membership pass to checkout on a
// managed collection, takes the token and the member only from the server's
// cookies (never from the form), and turns a refused proof into one generic
// message that sends the contributor back to the membership ID step.

// ── Constants ──────────────────────────────────────────────────────────────

const COMMUNITY_SLUG = "test-community";
const COLLECTION_SLUG = "test-collection";
const COLLECTION_ID = "c0000000-0000-4000-8000-000000000001";
const SESSION_MEMBER = "a0000000-0000-4000-8000-000000000001";
const FORGED_MEMBER = "b0000000-0000-4000-8000-000000000002";
// Synthetic test values only: never a real token.
const COOKIE_TOKEN = "a".repeat(64);
const FORGED_TOKEN = "f".repeat(64);
const CHECKOUT_KEY = "6f1c2b9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const GENERIC = "Your identification has expired. Enter your membership ID again.";

// ── Mock state ─────────────────────────────────────────────────────────────

let audienceMode = "all_members";
let sessionMember: string | null = SESSION_MEMBER;
let passToken: string | null = COOKIE_TOKEN;
let checkoutResult: Record<string, unknown> = { outcome: "provider_unavailable", reason: "test" };
let checkoutCalls: Record<string, unknown>[] = [];
let sessionCleared = false;
let passCleared = false;
let errorLogs: string[] = [];

const MEMBER_CONTEXT = {
  full_name: "Aisha Ibrahim",
  member_code: "MEM-001",
  identifier_label: null,
  identifier_value: null,
  cycle_label: null,
  cycle_key: null,
  expected_amount_kobo: null,
  waived_amount_kobo: null,
  obligation_status: null,
  due_at: null,
  contributor_reference: null,
  obligation_id: null,
};

vi.mock("@kolekto/db", () => ({
  getPublicCollection: async () => ({
    collection_id: COLLECTION_ID,
    status: "active",
    audience_mode: audienceMode,
    amount_model: "fixed",
    fixed_amount_kobo: "500000",
    min_amount_kobo: null,
    max_amount_kobo: null,
    category: "dues",
    fee_mode: "community_absorbs",
    collect_attendee_details: false,
  }),
  getCollectionMemberContext: async () => MEMBER_CONTEXT,
  getPublicCollectionFields: async () => [],
  getPublicCollectionItems: async () => [],
  getPublicCollectionTiers: async () => [],
}));

vi.mock("@kolekto/domain", () => ({
  ContributionError: class extends Error {},
  formatNaira: (v: unknown) => `₦${String(v)}`,
  fromNaira: (v: string) => Number(v) * 100,
  kobo: (v: string) => Number(v),
  resolveContributionAmount: () => ({ amountKobo: 500000 }),
}));

vi.mock("@kolekto/validation", () => ({
  buildContributorAnswersSchema: () => ({ safeParse: () => ({ success: true, data: {} }) }),
  contributorContactSchema: {
    safeParse: () => ({ success: true, data: { fullName: "Aisha Ibrahim", email: "payer@example.test", phone: "+2348000000000" } }),
  },
}));

vi.mock("@kolekto/payments", () => ({
  startCheckout: async (_ctx: unknown, input: Record<string, unknown>) => {
    checkoutCalls.push(input);
    return checkoutResult;
  },
}));

vi.mock("../../../lib/contributor-session.ts", () => ({
  clearContributorSession: async () => {
    sessionCleared = true;
  },
  readContributorSession: async (collectionId: string) => (collectionId === COLLECTION_ID ? sessionMember : null),
}));

vi.mock("../../../lib/membership-pass-helpers.ts", () => ({
  startMembershipPass: async () => ({ valid: true }),
  loadMembershipPassSummary: async () => null,
  completeMembershipPass: async () => null,
  rejectMembershipPass: async () => {},
}));

vi.mock("../../../lib/membership-pass.ts", () => ({
  clearMembershipPass: async () => {
    passCleared = true;
  },
  readMembershipPass: async (collectionId: string) => (collectionId === COLLECTION_ID ? passToken : null),
}));

vi.mock("../../../lib/payments/provider-factory.ts", () => ({
  getPaymentContext: () => ({ db: null, provider: { name: "fake" }, environment: "local", appOrigin: "http://localhost:3000" }),
  contributorCheckoutUrl: (_p: unknown, url: string) => url,
}));

const { submitContributionAction } = await import("./actions.ts");

function submit(extra: Record<string, unknown> = {}) {
  return submitContributionAction(COMMUNITY_SLUG, COLLECTION_SLUG, {
    fullName: "Aisha Ibrahim",
    email: "payer@example.test",
    phone: "+2348000000000",
    tierId: "",
    amount: "",
    answers: {},
    checkoutKey: CHECKOUT_KEY,
    ...extra,
  } as Parameters<typeof submitContributionAction>[2]);
}

beforeEach(() => {
  audienceMode = "all_members";
  sessionMember = SESSION_MEMBER;
  passToken = COOKIE_TOKEN;
  checkoutResult = { outcome: "provider_unavailable", reason: "test" };
  checkoutCalls = [];
  sessionCleared = false;
  passCleared = false;
  errorLogs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "));
  });
});

// ── Managed collections ────────────────────────────────────────────────────

describe("submitContributionAction() on a managed collection (M10)", () => {
  it("sends the pass token from the cookie and the member from the session to checkout", async () => {
    await submit();
    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0]!.memberId).toBe(SESSION_MEMBER);
    expect(checkoutCalls[0]!.accessToken).toBe(COOKIE_TOKEN);
  });

  it("ignores a member id or token smuggled into the form input", async () => {
    await submit({ memberId: FORGED_MEMBER, accessToken: FORGED_TOKEN, member_id: FORGED_MEMBER, p_access_token: FORGED_TOKEN });
    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0]!.memberId).toBe(SESSION_MEMBER);
    expect(checkoutCalls[0]!.accessToken).toBe(COOKIE_TOKEN);
  });

  it("with no pass cookie: refuses before checkout, clears both cookies, asks to re-identify", async () => {
    passToken = null;
    const result = await submit();
    expect(checkoutCalls).toHaveLength(0);
    expect(result).toEqual({ error: GENERIC, reidentify: true });
    expect(sessionCleared).toBe(true);
    expect(passCleared).toBe(true);
  });

  it("with no contributor session: refuses before checkout and asks to re-identify", async () => {
    sessionMember = null;
    const result = await submit();
    expect(checkoutCalls).toHaveLength(0);
    expect(result.reidentify).toBe(true);
    expect(result.error).toMatch(/membership ID/);
    expect(passCleared).toBe(true);
  });

  it.each(["MEMBER_PROOF_EXPIRED", "MEMBER_PROOF_MISMATCH"])(
    "%s from the database: one generic message, both cookies cleared, re-identify",
    async (code) => {
      checkoutResult = { outcome: "db_error", code };
      const result = await submit();
      expect(result).toEqual({ error: GENERIC, reidentify: true });
      expect(sessionCleared).toBe(true);
      expect(passCleared).toBe(true);
    },
  );

  it("logs a mismatch with the collection id only: no member id, no token", async () => {
    checkoutResult = { outcome: "db_error", code: "MEMBER_PROOF_MISMATCH" };
    await submit();
    expect(errorLogs).toHaveLength(1);
    expect(JSON.parse(errorLogs[0]!)).toEqual({ msg: "checkout_member_proof_mismatch", collectionId: COLLECTION_ID });
    expect(errorLogs[0]).not.toContain(SESSION_MEMBER);
    expect(errorLogs[0]).not.toContain(COOKIE_TOKEN);
  });

  it("never returns the token in the action result", async () => {
    for (const outcome of [
      { outcome: "db_error", code: "MEMBER_PROOF_EXPIRED" },
      { outcome: "db_error", code: "AMOUNT_MISMATCH" },
      { outcome: "provider_unavailable", reason: "test" },
    ]) {
      checkoutResult = outcome;
      const result = await submit();
      expect(JSON.stringify(result)).not.toContain(COOKIE_TOKEN);
    }
  });

  it("keeps the pass after a retryable outcome, so pressing Pay again can resume (D5)", async () => {
    checkoutResult = { outcome: "provider_unavailable", reason: "test" };
    await submit();
    expect(passCleared).toBe(false);
    expect(sessionCleared).toBe(false);
  });

  it("an unrelated database refusal keeps its own message and does not clear identification", async () => {
    checkoutResult = { outcome: "db_error", code: "AMOUNT_MISMATCH" };
    const result = await submit();
    expect(result.error).toMatch(/Prices on this page have changed/);
    expect(result.reidentify).toBeUndefined();
    expect(passCleared).toBe(false);
  });
});

// ── Open collections ───────────────────────────────────────────────────────

describe("submitContributionAction() on an open collection (unchanged)", () => {
  it("sends no member and no token, even when identification cookies exist", async () => {
    audienceMode = "public";
    await submit();
    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0]!.memberId).toBeNull();
    expect(checkoutCalls[0]!.accessToken).toBeNull();
  });

  it("does not require a pass", async () => {
    audienceMode = "public";
    passToken = null;
    sessionMember = null;
    const result = await submit();
    expect(checkoutCalls).toHaveLength(1);
    expect(result.reidentify).toBeUndefined();
  });
});
