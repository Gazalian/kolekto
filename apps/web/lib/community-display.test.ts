import { describe, expect, it } from "vitest";
import {
  communityTypeLabel,
  communityVerification,
  identityLevelView,
  initials,
  isManagingRole,
  naira,
  roleLabel,
  targetProgress,
} from "./community-display.ts";

describe("roles", () => {
  it("labels every officer role", () => {
    expect(["owner", "admin", "treasurer", "collector", "viewer"].map(roleLabel)).toEqual([
      "Owner",
      "Admin",
      "Treasurer",
      "Collector",
      "Viewer",
    ]);
  });

  it("treats owner, admin and treasurer as managing roles, collector and viewer not", () => {
    expect(["owner", "admin", "treasurer"].every(isManagingRole)).toBe(true);
    expect(isManagingRole("collector")).toBe(false);
    expect(isManagingRole("viewer")).toBe(false);
  });
});

describe("communityVerification", () => {
  it("only 'verified' reads as verified", () => {
    expect(communityVerification("verified")).toEqual({ label: "Verified", tone: "success" });
    for (const status of ["unverified", "pending", "rejected", "expired", "anything"]) {
      expect(communityVerification(status).label).not.toBe("Verified");
    }
  });
});

describe("identityLevelView", () => {
  it("never calls a contact-verified user identity verified", () => {
    expect(identityLevelView("contact_verified").label).toBe("Email confirmed");
    expect(identityLevelView("none").label).toBe("Not verified");
    expect(identityLevelView("identity_verified").label).toBe("Identity verified");
  });
});

describe("naira", () => {
  it("formats kobo strings without floating point and dashes a hidden figure", () => {
    expect(naira("148000000")).toBe("₦1,480,000");
    expect(naira("98050")).toBe("₦980.50");
    expect(naira("9007199254740993")).toBe("₦90,071,992,547,409.93");
    expect(naira(null)).toBe("—");
  });
});

describe("targetProgress", () => {
  it("is whole percent in integer arithmetic, bar capped at 100", () => {
    expect(targetProgress("333", "1000")).toEqual({ percent: 33, bar: 33 });
    expect(targetProgress("2500", "1000")).toEqual({ percent: 250, bar: 100 });
  });

  it("is null without a positive target or a visible amount", () => {
    expect(targetProgress("100", null)).toBeNull();
    expect(targetProgress("100", "0")).toBeNull();
    expect(targetProgress(null, "1000")).toBeNull();
  });
});

describe("initials and type labels", () => {
  it("takes first and last initials", () => {
    expect(initials("Adebayo Tunde Johnson")).toBe("AJ");
    expect(initials("maryam")).toBe("M");
    expect(initials("  ")).toBe("?");
  });

  it("labels community types, falling back to Community", () => {
    expect(communityTypeLabel("school_pta")).toBe("School PTA");
    expect(communityTypeLabel("unknown")).toBe("Community");
  });
});
