import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createOfficerInvitationSchema, redeemInviteLinkSchema } from "../src/invite.ts";

describe("redeemInviteLinkSchema", () => {
  it("requires a phone number — app.redeem_invite_link needs one to place the member on the roll", () => {
    const result = redeemInviteLinkSchema.safeParse({ token: "abc123", fullName: "Anon Joiner" });
    assert.equal(result.success, false);
  });

  it("accepts a minimal valid join", () => {
    const result = redeemInviteLinkSchema.safeParse({ token: "abc123", fullName: "Anon Joiner", phoneE164: "+2348012345678" });
    assert.equal(result.success, true);
  });
});

describe("createOfficerInvitationSchema", () => {
  it("rejects an invitation with neither a phone nor an email — app.create_officer_invitation requires one (UNREACHABLE)", () => {
    const result = createOfficerInvitationSchema.safeParse({
      communityId: crypto.randomUUID(),
      role: "admin",
    });
    assert.equal(result.success, false);
  });

  it("accepts an invitation reachable by email alone", () => {
    const result = createOfficerInvitationSchema.safeParse({
      communityId: crypto.randomUUID(),
      role: "admin",
      inviteeEmail: "officer@example.test",
    });
    assert.equal(result.success, true);
  });
});
