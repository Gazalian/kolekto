/**
 * itest-gate.ts — the fail-closed gate every integration test file goes through (M13.2 Phase 1a).
 *
 * Usage, in a file under test/integration/ (Phase 1b: the real, read-only
 * probe and switch reader are wired by liveGateDeps() in itest-db.ts):
 *
 *   const gate = createIntegrationGate(liveGateDeps());
 *   before(() => gate.verify());        // throws → every test in the file fails, none skips
 *   after(() => gate.postflight());     // the pause switch must still be off
 *   it("…", async () => { const sql = connectVerified(gate.verified(), { max: 2 }); … });
 *
 * Guarantees:
 *   - verify() refuses unless the lane was started by `npm run test:integration`
 *     (KOLEKTO_ITEST_REQUIRED=1), the static configuration is valid, the live
 *     identity matches the test stack, and the pause switch row exists and is
 *     exactly `false`. It never skips: a refusal is a thrown IntegrationGateError.
 *   - A refusal is permanent for the gate instance; a later verify() rethrows it.
 *   - verified() is the only way to obtain the environment, and it throws until
 *     verify() has succeeded. Helpers that open connections must call
 *     assertVerifiedEnvironment(), which accepts only objects this module issued.
 *   - The gate has no write path. It reads the pause switch and never changes it,
 *     not even inside a rolled-back transaction (approval checklist §8, R11′).
 */

import {
  IntegrationGateError,
  parseIntegrationEnvironment,
  refuse,
  verifyLiveIdentity,
  type EnvSource,
  type IntegrationEnvironment,
} from "./itest-environment.ts";

/** Set by the integration runner for its child test process only. */
export const REQUIRED_MODE_VARIABLE = "KOLEKTO_ITEST_REQUIRED";

/** Read-only. The row is a singleton; a missing row is a refusal (it would read as "off"). */
export const PAUSE_SWITCH_PROBE_SQL = "select email_sending_enabled from public.notification_sender_state";

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Shape a pause-switch reader returns: how many rows, and the column value. */
export interface PauseSwitchState {
  readonly rowCount: number;
  readonly enabled: unknown;
}

export type IdentityProbe = (db: IntegrationEnvironment["db"]) => Promise<unknown>;
export type PauseSwitchReader = (db: IntegrationEnvironment["db"]) => Promise<unknown>;

export interface IntegrationGateDeps {
  readonly env: EnvSource;
  readonly probeIdentity: IdentityProbe;
  readonly readPauseSwitch: PauseSwitchReader;
  readonly timeoutMs?: number;
}

declare const verifiedBrand: unique symbol;
export type VerifiedIntegrationEnvironment = IntegrationEnvironment & { readonly [verifiedBrand]: true };

export interface IntegrationGate {
  verify(): Promise<VerifiedIntegrationEnvironment>;
  verified(): VerifiedIntegrationEnvironment;
  postflight(): Promise<void>;
}

const issued = new WeakSet<object>();

/**
 * DB endpoints a gate has statically validated and is about to probe. The
 * read-only probe session (itest-db.ts) accepts only these: verification has
 * to connect once before anything is verified, and this keeps that one
 * connection inside the gate's own sequence instead of open to any caller.
 */
const probeTargets = new WeakSet<object>();

export function isVerifiedEnvironment(value: unknown): value is VerifiedIntegrationEnvironment {
  return typeof value === "object" && value !== null && issued.has(value);
}

export function assertVerifiedEnvironment(value: unknown): asserts value is VerifiedIntegrationEnvironment {
  if (!isVerifiedEnvironment(value)) {
    throw refuse("NOT_VERIFIED", "This environment was not issued by a successful gate.verify(); integration code may not use it.");
  }
}

export function assertProbeTarget(value: unknown): asserts value is IntegrationEnvironment["db"] {
  if (typeof value !== "object" || value === null || !probeTargets.has(value)) {
    throw refuse("PROBE_TARGET_UNISSUED", "This database endpoint was not validated by a gate; the read-only probe will not connect to it.");
  }
}

/**
 * Fails closed on anything but exactly one row whose value is the boolean
 * `false`. A switch found ON is reported, never corrected.
 */
export function checkPauseSwitch(state: unknown, phase: "before" | "after"): void {
  if (typeof state !== "object" || state === null || typeof (state as PauseSwitchState).rowCount !== "number") {
    throw refuse("PAUSE_SWITCH_INCONCLUSIVE", `The pause-switch read ${phase} the file returned an unexpected shape.`);
  }
  const { rowCount, enabled } = state as PauseSwitchState;
  if (rowCount === 0) {
    throw refuse("PAUSE_SWITCH_ROW_MISSING", `The notification_sender_state row is missing ${phase} the file; a missing row reads as "off" and cannot be trusted.`);
  }
  if (rowCount !== 1) {
    throw refuse("PAUSE_SWITCH_INCONCLUSIVE", `The pause-switch read ${phase} the file returned ${rowCount} rows, expected exactly 1.`);
  }
  if (enabled === true) {
    throw refuse("PAUSE_SWITCH_ON", `Email sending is ENABLED ${phase} the file. The harness never changes the switch; stop and investigate who enabled it.`);
  }
  if (enabled !== false) {
    throw refuse("PAUSE_SWITCH_INCONCLUSIVE", `The pause switch ${phase} the file is not a boolean false.`);
  }
}

/** Safe diagnostic tags only: a SQLSTATE (28P01) or a Node errno (ECONNREFUSED). */
function safeErrorTag(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z]{2,20})$/.test(code) ? ` (code ${code})` : "";
}

class Timeout extends Error {}

async function bounded<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(
  run: () => Promise<unknown>,
  ms: number,
  code: "IDENTITY_PROBE_FAILED" | "PAUSE_SWITCH_READ_FAILED",
  what: string,
): Promise<unknown> {
  try {
    return await bounded(run, ms);
  } catch (error) {
    if (error instanceof IntegrationGateError) throw error;
    const reason = error instanceof Timeout ? `timed out after ${ms} ms` : `failed${safeErrorTag(error)}`;
    // The underlying error is deliberately dropped: driver errors can embed the connection string.
    throw refuse(code, `${what} ${reason}. Details withheld.`);
  }
}

type GateState =
  | { readonly kind: "pending" }
  | { readonly kind: "verified"; readonly env: VerifiedIntegrationEnvironment }
  | { readonly kind: "refused"; readonly error: IntegrationGateError };

export function createIntegrationGate(deps: IntegrationGateDeps): IntegrationGate {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let state: GateState = { kind: "pending" };
  let inFlight: Promise<VerifiedIntegrationEnvironment> | null = null;

  async function run(): Promise<VerifiedIntegrationEnvironment> {
    if (deps.env[REQUIRED_MODE_VARIABLE] !== "1") {
      throw refuse("NOT_REQUIRED_MODE", `${REQUIRED_MODE_VARIABLE} is not 1. Integration tests run only through \`npm run test:integration\`.`);
    }
    const config = parseIntegrationEnvironment(deps.env);
    probeTargets.add(config.db);
    const facts = await readBounded(() => deps.probeIdentity(config.db), timeoutMs, "IDENTITY_PROBE_FAILED", "The identity probe");
    verifyLiveIdentity(config, facts);
    const before = await readBounded(() => deps.readPauseSwitch(config.db), timeoutMs, "PAUSE_SWITCH_READ_FAILED", "The pause-switch read before the file");
    checkPauseSwitch(before, "before");
    issued.add(config);
    return config as VerifiedIntegrationEnvironment;
  }

  function verified(): VerifiedIntegrationEnvironment {
    if (state.kind === "verified") return state.env;
    throw refuse(
      "NOT_VERIFIED",
      state.kind === "refused"
        ? "The gate refused this environment; no integration test may run."
        : "gate.verify() has not completed successfully; no integration test may run.",
    );
  }

  return {
    verify() {
      if (state.kind === "verified") return Promise.resolve(state.env);
      if (state.kind === "refused") return Promise.reject(state.error);
      inFlight ??= run().then(
        (env) => {
          state = { kind: "verified", env };
          return env;
        },
        (error: unknown) => {
          const refusal = error instanceof IntegrationGateError
            ? error
            : refuse("IDENTITY_INCONCLUSIVE", "Verification failed with an unexpected error. Details withheld.");
          state = { kind: "refused", error: refusal };
          throw refusal;
        },
      );
      return inFlight;
    },

    verified,

    async postflight() {
      const env = verified();
      const after = await readBounded(() => deps.readPauseSwitch(env.db), timeoutMs, "PAUSE_SWITCH_READ_FAILED", "The pause-switch read after the file");
      checkPauseSwitch(after, "after");
    },
  };
}

// ── Lexical guards (used by the runner and by unit tests) ─────────────────────

/** Every file under test/integration/ must visibly go through the gate. */
const GATE_USAGE = [
  /from\s+["'](?:\.\.\/)+support\/itest-gate\.ts["']/,
  /\bcreateIntegrationGate\s*\(/,
  /\.verify\s*\(\s*\)/,
  /\.postflight\s*\(\s*\)/,
];

export function usesIntegrationGate(source: string): boolean {
  return GATE_USAGE.every((pattern) => pattern.test(source));
}

/**
 * Connection rules for files under test/integration/ (Phase 1b). Every
 * database connection goes through connectVerified(gate.verified(), …), the
 * gate is wired with the real read-only probes, and nothing reads an ambient
 * endpoint or skips. Returns the labels of every rule a source breaks.
 */
const CONNECTION_RULES: readonly { readonly label: string; readonly bad: RegExp }[] = [
  { label: "imports a database driver as a value (use connectVerified)", bad: /^\s*import\s+(?!type\b)[^;]*?from\s+["'](?:postgres|pg)["']/m },
  { label: "calls the database driver directly (use connectVerified)", bad: /\b(?:postgres|pg\.Client|pg\.Pool|new\s+Client|new\s+Pool)\s*\(\s*[A-Za-z_$"'`{[]/ },
  { label: "reads process.env (endpoints come only from gate.verified())", bad: /\bprocess\s*\.\s*env\b/ },
  { label: "names a developer endpoint variable", bad: /\b(?:SUPABASE_DB_URL|DATABASE_URL|KOLEKTO_WORKER_INTEGRATION|MAILPIT_API|EMAIL_SMTP_[A-Z_]+)\b/ },
  { label: "names a developer-stack port", bad: /\b543[2][0-9]\b/ },
  { label: "skips or marks tests todo", bad: /\b(?:skip|todo)\s*:|\.(?:skip|todo)\s*\(/ },
];
const REQUIRED_WIRING: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "does not import support/itest-db.ts", pattern: /from\s+["'](?:\.\.\/)+support\/itest-db\.ts["']/ },
  { label: "does not wire the gate with liveGateDeps()", pattern: /\bcreateIntegrationGate\s*\(\s*liveGateDeps\s*\(\s*\)\s*\)/ },
];

export function findUnsafeConnectionPatterns(source: string): string[] {
  return [
    ...CONNECTION_RULES.filter((r) => r.bad.test(source)).map((r) => r.label),
    ...REQUIRED_WIRING.filter((r) => !r.pattern.test(source)).map((r) => r.label),
  ];
}

/** Anything that could turn the pause switch on. Matched case-insensitively. */
const SWITCH_WRITES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "switch setter call", pattern: /set_?email_?sending_?enabled/i },
  { label: "switch assigned true", pattern: /email_sending_enabled\s*:?=\s*true/i },
  { label: "sender-state update", pattern: /update\s+(?:"?public"?\s*\.\s*)?"?notification_sender_state/i },
  { label: "sender-state insert", pattern: /insert\s+into\s+(?:"?public"?\s*\.\s*)?"?notification_sender_state/i },
];

export function findForbiddenSwitchWrites(source: string): string[] {
  return SWITCH_WRITES.filter((w) => w.pattern.test(source)).map((w) => w.label);
}
