/**
 * itest-env-file.test.ts — M13.2 Phase 1c: how the integration runner loads `.env.itest`.
 *
 * The file system is injected: every test hands the loader a fake readFile, so
 * no real `.env.itest` or `.env.local` is ever read and no test depends on
 * whether the Phase 3 bootstrap has run. The lane's child process is mocked.
 * No database, SMTP or Mailpit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";

import {
  findAmbientItestVariables,
  ITEST_ENV_FILE_NAME,
  ITEST_ENV_FILE_PATH,
  loadIntegrationEnvironment,
  MAX_ENV_FILE_BYTES,
  parseItestEnvFile,
  type EnvFileDeps,
} from "./support/itest-env-file.ts";
import { ITEST_DB_ROLE, IntegrationGateError, parseIntegrationEnvironment, type EnvSource, type GateViolationCode } from "./support/itest-environment.ts";
import { defaultEntryDeps, runIntegrationEntry, type EntryDeps } from "./support/itest-lane.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PASSWORD = randomBytes(18).toString("base64url");
const STACK_ID = randomUUID();
const DB_URL = `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422/postgres`;

const GOOD_FILE = [
  "# written by the kolekto-itest bootstrap",
  `KOLEKTO_ITEST_DB_URL=${DB_URL}`,
  "KOLEKTO_ITEST_SMTP_PORT=55425",
  "KOLEKTO_ITEST_MAILPIT_API=http://127.0.0.1:55424",
  `KOLEKTO_ITEST_STACK_ID=${STACK_ID}`,
  "",
].join("\n");

/** Developer and application variables the runner's shell may carry. None may be used as a source. */
const DEVELOPER_ENV: EnvSource = {
  PATH: "/usr/bin",
  SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  EMAIL_SMTP_PORT: "54325",
  MAILPIT_API: "http://127.0.0.1:54324",
  KOLEKTO_SESSION_SECRET: "dev-session-secret-value",
  KOLEKTO_WORKER_INTEGRATION: "1",
};

function refusedWith(code: GateViolationCode) {
  return (e: unknown) => e instanceof IntegrationGateError && e.has(code);
}

function fs(files: Record<string, string | Error>) {
  const reads: string[] = [];
  const readFile = async (p: string) => {
    reads.push(p);
    const f = files[p];
    if (f === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
    if (f instanceof Error) throw f;
    return f;
  };
  return { readFile, reads };
}

function deps(processEnv: EnvSource, files: Record<string, string | Error>): EnvFileDeps & { reads: string[] } {
  const f = fs(files);
  return { processEnv, readFile: f.readFile, filePath: ITEST_ENV_FILE_PATH, reads: f.reads };
}

function assertNoSecret(error: unknown): void {
  assert.ok(error instanceof Error);
  for (const rendering of [error.message, String(error), inspect(error), JSON.stringify(error), error.stack ?? ""]) {
    assert.ok(!rendering.includes(PASSWORD), "the password never appears");
    assert.ok(!rendering.includes(STACK_ID), "the stack id never appears");
  }
}

describe(".env.itest — location and parsing", () => {
  it("is read from the repository root, and .env.* is git-ignored there", () => {
    assert.equal(path.resolve(ITEST_ENV_FILE_PATH), path.resolve(REPO_ROOT, ITEST_ENV_FILE_NAME));
    const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    assert.ok(gitignore.includes(".env.*"), ".gitignore ignores .env.* (so .env.itest is never committed)");
  });

  it("parses the bootstrap's KEY=value lines into a configuration the gate accepts", () => {
    const values = parseItestEnvFile(GOOD_FILE);
    assert.deepEqual(Object.keys(values).sort(), ["KOLEKTO_ITEST_DB_URL", "KOLEKTO_ITEST_MAILPIT_API", "KOLEKTO_ITEST_SMTP_PORT", "KOLEKTO_ITEST_STACK_ID"]);
    const config = parseIntegrationEnvironment(values);
    assert.equal(config.db.port, 55422);
    assert.equal(config.stackId.reveal(), STACK_ID);
  });

  it("tolerates CRLF line endings, blank lines, comments and one leading BOM", () => {
    const values = parseItestEnvFile(`﻿${GOOD_FILE.replaceAll("\n", "\r\n")}\r\n# trailing comment\r\n`);
    assert.equal(values["KOLEKTO_ITEST_SMTP_PORT"], "55425");
  });

  it("refuses anything but the four KOLEKTO_ITEST_* keys, naming the line or key, never the value", () => {
    const cases: readonly [string, RegExp][] = [
      [`${GOOD_FILE}SUPABASE_DB_URL=${DB_URL}\n`, /line 6 sets SUPABASE_DB_URL/],
      [`${GOOD_FILE}KOLEKTO_ITEST_REQUIRED=1\n`, /sets KOLEKTO_ITEST_REQUIRED/],
      [`${GOOD_FILE}KOLEKTO_ITEST_SMTP_PORT=55426\n`, /sets KOLEKTO_ITEST_SMTP_PORT more than once/],
      [`KOLEKTO_ITEST_DB_URL="${DB_URL}"\n`, /quoted values are not supported/],
      [`KOLEKTO_ITEST_DB_URL='${DB_URL}'\n`, /quoted values are not supported/],
      [`export KOLEKTO_ITEST_DB_URL=${DB_URL}\n`, /line 1 is not a KEY=value line/],
      [`KOLEKTO_ITEST_DB_URL ${DB_URL}\n`, /line 1 is not a KEY=value line/],
      [` KOLEKTO_ITEST_DB_URL=${DB_URL}\n`, /line 1 is not a KEY=value line/],
      [`kolekto_itest_db_url=${DB_URL}\n`, /line 1 is not a KEY=value line/],
      [`${PASSWORD}\n`, /line 1 is not a KEY=value line/],
    ];
    for (const [text, message] of cases) {
      let caught: unknown;
      try {
        parseItestEnvFile(text);
      } catch (error) {
        caught = error;
      }
      assert.ok(refusedWith("ENV_FILE_INVALID")(caught), text.slice(0, 40));
      assert.match((caught as Error).message, message);
      assertNoSecret(caught);
    }
  });

  it("refuses an oversized file", () => {
    assert.throws(() => parseItestEnvFile(`# ${"x".repeat(MAX_ENV_FILE_BYTES)}\n`), refusedWith("ENV_FILE_INVALID"));
  });

  it("an incomplete file is refused by the gate's own rules (ENV_MISSING), with no default", () => {
    const values = parseItestEnvFile(GOOD_FILE.split("\n").filter((l) => !l.startsWith("KOLEKTO_ITEST_MAILPIT_API")).join("\n"));
    assert.throws(() => parseIntegrationEnvironment({ ...DEVELOPER_ENV, ...values }), (e: unknown) => refusedWith("ENV_MISSING")(e) && /KOLEKTO_ITEST_MAILPIT_API/.test((e as Error).message));
  });
});

describe(".env.itest — loading fails closed, with no fallback", () => {
  it("loads exactly one file, the .env.itest path, and adds its four values to the environment", async () => {
    const d = deps(DEVELOPER_ENV, { [ITEST_ENV_FILE_PATH]: GOOD_FILE });
    const env = await loadIntegrationEnvironment(d);
    assert.deepEqual(d.reads, [ITEST_ENV_FILE_PATH], "nothing else is read (.env.local is never opened)");
    assert.equal(env["KOLEKTO_ITEST_DB_URL"], DB_URL);
    assert.equal(parseIntegrationEnvironment(env).db.role, ITEST_DB_ROLE);
  });

  it("a missing .env.itest is a refusal; the developer database URL and Mailpit are never used instead", async () => {
    const d = deps(DEVELOPER_ENV, {
      // These exist, but must never be consulted.
      [path.join(REPO_ROOT, ".env.local")]: `SUPABASE_DB_URL=${DEVELOPER_ENV["SUPABASE_DB_URL"]}\n`,
      [path.join(REPO_ROOT, ".env")]: "X=1\n",
    });
    await assert.rejects(loadIntegrationEnvironment(d), (e: unknown) => refusedWith("ENV_FILE_MISSING")(e) && /no fallback/.test((e as Error).message) && !/postgres:postgres/.test((e as Error).message));
    assert.deepEqual(d.reads, [ITEST_ENV_FILE_PATH]);
  });

  it("an unreadable file is a refusal with an errno only", async () => {
    const leaky = Object.assign(new Error(`EACCES: permission denied, open '${ITEST_ENV_FILE_PATH}' ${PASSWORD}`), { code: "EACCES" });
    const error = await loadIntegrationEnvironment(deps({}, { [ITEST_ENV_FILE_PATH]: leaky })).then(() => null, (e: unknown) => e);
    assert.ok(refusedWith("ENV_FILE_UNREADABLE")(error));
    assert.match((error as Error).message, /code EACCES/);
    assertNoSecret(error);
    assert.equal((error as Error).cause, undefined);
  });

  it("refuses any ambient KOLEKTO_ITEST_* variable before reading the file, so a shell export can never override it", async () => {
    for (const ambient of [{ KOLEKTO_ITEST_DB_URL: DB_URL }, { kolekto_itest_stack_id: STACK_ID }, { KOLEKTO_ITEST_REQUIRED: "1" }, { KOLEKTO_ITEST_SMTP_PORT: "" }]) {
      const d = deps({ ...DEVELOPER_ENV, ...ambient }, { [ITEST_ENV_FILE_PATH]: GOOD_FILE });
      const error = await loadIntegrationEnvironment(d).then(() => null, (e: unknown) => e);
      assert.ok(refusedWith("ITEST_ENV_AMBIENT")(error), JSON.stringify(Object.keys(ambient)));
      assert.deepEqual(d.reads, [], "the file is not read");
      assertNoSecret(error);
    }
    assert.deepEqual(findAmbientItestVariables({ KOLEKTO_ITEST_X: "1", OTHER: "2", KOLEKTO_ITESTX: "3" }), ["KOLEKTO_ITEST_X"]);
  });
});

// ── The integration entry point ───────────────────────────────────────────────

const GATED_SOURCE = [
  `import { createIntegrationGate } from "../support/itest-gate.ts";`,
  `import { connectVerified, liveGateDeps } from "../support/itest-db.ts";`,
  `const gate = createIntegrationGate(liveGateDeps());`,
  `before(() => gate.verify());`,
  `after(() => gate.postflight());`,
].join("\n");

const PASSING_TAP = ["TAP version 13", "ok 1 - x", "1..1", "# tests 1", "# pass 1", "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0"].join("\n");

function entry(processEnv: EnvSource, files: Record<string, string | Error>) {
  const log: string[] = [];
  const spawned: Readonly<Record<string, string>>[] = [];
  let listed = 0;
  const f = fs(files);
  const deps: EntryDeps = {
    envFile: { processEnv, readFile: f.readFile, filePath: ITEST_ENV_FILE_PATH },
    lane: {
      listIntegrationFiles: async () => { listed++; return [{ path: "test/integration/a.test.ts", source: GATED_SOURCE }]; },
      runTests: async (_files, env) => { spawned.push(env); return { code: 0, signal: null, output: PASSING_TAP }; },
      log: (t) => log.push(t),
      manifest: ["test/integration/a.test.ts"],
    },
  };
  return { deps, log, spawned, listed: () => listed, reads: f.reads };
}

describe("integration entry point — refuses to list or start tests without .env.itest", () => {
  it("a missing .env.itest exits 1 before listing or spawning anything", async () => {
    const e = entry(DEVELOPER_ENV, {});
    assert.equal(await runIntegrationEntry(e.deps), 1);
    assert.equal(e.listed() + e.spawned.length, 0);
    assert.match(e.log.join("\n"), /ENV_FILE_MISSING/);
  });

  it("an ambient KOLEKTO_ITEST_* variable exits 1 without reading the file", async () => {
    const e = entry({ ...DEVELOPER_ENV, KOLEKTO_ITEST_DB_URL: DB_URL }, { [ITEST_ENV_FILE_PATH]: GOOD_FILE });
    assert.equal(await runIntegrationEntry(e.deps), 1);
    assert.deepEqual(e.reads, []);
    assert.equal(e.listed() + e.spawned.length, 0);
    assert.ok(!e.log.join("\n").includes(PASSWORD));
  });

  it("a malformed or incomplete file exits 1 before listing anything, without echoing values", async () => {
    for (const text of [`${GOOD_FILE}SUPABASE_DB_URL=x\n`, GOOD_FILE.replace(/KOLEKTO_ITEST_STACK_ID=.*\n/, ""), GOOD_FILE.replace("55422", "54322")]) {
      const e = entry(DEVELOPER_ENV, { [ITEST_ENV_FILE_PATH]: text });
      assert.equal(await runIntegrationEntry(e.deps), 1);
      assert.equal(e.listed() + e.spawned.length, 0);
      assert.ok(!e.log.join("\n").includes(PASSWORD), "no secret in the lane log");
    }
  });

  it("with a valid file the lane runs, and the child gets the file's values but no developer variable", async () => {
    const e = entry(DEVELOPER_ENV, { [ITEST_ENV_FILE_PATH]: GOOD_FILE });
    assert.equal(await runIntegrationEntry(e.deps), 0);
    assert.equal(e.spawned.length, 1);
    const child = e.spawned[0]!;
    assert.equal(child["KOLEKTO_ITEST_DB_URL"], DB_URL);
    assert.equal(child["KOLEKTO_ITEST_REQUIRED"], "1");
    for (const name of ["SUPABASE_DB_URL", "DATABASE_URL", "EMAIL_SMTP_PORT", "MAILPIT_API", "KOLEKTO_SESSION_SECRET", "KOLEKTO_WORKER_INTEGRATION"]) {
      assert.ok(!(name in child), `${name} is not forwarded`);
    }
    assert.ok(!e.log.join("\n").includes(PASSWORD));
  });

  it("the default entry dependencies read the repository-root .env.itest with the real lane", () => {
    const d = defaultEntryDeps();
    assert.equal(d.envFile.filePath, ITEST_ENV_FILE_PATH);
    assert.equal(d.envFile.processEnv, process.env);
    assert.ok(!("env" in d.lane), "the lane receives its environment only from the loader");
  });
});
