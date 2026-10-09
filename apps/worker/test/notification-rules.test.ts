import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  admission,
  buildPayload,
  eventKey,
  isImportedMember,
  isWatchedAction,
  MAX_EVENT_AGE_MS,
  narrowRequester,
  parseAuditMessage,
  recipientPlan,
  redactEmails,
  WATCHED_ACTIONS,
  type AuditMessage,
} from "../src/notification-rules.ts";

const COMMUNITY = "a2000000-0000-4000-8000-00000000000a";
const OBJECT = "a4000000-0000-4000-8000-000000000001";
const AUDIT = "a6000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-10-09T12:00:00Z");

function raw(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    audit_log_id: AUDIT,
    community_id: COMMUNITY,
    action: "member.create",
    actor_type: "officer",
    actor_user_id: "a1000000-0000-4000-8000-000000000001",
    actor_name: "Ada Officer",
    object_type: "member",
    object_id: OBJECT,
    after_state: { full_name: "Chidi", member_code: "K/0001" },
    created_at: "2026-10-09T11:59:00Z",
    ...patch,
  };
}

function msg(patch: Record<string, unknown> = {}): AuditMessage {
  const r = parseAuditMessage(raw(patch));
  assert.ok(r.ok, "fixture message should parse");
  return r.message;
}

describe("the watched actions", () => {
  it("are exactly the seven approved ones", () => {
    assert.deepEqual(
      [...WATCHED_ACTIONS].sort(),
      [
        "collection.publish",
        "member.approve_join",
        "member.create",
        "member.join_via_invite",
        "member.reject_join",
        "officer_invitation.accept",
        "officer_term.end",
      ].sort(),
    );
  });

  it("do not include restore, archive or update, which must never notify", () => {
    for (const a of ["member.restore", "member.archive", "member.update", "member.edit"]) assert.equal(isWatchedAction(a), false, a);
  });

  it("event keys are action:object, unchanged from M13.1", () => {
    assert.equal(eventKey("member.create", OBJECT), `member.create:${OBJECT}`);
  });
});

describe("parseAuditMessage: a queued message is untrusted input", () => {
  it("accepts a well-formed message", () => {
    assert.equal(parseAuditMessage(raw()).ok, true);
  });

  it("rejects, without throwing, everything that is not a usable message", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "a string",
      42,
      [],
      {},
      raw({ audit_log_id: "not-a-uuid" }),
      raw({ community_id: null }),
      raw({ community_id: "x".repeat(500) }),
      raw({ object_id: 7 }),
      raw({ action: undefined }),
      raw({ created_at: "yesterday-ish" }),
      raw({ created_at: null }),
    ];
    for (const b of bad) assert.deepEqual(parseAuditMessage(b), { ok: false, reason: "invalid_message" }, JSON.stringify(b));
  });

  it("copies out only the fields it uses", () => {
    const r = parseAuditMessage(raw({ phone_e164: "+2348000000000", whatever: { nested: true } }));
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.message).sort(), [
      "action", "actor_name", "actor_type", "actor_user_id", "after_state", "audit_log_id", "before_state",
      "community_id", "created_at", "object_id", "object_type",
    ]);
  });

  it("treats a non-object after_state or before_state as absent", () => {
    const r = parseAuditMessage(raw({ after_state: "text", before_state: ["x"] }));
    assert.ok(r.ok);
    assert.equal(r.message.after_state, null);
    assert.equal(r.message.before_state, null);
  });

  it("drops an actor_user_id that is not a uuid", () => {
    const r = parseAuditMessage(raw({ actor_user_id: "robert'); drop table" }));
    assert.ok(r.ok);
    assert.equal(r.message.actor_user_id, null);
  });
});

describe("admission", () => {
  it("admits each watched action from a person actor", () => {
    for (const action of WATCHED_ACTIONS) {
      const actor = action === "member.join_via_invite" ? "member" : "officer";
      assert.deepEqual(admission(msg({ action, actor_type: actor }), NOW), { process: true }, action);
    }
  });

  it("ignores an unwatched action", () => {
    assert.deepEqual(admission(msg({ action: "member.restore" }), NOW), { process: false, reason: "unwatched_action" });
  });

  it("ignores a system, contributor or staff actor on every membership action", () => {
    for (const action of ["member.create", "member.approve_join", "member.reject_join", "member.join_via_invite"]) {
      for (const actor of ["system", "contributor", "staff"]) {
        assert.deepEqual(admission(msg({ action, actor_type: actor }), NOW), { process: false, reason: "not_a_person_action" }, `${action}/${actor}`);
      }
    }
  });

  it("but a system actor on collection.publish or an officer-access change is still admitted", () => {
    for (const action of ["collection.publish", "officer_term.end", "officer_invitation.accept"]) {
      assert.deepEqual(admission(msg({ action, actor_type: "system" }), NOW), { process: true }, action);
    }
  });

  it("drops a message older than 72 hours, and keeps one just inside it", () => {
    const old = new Date(NOW - MAX_EVENT_AGE_MS - 1000).toISOString();
    const fresh = new Date(NOW - MAX_EVENT_AGE_MS + 60_000).toISOString();
    assert.deepEqual(admission(msg({ created_at: old }), NOW), { process: false, reason: "event_too_old" });
    assert.deepEqual(admission(msg({ created_at: fresh }), NOW), { process: true });
  });
});

describe("isImportedMember", () => {
  it("refuses an imported or migrated member and accepts an ordinary one", () => {
    assert.equal(isImportedMember({ is_imported: true, joined_via: "manual" }), true);
    assert.equal(isImportedMember({ is_imported: false, joined_via: "import" }), true);
    assert.equal(isImportedMember({ is_imported: false, joined_via: "migration" }), true);
    assert.equal(isImportedMember({ is_imported: false, joined_via: "manual" }), false);
    assert.equal(isImportedMember({ is_imported: null, joined_via: "invite_link" }), false);
    assert.equal(isImportedMember({}), false);
  });
});

describe("recipientPlan", () => {
  it("tells the right in-app audience for each action", () => {
    assert.deepEqual(recipientPlan("collection.publish"), { kind: "collection_audience" });
    assert.deepEqual(recipientPlan("member.create"), { kind: "member_self" });
    assert.deepEqual(recipientPlan("member.approve_join"), { kind: "member_self" });
    assert.deepEqual(recipientPlan("officer_invitation.accept"), { kind: "officer_term_holder" });
    assert.deepEqual(recipientPlan("officer_term.end"), { kind: "officer_term_holder" });
  });

  it("R1: an invite joiner is never a recipient; the officers who admit members are", () => {
    assert.deepEqual(recipientPlan("member.join_via_invite"), { kind: "officers_with_permission", permission: "invite.approve" });
  });

  it("a rejected requester has no in-app recipient (they have no account)", () => {
    assert.deepEqual(recipientPlan("member.reject_join"), { kind: "nobody" });
  });

  it("an unknown action has nobody", () => {
    assert.deepEqual(recipientPlan("something.else"), { kind: "nobody" });
  });
});

describe("narrowRequester", () => {
  it("returns exactly three fields and drops everything else, even if it arrived", () => {
    const n = narrowRequester({
      full_name: "Requester", joined_via: "invite_link", email: "r@example.com",
      phone_e164: "+2348099990001", attributes: { matric: "KW/1" }, reason: "officer note", member_code: "K/1", id: "x",
    });
    assert.deepEqual(n, { full_name: "Requester", joined_via: "invite_link", email: "r@example.com" });
    assert.deepEqual(Object.keys(n).sort(), ["email", "full_name", "joined_via"]);
  });

  it("believes an address only if the requester typed it themselves", () => {
    assert.equal(narrowRequester({ full_name: "A", joined_via: "manual", email: "officer.typed@example.com" }).email, null);
    assert.equal(narrowRequester({ full_name: "A", joined_via: null, email: "x@example.com" }).email, null);
  });

  it("clamps lengths and tolerates garbage", () => {
    assert.equal(narrowRequester({ full_name: "x".repeat(500), joined_via: "invite_link" }).full_name?.length, 120);
    assert.equal(narrowRequester({ joined_via: "invite_link", email: "a".repeat(400) + "@example.com" }).email?.length, 254);
    for (const g of [null, undefined, "text", 5, [], [1, 2]]) {
      assert.deepEqual(narrowRequester(g), { full_name: null, joined_via: null, email: null });
    }
  });
});

describe("buildPayload: names, codes and slugs only", () => {
  const facts = {
    communitySlug: "kwasu", communityName: "KWASU Alumni", memberName: "Chidi Okafor", memberCode: "K/0001",
    collectionName: "Dues", collectionSlug: "dues", officerRole: "admin", endReason: "removed",
  };

  const KEYS: Record<string, string[]> = {
    "collection.publish": ["actor_name", "collection_name", "collection_slug", "community_id", "community_slug"],
    "member.create": ["actor_name", "community_id", "community_name", "community_slug", "member_code", "member_name"],
    "member.approve_join": ["actor_name", "community_id", "community_name", "community_slug", "member_code", "member_name"],
    "member.join_via_invite": ["actor_name", "community_id", "community_name", "community_slug", "member_name"],
    "member.reject_join": ["actor_name", "community_id", "community_name", "community_slug", "member_name"],
    "officer_invitation.accept": ["actor_name", "community_id", "community_name", "community_slug", "officer_role"],
    "officer_term.end": ["actor_name", "community_id", "community_name", "community_slug", "end_reason", "officer_role"],
  };

  it("has a fixed key set per action", () => {
    for (const [action, keys] of Object.entries(KEYS)) {
      assert.deepEqual(Object.keys(buildPayload(msg({ action }), facts)).sort(), keys, action);
    }
  });

  it("has no key that could carry a contact detail or a note, for any action", () => {
    const banned = /email|phone|address|reason|note|comment|message|token|password|secret|state|contact|recipient/i;
    for (const action of WATCHED_ACTIONS) {
      for (const key of Object.keys(buildPayload(msg({ action }), facts))) {
        assert.ok(!banned.test(key) || key === "end_reason", `${action} has a suspicious key: ${key}`);
      }
    }
  });

  it("cannot be made to carry an address by a hostile fact object", () => {
    const hostile = { ...facts, email: "leak@example.com", phone: "+2348000000000", reason: "officer text" } as unknown as typeof facts;
    for (const action of WATCHED_ACTIONS) {
      const json = JSON.stringify(buildPayload(msg({ action }), hostile));
      assert.ok(!json.includes("leak@example.com") && !json.includes("2348000000000") && !json.includes("officer text"), action);
    }
  });

  it("redacts an email address typed as a name, and clamps long values", () => {
    const p = buildPayload(msg({ action: "member.create" }), { ...facts, memberName: "bob@example.com", communityName: "x".repeat(900) });
    assert.equal(p["member_name"], "[email removed]");
    assert.equal(String(p["community_name"]).length, 120);
    // Same behaviour as the database trigger: the angle brackets are part of the matched run of non-space characters.
    assert.equal(redactEmails("Bob <bob@example.com> and carol@example.org"), "Bob [email removed] and [email removed]");
    assert.equal(redactEmails("@ada and see @ the meeting"), "@ada and see @ the meeting");
  });

  it("copes with absent facts", () => {
    const p = buildPayload(msg({ action: "officer_term.end" }), {});
    assert.equal(p["officer_role"], null);
    assert.equal(p["community_id"], COMMUNITY);
  });
});
