/**
 * itest-worker.ts — runs the REAL worker bundle as a child process against the test stack (M13.2 Phase 7).
 *
 * Nothing here imports src/index.ts: the test exercises the same esbuild bundle a deployment runs,
 * with the same flags as apps/worker/package.json, written to dist/itest/ (git-ignored). The bundle
 * has to live inside the repository so its external @aws-sdk import resolves, even though SES is
 * never constructed.
 *
 * Safety:
 *   - The child's environment is built from nothing (buildWorkerEnv). Only OS essentials are copied;
 *     no --env-file, no AWS_*, EMAIL_API_KEY, NODE_OPTIONS or any other PG* variable can reach it.
 *   - Host, port and database come only from a verified gate environment. The role is the
 *     least-privilege worker role, never the owner-equivalent harness role.
 *   - KOLEKTO_ENV=local makes the config layer refuse a real provider, and the Mailpit adapter
 *     refuses a non-loopback host.
 *   - After a spawn the caller proves the target: a session with the worker's application_name and
 *     role must appear on the verified database, or the child is killed (awaitWorkerSession).
 *   - Every child's output is scanned before it is stored (scanWorkerLog). A hit fails the test and
 *     the log is withheld rather than written.
 *
 * Credentials: issueWorkerCredential sets a random password, valid for a short time, by sending a
 * SCRAM verifier, so the plaintext never reaches the server or its logs. It lives only in memory.
 * revokeWorkerCredential removes it.
 */

import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ItestSql } from "./itest-db.ts";
import { WORKER_DB_ROLE } from "./itest-db.ts";
import { DEV_PORT_RANGE, ITEST_SMTP_HOST, refuse, Secret } from "./itest-environment.ts";
import { assertVerifiedEnvironment, type VerifiedIntegrationEnvironment } from "./itest-gate.ts";

export const WORKER_APP_NAME = "kolekto-itest-worker";

/** The test stack's Kong port. Only the config guard reads it; the worker never calls it. */
export const ITEST_API_PORT = 55421;

const WORKER_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BUNDLE_PATH = path.join(WORKER_ROOT, "dist", "itest", "index.js");
const PRELOAD_URL = new URL("./itest-worker-preload.mjs", import.meta.url).href;

/**
 * Evidence folders whose manifests are final. A new run adding a file would leave a folder that no longer
 * equals its manifest, even though `sha256sum -c` still passed. Nothing here ever writes into one.
 */
export const SEALED_EVIDENCE_FOLDERS = Object.freeze(["m13.2-phase-6b-2", "m13.2-phase-7", "m13.2-phase-8"]);
const EVIDENCE_ROOT = path.join(REPO_ROOT, "docs", "database", "evidence");

/** Durable evidence for this phase. Logs are written only after they pass scanWorkerLog. */
export const RUNTIME_EVIDENCE_DIR = path.join(EVIDENCE_ROOT, "m13.2-final-corrections", "runtime");

/** Pure. Compares resolved paths, so `..` cannot walk into a sealed folder. */
export function assertEvidenceFolderWritable(dir: string, root: string = EVIDENCE_ROOT): void {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  const folder = relative.split(path.sep)[0];
  if (folder !== undefined && SEALED_EVIDENCE_FOLDERS.includes(folder)) {
    throw refuse("EVIDENCE_SEALED", `Refusing to write into the sealed evidence folder ${folder}.`);
  }
}

const OS_ESSENTIALS = ["PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "TZ"];

// ── Build ─────────────────────────────────────────────────────────────────────

export interface WorkerBundle {
  readonly path: string;
  readonly sha256: string;
}

/** The same flags as the `build` script, with a test-only output path. */
export function workerBuildArgs(esbuildBin: string): string[] {
  return [
    esbuildBin,
    "src/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--external:@aws-sdk/*",
    "--external:@smithy/*",
    "--outfile=dist/itest/index.js",
    "--log-level=error",
  ];
}

export function buildWorkerBundle(): WorkerBundle {
  const esbuildBin = createRequire(import.meta.url).resolve("esbuild/bin/esbuild");
  const result = spawnSync(process.execPath, workerBuildArgs(esbuildBin), {
    cwd: WORKER_ROOT,
    encoding: "utf8",
    env: pickEssentials(process.env),
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.status !== 0) throw refuse("WORKER_BUILD_FAILED", `The worker bundle did not build (exit ${String(result.status)}).`);
  const sha256 = createHash("sha256").update(readFileSync(BUNDLE_PATH)).digest("hex");
  return { path: BUNDLE_PATH, sha256 };
}

// ── Credentials ───────────────────────────────────────────────────────────────

function scramVerifier(password: string): string {
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** Read-only check of the role's attributes. Anything broader than approved is a refusal. */
export async function assertWorkerRole(sql: ItestSql): Promise<void> {
  const rows = await sql.unsafe<Record<string, unknown>[]>(
    "select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit, " +
      "(select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships, " +
      "(select count(*)::int from pg_policies p where $1 = any(p.roles)) as policies " +
      "from pg_roles r where r.rolname = $1",
    [WORKER_DB_ROLE],
  );
  const r = rows[0];
  if (r === undefined) throw refuse("WORKER_ROLE_INVALID", `Role ${WORKER_DB_ROLE} does not exist. Run: npm run itest:worker-role`);
  const broader = ["rolsuper", "rolbypassrls", "rolcreaterole", "rolcreatedb", "rolreplication", "rolinherit"].filter((k) => r[k] !== false);
  if (r["rolcanlogin"] !== true || broader.length > 0 || r["memberships"] !== 0) {
    throw refuse("WORKER_ROLE_INVALID", `Role ${WORKER_DB_ROLE} has more than the approved attributes (${broader.join(", ") || "memberships or login"}).`);
  }
  // Phase 8: read from the catalog, so nothing here can reach a net function (F-13).
  const privileges = await sql.unsafe<Record<string, unknown>[]>(
    "select has_schema_privilege($1::name, (select oid from pg_namespace where nspname = 'net'), 'USAGE') as net_schema, " +
      "has_table_privilege($1::name, (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pgmq' and c.relname = 'q_notification_events'), 'DELETE') as queue_delete, " +
      "has_table_privilege($1::name, (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pgmq' and c.relname = 'a_notification_events'), 'INSERT') as archive_insert, " +
      "has_table_privilege($1::name, (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'notification_events'), 'INSERT') as events_insert, " +
      QUEUE_COLUMNS.map((column) => `has_column_privilege($1::name, (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pgmq' and c.relname = 'q_notification_events'), '${column}', 'UPDATE') as update_${column}`).join(", "),
    [WORKER_DB_ROLE],
  );
  const p = privileges[0];
  if (p?.["net_schema"] !== false) {
    throw refuse("WORKER_ROLE_INVALID", `Role ${WORKER_DB_ROLE} can reach schema net, so it can queue outbound HTTP. Run: npm run itest:net-lockdown`);
  }
  // A test that removed one of these and died mid-way must not leave later runs passing or failing for the wrong reason.
  if (p["queue_delete"] !== true || p["archive_insert"] !== true || p["events_insert"] !== true) {
    throw refuse("WORKER_ROLE_INVALID", `Role ${WORKER_DB_ROLE} is missing a queue privilege. Run: npm run itest:worker-role`);
  }
  assertQueueUpdateColumns(p);
}

/** The queue columns the worker writes. It must hold UPDATE on these and on no other. */
export const QUEUE_UPDATE_COLUMNS = Object.freeze(["vt", "read_ct", "headers"]);
/** A worker credential must not be able to rewrite a waiting message or falsify its age. */
export const QUEUE_FROZEN_COLUMNS = Object.freeze(["message", "enqueued_at", "msg_id"]);
const QUEUE_COLUMNS = Object.freeze([...QUEUE_UPDATE_COLUMNS, ...QUEUE_FROZEN_COLUMNS]);

/** Pure, so the refusal is unit-tested without a database. `read` holds one update_<column> flag per column. */
export function assertQueueUpdateColumns(read: Readonly<Record<string, unknown>>): void {
  const broader = QUEUE_FROZEN_COLUMNS.filter((column) => read[`update_${column}`] !== false);
  if (broader.length > 0) throw refuse("WORKER_ROLE_INVALID", `Role ${WORKER_DB_ROLE} can update queue column(s) it must not: ${broader.join(", ")}. Run: npm run itest:worker-role`);
  const missing = QUEUE_UPDATE_COLUMNS.filter((column) => read[`update_${column}`] !== true);
  if (missing.length > 0) throw refuse("WORKER_ROLE_INVALID", `Role ${WORKER_DB_ROLE} cannot update queue column(s) it needs: ${missing.join(", ")}. Run: npm run itest:worker-role`);
}

/**
 * Only these, on these tables. Each makes one operation fail for real: the delete and the archive insert
 * are the F-15 queue operations, and the event insert makes processing itself fail (R-1).
 */
const REVOCABLE_PRIVILEGES = Object.freeze({
  "queue-delete": { privilege: "delete", table: "pgmq.q_notification_events" },
  "archive-insert": { privilege: "insert", table: "pgmq.a_notification_events" },
  "events-insert": { privilege: "insert", table: "public.notification_events" },
});

/**
 * Injects a persistent acknowledgement or archive failure: takes one privilege from the worker role
 * for the length of `fn`, then gives it back and reads it back. A process that dies in between leaves
 * it removed; assertWorkerRole then refuses until `npm run itest:worker-role` restores it.
 */
export async function withWorkerPrivilegeRevoked<T>(sql: ItestSql, which: keyof typeof REVOCABLE_PRIVILEGES, fn: () => Promise<T>): Promise<T> {
  const { privilege, table } = REVOCABLE_PRIVILEGES[which];
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role postgres");
    await tx.unsafe(`revoke ${privilege} on ${table} from ${WORKER_DB_ROLE}`);
  });
  try {
    return await fn();
  } finally {
    await sql.begin(async (tx) => {
      await tx.unsafe("set local role postgres");
      await tx.unsafe(`grant ${privilege} on ${table} to ${WORKER_DB_ROLE}`);
    });
    await assertWorkerRole(sql);
  }
}

/**
 * Sets a random password that expires by itself. Runs as `postgres`, the role's creator, through the
 * harness role's existing membership. Returns the password wrapped so it cannot be printed.
 */
export async function issueWorkerCredential(sql: ItestSql, validMinutes = 90): Promise<Secret> {
  const password = randomBytes(32).toString("base64url");
  const verifier = scramVerifier(password);
  const until = new Date(Date.now() + validMinutes * 60_000).toISOString();
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role postgres");
    await tx.unsafe(`alter role ${WORKER_DB_ROLE} with password '${verifier}' valid until '${until}'`);
  });
  return new Secret(password);
}

export async function revokeWorkerCredential(sql: ItestSql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role postgres");
    await tx.unsafe(`alter role ${WORKER_DB_ROLE} with password null`);
  });
}

// ── Environment ───────────────────────────────────────────────────────────────

function pickEssentials(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && OS_ESSENTIALS.includes(key.toUpperCase())) out[key] = value;
  }
  return out;
}

export type WorkerDatabaseTarget =
  /** The verified test database as the worker role: the normal case. */
  | { readonly kind: "verified"; readonly password: Secret }
  /** Invalid-configuration cases. Host is always loopback; the port is closed or the test database. */
  | { readonly kind: "wrong-password"; readonly password: Secret }
  | { readonly kind: "closed-port"; readonly port: number; readonly password: Secret }
  | { readonly kind: "malformed-url"; readonly password: Secret }
  | { readonly kind: "unset" };

export interface WorkerOptions {
  readonly database: WorkerDatabaseTarget;
  /** "mailpit" by default; "none" leaves EMAIL_PROVIDER unset; "unsupported" is refused by the config layer. */
  readonly provider?: "mailpit" | "none" | "unsupported";
  /** Defaults to the gate's Mailpit port; the fault proxy's or a closed port otherwise. Host is always loopback. */
  readonly smtpPort?: number;
}

/** Pure, so every rule is unit-tested without spawning anything. */
export function buildWorkerEnv(env: VerifiedIntegrationEnvironment, options: WorkerOptions, ambient: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  assertVerifiedEnvironment(env);
  const child = pickEssentials(ambient);
  child["KOLEKTO_ENV"] = "local";
  child["NEXT_PUBLIC_SUPABASE_URL"] = `http://127.0.0.1:${ITEST_API_PORT}`;
  child["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] = "itest-placeholder-not-a-key";
  child["PGAPPNAME"] = WORKER_APP_NAME;

  const url = (port: number, password: Secret) =>
    `postgresql://${WORKER_DB_ROLE}:${encodeURIComponent(password.reveal())}@127.0.0.1:${port}/${env.db.database}`;
  const target = options.database;
  // A "closed" port comes from the operating system's free list, which can include the developer stack's
  // ports while that stack is stopped. The worker is never pointed there, closed or not.
  const refuseDeveloperPort = (port: number) => {
    if (port >= DEV_PORT_RANGE.min && port <= DEV_PORT_RANGE.max) throw refuse("WORKER_ENV_INVALID", "The worker is never pointed at a developer-stack port.");
  };
  if (target.kind === "verified" || target.kind === "wrong-password") child["SUPABASE_DB_URL"] = url(env.db.port, target.password);
  else if (target.kind === "closed-port") {
    refuseDeveloperPort(target.port);
    child["SUPABASE_DB_URL"] = url(target.port, target.password);
  }
  else if (target.kind === "malformed-url") child["SUPABASE_DB_URL"] = `postgresql://${WORKER_DB_ROLE}:${target.password.reveal()}@127.0.0.1:not-a-port/${env.db.database}`;

  const provider = options.provider ?? "mailpit";
  if (provider === "unsupported") child["EMAIL_PROVIDER"] = "acme";
  if (provider === "mailpit") {
    const smtpPort = options.smtpPort ?? env.smtp.port;
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) throw refuse("WORKER_ENV_INVALID", "The worker's SMTP port is not a valid port.");
    refuseDeveloperPort(smtpPort);
    child["EMAIL_PROVIDER"] = "mailpit";
    child["EMAIL_FROM"] = "noreply@kolekto.test";
    child["APP_BASE_URL"] = "http://127.0.0.1:3999";
    child["EMAIL_SMTP_HOST"] = ITEST_SMTP_HOST;
    child["EMAIL_SMTP_PORT"] = String(smtpPort);
  }
  return child;
}

// ── Log scan ──────────────────────────────────────────────────────────────────

const ALWAYS_FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "connection URL", pattern: /postgres(?:ql)?:\/\//i },
  { label: "run-scoped recipient address", pattern: /itest\+[0-9a-f]{8}-\d+@/i },
  { label: "address-shaped text", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/ },
  { label: "phone number", pattern: /\+234\d/ },
  { label: "Failing row detail", pattern: /Failing row contains/i },
  { label: "SCRAM verifier", pattern: /SCRAM-SHA-256\$/ },
];

/** Labels of everything sensitive in a worker's output. `secrets` are exact values for this run. */
export function scanWorkerLog(output: string, secrets: readonly Secret[] = []): string[] {
  const found = ALWAYS_FORBIDDEN.filter((r) => r.pattern.test(output)).map((r) => r.label);
  secrets.forEach((s, i) => {
    const value = s.reveal();
    if (value !== "" && (output.includes(value) || output.includes(encodeURIComponent(value)))) found.push(`run secret ${i + 1}`);
  });
  return found;
}

// ── The child ─────────────────────────────────────────────────────────────────

export interface WorkerExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface WorkerHandle {
  readonly pid: number;
  /** Everything the child has printed so far, in memory only. */
  output(): string;
  /** JSON log lines with this `msg` value. */
  linesFor(msg: string): Record<string, unknown>[];
  waitForOutput(pattern: RegExp, timeoutMs: number): Promise<void>;
  /** Asks for a graceful stop (the drain), then waits for the exit. */
  stop(timeoutMs?: number): Promise<WorkerExit>;
  /** Forced kill: SIGKILL on POSIX, TerminateProcess on Windows. */
  kill(): Promise<WorkerExit>;
  exited(): Promise<WorkerExit>;
  /** True until the process has exited. */
  alive(): boolean;
  /**
   * Every remote TCP address seen on this process by a 1 s sampler (Windows netstat; null where the
   * sampler does not run). Supporting evidence for "only loopback": a sample can miss a very short connection.
   */
  remoteAddresses(): readonly string[] | null;
}

const live = new Set<WorkerHandle>();

/** Remote addresses of `pid`'s TCP connections in `netstat -ano` output. Pure. */
export function parseRemoteAddresses(netstat: string, pid: number): string[] {
  const found = new Set<string>();
  for (const line of netstat.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+\s+(\S+)\s+\S+\s+(\d+)\s*$/.exec(line);
    if (m === null || Number(m[2]) !== pid) continue;
    const remote = m[1]!.slice(0, m[1]!.lastIndexOf(":"));
    if (remote !== "0.0.0.0" && remote !== "[::]" && remote !== "*") found.add(remote);
  }
  return [...found].sort();
}

export function startWorker(bundle: WorkerBundle, env: VerifiedIntegrationEnvironment, options: WorkerOptions): WorkerHandle {
  assertSwitchNotStuck();
  const child: ChildProcess = spawn(process.execPath, ["--import", PRELOAD_URL, bundle.path], {
    cwd: WORKER_ROOT,
    env: buildWorkerEnv(env, options),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let output = "";
  let exit: WorkerExit | null = null;
  const exitPromise = new Promise<WorkerExit>((resolve) => {
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });

  const remotes = new Set<string>();
  const sampling = process.platform === "win32";
  const sampler = sampling
    ? setInterval(() => {
        execFile("netstat", ["-ano"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
          if (error === null && child.pid !== undefined) for (const a of parseRemoteAddresses(stdout, child.pid)) remotes.add(a);
        });
      }, 1_000)
    : null;
  sampler?.unref();
  void exitPromise.then(() => { if (sampler !== null) clearInterval(sampler); });

  const waitForExit = async (timeoutMs: number): Promise<WorkerExit> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(refuse("WORKER_TIMEOUT", `The worker did not exit within ${timeoutMs} ms.`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const handle: WorkerHandle = {
    pid: child.pid ?? -1,
    output: () => output,
    linesFor(msg) {
      const lines: Record<string, unknown>[] = [];
      for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed["msg"] === msg) lines.push(parsed);
        } catch {
          // Not a JSON line.
        }
      }
      return lines;
    },
    async waitForOutput(pattern, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!pattern.test(output)) {
        if (Date.now() > deadline) throw refuse("WORKER_TIMEOUT", `Expected worker output did not appear within ${timeoutMs} ms (${pattern.source}).`);
        if (exit !== null && !pattern.test(output)) throw refuse("WORKER_TIMEOUT", `The worker exited (code ${String((exit as WorkerExit).code)}) before the expected output appeared (${pattern.source}).`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async stop(timeoutMs = 30_000) {
      if (exit === null) child.send?.("stop");
      try {
        return await waitForExit(timeoutMs);
      } finally {
        live.delete(handle);
      }
    },
    async kill() {
      if (exit === null) child.kill("SIGKILL");
      const result = await waitForExit(10_000);
      live.delete(handle);
      return result;
    },
    exited: () => exitPromise,
    alive: () => exit === null,
    remoteAddresses: () => (sampling ? [...remotes].sort() : null),
  };
  live.add(handle);
  return handle;
}

/** Kills anything a failed test left running. Called from afterEach, before quarantine. */
export async function killLeftoverWorkers(): Promise<number> {
  const leftovers = [...live];
  for (const worker of leftovers) await worker.kill();
  return leftovers.length;
}

export interface WorkerSession {
  readonly pid: number;
  readonly usename: string;
  readonly state: string | null;
  readonly wait_event_type: string | null;
  readonly query: string | null;
}

/** Read-only: sessions on this database with the worker's application name. */
export async function readWorkerSessions(sql: ItestSql): Promise<WorkerSession[]> {
  return sql.unsafe<WorkerSession[]>(
    "select pid, usename::text as usename, state, wait_event_type, query from pg_stat_activity " +
      "where application_name = $1 and datname = current_database() order by pid",
    [WORKER_APP_NAME],
  ) as unknown as Promise<WorkerSession[]>;
}

/**
 * The target proof: within the bound a session with the worker's application name and exactly the
 * worker role must exist on the verified database. Otherwise the child is killed and the test fails.
 */
export async function awaitWorkerSession(sql: ItestSql, worker: WorkerHandle, timeoutMs = 15_000): Promise<WorkerSession> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sessions = await readWorkerSessions(sql);
    const foreign = sessions.filter((s) => s.usename !== WORKER_DB_ROLE);
    if (foreign.length > 0) {
      await worker.kill();
      throw refuse("WORKER_TARGET_UNPROVEN", "A worker session is connected as a role other than the least-privilege worker role.");
    }
    if (sessions[0] !== undefined) return sessions[0];
    if (Date.now() > deadline) {
      await worker.kill();
      throw refuse("WORKER_TARGET_UNPROVEN", `No worker session appeared on the verified test database within ${timeoutMs} ms.`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Read-only, bounded: a worker session blocked on a lock, optionally running a matching statement. */
export async function awaitBlockedWorker(sql: ItestSql, queryPattern: RegExp, timeoutMs = 45_000): Promise<WorkerSession> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const blocked = (await readWorkerSessions(sql)).find((s) => s.wait_event_type === "Lock" && queryPattern.test(s.query ?? ""));
    if (blocked !== undefined) return blocked;
    if (Date.now() > deadline) throw refuse("WORKER_TIMEOUT", `No worker session blocked on a lock within ${timeoutMs} ms (${queryPattern.source}).`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── Evidence ──────────────────────────────────────────────────────────────────

export interface EvidenceSink {
  readonly dir: string;
  /** Appends one JSON line of independent readings. Ids, counts and codes only. */
  reading(label: string, value: unknown): void;
  /** Scans a worker's output; on a clean scan stores it, otherwise withholds it and throws. */
  storeWorkerLog(label: string, worker: WorkerHandle, secrets: readonly Secret[]): void;
}

export function createEvidenceSink(runTag: string): EvidenceSink {
  const dir = path.join(RUNTIME_EVIDENCE_DIR, runTag);
  assertEvidenceFolderWritable(dir);
  mkdirSync(path.join(dir, "worker-logs"), { recursive: true });
  const readings = path.join(dir, "readings.jsonl");
  return {
    dir,
    reading(label, value) {
      writeFileSync(readings, `${JSON.stringify({ at: new Date().toISOString(), label, value })}\n`, { flag: "a" });
    },
    storeWorkerLog(label, worker, secrets) {
      const file = path.join(dir, "worker-logs", `${label}.txt`);
      const hits = scanWorkerLog(worker.output(), secrets);
      if (hits.length > 0) {
        writeFileSync(`${file}.WITHHELD`, `Withheld: sensitive content detected (${hits.join(", ")}).\n`);
        throw refuse("WORKER_LOG_SENSITIVE", `A worker log for ${label} contained sensitive content (${hits.join(", ")}); it was withheld.`);
      }
      writeFileSync(file, worker.output());
    },
  };
}

// ── Set by itest-switch.ts when the pause switch could not be restored ────────

let switchStuck = false;

export function markSwitchStuck(): void {
  switchStuck = true;
}

/** Stop condition: if the switch could not be restored, no worker may start again in this process. */
export function assertSwitchNotStuck(): void {
  if (switchStuck) throw refuse("SWITCH_RESTORE_FAILED", "The pause switch could not be restored to false; no further worker or sender may run.");
}
