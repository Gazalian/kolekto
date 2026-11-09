import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHANNELS,
  COMMUNICATION_CATEGORIES,
  CURRENT_CAPABILITIES,
  channelRequirement,
  classifiedEvents,
  decide,
  emailSendClass,
  eventChannelRequirement,
  eventPolicy,
  mayRecordChoice,
  type Channel,
  type CommunicationCategory,
  type MemberPermission,
  type PaymentPurpose,
  type PolicyCapabilities,
  type RecipientFacts,
  type Requirement,
} from "../src/communication-policy.ts";
import {
  EMAIL_EVALUATION_EVENTS,
  collectionEmailCategory,
  collectionMemberDecision,
  COLLECTION_EMAIL_SEND_CLASS,
} from "../src/notification-eligibility.ts";
import { WATCHED_ACTIONS, recipientPlan } from "../src/notification-rules.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ALL_ON: PolicyCapabilities = { paymentAttribution: true, smsApproved: true };

function facts(patch: Partial<{ optedOut: boolean; communityNoticeAttested: boolean; permissions: MemberPermission[] }> = {}): RecipientFacts {
  return {
    optedOut: patch.optedOut ?? false,
    communityNoticeAttested: patch.communityNoticeAttested ?? true,
    permissions: new Set(patch.permissions ?? []),
  };
}

/** Compact, comparable form of a requirement. */
function sig(r: Requirement): string {
  switch (r.kind) {
    case "always":
      return "always";
    case "default_on":
      return r.requiresCommunityNotice ? "default_on+notice" : "default_on";
    case "opt_in":
      return `opt_in(${[...r.permissions].sort().join(",")})`;
    case "disabled":
      return `disabled(${r.reason})`;
  }
}

// ── 1. The full matrix, today and once each capability is approved ──────────

/**
 * Every category × channel cell (and both payment purposes) with today's
 * capabilities. This table IS the approved policy (review §4.2/§4.3, R0
 * decisions 1–7); a change here must be a reviewed product decision.
 */
const TODAY: Record<string, Record<Channel, string>> = {
  essential: { in_app: "always", email: "always", whatsapp: "opt_in(whatsapp_permission)", sms: "disabled(channel_disabled)" },
  community_operational: {
    in_app: "always",
    email: "default_on+notice",
    whatsapp: "opt_in(whatsapp_permission)",
    sms: "disabled(channel_disabled)",
  },
  marketing: {
    in_app: "disabled(category_not_on_channel)",
    email: "opt_in(marketing_consent)",
    whatsapp: "opt_in(marketing_consent,whatsapp_permission)",
    sms: "disabled(channel_disabled)",
  },
  "payment:status": {
    in_app: "disabled(payment_attribution_unavailable)",
    email: "disabled(payment_attribution_unavailable)",
    whatsapp: "disabled(payment_attribution_unavailable)",
    sms: "disabled(payment_attribution_unavailable)",
  },
  "payment:targeted_reminder": {
    in_app: "disabled(payment_attribution_unavailable)",
    email: "disabled(payment_attribution_unavailable)",
    whatsapp: "disabled(payment_attribution_unavailable)",
    sms: "disabled(payment_attribution_unavailable)",
  },
};

/** The same matrix once payment attribution and SMS are each separately approved. */
const FUTURE: Record<string, Record<Channel, string>> = {
  essential: { in_app: "always", email: "always", whatsapp: "opt_in(whatsapp_permission)", sms: "always" },
  community_operational: {
    in_app: "always",
    email: "default_on+notice",
    whatsapp: "opt_in(whatsapp_permission)",
    sms: "default_on+notice",
  },
  marketing: {
    in_app: "disabled(category_not_on_channel)",
    email: "opt_in(marketing_consent)",
    whatsapp: "opt_in(marketing_consent,whatsapp_permission)",
    sms: "opt_in(marketing_consent)",
  },
  "payment:status": { in_app: "always", email: "always", whatsapp: "opt_in(whatsapp_permission)", sms: "always" },
  "payment:targeted_reminder": {
    in_app: "always",
    email: "default_on+notice",
    whatsapp: "opt_in(whatsapp_permission)",
    sms: "default_on+notice",
  },
};

function rows(): Array<{ label: string; category: CommunicationCategory; purpose?: PaymentPurpose }> {
  return [
    { label: "essential", category: "essential" },
    { label: "community_operational", category: "community_operational" },
    { label: "marketing", category: "marketing" },
    { label: "payment:status", category: "payment", purpose: "status" },
    { label: "payment:targeted_reminder", category: "payment", purpose: "targeted_reminder" },
  ];
}

describe("communication policy matrix (every category × channel)", () => {
  it("covers exactly the four approved categories and four channels", () => {
    assert.deepEqual([...COMMUNICATION_CATEGORIES], ["essential", "community_operational", "marketing", "payment"]);
    assert.deepEqual([...CHANNELS], ["in_app", "email", "whatsapp", "sms"]);
  });

  it("current capabilities are all off", () => {
    assert.deepEqual(CURRENT_CAPABILITIES, { paymentAttribution: false, smsApproved: false });
    assert.ok(Object.isFrozen(CURRENT_CAPABILITIES));
  });

  for (const { label, category, purpose } of rows()) {
    for (const channel of CHANNELS) {
      it(`today: ${label} × ${channel} = ${TODAY[label]![channel]}`, () => {
        assert.equal(sig(channelRequirement(category, channel, { paymentPurpose: purpose })), TODAY[label]![channel]);
      });
      it(`once approved: ${label} × ${channel} = ${FUTURE[label]![channel]}`, () => {
        assert.equal(sig(channelRequirement(category, channel, { paymentPurpose: purpose, capabilities: ALL_ON })), FUTURE[label]![channel]);
      });
    }
  }

  it("payment attribution alone does not enable SMS, and SMS approval alone does not enable payment", () => {
    assert.equal(sig(channelRequirement("payment", "sms", { paymentPurpose: "status", capabilities: { paymentAttribution: true, smsApproved: false } })), "disabled(channel_disabled)");
    assert.equal(sig(channelRequirement("payment", "email", { paymentPurpose: "status", capabilities: { paymentAttribution: false, smsApproved: true } })), "disabled(payment_attribution_unavailable)");
  });

  it("a payment event with no purpose is treated as a targeted reminder (opt-out-able), never as essential", () => {
    assert.equal(sig(channelRequirement("payment", "email", { capabilities: ALL_ON })), "default_on+notice");
  });

  it("WhatsApp is opt-in for EVERY category and capability set (R0 decision 5)", () => {
    for (const caps of [CURRENT_CAPABILITIES, ALL_ON]) {
      for (const { category, purpose } of rows()) {
        const r = channelRequirement(category, "whatsapp", { paymentPurpose: purpose, capabilities: caps });
        assert.ok(r.kind === "opt_in" || r.kind === "disabled", `${category}: ${sig(r)}`);
        if (r.kind === "opt_in") assert.ok(r.permissions.includes("whatsapp_permission"));
      }
    }
  });

  it("no category except marketing ever requires marketing consent; marketing always does (outside in-app)", () => {
    for (const caps of [CURRENT_CAPABILITIES, ALL_ON]) {
      for (const { category, purpose } of rows()) {
        for (const channel of CHANNELS) {
          const r = channelRequirement(category, channel, { paymentPurpose: purpose, capabilities: caps });
          const needs = r.kind === "opt_in" && r.permissions.includes("marketing_consent");
          if (category === "marketing") assert.ok(needs || r.kind === "disabled", `${channel}: ${sig(r)}`);
          else assert.equal(needs, false, `${category} × ${channel}`);
        }
      }
    }
  });

  it("SMS stays disabled for every category today (R0 decision 6)", () => {
    for (const { category, purpose } of rows()) {
      assert.equal(channelRequirement(category, "sms", { paymentPurpose: purpose }).kind, "disabled", category);
    }
  });
});

// ── 2. Event → category ──────────────────────────────────────────────────────

describe("event classification", () => {
  const EXPECTED: Record<string, { category: CommunicationCategory; fanout: string; topic?: string; purpose?: string }> = {
    "member.create": { category: "essential", fanout: "per_event_recipient" },
    "member.approve_join": { category: "essential", fanout: "per_event_recipient" },
    "officer_invitation.accept": { category: "essential", fanout: "per_event_recipient" },
    "officer_term.end": { category: "essential", fanout: "per_event_recipient" },
    "member.reject_join": { category: "essential", fanout: "none" },
    "member.join_via_invite": { category: "essential", fanout: "none" },
    "collection.publish": { category: "community_operational", fanout: "per_audience_member", topic: "announcement" },
    "collection.announce_update": { category: "community_operational", fanout: "per_audience_member", topic: "update" },
    "collection.remind": { category: "community_operational", fanout: "per_audience_member", topic: "reminder" },
    "collection.publish_remind_unpaid": { category: "payment", fanout: "per_audience_member", purpose: "targeted_reminder" },
    "collection.remind_unpaid": { category: "payment", fanout: "per_audience_member", purpose: "targeted_reminder" },
  };

  for (const [action, want] of Object.entries(EXPECTED)) {
    it(`${action} → ${want.category}`, () => {
      const p = eventPolicy(action)!;
      assert.ok(p, action);
      assert.equal(p.category, want.category);
      assert.equal(p.emailFanout, want.fanout);
      assert.equal(p.topic, want.topic);
      assert.equal(p.paymentPurpose, want.purpose);
    });
  }

  it("classifies exactly these events, and nothing is marketing", () => {
    assert.deepEqual([...classifiedEvents()].sort(), Object.keys(EXPECTED).sort());
    assert.ok(!classifiedEvents().some((a) => eventPolicy(a)!.category === "marketing"));
  });

  it("every watched action is classified", () => {
    for (const action of WATCHED_ACTIONS) assert.ok(eventPolicy(action), action);
  });

  it("unknown or prototype-shaped actions are unclassified and send nothing", () => {
    for (const action of ["", "member.archive", "invite_link.redeem", "toString", "__proto__", "constructor"]) {
      assert.equal(eventPolicy(action), null, action || "(empty)");
      for (const ch of CHANNELS) assert.equal(eventChannelRequirement(action, ch), null);
    }
  });

  it("payment-targeted events are blocked on every channel today", () => {
    for (const action of ["collection.publish_remind_unpaid", "collection.remind_unpaid"]) {
      for (const ch of CHANNELS) {
        assert.equal(sig(eventChannelRequirement(action, ch)!), "disabled(payment_attribution_unavailable)", `${action} × ${ch}`);
      }
    }
  });

  it("the in-app recipient plan agrees with the policy: blocked in-app ⇔ payment_status_unavailable plan", () => {
    for (const action of classifiedEvents()) {
      const blocked = eventChannelRequirement(action, "in_app")!.kind === "disabled";
      assert.equal(recipientPlan(action).kind === "payment_status_unavailable", blocked, action);
    }
  });
});

// ── 3. Derived worker vocabulary ─────────────────────────────────────────────

describe("worker eligibility derives from the policy", () => {
  it("EMAIL_EVALUATION_EVENTS = the essential per-recipient events", () => {
    assert.deepEqual([...EMAIL_EVALUATION_EVENTS].sort(), ["member.approve_join", "member.create", "officer_invitation.accept", "officer_term.end"]);
  });

  it("collectionEmailCategory returns the topic for community events and null for everything else", () => {
    assert.equal(collectionEmailCategory("collection.publish"), "announcement");
    assert.equal(collectionEmailCategory("collection.announce_update"), "update");
    assert.equal(collectionEmailCategory("collection.remind"), "reminder");
    for (const a of ["collection.publish_remind_unpaid", "collection.remind_unpaid", "member.create", "officer_term.end", "", "nope"]) {
      assert.equal(collectionEmailCategory(a), null, a || "(empty)");
    }
  });

  it("send classes: essential transactional, community bulk, marketing none, payment by purpose", () => {
    assert.equal(emailSendClass("essential"), "transactional");
    assert.equal(emailSendClass("community_operational"), "bulk");
    assert.equal(emailSendClass("marketing"), null);
    assert.equal(emailSendClass("payment", "status"), "transactional");
    assert.equal(emailSendClass("payment", "targeted_reminder"), "bulk");
    assert.equal(emailSendClass("payment"), "bulk");
    assert.equal(COLLECTION_EMAIL_SEND_CLASS, "bulk");
  });
});

// ── 4. decide(): every requirement kind × every fact combination ─────────────

describe("decide()", () => {
  const PERMS: MemberPermission[][] = [[], ["whatsapp_permission"], ["marketing_consent"], ["whatsapp_permission", "marketing_consent"]];
  const BOOLS = [false, true];

  function each(fn: (f: RecipientFacts, label: string) => void): void {
    for (const optedOut of BOOLS) {
      for (const communityNoticeAttested of BOOLS) {
        for (const permissions of PERMS) {
          fn(facts({ optedOut, communityNoticeAttested, permissions }), `optedOut=${optedOut} attested=${communityNoticeAttested} perms=[${permissions.join(",")}]`);
        }
      }
    }
  }

  it("always: sends regardless of opt-out, attestation or permissions (essential is not optional)", () => {
    each((f, l) => assert.deepEqual(decide({ kind: "always" }, f), { send: true }, l));
  });

  it("disabled: never sends, with the disabled reason", () => {
    for (const reason of ["channel_disabled", "payment_attribution_unavailable", "category_not_on_channel"] as const) {
      each((f, l) => assert.deepEqual(decide({ kind: "disabled", reason }, f), { send: false, reason }, l));
    }
  });

  it("default_on with notice: opt-out first, then attestation, then send — permissions never matter", () => {
    each((f, l) => {
      const want = f.optedOut
        ? { send: false, reason: "opted_out" }
        : !f.communityNoticeAttested
          ? { send: false, reason: "community_notice_missing" }
          : { send: true };
      assert.deepEqual(decide({ kind: "default_on", requiresCommunityNotice: true }, f), want, l);
    });
  });

  it("default_on without notice: only the opt-out matters", () => {
    each((f, l) => {
      assert.deepEqual(decide({ kind: "default_on", requiresCommunityNotice: false }, f), f.optedOut ? { send: false, reason: "opted_out" } : { send: true }, l);
    });
  });

  it("opt_in(whatsapp): sends only with the member's WhatsApp permission and no opt-out; attestation never substitutes", () => {
    each((f, l) => {
      const want = f.optedOut
        ? { send: false, reason: "opted_out" }
        : f.permissions.has("whatsapp_permission")
          ? { send: true }
          : { send: false, reason: "channel_permission_missing" };
      assert.deepEqual(decide({ kind: "opt_in", permissions: ["whatsapp_permission"] }, f), want, l);
    });
  });

  it("opt_in(marketing, whatsapp): needs BOTH; marketing consent is reported first", () => {
    each((f, l) => {
      const want = f.optedOut
        ? { send: false, reason: "opted_out" }
        : !f.permissions.has("marketing_consent")
          ? { send: false, reason: "marketing_consent_missing" }
          : !f.permissions.has("whatsapp_permission")
            ? { send: false, reason: "channel_permission_missing" }
            : { send: true };
      assert.deepEqual(decide({ kind: "opt_in", permissions: ["marketing_consent", "whatsapp_permission"] }, f), want, l);
    });
  });

  it("community membership alone (attested, no permissions) never yields WhatsApp or marketing", () => {
    const member = facts({ communityNoticeAttested: true, permissions: [] });
    for (const category of COMMUNICATION_CATEGORIES) {
      for (const caps of [CURRENT_CAPABILITIES, ALL_ON]) {
        assert.equal(decide(channelRequirement(category, "whatsapp", { capabilities: caps }), member).send, false, `${category} whatsapp`);
      }
      if (category === "marketing") {
        for (const ch of CHANNELS) assert.equal(decide(channelRequirement(category, ch, { capabilities: ALL_ON }), member).send, false, `marketing ${ch}`);
      }
    }
  });

  it("every skip reason fits the delivery error_code format", () => {
    const seen = new Set<string>();
    for (const caps of [CURRENT_CAPABILITIES, ALL_ON]) {
      for (const { category, purpose } of rows()) {
        for (const ch of CHANNELS) {
          each((f) => {
            const d = decide(channelRequirement(category, ch, { paymentPurpose: purpose, capabilities: caps }), f);
            if (!d.send) seen.add(d.reason);
          });
        }
      }
    }
    for (const r of seen) assert.match(r, /^[a-z][a-z0-9_]{2,63}$/);
    assert.ok(!seen.has("consent_missing"), "the retired universal consent gate is never a policy outcome");
  });
});

// ── 5. Collection member decision (database facts + policy) ──────────────────

describe("collectionMemberDecision()", () => {
  const ELIGIBLE = { eligible: true, address: "a@example.com", assurance: "unverified_supplied", skip_reason: null };
  const db = (skip_reason: string) => ({ eligible: false, address: null, assurance: null, skip_reason });
  const ATTESTED = { communityNoticeAttested: true };
  const NOT_ATTESTED = { communityNoticeAttested: false };
  const COMMUNITY_EVENTS = ["collection.publish", "collection.announce_update", "collection.remind"];

  for (const action of COMMUNITY_EVENTS) {
    it(`${action}: eligible + attested → send; eligible + not attested → community_notice_missing`, () => {
      assert.deepEqual(collectionMemberDecision(action, ELIGIBLE, ATTESTED), { send: true });
      assert.deepEqual(collectionMemberDecision(action, ELIGIBLE, NOT_ATTESTED), { send: false, reason: "community_notice_missing" });
    });
  }

  it("reachability and availability come before any policy question", () => {
    for (const reason of ["collection_not_reachable", "member_unavailable"]) {
      for (const f of [ATTESTED, NOT_ATTESTED]) {
        assert.deepEqual(collectionMemberDecision("collection.publish", db(reason), f), { send: false, reason });
      }
    }
  });

  it("a database matrix reason (R2 proposal) is reported as given, never sent", () => {
    for (const reason of ["category_not_on_channel", "channel_disabled", "payment_attribution_unavailable"]) {
      assert.deepEqual(collectionMemberDecision("collection.publish", db(reason), ATTESTED), { send: false, reason });
    }
  });

  it("the member's opt-out is reported before the community notice", () => {
    for (const f of [ATTESTED, NOT_ATTESTED]) {
      assert.deepEqual(collectionMemberDecision("collection.publish", db("opted_out"), f), { send: false, reason: "opted_out" });
    }
  });

  it("community_notice_missing from the database (R2) is honoured even when the worker read says attested", () => {
    assert.deepEqual(collectionMemberDecision("collection.publish", db("community_notice_missing"), ATTESTED), { send: false, reason: "community_notice_missing" });
    assert.deepEqual(collectionMemberDecision("collection.publish", db("community_notice_missing"), NOT_ATTESTED), { send: false, reason: "community_notice_missing" });
  });

  it("consent_missing from the database is never a policy outcome", () => {
    assert.deepEqual(collectionMemberDecision("collection.publish", db("consent_missing"), NOT_ATTESTED), { send: false, reason: "community_notice_missing" });
    assert.deepEqual(collectionMemberDecision("collection.publish", db("consent_missing"), ATTESTED), { send: false, reason: "legacy_consent_gate" });
  });

  it("address reasons pass through once the policy allows sending", () => {
    for (const reason of ["no_recipient", "invalid_recipient_address", "unverified_account_email"]) {
      assert.deepEqual(collectionMemberDecision("collection.publish", db(reason), ATTESTED), { send: false, reason });
      assert.deepEqual(collectionMemberDecision("collection.publish", db(reason), NOT_ATTESTED), { send: false, reason: "community_notice_missing" });
    }
  });

  it("an unknown database reason, or 'eligible' without address/assurance, is a skip, never a send", () => {
    assert.deepEqual(collectionMemberDecision("collection.publish", db("something new"), ATTESTED), { send: false, reason: "no_recipient" });
    assert.deepEqual(collectionMemberDecision("collection.publish", { ...ELIGIBLE, address: null }, ATTESTED), { send: false, reason: "no_recipient" });
    assert.deepEqual(collectionMemberDecision("collection.publish", { ...ELIGIBLE, assurance: null }, ATTESTED), { send: false, reason: "no_recipient" });
  });

  it("payment-targeted and unclassified events never send, whatever the database says", () => {
    for (const action of ["collection.publish_remind_unpaid", "collection.remind_unpaid"]) {
      assert.deepEqual(collectionMemberDecision(action, ELIGIBLE, ATTESTED), { send: false, reason: "payment_attribution_unavailable" });
    }
    assert.deepEqual(collectionMemberDecision("nope", ELIGIBLE, ATTESTED), { send: false, reason: "category_not_on_channel" });
  });
});

// ── 6. Who may record which choice (R0 decision 4) ───────────────────────────

describe("mayRecordChoice()", () => {
  it("a member may record any choice about themselves", () => {
    for (const c of ["opt_out", "opt_in", "grant_permission", "withdraw_permission"] as const) assert.equal(mayRecordChoice("member", c), true, c);
  });

  it("an organiser may record an opt-out or a withdrawal on request, never an opt-in or a grant", () => {
    assert.equal(mayRecordChoice("organiser", "opt_out"), true);
    assert.equal(mayRecordChoice("organiser", "withdraw_permission"), true);
    assert.equal(mayRecordChoice("organiser", "opt_in"), false, "an organiser never reverses a member's opt-out");
    assert.equal(mayRecordChoice("organiser", "grant_permission"), false, "an organiser never grants WhatsApp/marketing permission");
  });
});
