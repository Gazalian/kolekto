/**
 * itest-gate.test.ts — M13.2 Phase 1a: the fail-closed integration gate and lane.
 *
 * Every dependency is mocked: the identity probe, the pause-switch reader and
 * the child test process are plain functions. No database, SMTP or Mailpit.
 * Two tests spawn `node --test` on throwaway fixture files that use a mocked
 * gate, to prove against real node:test output that a refusal is a failure and
 * that skipped tests fail the lane.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { globSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ITEST_DB_ROLE, IntegrationGateError, parseIntegrationEnvironment, type EnvSource } from "./support/itest-environment.ts";
import {
  assertVerifiedEnvironment,
  checkPauseSwitch,
  createIntegrationGate,
  findForbiddenSwitchWrites,
  findUnsafeConnectionPatterns,
  isVerifiedEnvironment,
  PAUSE_SWITCH_PROBE_SQL,
  usesIntegrationGate,
  type IntegrationGateDeps,
} from "./support/itest-gate.ts";
import {
  buildChildEnv,
  checkIntegrationFiles,
  defaultLaneDeps,
  evaluateRun,
  INTEGRATION_MANIFEST,
  nodeTestArgs,
  parseTapSummary,
  runIntegrationLane,
  parseLaneArgs,
  SMTP_INTEGRATION_FILES,
  type ChildResult,
  type LaneDeps,
  type SourceFile,
} from "./support/itest-lane.ts";

const WORKER_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PASSWORD = randomBytes(18).toString("base64url");
const STACK_ID = randomUUID();

// Forbidden tokens are assembled at runtime so this file never contains them literally.
const SETTER = "set" + "EmailSendingEnabled";
const SQL_SETTER = "set_" + "email_sending_enabled";

function testEnv(overrides: Record<string, string | undefined> = {}): EnvSource {
  return {
    KOLEKTO_ITEST_REQUIRED: "1",
    KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422/postgres`,
    KOLEKTO_ITEST_SMTP_PORT: "55425",
    KOLEKTO_ITEST_MAILPIT_API: "http://127.0.0.1:55424",
    KOLEKTO_ITEST_STACK_ID: STACK_ID,
    ...overrides,
  };
}

const GOOD_FACTS = { rowCount: 1, currentUser: ITEST_DB_ROLE, sessionUser: ITEST_DB_ROLE, currentDatabase: "postgres", serverPort: 5432, stackId: STACK_ID, declaredHostPort: "55422", transactionReadOnly: "on" };
const SWITCH_OFF = { rowCount: 1, enabled: false };

interface Mocked {
  readonly deps: IntegrationGateDeps;
  readonly calls: { probe: number; reads: number };
}

function mocked(opts: {
  env?: EnvSource;
  probe?: () => Promise<unknown>;
  switchStates?: readonly unknown[];
  readSwitch?: () => Promise<unknown>;
  timeoutMs?: number;
} = {}): Mocked {
  const calls = { probe: 0, reads: 0 };
  const states = opts.switchStates ?? [SWITCH_OFF, SWITCH_OFF];
  const deps: IntegrationGateDeps = {
    env: opts.env ?? testEnv(),
    probeIdentity: async (db) => {
      calls.probe++;
      assert.equal(db.role, ITEST_DB_ROLE);
      return opts.probe ? opts.probe() : GOOD_FACTS;
    },
    readPauseSwitch: async () => {
      const state = opts.readSwitch ? opts.readSwitch() : states[calls.reads];
      calls.reads++;
      return state;
    },
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  };
  return { deps, calls };
}

async function gateRefusal(promise: Promise<unknown>): Promise<IntegrationGateError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof IntegrationGateError, `expected IntegrationGateError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the gate to refuse");
}

describe("integration gate — explicit verification", () => {
  it("verifies a valid environment, issues it once and runs read-only checks only", async () => {
    const { deps, calls } = mocked();
    const gate = createIntegrationGate(deps);
    const env = await gate.verify();
    assert.ok(isVerifiedEnvironment(env));
    assert.equal(gate.verified(), env);
    assert.equal(await gate.verify(), env, "verify() is idempotent");
    assert.deepEqual(calls, { probe: 1, reads: 1 });
    await gate.postflight();
    assert.deepEqual(calls, { probe: 1, reads: 2 });
  });

  it("concurrent verify() calls share one probe", async () => {
    const { deps, calls } = mocked();
    const gate = createIntegrationGate(deps);
    const [a, b] = await Promise.all([gate.verify(), gate.verify()]);
    assert.equal(a, b);
    assert.equal(calls.probe, 1);
  });

  it("refuses to hand out the environment before verify() succeeds", async () => {
    const { deps, calls } = mocked();
    const gate = createIntegrationGate(deps);
    assert.throws(() => gate.verified(), (e: unknown) => e instanceof IntegrationGateError && e.has("NOT_VERIFIED"));
    assert.ok((await gateRefusal(gate.postflight())).has("NOT_VERIFIED"));
    assert.deepEqual(calls, { probe: 0, reads: 0 }, "nothing is read before verification");
  });

  it("refuses unless started by the integration runner (KOLEKTO_ITEST_REQUIRED=1)", async () => {
    for (const value of [undefined, "", "0", "true", " 1"]) {
      const { deps, calls } = mocked({ env: testEnv({ KOLEKTO_ITEST_REQUIRED: value }) });
      assert.ok((await gateRefusal(createIntegrationGate(deps).verify())).has("NOT_REQUIRED_MODE"));
      assert.equal(calls.probe, 0);
    }
  });

  it("refuses invalid static configuration without probing anything", async () => {
    const { deps, calls } = mocked({ env: testEnv({ KOLEKTO_ITEST_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }) });
    const error = await gateRefusal(createIntegrationGate(deps).verify());
    assert.ok(error.has("DB_PORT_DEVELOPER"));
    assert.deepEqual(calls, { probe: 0, reads: 0 });
  });

  it("refuses a live identity mismatch and stays refused", async () => {
    const { deps, calls } = mocked({ probe: async () => ({ ...GOOD_FACTS, stackId: null }) });
    const gate = createIntegrationGate(deps);
    const first = await gateRefusal(gate.verify());
    assert.ok(first.has("IDENTITY_STACK_MISSING"));
    assert.equal(calls.reads, 0, "the switch is not read once identity failed");
    assert.equal(await gateRefusal(gate.verify()), first, "a refusal is permanent");
    assert.equal(calls.probe, 1, "no retry of identity checks");
    assert.throws(() => gate.verified(), (e: unknown) => e instanceof IntegrationGateError && e.has("NOT_VERIFIED"));
  });

  it("turns a probe failure into a refusal that withholds driver details", async () => {
    const leaky = Object.assign(new Error(`password authentication failed for postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422`), { code: "28P01" });
    const { deps } = mocked({ probe: async () => { throw leaky; } });
    const error = await gateRefusal(createIntegrationGate(deps).verify());
    assert.ok(error.has("IDENTITY_PROBE_FAILED"));
    assert.match(error.message, /code 28P01/);
    assert.ok(!error.message.includes(PASSWORD));
    assert.equal(error.cause, undefined);
  });

  it("drops error codes that are not a SQLSTATE or errno", async () => {
    const { deps } = mocked({ probe: async () => { throw Object.assign(new Error("x"), { code: `secret ${PASSWORD}` }); } });
    const error = await gateRefusal(createIntegrationGate(deps).verify());
    assert.ok(!error.message.includes(PASSWORD));
    assert.doesNotMatch(error.message, /\(code /);
  });

  it("treats a probe that never answers as a refusal (timeout), not a hang or a skip", async () => {
    const { deps } = mocked({ probe: () => new Promise(() => {}), timeoutMs: 20 });
    const error = await gateRefusal(createIntegrationGate(deps).verify());
    assert.ok(error.has("IDENTITY_PROBE_FAILED"));
    assert.match(error.message, /timed out after 20 ms/);
  });

  it("only accepts environments it issued itself", async () => {
    const parsed = parseIntegrationEnvironment(testEnv());
    for (const value of [parsed, { ...parsed }, null, undefined, {}]) {
      assert.equal(isVerifiedEnvironment(value), false);
      assert.throws(() => assertVerifiedEnvironment(value), (e: unknown) => e instanceof IntegrationGateError && e.has("NOT_VERIFIED"));
    }
    const env = await createIntegrationGate(mocked().deps).verify();
    assertVerifiedEnvironment(env);
  });
});

describe("integration gate — pause-switch guard (mocked reader)", () => {
  it("refuses to start when the switch is ON and never tries to correct it", async () => {
    const { deps, calls } = mocked({ switchStates: [{ rowCount: 1, enabled: true }] });
    const gate = createIntegrationGate(deps);
    const error = await gateRefusal(gate.verify());
    assert.ok(error.has("PAUSE_SWITCH_ON"));
    assert.equal(calls.reads, 1, "one read, no write path exists");
    assert.throws(() => gate.verified());
  });

  it("fails the file when the switch is ON after it", async () => {
    const { deps } = mocked({ switchStates: [SWITCH_OFF, { rowCount: 1, enabled: true }] });
    const gate = createIntegrationGate(deps);
    await gate.verify();
    assert.ok((await gateRefusal(gate.postflight())).has("PAUSE_SWITCH_ON"));
  });

  it("refuses a missing switch row (a missing row reads as off)", async () => {
    const { deps } = mocked({ switchStates: [{ rowCount: 0, enabled: undefined }] });
    assert.ok((await gateRefusal(createIntegrationGate(deps).verify())).has("PAUSE_SWITCH_ROW_MISSING"));
  });

  it("treats anything but exactly one boolean false as inconclusive", () => {
    for (const state of [null, undefined, "false", {}, { enabled: false }, { rowCount: 2, enabled: false }, { rowCount: 1, enabled: "false" }, { rowCount: 1, enabled: 0 }, { rowCount: 1, enabled: null }]) {
      assert.throws(() => checkPauseSwitch(state, "before"), (e: unknown) => e instanceof IntegrationGateError && e.has("PAUSE_SWITCH_INCONCLUSIVE"), JSON.stringify(state));
    }
    checkPauseSwitch(SWITCH_OFF, "before");
    checkPauseSwitch(SWITCH_OFF, "after");
  });

  it("a failing or hanging switch read is a refusal", async () => {
    const failing = mocked({ readSwitch: async () => { throw Object.assign(new Error("boom"), { code: "ECONNRESET" }); } });
    const error = await gateRefusal(createIntegrationGate(failing.deps).verify());
    assert.ok(error.has("PAUSE_SWITCH_READ_FAILED"));
    assert.match(error.message, /ECONNRESET/);

    const hanging = mocked({ readSwitch: () => new Promise(() => {}), timeoutMs: 20 });
    assert.ok((await gateRefusal(createIntegrationGate(hanging.deps).verify())).has("PAUSE_SWITCH_READ_FAILED"));
  });

  it("the switch probe is a read-only select of the singleton row", () => {
    assert.equal(PAUSE_SWITCH_PROBE_SQL, "select email_sending_enabled from public.notification_sender_state");
    assert.deepEqual(findForbiddenSwitchWrites(PAUSE_SWITCH_PROBE_SQL), []);
  });

  it("detects every form of pause-switch write", () => {
    const samples = [
      `await ${SETTER}(sql, true)`,
      `select app.${SQL_SETTER}(true)`,
      "update public.notification_sender_state set email_sending_enabled = true",
      `UPDATE "public"."notification_sender_state" SET x = 1`,
      "insert into notification_sender_state (id) values (true)",
      "email_sending_enabled := TRUE",
    ];
    for (const sample of samples) {
      assert.notDeepEqual(findForbiddenSwitchWrites(sample), [], sample);
    }
    assert.deepEqual(findForbiddenSwitchWrites("const enabled = await isEmailSendingEnabled(sql);"), []);
  });
});

// ── Lane ───────────────────────────────────────────────────────────────────────

const GATED_SOURCE = [
  `import { createIntegrationGate } from "../support/itest-gate.ts";`,
  `import { connectVerified, liveGateDeps } from "../support/itest-db.ts";`,
  `const gate = createIntegrationGate(liveGateDeps());`,
  `before(() => gate.verify());`,
  `after(() => gate.postflight());`,
].join("\n");

function tap(counts: Partial<Record<"tests" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>>): string {
  const c = { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...counts };
  return [`TAP version 13`, `ok 1 - x`, `1..${c.tests}`, ...Object.entries(c).map(([k, v]) => `# ${k} ${v}`), `# duration_ms 12.3`].join("\n");
}

function lane(opts: { env?: EnvSource; files?: readonly SourceFile[]; result?: ChildResult; manifest?: readonly string[] } = {}) {
  const log: string[] = [];
  const spawned: { files: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  let listed = 0;
  const deps: LaneDeps = {
    env: opts.env ?? testEnv({ KOLEKTO_ITEST_REQUIRED: undefined }),
    listIntegrationFiles: async () => {
      listed++;
      return opts.files ?? [{ path: "test/integration/a.test.ts", source: GATED_SOURCE }];
    },
    runTests: async (files, env) => {
      spawned.push({ files, env });
      return opts.result ?? { code: 0, signal: null, output: tap({}) };
    },
    log: (text) => log.push(text),
    manifest: opts.manifest ?? ["test/integration/a.test.ts"],
  };
  return { deps, log, spawned, listed: () => listed };
}

describe("integration lane — fails instead of silently skipping", () => {
  it("exits non-zero without the KOLEKTO_ITEST_* environment and spawns nothing", async () => {
    const l = lane({ env: {} });
    assert.equal(await runIntegrationLane(l.deps), 1);
    assert.equal(l.listed(), 0);
    assert.equal(l.spawned.length, 0);
    assert.match(l.log.join("\n"), /ENV_MISSING/);
  });

  it("exits non-zero for a developer-database URL", async () => {
    const l = lane({ env: testEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://postgres:${PASSWORD}@127.0.0.1:54322/postgres` }) });
    assert.equal(await runIntegrationLane(l.deps), 1);
    assert.equal(l.spawned.length, 0);
    assert.ok(!l.log.join("\n").includes(PASSWORD), "no secret in the lane log");
  });

  it("exits non-zero when test/integration/ holds no test files", async () => {
    const l = lane({ files: [] });
    assert.equal(await runIntegrationLane(l.deps), 1);
    assert.equal(l.spawned.length, 0);
    assert.match(l.log.join("\n"), /NO_INTEGRATION_FILES/);
  });

  it("exits non-zero when a file does not go through the gate", async () => {
    const l = lane({ files: [{ path: "test/integration/a.test.ts", source: GATED_SOURCE }, { path: "test/integration/b.test.ts", source: `describe("x", { skip: true }, () => {});` }] });
    assert.equal(await runIntegrationLane(l.deps), 1);
    assert.equal(l.spawned.length, 0);
    assert.match(l.log.join("\n"), /FILE_NOT_GATED.*b\.test\.ts/);
  });

  it("exits non-zero when a file contains a pause-switch write", async () => {
    const l = lane({ files: [{ path: "test/integration/a.test.ts", source: `${GATED_SOURCE}\nawait ${SETTER}(sql, true);` }] });
    assert.equal(await runIntegrationLane(l.deps), 1);
    assert.equal(l.spawned.length, 0);
    assert.match(l.log.join("\n"), /FORBIDDEN_SWITCH_WRITE/);
  });

  const failingRuns: readonly [string, ChildResult, string][] = [
    ["a failing test", { code: 1, signal: null, output: tap({ pass: 2, fail: 1 }) }, "RUN_FAILED"],
    ["a non-zero exit with a clean summary", { code: 1, signal: null, output: tap({}) }, "RUN_FAILED"],
    ["skipped tests", { code: 0, signal: null, output: tap({ pass: 0, skipped: 3 }) }, "RUN_SKIPPED_TESTS"],
    ["todo tests", { code: 0, signal: null, output: tap({ pass: 2, todo: 1 }) }, "RUN_SKIPPED_TESTS"],
    ["zero tests", { code: 0, signal: null, output: tap({ tests: 0, pass: 0 }) }, "RUN_EMPTY"],
    ["cancelled tests", { code: 0, signal: null, output: tap({ pass: 2, cancelled: 1 }) }, "RUN_FAILED"],
    ["no TAP summary", { code: 0, signal: null, output: "TAP version 13\n" }, "RUN_INCONCLUSIVE"],
    ["a partial TAP summary", { code: 0, signal: null, output: "# tests 3\n# pass 3\n" }, "RUN_INCONCLUSIVE"],
    ["pass count below test count", { code: 0, signal: null, output: tap({ tests: 4 }) }, "RUN_INCONCLUSIVE"],
    ["a killed process", { code: null, signal: "SIGTERM", output: tap({}) }, "RUN_FAILED"],
  ];
  for (const [label, result, code] of failingRuns) {
    it(`exits non-zero for ${label}`, async () => {
      const l = lane({ result });
      assert.equal(await runIntegrationLane(l.deps), 1);
      assert.match(l.log.join("\n"), new RegExp(code));
    });
  }

  it("exits zero only for a run where every counted test passed", async () => {
    const l = lane();
    assert.equal(await runIntegrationLane(l.deps), 0);
    assert.equal(l.spawned.length, 1);
    assert.deepEqual(l.spawned[0]!.files, ["test/integration/a.test.ts"]);
    assert.match(l.log.join("\n"), /3\/3 test\(s\) in 1 file\(s\), none skipped/);
  });

  it("forwards only an allow-listed environment: no developer endpoint, provider credential or app secret", () => {
    const child = buildChildEnv({
      ...testEnv({ KOLEKTO_ITEST_REQUIRED: "0" }),
      SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      supabase_db_url: "lower-case alias",
      DATABASE_URL: "x",
      SUPABASE_SERVICE_ROLE_KEY: "x",
      KOLEKTO_WORKER_INTEGRATION: "1",
      MAILPIT_API: "http://127.0.0.1:54324",
      EMAIL_PROVIDER: "ses",
      EMAIL_SMTP_PORT: "54325",
      EMAIL_AWS_SECRET_ACCESS_KEY: "x",
      EMAIL_API_KEY: "x",
      KOLEKTO_SESSION_SECRET: "x",
      KOLEKTO_PRODUCTION_PROJECT_REF: "x",
      KOLEKTO_ENV: "local",
      PAYSTACK_API_KEY: "x",
      PAYSTACK_WEBHOOK_SECRET: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      NODE_OPTIONS: "--require ./evil.js",
      PGPASSWORD: "x",
      PATH: "/usr/bin",
    });
    assert.deepEqual(Object.keys(child).sort(), ["KOLEKTO_ITEST_DB_URL", "KOLEKTO_ITEST_MAILPIT_API", "KOLEKTO_ITEST_REQUIRED", "KOLEKTO_ITEST_SMTP_PORT", "KOLEKTO_ITEST_STACK_ID", "PATH"]);
    assert.equal(child["KOLEKTO_ITEST_REQUIRED"], "1");
  });

  it("runs the files serially, by explicit path, with the TAP reporter the canary reads", () => {
    const args = nodeTestArgs(["test/integration/a.test.ts"]);
    assert.deepEqual(args, ["--experimental-strip-types", "--test", "--test-concurrency=1", "--test-reporter=tap", "test/integration/a.test.ts"]);
  });

  it("parses node:test's TAP summary and ignores indented subtest lines", () => {
    assert.deepEqual(parseTapSummary(`    # tests 99\n${tap({ tests: 2, pass: 2 })}`), { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, directives: 0 });
    assert.equal(parseTapSummary(""), null);
  });

  it("counts SKIP/TODO directives at any depth, but not an escaped '#' in a test name", () => {
    const output = [`ok 1 - suite # SKIP`, `    ok 1 - inner # TODO later`, `ok 2 - name with \\# SKIP in it`, tap({})].join("\n");
    assert.equal(parseTapSummary(output)?.directives, 2);
    assert.throws(() => evaluateRun({ code: 0, signal: null, output }), (e: unknown) => e instanceof IntegrationGateError && e.has("RUN_SKIPPED_TESTS"));
  });

  it("checkIntegrationFiles returns the paths of a fully gated set", () => {
    assert.deepEqual(checkIntegrationFiles([{ path: "p", source: GATED_SOURCE }], ["p"]), ["p"]);
    assert.equal(usesIntegrationGate(GATED_SOURCE.replace("gate.postflight()", "")), false);
  });
});

describe("integration lane — against real node:test output (mocked gate, no database)", () => {
  const gateUrl = pathToFileURL(path.join(WORKER_ROOT, "test", "support", "itest-gate.ts")).href;

  function runFixture(source: string): ChildResult {
    const dir = mkdtempSync(path.join(tmpdir(), "kolekto-gate-"));
    try {
      const file = path.join(dir, "fixture.test.ts");
      writeFileSync(file, source);
      const r = spawnSync(process.execPath, nodeTestArgs([file]), { encoding: "utf8", env: buildChildEnv({ PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] }), timeout: 60_000 });
      return { code: r.status, signal: r.signal, output: r.stdout };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a gate refusal in before() fails every test in the file — nothing is skipped", () => {
    const result = runFixture([
      `import { before, describe, it } from "node:test";`,
      `import { createIntegrationGate } from ${JSON.stringify(gateUrl)};`,
      `const gate = createIntegrationGate({ env: process.env, probeIdentity: async () => ({}), readPauseSwitch: async () => ({ rowCount: 1, enabled: false }) });`,
      `describe("fixture", () => {`,
      `  before(() => gate.verify());`,
      `  it("one", () => { gate.verified(); });`,
      `  it("two", () => { gate.verified(); });`,
      `});`,
    ].join("\n"));
    const summary = parseTapSummary(result.output);
    assert.ok(summary, "TAP summary present");
    // node:test 22 reports tests under a failed before() hook as cancelled, not failed.
    assert.equal(summary.fail + summary.cancelled, 2, "both tests are reported as not passing");
    assert.equal(summary.pass, 0);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.directives, 0);
    assert.match(result.output, /ENV_MISSING/, "required mode is on; the missing KOLEKTO_ITEST_* set is the refusal");
    assert.notEqual(result.code, 0);
    assert.throws(() => evaluateRun(result), (e: unknown) => e instanceof IntegrationGateError && e.has("RUN_FAILED"));
  });

  it("an all-skipped file passes node:test but fails the lane canary", () => {
    const result = runFixture(`import { describe, it } from "node:test";\ndescribe("fixture", { skip: true }, () => { it("x", () => {}); });`);
    assert.equal(result.code, 0, "node:test itself treats skips as success");
    assert.throws(() => evaluateRun(result), (e: unknown) => e instanceof IntegrationGateError && e.has("RUN_SKIPPED_TESTS") && e.has("RUN_EMPTY"));
  });

  it("a skipped suite beside a passing test fails the lane although node:test counts 0 skipped", () => {
    const result = runFixture([
      `import { describe, it } from "node:test";`,
      `it("runs", () => {});`,
      `describe("gated off", { skip: true }, () => { it("x", () => {}); });`,
    ].join("\n"));
    const summary = parseTapSummary(result.output);
    assert.ok(summary);
    assert.equal(result.code, 0);
    assert.deepEqual([summary.tests, summary.pass, summary.skipped], [1, 1, 0], "the counters alone would look clean");
    assert.equal(summary.directives, 1);
    assert.throws(() => evaluateRun(result), (e: unknown) => e instanceof IntegrationGateError && e.has("RUN_SKIPPED_TESTS"));
  });
});

// ── Static guards over the repository ─────────────────────────────────────────

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(path.join(WORKER_ROOT, dir), { recursive: true, encoding: "utf8" })
      .map((rel) => path.join(dir, rel))
      .filter((rel) => /\.(ts|md|mjs|js|json)$/.test(rel));
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
}

describe("integration lane — repository guards", () => {
  it("npm test runs unit files only; test:integration runs the gated runner", () => {
    const pkg = JSON.parse(readFileSync(path.join(WORKER_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["test"], `node --experimental-strip-types --test "test/!(*.integration).test.ts"`);
    assert.equal(pkg.scripts["test:integration"], "node --experimental-strip-types test/support/run-integration.ts");
  });

  it("the unit glob matches no integration or support file, and the lanes do not overlap", () => {
    const pkg = JSON.parse(readFileSync(path.join(WORKER_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const pattern = /--test "([^"]+)"/.exec(pkg.scripts["test"] ?? "")?.[1];
    assert.ok(pattern);
    const unit = globSync(pattern, { cwd: WORKER_ROOT }).map((f) => f.replaceAll("\\", "/"));
    assert.ok(unit.includes("test/itest-gate.test.ts") && unit.includes("test/itest-environment.test.ts"));
    for (const file of unit) {
      assert.doesNotMatch(file, /\.integration\.test\.ts$|^test\/(integration|support)\//, file);
    }
    const integration = filesUnder(path.join("test", "integration")).map((f) => f.replaceAll("\\", "/"));
    assert.ok(integration.every((f) => !unit.includes(f)));
  });

  it("no harness or integration file can write the pause switch, except the one guarded helper (Phase 7)", () => {
    const helper = path.join("test", "support", "itest-switch.ts");
    for (const rel of [...filesUnder(path.join("test", "support")), ...filesUnder(path.join("test", "integration"))]) {
      const found = findForbiddenSwitchWrites(readFileSync(path.join(WORKER_ROOT, rel), "utf8"));
      assert.deepEqual(found, rel === helper ? ["switch setter call"] : [], rel);
    }
  });

  it("every integration test file goes through the gate", () => {
    for (const rel of filesUnder(path.join("test", "integration")).filter((f) => f.endsWith(".test.ts"))) {
      assert.ok(usesIntegrationGate(readFileSync(path.join(WORKER_ROOT, rel), "utf8")), rel);
    }
  });

  it("only itest-db.ts may import the database driver; no harness file opens SMTP or HTTP", () => {
    const dbModule = path.join("test", "support", "itest-db.ts");
    // Phase 7: the SMTP fault proxy is the one exception to node:net; its upstream host is a constant 127.0.0.1 (itest-worker.test.ts).
    const faultProxy = path.join("test", "support", "itest-smtp-fault-proxy.ts");
    for (const rel of filesUnder(path.join("test", "support")).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(path.join(WORKER_ROOT, rel), "utf8");
      if (rel === faultProxy) assert.doesNotMatch(source, /from\s+["'](?:pg|@kolekto\/adapters|@kolekto\/db|node:tls|node:http|node:https|node:dns|nodemailer)["']|\bfetch\s*\(/, rel);
      else assert.doesNotMatch(source, /from\s+["'](?:pg|@kolekto\/adapters|@kolekto\/db|node:net|node:tls|node:http|node:https|nodemailer)["']|\bfetch\s*\(/, rel);
      if (rel !== dbModule) assert.doesNotMatch(source, /from\s+["']postgres["']/, rel);
    }
    const db = readFileSync(path.join(WORKER_ROOT, dbModule), "utf8");
    assert.match(db, /^import postgres from "postgres";$/m);
    // Each driver call sits behind a brand check; the URL string is never handed to the driver.
    assert.match(db, /assertProbeTarget\(db\)/);
    assert.match(db, /assertVerifiedEnvironment\(env\)/);
    assert.doesNotMatch(db, /\.url\b|reveal\(\)\s*\)/, "no URL string reaches the driver");
  });
});

// ── Phase 1b: relocation, connection enforcement and file selection ───────────

describe("integration lane — Phase 1b relocation and connection enforcement", () => {
  const integrationFiles = () =>
    filesUnder(path.join("test", "integration")).filter((f) => f.endsWith(".test.ts")).map((f) => f.replaceAll("\\", "/")).sort();

  it("the integration files (six from Phase 1b, the Phase 6A end-to-end file and the Phase 7 real-worker file) live in test/integration/ under their approved names", () => {
    assert.deepEqual(integrationFiles(), [...INTEGRATION_MANIFEST].sort());
    // M13.3 R3 added the communication-policy file (tenth).
    assert.equal(INTEGRATION_MANIFEST.length, 10);
    assert.ok(INTEGRATION_MANIFEST.includes("test/integration/notification-sender-mailpit.integration.test.ts"));
    assert.ok(INTEGRATION_MANIFEST.includes("test/integration/notification-e2e-mailpit.integration.test.ts"));
    assert.ok(!INTEGRATION_MANIFEST.some((f) => f.includes("notification-pipeline")), "the pipeline file was renamed");
  });

  it("no integration file is left at the top level of test/", () => {
    const top = readdirSync(path.join(WORKER_ROOT, "test")).filter((f) => f.endsWith(".integration.test.ts"));
    assert.deepEqual(top, []);
  });

  it("every integration file imports the gate, wires liveGateDeps() and connects only through connectVerified()", () => {
    for (const rel of integrationFiles()) {
      const source = readFileSync(path.join(WORKER_ROOT, rel), "utf8");
      assert.ok(usesIntegrationGate(source), `${rel} is not gated`);
      assert.deepEqual(findUnsafeConnectionPatterns(source), [], rel);
      assert.deepEqual(findForbiddenSwitchWrites(source), [], rel);
      assert.match(source, /connectVerified\(gate\.verified\(\), \{ max: /, `${rel} opens no verified connection`);
      assert.doesNotMatch(source, /from "\.\.\/src\//, `${rel} has a stale relative import`);
    }
  });

  it("the lane's own file check accepts exactly the real integration set", async () => {
    const files = await defaultLaneDeps().listIntegrationFiles();
    assert.deepEqual(checkIntegrationFiles(files, INTEGRATION_MANIFEST).map((f) => f.replaceAll("\\", "/")).sort(), [...INTEGRATION_MANIFEST].sort());
  });

  it("a file missing from, or added outside, the manifest fails the lane", () => {
    const one = { path: "test/integration/a.test.ts", source: GATED_SOURCE };
    assert.throws(() => checkIntegrationFiles([one], ["test/integration/a.test.ts", "test/integration/b.test.ts"]), (e: unknown) => e instanceof IntegrationGateError && e.has("INTEGRATION_FILE_MISSING"));
    assert.throws(() => checkIntegrationFiles([one, { ...one, path: "test/integration/c.test.ts" }], ["test/integration/a.test.ts"]), (e: unknown) => e instanceof IntegrationGateError && e.has("INTEGRATION_FILE_UNLISTED"));
    assert.deepEqual(checkIntegrationFiles([{ ...one, path: "test\\integration\\a.test.ts" }], ["test/integration/a.test.ts"]), ["test\\integration\\a.test.ts"], "Windows separators match");
  });

  it("detects direct driver use, ambient endpoints, developer ports and skips", () => {
    const cases: readonly [string, RegExp][] = [
      [`import postgres from "postgres";`, /driver as a value/],
      [`const sql = postgres(url, { max: 1 });`, /driver directly/],
      [`const sql = postgres({ host });`, /driver directly/],
      [`const url = process.env["KOLEKTO_ITEST_DB_URL"];`, /process\.env/],
      [`const url = SUPABASE_DB_URL;`, /developer endpoint variable/],
      [`fetch("http://127.0.0.1:54324/api")`, /developer-stack port/],
      [`describe("x", { skip: SKIP }, () => {});`, /skips/],
      [`it.todo("later");`, /skips/],
    ];
    for (const [snippet, label] of cases) {
      const found = findUnsafeConnectionPatterns(`${GATED_SOURCE}\n${snippet}`);
      assert.ok(found.some((l) => label.test(l)), `${snippet} → ${JSON.stringify(found)}`);
    }
    assert.deepEqual(findUnsafeConnectionPatterns(`${GATED_SOURCE}\nimport type postgres from "postgres";\n// postgres(1).js surfaces the sqlstate`), []);
    assert.ok(findUnsafeConnectionPatterns(GATED_SOURCE.replace("liveGateDeps()", "fakeDeps")).some((l) => /liveGateDeps/.test(l)));
  });

  it("the lane refuses a file that opens its own connection, before spawning anything", async () => {
    const l = lane({ files: [{ path: "test/integration/a.test.ts", source: `${GATED_SOURCE}\nconst sql = postgres(url, { max: 1 });` }] });
    assert.equal(await runIntegrationLane(l.deps), 1);
    assert.equal(l.spawned.length, 0);
    assert.match(l.log.join("\n"), /FILE_UNSAFE_CONNECTION/);
  });

  it("the real lane refuses without verified test-stack configuration and lists or spawns nothing", async () => {
    for (const env of [{}, { SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", KOLEKTO_WORKER_INTEGRATION: "1" }]) {
      let spawned = 0;
      let listed = 0;
      const real = defaultLaneDeps();
      const log: string[] = [];
      const code = await runIntegrationLane({
        ...real,
        env,
        listIntegrationFiles: async () => { listed++; return real.listIntegrationFiles(); },
        runTests: async () => { spawned++; return { code: 0, signal: null, output: "" }; },
        log: (t) => log.push(t),
      });
      assert.equal(code, 1);
      assert.equal(listed + spawned, 0, "refused at the static gate");
      assert.match(log.join("\n"), /ENV_MISSING/);
    }
  });

  it("the test:integration entry point exits non-zero in a scrubbed environment (static refusal, no connection possible)", () => {
    // Phase 1c: the entry point now reads <repo>/.env.itest (itest-env-file.ts). An ambient
    // KOLEKTO_ITEST_* variable is refused BEFORE that file is read, so this spawned run is
    // refused whether or not the Phase 3 bootstrap has created the file, and `npm test` can
    // never start a real integration run through it. The missing-file path is covered
    // in-process with an injected file system (itest-env-file.test.ts).
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join("test", "support", "run-integration.ts")], {
      cwd: WORKER_ROOT,
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "", KOLEKTO_ITEST_STACK_ID: STACK_ID },
      timeout: 60_000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Integration gate refused/);
    assert.match(r.stderr, /ITEST_ENV_AMBIENT/);
    assert.ok(!r.stderr.includes(STACK_ID), "the ambient value is not echoed");
    assert.doesNotMatch(r.stdout, /^TAP version/m, "no test process was started");
  });
});

// ── Phase 4: explicit SMTP lane mode ──────────────────────────────────────────

describe("integration lane — Phase 4 explicit SMTP mode", () => {
  const A = "test/integration/a.test.ts";
  const M = "test/integration/m.test.ts";
  const SMTP_SOURCE = `${GATED_SOURCE}\nconst p = new MailpitEmailProvider({ host: gate.verified().smtp.host });`;
  const files: readonly SourceFile[] = [{ path: A, source: GATED_SOURCE }, { path: M, source: SMTP_SOURCE }];
  const smtpLane = (smtpMode?: "with" | "without", list: readonly SourceFile[] = files) => {
    const l = lane({ files: list, manifest: [A, M] });
    const deps: LaneDeps = { ...l.deps, smtpFiles: [M], ...(smtpMode === undefined ? {} : { smtpMode }) };
    return { ...l, deps };
  };

  it("parses exactly one of --with-smtp / --without-smtp and refuses anything else", () => {
    assert.equal(parseLaneArgs(["--with-smtp"]), "with");
    assert.equal(parseLaneArgs(["--without-smtp"]), "without");
    for (const [argv, code] of [
      [[], "SMTP_MODE_REQUIRED"],
      [["--with-smtp", "--without-smtp"], "SMTP_MODE_REQUIRED"],
      [["--without-smtp", "--without-smtp"], "SMTP_MODE_REQUIRED"],
      [["--smtp"], "LANE_ARGUMENT_INVALID"],
      [["--without-smtp", "--linked"], "LANE_ARGUMENT_INVALID"],
    ] as const) {
      assert.throws(() => parseLaneArgs(argv), (e: unknown) => e instanceof IntegrationGateError && e.has(code), JSON.stringify(argv));
    }
  });

  it("refuses without a mode when the manifest holds SMTP files, and starts nothing", async () => {
    const l = smtpLane();
    assert.equal(await runIntegrationLane(l.deps), 1);
    assert.equal(l.spawned.length, 0);
    assert.match(l.log.join("\n"), /SMTP_MODE_REQUIRED/);
  });

  it("--without-smtp starts only the non-SMTP files and labels the run as partial, naming the withheld file", async () => {
    const l = smtpLane("without");
    assert.equal(await runIntegrationLane(l.deps), 0);
    assert.equal(l.spawned.length, 1);
    assert.deepEqual(l.spawned[0]!.files, [A]);
    const log = l.log.join("\n");
    assert.match(log, /WITHOUT SMTP \(partial run, not the full suite\)/);
    assert.match(log, /in 1 of 2 file\(s\)/);
    assert.ok(log.includes(`Withheld, not started (SMTP; needs --with-smtp and SMTP approval): ${M}`));
  });

  it("--without-smtp still checks the withheld file: an unsafe SMTP file blocks the whole lane", async () => {
    const l = smtpLane("without", [{ path: A, source: GATED_SOURCE }, { path: M, source: `${SMTP_SOURCE}\nconst u = process.env.X;` }]);
    assert.equal(await runIntegrationLane(l.deps), 1);
    assert.equal(l.spawned.length, 0);
  });

  it("--with-smtp starts every file", async () => {
    const l = smtpLane("with");
    assert.equal(await runIntegrationLane(l.deps), 0);
    assert.deepEqual(l.spawned[0]!.files, [A, M]);
    assert.match(l.log.join("\n"), /in 2 file\(s\), none skipped/);
  });

  it("refuses a file outside the SMTP set that uses the SMTP adapter or endpoints (FILE_SMTP_UNDECLARED)", async () => {
    for (const sneaky of ["new MailpitEmailProvider({})", "const s = gate.verified().smtp;", "const api = mailpitApi();"]) {
      const l = smtpLane("without", [{ path: A, source: `${GATED_SOURCE}\n${sneaky}` }, { path: M, source: SMTP_SOURCE }]);
      assert.equal(await runIntegrationLane(l.deps), 1, sneaky);
      assert.equal(l.spawned.length, 0, sneaky);
      assert.match(l.log.join("\n"), /FILE_SMTP_UNDECLARED/, sneaky);
    }
  });

  it("the real lane declares exactly the sender-to-Mailpit, end-to-end and real-worker files as SMTP, and only they use SMTP", () => {
    assert.deepEqual([...SMTP_INTEGRATION_FILES], [
      "test/integration/notification-e2e-mailpit.integration.test.ts",
      "test/integration/notification-sender-mailpit.integration.test.ts",
      "test/integration/notification-worker-reliability.integration.test.ts",
      "test/integration/notification-worker-runtime.integration.test.ts",
    ]);
    assert.deepEqual(defaultLaneDeps().smtpFiles, SMTP_INTEGRATION_FILES);
    for (const rel of INTEGRATION_MANIFEST) {
      const source = readFileSync(path.join(WORKER_ROOT, rel), "utf8");
      const usesSmtp = /\bMailpitEmailProvider\b|\.smtp\b|\bmailpitApi\b/.test(source);
      assert.equal(usesSmtp, SMTP_INTEGRATION_FILES.includes(rel), rel);
    }
  });
});
