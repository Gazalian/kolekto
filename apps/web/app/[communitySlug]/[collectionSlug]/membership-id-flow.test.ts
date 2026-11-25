import { describe, expect, it, vi } from "vitest";
import { canonicalMembershipId } from "../../../lib/membership-id.ts";
import {
  ENTER_SCREEN,
  INVALID_MEMBERSHIP_ID_MESSAGE,
  PASS_EXPIRED_MESSAGE,
  TRY_AGAIN_MESSAGE,
  canSubmitMembershipId,
  canonicalMembershipIdLength,
  confirmIdentity,
  createSingleFlight,
  membershipIdForSubmission,
  normaliseMembershipIdInput,
  payerDetailsAfterIdentification,
  rejectIdentity,
  submitMembershipId,
  type IdentifiedMember,
  type IdentifyActions,
} from "./membership-id-flow.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ACCESS_TOKEN = "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const MEMBER_UUID = "3f2b8c1a-9d4e-4f6a-8b7c-1e2d3c4b5a69";
const FULL_EMAIL = "aisha.ibrahim@gmail.com";
const FULL_PHONE = "+2348031234567";

const SUMMARY = { fullName: "Aisha Ibrahim", emailMasked: "a•••@gmail.com", phoneMasked: "+234 ••• ••• •567" };

const MEMBER: IdentifiedMember = {
  fullName: "Aisha Ibrahim",
  memberCode: "MEM-001",
  identifierLabel: null,
  identifierValue: null,
  cycleLabel: null,
  cycleKey: null,
  expectedAmount: "₦5,000",
  waivedAmount: null,
  obligationStatus: "unpaid",
  dueAt: null,
  reference: null,
};

function actions(overrides: Partial<IdentifyActions> = {}): IdentifyActions & {
  validate: ReturnType<typeof vi.fn>;
  summary: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
} {
  return {
    validate: vi.fn(overrides.validate ?? (async () => ({ valid: true }))),
    summary: vi.fn(overrides.summary ?? (async () => ({ summary: SUMMARY }))),
    confirm: vi.fn(overrides.confirm ?? (async () => ({ member: MEMBER }))),
    reject: vi.fn(overrides.reject ?? (async () => undefined)),
  };
}

// ── 1. Input normalisation ───────────────────────────────────────────────────

describe("membership ID input normalisation", () => {
  it("upper-cases, collapses inner whitespace and trims", () => {
    expect(normaliseMembershipIdInput("  ids/k7p9q")).toBe("IDS/K7P9Q");
    expect(normaliseMembershipIdInput("ids   k7p9q ")).toBe("IDS K7P9Q ");
    expect(membershipIdForSubmission("  ids   k7p9q  ")).toBe("IDS K7P9Q");
  });

  it("never changes the canonical form the database compares", () => {
    for (const raw of ["ids/k7p9o", "IDS K7P90", "ids-k7p9q", " abc . 12il ", "kwasu_00l1", "\tids/k7p9q\n"]) {
      expect(canonicalMembershipId(membershipIdForSubmission(raw))).toBe(canonicalMembershipId(raw));
    }
  });

  it("measures length with the same rule as lib/membership-id.ts", () => {
    for (const raw of ["IDS/K7P9Q", "ids - k7p9o", "AB/12345", "a.b_c-d e/f", "OIL"]) {
      expect(canonicalMembershipIdLength(raw)).toBe(canonicalMembershipId(raw).length);
    }
  });

  it("only allows submission once the shortest possible ID is typed", () => {
    expect(canSubmitMembershipId("")).toBe(false);
    expect(canSubmitMembershipId("   ")).toBe(false);
    expect(canSubmitMembershipId("AB/1234")).toBe(false); // 6 canonical characters
    expect(canSubmitMembershipId("AB/12345")).toBe(true); // 7
    expect(canSubmitMembershipId("ids/k7p9q")).toBe(true);
  });
});

// ── 1–3. Submission, success, generic invalid-ID response ────────────────────

describe("submitMembershipId()", () => {
  it("sends the normalised ID and moves to the confirmation screen", async () => {
    const a = actions();
    const screen = await submitMembershipId(a, "  ids/k7p9q ");
    expect(a.validate).toHaveBeenCalledTimes(1);
    expect(a.validate).toHaveBeenCalledWith("IDS/K7P9Q");
    expect(a.summary).toHaveBeenCalledTimes(1);
    expect(screen).toEqual({ step: "confirm", summary: SUMMARY });
  });

  it("does not call the server for input too short to be an ID", async () => {
    const a = actions();
    const screen = await submitMembershipId(a, "AB1");
    expect(a.validate).not.toHaveBeenCalled();
    expect(screen).toEqual({ step: "enter", error: INVALID_MEMBERSHIP_ID_MESSAGE });
  });

  it.each([
    "That membership ID was not recognised. Check it and try again.",
    "This collection is no longer available.",
    "Member suspended",
    "Not in this collection's audience",
    undefined,
  ])("shows one generic message whatever the server's reason (%s)", async (serverError) => {
    const a = actions({ validate: async () => ({ valid: false, ...(serverError ? { error: serverError } : {}) }) });
    const screen = await submitMembershipId(a, "IDS/K7P9Q");
    expect(screen).toEqual({ step: "enter", error: INVALID_MEMBERSHIP_ID_MESSAGE });
    expect(INVALID_MEMBERSHIP_ID_MESSAGE).toBe("We couldn't find a member with this ID. Please check and try again.");
    expect(a.summary).not.toHaveBeenCalled();
  });

  it("shows a neutral retry message when the server action throws", async () => {
    const a = actions({ validate: async () => Promise.reject(new Error("db: relation app.x does not exist")) });
    const screen = await submitMembershipId(a, "IDS/K7P9Q");
    expect(screen).toEqual({ step: "enter", error: TRY_AGAIN_MESSAGE });
    expect(JSON.stringify(screen)).not.toContain("relation");
  });
});

// ── 4. Loading and duplicate submissions ─────────────────────────────────────

describe("createSingleFlight()", () => {
  it("drops calls made while the first is still running", async () => {
    const run = createSingleFlight();
    let release!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));

    expect(run(task)).toBe(true);
    expect(run(task)).toBe(false);
    expect(run(task)).toBe(false);
    expect(task).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(run(task)).toBe(true);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("releases after a failed task so the screen is never locked", async () => {
    const run = createSingleFlight();
    run(() => Promise.reject(new Error("boom")));
    await Promise.resolve();
    await Promise.resolve();
    expect(run(async () => undefined)).toBe(true);
  });
});

// ── 5. Masked summary; 11. no full contact details ──────────────────────────

describe("masked summary", () => {
  it("keeps only the name and the masked contact fields", async () => {
    const leaky = { ...SUMMARY, email: FULL_EMAIL, phone: FULL_PHONE, memberId: MEMBER_UUID, accessToken: ACCESS_TOKEN };
    const a = actions({ summary: async () => ({ summary: leaky }) });
    const screen = await submitMembershipId(a, "IDS/K7P9Q");
    expect(screen).toEqual({ step: "confirm", summary: SUMMARY });
    const serialised = JSON.stringify(screen);
    for (const secret of [FULL_EMAIL, FULL_PHONE, MEMBER_UUID, ACCESS_TOKEN]) expect(serialised).not.toContain(secret);
  });

  it("treats missing masked fields as null", async () => {
    const a = actions({ summary: async () => ({ summary: { fullName: "Bola", emailMasked: null, phoneMasked: null } }) });
    expect(await submitMembershipId(a, "IDS/K7P9Q")).toEqual({
      step: "confirm",
      summary: { fullName: "Bola", emailMasked: null, phoneMasked: null },
    });
  });
});

// ── 12. No token or UUID reaches client state ───────────────────────────────

describe("client state never carries the pass token or member UUID", () => {
  it("drops anything extra the validate action returns", async () => {
    const a = actions({
      validate: async () => ({ valid: true, accessToken: ACCESS_TOKEN, memberId: MEMBER_UUID }) as never,
    });
    const screen = await submitMembershipId(a, "IDS/K7P9Q");
    expect(JSON.stringify(screen)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(screen)).not.toContain(MEMBER_UUID);
  });
});

// ── 6. Confirmation; 8. expired or missing pass ─────────────────────────────

describe("confirmIdentity()", () => {
  it("hands back the member the server confirmed", async () => {
    const a = actions();
    expect(await confirmIdentity(a)).toEqual({ member: MEMBER });
    expect(a.confirm).toHaveBeenCalledTimes(1);
  });

  it("returns to ID entry with the server's message when the pass expired", async () => {
    const a = actions({ confirm: async () => ({ error: "That identification has expired. Enter your membership ID again." }) });
    expect(await confirmIdentity(a)).toEqual({
      screen: { step: "enter", error: "That identification has expired. Enter your membership ID again." },
    });
  });

  it("does not proceed when the server returns neither a member nor an error", async () => {
    const a = actions({ confirm: async () => ({}) });
    expect(await confirmIdentity(a)).toEqual({ screen: { step: "enter", error: PASS_EXPIRED_MESSAGE } });
  });

  it("does not proceed when the server action throws", async () => {
    const a = actions({ confirm: async () => Promise.reject(new Error("ECONNRESET")) });
    expect(await confirmIdentity(a)).toEqual({ screen: { step: "enter", error: TRY_AGAIN_MESSAGE } });
  });
});

describe("expired or missing pass on the summary step", () => {
  it.each([{ error: "That identification has expired. Enter your membership ID again." }, {}])(
    "returns to ID entry (%o)",
    async (response) => {
      const a = actions({ summary: async () => response });
      expect(await submitMembershipId(a, "IDS/K7P9Q")).toEqual({ step: "enter", error: PASS_EXPIRED_MESSAGE });
    },
  );
});

// ── 7. Rejection ─────────────────────────────────────────────────────────────

describe("rejectIdentity()", () => {
  it("clears the server pass and returns to a clean ID entry screen", async () => {
    const a = actions();
    expect(await rejectIdentity(a)).toEqual(ENTER_SCREEN);
    expect(ENTER_SCREEN).toEqual({ step: "enter", error: null });
    expect(a.reject).toHaveBeenCalledTimes(1);
  });

  it("still resets the screen when clearing the cookie fails", async () => {
    const a = actions({ reject: async () => Promise.reject(new Error("network")) });
    expect(await rejectIdentity(a)).toEqual(ENTER_SCREEN);
  });
});

// ── 9–10. Payer details after confirmation ──────────────────────────────────

describe("payerDetailsAfterIdentification()", () => {
  it("prefills the member's name and leaves the payer's email and phone empty", () => {
    expect(payerDetailsAfterIdentification(MEMBER)).toEqual({ fullName: "Aisha Ibrahim", email: "", phone: "" });
  });

  it("ignores any contact details present on the member object", () => {
    const withContacts = { ...MEMBER, email: FULL_EMAIL, phone: FULL_PHONE } as IdentifiedMember;
    const payer = payerDetailsAfterIdentification(withContacts);
    expect(payer.email).toBe("");
    expect(payer.phone).toBe("");
  });
});
