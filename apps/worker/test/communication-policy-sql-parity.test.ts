/**
 * M13.3 R2 — parity between the worker's central policy and the (unapplied)
 * database proposals. No database: the SQL is read as text. This keeps the two
 * authorities from drifting before the proposals are applied and tested by pgTAP.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHANNELS,
  COMMUNICATION_CATEGORIES,
  channelRequirement,
  classifiedEvents,
  eventPolicy,
  mayRecordChoice,
  type Channel,
  type CommunicationCategory,
  type PaymentPurpose,
  type Requirement,
} from "../src/communication-policy.ts";
import { COLLECTION_DB_SKIP_REASONS } from "../src/notification-eligibility.ts";

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url);
const POLICY_SQL = readFileSync(new URL("20261109100000_m13_3_communication_policy.sql", MIGRATIONS), "utf8");
const ANNOUNCE_SQL = readFileSync(new URL("20261109100100_member_collection_announcements.sql", MIGRATIONS), "utf8");
const R3_SQL = readFileSync(new URL("20261109100200_m13_3_send_time_recheck.sql", MIGRATIONS), "utf8").replace(/\r\n/g, "\n");
const QUOTA_MIGRATION = readFileSync(
  new URL("../../../supabase/migrations/20261024200000_notification_quota_controls.sql", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

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

function sqlSig(requirement: string, detail: string | null): string {
  if (requirement === "always") return "always";
  if (requirement === "default_on") return detail === "community_notice" ? "default_on+notice" : "default_on";
  if (requirement === "opt_in") return `opt_in(${detail})`;
  return `disabled(${detail})`;
}

/** The text between two markers. */
function between(text: string, begin: string, end: string): string {
  const a = text.indexOf(begin);
  const b = text.indexOf(end, a + begin.length);
  assert.ok(a >= 0 && b > a, `markers ${begin} … ${end} present`);
  return text.slice(a + begin.length, b);
}

/** The quoted values of a `<column> in ('a', 'b', …)` list inside the named constraint. */
function checkList(text: string, constraint: string, column: string): string[] {
  const at = text.indexOf(constraint);
  assert.ok(at >= 0, `constraint ${constraint} present`);
  const m = new RegExp(`${column} (?:not )?in \\(([^)]*)\\)`).exec(text.slice(at));
  assert.ok(m, `${constraint}: ${column} in (…)`);
  return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}

describe("SQL policy matrix = worker policy matrix", () => {
  const rows = [
    ...between(POLICY_SQL, "-- POLICY-MATRIX-BEGIN", "-- POLICY-MATRIX-END").matchAll(
      /\('([a-z_]+)',\s*'([a-z_]*)',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*(null(?:::text)?|'[a-z_,]+')\)/g,
    ),
  ].map((m) => ({
    category: m[1] as CommunicationCategory,
    purpose: (m[2] || undefined) as PaymentPurpose | undefined,
    channel: m[3] as Channel,
    requirement: m[4]!,
    detail: m[5]!.startsWith("null") ? null : m[5]!.slice(1, -1),
  }));

  it("has exactly one row per category/purpose × channel (20)", () => {
    assert.equal(rows.length, 20);
    const keys = new Set(rows.map((r) => `${r.category}:${r.purpose ?? ""}:${r.channel}`));
    assert.equal(keys.size, 20, "no duplicate cell");
    for (const r of rows) {
      assert.ok((COMMUNICATION_CATEGORIES as readonly string[]).includes(r.category), r.category);
      assert.ok((CHANNELS as readonly string[]).includes(r.channel), r.channel);
    }
  });

  it("every SQL cell equals the worker's requirement with today's capabilities", () => {
    for (const r of rows) {
      assert.equal(
        sqlSig(r.requirement, r.detail),
        sig(channelRequirement(r.category, r.channel, { paymentPurpose: r.purpose })),
        `${r.category}${r.purpose ? `:${r.purpose}` : ""} × ${r.channel}`,
      );
    }
  });

  it("covers every worker category and channel", () => {
    for (const c of COMMUNICATION_CATEGORIES) assert.ok(rows.some((r) => r.category === c), c);
    for (const ch of CHANNELS) assert.ok(rows.some((r) => r.channel === ch), ch);
  });
});

describe("SQL vocabularies = worker vocabularies", () => {
  it("notification_deliveries.communication_category accepts exactly the worker's four categories", () => {
    assert.deepEqual(
      checkList(POLICY_SQL, "notification_deliveries_communication_category_values", "communication_category"),
      [...COMMUNICATION_CATEGORIES],
    );
  });

  it("member choices: categories exclude essential (not optional); channels exclude in_app (not configurable)", () => {
    assert.deepEqual(
      checkList(POLICY_SQL, "member_communication_choices_category_values", "category").sort(),
      COMMUNICATION_CATEGORIES.filter((c) => c !== "essential").sort(),
    );
    assert.deepEqual(
      checkList(POLICY_SQL, "member_communication_choices_channel_values", "channel").sort(),
      [...CHANNELS.filter((c) => c !== "in_app"), "all"].sort(),
    );
    assert.deepEqual(
      checkList(POLICY_SQL, "member_communication_choices_permission_values", "permission").sort(),
      ["marketing_consent", "whatsapp_permission"],
    );
  });

  it("the officer-row CHECK allows exactly what mayRecordChoice allows an organiser", () => {
    const sqlAllowed = checkList(POLICY_SQL, "member_communication_choices_officer_rows", "choice").sort();
    const all = ["opt_out", "opt_in", "grant_permission", "withdraw_permission"] as const;
    assert.deepEqual(sqlAllowed, all.filter((c) => mayRecordChoice("organiser", c)).sort());
  });

  it("only a member may opt in or grant (CHECK) — matches mayRecordChoice", () => {
    const memberOnly = checkList(POLICY_SQL, "member_communication_choices_only_member_opts_in_or_grants", "choice").sort();
    assert.deepEqual(memberOnly, ["grant_permission", "opt_in"]);
    for (const c of memberOnly) assert.equal(mayRecordChoice("organiser", c as "opt_in" | "grant_permission"), false, c);
  });
});

describe("collection email decision (SQL) agrees with the worker", () => {
  const body = between(
    ANNOUNCE_SQL,
    "create or replace function app.collection_member_email_decisions(",
    "comment on function app.collection_member_email_decisions",
  );
  // Only the skip-reason CASE (the assurance CASE after it returns other values).
  const reasonCase = body.slice(body.indexOf("decided as"), body.indexOf("end as d_skip_reason"));
  const reasons = [...reasonCase.matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]!);

  it("every reason the database can return is one the worker understands", () => {
    assert.ok(reasons.length >= 6);
    for (const r of reasons) assert.ok(COLLECTION_DB_SKIP_REASONS.includes(r), r);
  });

  it("the database never returns consent_missing and does return community_notice_missing", () => {
    assert.ok(!reasons.includes("consent_missing"));
    assert.ok(reasons.includes("community_notice_missing"));
    assert.ok(!/consent_messages_at/.test(body), "consent_messages_at is not read");
  });

  it("order: reachability → availability → opted_out → community_notice_missing → address (worker order)", () => {
    const at = (r: string) => reasonCase.indexOf(`then '${r}'`);
    assert.ok(at("collection_not_reachable") < at("member_unavailable"));
    assert.ok(at("member_unavailable") < at("opted_out"));
    assert.ok(at("opted_out") < at("community_notice_missing"));
    assert.ok(at("community_notice_missing") < at("unverified_account_email"));
    assert.ok(at("community_notice_missing") < at("no_recipient"));
  });

  it("the database decision consults the policy matrix and the attestation", () => {
    assert.match(body, /app\.communication_requirement\('community_operational', 'email'\)/);
    assert.match(body, /app\.community_communication_notice_attested\(/);
    assert.match(body, /app\.member_communication_opted_out\(m\.id, 'community_operational', 'email'\)/);
  });

  it("the worker feature-detects the exact function the proposal defines", () => {
    assert.match(POLICY_SQL, /create or replace function app\.community_communication_notice_attested\(p_community_id uuid\)\s+returns boolean/);
  });
});

describe("M13.3 R3 SQL agrees with the worker", () => {
  it("app.communication_category_for_event classifies exactly the worker's events, identically", () => {
    const rows = [
      ...between(R3_SQL, "-- EVENT-CATEGORY-BEGIN", "-- EVENT-CATEGORY-END").matchAll(
        /\('([a-z_.]+)',\s*'([a-z_]+)',\s*(null(?:::text)?|'[a-z_]+'),\s*(null(?:::text)?|'[a-z_]+')\)/g,
      ),
    ].map((m) => ({
      event: m[1]!,
      category: m[2]!,
      purpose: m[3]!.startsWith("null") ? undefined : m[3]!.slice(1, -1),
      topic: m[4]!.startsWith("null") ? undefined : m[4]!.slice(1, -1),
    }));
    assert.deepEqual(rows.map((r) => r.event).sort(), [...classifiedEvents()].sort());
    for (const r of rows) {
      const p = eventPolicy(r.event)!;
      assert.equal(r.category, p.category, r.event);
      assert.equal(r.purpose, p.paymentPurpose, `${r.event} purpose`);
      assert.equal(r.topic, p.topic, `${r.event} topic`);
    }
  });

  it("the reserve function in the R3 proposal is the 20261024200000 body plus only the R3 block (no drift)", () => {
    const start = (t: string) => t.indexOf("create or replace function app.reserve_email_attempt(");
    const end = (t: string) => t.indexOf("revoke execute on function app.reserve_email_attempt(uuid) from anon, authenticated;\n", start(t));
    const original = QUOTA_MIGRATION.slice(start(QUOTA_MIGRATION), end(QUOTA_MIGRATION));
    let proposed = R3_SQL.slice(start(R3_SQL), end(R3_SQL));
    assert.ok(start(R3_SQL) >= 0 && end(R3_SQL) > start(R3_SQL), "the proposal redefines reserve_email_attempt");
    // Undo exactly the three documented changes; what remains must be byte-identical.
    proposed = proposed.replace("  v_ineligible      text;     -- M13.3 R3\n", "");
    const blockStart = proposed.indexOf("\n  -- ── M13.3 R3: send-time eligibility recheck");
    const blockEnd = proposed.indexOf("    return next; return;\n  end if;\n", blockStart) + "    return next; return;\n  end if;\n".length;
    assert.ok(blockStart > 0 && blockEnd > blockStart, "the R3 block is present");
    proposed = proposed.slice(0, blockStart + 1).replace(/\n$/, "") + proposed.slice(blockEnd);
    proposed = proposed.replace(
      "M13.2 P5-2 + P9-1 + P9-3 + M13.3 R3: concurrency-safe rate-limit reservation. Called inside the transaction that claimed the delivery (P5-1). Checks (in order): send-time eligibility (M13.3 R3, app.recheck_delivery_eligibility; outcome ineligible), suppression (P9-1),",
      "M13.2 P5-2 + P9-1 + P9-3: concurrency-safe rate-limit reservation. Called inside the transaction that claimed the delivery (P5-1). Checks (in order): suppression (P9-1),",
    );
    assert.equal(proposed, original);
  });

  it("the recheck runs before suppression and every limit", () => {
    const body = R3_SQL.slice(R3_SQL.indexOf("create or replace function app.reserve_email_attempt("));
    const at = (s: string) => body.indexOf(s);
    assert.ok(at("app.recheck_delivery_eligibility(p_delivery_id)") > 0);
    assert.ok(at("app.recheck_delivery_eligibility(p_delivery_id)") < at("app.is_address_suppressed("));
    assert.ok(at("app.recheck_delivery_eligibility(p_delivery_id)") < at("pg_advisory_xact_lock(1,"));
  });

  it("every recheck reason fits the delivery error_code format and none is consent", () => {
    const fn = between(R3_SQL, "create or replace function app.recheck_delivery_eligibility(", "comment on function app.recheck_delivery_eligibility");
    const reasons = [...fn.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]!);
    assert.ok(reasons.length >= 10);
    for (const r of reasons) assert.match(r, /^[a-z][a-z0-9_]{2,63}$/);
    assert.ok(!reasons.includes("consent_missing"));
  });
});
