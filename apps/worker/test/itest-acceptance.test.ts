/**
 * itest-acceptance.test.ts — M13.2 Phase 1c: approval checklist §9 criterion 1.
 *
 * Unit tests of the lexical acceptance guard (test/support/itest-acceptance.ts)
 * and its application to every file under apps/worker/test/. Pure file reads;
 * no database, SMTP or Mailpit.
 *
 * Forbidden tokens are assembled at runtime so this file never contains them
 * literally (it is itself scanned).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findAcceptanceViolations,
  findAcceptanceViolationsInFile,
  LEDGER_FILLER_HELPER,
  LEDGER_INSERT_LABEL,
  ledgerInsertIsRollbackGuarded,
  QUEUE_ARCHIVE_HELPER,
  QUEUE_CALL_LABEL,
  QUEUE_RELEASE_HELPER,
  QUEUE_SEED_HELPER,
  QUEUE_TABLE_WRITE_LABEL,
  queueArchiveIsOwnershipGuarded,
  queueReleaseIsOwnershipGuarded,
  queueSeedIsOwnershipGuarded,
  SET_CONFIG_LABEL,
  SWITCH_HELPER,
  SWITCH_SETTER_LABEL,
  switchWriteIsGuarded,
  type AcceptanceViolation,
} from "./support/itest-acceptance.ts";

const TEST_ROOT = fileURLToPath(new URL("./", import.meta.url));

const SC = "set_" + "config";
const BT = "`";
const allowed = (body = "${JSON.stringify({ sub: OWNER, role: \"authenticated\" })}") =>
  `await tx${BT}select ${SC}('request.jwt.claims', ${body}, true)${BT};`;

const setConfigCount = (source: string) => findAcceptanceViolations(source).find((v) => v.label === SET_CONFIG_LABEL)?.count ?? 0;

describe("acceptance guard — the narrow set_config exception", () => {
  it("allows exactly the transaction-local request.jwt.claims setup the processor test uses", () => {
    for (const source of [
      allowed(),
      allowed("${JSON.stringify({ sub: OWING, role: \"authenticated\" })}"),
      allowed("${claims}"),
      `await tx${BT}  select   ${SC} ( 'request.jwt.claims' ,  \${claims} ,  TRUE )  ${BT};`,
      `await tx${BT}\n  select ${SC}('request.jwt.claims', \${claims}, true)\n${BT};`,
    ]) {
      assert.deepEqual(findAcceptanceViolations(source), [], source);
    }
  });

  it("the real processor integration file passes: its three calls are the allowed form", () => {
    const source = readFileSync(path.join(TEST_ROOT, "integration", "notification-processor.integration.test.ts"), "utf8");
    assert.equal([...source.matchAll(new RegExp(`\\b${SC}\\s*\\(`, "g"))].length, 3, "the file still contains its three set_config calls");
    assert.deepEqual(findAcceptanceViolations(source), []);
  });

  it("rejects every other configuration mutation, scope, name or handle", () => {
    const rejected: readonly [string, string][] = [
      ["another setting name (ledger purge flag)", `await tx${BT}select ${SC}('app.send_attempts_` + `purging', 'true', true)${BT};`],
      ["role setting", `await tx${BT}select ${SC}('role', \${role}, true)${BT};`],
      ["search_path", `await tx${BT}select ${SC}('search_path', \${p}, true)${BT};`],
      ["a similar claims name", `await tx${BT}select ${SC}('request.jwt.claim.sub', \${sub}, true)${BT};`],
      ["session-scoped (is_local false)", `await tx${BT}select ${SC}('request.jwt.claims', \${claims}, false)${BT};`],
      ["is_local as a parameter", `await tx${BT}select ${SC}('request.jwt.claims', \${claims}, \${local})${BT};`],
      ["is_local omitted", `await tx${BT}select ${SC}('request.jwt.claims', \${claims})${BT};`],
      ["dynamic setting name", `await tx${BT}select ${SC}(\${name}, \${claims}, true)${BT};`],
      ["concatenated setting name", `await tx${BT}select ${SC}('request.jwt.' || 'claims', \${claims}, true)${BT};`],
      ["double-quoted name", `await tx${BT}select ${SC}("request.jwt.claims", \${claims}, true)${BT};`],
      ["literal value instead of a parameter", `await tx${BT}select ${SC}('request.jwt.claims', '{"role":"service_role"}', true)${BT};`],
      ["on the pool, not the transaction", `await sql${BT}select ${SC}('request.jwt.claims', \${claims}, true)${BT};`],
      ["through unsafe()", `await tx.unsafe("select ${SC}('request.jwt.claims', $1, true)", [claims]);`],
      ["schema-qualified call", `await tx${BT}select pg_catalog.${SC}('request.jwt.claims', \${claims}, true)${BT};`],
      ["extra statement after the call", `await tx${BT}select ${SC}('request.jwt.claims', \${claims}, true); select 1${BT};`],
      ["not the whole statement", `await tx${BT}select 1, ${SC}('request.jwt.claims', \${claims}, true)${BT};`],
      ["nested template in the parameter", `await tx${BT}select ${SC}('request.jwt.claims', \${${BT}x${BT}}, true)${BT};`],
      ["upper-case call on the pool", `await sql.unsafe("SELECT ${SC.toUpperCase()}('request.jwt.claims', '{}', true)");`],
      ["unbalanced parameter", `await tx${BT}select ${SC}('request.jwt.claims', \${claims, true)${BT};`],
    ];
    for (const [label, source] of rejected) {
      assert.equal(setConfigCount(source), 1, label);
    }
  });

  it("counts every violating call and ignores allowed calls beside it", () => {
    const source = [allowed(), `await tx${BT}select ${SC}('role', \${r}, true)${BT};`, allowed(), `await tx${BT}select ${SC}('request.jwt.claims', \${c}, false)${BT};`].join("\n");
    assert.equal(setConfigCount(source), 2);
  });
});

describe("acceptance guard — the other criterion-1 rules", () => {
  const samples: readonly [string, string, RegExp][] = [
    ["trigger disable", "await sql`alter table public.x " + "disable" + " trigger t`", /trigger/],
    ["trigger enable", "ALTER TABLE x " + "ENABLE" + " TRIGGER t", /trigger/],
    ["ledger delete", "delete" + " from public.notification_send_attempts where id = 1", /ledger rows/],
    ["quoted ledger delete", "DELETE" + ' FROM "public"."notification_send_attempts"', /ledger rows/],
    ["event delete", "delete" + " from notification_events", /event rows/],
    ["ledger filler insert", "insert" + " into public.notification_send_attempts (x) values (1)", /inserts ledger rows/],
    ["purge flag", "app.send_attempts_" + "purging", /purge flag/],
    ["replication role", "set session_replication_" + "role = replica", /replication role/],
    ["Mailpit delete-all", `fetch(url, { method: "${"DEL" + "ETE"}" })`, /HTTP DELETE/],
    ["inbox-wide total", "assert.equal(inbox" + ".total, 0)", /inbox-wide total/],
    ["switch setter", "await set" + "EmailSendingEnabled(sql, true)", /pause-switch write/],
    ["switch SQL setter", "select app.set_email_" + "sending_enabled(true)", /pause-switch write/],
  ];
  for (const [label, source, expected] of samples) {
    it(`reports: ${label}`, () => {
      const found = findAcceptanceViolations(source);
      assert.ok(found.some((v) => expected.test(v.label)), `${source} → ${JSON.stringify(found)}`);
    });
  }

  it("does not report reads, rollback sentinels, the quarantine UPDATE or deletes from mutable tables", () => {
    for (const source of [
      "const enabled = await isEmailSendingEnabled(sql);",
      "select current_setting('request.jwt.claims', true)",
      "throw new Rollback();",
      "update public.notification_deliveries set status = 'dead' where id = $1",
      "delete" + " from public.notification_deliveries where community_id = $1",
      "select count(*) from public.notification_send_attempts",
      "// deleting from the ledger is forbidden",
    ]) {
      assert.deepEqual(findAcceptanceViolations(source), [], source);
    }
  });
});

describe("acceptance guard — the rollback-only ledger filler exception (Phase 4)", () => {
  const INS = "insert" + " into public.notification_send_attempts (delivery_id) values (1)";
  const guarded = (body = "") => `export async function fill(tx) {\n  assertRollbackHandle(tx);\n  ${body}\n  await tx${BT}${INS}${BT};\n}`;
  const ledgerCount = (rel: string, source: string) => findAcceptanceViolationsInFile(rel, source).find((v) => v.label === LEDGER_INSERT_LABEL)?.count ?? 0;

  it("allows exactly one insert in the filler helper, after the rollback assertion in the same function", () => {
    assert.equal(ledgerCount(LEDGER_FILLER_HELPER, guarded("if (x) throw new Error();")), 0);
    assert.ok(ledgerInsertIsRollbackGuarded(guarded()));
  });

  it("still reports the insert anywhere else, unguarded, guarded from another function, or twice", () => {
    assert.equal(ledgerCount("integration/notification-sender.integration.test.ts", guarded()), 1, "another file");
    assert.equal(ledgerCount("support/itest-db.ts", guarded()), 1, "another support file");
    assert.equal(ledgerCount(LEDGER_FILLER_HELPER, `export async function fill(tx) {\n  await tx${BT}${INS}${BT};\n}`), 1, "no assertion");
    assert.equal(ledgerCount(LEDGER_FILLER_HELPER, `function a(tx) { assertRollbackHandle(tx); }\nexport async function b(tx) {\n  await tx${BT}${INS}${BT};\n}`), 1, "assertion in another function");
    assert.equal(ledgerCount(LEDGER_FILLER_HELPER, `${guarded()}\n${guarded()}`), 2, "two inserts");
    assert.equal(ledgerCount(LEDGER_FILLER_HELPER, guarded("const f = () => { return 1; };")), 1, "a nested function between guard and insert");
  });

  it("the real helper is guarded, and the exception hides nothing else in it", () => {
    const source = readFileSync(path.join(TEST_ROOT, "support", "itest-isolation.ts"), "utf8");
    assert.deepEqual(findAcceptanceViolations(source), [{ label: LEDGER_INSERT_LABEL, count: 1 }], "the helper's only raw finding is its single filler insert");
    assert.ok(ledgerInsertIsRollbackGuarded(source));
    assert.deepEqual(findAcceptanceViolationsInFile(LEDGER_FILLER_HELPER, source), []);
  });
});

describe("acceptance guard — pgmq writes and the owned-message archive exception (Phase 6A)", () => {
  const Q = "pg" + "mq";
  const ARCHIVE = `select ${Q}.archive('notification_events', $1::bigint) as archived`;
  const ASSERT = "assertOwnedQueueMessage(owner, message);";
  const guarded = (between = "") =>
    `export async function archiveOwnQueueMessage(sql, owner, message) {\n  ${ASSERT}\n  ${between}\n  await tx.unsafe("${ARCHIVE}", [message.msgId]);\n}`;
  const queueCount = (rel: string, source: string) => findAcceptanceViolationsInFile(rel, source).find((v) => v.label === QUEUE_CALL_LABEL)?.count ?? 0;

  it("reports every queue-writing or consuming pgmq call, anywhere", () => {
    for (const fn of ["send", "send_batch", "archive", "delete", "pop", "read", "read_with_poll", "set_vt", "purge_queue", "drop_queue", "create", "create_unlogged", "detach_archive"]) {
      for (const source of [`select ${Q}.${fn}('notification_events', 1)`, `SELECT ${Q.toUpperCase()} . ${fn.toUpperCase()} ('x')`, `select "${Q}"."${fn}"('x')`.replace(`"${Q}"`, Q)]) {
        assert.equal(queueCount("integration/x.integration.test.ts", source), 1, source);
      }
    }
  });

  it("reports direct DML on pgmq tables", () => {
    for (const source of [
      "delete" + ` from ${Q}.q_notification_events`,
      "insert" + ` into ${Q}.a_notification_events (msg_id) values (1)`,
      "update" + ` ${Q}.q_notification_events set vt = now()`,
      "truncate" + ` ${Q}.q_notification_events`,
      "TRUNCATE TABLE" + ` "${Q}".q_notification_events`,
    ]) {
      assert.ok(findAcceptanceViolations(source).some((v) => v.label === QUEUE_TABLE_WRITE_LABEL), source);
    }
  });

  it("does not report read-only queue selects", () => {
    for (const source of [
      `select message from ${Q}.q_notification_events where message ->> 'community_id' = $1`,
      `select count(*)::int from ${Q}.q_notification_events where read_ct > 0`,
      `select msg_id::text from ${Q}.q_notification_events where msg_id = $1::bigint for update`,
      `select msg_id from ${Q}.a_notification_events where msg_id = $1::bigint`,
    ]) {
      assert.deepEqual(findAcceptanceViolations(source), [], source);
    }
  });

  it("allows exactly one owned archive in the queue helper, after the ownership assertion in the same function", () => {
    assert.ok(queueArchiveIsOwnershipGuarded(guarded()));
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, guarded("const rows = 1;")), 0);
  });

  it("still reports the archive anywhere else, unguarded, guarded from another function, twice, or in any other form", () => {
    assert.equal(queueCount("integration/notification-e2e-mailpit.integration.test.ts", guarded()), 1, "another file");
    assert.equal(queueCount("support/itest-isolation.ts", guarded()), 1, "another support file");
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, guarded().replace(ASSERT, "")), 1, "no assertion");
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, `function a(owner, message) { ${ASSERT} }\nexport async function b() {\n  await tx.unsafe("${ARCHIVE}", [id]);\n}`), 1, "assertion in another function");
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, guarded("const f = () => { return 1; };")), 1, "a nested function between assertion and archive");
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, `${guarded()}\n${guarded()}`), 2, "two archives");
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, guarded().replace(".archive(", ".delete(")), 1, "delete instead of archive");
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, guarded().replace("'notification_events'", "${queue}")), 1, "another or dynamic queue");
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, guarded().replace("$1::bigint", "$1::bigint[]")), 1, "a batch of ids");
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, guarded(`await tx.unsafe("select ${Q}.purge_queue('notification_events')");`)), 2, "a second, different queue call");
  });

  it("the real queue helper is guarded, and the exception hides nothing else in it", () => {
    const source = readFileSync(path.join(TEST_ROOT, "support", "itest-queue.ts"), "utf8");
    assert.deepEqual(findAcceptanceViolations(source), [{ label: QUEUE_CALL_LABEL, count: 1 }], "the helper's only raw finding is its single owned archive");
    assert.ok(queueArchiveIsOwnershipGuarded(source));
    assert.deepEqual(findAcceptanceViolationsInFile(QUEUE_ARCHIVE_HELPER, source), []);
  });

  it("the end-to-end file holds no pgmq write of its own and only the allowed set_config form", () => {
    const source = readFileSync(path.join(TEST_ROOT, "integration", "notification-e2e-mailpit.integration.test.ts"), "utf8");
    assert.deepEqual(findAcceptanceViolations(source), []);
    assert.equal([...source.matchAll(new RegExp(`\\b${SC}\\s*\\(`, "g"))].length, 1, "one transaction-local claims setup");
  });
});

describe("acceptance guard — the Phase 7 exceptions", () => {
  const Q = "pg" + "mq";
  const SEED = `select ${Q}.send('notification_events', $1::text::jsonb)::text as msg_id`;
  const SEED_ASSERT = "assertSeedOwned(owner, message);";
  const seed = (between = "") => `export async function seedOwnQueueMessage(sql, owner, message) {\n  ${SEED_ASSERT}\n  ${between}\n  await sql.unsafe("${SEED}", [m]);\n}`;
  const queueCount = (rel: string, source: string) => findAcceptanceViolationsInFile(rel, source).find((v) => v.label === QUEUE_CALL_LABEL)?.count ?? 0;

  it("allows one owned seed in its helper, and reports it anywhere else or in any other form", () => {
    assert.ok(queueSeedIsOwnershipGuarded(seed()));
    assert.equal(queueCount(QUEUE_SEED_HELPER, seed()), 0);
    assert.equal(queueCount("integration/x.integration.test.ts", seed()), 1, "another file");
    assert.equal(queueCount(QUEUE_ARCHIVE_HELPER, seed()), 1, "the archive helper does not get the seed's exception");
    assert.equal(queueCount(QUEUE_SEED_HELPER, seed().replace(SEED_ASSERT, "")), 1, "no assertion");
    assert.equal(queueCount(QUEUE_SEED_HELPER, seed("const f = () => { return 1; };")), 1, "a nested function in between");
    assert.equal(queueCount(QUEUE_SEED_HELPER, seed().replace("'notification_events'", "${q}")), 1, "a dynamic queue");
    assert.equal(queueCount(QUEUE_SEED_HELPER, `${seed()}\n${seed()}`), 2, "two seeds");
    assert.equal(queueCount(QUEUE_SEED_HELPER, seed().replace(".send(", ".purge_queue(")), 1, "another function");
  });

  const SETTER = "set_email_" + "sending_enabled";
  const authorize = "await assertSwitchWriteAuthorized(ctx);";
  const on = `await ctx.sql.unsafe("select app.${SETTER}(true) as enabled");`;
  const off = `await ctx.sql.unsafe("select app.${SETTER}(false) as enabled");`;
  const guarded = `export async function withSendingEnabled(ctx, fn) {\n  ${authorize}\n  ${on}\n  try {\n    return await fn();\n  } finally {\n    ${off}\n  }\n}`;
  const switchCount = (rel: string, source: string) => findAcceptanceViolationsInFile(rel, source).find((v) => v.label === SWITCH_SETTER_LABEL)?.count ?? 0;

  it("allows the guarded switch write in its helper only, with the disable in a finally", () => {
    assert.ok(switchWriteIsGuarded(guarded));
    assert.equal(switchCount(SWITCH_HELPER, guarded), 0);
    assert.equal(switchCount("integration/notification-worker-runtime.integration.test.ts", guarded), 1, "another file");
    assert.equal(switchCount("support/itest-worker.ts", guarded), 1, "another support file");
    assert.equal(switchCount(SWITCH_HELPER, guarded.replace(authorize, "")), 1, "no authorisation");
    assert.equal(switchCount(SWITCH_HELPER, guarded.replace("finally", "catch (e)")), 1, "the disable is not in a finally");
    assert.equal(switchCount(SWITCH_HELPER, guarded.replace(off, "")), 1, "no disable at all");
    assert.equal(switchCount(SWITCH_HELPER, `${guarded}\nawait x("select app.${SETTER}(true)")`), 1, "a third setter call");
    assert.equal(switchCount(SWITCH_HELPER, guarded.replace(on, `const f = () => { return 1; };\n${on}`)), 1, "a nested function between guard and write");
  });

  it("the real helpers carry the guards, and each exception hides nothing else", () => {
    const seedSource = readFileSync(path.join(TEST_ROOT, "support", "itest-queue-seed.ts"), "utf8");
    assert.deepEqual(findAcceptanceViolations(seedSource), [{ label: QUEUE_CALL_LABEL, count: 1 }]);
    assert.deepEqual(findAcceptanceViolationsInFile(QUEUE_SEED_HELPER, seedSource), []);
    const switchSource = readFileSync(path.join(TEST_ROOT, "support", "itest-switch.ts"), "utf8");
    assert.deepEqual(findAcceptanceViolations(switchSource), [{ label: SWITCH_SETTER_LABEL, count: 1 }]);
    assert.deepEqual(findAcceptanceViolationsInFile(SWITCH_HELPER, switchSource), []);
  });

  const RELEASE = `select msg_id::text as msg_id from ${Q}.set_vt('notification_events', $1::bigint, 0)`;
  const RELEASE_ASSERT = "assertOwnedQueueMessage(owner, message);";
  const release = (between = "") => `export async function releaseParkedOwnMessage(sql, owner, message) {\n  ${RELEASE_ASSERT}\n  ${between}\n  await sql.unsafe("${RELEASE}", [m]);\n}`;

  it("Phase 8: allows one owned release in its helper, and reports it anywhere else or in any other form", () => {
    assert.ok(queueReleaseIsOwnershipGuarded(release()));
    assert.equal(queueCount(QUEUE_RELEASE_HELPER, release()), 0);
    assert.equal(queueCount("integration/x.integration.test.ts", release()), 1, "another file");
    assert.equal(queueCount(QUEUE_SEED_HELPER, release()), 1, "the seed helper does not get the release's exception");
    assert.equal(queueCount(QUEUE_RELEASE_HELPER, release().replace(RELEASE_ASSERT, "")), 1, "no assertion");
    assert.equal(queueCount(QUEUE_RELEASE_HELPER, release("const f = () => { return 1; };")), 1, "a nested function in between");
    assert.equal(queueCount(QUEUE_RELEASE_HELPER, release().replace("'notification_events'", "${q}")), 1, "a dynamic queue");
    assert.equal(queueCount(QUEUE_RELEASE_HELPER, release().replace("$1::bigint, 0)", "$1::bigint, 3600)")), 1, "any other visibility");
    assert.equal(queueCount(QUEUE_RELEASE_HELPER, `${release()}\n${release()}`), 2, "two releases");
    const source = readFileSync(path.join(TEST_ROOT, "support", "itest-queue-release.ts"), "utf8");
    assert.deepEqual(findAcceptanceViolations(source), [{ label: QUEUE_CALL_LABEL, count: 1 }]);
    assert.deepEqual(findAcceptanceViolationsInFile(QUEUE_RELEASE_HELPER, source), []);
  });
});

// ── Applied to the repository ─────────────────────────────────────────────────

/**
 * Known violations, frozen. Criterion 1 is met for every integration file and
 * every harness module: Phase 4 converted the six integration files (no trigger
 * toggles, no ledger or event deletes, no committed fillers — fillers only through
 * the rollback-only helper — and no Mailpit delete-all).
 *
 * What remains is not test behaviour: itest-db.test.ts and itest-gate.test.ts hold
 * the sample strings that unit-test the pause-switch write detector itself.
 * Phase 6A added the pgmq-write rule: dead-letter.test.ts holds a copy of the
 * index.ts event loop (pgmq archive + delete) that runs only against a recording
 * fake connection — no database — so it is recorded here, not exempted.
 *
 * The comparison is exact in both directions: a new violation anywhere fails,
 * and so does a removed one until this map is updated, so the recorded state
 * always matches the tree.
 */
const KNOWN_VIOLATIONS: Readonly<Record<string, readonly AcceptanceViolation[]>> = {
  "dead-letter.test.ts": [{ label: QUEUE_CALL_LABEL, count: 2 }],
  "itest-db.test.ts": [{ label: "pause-switch write (sender-state update)", count: 1 }],
  "itest-gate.test.ts": [
    { label: "pause-switch write (sender-state insert)", count: 1 },
    { label: "pause-switch write (sender-state update)", count: 1 },
    { label: "pause-switch write (switch assigned true)", count: 1 },
  ],
};

function scanTestTree(): Record<string, AcceptanceViolation[]> {
  const out: Record<string, AcceptanceViolation[]> = {};
  const files = readdirSync(TEST_ROOT, { recursive: true, encoding: "utf8" }).filter((f) => /\.(?:ts|mts|js|mjs|md|json)$/.test(f)).sort();
  assert.ok(files.length > 20, "the scan sees the test tree");
  for (const rel of files) {
    const posix = rel.replaceAll("\\", "/");
    const found = findAcceptanceViolationsInFile(posix, readFileSync(path.join(TEST_ROOT, rel), "utf8"));
    if (found.length > 0) out[posix] = found;
  }
  return out;
}

describe("acceptance guard — apps/worker/test/** (criterion 1)", () => {
  it("the tree holds exactly the known violations: none new, none silently fixed", () => {
    assert.deepEqual(scanTestTree(), KNOWN_VIOLATIONS);
  });

  it("no harness module, no integration file and no unit test outside the guard's own samples (and the fake-SQL dead-letter test) has a violation", () => {
    const scanned = scanTestTree();
    for (const file of Object.keys(scanned)) {
      assert.ok(file === "itest-db.test.ts" || file === "itest-gate.test.ts" || file === "dead-letter.test.ts", file);
    }
    assert.ok(!("support/itest-queue.ts" in scanned), "the queue helper's single archive is the guarded exception");
    for (const rel of readdirSync(path.join(TEST_ROOT, "integration")).filter((f) => f.endsWith(".test.ts"))) {
      assert.ok(!(`integration/${rel}` in scanned), rel);
    }
  });

  it("the Mailpit file no longer holds the unscoped ledger wipe or an inbox-wide total", () => {
    const source = readFileSync(path.join(TEST_ROOT, "integration", "notification-sender-mailpit.integration.test.ts"), "utf8");
    assert.doesNotMatch(source, new RegExp("delete" + "\\s+from\\s+public\\.notification_send_attempts\\s*`"), "no unscoped ledger delete");
    assert.doesNotMatch(source, /clearSendLedger\(sql\)/);
    assert.doesNotMatch(source, new RegExp("inbox" + "\\.total"));
  });
});
