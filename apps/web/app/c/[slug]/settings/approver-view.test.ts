import type { WithdrawalApproverCandidate, WithdrawalApproverDesignation } from "@kolekto/db";
import { describe, expect, it } from "vitest";

import { approverErrorMessage, approverPanelState } from "./approver-view.ts";

const designation = (over: Partial<WithdrawalApproverDesignation>): WithdrawalApproverDesignation => ({
  designationId: "d1",
  userId: "u1",
  fullName: "Dayo Admin",
  designatedByName: "Amaka Owner",
  startedAt: "2026-11-20T10:00:00.000Z",
  endedByName: null,
  endedAt: null,
  active: true,
  eligible: true,
  officerRole: "admin",
  ...over,
});
const candidate = (over: Partial<WithdrawalApproverCandidate>): WithdrawalApproverCandidate => ({
  userId: "u1",
  fullName: "Dayo Admin",
  officerRole: "admin",
  officerTitle: null,
  officerSince: "2026-11-01T00:00:00.000Z",
  designated: false,
  ...over,
});

describe("approverPanelState", () => {
  it("with nobody designated, warns and offers every eligible admin", () => {
    const s = approverPanelState([], [candidate({}), candidate({ userId: "u2", fullName: "Efe Admin" })]);
    expect(s.notice).toBe("none_designated");
    expect(s.hasEffectiveApprover).toBe(false);
    expect(s.choices.map((c) => c.userId)).toEqual(["u1", "u2"]);
    expect(s.needsAdmin).toBe(false);
  });

  it("asks the owner to invite an admin when nobody is eligible", () => {
    const s = approverPanelState([], []);
    expect(s.needsAdmin).toBe(true);
    expect(s.choices).toEqual([]);
  });

  it("shows the current designee with who designated them and when, and offers only others for Replace", () => {
    const s = approverPanelState([designation({})], [candidate({ designated: true }), candidate({ userId: "u2", fullName: "Efe Admin" })]);
    expect(s.notice).toBeNull();
    expect(s.current).toEqual([
      expect.objectContaining({ fullName: "Dayo Admin", roleLabel: "Admin", status: "active", statusLabel: "Active", designatedByName: "Amaka Owner", designatedAt: "2026-11-20T10:00:00.000Z" }),
    ]);
    expect(s.choices.map((c) => c.userId)).toEqual(["u2"]);
  });

  it("marks a designee who lost their admin role or account as not eligible, and warns", () => {
    const s = approverPanelState([designation({ eligible: false, officerRole: null })], []);
    expect(s.current[0]).toMatchObject({ status: "not_eligible", statusLabel: "Not eligible", roleLabel: "No longer an admin" });
    expect(s.current[0]!.statusHelp).toMatch(/cannot approve/);
    expect(s.notice).toBe("none_effective");
    expect(s.hasEffectiveApprover).toBe(false);
  });

  it("keeps ended designations as history with who ended them", () => {
    const s = approverPanelState(
      [
        designation({ designationId: "d2", userId: "u2", fullName: "Efe Admin" }),
        designation({ active: false, eligible: false, endedAt: "2026-11-20T12:00:00.000Z", endedByName: "Amaka Owner" }),
      ],
      [],
    );
    expect(s.current.map((c) => c.fullName)).toEqual(["Efe Admin"]);
    expect(s.past).toEqual([
      { designationId: "d1", fullName: "Dayo Admin", designatedAt: "2026-11-20T10:00:00.000Z", designatedByName: "Amaka Owner", endedAt: "2026-11-20T12:00:00.000Z", endedByName: "Amaka Owner" },
    ]);
  });
});

describe("approverErrorMessage", () => {
  it("explains each refusal without database prose", () => {
    expect(approverErrorMessage("FORBIDDEN")).toMatch(/Only a community owner/);
    expect(approverErrorMessage("WITHDRAWAL_APPROVER_NOT_ELIGIBLE")).toMatch(/current admin or owner/);
    expect(approverErrorMessage("WITHDRAWAL_APPROVER_SELF")).toMatch(/nobody approves their own withdrawal/);
    expect(approverErrorMessage("SOMETHING_ELSE")).toMatch(/could not be changed/);
  });
});
