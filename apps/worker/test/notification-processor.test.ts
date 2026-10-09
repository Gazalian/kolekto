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
}

function fakeDb(world: World) {
  const log: Recorded[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    log.push({ text, values });
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

describe("what each action does", () => {
  it("member.create: an event, and no delivery when the member has no account", async () => {
    const { sql, log } = fakeDb({ member: MEMBER });
    const out = await processNotificationMessage(sql, message("member.create"), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 0 });
    assert.equal(eventInsert(log)?.key, `member.create:${OBJ}`);
    assert.equal(eventInsert(log)?.payload["member_code"], "K/0001");
    assert.equal(deliveryRows(log).length, 0);
  });

  it("member.create: one in-app delivery when the member does have an account", async () => {
    const { sql, log } = fakeDb({ member: { ...MEMBER, user_id: USER } });
    const out = await processNotificationMessage(sql, message("member.create"), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 1 });
    assert.equal(deliveryRows(log).length, 1);
  });

  it("member.approve_join keeps its M13.1 payload keys and recipient", async () => {
    const { sql, log } = fakeDb({ member: { ...MEMBER, user_id: USER } });
    await processNotificationMessage(sql, message("member.approve_join"), NOW);
    const p = eventInsert(log)!.payload;
    for (const k of ["actor_name", "community_id", "member_name", "member_code", "community_slug"]) assert.ok(k in p, k);
    assert.equal(deliveryRows(log).length, 1);
  });

  it("R1: member.join_via_invite tells the officers who admit members, never the joiner", async () => {
    const { sql, log } = fakeDb({ member: { ...MEMBER, user_id: USER, joined_via: "invite_link" }, officers: [{ member_id: null, user_id: "o1" }, { member_id: null, user_id: "o2" }] });
    const out = await processNotificationMessage(sql, message("member.join_via_invite"), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 2 });
    const recipients = deliveryRows(log).map((r) => r.values[3]);
    assert.deepEqual(recipients, ["o1", "o2"]);
    assert.ok(!recipients.includes(USER), "the joiner's own user id must not be a recipient");
    assert.ok(log.some((r) => r.values.includes("invite.approve")), "officers are chosen by the invite.approve permission");
  });

  it("member.reject_join: an event with the requester's NAME only, and no delivery", async () => {
    const { sql, log } = fakeDb({ community: { slug: "kwasu", name: "KWASU" } });
    const out = await processNotificationMessage(
      sql,
      message("member.reject_join", { before_state: { full_name: "Requester Name", joined_via: "invite_link", email: "requester@example.com", phone_e164: "+2348099990001" } }),
      NOW,
    );
    assert.deepEqual(out, { outcome: "processed", deliveries: 0 });
    const payload = eventInsert(log)!.payload;
    assert.equal(payload["member_name"], "Requester Name");
    const json = JSON.stringify(payload);
    assert.ok(!json.includes("requester@example.com") && !json.includes("2348099990001"), "no address or phone in the event payload");
    assert.ok(!log.some((r) => r.text.includes("from public.members")), "the deleted member row is not queried");
  });

  it("officer_invitation.accept and officer_term.end: one in-app delivery to the officer whose term it is", async () => {
    for (const action of ["officer_invitation.accept", "officer_term.end"]) {
      const { sql, log } = fakeDb({ term: { user_id: USER, role: "admin", end_reason: "removed", community_slug: "kwasu", community_name: "KWASU" } });
      const out = await processNotificationMessage(sql, message(action, { object_type: "officer_term" }), NOW);
      assert.deepEqual(out, { outcome: "processed", deliveries: 1 }, action);
      assert.equal(deliveryRows(log)[0]?.values[3], USER, action);
      assert.equal(eventInsert(log)!.payload["officer_role"], "admin", action);
    }
  });

  it("collection.publish: unchanged — audience members who have accounts", async () => {
    const { sql, log } = fakeDb({ collection: { name: "Dues", slug: "dues", community_slug: "kwasu" }, audience: [{ member_id: "m1", user_id: "u1" }, { member_id: "m2", user_id: "u2" }] });
    const out = await processNotificationMessage(sql, message("collection.publish", { object_type: "collection" }), NOW);
    assert.deepEqual(out, { outcome: "processed", deliveries: 2 });
    assert.equal(eventInsert(log)!.payload["collection_name"], "Dues");
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
    assert.deepEqual(out, { outcome: "processed", deliveries: 1 });
  });
  it("a member who no longer exists (rejected or deleted before processing)", async () => {
    for (const action of ["member.create", "member.approve_join", "member.join_via_invite"]) {
      const { out, log } = await skipped(message(action), { member: null });
      assert.deepEqual(out, { outcome: "skipped", reason: "member_unavailable" }, action);
      assert.ok(!log.some((r) => r.text.startsWith("insert")), action);
    }
  });
});

describe("P3 writes no email delivery row", () => {
  const ALL = [
    ["member.create", { member: { ...MEMBER, user_id: USER } }],
    ["member.approve_join", { member: { ...MEMBER, user_id: USER } }],
    ["member.join_via_invite", { member: MEMBER, officers: [{ member_id: null as null, user_id: "o1" }] }],
    ["member.reject_join", { community: { slug: "k", name: "K" } }],
    ["officer_invitation.accept", { term: { user_id: USER, role: "admin", end_reason: null, community_slug: "k", community_name: "K" } }],
    ["officer_term.end", { term: { user_id: USER, role: "admin", end_reason: "removed", community_slug: "k", community_name: "K" } }],
    ["collection.publish", { collection: { name: "D", slug: "d", community_slug: "k" }, audience: [{ member_id: "m", user_id: "u" }] }],
  ] as const;

  it("every delivery the processor inserts is in_app, for every action", async () => {
    let total = 0;
    for (const [action, world] of ALL) {
      const { sql, log } = fakeDb(world as World);
      await processNotificationMessage(sql, message(action, { before_state: { full_name: "R", joined_via: "invite_link", email: "r@example.com" } }), NOW);
      for (const d of deliveryRows(log)) {
        total += 1;
        assert.match(d.text, /'in_app'/, `${action}: channel is the literal in_app`);
        assert.doesNotMatch(d.text, /'email'|'whatsapp'|'sms'/i, action);
        assert.ok(!d.values.includes("email"), action);
      }
    }
    assert.ok(total >= 5, "the scenarios did exercise real deliveries");
  });

  it("no statement the processor runs mentions the email channel at all", async () => {
    for (const [action, world] of ALL) {
      const { sql, log } = fakeDb(world as World);
      await processNotificationMessage(sql, message(action), NOW);
      for (const r of log) assert.doesNotMatch(r.text, /'email'/i, `${action}: ${r.text.slice(0, 60)}`);
    }
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
    const { sql, log } = fakeDb({ member: { ...MEMBER, user_id: USER } });
    await processNotificationMessage(sql, message("member.approve_join"), NOW);
    assert.match(log.find((r) => r.text.startsWith("insert into public.notification_events"))!.text, /on conflict \(event_key\) do nothing/);
    assert.match(deliveryRows(log)[0]!.text, /on conflict \( notification_event_id, coalesce\( recipient_member_id, recipient_user_id,/);
  });

  it("processing the same message twice issues the same statements twice (the database dedupes)", async () => {
    const a = fakeDb({ member: { ...MEMBER, user_id: USER } });
    const b = fakeDb({ member: { ...MEMBER, user_id: USER } });
    await processNotificationMessage(a.sql, message("member.approve_join"), NOW);
    await processNotificationMessage(b.sql, message("member.approve_join"), NOW);
    assert.deepEqual(a.log.map((r) => r.text), b.log.map((r) => r.text));
  });
});
