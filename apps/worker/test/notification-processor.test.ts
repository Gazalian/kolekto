import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processNotificationMessage } from "../src/notification-processor.ts";

/**
 * A recording stand-in for a postgres.js connection. It matches each statement by a
 * fragment of its SQL text and answers with canned rows, and records every statement
 * and its parameters, so a test can assert what the processor DID rather than what a
 * real database would have stored. (A real-database run is notification-processor.integration.test.ts.)
 */
interface Recorded {
  readonly text: string;
  readonly values: unknown[];
}

interface World {
  member?: Record<string, unknown> | null;
  community?: { slug: string; name: string } | null;
  term?: Record<string, unknown> | null;
  collection?: Record<string, unknown> | null;
  officers?: Array<{ member_id: null; user_id: string }>;
  audience?: Array<{ member_id: string; user_id: string }>;
  /** Canned answer for app.evaluate_email_eligibility. Default: skipped, no usable account link. */
  eligibility?: { eligible: boolean; address: string | null; assurance: string | null; skip_reason: string | null };
  /** Member announcements: whether the proposal's functions are installed and executable. Default: not installed. */
  announcement?: { context: boolean; eligibility: boolean; notice?: boolean; targeted?: boolean };
  /** M13.3 R1: canned answer for app.community_communication_notice_attested (R2 function). */
  attested?: boolean | null;
  /** M13.3 R3: whether notification_deliveries.communication_category exists. Default: absent. */
  categoryColumn?: boolean;
  /** Canned answer for app.collection_announcement_context. */
  context?: Record<string, unknown>;
  /** Canned answer for app.evaluate_collection_email_recipients. */
  collectionRecipients?: Array<{ member_id: string; user_id: string | null; eligible: boolean; address: string | null; assurance: string | null; skip_reason: string | null }>;
}

function fakeDb(world: World) {
  const log: Recorded[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    log.push({ text, values });
    if (text.includes("has_function_privilege")) {
      const a = world.announcement ?? { context: false, eligibility: false };
      return [{ context: a.context, eligibility: a.eligibility, notice: a.notice ?? false, targeted: a.targeted ?? false }];
    }
    if (text.includes("app.community_communication_notice_attested")) return [{ attested: world.attested ?? null }];
    if (text.includes("from pg_catalog.pg_attribute")) return [{ supported: world.categoryColumn === true }];
    if (text.includes("from app.collection_announcement_context")) return world.context ? [world.context] : [];
    if (text.includes("from app.evaluate_collection_email_recipients")) return world.collectionRecipients ?? [];
    if (text.includes("from app.evaluate_email_eligibility")) {
      return [world.eligibility ?? { eligible: false, address: null, assurance: null, skip_reason: "missing_membership_relationship" }];
    }
    if (text.includes("from public.members m join public.communities")) return world.member ? [world.member] : [];
    if (text.includes("select slug, name from public.communities")) return world.community ? [world.community] : [];
    if (text.includes("from public.officer_terms ot join public.communities")) return world.term ? [world.term] : [];
    if (text.includes("from public.collections c join public.communities")) return world.collection ? [world.collection] : [];
    if (text.includes("select id from public.notification_events")) return [{ id: "event-1" }];
    if (text.includes("from app.resolve_collection_audience")) return world.audience ?? [];
    if (text.includes("from public.officer_terms ot join public.role_permissions")) return world.officers ?? [];
    return [];
  }) as unknown as { (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>; json: (v: unknown) => unknown };
  tx.json = (v: unknown) => ({ __json: v });
  const sql = { begin: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { sql: sql as unknown as Parameters<typeof processNotificationMessage>[0], log };
}

const NOW = Date.parse("2026-10-09T12:00:00Z");
const COMMUNITY = "a2000000-0000-4000-8000-00000000000a";
const OBJ = "a4000000-0000-4000-8000-000000000001";
const USER = "a1000000-0000-4000-8000-0000000000aa";

function message(action: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    audit_log_id: "a6000000-0000-4000-8000-000000000001", community_id: COMMUNITY, action,
    actor_type: action === "member.join_via_invite" ? "member" : "officer",
    actor_user_id: USER, actor_name: "Ada Officer", object_type: action.split(".")[0], object_id: OBJ,
    after_state: null, created_at: "2026-10-09T11:59:00Z", ...patch,
  };
}

const MEMBER = { id: OBJ, full_name: "Chidi Okafor", member_code: "K/0001", user_id: null, is_imported: false, joined_via: "manual", community_slug: "kwasu", community_name: "KWASU" };

function eventInsert(log: Recorded[]): { payload: Record<string, unknown>; key: unknown } | undefined {
  const row = log.find((r) => r.text.startsWith("insert into public.notification_events"));
  if (!row) return undefined;
  const payload = (row.values.find((v) => typeof v === "object" && v !== null && "__json" in (v as object)) as { __json: Record<string, unknown> }).__json;
  return { payload, key: row.values[2] };
}

function deliveryRows(log: Recorded[]): Recorded[] {
  return log.filter((r) => r.text.startsWith("insert into public.notification_deliveries"));
}

function emailRows(log: Recorded[]): Recorded[] {
  return deliveryRows(log).filter((r) => r.text.includes("'email'"));
}

function inAppRows(log: Recorded[]): Recorded[] {
  return deliveryRows(log).filter((r) => r.text.includes("'in_app'"));
}

describe("what each action does", () => {
  it("member.create: an event, and a skipped email row when no account is linked", async () => {
    const { sql, log } = fakeDb({ member: MEMBER });
    const out = await processNotificationMessage(sql, message("member.create"), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "skipped", reason: "missing_membership_relationship" } });
    assert.equal(eventInsert(log)?.key, `member.create:${OBJ}`);
    assert.equal(eventInsert(log)?.payload["member_code"], "K/0001");
    assert.equal(inAppRows(log).length, 0);
    assert.equal(emailRows(log).length, 1, "an evaluation event always files an email row");
    assert.match(emailRows(log)[0]!.text, /'skipped'/);
  });

  it("member.create: one in-app delivery when the member does have an account", async () => {
    const { sql, log } = fakeDb({
      member: { ...MEMBER, user_id: USER },
      eligibility: { eligible: true, address: "holder@example.com", assurance: "verified_account", skip_reason: null },
    });
    const out = await processNotificationMessage(sql, message("member.create"), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 1, email: { kind: "pending" } });
    assert.equal(inAppRows(log).length, 1);
    assert.equal(emailRows(log).length, 1);
    assert.match(emailRows(log)[0]!.text, /'pending'/);
    assert.ok(emailRows(log)[0]!.values.includes("holder@example.com"), "the eligible address is stored");
    assert.ok(emailRows(log)[0]!.values.includes("verified_account"), "assurance is stored");
    assert.ok(emailRows(log)[0]!.values.includes(`membership_confirmation:${OBJ}`), "confirmations carry the shared dedupe key");
  });

  it("member.approve_join keeps its M13.1 payload keys and recipient", async () => {
    const { sql, log } = fakeDb({
      member: { ...MEMBER, user_id: USER },
      eligibility: { eligible: true, address: "holder@example.com", assurance: "verified_account", skip_reason: null },
    });
    const out = await processNotificationMessage(sql, message("member.approve_join"), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 1, email: { kind: "pending" } });
    const p = eventInsert(log)!.payload;
    for (const k of ["actor_name", "community_id", "member_name", "member_code", "community_slug"]) assert.ok(k in p, k);
    assert.equal(inAppRows(log).length, 1);
  });

  it("R1: member.join_via_invite tells the officers who admit members, never the joiner", async () => {
    const { sql, log } = fakeDb({ member: { ...MEMBER, user_id: USER, joined_via: "invite_link" }, officers: [{ member_id: null, user_id: "o1" }, { member_id: null, user_id: "o2" }] });
    const out = await processNotificationMessage(sql, message("member.join_via_invite"), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 2, email: { kind: "no_row" } });
    const recipients = deliveryRows(log).map((r) => r.values[3]);
    assert.deepEqual(recipients, ["o1", "o2"]);
    assert.ok(!recipients.includes(USER), "the joiner's own user id must not be a recipient");
    assert.ok(log.some((r) => r.values.includes("invite.approve")), "officers are chosen by the invite.approve permission");
  });

  it("member.reject_join: an event with the requester's NAME only, and no email row", async () => {
    const { sql, log } = fakeDb({ community: { slug: "kwasu", name: "KWASU" } });
    const out = await processNotificationMessage(
      sql,
      message("member.reject_join", { before_state: { full_name: "Requester Name", joined_via: "invite_link", email: "requester@example.com", phone_e164: "+2348099990001" } }),
      NOW,
    );
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "no_row" } });
    const payload = eventInsert(log)!.payload;
    assert.equal(payload["member_name"], "Requester Name");
    const json = JSON.stringify(payload);
    assert.ok(!json.includes("requester@example.com") && !json.includes("2348099990001"), "no address or phone in the event payload");
    assert.ok(!log.some((r) => r.text.includes("from public.members")), "the deleted member row is not queried");
    assert.ok(!log.some((r) => r.text.includes("evaluate_email_eligibility")), "rejections are not email-evaluated (R-E3 final: no rejection mail)");
    assert.equal(emailRows(log).length, 0, "no email row for a rejection");
  });

  it("officer_invitation.accept and officer_term.end: one in-app delivery to the officer whose term it is", async () => {
    for (const action of ["officer_invitation.accept", "officer_term.end"]) {
      const { sql, log } = fakeDb({
        term: { user_id: USER, role: "admin", end_reason: "removed", community_slug: "kwasu", community_name: "KWASU" },
        eligibility: { eligible: true, address: "officer@example.com", assurance: "verified_account", skip_reason: null },
      });
      const out = await processNotificationMessage(sql, message(action, { object_type: "officer_term" }), NOW);
      assert.deepEqual(out, { outcome: "processed", deliveries: 1, email: { kind: "pending" } }, action);
      assert.equal(deliveryRows(log)[0]?.values[3], USER, action);
      assert.equal(eventInsert(log)!.payload["officer_role"], "admin", action);
      assert.equal(emailRows(log).length, 1, `${action}: one email row`);
      assert.ok(!emailRows(log)[0]!.values.some((v) => typeof v === "string" && v.startsWith("membership_confirmation:")), `${action}: officer notices carry no membership dedupe key`);
    }
  });

  it("collection.publish without the announcement functions installed: in-app as before, no email row, payload unchanged", async () => {
    const { sql, log } = fakeDb({ collection: { name: "Dues", slug: "dues", community_slug: "kwasu" }, audience: [{ member_id: "m1", user_id: "u1" }, { member_id: "m2", user_id: "u2" }] });
    const out = await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 2, email: { kind: "collection_unavailable" } });
    assert.deepEqual(Object.keys(eventInsert(log)!.payload).sort(), ["actor_name", "collection_name", "collection_slug", "community_id", "community_slug"]);
    assert.equal(emailRows(log).length, 0, "no email row until the eligibility function exists");
    assert.ok(!log.some((r) => r.text.includes("from app.evaluate_collection_email_recipients")), "the missing function is never called");
  });
});

describe("what is skipped, and that skipping touches nothing", () => {
  async function skipped(msg: Record<string, unknown>, world: World = {}) {
    const { sql, log } = fakeDb(world);
    const out = await processNotificationMessage(sql, msg, NOW);
    return { out, log };
  }

  it("a system actor on a membership action", async () => {
    const { out, log } = await skipped(message("member.create", { actor_type: "system" }), { member: MEMBER });
    assert.deepEqual(out, { outcome: "skipped", reason: "not_a_person_action" });
    assert.equal(log.length, 0, "no SQL at all was run");
  });

  it("a message older than 72 hours", async () => {
    const { out, log } = await skipped(message("member.create", { created_at: "2026-10-05T11:00:00Z" }), { member: MEMBER });
    assert.deepEqual(out, { outcome: "skipped", reason: "event_too_old" });
    assert.equal(log.length, 0);
  });

  it("an unwatched action, and a malformed message — neither throws", async () => {
    assert.deepEqual((await skipped(message("member.restore"))).out, { outcome: "skipped", reason: "unwatched_action" });
    assert.deepEqual((await skipped({ garbage: true })).out, { outcome: "skipped", reason: "invalid_message" });
    assert.deepEqual((await skipped({ ...message("member.create"), object_id: "nope" })).out, { outcome: "skipped", reason: "invalid_message" });
  });

  it("an imported or migrated member: no event, no delivery", async () => {
    for (const member of [{ ...MEMBER, is_imported: true }, { ...MEMBER, joined_via: "migration" }]) {
      const { out, log } = await skipped(message("member.create"), { member });
      assert.deepEqual(out, { outcome: "skipped", reason: "imported_member" });
      assert.ok(!log.some((r) => r.text.startsWith("insert")), "nothing was inserted");
    }
  });

  it("an archived or merged member (decision record F-3): no event, no delivery", async () => {
    for (const member of [{ ...MEMBER, status: "archived", user_id: USER }, { ...MEMBER, status: "merged", user_id: USER }, { ...MEMBER, archived_at: "2026-10-09T10:00:00Z", user_id: USER }, { ...MEMBER, merged_into_id: "a5000000-0000-4000-8000-000000000009", user_id: USER }]) {
      for (const action of ["member.create", "member.approve_join", "member.join_via_invite"]) {
        const { out, log } = await skipped(message(action), { member });
        assert.deepEqual(out, { outcome: "skipped", reason: "member_unavailable" }, `${action} / ${JSON.stringify(member).slice(-60)}`);
        assert.ok(!log.some((r) => r.text.startsWith("insert")), action);
      }
    }
  });

  it("but a pending-approval joiner IS available: officers must still be told someone applied", async () => {
    const { out } = await skipped(message("member.join_via_invite"), { member: { ...MEMBER, status: "pending_approval", joined_via: "invite_link" }, officers: [{ member_id: null, user_id: "o1" }] });
    assert.deepEqual(out, { outcome: "processed", deliveries: 1, email: { kind: "no_row" } });
  });
  it("a member who no longer exists (rejected or deleted before processing)", async () => {
    for (const action of ["member.create", "member.approve_join", "member.join_via_invite"]) {
      const { out, log } = await skipped(message(action), { member: null });
      assert.deepEqual(out, { outcome: "skipped", reason: "member_unavailable" }, action);
      assert.ok(!log.some((r) => r.text.startsWith("insert")), action);
    }
  });
});

describe("P4 email rows: evaluation events file one, everything else files none", () => {
  const ELIGIBLE = { eligible: true, address: "holder@example.com", assurance: "verified_account", skip_reason: null };

  it("eligible membership confirmations: pending with address, assurance and the shared dedupe key", async () => {
    for (const action of ["member.create", "member.approve_join"]) {
      const { sql, log } = fakeDb({ member: { ...MEMBER, user_id: USER }, eligibility: ELIGIBLE });
      const out = await processNotificationMessage(sql, message(action), NOW);
      if (out.outcome !== "processed") throw new Error(`expected processed for ${action}`);
      assert.deepEqual(out.email, { kind: "pending" }, action);
      assert.equal(emailRows(log).length, 1, action);
      const row = emailRows(log)[0]!;
      assert.match(row.text, /'email', 'pending'/, action);
      assert.ok(row.values.includes("holder@example.com") && row.values.includes("verified_account"), action);
      assert.ok(row.values.includes(`membership_confirmation:${OBJ}`), `${action}: shared dedupe key`);
      assert.match(row.text, /on conflict do nothing/, `${action}: replay-safe insert`);
    }
  });

  it("ineligible evaluations: skipped with a stable reason and no stored address", async () => {
    const { sql, log } = fakeDb({
      member: { ...MEMBER, user_id: USER },
      eligibility: { eligible: false, address: null, assurance: null, skip_reason: "unverified_account_email" },
    });
    const out = await processNotificationMessage(sql, message("member.create"), NOW);
    if (out.outcome !== "processed") throw new Error("expected processed");
    assert.deepEqual(out.email, { kind: "skipped", reason: "unverified_account_email" });
    assert.equal(emailRows(log).length, 1);
    const row = emailRows(log)[0]!;
    assert.match(row.text, /'email', 'skipped'/);
    assert.ok(row.values.includes("unverified_account_email"), "the stable reason is stored");
    assert.ok(!row.values.some((v) => typeof v === "string" && v.includes("@")), "no address on a skipped row");
    assert.ok(!row.values.some((v) => typeof v === "string" && v.startsWith("membership_confirmation:")), "no dedupe key on a skipped row");
    assert.equal(inAppRows(log).length, 1, "the email skip leaves the valid in-app delivery intact");
  });

  it("non-evaluation events: no email row and no eligibility call", async () => {
    const cases: Array<[string, World, Record<string, unknown>]> = [
      ["member.join_via_invite", { member: MEMBER, officers: [{ member_id: null as null, user_id: "o1" }] }, {}],
      ["member.reject_join", { community: { slug: "k", name: "K" } }, { before_state: { full_name: "R", joined_via: "invite_link", email: "r@example.com" } }],
    ];
    for (const [action, world, patch] of cases) {
      const { sql, log } = fakeDb(world);
      const out = await processNotificationMessage(sql, message(action, patch), NOW);
      if (out.outcome !== "processed") throw new Error(`expected processed for ${action}`);
      assert.deepEqual(out.email, { kind: "no_row" }, action);
      assert.equal(emailRows(log).length, 0, action);
      assert.ok(!log.some((r) => r.text.includes("evaluate_email_eligibility")), action);
    }
  });
  const ALL = [
    ["member.create", { member: { ...MEMBER, user_id: USER } }],
    ["member.approve_join", { member: { ...MEMBER, user_id: USER } }],
    ["member.join_via_invite", { member: MEMBER, officers: [{ member_id: null as null, user_id: "o1" }] }],
    ["member.reject_join", { community: { slug: "k", name: "K" } }],
    ["officer_invitation.accept", { term: { user_id: USER, role: "admin", end_reason: null, community_slug: "k", community_name: "K" } }],
    ["officer_term.end", { term: { user_id: USER, role: "admin", end_reason: "removed", community_slug: "k", community_name: "K" } }],
    ["collection.publish", { collection: { name: "D", slug: "d", community_slug: "k" }, audience: [{ member_id: "m", user_id: "u" }] }],
  ] as const;

  it("every in-app delivery the processor inserts is still in_app", async () => {
    let total = 0;
    for (const [action, world] of ALL) {
      const { sql, log } = fakeDb(world as World);
      await processNotificationMessage(sql, message(action, { before_state: { full_name: "R", joined_via: "invite_link", email: "r@example.com" } }), NOW);
      for (const d of inAppRows(log)) {
        total += 1;
        assert.match(d.text, /'in_app'/, `${action}: channel is the literal in_app`);
      }
      for (const d of emailRows(log)) {
        assert.match(d.text, /'email', '(pending|skipped)'/, `${action}: email rows are pending or skipped only`);
      }
    }
    assert.ok(total >= 5, "the scenarios did exercise real deliveries");
  });

  it("no event payload contains an address, for any action, even when one is handed to it", async () => {
    for (const [action, world] of ALL) {
      const { sql, log } = fakeDb(world as World);
      await processNotificationMessage(sql, message(action, { before_state: { full_name: "bob@example.com", joined_via: "invite_link", email: "typed@example.com" } }), NOW);
      const ev = eventInsert(log);
      if (ev) assert.ok(!JSON.stringify(ev.payload).includes("@"), `${action}: ${JSON.stringify(ev.payload)}`);
    }
  });
});

describe("replay safety", () => {
  it("the event insert and the delivery insert are both idempotent statements", async () => {
    const { sql, log } = fakeDb({
      member: { ...MEMBER, user_id: USER },
      eligibility: { eligible: true, address: "holder@example.com", assurance: "verified_account", skip_reason: null },
    });
    await processNotificationMessage(sql, message("member.approve_join"), NOW);
    assert.match(log.find((r) => r.text.startsWith("insert into public.notification_events"))!.text, /on conflict \(event_key\) do nothing/);
    assert.match(inAppRows(log)[0]!.text, /on conflict \( notification_event_id, coalesce\( recipient_member_id, recipient_user_id,/);
    assert.match(emailRows(log)[0]!.text, /on conflict do nothing/, "the email insert dedupes replays and shared confirmation keys");
  });

  it("processing the same message twice issues the same statements twice (the database dedupes)", async () => {
    const a = fakeDb({ member: { ...MEMBER, user_id: USER } });
    const b = fakeDb({ member: { ...MEMBER, user_id: USER } });
    await processNotificationMessage(a.sql, message("member.approve_join"), NOW);
    await processNotificationMessage(b.sql, message("member.approve_join"), NOW);
    assert.deepEqual(a.log.map((r) => r.text), b.log.map((r) => r.text));
  });
});

/**
 * Moved from test/integration/notification-sender-mailpit.integration.test.ts (M13.2 Phase 1c;
 * review F13 / §4.3). parseAuditMessage and admission() return before any SQL, so these never
 * needed a database. Titles are the integration file's; the inputs are the same messages. Each
 * test now also proves that no statement at all was issued — a stronger assertion than the
 * integration version, which could only check the returned outcome.
 */
describe("P8 processor skip decisions (moved from the sender-to-Mailpit integration file)", () => {
  async function run(msg: Record<string, unknown>) {
    const { sql, log } = fakeDb({ member: MEMBER });
    const out = await processNotificationMessage(sql, msg, NOW);
    return { out, log };
  }

  it("E1: unknown event type produces no email delivery row", async () => {
    const { out, log } = await run(message("unknown.action.type"));
    assert.deepEqual(out, { outcome: "skipped", reason: "unwatched_action" });
    assert.equal(log.length, 0, "no SQL at all: no event, no delivery row");
  });

  it("E2: invalid/malformed message is skipped, not thrown", async () => {
    const { out, log } = await run({ garbage: true, no_fields: "at all" });
    assert.deepEqual(out, { outcome: "skipped", reason: "invalid_message" });
    assert.equal(log.length, 0);
  });

  it("E3: empty payload message is skipped", async () => {
    const { out, log } = await run({});
    assert.deepEqual(out, { outcome: "skipped", reason: "invalid_message" });
    assert.equal(log.length, 0);
  });

  it("E8: event too old (>72h) is skipped by the processor", async () => {
    const { out, log } = await run(message("member.create", { created_at: new Date(NOW - 73 * 60 * 60 * 1000).toISOString() }));
    assert.deepEqual(out, { outcome: "skipped", reason: "event_too_old" });
    assert.equal(log.length, 0);
  });
});

// ── Member announcements ─────────────────────────────────────────────────────

describe("member announcements: collection email to member records", () => {
  const COLLECTION = { name: "Annual Dues", slug: "annual-dues", community_slug: "kwasu" };
  const CONTEXT = {
    community_name: "KWASU Alumni",
    description_excerpt: "Dues for 2027. Questions: treasurer@example.com",
    amount_model: "fixed",
    fixed_amount_kobo: "500000",
    deadline_at: new Date("2026-12-31T22:59:00Z"),
  };
  const RECIPIENTS = [
    // A member with NO account and consent: reached through the member record.
    { member_id: "m-noaccount", user_id: null, eligible: true, address: "chidi@example.com", assurance: "unverified_supplied", skip_reason: null },
    // An account holder: confirmed account address.
    { member_id: "m-account", user_id: "u-account", eligible: true, address: "holder@example.com", assurance: "verified_account", skip_reason: null },
    { member_id: "m-noconsent", user_id: null, eligible: false, address: null, assurance: null, skip_reason: "consent_missing" },
    { member_id: "m-optout", user_id: null, eligible: false, address: null, assurance: null, skip_reason: "opted_out" },
    { member_id: "m-noemail", user_id: null, eligible: false, address: null, assurance: null, skip_reason: "no_recipient" },
    { member_id: "m-bademail", user_id: null, eligible: false, address: null, assurance: null, skip_reason: "invalid_recipient_address" },
  ];
  // The community notice attestation (R2 function) present and positive, so
  // the per-member facts decide. Cases without it are in the M13.3 suite below.
  const installed = {
    announcement: { context: true, eligibility: true, notice: true },
    attested: true,
    context: CONTEXT,
    collection: COLLECTION,
  };

  it("publish: one email row per audience member — pending for the eligible (account or not), skipped with a stable reason otherwise", async () => {
    const { sql, log } = fakeDb({ ...installed, audience: [{ member_id: "m-account", user_id: "u-account" }], collectionRecipients: RECIPIENTS });
    const out = await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 1, email: { kind: "collection", pending: 2, skipped: 4 } });

    const rows = emailRows(log);
    assert.equal(rows.length, RECIPIENTS.length, "exactly one email row per member");
    const pending = rows.filter((r) => /'pending'/.test(r.text));
    const skipped = rows.filter((r) => /'skipped'/.test(r.text));
    assert.equal(pending.length, 2);
    assert.equal(skipped.length, 4);

    const noAccount = pending.find((r) => r.values.includes("m-noaccount"))!;
    assert.ok(noAccount, "a member without an account gets a pending email");
    assert.ok(noAccount.values.includes("chidi@example.com"));
    assert.ok(noAccount.values.includes("unverified_supplied"));
    assert.ok(noAccount.values.includes(null), "no user id is needed");
    for (const r of rows) assert.ok(r.values.includes("bulk"), "collection email is classed bulk, never transactional");

    for (const r of skipped) {
      assert.ok(!r.values.some((v) => typeof v === "string" && v.includes("@")), "no address on a skipped row");
    }
    const reasons = skipped.map((r) => r.values.find((v) => typeof v === "string" && /^[a-z_]+$/.test(v) && v !== "bulk"));
    // M13.3 R1: consent is not a policy requirement for community email. The
    // database proposal still withholds that member's address for consent, so
    // the row is filed as legacy_consent_gate — never as consent_missing.
    assert.deepEqual(reasons.sort(), ["invalid_recipient_address", "legacy_consent_gate", "no_recipient", "opted_out"]);

    const evalCall = log.find((r) => r.text.includes("from app.evaluate_collection_email_recipients"))!;
    assert.deepEqual(evalCall.values, [OBJ, "announcement"], "publish is an announcement");
    assert.ok(!log.some((r) => r.text.includes("evaluate_email_eligibility")), "the membership eligibility path is not used");
  });

  it("publish: the payload carries collection facts — redacted description, kobo as a digit string, ISO deadline", async () => {
    const { sql, log } = fakeDb({ ...installed, collectionRecipients: [] });
    await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    const p = eventInsert(log)!.payload;
    assert.equal(p["community_name"], "KWASU Alumni");
    assert.equal(p["collection_description"], "Dues for 2027. Questions: [email removed]");
    assert.equal(p["amount_model"], "fixed");
    assert.equal(p["fixed_amount_kobo"], "500000");
    assert.equal(p["deadline_at"], "2026-12-31T22:59:00.000Z");
    assert.ok(!("changed_fields" in p), "only an update announcement carries changed_fields");
    assert.ok(!JSON.stringify(p).includes("@"), "no email-shaped text anywhere in the payload");
  });

  it("a replayed message reuses the event and inserts idempotently (ON CONFLICT DO NOTHING on every row)", async () => {
    const { sql, log } = fakeDb({ ...installed, collectionRecipients: RECIPIENTS });
    await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    for (const r of emailRows(log)) assert.match(r.text, /on conflict do nothing/);
    assert.equal(eventInsert(log)?.key, `collection.publish:${OBJ}`, "one publish event per collection");
  });

  it("collection.remind is a 'reminder' and makes no payment claim in its plan", async () => {
    const { sql, log } = fakeDb({ ...installed, collectionRecipients: RECIPIENTS.slice(0, 1) });
    const out = await processNotificationMessage(sql, message("collection.remind", { object_type: "collection" }), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "collection", pending: 1, skipped: 0 } });
    assert.deepEqual(log.find((r) => r.text.includes("from app.evaluate_collection_email_recipients"))!.values, [OBJ, "reminder"]);
  });

  it("collection.announce_update is watched: it fans out a collection email per audience member (untargeted when no target is set)", async () => {
    const { sql, log } = fakeDb({ ...installed, collectionRecipients: RECIPIENTS.slice(0, 1) });
    const out = await processNotificationMessage(
      sql,
      message("collection.announce_update", { object_type: "collection", after_state: { changed_fields: ["deadline"] } }),
      NOW,
    );
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "collection", pending: 1, skipped: 0 } });
    // No target_audience in the audit row → the untargeted evaluator, category "update".
    assert.deepEqual(
      log.find((r) => r.text.includes("from app.evaluate_collection_email_recipients("))!.values,
      [OBJ, "update"],
    );
    assert.ok(
      !log.some((r) => r.text.includes("from app.evaluate_collection_email_recipients_targeted(")),
      "no target set → the targeted evaluator is not called",
    );
  });

  it("collection.announce_update with a group target uses the targeted evaluator when it is installed", async () => {
    const GROUP = "a7000000-0000-4000-8000-000000000001";
    const { sql, log } = fakeDb({
      ...installed,
      announcement: { context: true, eligibility: true, notice: true, targeted: true },
      collectionRecipients: RECIPIENTS.slice(0, 1),
    });
    const out = await processNotificationMessage(
      sql,
      message("collection.announce_update", {
        object_type: "collection",
        after_state: { changed_fields: ["deadline"], target_audience: "groups", target_group_ids: [GROUP] },
      }),
      NOW,
    );
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "collection", pending: 1, skipped: 0 } });
    const call = log.find((r) => r.text.includes("from app.evaluate_collection_email_recipients_targeted("))!;
    assert.ok(call, "the targeted evaluator is called");
    assert.deepEqual(call.values, [OBJ, "update", "groups", [GROUP]]);
  });

  it("collection.announce_update ignores a target when the targeted evaluator is NOT installed (falls back to the whole audience)", async () => {
    const { sql, log } = fakeDb({
      ...installed, // announcement.targeted defaults to false
      collectionRecipients: RECIPIENTS.slice(0, 1),
    });
    const out = await processNotificationMessage(
      sql,
      message("collection.announce_update", {
        object_type: "collection",
        after_state: { changed_fields: ["deadline"], target_audience: "groups", target_group_ids: ["a7000000-0000-4000-8000-000000000001"] },
      }),
      NOW,
    );
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "collection", pending: 1, skipped: 0 } });
    assert.ok(
      !log.some((r) => r.text.includes("from app.evaluate_collection_email_recipients_targeted(")),
      "targeted function absent → never called, no aborted transaction",
    );
  });

  it("an unexpected skip reason from the database is still a skip, never a send", async () => {
    const { sql, log } = fakeDb({ ...installed, collectionRecipients: [{ member_id: "m", user_id: null, eligible: false, address: null, assurance: null, skip_reason: "something new" }] });
    await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    const row = emailRows(log)[0]!;
    assert.match(row.text, /'skipped'/);
    assert.ok(row.values.includes("no_recipient"));
  });

  it("an 'eligible' row without an address is filed as skipped, not pending", async () => {
    const { sql, log } = fakeDb({ ...installed, collectionRecipients: [{ member_id: "m", user_id: null, eligible: true, address: null, assurance: null, skip_reason: null }] });
    await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    assert.match(emailRows(log)[0]!.text, /'skipped'/);
  });
});

// ── M13.3 R1: central communication policy in the processor ──────────────────

describe("M13.3 R1: community email follows the central policy, not a consent gate", () => {
  const COLLECTION = { name: "Annual Dues", slug: "annual-dues", community_slug: "kwasu" };
  const ELIGIBLE = { member_id: "m-ok", user_id: null, eligible: true, address: "ok@example.com", assurance: "unverified_supplied", skip_reason: null };
  const OPTED_OUT = { member_id: "m-out", user_id: null, eligible: false, address: null, assurance: null, skip_reason: "opted_out" };
  const NO_CONSENT = { member_id: "m-nc", user_id: null, eligible: false, address: null, assurance: null, skip_reason: "consent_missing" };
  const UNREACHABLE = { member_id: "m-ur", user_id: null, eligible: false, address: null, assurance: null, skip_reason: "collection_not_reachable" };

  function reasonOf(r: Recorded): unknown {
    return r.values.find((v) => typeof v === "string" && /^[a-z_]+$/.test(v) && v !== "bulk");
  }

  it("attestation function not installed: every member is skipped community_notice_missing (or their own opt-out); nothing pending; no address stored", async () => {
    const { sql, log } = fakeDb({
      announcement: { context: true, eligibility: true },
      collection: COLLECTION,
      collectionRecipients: [ELIGIBLE, OPTED_OUT, NO_CONSENT],
    });
    const out = await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "collection", pending: 0, skipped: 3 } });
    const rows = emailRows(log);
    assert.ok(rows.every((r) => /'skipped'/.test(r.text)));
    assert.ok(!rows.some((r) => r.values.some((v) => typeof v === "string" && v.includes("@"))), "no address on any row");
    const byMember = Object.fromEntries(rows.map((r) => [r.values.find((v) => typeof v === "string" && v.startsWith("m-")), reasonOf(r)]));
    assert.deepEqual(byMember, { "m-ok": "community_notice_missing", "m-out": "opted_out", "m-nc": "community_notice_missing" });
    assert.ok(!log.some((r) => r.text.includes("select app.community_communication_notice_attested")), "a missing function is never called");
  });

  it("attestation function installed but the community has not attested: no pending rows", async () => {
    const { sql, log } = fakeDb({
      announcement: { context: true, eligibility: true, notice: true },
      attested: false,
      collection: COLLECTION,
      collectionRecipients: [ELIGIBLE],
    });
    await processNotificationMessage(sql, message("collection.remind", { object_type: "collection" }), NOW);
    const call = log.find((r) => r.text.includes("select app.community_communication_notice_attested"))!;
    assert.deepEqual(call.values, [COMMUNITY], "attestation is asked for the event's community");
    assert.equal(reasonOf(emailRows(log)[0]!), "community_notice_missing");
  });

  it("a NULL attestation answer is treated as not attested", async () => {
    const { sql, log } = fakeDb({
      announcement: { context: true, eligibility: true, notice: true },
      attested: null,
      collection: COLLECTION,
      collectionRecipients: [ELIGIBLE],
    });
    await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    assert.match(emailRows(log)[0]!.text, /'skipped'/);
  });

  it("attested community: an eligible member without any consent record is pending — consent is not required", async () => {
    const { sql, log } = fakeDb({
      announcement: { context: true, eligibility: true, notice: true },
      attested: true,
      collection: COLLECTION,
      collectionRecipients: [ELIGIBLE, UNREACHABLE],
    });
    const out = await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "collection", pending: 1, skipped: 1 } });
    const unreachable = emailRows(log).find((r) => r.values.includes("m-ur"))!;
    assert.equal(reasonOf(unreachable), "collection_not_reachable", "reachability is decided before the policy");
  });

  it("consent_missing is never stored on a collection email row, in any scenario", async () => {
    for (const attested of [true, false, null]) {
      const { sql, log } = fakeDb({
        announcement: { context: true, eligibility: true, notice: true },
        attested,
        collection: COLLECTION,
        collectionRecipients: [NO_CONSENT],
      });
      await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
      assert.ok(!emailRows(log).some((r) => r.values.includes("consent_missing")), `attested=${String(attested)}`);
    }
  });

  it("essential membership confirmation is unchanged: no attestation is asked, transactional class", async () => {
    const { sql, log } = fakeDb({
      member: MEMBER,
      eligibility: { eligible: true, address: "chidi@example.com", assurance: "unverified_supplied", skip_reason: null },
    });
    const out = await processNotificationMessage(sql, message("member.create"), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "pending" } });
    assert.match(emailRows(log)[0]!.text, /'transactional'/);
    assert.ok(!log.some((r) => r.text.includes("notice_attested")));
  });
});

// ── M13.3 R3: the worker records the communication category ───────────────────

describe("M13.3 R3: communication_category on new email deliveries", () => {
  const COLLECTION = { name: "Dues", slug: "dues", community_slug: "kwasu" };
  const ROWS = [
    { member_id: "m-ok", user_id: null, eligible: true, address: "ok@example.com", assurance: "unverified_supplied", skip_reason: null },
    { member_id: "m-out", user_id: null, eligible: false, address: null, assurance: null, skip_reason: "opted_out" },
  ];
  const withCategory = (r: Recorded) => r.text.includes("communication_category");

  it("collection email rows carry community_operational when the column exists", async () => {
    const { sql, log } = fakeDb({ announcement: { context: true, eligibility: true, notice: true }, attested: true, collection: COLLECTION, collectionRecipients: ROWS, categoryColumn: true });
    const out = await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "collection", pending: 1, skipped: 1 } });
    const rows = emailRows(log);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(withCategory(r), "the insert names the column");
      assert.ok(r.values.includes("community_operational"), "and stores the policy category");
    }
  });

  it("membership confirmations carry essential when the column exists", async () => {
    const { sql, log } = fakeDb({
      member: MEMBER,
      eligibility: { eligible: true, address: "chidi@example.com", assurance: "unverified_supplied", skip_reason: null },
      categoryColumn: true,
    });
    await processNotificationMessage(sql, message("member.create"), NOW);
    const [row] = emailRows(log);
    assert.ok(row && withCategory(row) && row.values.includes("essential"));
  });

  it("a skipped confirmation carries essential too", async () => {
    const { sql, log } = fakeDb({ member: MEMBER, categoryColumn: true });
    await processNotificationMessage(sql, message("member.create"), NOW);
    const [row] = emailRows(log);
    assert.ok(row && /'skipped'/.test(row.text) && row.values.includes("essential"));
  });

  it("without the column the inserts are exactly the pre-R3 statements (no category, nothing inferred)", async () => {
    const { sql, log } = fakeDb({ announcement: { context: true, eligibility: true, notice: true }, attested: true, collection: COLLECTION, collectionRecipients: ROWS });
    await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    assert.ok(emailRows(log).length === 2 && emailRows(log).every((r) => !withCategory(r)));
  });
});

describe("payment-status targeting is disabled", () => {
  for (const action of ["collection.publish_remind_unpaid", "collection.remind_unpaid"]) {
    it(`${action}: the event is recorded, nobody is told — no in-app row, no email row, no recipient query`, async () => {
      const { sql, log } = fakeDb({
        announcement: { context: true, eligibility: true },
        collection: { name: "D", slug: "d", community_slug: "k" },
        audience: [{ member_id: "m", user_id: "u" }],
        collectionRecipients: [{ member_id: "m", user_id: null, eligible: true, address: "a@example.com", assurance: "unverified_supplied", skip_reason: null }],
      });
      const out = await processNotificationMessage(sql, message(action, { object_type: "collection" }), NOW);
      assert.deepEqual(out, { outcome: "processed", deliveries: 0, email: { kind: "no_row" } });
      assert.ok(eventInsert(log), "the event row is kept for the audit trail");
      assert.equal(deliveryRows(log).length, 0);
      assert.ok(!log.some((r) => r.text.includes("from public.obligations")), "obligation status is never used as payment status");
      assert.ok(!log.some((r) => r.text.includes("from app.evaluate_collection_email_recipients")));
      assert.ok(!log.some((r) => r.text.includes("resolve_collection_audience")));
    });
  }
});
