import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  emailDedupeKey,
  isEmailEvaluationEvent,
} from "../src/notification-eligibility.ts";

describe("isEmailEvaluationEvent", () => {
  it("evaluation events always file an email row", () => {
    for (const action of ["member.create", "member.approve_join", "officer_invitation.accept", "officer_term.end"]) {
      assert.equal(isEmailEvaluationEvent(action), true, action);
    }
  });

  it("rejections, redemptions, collection lifecycle and unwatched actions file no email row", () => {
    for (const action of ["member.reject_join", "member.join_via_invite", "collection.publish", "member.restore", "member.archive", "invite_link.redeem", ""]) {
      assert.equal(isEmailEvaluationEvent(action), false, action || "(empty)");
    }
  });
});

describe("emailDedupeKey", () => {
  it("creation and approval for one member share one confirmation key", () => {
    const member = "a4000000-0000-4000-8000-000000000001";
    assert.equal(emailDedupeKey("member.create", member), `membership_confirmation:${member}`);
    assert.equal(emailDedupeKey("member.approve_join", member), `membership_confirmation:${member}`);
  });

  it("officer notices and non-evaluation events carry no dedupe key", () => {
    for (const action of ["officer_invitation.accept", "officer_term.end", "member.reject_join", "member.join_via_invite", "collection.publish"]) {
      assert.equal(emailDedupeKey(action, "whatever"), null, action);
    }
  });

  it("the confirmation key satisfies the delivery-table dedupe format", () => {
    assert.match(emailDedupeKey("member.create", "a4000000-0000-4000-8000-000000000001")!, /^[a-z][a-z_]{2,40}:[A-Za-z0-9-]{1,100}$/);
  });
});
