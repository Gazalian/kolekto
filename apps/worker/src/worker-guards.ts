/**
 * worker-guards.ts — what must be true before the worker touches a database or a queue message
 * (M13.2 final corrections, findings R-4 and R-1).
 *
 * ── THE ENVIRONMENT GUARD (R-4) ─────────────────────────────────────────────
 * The checks in @kolekto/config used to run only when EMAIL_PROVIDER was set, a refusal only stopped
 * the sender, and they never looked at SUPABASE_DB_URL. So a worker whose web URL said staging and
 * whose database URL pointed somewhere else started normally and processed that queue. Now:
 *
 *   - the guard runs first, whatever the email configuration, before any connection is opened;
 *   - any refusal ends the process with exit code 1;
 *   - SUPABASE_DB_URL is checked against the same expectation as NEXT_PUBLIC_SUPABASE_URL.
 *
 * It fails closed: a value this code cannot positively place is refused. A refusal reports a stable
 * code and at most a variable NAME, never a value. Operators paste secrets into the wrong variable,
 * and a connection string holds a password. So config errors are never printed either, since their
 * messages can quote project refs and values.
 *
 * The URL rules follow what the driver really does (postgres/src/index.js): a comma selects several
 * hosts, an empty host or database falls back to PG* environment variables, and the host is
 * percent-decoded before that comma check. Each of those could make the driver connect somewhere the
 * checked hostname does not say, so each is refused.
 *
 * ── THE PRIVILEGE PREFLIGHT (R-1) ───────────────────────────────────────────
 * pgmq raises read_ct on every read, so a worker that reads while it cannot process would use up a
 * healthy message's attempts. This reads the catalog only and runs before the first pgmq.read: if the
 * role cannot process, the worker exits having read nothing, and a restart loop cannot raise read_ct.
 *
 * Two tiers, because the failures differ. Without what processing needs, healthy messages would be
 * consumed, so the worker refuses. Without DELETE on the queue or INSERT on the archive, the proven
 * F-15 path applies (mark, retry, park: nothing lost, nothing dead-lettered, nothing processed twice),
 * so the worker runs and reports the gap loudly.
 */

import type postgres from "postgres";

import { LEGACY_PROJECT_REFS, type KolektoEnvironment } from "@kolekto/config";

import { safeErrorSummary } from "./worker-safety.ts";

// ── Environment ───────────────────────────────────────────────────────────────

export type EnvironmentRefusalCode =
  | "ENV_MISSING"
  | "ENV_KOLEKTO_ENV_INVALID"
  | "ENV_SUPABASE_URL_MALFORMED"
  | "ENV_SUPABASE_URL_NOT_LOCAL"
  | "ENV_SUPABASE_URL_NOT_HOSTED"
  | "ENV_SUPABASE_URL_PROJECT_MISMATCH"
  | "ENV_EXPECTED_REF_MISSING"
  | "ENV_LEGACY_PROJECT"
  | "ENV_TARGETS_PRODUCTION"
  | "ENV_DB_URL_MALFORMED"
  | "ENV_DB_URL_MULTIPLE_HOSTS"
  | "ENV_DB_URL_NOT_LOCAL"
  | "ENV_DB_URL_PROJECT_UNKNOWN"
  | "ENV_DB_URL_PROJECT_MISMATCH"
  | "ENV_CONFIG_REFUSED"
  | "ENV_EMAIL_REFUSED";

export type EnvironmentCheck =
  | { readonly ok: true; readonly environment: KolektoEnvironment }
  | { readonly ok: false; readonly code: EnvironmentRefusalCode; readonly variable: string | null };

type Env = Readonly<Record<string, string | undefined>>;

const refused = (code: EnvironmentRefusalCode, variable: string | null = null): EnvironmentCheck => ({ ok: false, code, variable });

function setting(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PROJECT_REF = /^[a-z0-9]{20}$/;
const HOSTED_API_HOST = /^([a-z0-9]{20})\.supabase\.(?:co|in)$/;
const HOSTED_DB_HOST = /^db\.([a-z0-9]{20})\.supabase\.(?:co|in)$/;
const POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.(?:com|co|in)$/;
const PLAIN_HOST = /^(?:[a-z0-9.-]+|\[::1\])$/;
/** Connection targets a driver could honour from the query string. None belongs in this URL. */
const REDIRECTING_PARAMS = ["host", "hostaddr", "port", "service", "servicefile", "passfile"];

/** What SUPABASE_DB_URL really addresses. No field holds a password. */
interface DatabaseTarget {
  readonly host: string;
  readonly projectRef: string | null;
}

function parseDatabaseUrl(raw: string): DatabaseTarget | "malformed" | "multiple_hosts" {
  const afterScheme = /^postgres(?:ql)?:\/\/(.*)$/is.exec(raw)?.[1];
  if (afterScheme === undefined) return "malformed";
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  // The driver reads the host from the first @ and the URL parser from the last, so an unescaped @ in a
  // password could give the two different answers. Refused rather than reconciled.
  if (authority.indexOf("@") !== authority.lastIndexOf("@")) return "malformed";
  const hostPart = authority.slice(authority.indexOf("@") + 1);
  if (hostPart.includes(",")) return "multiple_hosts";
  if (hostPart.includes("%")) return "malformed";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "malformed";
  }
  const host = url.hostname.toLowerCase();
  if (host === "" || !PLAIN_HOST.test(host)) return "malformed";
  if (url.username === "" || url.pathname === "" || url.pathname === "/") return "malformed";
  if (url.port !== "" && (Number(url.port) < 1 || Number(url.port) > 65_535)) return "malformed";
  for (const name of url.searchParams.keys()) {
    if (REDIRECTING_PARAMS.includes(name.toLowerCase())) return "malformed";
  }

  const direct = HOSTED_DB_HOST.exec(host)?.[1];
  if (direct !== undefined) return { host, projectRef: direct };
  if (POOLER_HOST.test(host)) {
    // The session pooler carries the project in the user name: <role>.<ref>.
    const ref = decodeUserName(url.username).split(".").pop() ?? "";
    return { host, projectRef: PROJECT_REF.test(ref) ? ref : null };
  }
  return { host, projectRef: null };
}

function decodeUserName(value: string): string {
  try {
    return decodeURIComponent(value).toLowerCase();
  } catch {
    return "";
  }
}

const mentionsLegacyProject = (value: string): boolean => {
  const lower = value.toLowerCase();
  return Object.keys(LEGACY_PROJECT_REFS).some((ref) => lower.includes(ref));
};

/**
 * Every environment rule the worker enforces itself. Pure: reads only its argument, so each refusal is
 * tested without touching process.env or a network.
 *
 *   every environment   all four settings present; neither URL names the legacy estate
 *   local               both URLs are this machine
 *   staging             both URLs name the project in KOLEKTO_EXPECTED_PROJECT_REF, which is required
 *   production          both URLs name one hosted project, and KOLEKTO_EXPECTED_PROJECT_REF and
 *                       KOLEKTO_PRODUCTION_PROJECT_REF, when set, name the same one
 *   not production      neither URL names KOLEKTO_PRODUCTION_PROJECT_REF
 */
export function checkWorkerEnvironment(env: Env): EnvironmentCheck {
  for (const name of ["KOLEKTO_ENV", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_DB_URL"]) {
    if (setting(env, name) === undefined) return refused("ENV_MISSING", name);
  }
  const environment = setting(env, "KOLEKTO_ENV") as string;
  if (environment !== "local" && environment !== "staging" && environment !== "production") return refused("ENV_KOLEKTO_ENV_INVALID", "KOLEKTO_ENV");

  const apiUrl = setting(env, "NEXT_PUBLIC_SUPABASE_URL") as string;
  const dbUrl = setting(env, "SUPABASE_DB_URL") as string;
  if (mentionsLegacyProject(apiUrl)) return refused("ENV_LEGACY_PROJECT", "NEXT_PUBLIC_SUPABASE_URL");
  if (mentionsLegacyProject(dbUrl)) return refused("ENV_LEGACY_PROJECT", "SUPABASE_DB_URL");

  let api: URL;
  try {
    api = new URL(apiUrl);
  } catch {
    return refused("ENV_SUPABASE_URL_MALFORMED", "NEXT_PUBLIC_SUPABASE_URL");
  }
  if (api.protocol !== "https:" && api.protocol !== "http:") return refused("ENV_SUPABASE_URL_MALFORMED", "NEXT_PUBLIC_SUPABASE_URL");

  const db = parseDatabaseUrl(dbUrl);
  if (db === "malformed") return refused("ENV_DB_URL_MALFORMED", "SUPABASE_DB_URL");
  if (db === "multiple_hosts") return refused("ENV_DB_URL_MULTIPLE_HOSTS", "SUPABASE_DB_URL");

  if (environment === "local") {
    if (!LOOPBACK.has(api.hostname)) return refused("ENV_SUPABASE_URL_NOT_LOCAL", "NEXT_PUBLIC_SUPABASE_URL");
    if (!LOOPBACK.has(db.host)) return refused("ENV_DB_URL_NOT_LOCAL", "SUPABASE_DB_URL");
    return { ok: true, environment };
  }

  // Staging and production: exact hosts. A prefix match would accept <ref>.supabase.co.example.com.
  const apiRef = api.protocol === "https:" ? HOSTED_API_HOST.exec(api.hostname)?.[1] : undefined;
  if (apiRef === undefined) return refused("ENV_SUPABASE_URL_NOT_HOSTED", "NEXT_PUBLIC_SUPABASE_URL");
  if (db.projectRef === null) return refused("ENV_DB_URL_PROJECT_UNKNOWN", "SUPABASE_DB_URL");

  const expected = setting(env, "KOLEKTO_EXPECTED_PROJECT_REF");
  const productionRef = setting(env, "KOLEKTO_PRODUCTION_PROJECT_REF");
  if (environment === "staging" && expected === undefined) return refused("ENV_EXPECTED_REF_MISSING", "KOLEKTO_EXPECTED_PROJECT_REF");
  if (environment === "staging" && (apiRef === productionRef || db.projectRef === productionRef)) return refused("ENV_TARGETS_PRODUCTION");
  if (expected !== undefined && apiRef !== expected) return refused("ENV_SUPABASE_URL_PROJECT_MISMATCH", "KOLEKTO_EXPECTED_PROJECT_REF");
  if (environment === "production" && productionRef !== undefined && apiRef !== productionRef) return refused("ENV_SUPABASE_URL_PROJECT_MISMATCH", "KOLEKTO_PRODUCTION_PROJECT_REF");
  // The check the old guards never made: the database URL has to name the same project as the web URL.
  if (db.projectRef !== apiRef) return refused("ENV_DB_URL_PROJECT_MISMATCH", "SUPABASE_DB_URL");
  return { ok: true, environment };
}

/**
 * Runs the guard, then the shared config layer as a backstop, then the email rules that depend on the
 * environment. Returns false when the process must stop. Never logs an error's message or a value.
 *
 * An email error starting "REFUSING TO START" is a wrong-environment refusal (a real provider in local,
 * mailpit in production, a credential in NEXT_PUBLIC_*), so it is fatal like the others. Any other email
 * error is an incomplete or unsupported sender configuration: loadEmailSender reports that and the event
 * stage keeps running, as CFG-SENDER proves. With EMAIL_PROVIDER unset this still runs, for the
 * NEXT_PUBLIC_* rule; its "missing EMAIL_PROVIDER" error is one of the non-fatal kind.
 */
export function enforceWorkerEnvironment(deps: {
  readonly env: Env;
  readonly loadConfig: () => { readonly environment: KolektoEnvironment };
  readonly loadEmailConfig: (environment: KolektoEnvironment) => unknown;
  readonly log: (line: string) => void;
}): boolean {
  const refuse = (check: { readonly code: EnvironmentRefusalCode; readonly variable: string | null }): false => {
    deps.log(JSON.stringify({ msg: "worker_environment_refused", code: check.code, variable: check.variable }));
    return false;
  };
  const check = checkWorkerEnvironment(deps.env);
  if (!check.ok) return refuse(check);

  let environment: KolektoEnvironment;
  try {
    environment = deps.loadConfig().environment;
  } catch {
    return refuse({ code: "ENV_CONFIG_REFUSED", variable: null });
  }
  try {
    deps.loadEmailConfig(environment);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("REFUSING TO START")) return refuse({ code: "ENV_EMAIL_REFUSED", variable: null });
  }
  return true;
}

// ── Privileges ────────────────────────────────────────────────────────────────

export type PrivilegeCheck =
  | { readonly kind: "schema"; readonly schema: string }
  | { readonly kind: "table"; readonly table: string; readonly privilege: "SELECT" | "INSERT" | "DELETE" }
  | { readonly kind: "column"; readonly table: string; readonly column: string; readonly privilege: "SELECT" | "UPDATE" }
  /** A signature fixed by this codebase's migrations. */
  | { readonly kind: "function"; readonly signature: string }
  /** pgmq's own functions, whose argument lists change between its releases. */
  | { readonly kind: "function_name"; readonly schema: string; readonly name: string };

/** Keep in step with docs/database/proposals/M13.2-FINAL-worker-role.proposed.sql. A unit test compares them. */
export const WORKER_READ_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  communities: ["id", "slug", "name"],
  collections: ["id", "community_id", "name", "slug"],
  members: ["id", "community_id", "full_name", "member_code", "user_id", "is_imported", "joined_via", "status", "archived_at", "merged_into_id"],
  officer_terms: ["id", "community_id", "user_id", "role", "end_reason", "started_at", "ended_at"],
  role_permissions: ["role", "permission"],
  obligations: ["collection_id", "member_id", "status"],
});

export const WORKER_FUNCTIONS: readonly string[] = Object.freeze([
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
  "app.uuid_generate_v7()",
  "extensions.gen_random_bytes(integer)",
  "app.strip_banned_payload_keys(jsonb)",
  "app.payload_has_banned_key(jsonb)",
]);

const QUEUE_TABLE = "pgmq.q_notification_events";
const ARCHIVE_TABLE = "pgmq.a_notification_events";

/** The queue columns the worker writes: pgmq.read and pgmq.set_vt, and its own mark, park and fault record. */
export const QUEUE_UPDATE_COLUMNS: readonly string[] = Object.freeze(["vt", "read_ct", "headers"]);

/** Without any of these a healthy message cannot be processed, so reading it would only use up its attempts. */
export const REQUIRED_PRIVILEGES: readonly PrivilegeCheck[] = Object.freeze([
  ...["public", "app", "pgmq", "extensions"].map((schema): PrivilegeCheck => ({ kind: "schema", schema })),
  { kind: "table", table: QUEUE_TABLE, privilege: "SELECT" },
  ...QUEUE_UPDATE_COLUMNS.map((column): PrivilegeCheck => ({ kind: "column", table: QUEUE_TABLE, column, privilege: "UPDATE" })),
  ...["public.notification_events", "public.notification_deliveries"].flatMap((table): PrivilegeCheck[] => [
    { kind: "table", table, privilege: "SELECT" },
    { kind: "table", table, privilege: "INSERT" },
  ]),
  ...Object.entries(WORKER_READ_COLUMNS).flatMap(([table, columns]) => columns.map((column): PrivilegeCheck => ({ kind: "column", table: `public.${table}`, column, privilege: "SELECT" }))),
  ...WORKER_FUNCTIONS.map((signature): PrivilegeCheck => ({ kind: "function", signature })),
  ...["read", "set_vt"].map((name): PrivilegeCheck => ({ kind: "function_name", schema: "pgmq", name })),
]);

/** Without these the final queue operation fails, and F-15's bounded path takes over. Reported, not refused. */
export const DEGRADED_PRIVILEGES: readonly PrivilegeCheck[] = Object.freeze([
  { kind: "table", table: QUEUE_TABLE, privilege: "DELETE" },
  { kind: "table", table: ARCHIVE_TABLE, privilege: "INSERT" },
  { kind: "column", table: ARCHIVE_TABLE, column: "msg_id", privilege: "SELECT" },
  ...["delete", "archive"].map((name): PrivilegeCheck => ({ kind: "function_name", schema: "pgmq", name })),
]);

/** A short name for a log line. Object names only: nothing here comes from configuration or a row. */
export function describePrivilege(check: PrivilegeCheck): string {
  switch (check.kind) {
    case "schema":
      return `usage on schema ${check.schema}`;
    case "table":
      return `${check.privilege} on ${check.table}`;
    case "column":
      return `${check.privilege} (${check.column}) on ${check.table}`;
    case "function":
      return `execute on ${check.signature}`;
    case "function_name":
      return `execute on ${check.schema}.${check.name}`;
  }
}

/** True when the role holds the privilege. Throws when the object is missing or the catalog cannot be read. */
export type PrivilegeProbe = (check: PrivilegeCheck) => Promise<boolean>;

export interface PrivilegeReport {
  readonly missing: readonly string[];
  readonly degraded: readonly string[];
}

async function failing(checks: readonly PrivilegeCheck[], probe: PrivilegeProbe): Promise<string[]> {
  const out: string[] = [];
  for (const check of checks) {
    let held = false;
    let reason: string | undefined;
    try {
      held = await probe(check);
    } catch (error) {
      // A missing object raises 42P01, 42883, 42703 or 3F000. Any failure here counts as not held: fail closed.
      reason = safeErrorSummary(error).code ?? "unverifiable";
    }
    if (!held) out.push(reason === undefined ? describePrivilege(check) : `${describePrivilege(check)} [${reason}]`);
  }
  return out;
}

export async function checkWorkerPrivileges(probe: PrivilegeProbe): Promise<PrivilegeReport> {
  return { missing: await failing(REQUIRED_PRIVILEGES, probe), degraded: await failing(DEGRADED_PRIVILEGES, probe) };
}

/** The catalog reads behind the preflight. Each is a read of privileges: none touches a queue row. */
export function sqlPrivilegeProbe(sql: postgres.Sql<Record<string, never>>): PrivilegeProbe {
  return async (check) => {
    let rows: readonly { ok: boolean | null }[];
    switch (check.kind) {
      case "schema":
        rows = await sql<{ ok: boolean | null }[]>`select has_schema_privilege(current_user, ${check.schema}::text, 'USAGE') as ok`;
        break;
      case "table":
        rows = await sql<{ ok: boolean | null }[]>`select has_table_privilege(current_user, ${check.table}::text, ${check.privilege}::text) as ok`;
        break;
      case "column":
        rows = await sql<{ ok: boolean | null }[]>`select has_column_privilege(current_user, ${check.table}::text, ${check.column}::text, ${check.privilege}::text) as ok`;
        break;
      case "function":
        rows = await sql<{ ok: boolean | null }[]>`select has_function_privilege(current_user, ${check.signature}::text, 'EXECUTE') as ok`;
        break;
      case "function_name":
        rows = await sql<{ ok: boolean | null }[]>`
          select bool_or(has_function_privilege(current_user, p.oid, 'EXECUTE')) as ok
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = ${check.schema}::text and p.proname = ${check.name}::text`;
        break;
    }
    return rows[0]?.ok === true;
  };
}
