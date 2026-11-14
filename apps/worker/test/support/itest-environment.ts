/**
 * itest-environment.ts — identity of the dedicated local integration-test stack (M13.2 Phase 1a).
 *
 * Pure: no I/O, no database, no SMTP, no Mailpit. Everything here validates
 * values it is handed, so every rule is unit-testable with plain objects.
 *
 * The integration lane may only ever talk to the `kolekto-itest` Supabase stack
 * (its own work directory `supabase-itest/`, its own Postgres and its own
 * Mailpit, ports 55420–55429). Identity is established in depth — no single
 * check is trusted on its own (approval checklist §7, review §4.1):
 *
 *   1. Credentials. The URL must log in as `kolekto_itest`, a role that exists
 *      only on the test stack, with a non-default password. A URL pointed at the
 *      developer stack fails authentication instead of connecting.
 *   2. Variables. Only `KOLEKTO_ITEST_*` variables are read, with no defaults
 *      and no fallback to `SUPABASE_DB_URL`, `EMAIL_SMTP_*` or `MAILPIT_API`.
 *   3. Endpoints. DB, SMTP and Mailpit API are all literal loopback, all inside
 *      the test port range, all distinct, none in the developer range.
 *   4. Live identity (checked on the connection the tests use, by the gate):
 *      `current_user` / `session_user` = the test role (never a built-in
 *      role), `current_database()` = the configured database, the probe ran in
 *      a read-only transaction, and two database-level settings the bootstrap
 *      writes: `kolekto.itest_stack` = `KOLEKTO_ITEST_STACK_ID` (a random UUID
 *      also stored in the git-ignored `.env.itest`) and
 *      `kolekto.itest_db_host_port` = the port in the URL. The old boolean
 *      `kolekto.itest = 'on'` marker is not used.
 *
 *      Port semantics (Phase 1b): `inet_server_port()` is the port the server
 *      accepted the connection on. Inside the Supabase Postgres container that
 *      is the container port 5432, not the published host port (verified:
 *      the developer container maps 5432/tcp to host 54322). It therefore
 *      cannot tell the developer stack from the test stack and is only checked
 *      as "a TCP connection to the container port". The host port the client
 *      dialled is matched against the value the bootstrap stored in the test
 *      database instead.
 *
 * Anything missing, malformed, inconsistent or inconclusive is a refusal.
 * Refusal messages name the variable or condition, never a value: passwords,
 * URLs and the stack ID are never echoed.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Login role that exists only on the test stack (created by its bootstrap). */
export const ITEST_DB_ROLE = "kolekto_itest";

/** Database-level setting holding the per-bootstrap stack identity token. */
export const ITEST_STACK_SETTING = "kolekto.itest_stack";

/** Database-level setting holding the host port the bootstrap published the test database on. */
export const ITEST_HOST_PORT_SETTING = "kolekto.itest_db_host_port";

/**
 * The port Postgres listens on inside the Supabase container, which is what
 * `inet_server_port()` reports for a connection through a published port.
 * [U for the test stack until Phase 3; a different value is a refusal.]
 */
export const ITEST_CONTAINER_DB_PORT = 5432;

/** Every test-stack endpoint lives here. */
export const ITEST_PORT_RANGE = { min: 55420, max: 55429 } as const;

/** The developer stack (`supabase/config.toml`). Never reachable from the lane. */
export const DEV_PORT_RANGE = { min: 54320, max: 54329 } as const;
export const DEV_DB_PORT = 54322;
export const DEV_MAILPIT_API_PORT = 54324;
export const DEV_MAILPIT_SMTP_PORT = 54325;

/** The test stack's Mailpit SMTP listener is always the loopback literal. */
export const ITEST_SMTP_HOST = "127.0.0.1";

/** The only variables the lane reads. */
export const ITEST_ENV = {
  dbUrl: "KOLEKTO_ITEST_DB_URL",
  smtpPort: "KOLEKTO_ITEST_SMTP_PORT",
  mailpitApi: "KOLEKTO_ITEST_MAILPIT_API",
  stackId: "KOLEKTO_ITEST_STACK_ID",
} as const;

/**
 * One read-only statement, run by the gate's probe (itest-probes.ts) inside a
 * read-only transaction on a dedicated, single-use connection.
 */
export const IDENTITY_PROBE_SQL =
  `select current_user::text as role_name, session_user::text as session_role_name, ` +
  `current_database()::text as database_name, inet_server_port() as server_port, ` +
  `current_setting('${ITEST_STACK_SETTING}', true) as stack_id, ` +
  `current_setting('${ITEST_HOST_PORT_SETTING}', true) as declared_host_port, ` +
  `current_setting('transaction_read_only') as transaction_read_only`;

/** Literal loopback only. `localhost` is refused: it resolves through the hosts file. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]"]);

/** Hosted Supabase (staging and production live here). */
const REMOTE_SUPABASE_SUFFIXES = [".supabase.co", ".supabase.com", ".supabase.net", ".supabase.in"];

/** Roles of a stock Supabase stack: their presence means "not the test role". */
const DEVELOPER_ROLES: ReadonlySet<string> = new Set(["postgres", "supabase_admin", "authenticator", "service_role", "anon", "authenticated"]);

/** Any role Postgres or Supabase ships with: stock roles plus the `pg_*` and `supabase*` families. */
export function isBuiltInRole(role: string): boolean {
  const name = role.toLowerCase();
  return DEVELOPER_ROLES.has(name) || name.startsWith("pg_") || name.startsWith("supabase");
}

/**
 * Ambient libpq variables that could redirect or re-identify a connection.
 * postgres.js also falls back to `PG<OPTION>` variables (PGPASSWORD, PGSSL,
 * PGAPPNAME, PGTARGETSESSIONATTRS, …), so every `PG*` variable is refused.
 */
export const AMBIENT_PG_VARIABLES = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGSERVICE", "PGOPTIONS"] as const;
const AMBIENT_PG_PREFIX = /^PG[A-Z0-9_]+$/i;

/** Developer-stack variables the lane never reads, but compares against so a copied value is refused. */
const DEVELOPER_DB_URL_VARIABLES = ["SUPABASE_DB_URL", "DATABASE_URL"] as const;

const MIN_PASSWORD_LENGTH = 16;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PG_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const PORT_TEXT = /^[1-9][0-9]{0,4}$/;

// ── Errors and secrets ────────────────────────────────────────────────────────

export type GateViolationCode =
  | "ENV_MISSING"
  | "ENV_MALFORMED"
  | "AMBIENT_PG_OVERRIDE"
  | "NOT_REQUIRED_MODE"
  | "DB_URL_INVALID"
  | "DB_HOST_REMOTE"
  | "DB_HOST_NOT_LOOPBACK"
  | "DB_PORT_DEVELOPER"
  | "DB_PORT_OUTSIDE_TEST_RANGE"
  | "DB_DEVELOPER_CREDENTIALS"
  | "DB_MATCHES_DEVELOPER"
  | "DB_ROLE_NOT_TEST_ROLE"
  | "DB_PASSWORD_WEAK"
  | "DB_NAME_INVALID"
  | "MAILPIT_URL_INVALID"
  | "MAILPIT_HOST_NOT_LOOPBACK"
  | "MAILPIT_DEVELOPER"
  | "MAILPIT_PORT_OUTSIDE_TEST_RANGE"
  | "SMTP_DEVELOPER"
  | "SMTP_PORT_OUTSIDE_TEST_RANGE"
  | "PORTS_NOT_DISTINCT"
  | "STACK_ID_INVALID"
  | "IDENTITY_PROBE_FAILED"
  | "IDENTITY_INCONCLUSIVE"
  | "IDENTITY_ROLE_MISMATCH"
  | "IDENTITY_BUILTIN_ROLE"
  | "IDENTITY_DATABASE_MISMATCH"
  | "IDENTITY_PORT_MISMATCH"
  | "IDENTITY_PORT_UNDECLARED"
  | "IDENTITY_SERVER_PORT_UNEXPECTED"
  | "IDENTITY_NOT_READ_ONLY"
  | "IDENTITY_STACK_MISSING"
  | "IDENTITY_STACK_MISMATCH"
  | "PAUSE_SWITCH_READ_FAILED"
  | "PAUSE_SWITCH_ROW_MISSING"
  | "PAUSE_SWITCH_INCONCLUSIVE"
  | "PAUSE_SWITCH_ON"
  | "NOT_VERIFIED"
  | "PROBE_TARGET_UNISSUED"
  | "PROBE_STATEMENT_REFUSED"
  | "CONNECTION_OPTIONS_INVALID"
  | "NO_INTEGRATION_FILES"
  | "INTEGRATION_FILE_MISSING"
  | "INTEGRATION_FILE_UNLISTED"
  | "FILE_NOT_GATED"
  | "FILE_UNSAFE_CONNECTION"
  | "FORBIDDEN_SWITCH_WRITE"
  | "RUN_FAILED"
  | "RUN_INCONCLUSIVE"
  | "RUN_EMPTY"
  | "RUN_SKIPPED_TESTS"
  // Phase 1c: .env.itest loading (itest-env-file.ts)
  | "ITEST_ENV_AMBIENT"
  | "ENV_FILE_MISSING"
  | "ENV_FILE_UNREADABLE"
  | "ENV_FILE_INVALID"
  // Phase 1c: run-unique fixtures (itest-fixtures.ts) and quarantine SQL (itest-quarantine.ts)
  | "FIXTURE_INPUT_INVALID"
  | "FIXTURE_ID_COLLISION"
  | "FIXTURE_ID_RESERVED"
  | "QUARANTINE_INPUT_INVALID"
  // Phase 1c: Mailpit exact matching (itest-mailpit.ts)
  | "MAILPIT_EXPECTATION_INVALID"
  | "MAILPIT_RESPONSE_INVALID"
  | "MAILPIT_NO_MATCH"
  | "MAILPIT_AMBIGUOUS"
  | "MAILPIT_UNEXPECTED_MESSAGE"
  | "MAILPIT_CONTENT_MISMATCH"
  // Phase 1c: bounded polling and the suite mutex (itest-mutex.ts)
  | "POLL_OPTIONS_INVALID"
  | "POLL_TIMEOUT"
  | "POLL_FAILED"
  | "POLL_INCONCLUSIVE"
  | "MUTEX_TIMEOUT"
  | "MUTEX_FAILED"
  | "MUTEX_INCONCLUSIVE"
  | "MUTEX_LOST"
  // Phase 4: rollback helpers, preflight and isolation (itest-isolation.ts)
  | "ROLLBACK_HANDLE_UNISSUED"
  | "LEDGER_FILLER_INVALID"
  | "PREFLIGHT_OPEN_DELIVERIES"
  | "PREFLIGHT_LIVE_WORKER"
  | "PREFLIGHT_QUEUE_CONSUMED"
  | "PREFLIGHT_L4_HEADROOM"
  | "PREFLIGHT_INCONCLUSIVE"
  | "ISOLATION_FOREIGN_ROWS"
  | "L5_HEADROOM_TIMEOUT"
  | "QUARANTINE_FAILED"
  | "QUARANTINE_RESIDUE"
  // Phase 4: explicit SMTP lane mode (itest-lane.ts)
  | "SMTP_MODE_REQUIRED"
  | "LANE_ARGUMENT_INVALID"
  | "FILE_SMTP_UNDECLARED"
  // Phase 6A: notification-queue isolation and own-message archive (itest-queue.ts)
  | "PREFLIGHT_QUEUE_NOT_EMPTY"
  | "ISOLATION_FOREIGN_QUEUE"
  | "QUEUE_RESIDUE"
  | "QUEUE_OWNER_INVALID"
  | "QUEUE_MESSAGE_NOT_OWNED"
  | "QUEUE_MESSAGE_TIMEOUT"
  | "QUEUE_MESSAGE_AMBIGUOUS"
  | "QUEUE_ARCHIVE_FAILED"
  | "QUEUE_RECOVERY_FAILED"
  // Phase 7: the real worker process, its role, the pause-switch experiment and the fault proxy
  | "WORKER_BUILD_FAILED"
  | "WORKER_ROLE_INVALID"
  | "EVIDENCE_SEALED"
  | "WORKER_TARGET_UNPROVEN"
  | "WORKER_LOG_SENSITIVE"
  | "WORKER_TIMEOUT"
  | "WORKER_ENV_INVALID"
  | "LEDGER_PURGE_ELIGIBLE"
  | "QUEUE_SEED_NOT_OWNED"
  | "SWITCH_WRITE_REFUSED"
  | "SWITCH_RESTORE_FAILED";

export interface GateViolation {
  readonly code: GateViolationCode;
  readonly message: string;
}

/**
 * The only error the lane throws for a safety refusal. Built from fixed text
 * only; it never carries a `cause`, because underlying errors (URL parsing,
 * driver errors) can embed the connection string.
 */
export class IntegrationGateError extends Error {
  readonly violations: readonly GateViolation[];

  constructor(violations: readonly GateViolation[]) {
    const lines = violations.map((v) => `  - [${v.code}] ${v.message}`);
    super(`Integration gate refused: ${violations.length} safety condition(s) failed.\n${lines.join("\n")}`);
    this.name = "IntegrationGateError";
    this.violations = Object.freeze([...violations]);
  }

  has(code: GateViolationCode): boolean {
    return this.violations.some((v) => v.code === code);
  }
}

export function refuse(code: GateViolationCode, message: string): IntegrationGateError {
  return new IntegrationGateError([{ code, message }]);
}

const REDACTED = "[redacted]";

/** A value that must never be printed. `reveal()` is the only way out. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

// ── Validated configuration ───────────────────────────────────────────────────

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface IntegrationEnvironment {
  readonly db: {
    readonly url: Secret;
    /** Decoded password. Connections are built from these fields, never from the URL string. */
    readonly password: Secret;
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly role: string;
  };
  readonly smtp: { readonly host: string; readonly port: number };
  readonly mailpitApi: { readonly origin: string; readonly port: number };
  readonly stackId: Secret;
}

type HostClass = "loopback" | "remote_supabase" | "other";

function classifyHost(hostname: string): HostClass {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return "loopback";
  if (REMOTE_SUPABASE_SUFFIXES.some((s) => host.endsWith(s))) return "remote_supabase";
  return "other";
}

function inRange(port: number, range: { readonly min: number; readonly max: number }): boolean {
  return port >= range.min && port <= range.max;
}

function parsePortText(text: string): number | null {
  if (!PORT_TEXT.test(text)) return null;
  const port = Number(text);
  return port <= 65535 ? port : null;
}

function decode(component: string): string | null {
  try {
    return decodeURIComponent(component);
  } catch {
    return null;
  }
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null; // the TypeError carries the input; never rethrow or chain it
  }
}

function readVariable(env: EnvSource, name: string, out: GateViolation[]): string | null {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    out.push({ code: "ENV_MISSING", message: `${name} is not set. The integration lane has no defaults.` });
    return null;
  }
  if (raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    out.push({ code: "ENV_MALFORMED", message: `${name} contains surrounding whitespace or control characters.` });
    return null;
  }
  return raw;
}

function parseDbUrl(raw: string, out: GateViolation[]): IntegrationEnvironment["db"] | null {
  const name = ITEST_ENV.dbUrl;
  const url = parseUrl(raw);
  if (url === null) {
    out.push({ code: "DB_URL_INVALID", message: `${name} is not a valid URL.` });
    return null;
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    out.push({ code: "DB_URL_INVALID", message: `${name} must use the postgresql:// scheme.` });
    return null;
  }
  // The raw check also catches a bare '?' or '#', which URL reports as an empty search/hash.
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    out.push({ code: "DB_URL_INVALID", message: `${name} must not carry query parameters or a fragment (they can override host, port or user).` });
    return null;
  }

  const before = out.length;
  const hostClass = classifyHost(url.hostname);
  if (hostClass === "remote_supabase") {
    out.push({ code: "DB_HOST_REMOTE", message: `${name} points at a hosted Supabase project. Staging and production are never allowed.` });
  } else if (hostClass === "other") {
    out.push({ code: "DB_HOST_NOT_LOOPBACK", message: `${name} host is not literal loopback (127.0.0.1 or [::1]). Remote, staging and production hosts are refused; 'localhost' is refused because it is resolved, not literal.` });
  }

  const port = url.port === "" ? null : parsePortText(url.port);
  if (port === null) {
    out.push({ code: "DB_URL_INVALID", message: `${name} must state an explicit, valid port.` });
  } else if (inRange(port, DEV_PORT_RANGE)) {
    out.push({ code: "DB_PORT_DEVELOPER", message: `${name} uses a developer-stack port (${DEV_PORT_RANGE.min}-${DEV_PORT_RANGE.max}). The developer database is never a test target.` });
  } else if (!inRange(port, ITEST_PORT_RANGE)) {
    out.push({ code: "DB_PORT_OUTSIDE_TEST_RANGE", message: `${name} port ${port} is outside the test-stack range ${ITEST_PORT_RANGE.min}-${ITEST_PORT_RANGE.max}.` });
  }

  const role = decode(url.username);
  const password = decode(url.password);
  if (role === null || password === null) {
    out.push({ code: "DB_URL_INVALID", message: `${name} has malformed percent-encoding in its credentials.` });
  } else {
    if (role !== ITEST_DB_ROLE) {
      out.push(
        isBuiltInRole(role) || role === ""
          ? { code: "DB_DEVELOPER_CREDENTIALS", message: `${name} does not log in as ${ITEST_DB_ROLE}; it uses a stock Supabase role, which is what the developer database accepts.` }
          : { code: "DB_ROLE_NOT_TEST_ROLE", message: `${name} must log in as ${ITEST_DB_ROLE}.` },
      );
    }
    if (password === "postgres") {
      out.push({ code: "DB_DEVELOPER_CREDENTIALS", message: `${name} uses the developer default password.` });
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      out.push({ code: "DB_PASSWORD_WEAK", message: `${name} password is missing or shorter than ${MIN_PASSWORD_LENGTH} characters; the test-stack bootstrap generates a random one.` });
    }
  }

  const database = url.pathname.startsWith("/") ? url.pathname.slice(1) : "";
  if (!PG_IDENTIFIER.test(database)) {
    out.push({ code: "DB_NAME_INVALID", message: `${name} must name exactly one database as a plain identifier.` });
  }

  if (out.length !== before || port === null || role === null || password === null) return null;
  return Object.freeze({ url: new Secret(raw), password: new Secret(password), host: url.hostname, port, database, role });
}

/**
 * Refuses a test configuration that reuses a developer endpoint or password
 * found in SUPABASE_DB_URL / DATABASE_URL (approval checklist §7.3: "refuse if
 * any value equals its developer counterpart"). The developer values are read
 * only to compare; they are never used, stored or echoed. An unparsable
 * developer value is ignored here (it is not a connection target).
 */
function checkDeveloperCounterparts(
  env: EnvSource,
  { db, smtp, mailpitApi }: Pick<IntegrationEnvironment, "db" | "smtp" | "mailpitApi">,
  out: GateViolation[],
): void {
  for (const name of DEVELOPER_DB_URL_VARIABLES) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const dev = parseUrl(raw);
    if (dev === null) continue;
    const devPassword = decode(dev.password);
    const sameEndpoint = dev.hostname.toLowerCase() === db.host.toLowerCase() && dev.port === String(db.port);
    const samePassword = devPassword !== null && devPassword !== "" && devPassword === db.password.reveal();
    if (sameEndpoint || samePassword) {
      out.push({ code: "DB_MATCHES_DEVELOPER", message: `${ITEST_ENV.dbUrl} reuses the ${sameEndpoint ? "host and port" : "password"} of ${name}. The developer database is never a test target.` });
    }
  }
  const devMailpit = env["MAILPIT_API"] ? parseUrl(env["MAILPIT_API"]) : null;
  if (devMailpit !== null && devMailpit.port === String(mailpitApi.port)) {
    out.push({ code: "MAILPIT_DEVELOPER", message: `${ITEST_ENV.mailpitApi} uses the same port as MAILPIT_API.` });
  }
  if (env["EMAIL_SMTP_PORT"] !== undefined && env["EMAIL_SMTP_PORT"].trim() === String(smtp.port)) {
    out.push({ code: "SMTP_DEVELOPER", message: `${ITEST_ENV.smtpPort} equals EMAIL_SMTP_PORT.` });
  }
}

function parseMailpitApi(raw: string, out: GateViolation[]): IntegrationEnvironment["mailpitApi"] | null {
  const name = ITEST_ENV.mailpitApi;
  const url = parseUrl(raw);
  if (url === null || url.protocol !== "http:") {
    out.push({ code: "MAILPIT_URL_INVALID", message: `${name} must be an http:// URL.` });
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) {
    out.push({ code: "MAILPIT_URL_INVALID", message: `${name} must be a bare origin (no credentials, path, query or fragment).` });
    return null;
  }
  const before = out.length;
  if (classifyHost(url.hostname) !== "loopback") {
    out.push({ code: "MAILPIT_HOST_NOT_LOOPBACK", message: `${name} host is not literal loopback (127.0.0.1 or [::1]).` });
  }
  const port = url.port === "" ? null : parsePortText(url.port);
  if (port === null) {
    out.push({ code: "MAILPIT_URL_INVALID", message: `${name} must state an explicit, valid port.` });
  } else if (port === DEV_MAILPIT_API_PORT || inRange(port, DEV_PORT_RANGE)) {
    out.push({ code: "MAILPIT_DEVELOPER", message: `${name} points at the developer Mailpit (developer-stack port range). Test mail never goes to the developer inbox.` });
  } else if (!inRange(port, ITEST_PORT_RANGE)) {
    out.push({ code: "MAILPIT_PORT_OUTSIDE_TEST_RANGE", message: `${name} port ${port} is outside the test-stack range ${ITEST_PORT_RANGE.min}-${ITEST_PORT_RANGE.max}.` });
  }
  if (out.length !== before || port === null) return null;
  return Object.freeze({ origin: url.origin, port });
}

function parseSmtpPort(raw: string, out: GateViolation[]): IntegrationEnvironment["smtp"] | null {
  const name = ITEST_ENV.smtpPort;
  const port = parsePortText(raw);
  if (port === null) {
    out.push({ code: "ENV_MALFORMED", message: `${name} is not a valid port number.` });
    return null;
  }
  if (port === DEV_MAILPIT_SMTP_PORT || inRange(port, DEV_PORT_RANGE)) {
    out.push({ code: "SMTP_DEVELOPER", message: `${name} points at the developer Mailpit SMTP listener (developer-stack port range).` });
    return null;
  }
  if (!inRange(port, ITEST_PORT_RANGE)) {
    out.push({ code: "SMTP_PORT_OUTSIDE_TEST_RANGE", message: `${name} ${port} is outside the test-stack range ${ITEST_PORT_RANGE.min}-${ITEST_PORT_RANGE.max}.` });
    return null;
  }
  return Object.freeze({ host: ITEST_SMTP_HOST, port });
}

/**
 * Static validation of the lane's environment. No I/O. Collects every
 * violation and throws one IntegrationGateError; returns only a fully
 * consistent configuration.
 */
export function parseIntegrationEnvironment(env: EnvSource): IntegrationEnvironment {
  const out: GateViolation[] = [];

  // AMBIENT_PG_VARIABLES is a subset of the prefix rule; names are listed, values never.
  const ambient = Object.keys(env).filter((k) => AMBIENT_PG_PREFIX.test(k) && env[k] !== undefined && env[k] !== "");
  if (ambient.length > 0) {
    out.push({ code: "AMBIENT_PG_OVERRIDE", message: `Ambient libpq variables are set (${ambient.join(", ")}); unset them so the connection is defined only by ${ITEST_ENV.dbUrl}.` });
  }

  const dbRaw = readVariable(env, ITEST_ENV.dbUrl, out);
  const smtpRaw = readVariable(env, ITEST_ENV.smtpPort, out);
  const mailpitRaw = readVariable(env, ITEST_ENV.mailpitApi, out);
  const stackRaw = readVariable(env, ITEST_ENV.stackId, out);

  const db = dbRaw === null ? null : parseDbUrl(dbRaw, out);
  const smtp = smtpRaw === null ? null : parseSmtpPort(smtpRaw, out);
  const mailpitApi = mailpitRaw === null ? null : parseMailpitApi(mailpitRaw, out);

  let stackId: Secret | null = null;
  if (stackRaw !== null) {
    if (UUID_V4.test(stackRaw)) stackId = new Secret(stackRaw);
    else out.push({ code: "STACK_ID_INVALID", message: `${ITEST_ENV.stackId} is not a lowercase random (version 4) UUID.` });
  }

  if (db !== null && smtp !== null && mailpitApi !== null) {
    const ports = [db.port, smtp.port, mailpitApi.port];
    if (new Set(ports).size !== ports.length) {
      out.push({ code: "PORTS_NOT_DISTINCT", message: "The DB, SMTP and Mailpit API ports must be three distinct test-stack ports." });
    }
    checkDeveloperCounterparts(env, { db, smtp, mailpitApi }, out);
  }

  if (out.length > 0 || db === null || smtp === null || mailpitApi === null || stackId === null) {
    throw new IntegrationGateError(out);
  }
  return Object.freeze({ db, smtp, mailpitApi, stackId });
}

// ── Live identity ─────────────────────────────────────────────────────────────

/** What the identity probe returns, after shape validation. */
export interface IdentityFacts {
  readonly rowCount: number;
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly currentDatabase: string;
  /** `inet_server_port()`: the container-side port, not the host port the client dialled. */
  readonly serverPort: number | null;
  readonly stackId: string | null;
  /** `current_setting('kolekto.itest_db_host_port', true)`: the host port the bootstrap recorded. */
  readonly declaredHostPort: string | null;
  /** `current_setting('transaction_read_only')`: proves the probe ran read-only. */
  readonly transactionReadOnly: string;
}

function isIdentityFacts(value: unknown): value is IdentityFacts {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["rowCount"] === "number" &&
    typeof v["currentUser"] === "string" &&
    typeof v["sessionUser"] === "string" &&
    typeof v["currentDatabase"] === "string" &&
    (v["serverPort"] === null || typeof v["serverPort"] === "number") &&
    (v["stackId"] === null || typeof v["stackId"] === "string") &&
    (v["declaredHostPort"] === null || typeof v["declaredHostPort"] === "string") &&
    typeof v["transactionReadOnly"] === "string"
  );
}

/**
 * Compares what the live connection reports with the validated configuration.
 * Unknown shapes, row counts other than one and nulls are inconclusive, which
 * is a refusal. Values are never echoed.
 */
export function verifyLiveIdentity(config: IntegrationEnvironment, facts: unknown): void {
  if (!isIdentityFacts(facts) || facts.rowCount !== 1) {
    throw refuse("IDENTITY_INCONCLUSIVE", "The identity probe did not return exactly one well-formed row.");
  }
  const out: GateViolation[] = [];
  for (const [label, user] of [["current_user", facts.currentUser], ["session_user", facts.sessionUser]] as const) {
    if (user !== ITEST_DB_ROLE) {
      out.push({
        code: "IDENTITY_ROLE_MISMATCH",
        message: DEVELOPER_ROLES.has(user)
          ? `${label} is a stock Supabase role, not ${ITEST_DB_ROLE}: this looks like the developer database.`
          : `${label} is not ${ITEST_DB_ROLE}.`,
      });
    }
    if (isBuiltInRole(user)) {
      out.push({ code: "IDENTITY_BUILTIN_ROLE", message: `${label} is a built-in Postgres/Supabase role. Integration tests never run as one.` });
    }
  }
  if (facts.currentDatabase !== config.db.database) {
    out.push({ code: "IDENTITY_DATABASE_MISMATCH", message: "current_database() differs from the database named in the URL." });
  }
  if (facts.serverPort === null) {
    out.push({ code: "IDENTITY_INCONCLUSIVE", message: "inet_server_port() returned null (not a TCP connection?)." });
  } else if (facts.serverPort !== ITEST_CONTAINER_DB_PORT) {
    out.push({ code: "IDENTITY_SERVER_PORT_UNEXPECTED", message: `inet_server_port() is not the container port ${ITEST_CONTAINER_DB_PORT}: not the expected Supabase container.` });
  }
  if (facts.declaredHostPort === null || facts.declaredHostPort === "") {
    out.push({ code: "IDENTITY_PORT_UNDECLARED", message: `The database carries no ${ITEST_HOST_PORT_SETTING} setting: it was not bootstrapped as the integration-test stack.` });
  } else if (facts.declaredHostPort !== String(config.db.port)) {
    out.push({ code: "IDENTITY_PORT_MISMATCH", message: `${ITEST_HOST_PORT_SETTING} differs from the port in the URL: the URL reaches a database published on another port.` });
  }
  if (facts.transactionReadOnly !== "on") {
    out.push({ code: "IDENTITY_NOT_READ_ONLY", message: "The identity probe did not run in a read-only transaction." });
  }
  if (facts.stackId === null || facts.stackId === "") {
    out.push({ code: "IDENTITY_STACK_MISSING", message: `The database carries no ${ITEST_STACK_SETTING} marker: it is not the integration-test stack (developer database?).` });
  } else if (facts.stackId !== config.stackId.reveal()) {
    out.push({ code: "IDENTITY_STACK_MISMATCH", message: `${ITEST_STACK_SETTING} differs from ${ITEST_ENV.stackId}: another or a stale stack.` });
  }
  if (out.length > 0) throw new IntegrationGateError(out);
}
