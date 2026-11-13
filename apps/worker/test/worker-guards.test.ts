/**
 * worker-guards.test.ts — M13.2 final corrections, findings R-4, R-3 and R-1.
 *
 * Pure tests of every refusal, then the real bundle as a child process to prove the exit code and that
 * nothing is printed. No test here reaches a database: a refusal happens before any connection, and the
 * one case that gets past the guard points at a closed loopback port. Every project ref is synthetic, so
 * a broken guard could not reach a real project, and hosts that must never resolve use the .invalid TLD.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError } from "@kolekto/config";

import {
  checkWorkerEnvironment,
  checkWorkerPrivileges,
  DEGRADED_PRIVILEGES,
  describePrivilege,
  enforceWorkerEnvironment,
  QUEUE_UPDATE_COLUMNS,
  REQUIRED_PRIVILEGES,
  WORKER_FUNCTIONS,
  WORKER_READ_COLUMNS,
  type PrivilegeCheck,
} from "../src/worker-guards.ts";

const WORKER_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const REF_A = "aaaaaaaaaaaaaaaaaaaa";
const REF_B = "bbbbbbbbbbbbbbbbbbbb";
const SENTINEL = "sentinelpassword0123";

const local = (over: Record<string, string | undefined> = {}) => ({
  KOLEKTO_ENV: "local",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55421",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "placeholder-not-a-key",
  SUPABASE_DB_URL: `postgresql://role:${SENTINEL}@127.0.0.1:9/postgres`,
  ...over,
});

const staging = (over: Record<string, string | undefined> = {}) => ({
  KOLEKTO_ENV: "staging",
  NEXT_PUBLIC_SUPABASE_URL: `https://${REF_A}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "placeholder-not-a-key",
  SUPABASE_DB_URL: `postgresql://role:${SENTINEL}@db.${REF_A}.supabase.co:5432/postgres`,
  KOLEKTO_EXPECTED_PROJECT_REF: REF_A,
  ...over,
});

const production = (over: Record<string, string | undefined> = {}) => staging({ KOLEKTO_ENV: "production", KOLEKTO_EXPECTED_PROJECT_REF: undefined, ...over });

const refusal = (env: Record<string, string | undefined>) => {
  const check = checkWorkerEnvironment(env);
  return check.ok ? "allowed" : `${check.code}${check.variable === null ? "" : `:${check.variable}`}`;
};

describe("the environment guard allows what is correct", () => {
  it("local on this machine", () => {
    assert.equal(refusal(local()), "allowed");
    assert.equal(refusal(local({ SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost:5432/postgres" })), "allowed");
    assert.equal(refusal(local({ SUPABASE_DB_URL: "postgres://postgres:postgres@[::1]:5432/postgres" })), "allowed");
  });

  it("matches the variables CI's real worker runs with", () => {
    assert.equal(refusal(local({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" })), "allowed");
  });

  it("staging and production, on a direct connection and through the session pooler", () => {
    assert.equal(refusal(staging()), "allowed");
    assert.equal(refusal(production()), "allowed");
    assert.equal(refusal(staging({ SUPABASE_DB_URL: `postgresql://kolekto_worker.${REF_A}:${SENTINEL}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres` })), "allowed");
    assert.equal(refusal(production({ KOLEKTO_EXPECTED_PROJECT_REF: REF_A, KOLEKTO_PRODUCTION_PROJECT_REF: REF_A })), "allowed");
  });

  it("does not depend on email being configured", () => {
    const without = local();
    assert.equal("EMAIL_PROVIDER" in without, false);
    assert.equal(refusal(without), "allowed");
    assert.equal(refusal({ ...local(), SUPABASE_DB_URL: undefined }), "ENV_MISSING:SUPABASE_DB_URL");
  });
});

describe("every refusal condition", () => {
  const cases: readonly (readonly [string, Record<string, string | undefined>, string])[] = [
    ["KOLEKTO_ENV unset", local({ KOLEKTO_ENV: undefined }), "ENV_MISSING:KOLEKTO_ENV"],
    ["KOLEKTO_ENV blank", local({ KOLEKTO_ENV: "   " }), "ENV_MISSING:KOLEKTO_ENV"],
    ["web URL unset", local({ NEXT_PUBLIC_SUPABASE_URL: undefined }), "ENV_MISSING:NEXT_PUBLIC_SUPABASE_URL"],
    ["publishable key unset", local({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined }), "ENV_MISSING:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
    ["database URL unset", local({ SUPABASE_DB_URL: undefined }), "ENV_MISSING:SUPABASE_DB_URL"],
    ["KOLEKTO_ENV not one of the three", local({ KOLEKTO_ENV: "prod" }), "ENV_KOLEKTO_ENV_INVALID:KOLEKTO_ENV"],

    ["web URL not a URL", local({ NEXT_PUBLIC_SUPABASE_URL: "not a url" }), "ENV_SUPABASE_URL_MALFORMED:NEXT_PUBLIC_SUPABASE_URL"],
    ["web URL not http", local({ NEXT_PUBLIC_SUPABASE_URL: "ftp://127.0.0.1" }), "ENV_SUPABASE_URL_MALFORMED:NEXT_PUBLIC_SUPABASE_URL"],
    ["local with a remote web URL", local({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF_A}.supabase.co` }), "ENV_SUPABASE_URL_NOT_LOCAL:NEXT_PUBLIC_SUPABASE_URL"],
    ["staging with a loopback web URL", staging({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }), "ENV_SUPABASE_URL_NOT_HOSTED:NEXT_PUBLIC_SUPABASE_URL"],
    ["staging over plain http", staging({ NEXT_PUBLIC_SUPABASE_URL: `http://${REF_A}.supabase.co` }), "ENV_SUPABASE_URL_NOT_HOSTED:NEXT_PUBLIC_SUPABASE_URL"],
    ["a host that only starts like Supabase's", staging({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF_A}.supabase.co.example.invalid` }), "ENV_SUPABASE_URL_NOT_HOSTED:NEXT_PUBLIC_SUPABASE_URL"],
    ["production with a loopback web URL", production({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }), "ENV_SUPABASE_URL_NOT_HOSTED:NEXT_PUBLIC_SUPABASE_URL"],
    ["staging without a named project", staging({ KOLEKTO_EXPECTED_PROJECT_REF: undefined }), "ENV_EXPECTED_REF_MISSING:KOLEKTO_EXPECTED_PROJECT_REF"],
    ["staging, web URL and expected project differ", staging({ KOLEKTO_EXPECTED_PROJECT_REF: REF_B }), "ENV_SUPABASE_URL_PROJECT_MISMATCH:KOLEKTO_EXPECTED_PROJECT_REF"],
    ["production, web URL and production ref differ", production({ KOLEKTO_PRODUCTION_PROJECT_REF: REF_B }), "ENV_SUPABASE_URL_PROJECT_MISMATCH:KOLEKTO_PRODUCTION_PROJECT_REF"],
    ["staging pointed at the production project", staging({ KOLEKTO_PRODUCTION_PROJECT_REF: REF_A }), "ENV_TARGETS_PRODUCTION"],

    ["database URL not a URL", local({ SUPABASE_DB_URL: "not a url" }), "ENV_DB_URL_MALFORMED:SUPABASE_DB_URL"],
    ["database URL with another scheme", local({ SUPABASE_DB_URL: "mysql://role:x@127.0.0.1:3306/db" }), "ENV_DB_URL_MALFORMED:SUPABASE_DB_URL"],
    ["database URL with a bad port", local({ SUPABASE_DB_URL: "postgresql://role:x@127.0.0.1:not-a-port/db" }), "ENV_DB_URL_MALFORMED:SUPABASE_DB_URL"],
    ["database URL with no host: the driver would use PGHOST", local({ SUPABASE_DB_URL: "postgresql://role:x@:5432/db" }), "ENV_DB_URL_MALFORMED:SUPABASE_DB_URL"],
    ["database URL with no database: the driver would use PGDATABASE", local({ SUPABASE_DB_URL: "postgresql://role:x@127.0.0.1:5432" }), "ENV_DB_URL_MALFORMED:SUPABASE_DB_URL"],
    ["database URL with no user: the driver would use PGUSER", local({ SUPABASE_DB_URL: "postgresql://127.0.0.1:5432/db" }), "ENV_DB_URL_MALFORMED:SUPABASE_DB_URL"],
    ["database URL with an encoded host: the driver decodes it", local({ SUPABASE_DB_URL: "postgresql://role:x@127.0.0.1%2Cother.invalid:5432/db" }), "ENV_DB_URL_MALFORMED:SUPABASE_DB_URL"],
    ["database URL with a second @", local({ SUPABASE_DB_URL: "postgresql://role:x@other.invalid:1@127.0.0.1:5432/db" }), "ENV_DB_URL_MALFORMED:SUPABASE_DB_URL"],
    ["database URL redirected by a parameter", local({ SUPABASE_DB_URL: "postgresql://role:x@127.0.0.1:5432/db?host=other.invalid" }), "ENV_DB_URL_MALFORMED:SUPABASE_DB_URL"],
    ["database URL with several hosts", local({ SUPABASE_DB_URL: "postgresql://role:x@127.0.0.1:5432,other.invalid:5432/db" }), "ENV_DB_URL_MULTIPLE_HOSTS:SUPABASE_DB_URL"],
    ["local with a remote database", local({ SUPABASE_DB_URL: `postgresql://role:x@db.${REF_A}.supabase.co:5432/postgres` }), "ENV_DB_URL_NOT_LOCAL:SUPABASE_DB_URL"],
    ["staging with a loopback database", staging({ SUPABASE_DB_URL: "postgresql://role:x@127.0.0.1:5432/postgres" }), "ENV_DB_URL_PROJECT_UNKNOWN:SUPABASE_DB_URL"],
    ["staging with an unrecognised database host", staging({ SUPABASE_DB_URL: "postgresql://role:x@db.example.invalid:5432/postgres" }), "ENV_DB_URL_PROJECT_UNKNOWN:SUPABASE_DB_URL"],
    ["production with an unrecognised database host", production({ SUPABASE_DB_URL: "postgresql://role:x@db.example.invalid:5432/postgres" }), "ENV_DB_URL_PROJECT_UNKNOWN:SUPABASE_DB_URL"],
    ["a pooler URL that names no project", staging({ SUPABASE_DB_URL: "postgresql://postgres:x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres" }), "ENV_DB_URL_PROJECT_UNKNOWN:SUPABASE_DB_URL"],
    ["web URL says staging, database URL is another project", staging({ SUPABASE_DB_URL: `postgresql://role:x@db.${REF_B}.supabase.co:5432/postgres` }), "ENV_DB_URL_PROJECT_MISMATCH:SUPABASE_DB_URL"],
    ["the same through the pooler", staging({ SUPABASE_DB_URL: `postgresql://role.${REF_B}:x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres` }), "ENV_DB_URL_PROJECT_MISMATCH:SUPABASE_DB_URL"],
    ["production, database URL is another project", production({ SUPABASE_DB_URL: `postgresql://role:x@db.${REF_B}.supabase.co:5432/postgres` }), "ENV_DB_URL_PROJECT_MISMATCH:SUPABASE_DB_URL"],
    ["staging's database is the production project", staging({ KOLEKTO_PRODUCTION_PROJECT_REF: REF_B, SUPABASE_DB_URL: `postgresql://role:x@db.${REF_B}.supabase.co:5432/postgres` }), "ENV_TARGETS_PRODUCTION"],
  ];

  for (const [name, env, expected] of cases) {
    it(name, () => assert.equal(refusal(env), expected));
  }

  it("refuses the legacy estate through either URL, however it is spelled and in every environment", () => {
    // Built from parts: this file never holds a usable URL for the legacy project, even in a test.
    const legacyRef = ["busfgcmbnd", "leljklrcbd"].join("");
    for (const environment of [local, staging, production]) {
      assert.equal(refusal(environment({ NEXT_PUBLIC_SUPABASE_URL: `https://${legacyRef}.supabase.co` })), "ENV_LEGACY_PROJECT:NEXT_PUBLIC_SUPABASE_URL");
      assert.equal(refusal(environment({ SUPABASE_DB_URL: `postgresql://role:x@db.${legacyRef}.supabase.co:5432/postgres` })), "ENV_LEGACY_PROJECT:SUPABASE_DB_URL");
      assert.equal(refusal(environment({ SUPABASE_DB_URL: `postgresql://role.${legacyRef.toUpperCase()}:x@aws-0-x.pooler.supabase.com:5432/postgres` })), "ENV_LEGACY_PROJECT:SUPABASE_DB_URL");
    }
  });
});

describe("enforceWorkerEnvironment", () => {
  const okConfig = () => ({ environment: "local" as const });
  const noEmail = () => { throw new ConfigError("Missing required environment variable EMAIL_PROVIDER."); };

  function run(over: Partial<Parameters<typeof enforceWorkerEnvironment>[0]> = {}) {
    const lines: string[] = [];
    const allowed = enforceWorkerEnvironment({ env: local(), loadConfig: okConfig, loadEmailConfig: noEmail, log: (l) => lines.push(l), ...over });
    return { allowed, lines };
  }

  it("continues when the configuration is valid and email is simply not configured", () => {
    assert.deepEqual(run(), { allowed: true, lines: [] });
  });

  it("reports a refusal as a code and a variable name, never a value", () => {
    const { allowed, lines } = run({ env: local({ SUPABASE_DB_URL: `postgresql://role:${SENTINEL}@elsewhere.invalid:5432/postgres` }) });
    assert.equal(allowed, false);
    assert.deepEqual(lines.map((l) => JSON.parse(l) as unknown), [{ msg: "worker_environment_refused", code: "ENV_DB_URL_NOT_LOCAL", variable: "SUPABASE_DB_URL" }]);
    assert.ok(!lines.join("\n").includes(SENTINEL));
    assert.ok(!lines.join("\n").includes("elsewhere"));
  });

  it("does not print an invalid KOLEKTO_ENV: operators paste secrets into the wrong variable", () => {
    const { lines } = run({ env: local({ KOLEKTO_ENV: SENTINEL }) });
    assert.ok(!lines.join("\n").includes(SENTINEL));
  });

  it("the shared config layer stays a backstop, and its message is not printed", () => {
    const { allowed, lines } = run({ loadConfig: () => { throw new ConfigError(`REFUSING TO START: quoted ${SENTINEL}`); } });
    assert.equal(allowed, false);
    assert.match(lines[0]!, /ENV_CONFIG_REFUSED/);
    assert.ok(!lines.join("\n").includes(SENTINEL));
  });

  it("a wrong-environment email configuration is fatal, and is not printed", () => {
    const { allowed, lines } = run({ loadEmailConfig: () => { throw new ConfigError(`REFUSING TO START: quoted ${SENTINEL}`); } });
    assert.equal(allowed, false);
    assert.match(lines[0]!, /ENV_EMAIL_REFUSED/);
    assert.ok(!lines.join("\n").includes(SENTINEL));
  });

  it("an unsupported or incomplete sender is not: the event stage keeps running (CFG-SENDER)", () => {
    const { allowed, lines } = run({ loadEmailConfig: () => { throw new ConfigError("EMAIL_PROVIDER is not a supported provider."); } });
    assert.equal(allowed, true);
    assert.deepEqual(lines, []);
  });
});

describe("the real bundle: a refusal ends the process non-zero, before any connection", () => {
  const OUTFILE = "dist/guard-test/index.js";

  before(() => {
    const { buildSync } = createRequire(import.meta.url)("esbuild") as { buildSync: (opts: Record<string, unknown>) => { errors: unknown[] } };
    const result = buildSync({ entryPoints: [path.join(WORKER_ROOT, "src/index.ts")], bundle: true, platform: "node", format: "esm", target: "node22", external: ["@aws-sdk/*", "@smithy/*"], outfile: path.join(WORKER_ROOT, OUTFILE), logLevel: "error" });
    assert.equal(result.errors.length, 0, `the bundle builds: ${JSON.stringify(result.errors)}`);
  });

  /** An environment built from nothing. Only OS essentials, so no developer setting can reach the child. */
  function runWorker(env: Record<string, string | undefined>): Promise<{ code: number | null; output: string }> {
    const essentials = Object.fromEntries(Object.entries(process.env).filter(([k]) => ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].includes(k.toUpperCase())));
    const child = spawn(process.execPath, [OUTFILE], { cwd: WORKER_ROOT, env: { ...essentials, ...env } as NodeJS.ProcessEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => { output += String(d); });
    child.stderr.on("data", (d: Buffer) => { output += String(d); });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("the worker did not exit")); }, 60_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        setImmediate(() => resolve({ code, output }));
      });
    });
  }

  const refusals: readonly (readonly [string, Record<string, string | undefined>, RegExp])[] = [
    ["nothing configured", {}, /ENV_MISSING.*KOLEKTO_ENV/],
    ["database URL missing, no email configured", local({ SUPABASE_DB_URL: undefined }), /ENV_MISSING.*SUPABASE_DB_URL/],
    ["database URL malformed, no email configured", local({ SUPABASE_DB_URL: `postgresql://role:${SENTINEL}@127.0.0.1:not-a-port/db` }), /ENV_DB_URL_MALFORMED/],
    ["database URL disallowed, no email configured", local({ SUPABASE_DB_URL: `postgresql://role:${SENTINEL}@db.example.invalid:5432/db` }), /ENV_DB_URL_NOT_LOCAL/],
    ["a real provider in local", local({ EMAIL_PROVIDER: "ses" }), /ENV_EMAIL_REFUSED/],
  ];

  for (const [name, env, expected] of refusals) {
    it(`${name}: exits 1, reports the code, prints no value, never claims to be connected`, async () => {
      const { code, output } = await runWorker(env);
      assert.equal(code, 1, output);
      assert.match(output, expected);
      assert.ok(!output.includes(SENTINEL), "no credential in the output");
      assert.ok(!output.includes("example.invalid"), "no host in the output");
      assert.doesNotMatch(output, /connected\. Polling/);
      assert.doesNotMatch(output, /worker_database_unavailable/, "it never tried to connect");
    });
  }

  it("a valid configuration gets past the guard: it tries the (closed) port and stops there", { timeout: 60_000 }, async () => {
    const { code, output } = await runWorker(local());
    assert.equal(code, 1);
    assert.doesNotMatch(output, /worker_environment_refused/);
    assert.match(output, /worker_database_unavailable/);
    assert.ok(!output.includes(SENTINEL));
  });
});

describe("the privilege preflight (R-1)", () => {
  const holdsAll = async () => true;

  it("passes when the role holds everything", async () => {
    assert.deepEqual(await checkWorkerPrivileges(holdsAll), { missing: [], degraded: [] });
  });

  it("reports every required privilege a role lacks, as an object name", async () => {
    const report = await checkWorkerPrivileges(async (c: PrivilegeCheck) => !(c.kind === "table" && c.table === "public.notification_events" && c.privilege === "INSERT"));
    assert.deepEqual(report, { missing: ["INSERT on public.notification_events"], degraded: [] });
  });

  it("fails closed: an object that does not exist, or a catalog that cannot be read, counts as not held", async () => {
    const missingTable = Object.assign(new Error(`relation quoted ${SENTINEL}`), { name: "PostgresError", code: "42P01", severity: "ERROR" });
    const report = await checkWorkerPrivileges(async (c) => {
      if (c.kind === "function" && c.signature === "app.reserve_email_attempt(uuid)") throw missingTable;
      return true;
    });
    assert.deepEqual(report.missing, ["execute on app.reserve_email_attempt(uuid) [42P01]"]);
    assert.ok(!JSON.stringify(report).includes(SENTINEL));
  });

  it("the final queue operations are a warning, not a refusal: F-15's bounded path covers them", async () => {
    const report = await checkWorkerPrivileges(async (c) => !DEGRADED_PRIVILEGES.includes(c));
    assert.deepEqual(report.missing, []);
    assert.equal(report.degraded.length, DEGRADED_PRIVILEGES.length);
    assert.ok(report.degraded.includes("DELETE on pgmq.q_notification_events"));
    assert.ok(report.degraded.includes("INSERT on pgmq.a_notification_events"));
  });

  it("requires what processing writes to the queue table, and nothing that would widen it", () => {
    const queueColumns = REQUIRED_PRIVILEGES.flatMap((c) => (c.kind === "column" && c.table.endsWith("q_notification_events") ? [`${c.privilege}:${c.column}`] : []));
    assert.deepEqual(queueColumns.sort(), ["UPDATE:headers", "UPDATE:read_ct", "UPDATE:vt"]);
    for (const check of [...REQUIRED_PRIVILEGES, ...DEGRADED_PRIVILEGES]) assert.doesNotMatch(describePrivilege(check), /message|enqueued_at/);
  });
});

describe("the worker role: the proposal, the test stack and the code agree (R-3)", () => {
  const proposal = readFileSync(path.join(REPO_ROOT, "docs", "database", "proposals", "M13.2-FINAL-worker-role.proposed.sql"), "utf8");
  const harness = readFileSync(path.join(REPO_ROOT, "scripts", "itest", "itest.mjs"), "utf8");
  const entrypoint = readFileSync(path.join(WORKER_ROOT, "src", "index.ts"), "utf8");
  const QUEUE = `${"pg" + "mq"}.q_notification_events`;
  const statements = proposal.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("--")).join("\n");

  it("the proposal holds no table-wide UPDATE on the queue", () => {
    assert.doesNotMatch(statements, new RegExp(String.raw`grant[^;]*\bupdate\b(?!\s*\()[^;]*on\s+${QUEUE}`, "i"));
    assert.match(statements, new RegExp(String.raw`grant select, delete on ${QUEUE} to kolekto_worker;`));
  });

  it("the proposal revokes first, then grants exactly vt, read_ct and headers", () => {
    const revoke = statements.indexOf(`revoke update on ${QUEUE} from kolekto_worker;`);
    const grant = statements.indexOf(`grant update (vt, read_ct, headers) on ${QUEUE} to kolekto_worker;`);
    assert.ok(revoke >= 0 && grant > revoke, "the revoke precedes the column grant");
    assert.equal([...statements.matchAll(new RegExp(String.raw`grant\s+update[^;]*${QUEUE.replace(".", String.raw`\.`)}`, "gi"))].length, 1, "one UPDATE grant on the queue");
  });

  it("the proposal's post-apply checks prove it", () => {
    for (const column of ["vt", "read_ct", "headers", "message", "enqueued_at", "msg_id"]) assert.ok(proposal.includes(`'${column}'`), column);
    assert.match(proposal, /message, enqueued_at, msg_id false/);
  });

  it("the test stack's role gets the same treatment, and re-running it narrows a role that already holds the old grant", () => {
    assert.match(harness, new RegExp(String.raw`grant select, delete on ${QUEUE} to \$\{WORKER_ROLE\};`));
    const revoke = harness.indexOf(`revoke update on ${QUEUE} from \${WORKER_ROLE};`);
    const grant = harness.indexOf(`grant update (\${WORKER_QUEUE_UPDATE_COLUMNS.join(", ")}) on ${QUEUE} to \${WORKER_ROLE};`);
    assert.ok(revoke >= 0 && grant > revoke);
    assert.match(harness, /WORKER_QUEUE_UPDATE_COLUMNS = Object\.freeze\(\["vt", "read_ct", "headers"\]\)/);
    assert.doesNotMatch(harness, new RegExp(String.raw`grant select, update, delete on ${QUEUE}`));
  });

  it("the worker's own statements write only the permitted columns", () => {
    const updates = [...entrypoint.matchAll(new RegExp(String.raw`update\s+${QUEUE.replace(".", String.raw`\.`)}\s+set\s+([\s\S]*?)\s+where`, "gi"))];
    assert.equal(updates.length, 3, "mark, park, fault record");
    const written = updates.flatMap((m) => [...m[1]!.matchAll(/(?:^|,\s*\n\s*)(\w+)\s*=/g)].map((c) => c[1]!));
    assert.deepEqual([...new Set(written)].sort(), ["headers", "vt"]);
    for (const column of written) assert.ok(QUEUE_UPDATE_COLUMNS.includes(column));
    assert.doesNotMatch(entrypoint, /set\s+message\b|set\s+enqueued_at\b|enqueued_at\s*=/i);
  });

  it("the preflight's lists match the proposal and the test stack's role", () => {
    for (const signature of WORKER_FUNCTIONS) {
      assert.ok(proposal.includes(signature), `proposal: ${signature}`);
      assert.ok(harness.includes(`"${signature}"`), `harness: ${signature}`);
    }
    assert.equal([...proposal.slice(proposal.indexOf("grant execute on function"), proposal.indexOf("to kolekto_worker;", proposal.indexOf("grant execute on function"))).matchAll(/^\s*\w+\.\w+\(/gm)].length, WORKER_FUNCTIONS.length, "the proposal grants exactly these functions");
    for (const [table, columns] of Object.entries(WORKER_READ_COLUMNS)) {
      assert.ok(statements.includes(`grant select (${columns.join(", ")}) on public.${table} to kolekto_worker;`), table);
      assert.ok(harness.includes(`${table}: [${columns.map((c) => `"${c}"`).join(", ")}]`), table);
    }
  });

  it("the superseded proposal is not what the runbook points at", () => {
    const runbook = readFileSync(path.join(REPO_ROOT, "docs", "runbooks", "worker-deployment-operator-guide.md"), "utf8");
    assert.ok(runbook.includes("M13.2-FINAL-worker-role.proposed.sql"));
    assert.ok(!runbook.includes("M13.2-P8-worker-role.proposed.sql"));
  });
});
