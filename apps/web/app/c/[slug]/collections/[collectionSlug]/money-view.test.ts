import { describe, expect, it } from "vitest";
import { eligibilityText, headlineChange, PAYMENT_STATUS_LABEL, payoutAccountWaiting, withdrawBlock, type WithdrawInputs } from "./money-view.ts";

const base: WithdrawInputs = {
  availableKobo: "500000",
  pendingKobo: "0",
  totalRaisedKobo: "500000",
  hasPayoutAccount: true,
  withdrawals: [],
  nextReleaseAt: null,
};

describe("withdrawBlock", () => {
  it("lets a verified officer with an available balance open the form", () => {
    expect(withdrawBlock(base)).toBeNull();
  });

  it("explains settlement when only pending money exists", () => {
    expect(
      withdrawBlock({ ...base, availableKobo: "0", pendingKobo: "490000", nextReleaseAt: "2026-11-18T04:00:00.000Z" }),
    ).toEqual({ kind: "settling", nextReleaseAt: "2026-11-18T04:00:00.000Z", awaitingProvider: false });
  });

  it("says the provider has not released the funds when everything pending is past T+1", () => {
    expect(
      withdrawBlock({
        ...base,
        availableKobo: "0",
        pendingKobo: "490000",
        scheduledKobo: "0",
        awaitingProviderKobo: "490000",
        nextReleaseAt: "2026-11-18T04:00:00.000Z",
      }),
    ).toEqual({ kind: "settling", nextReleaseAt: null, awaitingProvider: true });
  });

  it("names the clock, not the provider, while some pending money is still inside T+1", () => {
    expect(
      withdrawBlock({
        ...base,
        availableKobo: "0",
        pendingKobo: "980000",
        scheduledKobo: "490000",
        awaitingProviderKobo: "490000",
        nextReleaseAt: "2026-11-18T04:00:00.000Z",
      }),
    ).toEqual({ kind: "settling", nextReleaseAt: "2026-11-18T04:00:00.000Z", awaitingProvider: false });
  });

  it("says nothing has been received when the collection is empty", () => {
    expect(withdrawBlock({ ...base, availableKobo: "0", totalRaisedKobo: "0" })).toEqual({ kind: "nothing_received" });
  });

  it("says the balance is empty when everything was already withdrawn", () => {
    expect(withdrawBlock({ ...base, availableKobo: "0", withdrawals: [{ status: "failed", amountKobo: "1" }] })).toEqual({
      kind: "empty",
    });
  });

  it("asks for a payout account once there is money to withdraw", () => {
    expect(withdrawBlock({ ...base, hasPayoutAccount: false })).toEqual({ kind: "no_payout_account" });
  });

  it("says why saved accounts cannot receive it yet: review, or the 48-hour cooling-off", () => {
    expect(withdrawBlock({ ...base, hasPayoutAccount: false, payoutAccountWaiting: { kind: "under_review" } })).toEqual({
      kind: "no_payout_account",
      waiting: { kind: "under_review" },
    });
    const usableFrom = "2026-11-21T11:11:02.000Z";
    expect(
      withdrawBlock({ ...base, hasPayoutAccount: false, payoutAccountWaiting: { kind: "cooling_off", usableFrom } }),
    ).toEqual({ kind: "no_payout_account", waiting: { kind: "cooling_off", usableFrom } });
  });

  it("payoutAccountWaiting: earliest cooling-off first, then review, else nothing", () => {
    const now = Date.parse("2026-11-19T12:00:00.000Z");
    const acct = (id: string, usableFrom: string) => ({ id, bankName: "B", accountLast4: "0001", accountName: "N", isDefault: false, usableFrom });
    expect(
      payoutAccountWaiting([acct("a", "2026-11-21T10:00:00.000Z"), acct("b", "2026-11-20T10:00:00.000Z")], true, now),
    ).toEqual({ kind: "cooling_off", usableFrom: "2026-11-20T10:00:00.000Z" });
    expect(payoutAccountWaiting([acct("a", "2026-11-18T10:00:00.000Z")], true, now)).toEqual({ kind: "under_review" });
    expect(payoutAccountWaiting([], false, now)).toBeUndefined();
    expect(payoutAccountWaiting(null, false, now)).toBeUndefined();
  });

  it("explains the balance before the missing account when there is nothing to withdraw", () => {
    expect(withdrawBlock({ ...base, hasPayoutAccount: false, availableKobo: "0", totalRaisedKobo: "0" })).toEqual({
      kind: "nothing_received",
    });
  });

  it("does not block when the accounts could not be read (the database decides)", () => {
    expect(withdrawBlock({ ...base, hasPayoutAccount: null })).toBeNull();
  });

  it("reports a withdrawal already in progress", () => {
    expect(withdrawBlock({ ...base, withdrawals: [{ status: "approved", amountKobo: "200000" }] })).toEqual({
      kind: "in_progress",
      amountKobo: "200000",
    });
  });

  it("allows another withdrawal after a paid one (owner decision Q4: no free-first limit)", () => {
    expect(withdrawBlock({ ...base, withdrawals: [{ status: "paid", amountKobo: "200000" }] })).toBeNull();
  });

  it("a finished withdrawal never blocks the next", () => {
    for (const status of ["failed", "rejected", "cancelled", "reversed"]) {
      expect(withdrawBlock({ ...base, withdrawals: [{ status, amountKobo: "1" }] })).toBeNull();
    }
  });
});

describe("headlineChange", () => {
  const zero = { availableChangeKobo: "0", pendingChangeKobo: "0", withdrawingChangeKobo: "0", withdrawnChangeKobo: "0" };

  it("names the pending BALANCE for a payment, never a pending status", () => {
    expect(headlineChange({ ...zero, pendingChangeKobo: "490000", sourceType: "capture" })).toEqual({
      bucket: "Pending balance",
      kobo: "490000",
    });
  });

  it("shows a release as available money, not the matching pending decrease", () => {
    expect(
      headlineChange({ ...zero, pendingChangeKobo: "-490000", availableChangeKobo: "490000", sourceType: "balance_release" }),
    ).toEqual({ bucket: "Available balance", kobo: "490000" });
  });

  it("shows a payout as money withdrawn", () => {
    expect(
      headlineChange({ ...zero, withdrawingChangeKobo: "-200000", withdrawnChangeKobo: "200000", sourceType: "payout" }),
    ).toEqual({ bucket: "Total withdrawn", kobo: "200000" });
  });

  it("returns null for a row that moved nothing visible", () => {
    expect(headlineChange({ ...zero, sourceType: "adjustment" })).toBeNull();
  });
});

describe("payment status and withdrawal eligibility are separate", () => {
  const fmt = (iso: string) => iso.slice(0, 10);

  it("a successful payment is labelled Successful whatever its eligibility", () => {
    expect(PAYMENT_STATUS_LABEL.successful).toEqual({ label: "Successful", tone: "success" });
  });

  it("describes each eligibility without calling the payment pending", () => {
    const texts = [
      eligibilityText("scheduled", "2026-11-18T04:00:00.000Z", fmt),
      eligibilityText("awaiting_provider", null, fmt),
      eligibilityText("held", null, fmt),
      eligibilityText("released", null, fmt),
    ];
    expect(texts[0]).toBe("Available to withdraw from 2026-11-18");
    expect(texts[3]).toBe("In your available balance");
    for (const text of texts) expect(text).not.toMatch(/^pending/i);
  });

  it("has nothing to say for a payment that did not succeed", () => {
    expect(eligibilityText(null, null, fmt)).toBeNull();
  });
});
