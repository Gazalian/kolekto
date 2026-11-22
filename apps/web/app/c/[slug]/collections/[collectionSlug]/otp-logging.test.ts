import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * otp-logging.test.ts — session 39: the member's withdrawal code never
 * reaches a log line or an error response.
 *
 * The database is mocked here on purpose (unlike the rest of this suite's
 * policy, see vitest.config.ts): what is under test is what the server
 * actions WRITE TO THE LOG and RETURN, not what the database decides — the
 * database's OTP rules are proved in pgTAP 69. Every console method is
 * captured and searched for the code, its HMAC and the server secret.
 */

const OTP = "482913";
const SECRET = "otp-secret-for-tests-".padEnd(64, "z");
const WITHDRAWAL_ID = "01a1f94d-f434-75ca-9863-8d1466f3e711";
const CHALLENGE_ID = "01a1f94d-f4eb-7000-8000-0000000000aa";

const db = {
  getWithdrawalOtpState: vi.fn(),
  verifyWithdrawalOtp: vi.fn(),
  requestWithdrawalOtp: vi.fn(),
};
let secretMissing = false;

vi.mock("@kolekto/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kolekto/db")>();
  return {
    ...actual,
    getWithdrawalOtpState: (...a: unknown[]) => db.getWithdrawalOtpState(...a),
    verifyWithdrawalOtp: (...a: unknown[]) => db.verifyWithdrawalOtp(...a),
    requestWithdrawalOtp: (...a: unknown[]) => db.requestWithdrawalOtp(...a),
  };
});
vi.mock("@kolekto/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kolekto/config")>();
  return {
    ...actual,
    loadWithdrawalOtpSecret: () => {
      if (secretMissing) throw new actual.ConfigError("KOLEKTO_WITHDRAWAL_OTP_SECRET is not set");
      return SECRET;
    },
  };
});
vi.mock("../../../../../lib/caller.ts", () => ({ requireCallerContext: async () => ({ userId: "01900000-0000-7000-8000-000000000001" }) }));
vi.mock("../../../../../lib/supabase/server.ts", () => ({ createClient: async () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { DatabaseError } = await import("@kolekto/db");
const { hashWithdrawalOtp } = await import("@kolekto/domain");
const { verifyWithdrawalOtpAction, resendWithdrawalOtpAction } = await import("./money-actions.ts");

const HASH = hashWithdrawalOtp(SECRET, CHALLENGE_ID, OTP);
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  secretMissing = false;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? String(v) : v)))).join(" "));
    });
  }
  db.getWithdrawalOtpState.mockResolvedValue({ challengeId: CHALLENGE_ID });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.getWithdrawalOtpState.mockReset();
  db.verifyWithdrawalOtp.mockReset();
  db.requestWithdrawalOtp.mockReset();
});

function assertNoSecret(result: unknown) {
  const everything = [...logged, JSON.stringify(result)].join("\n");
  expect(everything).not.toContain(OTP);
  expect(everything).not.toContain(HASH);
  expect(everything).not.toContain(SECRET);
}

const verify = (code: string = OTP) => verifyWithdrawalOtpAction("club", "dues", { withdrawalId: WITHDRAWAL_ID, code });

describe("verifyWithdrawalOtpAction never logs or returns the code", () => {
  it("successful verification: logs identifiers and outcome only; only the hash reaches the database", async () => {
    db.verifyWithdrawalOtp.mockResolvedValue({ outcome: "verified", attemptsRemaining: null });
    const result = await verify();
    expect(result).toEqual({ outcome: "verified", attemptsRemaining: null });
    expect(db.verifyWithdrawalOtp).toHaveBeenCalledWith(expect.anything(), { withdrawalId: WITHDRAWAL_ID, challengeId: CHALLENGE_ID, codeHash: HASH });
    assertNoSecret(result);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toEqual({
      msg: "withdrawal_otp_verify",
      withdrawalId: WITHDRAWAL_ID,
      challengeId: CHALLENGE_ID,
      outcome: "verified",
      attemptsRemaining: null,
    });
  });

  for (const [outcome, attemptsRemaining] of [
    ["incorrect", 3],
    ["locked", 0],
    ["expired", null],
    ["superseded", null],
    ["not_sent", null],
    ["withdrawal_closed", null],
    ["already_verified", null],
  ] as const) {
    it(`failed verification (${outcome}) does not log the code`, async () => {
      db.verifyWithdrawalOtp.mockResolvedValue({ outcome, attemptsRemaining });
      const result = await verify();
      assertNoSecret(result);
      expect(JSON.parse(logged[0]!)).toMatchObject({ msg: "withdrawal_otp_verify", outcome, attemptsRemaining });
    });
  }

  it("an invalid (malformed) code is neither logged nor sent to the database", async () => {
    const malformed = "48291";
    const result = await verify(malformed);
    expect(result).toEqual({ error: "Enter the 6-digit code from the email." });
    expect(db.verifyWithdrawalOtp).not.toHaveBeenCalled();
    expect(logged.join("\n")).not.toContain(malformed);
    expect(JSON.parse(logged[0]!)).toEqual({ msg: "withdrawal_otp_verify", withdrawalId: WITHDRAWAL_ID, outcome: "invalid_format" });
  });

  it("a code typed with spaces is still not logged in either form", async () => {
    db.verifyWithdrawalOtp.mockResolvedValue({ outcome: "incorrect", attemptsRemaining: 4 });
    const result = await verify("482 913");
    assertNoSecret(result);
    expect(logged.join("\n")).not.toContain("482 913");
  });

  it("a database error is logged by category only, and the response carries no secret", async () => {
    db.verifyWithdrawalOtp.mockRejectedValue(new DatabaseError(new Error(`OTP_CHALLENGE_MISMATCH: hash ${HASH} code ${OTP}`)));
    const result = await verify();
    assertNoSecret(result);
    expect(JSON.parse(logged[0]!)).toMatchObject({ outcome: "error", reason: "OTP_CHALLENGE_MISMATCH" });
  });

  it("an unexpected error message containing the code is not echoed", async () => {
    db.verifyWithdrawalOtp.mockRejectedValue(new Error(`boom ${OTP} ${HASH}`));
    const result = await verify();
    assertNoSecret(result);
    expect(result).toEqual({ error: "The code could not be checked." });
  });

  it("a missing secret is reported as unconfigured without any value", async () => {
    secretMissing = true;
    const result = await verify();
    assertNoSecret(result);
    expect(JSON.parse(logged[0]!)).toMatchObject({ outcome: "error", reason: "unconfigured" });
    expect(db.verifyWithdrawalOtp).not.toHaveBeenCalled();
  });
});

describe("resendWithdrawalOtpAction", () => {
  it("logs the new challenge id, not a code", async () => {
    db.requestWithdrawalOtp.mockResolvedValue({ challengeId: CHALLENGE_ID, resendAvailableAt: "2026-11-20T14:15:00.000Z" });
    const result = await resendWithdrawalOtpAction(WITHDRAWAL_ID);
    assertNoSecret(result);
    expect(JSON.parse(logged[0]!)).toEqual({ msg: "withdrawal_otp_resend", withdrawalId: WITHDRAWAL_ID, challengeId: CHALLENGE_ID, result: "requested" });
  });

  it("logs a refusal by its code", async () => {
    db.requestWithdrawalOtp.mockRejectedValue(new DatabaseError(new Error("OTP_RESEND_TOO_SOON: wait")));
    const result = await resendWithdrawalOtpAction(WITHDRAWAL_ID);
    assertNoSecret(result);
    expect(JSON.parse(logged[0]!)).toMatchObject({ result: "refused", reason: "OTP_RESEND_TOO_SOON" });
  });
});
