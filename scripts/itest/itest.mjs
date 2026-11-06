#!/usr/bin/env node
/**
 * Guarded lifecycle wrapper for the dedicated integration-test Supabase stack
 * (M13.2 Phase 3). The ONLY supported way to manage it:
 *
 *   npm run itest:up       start the `kolekto-itest` stack; bootstrap it once
 *   npm run itest:status   containers, ports, migration hashes, bootstrap state
 *   npm run itest:down     stop it (the data volume is kept)
 *   npm run itest:reset -- --confirm-reset-kolekto-itest
 *                          replay migrations on the TEST database and
 *                          re-bootstrap (new password, new stack ID)
 *   npm run itest:worker-role
 *                          create or refresh the test-only least-privilege
 *                          worker role and its grants (M13.2 Phase 7)
 *   npm run itest:net-lockdown
 *                          remove pg_net's broad grants on the TEST database
 *                          (M13.2 Phase 8, finding F-13)
 *
 * Safety rules (approval checklist R12, §7.8):
 *   - Every Supabase CLI call passes `--workdir supabase-itest` (absolute) and
 *     is checked against a deny-list: never `link`, `unlink`, `db push`,
 *     `--linked`, `--db-url`, `--project-ref` or `--all`. The developer
 *     work directory `supabase/` is never used.
 *   - The work directory must carry `project_id = "kolekto-itest"`, the
 *     55420–55429 ports, Studio/pooler/analytics/edge runtime off, no
 *     `[remotes]` section and no `env()` reference; otherwise refuse.
 *   - Refuse if `supabase-itest/supabase/.temp` holds a link artifact
 *     (`project-ref`, `linked-project.json`, `pooler-url`).
 *   - Every container labelled `com.supabase.cli.project=kolekto-itest` must
 *     be named `supabase_<service>_kolekto-itest` and publish only test ports;
 *     the database container must be `supabase_db_kolekto-itest` with
 *     5432/tcp published on 55422. Anything else is a refusal.
 *   - SQL runs only through `docker exec` into `supabase_db_kolekto-itest`,
 *     after that identity check. Never against the developer container.
 *   - Spawned processes get an allow-listed environment: no SUPABASE_*, PG*,
 *     EMAIL_*, Paystack or session secrets, no access token.
 *   - Output never contains the role password, the stack ID, `.env.itest`
 *     contents or the CLI's API keys (CLI output is captured, not echoed).
 *   - The pause switch (`email_sending_enabled`) is only ever READ. A missing,
 *     duplicated or `true` row stops the wrapper; it is never repaired.
 *
 * Migrations: `supabase-itest/supabase/migrations/` is a git-ignored copy of
 * `supabase/migrations/`. `up` writes it only when it does not exist yet and
 * otherwise requires it to be byte-identical (SHA-256 per file, same file set)
 * to the source; a divergent copy is a refusal (`itest:reset` re-syncs it and
 * replays the migrations on the test database only).
 */

import { spawnSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ── Fixed identity ────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKDIR = path.join(REPO_ROOT, "supabase-itest");
const SUPABASE_DIR = path.join(WORKDIR, "supabase");
const CONFIG_PATH = path.join(SUPABASE_DIR, "config.toml");
const TEMP_DIR = path.join(SUPABASE_DIR, ".temp");
const MIGRATIONS_SOURCE = path.join(REPO_ROOT, "supabase", "migrations");
const MIGRATIONS_COPY = path.join(SUPABASE_DIR, "migrations");
const ENV_FILE = path.join(REPO_ROOT, ".env.itest");

const PROJECT_ID = "kolekto-itest";
const PROJECT_LABEL = "com.supabase.cli.project";
const DB_CONTAINER = `supabase_db_${PROJECT_ID}`;
const DB_VOLUME = `supabase_db_${PROJECT_ID}`;
const CONTAINER_NAME = /^supabase_[a-z][a-z0-9_]*_kolekto-itest$/;
const CLI_VERSION = "2.109.1";
const ROLE = "kolekto_itest";
const DATABASE = "postgres";

const PORTS = Object.freeze({ shadow: 55420, api: 55421, db: 55422, studio: 55423, mailpitUi: 55424, mailpitSmtp: 55425, analytics: 55427, inspector: 55428, pooler: 55429 });
const TEST_RANGE = { min: 55420, max: 55429 };
const PUBLISHED_PORTS = [PORTS.api, PORTS.db, PORTS.mailpitUi, PORTS.mailpitSmtp];

/** Lines that must appear in config.toml (section.key → literal value). */
const EXPECTED_CONFIG = Object.freeze({
  project_id: `"${PROJECT_ID}"`,
  "api.port": String(PORTS.api),
  "db.port": String(PORTS.db),
  "db.shadow_port": String(PORTS.shadow),
  "db.major_version": "17",
  "db.pooler.enabled": "false",
  "db.seed.enabled": "false",
  "studio.enabled": "false",
  "local_smtp.enabled": "true",
  "local_smtp.port": String(PORTS.mailpitUi),
  "local_smtp.smtp_port": String(PORTS.mailpitSmtp),
  "analytics.enabled": "false",
  "edge_runtime.enabled": "false",
});

/** Never passed to the CLI, in any position. */
const FORBIDDEN_CLI_TOKENS = new Set(["link", "unlink", "push", "--linked", "--db-url", "--project-ref", "--all"]);
const LINK_ARTIFACTS = ["project-ref", "linked-project.json", "pooler-url"];

/** Services the integration lane does not need (Studio and its meta API, image proxy, logs, functions). */
const START_EXCLUDES = "studio,meta,imgproxy,vector,analytics,edge-runtime,functions";

/** The only variables spawned processes inherit (compared upper-case). */
const CHILD_ENV_ALLOWED = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES",
  "LANG", "LC_ALL", "TZ", "TERM", "NO_COLOR",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
]);

// ── Output ────────────────────────────────────────────────────────────────────

class Refusal extends Error {}

const log = (text) => process.stdout.write(`${text}\n`);
function refuse(message) {
  throw new Refusal(message);
}

/** CLI output can carry API keys and the JWT secret; only lines without them are ever shown. */
const SECRETISH = /(key|secret|jwt|token|password|passwd|eyJ|sb_[a-z]+_|s3|postgresql:\/\/|postgres:\/\/)/i;
function redactedTail(text, lines = 25) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !SECRETISH.test(l))
    .slice(-lines)
    .map((l) => `    | ${l}`)
    .join("\n");
}

// ── Processes ─────────────────────────────────────────────────────────────────

function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && CHILD_ENV_ALLOWED.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

function run(command, args, { input, cwd = REPO_ROOT, shell = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv(),
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) refuse(`Could not run ${command} (${result.error.code ?? result.error.name}).`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function docker(args, options) {
  return run("docker", args, options);
}

/** The Supabase CLI, always with --workdir supabase-itest and never with a forbidden token. */
function supabase(args) {
  for (const token of args) {
    if (FORBIDDEN_CLI_TOKENS.has(token)) refuse(`Internal guard: the Supabase CLI argument '${token}' is never allowed.`);
    if (/^--(?:linked|db-url|project-ref|all)(?:=|$)/.test(token)) refuse(`Internal guard: '${token.split("=")[0]}' is never allowed.`);
  }
  if (/[\s"&|<>^%]/.test(WORKDIR)) refuse("The repository path contains characters the guarded CLI call does not quote; refusing.");
  const full = [...args, "--workdir", WORKDIR];
  // On Windows the CLI is an npm .cmd shim, which needs a shell; every argument is a constant.
  return run("supabase", full, { cwd: WORKDIR, shell: process.platform === "win32" });
}

// ── Preflight guards ──────────────────────────────────────────────────────────

function checkCliVersion() {
  const r = supabase(["--version"]);
  const version = r.stdout.trim();
  if (r.status !== 0 || version !== CLI_VERSION) refuse(`Supabase CLI must be ${CLI_VERSION} (found '${version || "unknown"}').`);
}

/** Minimal TOML reader for this file's flat sections and scalar values. */
function readConfig() {
  if (!existsSync(CONFIG_PATH)) refuse("supabase-itest/supabase/config.toml does not exist.");
  const values = new Map();
  let section = "";
  const problems = [];
  readFileSync(CONFIG_PATH, "utf8")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return;
      if (/env\(/i.test(line)) problems.push(`line ${i + 1} uses env(); the test stack takes nothing from the host environment`);
      const header = /^\[([A-Za-z0-9_.]+)\]$/.exec(line);
      if (header) {
        section = header[1];
        if (/^remotes(\.|$)/.test(section)) problems.push(`line ${i + 1} declares a [remotes] section`);
        return;
      }
      const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
      if (!kv) return;
      const key = section === "" ? kv[1] : `${section}.${kv[1]}`;
      const value = kv[2].trim();
      if (values.has(key)) problems.push(`${key} is set twice`);
      values.set(key, value);
      if (/port$/.test(kv[1])) {
        const port = Number(value);
        if (!Number.isInteger(port) || port < TEST_RANGE.min || port > TEST_RANGE.max) problems.push(`${key} is outside ${TEST_RANGE.min}-${TEST_RANGE.max}`);
      }
    });
  for (const [key, expected] of Object.entries(EXPECTED_CONFIG)) {
    if (values.get(key) !== expected) problems.push(`${key} must be ${expected}`);
  }
  if (problems.length > 0) refuse(`supabase-itest/supabase/config.toml is not the expected test-stack configuration:\n  - ${problems.join("\n  - ")}`);
}

function checkTempDir() {
  if (!existsSync(TEMP_DIR)) return;
  const found = LINK_ARTIFACTS.filter((f) => existsSync(path.join(TEMP_DIR, f)));
  if (found.length > 0) {
    refuse(`supabase-itest/supabase/.temp contains link artifact(s) (${found.join(", ")}). The test stack is never linked to a hosted project. Stop and investigate; do not delete it blindly.`);
  }
}

function checkDocker() {
  const r = docker(["version", "--format", "{{.Server.Version}}"]);
  if (r.status !== 0 || r.stdout.trim() === "") refuse("Docker is not reachable.");
}

/** Every container that belongs to the test project, by label and by name. */
function projectContainers() {
  const byLabel = docker(["ps", "-a", "--filter", `label=${PROJECT_LABEL}=${PROJECT_ID}`, "--format", "{{.Names}}\t{{.State}}"]);
  const byName = docker(["ps", "-a", "--filter", `name=${PROJECT_ID}`, "--format", "{{.Names}}\t{{.Label \"" + PROJECT_LABEL + "\"}}"]);
  if (byLabel.status !== 0 || byName.status !== 0) refuse("Could not list Docker containers.");
  const containers = byLabel.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [name, state] = l.split("\t");
      return { name, state };
    });
  const problems = [];
  for (const c of containers) {
    if (!CONTAINER_NAME.test(c.name)) problems.push(`container '${c.name}' carries the ${PROJECT_ID} label but not the expected name pattern supabase_<service>_${PROJECT_ID}`);
  }
  for (const l of byName.stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, label] = l.split("\t");
    if (name.endsWith(`_${PROJECT_ID}`) && label !== PROJECT_ID) problems.push(`container '${name}' is named like the test stack but is not labelled ${PROJECT_LABEL}=${PROJECT_ID}`);
  }
  if (problems.length > 0) refuse(`Unexpected containers:\n  - ${problems.join("\n  - ")}`);
  return containers;
}

function inspectPorts(name) {
  const r = docker(["inspect", name, "--format", "{{json .HostConfig.PortBindings}}"]);
  if (r.status !== 0) refuse(`Could not inspect container ${name}.`);
  const bindings = JSON.parse(r.stdout.trim() || "null") ?? {};
  const out = [];
  for (const [containerPort, hosts] of Object.entries(bindings)) {
    for (const h of hosts ?? []) out.push({ containerPort, hostIp: h.HostIp ?? "", hostPort: Number(h.HostPort) });
  }
  return out;
}

/** The running test stack is exactly what we expect: names, labels, published ports. */
function verifyRunningStack() {
  const containers = projectContainers();
  const db = containers.find((c) => c.name === DB_CONTAINER);
  if (!db) refuse(`${DB_CONTAINER} does not exist.`);
  if (db.state !== "running") refuse(`${DB_CONTAINER} is not running (state ${db.state}).`);
  const problems = [];
  const summary = [];
  for (const c of containers) {
    const ports = inspectPorts(c.name);
    for (const p of ports) {
      if (p.hostPort < TEST_RANGE.min || p.hostPort > TEST_RANGE.max) problems.push(`${c.name} publishes host port ${p.hostPort}, outside ${TEST_RANGE.min}-${TEST_RANGE.max}`);
    }
    summary.push({ ...c, ports });
  }
  const dbPorts = summary.find((c) => c.name === DB_CONTAINER).ports;
  if (dbPorts.length === 0 || !dbPorts.every((p) => p.containerPort === "5432/tcp" && p.hostPort === PORTS.db)) {
    problems.push(`${DB_CONTAINER} must publish exactly 5432/tcp on host port ${PORTS.db}`);
  }
  const mailpit = summary.filter((c) => c.ports.some((p) => p.hostPort === PORTS.mailpitUi));
  if (mailpit.length !== 1 || !mailpit[0].ports.some((p) => p.hostPort === PORTS.mailpitSmtp)) {
    problems.push(`exactly one test-stack container must publish Mailpit on ${PORTS.mailpitUi} (UI/API) and ${PORTS.mailpitSmtp} (SMTP)`);
  }
  if (problems.length > 0) refuse(`The running test stack does not match its expected identity:\n  - ${problems.join("\n  - ")}`);
  return summary;
}

const HEALTH_TIMEOUT_MS = 240_000;
const HEALTH_INTERVAL_MS = 3_000;

/** Bounded wait until every test-stack container with a health check reports healthy. */
function waitHealthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    const names = projectContainers().map((c) => c.name);
    if (names.length === 0) refuse("No kolekto-itest containers exist after start.");
    const r = docker(["inspect", "--format", "{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", ...names]);
    if (r.status !== 0) refuse("Could not inspect the test-stack containers.");
    const pending = r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split("|"))
      .filter(([, state, health]) => state !== "running" || (health !== "healthy" && health !== "none"));
    if (pending.length === 0) return;
    if (Date.now() > deadline) {
      refuse(`Not healthy within ${HEALTH_TIMEOUT_MS / 1000} s: ${pending.map(([n, s, h]) => `${n.replace(/^\//, "")} (${s}/${h})`).join(", ")}. The stack was left as is; inspect it or run \`npm run itest:down\`.`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HEALTH_INTERVAL_MS);
  }
}

function excludedPortRanges() {
  if (process.platform !== "win32") return [];
  const r = run("netsh", ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"]);
  if (r.status !== 0) refuse("Could not read the Windows excluded TCP port ranges.");
  return [...r.stdout.matchAll(/^\s*(\d+)\s+(\d+)/gm)].map((m) => ({ min: Number(m[1]), max: Number(m[2]) }));
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function checkPortsFree() {
  const excluded = excludedPortRanges().filter((r) => r.max >= TEST_RANGE.min && r.min <= TEST_RANGE.max);
  if (excluded.length > 0) refuse(`Windows reserves part of ${TEST_RANGE.min}-${TEST_RANGE.max}; the test stack cannot start.`);
  const busy = [];
  for (const port of PUBLISHED_PORTS) if (!(await portFree(port))) busy.push(port);
  if (busy.length > 0) refuse(`Port(s) ${busy.join(", ")} are already in use by something other than a running test stack.`);
}

// ── Migrations: hash-checked copy ─────────────────────────────────────────────

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function hashDirectory(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).sort();
  for (const f of files) {
    if (!statSync(path.join(dir, f)).isFile()) refuse(`${path.relative(REPO_ROOT, dir)} contains a non-file entry '${f}'.`);
  }
  const perFile = new Map(files.map((f) => [f, sha256(readFileSync(path.join(dir, f)))]));
  const aggregate = sha256([...perFile].map(([f, h]) => `${f}:${h}`).join("\n"));
  return { perFile, aggregate, count: files.length };
}

function compareMigrations() {
  const source = hashDirectory(MIGRATIONS_SOURCE);
  if (source === null || source.count === 0) refuse("supabase/migrations is missing or empty.");
  const copy = hashDirectory(MIGRATIONS_COPY);
  if (copy === null) return { source, copy: null, identical: false, differences: ["copy does not exist"] };
  const differences = [];
  for (const [f, h] of source.perFile) {
    if (!copy.perFile.has(f)) differences.push(`missing in copy: ${f}`);
    else if (copy.perFile.get(f) !== h) differences.push(`content differs: ${f}`);
  }
  for (const f of copy.perFile.keys()) if (!source.perFile.has(f)) differences.push(`not in source: ${f}`);
  return { source, copy, identical: differences.length === 0, differences };
}

function writeMigrationCopy() {
  mkdirSync(MIGRATIONS_COPY, { recursive: true });
  // Only files this wrapper manages live here (the directory is git-ignored and documented as generated).
  for (const f of readdirSync(MIGRATIONS_COPY)) rmSync(path.join(MIGRATIONS_COPY, f));
  for (const f of readdirSync(MIGRATIONS_SOURCE).sort()) copyFileSync(path.join(MIGRATIONS_SOURCE, f), path.join(MIGRATIONS_COPY, f));
  const result = compareMigrations();
  if (!result.identical) refuse(`The migration copy does not match the source after copying:\n  - ${result.differences.slice(0, 10).join("\n  - ")}`);
  return result;
}

function reportMigrations(result) {
  log(`  migrations: ${result.source.count} source file(s), ${result.copy?.count ?? 0} in the copy, ${result.identical ? "byte-identical (SHA-256 per file)" : "DIFFERENT"}`);
  log(`  migrations aggregate sha256: source ${result.source.aggregate.slice(0, 16)}… copy ${result.copy ? `${result.copy.aggregate.slice(0, 16)}…` : "-"}`);
}

function volumeExists(name) {
  const r = docker(["volume", "ls", "--filter", `name=${name}`, "--format", "{{.Name}}"]);
  if (r.status !== 0) refuse("Could not list Docker volumes.");
  return r.stdout.split(/\r?\n/).includes(name);
}

// ── SQL inside the TEST container only ────────────────────────────────────────

function psql(sql) {
  verifyRunningStack(); // identity before every SQL call
  const r = docker(["exec", "-i", DB_CONTAINER, "psql", "-X", "-q", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U", "supabase_admin", "-d", DATABASE], { input: sql });
  if (r.status !== 0) {
    const sqlstate = /ERROR:\s+([0-9A-Z]{5}):/.exec(r.stderr)?.[1];
    refuse(`SQL on the test database failed${sqlstate ? ` (${sqlstate})` : ""}. Details withheld.`);
  }
  return r.stdout.split(/\r?\n/).filter((l) => l !== "");
}

/** Read-only: role, its attributes, and the two database-level identity settings. */
function readBootstrapState() {
  const rows = psql(`begin read only;
select 'role', count(*)::text from pg_roles where rolname = '${ROLE}';
select 'attrs', rolcanlogin::text, rolbypassrls::text, rolsuper::text, rolcreaterole::text, rolcreatedb::text, rolreplication::text, rolinherit::text
  from pg_roles where rolname = '${ROLE}';
select 'member_of', coalesce(string_agg(r.rolname, ',' order by r.rolname), '')
  from pg_auth_members m join pg_roles r on r.oid = m.roleid
 where m.member = (select oid from pg_roles where rolname = '${ROLE}');
select 'setting', split_part(s, '=', 1), substr(s, length(split_part(s, '=', 1)) + 2)
  from pg_db_role_setting d cross join lateral unnest(d.setconfig) s
 where d.setdatabase = (select oid from pg_database where datname = '${DATABASE}') and d.setrole = 0
   and split_part(s, '=', 1) in ('kolekto.itest_stack', 'kolekto.itest_db_host_port');
rollback;`);
  const state = { roleExists: false, attrs: null, memberOf: [], stackId: null, hostPort: null };
  for (const row of rows) {
    const cols = row.split("|");
    if (cols[0] === "role") state.roleExists = cols[1] === "1";
    else if (cols[0] === "attrs") {
      const [login, bypassrls, superuser, createrole, createdb, replication, inherit] = cols.slice(1).map((v) => v === "true");
      state.attrs = { login, bypassrls, superuser, createrole, createdb, replication, inherit };
    } else if (cols[0] === "member_of") state.memberOf = cols[1] === "" ? [] : cols[1].split(",");
    else if (cols[0] === "setting" && cols[1] === "kolekto.itest_stack") state.stackId = cols.slice(2).join("|");
    else if (cols[0] === "setting" && cols[1] === "kolekto.itest_db_host_port") state.hostPort = cols.slice(2).join("|");
  }
  return state;
}

/** Read-only. Stops on anything but exactly one row with false. Never repairs. */
function checkPauseSwitch() {
  const rows = psql(`begin read only;
select count(*)::text, count(*) filter (where email_sending_enabled is true)::text, count(*) filter (where email_sending_enabled is false)::text
  from public.notification_sender_state;
rollback;`);
  const [total, on, off] = (rows[0] ?? "").split("|").map(Number);
  if (total === 0) refuse("public.notification_sender_state has no row. Not repaired; stop and investigate.");
  if (total !== 1) refuse(`public.notification_sender_state has ${total} rows. Not repaired; stop and investigate.`);
  if (on === 1) refuse("email_sending_enabled is TRUE on the test stack. Not changed; stop and investigate.");
  if (off !== 1) refuse("email_sending_enabled is neither true nor false. Not repaired; stop and investigate.");
  return "exactly one row, email_sending_enabled = false";
}

// ── Credentials and .env.itest ───────────────────────────────────────────────

/** A SCRAM-SHA-256 verifier, so the plaintext password never reaches the server or its logs. */
function scramVerifier(password) {
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

function newCredentials() {
  return { password: randomBytes(32).toString("base64url"), stackId: randomUUID() };
}

function envFileText({ password, stackId }) {
  return [
    "# Integration-test stack (kolekto-itest) — written by scripts/itest/itest.mjs (M13.2 Phase 3).",
    "# Git-ignored (.env.*). Never commit, copy or print. Regenerated by `npm run itest:reset`.",
    `KOLEKTO_ITEST_DB_URL=postgresql://${ROLE}:${password}@127.0.0.1:${PORTS.db}/${DATABASE}`,
    `KOLEKTO_ITEST_SMTP_PORT=${PORTS.mailpitSmtp}`,
    `KOLEKTO_ITEST_MAILPIT_API=http://127.0.0.1:${PORTS.mailpitUi}`,
    `KOLEKTO_ITEST_STACK_ID=${stackId}`,
    "",
  ].join("\n");
}

/** Reads the stack ID and URL shape from .env.itest without ever printing them. */
function readEnvFile() {
  if (!existsSync(ENV_FILE)) return null;
  const values = {};
  for (const line of readFileSync(ENV_FILE, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^(KOLEKTO_ITEST_[A-Z_]+)=(.*)$/.exec(line);
    if (m) values[m[1]] = m[2];
  }
  let url = null;
  try {
    url = new URL(values.KOLEKTO_ITEST_DB_URL ?? "");
  } catch {
    url = null;
  }
  return {
    stackId: values.KOLEKTO_ITEST_STACK_ID ?? null,
    urlShapeOk: url !== null && url.username === ROLE && url.hostname === "127.0.0.1" && url.port === String(PORTS.db) && url.pathname === `/${DATABASE}`,
    smtpOk: values.KOLEKTO_ITEST_SMTP_PORT === String(PORTS.mailpitSmtp),
    mailpitOk: values.KOLEKTO_ITEST_MAILPIT_API === `http://127.0.0.1:${PORTS.mailpitUi}`,
  };
}

function checkEnvFileIgnored() {
  const r = run("git", ["check-ignore", "-q", ".env.itest"]);
  if (r.status !== 0) refuse(".env.itest is not git-ignored; refusing to write credentials.");
}

function roleSql(verifier, { exists }) {
  return exists
    ? `alter role ${ROLE} with login bypassrls nosuperuser nocreatedb nocreaterole noreplication inherit password '${verifier}';`
    : `create role ${ROLE} with login bypassrls nosuperuser nocreatedb nocreaterole noreplication inherit password '${verifier}';\ngrant postgres to ${ROLE};`;
}

function applyBootstrap(credentials, { roleExists }) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(credentials.password) || !/^[0-9a-f-]{36}$/.test(credentials.stackId)) refuse("Internal guard: generated credentials have an unexpected shape.");
  psql(`begin;
${roleSql(scramVerifier(credentials.password), { exists: roleExists })}
alter database ${DATABASE} set kolekto.itest_stack = '${credentials.stackId}';
alter database ${DATABASE} set kolekto.itest_db_host_port = '${PORTS.db}';
commit;`);
}

function verifyBootstrap(expectedStackId) {
  const s = readBootstrapState();
  const problems = [];
  if (!s.roleExists) problems.push(`role ${ROLE} does not exist`);
  else {
    const a = s.attrs;
    if (!a.login) problems.push("role cannot log in");
    if (!a.bypassrls) problems.push("role lacks BYPASSRLS");
    if (a.superuser || a.createrole || a.createdb || a.replication) problems.push("role has more than the approved attributes");
    if (!s.memberOf.includes("postgres")) problems.push("role is not a member of postgres");
  }
  if (s.hostPort !== String(PORTS.db)) problems.push(`kolekto.itest_db_host_port is not ${PORTS.db}`);
  if (s.stackId === null || s.stackId === "") problems.push("kolekto.itest_stack is not set");
  else if (expectedStackId !== undefined && s.stackId !== expectedStackId) problems.push("kolekto.itest_stack does not match .env.itest");
  if (problems.length > 0) refuse(`Bootstrap verification failed:\n  - ${problems.join("\n  - ")}`);
  return s;
}

function describeRole(s) {
  const a = s.attrs;
  return `${ROLE}: LOGIN=${a.login} BYPASSRLS=${a.bypassrls} SUPERUSER=${a.superuser} CREATEROLE=${a.createrole} CREATEDB=${a.createdb} REPLICATION=${a.replication} INHERIT=${a.inherit}; member of [${s.memberOf.join(", ")}]`;
}

/** First start: create the role, settings and .env.itest. Later starts: verify they agree. */
function bootstrapOnce() {
  const s = readBootstrapState();
  const env = readEnvFile();
  const parts = { role: s.roleExists, stack: s.stackId !== null, port: s.hostPort !== null, envFile: env !== null };
  const present = Object.values(parts).filter(Boolean).length;

  if (present === 0) {
    checkEnvFileIgnored();
    const credentials = newCredentials();
    applyBootstrap(credentials, { roleExists: false });
    writeFileSync(ENV_FILE, envFileText(credentials), { flag: "wx", mode: 0o600 });
    const verified = verifyBootstrap(credentials.stackId);
    log("  bootstrap: created role, both identity settings and .env.itest (values not shown)");
    log(`  ${describeRole(verified)}`);
    return;
  }
  if (present === 4) {
    if (!env.urlShapeOk || !env.smtpOk || !env.mailpitOk) refuse(".env.itest does not describe this stack's endpoints. Not changed; inspect it without printing it.");
    const verified = verifyBootstrap(env.stackId ?? "");
    log("  bootstrap: already done; role, settings and .env.itest agree (values not shown)");
    log(`  ${describeRole(verified)}`);
    return;
  }
  const flags = Object.entries(parts).map(([k, v]) => `${k}=${v ? "present" : "absent"}`).join(", ");
  refuse(`Partial bootstrap state (${flags}). Nothing changed. Recreating it needs \`npm run itest:reset -- --confirm-reset-kolekto-itest\` (separate approval).`);
}

// ── The test stack's least-privilege worker role (M13.2 Phase 7, finding F-1) ─

/**
 * A rehearsal of what a production worker role must be allowed to do, on the test
 * stack only. It is not a migration: nothing here is written to supabase/migrations,
 * and no hosted environment ever runs it. `itest:reset` removes it (run this again).
 *
 * The role has no BYPASSRLS, no membership of any role and no password. Row access
 * comes only from the narrow policies below, each `to kolekto_itest_worker`, so no
 * other role's access changes. The integration file sets a short-lived password in
 * memory for its own run and removes it afterwards.
 *
 * Deliberately absent: UPDATE or DELETE on deliveries and events (those changes go
 * through SECURITY DEFINER functions), INSERT on the queue (so pgmq.send is refused),
 * app.set_email_sending_enabled, the ledger and sender-state tables, audit_logs,
 * users, auth.users, every financial table except the three obligation columns the
 * audience filter reads, and members' phone and email columns.
 */
const WORKER_ROLE = "kolekto_itest_worker";
/** The only queue columns the worker may change. message, enqueued_at and msg_id stay out of reach. */
const WORKER_QUEUE_UPDATE_COLUMNS = Object.freeze(["vt", "read_ct", "headers"]);
const WORKER_QUEUE_FROZEN_COLUMNS = Object.freeze(["message", "enqueued_at", "msg_id"]);
const WORKER_ROLE_READS = Object.freeze({
  communities: ["id", "slug", "name"],
  collections: ["id", "community_id", "name", "slug"],
  members: ["id", "community_id", "full_name", "member_code", "user_id", "is_imported", "joined_via", "status", "archived_at", "merged_into_id"],
  officer_terms: ["id", "community_id", "user_id", "role", "end_reason", "started_at", "ended_at"],
  role_permissions: ["role", "permission"],
  obligations: ["collection_id", "member_id", "status"],
});
const WORKER_ROLE_FUNCTIONS = Object.freeze([
  "app.claim_next_notification_delivery(integer)",
  "app.reserve_email_attempt(uuid)",
  "app.resolve_notification_claim(uuid, text, text, text, text, timestamptz)",
  "app.resolve_lease_ambiguous(uuid)",
  "app.recover_expired_notification_lease(uuid)",
  "app.expire_stale_notification_deliveries(integer)",
  "app.purge_stale_send_attempts()",
  "app.record_sender_heartbeat(boolean)",
  "app.notification_send_health()",
  "app.notification_send_limits(text)",
  "app.email_sending_enabled()",
  "app.evaluate_email_eligibility(text, uuid, uuid)",
  "app.resolve_collection_audience(uuid)",
  // Run by the insert path: the id default, the payload sanitiser trigger and the table's CHECK constraint.
  "app.uuid_generate_v7()",
  "extensions.gen_random_bytes(integer)",
  "app.strip_banned_payload_keys(jsonb)",
  "app.payload_has_banned_key(jsonb)",
]);

function workerRoleSql() {
  const policy = (table, command) => {
    const name = `${WORKER_ROLE}_${table}_${command}`;
    const clause = command === "insert" ? "with check (true)" : "using (true)";
    return `drop policy if exists ${name} on public.${table};\ncreate policy ${name} on public.${table} for ${command} to ${WORKER_ROLE} ${clause};`;
  };
  const reads = Object.entries(WORKER_ROLE_READS).flatMap(([table, columns]) => [
    `grant select (${columns.join(", ")}) on public.${table} to ${WORKER_ROLE};`,
    policy(table, "select"),
  ]);
  return `begin;
set local role postgres;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = '${WORKER_ROLE}') then
    create role ${WORKER_ROLE} with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit connection limit 15 password null;
  end if;
end
$$;
grant usage on schema public, app, pgmq, extensions to ${WORKER_ROLE};
grant select, delete on pgmq.q_notification_events to ${WORKER_ROLE};
-- pgmq.read writes vt and read_ct, set_vt writes vt, the worker's mark and park write vt and headers. Nothing
-- it does writes message, enqueued_at or msg_id. The revoke matters: a column grant beside a table grant
-- removes nothing, and this role may already hold the table-wide UPDATE from an earlier run.
revoke update on pgmq.q_notification_events from ${WORKER_ROLE};
grant update (${WORKER_QUEUE_UPDATE_COLUMNS.join(", ")}) on pgmq.q_notification_events to ${WORKER_ROLE};
grant insert, select (msg_id) on pgmq.a_notification_events to ${WORKER_ROLE};
grant select, insert on public.notification_events, public.notification_deliveries to ${WORKER_ROLE};
${policy("notification_events", "select")}
${policy("notification_events", "insert")}
${policy("notification_deliveries", "select")}
${policy("notification_deliveries", "insert")}
${reads.join("\n")}
${WORKER_ROLE_FUNCTIONS.map((f) => `grant execute on function ${f} to ${WORKER_ROLE};`).join("\n")}
commit;`;
}

function readWorkerRole() {
  const rows = psql(`begin read only;
select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit, rolpassword is not null
  from pg_authid where rolname = '${WORKER_ROLE}';
select count(*) from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = '${WORKER_ROLE}';
select count(*) from pg_policies where '${WORKER_ROLE}' = any(roles);
rollback;`);
  if (rows.length === 2) return null;
  const [login, superuser, bypassrls, createrole, createdb, replication, inherit, hasPassword] = rows[0].split("|").map((v) => v === "t");
  return { login, superuser, bypassrls, createrole, createdb, replication, inherit, hasPassword, memberships: Number(rows[1]), policies: Number(rows[2]) };
}

function describeWorkerRole(r) {
  return r === null
    ? `${WORKER_ROLE}: absent (npm run itest:worker-role)`
    : `${WORKER_ROLE}: LOGIN=${r.login} BYPASSRLS=${r.bypassrls} SUPERUSER=${r.superuser} CREATEROLE=${r.createrole} CREATEDB=${r.createdb} REPLICATION=${r.replication} INHERIT=${r.inherit} PASSWORD_SET=${r.hasPassword}; memberships ${r.memberships}; policies ${r.policies}`;
}

/** Read-only, from the catalog: which queue columns the role can update. */
function readWorkerQueueColumns() {
  const columns = [...WORKER_QUEUE_UPDATE_COLUMNS, ...WORKER_QUEUE_FROZEN_COLUMNS];
  const rows = psql(`begin read only;
select c.column_name, has_column_privilege('${WORKER_ROLE}', 'pgmq.q_notification_events', c.column_name, 'UPDATE')
  from unnest(array[${columns.map((n) => `'${n}'`).join(", ")}]) as c(column_name);
rollback;`);
  return Object.fromEntries(rows.map((r) => r.split("|")).map(([name, can]) => [name, can === "t"]));
}

function workerRole() {
  preflight();
  verifyRunningStack();
  verifyBootstrap();
  psql(workerRoleSql());
  const r = readWorkerRole();
  if (r === null || !r.login || r.superuser || r.bypassrls || r.createrole || r.createdb || r.replication || r.inherit || r.memberships !== 0) {
    refuse(`The worker role does not have the approved attributes: ${describeWorkerRole(r)}`);
  }
  log(`  ${describeWorkerRole(r)}`);
  const queueColumns = readWorkerQueueColumns();
  if (WORKER_QUEUE_UPDATE_COLUMNS.some((c) => queueColumns[c] !== true) || WORKER_QUEUE_FROZEN_COLUMNS.some((c) => queueColumns[c] !== false)) {
    refuse(`The worker role's queue UPDATE columns are not the approved set: ${JSON.stringify(queueColumns)}`);
  }
  log(`  queue UPDATE columns: ${JSON.stringify(queueColumns)}`);
  log(`  pause switch: ${checkPauseSwitch()} (read only)`);
  log("itest:worker-role complete.");
}

// ── The test stack's outbound-HTTP path (M13.2 Phase 8, finding F-13) ─────────

/**
 * pg_net leaves schema `net` usable by PUBLIC, every privilege on its queue table with PUBLIC, and
 * net.http_delete executable by PUBLIC. A PUBLIC grant cannot be denied per role, so a least-privilege
 * role can still queue outbound HTTP (http_delete, or a direct insert into the queue table) until the
 * PUBLIC grants themselves go. Supabase's grant_pg_net_access() adds anon, authenticated and
 * service_role when the extension is created.
 *
 * Nothing in this application calls net.*. The one function that does, supabase_functions.http_request,
 * runs as its owner and has no trigger using it. ADR 0005's pg_cron → pg_net design would run as
 * `postgres`, so `postgres` and `supabase_functions_admin` keep their access; so does the owner.
 *
 * Test stack only, as supabase_admin, through this wrapper's identity check. Not a migration: `itest:reset`
 * brings the defaults back (run this again). It sends no HTTP request. Staging and production need
 * their own security review.
 */
const NET_REVOKED_FROM = "public, anon, authenticated, service_role";

function netLockdownSql() {
  return `begin;
revoke all on schema net from ${NET_REVOKED_FROM};
revoke all on all tables in schema net from ${NET_REVOKED_FROM};
revoke all on all sequences in schema net from ${NET_REVOKED_FROM};
revoke all on all functions in schema net from ${NET_REVOKED_FROM};
commit;`;
}

/** Read-only. One row per role, from the catalog: never by calling a net function. */
function readNetAccess() {
  const roles = [WORKER_ROLE, "anon", "authenticated", "service_role", "authenticator", "kolekto_importer", "postgres", "supabase_functions_admin"];
  const rows = psql(`begin read only;
select r.rolname, has_schema_privilege(r.oid, 'net', 'USAGE'),
       bool_or(has_function_privilege(r.oid, p.oid, 'EXECUTE')),
       has_table_privilege(r.oid, 'net.http_request_queue', 'INSERT'),
       has_table_privilege(r.oid, 'net._http_response', 'SELECT')
  from pg_roles r cross join pg_proc p
 where p.pronamespace = 'net'::regnamespace and p.proname in ('http_get', 'http_post', 'http_delete')
   and r.rolname in (${roles.map((n) => `'${n}'`).join(", ")})
 group by r.oid, r.rolname order by r.rolname;
select 'public_acl', count(*) from (
  select n.nspacl as acl from pg_namespace n where n.nspname = 'net'
  union all select c.relacl from pg_class c where c.relnamespace = 'net'::regnamespace
  union all select coalesce(p.proacl, acldefault('f', p.proowner)) from pg_proc p where p.pronamespace = 'net'::regnamespace
) a cross join lateral aclexplode(a.acl) x where x.grantee = 0;
rollback;`);
  const access = rows.filter((r) => !r.startsWith("public_acl|")).map((r) => {
    const [role, schema, execute, queueInsert, responseSelect] = r.split("|");
    return { role, schema: schema === "t", execute: execute === "t", queueInsert: queueInsert === "t", responseSelect: responseSelect === "t" };
  });
  const publicGrants = Number(rows.find((r) => r.startsWith("public_acl|"))?.split("|")[1]);
  return { access, publicGrants };
}

function describeNetAccess({ access, publicGrants }) {
  return [
    `PUBLIC grants on schema net and its objects: ${publicGrants}`,
    ...access.map((a) => `${a.role}: schema=${a.schema} http_functions=${a.execute} queue_insert=${a.queueInsert} response_select=${a.responseSelect}`),
  ];
}

function netLockdown() {
  preflight();
  verifyRunningStack();
  verifyBootstrap();
  checkPauseSwitch();
  for (const line of describeNetAccess(readNetAccess())) log(`  before: ${line}`);
  psql(netLockdownSql());
  const after = readNetAccess();
  for (const line of describeNetAccess(after)) log(`  after:  ${line}`);
  const open = after.access.filter((a) => !["postgres", "supabase_functions_admin"].includes(a.role) && (a.schema || a.execute || a.queueInsert || a.responseSelect));
  if (after.publicGrants !== 0 || open.length > 0) refuse(`Outbound HTTP is still reachable: ${open.map((a) => a.role).join(", ") || "PUBLIC"}.`);
  log(`  pause switch: ${checkPauseSwitch()} (read only)`);
  log("itest:net-lockdown complete. No HTTP request was sent.");
}

// ── Commands ──────────────────────────────────────────────────────────────────

function preflight() {
  checkDocker();
  checkCliVersion();
  readConfig();
  checkTempDir();
  return projectContainers();
}

async function up() {
  const containers = preflight();
  const dbRunning = containers.some((c) => c.name === DB_CONTAINER && c.state === "running");

  const migrations = compareMigrations();
  if (!migrations.identical) {
    if (volumeExists(DB_VOLUME)) {
      refuse(`The migration copy differs from supabase/migrations, and a test database volume already exists (built from an earlier set):\n  - ${migrations.differences.slice(0, 10).join("\n  - ")}\nRun \`npm run itest:reset -- --confirm-reset-kolekto-itest\` (separate approval).`);
    }
    reportMigrations(writeMigrationCopy());
  } else {
    reportMigrations(migrations);
  }

  if (dbRunning) {
    log(`${DB_CONTAINER} is already running; not starting again.`);
  } else {
    await checkPortsFree();
    log(`Starting the ${PROJECT_ID} stack (supabase start --workdir supabase-itest -x ${START_EXCLUDES} --ignore-health-check). CLI output is captured, not shown.`);
    // The CLI's own health wait is short; on a memory-constrained Docker VM running the
    // developer stack too, storage can need longer and the CLI then tears everything
    // down. This wrapper waits itself (bounded) and refuses if a service never becomes healthy.
    const r = supabase(["start", "-x", START_EXCLUDES, "--ignore-health-check"]);
    if (r.status !== 0) refuse(`supabase start failed (exit ${r.status}). Redacted tail:\n${redactedTail(`${r.stdout}\n${r.stderr}`)}`);
  }
  waitHealthy();
  checkTempDir();
  const stack = verifyRunningStack();
  for (const c of stack) log(`  ${c.name} ${c.state} ${c.ports.map((p) => `${p.containerPort}->${p.hostIp || "*"}:${p.hostPort}`).join(" ")}`);
  bootstrapOnce();
  log(`  pause switch: ${checkPauseSwitch()} (read only)`);
  log("itest:up complete.");
}

function down() {
  const containers = preflight();
  if (containers.length === 0) {
    log("No kolekto-itest containers exist; nothing to stop.");
    return;
  }
  const r = supabase(["stop"]);
  if (r.status !== 0) refuse(`supabase stop failed (exit ${r.status}). Redacted tail:\n${redactedTail(`${r.stdout}\n${r.stderr}`)}`);
  const left = projectContainers().filter((c) => c.state === "running");
  if (left.length > 0) refuse(`Still running after stop: ${left.map((c) => c.name).join(", ")}`);
  log(`Stopped the ${PROJECT_ID} stack. Its data volume (${DB_VOLUME}) is kept.`);
}

function status() {
  const containers = preflight();
  log(`work directory: supabase-itest (project_id ${PROJECT_ID}); config guard passed; no link artifacts in .temp`);
  reportMigrations(compareMigrations());
  log(`  .env.itest: ${existsSync(ENV_FILE) ? "present" : "absent"} (contents never shown)`);
  if (containers.length === 0) {
    log("containers: none");
    return;
  }
  const cli = supabase(["status", "-o", "json"]);
  if (cli.status === 0) {
    try {
      const s = JSON.parse(cli.stdout.slice(cli.stdout.indexOf("{")));
      for (const key of ["API_URL", "INBUCKET_URL", "MAILPIT_URL"]) if (typeof s[key] === "string") log(`  cli ${key}: ${s[key]}`);
      if (typeof s.DB_URL === "string") log(`  cli DB endpoint: ${new URL(s.DB_URL).host}`);
    } catch {
      log("  cli status: unparsable (not shown)");
    }
  } else {
    log(`  cli status: exit ${cli.status}`);
  }
  if (!containers.some((c) => c.name === DB_CONTAINER && c.state === "running")) {
    for (const c of containers) log(`  ${c.name} ${c.state}`);
    return;
  }
  for (const c of verifyRunningStack()) log(`  ${c.name} ${c.state} ${c.ports.map((p) => `${p.containerPort}->${p.hostIp || "*"}:${p.hostPort}`).join(" ")}`);
  const s = readBootstrapState();
  const env = readEnvFile();
  log(`  role ${s.roleExists ? describeRole(s) : `${ROLE}: absent`}`);
  log(`  role ${describeWorkerRole(readWorkerRole())}`);
  log(`  net: PUBLIC grants ${readNetAccess().publicGrants}`);
  log(`  kolekto.itest_db_host_port: ${s.hostPort ?? "absent"}; kolekto.itest_stack: ${s.stackId ? "set" : "absent"}${env?.stackId && s.stackId ? `, ${env.stackId === s.stackId ? "matches" : "DOES NOT MATCH"} .env.itest` : ""}`);
  log(`  pause switch: ${checkPauseSwitch()} (read only)`);
}

async function reset(args) {
  if (!args.includes("--confirm-reset-kolekto-itest")) {
    refuse("itest:reset replays every migration on the TEST database (all test data is lost) and rotates the role password and stack ID.\nRe-run with: npm run itest:reset -- --confirm-reset-kolekto-itest");
  }
  preflight();
  verifyRunningStack();
  reportMigrations(writeMigrationCopy());
  log(`Resetting the ${PROJECT_ID} database (supabase db reset --local --no-seed --workdir supabase-itest). CLI output is captured, not shown.`);
  const r = supabase(["db", "reset", "--local", "--no-seed"]);
  if (r.status !== 0) refuse(`supabase db reset failed (exit ${r.status}). Redacted tail:\n${redactedTail(`${r.stdout}\n${r.stderr}`)}`);
  checkTempDir();
  verifyRunningStack();
  checkEnvFileIgnored();
  const credentials = newCredentials();
  applyBootstrap(credentials, { roleExists: readBootstrapState().roleExists });
  const tmp = `${ENV_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, envFileText(credentials), { flag: "wx", mode: 0o600 });
  renameSync(tmp, ENV_FILE);
  log(`  ${describeRole(verifyBootstrap(credentials.stackId))}`);
  log("  bootstrap: role password, stack ID and .env.itest rotated (values not shown)");
  log(`  pause switch: ${checkPauseSwitch()} (read only)`);
  log("itest:reset complete.");
}

const COMMANDS = { up, down, status, reset, "worker-role": workerRole, "net-lockdown": netLockdown };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const allowed = command === "reset" ? ["--confirm-reset-kolekto-itest"] : [];
  const unknown = rest.filter((a) => !allowed.includes(a));
  if (!Object.hasOwn(COMMANDS, command ?? "") || unknown.length > 0) {
    refuse("Usage: node scripts/itest/itest.mjs <up|down|status|reset|worker-role|net-lockdown> (reset also needs --confirm-reset-kolekto-itest). No other arguments are accepted.");
  }
  await COMMANDS[command](rest);
}

main().catch((error) => {
  if (error instanceof Refusal) {
    process.stderr.write(`itest: REFUSED — ${error.message}\n`);
  } else {
    process.stderr.write(`itest: failed with an unexpected ${error?.name ?? "error"}. Details withheld.\n`);
  }
  process.exit(1);
});
