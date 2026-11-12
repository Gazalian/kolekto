/**
 * itest-lane.ts — the `npm run test:integration` runner logic (M13.2 Phase 1a).
 *
 * The lane fails, never passes vacuously:
 *   1. Static gate: the KOLEKTO_ITEST_* environment must validate (no I/O).
 *   2. Files: test/integration/ must hold exactly the files in
 *      INTEGRATION_MANIFEST (none missing, none unlisted), every one must
 *      visibly use the gate and connectVerified(), and none may contain a
 *      pause-switch write, a direct driver call, an ambient endpoint or a skip.
 *   3. Child: node --test runs those files only, one at a time, with
 *      KOLEKTO_ITEST_REQUIRED=1 and an allow-listed environment: OS essentials
 *      plus the KOLEKTO_ITEST_* set. Developer database URLs, service-role
 *      keys, EMAIL_* and SES, Paystack and session secrets are never inherited.
 *      Each file then runs the full gate (live identity + pause switch) itself.
 *   4. Canary: the TAP summary must exist and report > 0 tests, all passed,
 *      none failed, cancelled, skipped or todo. Anything else exits non-zero.
 *
 * Only the dependency-injected runIntegrationLane() and pure helpers live here,
 * so unit tests can drive every branch without spawning a process or touching
 * a database. run-integration.ts is the entry point; it calls
 * runIntegrationEntry(), which first loads `.env.itest` (itest-env-file.ts,
 * Phase 1c) and refuses before step 1 if that fails.
 */

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ITEST_ENV,
  IntegrationGateError,
  parseIntegrationEnvironment,
  refuse,
  type EnvSource,
  type GateViolation,
} from "./itest-environment.ts";
import { ITEST_ENV_FILE_PATH, loadIntegrationEnvironment, type EnvFileDeps } from "./itest-env-file.ts";
import { findForbiddenSwitchWrites, findUnsafeConnectionPatterns, REQUIRED_MODE_VARIABLE, usesIntegrationGate } from "./itest-gate.ts";

export const WORKER_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const INTEGRATION_DIR = path.join("test", "integration");

/**
 * Every integration test file, by path relative to the worker root. The lane
 * refuses a run in which any of these is missing or an unlisted file appears,
 * so a file cannot silently drop out of (or slip into) the lane.
 */
export const INTEGRATION_MANIFEST: readonly string[] = [
  // M13.3 R3: the communication policy file (no SMTP, no pause switch; rolled back).
  "test/integration/notification-communication-policy.integration.test.ts",
  "test/integration/notification-e2e-mailpit.integration.test.ts",
  "test/integration/notification-processor.integration.test.ts",
  "test/integration/notification-rate-limit.integration.test.ts",
  "test/integration/notification-send-claim.integration.test.ts",
  "test/integration/notification-sender-mailpit.integration.test.ts",
  "test/integration/notification-sender.integration.test.ts",
  "test/integration/notification-suppression.integration.test.ts",
  "test/integration/notification-worker-reliability.integration.test.ts",
  "test/integration/notification-worker-runtime.integration.test.ts",
  // M8.5: the payment orchestrator, all seven collection flows (no SMTP, no pause switch; rolled back).
  "test/integration/payments-orchestrator.integration.test.ts",
];

/**
 * Phase 4: manifest files that open SMTP connections (to the test Mailpit, or to
 * a closed loopback port for the unreachable-provider case). They run only when
 * the lane is started with `--with-smtp` (Phase 5 approval). With
 * `--without-smtp` they are still listed and lexically checked, but not
 * started, and the lane says so in its summary. With neither flag the lane
 * refuses: there is no default.
 *
 * Phase 6A: the end-to-end file (one send to the test Mailpit) is an SMTP file too.
 */
export const SMTP_INTEGRATION_FILES: readonly string[] = [
  "test/integration/notification-e2e-mailpit.integration.test.ts",
  "test/integration/notification-sender-mailpit.integration.test.ts",
  "test/integration/notification-worker-reliability.integration.test.ts",
  "test/integration/notification-worker-runtime.integration.test.ts",
];

/**
 * Phase 7: the files that run the real worker process and, inside their guarded helper, change the
 * pause switch. They need real time (the 30 s visibility timeout is a constant), so `--worker-runtime`
 * runs them alone: they can be repeated cheaply. `--with-smtp` runs them too, last, as part of the full lane.
 */
export const WORKER_RUNTIME_FILES: readonly string[] = [
  "test/integration/notification-worker-reliability.integration.test.ts",
  "test/integration/notification-worker-runtime.integration.test.ts",
];

/** Phase 8: the F-13, F-14 and F-15 file alone, because it spends almost no budget and the others spend it quickly. */
export const WORKER_RELIABILITY_FILES: readonly string[] = [
  "test/integration/notification-worker-reliability.integration.test.ts",
];

/** Set by the lane for its child only, and only when a worker-runtime file is started. */
export const SWITCH_GRANT_VARIABLE = "KOLEKTO_ITEST_ALLOW_SWITCH_ON";

export type SmtpMode = "with" | "without" | "worker-runtime" | "worker-reliability";

/** What a file outside SMTP_INTEGRATION_FILES may not mention: the SMTP adapter or the SMTP/Mailpit endpoints. */
const SMTP_USAGE = /\bMailpitEmailProvider\b|\.smtp\b|\bmailpitApi\b/;

/** Parses the lane's command-line arguments: exactly one of --with-smtp / --without-smtp / --worker-runtime / --worker-reliability. */
export function parseLaneArgs(argv: readonly string[]): SmtpMode {
  const known = new Map<string, SmtpMode>([["--with-smtp", "with"], ["--without-smtp", "without"], ["--worker-runtime", "worker-runtime"], ["--worker-reliability", "worker-reliability"]]);
  const modes = argv.map((a) => known.get(a));
  if (modes.some((m) => m === undefined)) {
    throw refuse("LANE_ARGUMENT_INVALID", "The integration lane accepts only --with-smtp, --without-smtp, --worker-runtime or --worker-reliability.");
  }
  if (argv.length !== 1) {
    throw refuse("SMTP_MODE_REQUIRED", "Start the lane with exactly one of --with-smtp (sends to the test Mailpit; needs SMTP approval), --without-smtp (no SMTP connection), --worker-runtime (only the real-worker files) or --worker-reliability (only the F-13, F-14 and F-15 file). There is no default.");
  }
  return modes[0]!;
}

/**
 * The only variables an integration child inherits (compared upper-case:
 * Windows names are case-insensitive). Everything else — SUPABASE_DB_URL,
 * service-role keys, EMAIL_* and SES credentials, Paystack keys,
 * KOLEKTO_SESSION_SECRET, NODE_OPTIONS, PG* — is dropped.
 */
const CHILD_ENV_ALLOWED: ReadonlySet<string> = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL", "TZ", "TERM", "NO_COLOR", "FORCE_COLOR", "CI",
  ...Object.values(ITEST_ENV),
]);

export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

export interface ChildResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly output: string;
}

export interface LaneDeps {
  readonly env: EnvSource;
  readonly listIntegrationFiles: () => Promise<readonly SourceFile[]>;
  readonly runTests: (files: readonly string[], env: Readonly<Record<string, string>>) => Promise<ChildResult>;
  readonly log: (text: string) => void;
  /** Normally INTEGRATION_MANIFEST; injectable so unit tests can use fixture paths. */
  readonly manifest: readonly string[];
  /** Manifest files that open SMTP connections (default: none). The real lane passes SMTP_INTEGRATION_FILES. */
  readonly smtpFiles?: readonly string[];
  /** Required whenever smtpFiles is non-empty (Phase 4). */
  readonly smtpMode?: SmtpMode;
  /** Phase 7: files only `--worker-runtime` and `--with-smtp` start. The real lane passes WORKER_RUNTIME_FILES. */
  readonly runtimeFiles?: readonly string[];
}

export interface TapSummary {
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly todo: number;
  /**
   * `# SKIP` / `# TODO` directives on any ok/not ok line. Needed because
   * node:test 22 does not count a skipped describe() in `# skipped` (it reports
   * `# tests 0`, `# skipped 0`), so the counters alone miss suite-level skips.
   */
  readonly directives: number;
}

export function buildChildEnv(env: EnvSource): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase(); // Windows environment names are case-insensitive
    if (!CHILD_ENV_ALLOWED.has(upper)) continue;
    child[key] = value;
  }
  child[REQUIRED_MODE_VARIABLE] = "1";
  return child;
}

export function nodeTestArgs(files: readonly string[]): string[] {
  return ["--experimental-strip-types", "--test", "--test-concurrency=1", "--test-reporter=tap", ...files];
}

const toPosix = (p: string) => p.replaceAll("\\", "/");

/**
 * Phase 4: a file outside the declared SMTP set must not use the SMTP adapter or
 * the SMTP/Mailpit endpoints, so --without-smtp really opens no SMTP connection.
 */
export function checkSmtpDeclarations(files: readonly SourceFile[], smtpFiles: readonly string[]): void {
  const declared = new Set(smtpFiles.map(toPosix));
  const out: GateViolation[] = [];
  for (const file of files) {
    if (!declared.has(toPosix(file.path)) && SMTP_USAGE.test(file.source)) {
      out.push({ code: "FILE_SMTP_UNDECLARED", message: `${file.path} uses the SMTP adapter or an SMTP/Mailpit endpoint but is not listed in SMTP_INTEGRATION_FILES.` });
    }
  }
  if (out.length > 0) throw new IntegrationGateError(out);
}

/** Splits the checked file list into the files to start and the SMTP files withheld by --without-smtp. */
export function selectLaneFiles(files: readonly string[], smtpFiles: readonly string[], mode: SmtpMode | undefined, runtimeFiles: readonly string[] = []): { run: string[]; withheld: string[] } {
  if (smtpFiles.length === 0) return { run: [...files], withheld: [] };
  if (mode === undefined) {
    throw refuse("SMTP_MODE_REQUIRED", "This manifest contains SMTP files; start the lane with --with-smtp, --without-smtp or --worker-runtime. There is no default.");
  }
  if (mode === "with") return { run: [...files], withheld: [] };
  if (mode === "worker-runtime" || mode === "worker-reliability") {
    const selected = new Set((mode === "worker-runtime" ? runtimeFiles : WORKER_RELIABILITY_FILES).map(toPosix));
    const run = files.filter((f) => selected.has(toPosix(f)));
    if (run.length === 0) throw refuse("NO_INTEGRATION_FILES", `--${mode} found no file to run.`);
    return { run, withheld: files.filter((f) => !selected.has(toPosix(f))) };
  }
  const declared = new Set(smtpFiles.map(toPosix));
  const run = files.filter((f) => !declared.has(toPosix(f)));
  const withheld = files.filter((f) => declared.has(toPosix(f)));
  if (run.length === 0) throw refuse("NO_INTEGRATION_FILES", "--without-smtp leaves no integration file to run.");
  return { run, withheld };
}

/** Returns the file paths to run, or throws if the set is empty, differs from the manifest, or any file is unsafe. */
export function checkIntegrationFiles(files: readonly SourceFile[], manifest: readonly string[]): string[] {
  if (files.length === 0) {
    throw refuse("NO_INTEGRATION_FILES", `No *.test.ts files under ${INTEGRATION_DIR}. An empty lane is a failure, not a pass.`);
  }
  const out: GateViolation[] = [];
  const found = new Set(files.map((f) => toPosix(f.path)));
  const expected = new Set(manifest.map(toPosix));
  for (const missing of [...expected].filter((p) => !found.has(p))) {
    out.push({ code: "INTEGRATION_FILE_MISSING", message: `${missing} is listed in the integration manifest but does not exist.` });
  }
  for (const unlisted of [...found].filter((p) => !expected.has(p))) {
    out.push({ code: "INTEGRATION_FILE_UNLISTED", message: `${unlisted} is not listed in the integration manifest (itest-lane.ts).` });
  }
  for (const file of files) {
    if (!usesIntegrationGate(file.source)) {
      out.push({ code: "FILE_NOT_GATED", message: `${file.path} does not import support/itest-gate.ts and call createIntegrationGate(), verify() and postflight().` });
    }
    for (const label of findUnsafeConnectionPatterns(file.source)) {
      out.push({ code: "FILE_UNSAFE_CONNECTION", message: `${file.path} ${label}.` });
    }
    for (const label of findForbiddenSwitchWrites(file.source)) {
      out.push({ code: "FORBIDDEN_SWITCH_WRITE", message: `${file.path} contains a pause-switch write (${label}).` });
    }
  }
  if (out.length > 0) throw new IntegrationGateError(out);
  return files.map((f) => f.path);
}

const SUMMARY_LINE = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/;
// The TAP reporter escapes '#' in test names as '\#', so an unescaped " # SKIP" is a directive.
const DIRECTIVE_LINE = /^\s*(?:not )?ok \d+ - .*(?<!\\) # (?:SKIP|TODO)\b/i;

/** Reads node:test's top-level TAP summary. Null if any of the six counters is absent. */
export function parseTapSummary(output: string): TapSummary | null {
  const found = new Map<string, number>();
  let directives = 0;
  for (const line of output.split(/\r?\n/)) {
    const m = SUMMARY_LINE.exec(line);
    if (m !== null) found.set(m[1]!, Number(m[2]));
    if (DIRECTIVE_LINE.test(line)) directives++;
  }
  const get = (k: string) => found.get(k);
  const [tests, pass, fail, cancelled, skipped, todo] = ["tests", "pass", "fail", "cancelled", "skipped", "todo"].map(get);
  if (tests === undefined || pass === undefined || fail === undefined || cancelled === undefined || skipped === undefined || todo === undefined) {
    return null;
  }
  return { tests, pass, fail, cancelled, skipped, todo, directives };
}

/** The canary. Returns the summary only for a run where every counted test passed. */
export function evaluateRun(result: ChildResult): TapSummary {
  if (result.signal !== null || result.code === null) {
    throw refuse("RUN_FAILED", "The integration test process was terminated before it finished.");
  }
  const summary = parseTapSummary(result.output);
  if (summary === null) {
    throw refuse("RUN_INCONCLUSIVE", "The integration test process printed no complete TAP summary.");
  }
  const out: GateViolation[] = [];
  if (result.code !== 0 || summary.fail > 0 || summary.cancelled > 0) {
    out.push({ code: "RUN_FAILED", message: `Integration tests failed (exit ${result.code}, ${summary.fail} failed, ${summary.cancelled} cancelled).` });
  }
  if (summary.tests === 0) {
    out.push({ code: "RUN_EMPTY", message: "Zero integration tests executed." });
  }
  if (summary.skipped > 0 || summary.todo > 0 || summary.directives > 0) {
    out.push({ code: "RUN_SKIPPED_TESTS", message: `${summary.skipped} skipped, ${summary.todo} todo, ${summary.directives} SKIP/TODO directive(s) in the TAP output. The lane never skips.` });
  }
  if (out.length === 0 && summary.pass !== summary.tests) {
    out.push({ code: "RUN_INCONCLUSIVE", message: `Passed count (${summary.pass}) differs from test count (${summary.tests}).` });
  }
  if (out.length > 0) throw new IntegrationGateError(out);
  return summary;
}

export async function runIntegrationLane(deps: LaneDeps): Promise<number> {
  try {
    parseIntegrationEnvironment(deps.env);
    const listed = await deps.listIntegrationFiles();
    const files = checkIntegrationFiles(listed, deps.manifest);
    const smtpFiles = deps.smtpFiles ?? [];
    checkSmtpDeclarations(listed, smtpFiles);
    const runtimeFiles = deps.runtimeFiles ?? [];
    const { run, withheld } = selectLaneFiles(files, smtpFiles, deps.smtpMode, runtimeFiles);
    const runtime = new Set(runtimeFiles.map(toPosix));
    // The grant reaches the child only when a file that may use it is actually starting.
    const grant = run.some((f) => runtime.has(toPosix(f))) ? { [SWITCH_GRANT_VARIABLE]: "1" } : {};
    const summary = evaluateRun(await deps.runTests(run, { ...buildChildEnv(deps.env), ...grant }));
    if (withheld.length === 0) {
      deps.log(`Integration lane passed: ${summary.pass}/${summary.tests} test(s) in ${run.length} file(s), none skipped.`);
    } else if (deps.smtpMode === "worker-runtime") {
      deps.log(`Integration lane passed WORKER RUNTIME ONLY (partial run, not the full suite): ${summary.pass}/${summary.tests} test(s) in ${run.length} of ${files.length} file(s), none skipped.`);
    } else if (deps.smtpMode === "worker-reliability") {
      deps.log(`Integration lane passed WORKER RELIABILITY ONLY (partial run, not the full suite): ${summary.pass}/${summary.tests} test(s) in ${run.length} of ${files.length} file(s), none skipped.`);
    } else {
      deps.log(
        `Integration lane passed WITHOUT SMTP (partial run, not the full suite): ${summary.pass}/${summary.tests} test(s) in ${run.length} of ${files.length} file(s), none skipped. ` +
          `Withheld, not started (SMTP; needs --with-smtp and SMTP approval): ${withheld.map(toPosix).join(", ")}.`,
      );
    }
    return 0;
  } catch (error) {
    deps.log(
      error instanceof IntegrationGateError
        ? error.message
        : `Integration lane failed with an unexpected ${error instanceof Error ? error.name : "error"}. Details withheld.`,
    );
    return 1;
  }
}

// ── Real dependencies (used only by run-integration.ts) ──────────────────────

async function listIntegrationFiles(): Promise<SourceFile[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(WORKER_ROOT, INTEGRATION_DIR), { recursive: true });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  const files = entries.filter((e) => e.endsWith(".test.ts")).sort();
  return Promise.all(
    files.map(async (rel) => {
      const filePath = path.join(INTEGRATION_DIR, rel);
      return { path: filePath, source: await readFile(path.join(WORKER_ROOT, filePath), "utf8") };
    }),
  );
}

function runTests(files: readonly string[], env: Readonly<Record<string, string>>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeTestArgs(files), { cwd: WORKER_ROOT, env, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
}

export function defaultLaneDeps(): LaneDeps {
  return {
    env: process.env,
    listIntegrationFiles,
    runTests,
    log: (text) => process.stderr.write(`${text}\n`),
    manifest: INTEGRATION_MANIFEST,
    smtpFiles: SMTP_INTEGRATION_FILES,
    runtimeFiles: WORKER_RUNTIME_FILES,
  };
}

// ── Entry point (Phase 1c): configuration comes only from .env.itest ──────────

export interface EntryDeps {
  readonly envFile: EnvFileDeps;
  readonly lane: Omit<LaneDeps, "env" | "smtpMode">;
  /** Command-line arguments after the script name (Phase 4: --with-smtp / --without-smtp). Default: none. */
  readonly argv?: readonly string[];
}

export function defaultEntryDeps(): EntryDeps {
  const { env, ...lane } = defaultLaneDeps();
  return { envFile: { processEnv: env, readFile: (p) => readFile(p, "utf8"), filePath: ITEST_ENV_FILE_PATH }, lane, argv: process.argv.slice(2) };
}

/**
 * What run-integration.ts runs: load .env.itest (itest-env-file.ts), then the
 * lane. A missing, malformed or overridden configuration exits 1 before any
 * file is listed or any test process is started.
 */
export async function runIntegrationEntry(deps: EntryDeps): Promise<number> {
  let env: EnvSource;
  try {
    env = await loadIntegrationEnvironment(deps.envFile);
  } catch (error) {
    deps.lane.log(
      error instanceof IntegrationGateError
        ? error.message
        : `Integration lane failed while loading its configuration (unexpected ${error instanceof Error ? error.name : "error"}). Details withheld.`,
    );
    return 1;
  }
  let smtpMode: SmtpMode | undefined;
  const argv = deps.argv ?? [];
  // No arguments leaves the mode unset: the lane then refuses only if its manifest holds SMTP files.
  if (argv.length > 0) {
    try {
      smtpMode = parseLaneArgs(argv);
    } catch (error) {
      deps.lane.log(error instanceof IntegrationGateError ? error.message : "Integration lane arguments could not be read. Details withheld.");
      return 1;
    }
  }
  return runIntegrationLane({ ...deps.lane, env, ...(smtpMode === undefined ? {} : { smtpMode }) });
}
