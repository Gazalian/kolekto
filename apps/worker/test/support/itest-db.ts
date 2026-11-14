/**
 * itest-db.ts — the only way integration code reaches a database (M13.2 Phase 1b).
 *
 * This is the single module under test/support/ that imports the database
 * driver (a repository guard enforces it). It opens exactly two kinds of
 * connection, each behind a brand check, and nothing else:
 *
 *   openProbeSession(db)        the gate's read-only probe connection. Accepts
 *                               only an endpoint the gate itself validated and
 *                               is probing (assertProbeTarget); runs only the
 *                               two constant probe statements, inside
 *                               `begin read only`, on a session started with
 *                               default_transaction_read_only = on.
 *   connectVerified(env, opts)  every test connection. Accepts only an
 *                               environment issued by a successful
 *                               gate.verify() (assertVerifiedEnvironment).
 *
 * Both build the driver options field by field from the validated
 * configuration: host, port, database, user and password are explicit, and
 * the URL string is never handed to the driver. postgres.js would otherwise
 * honour URL query parameters (startup `options`, sslmode, …) and fall back
 * to ambient PG* variables; the static gate refuses both, and this module
 * does not depend on that refusal.
 *
 * Nothing here runs at import time. Unit tests exercise the option builders
 * and inject a fake driver; no test connects.
 */

import postgres from "postgres";

import { refuse, type IntegrationEnvironment, type Secret } from "./itest-environment.ts";
import { assertProbeTarget, assertVerifiedEnvironment, type IntegrationGateDeps } from "./itest-gate.ts";
import { createIdentityProbe, createPauseSwitchReader, PROBE_STATEMENTS, type ReadOnlySession } from "./itest-probes.ts";

export type ItestSql = postgres.Sql<Record<string, never>>;
/** The transaction handle of `ItestSql.begin` (Phase 4: rollback helpers in itest-isolation.ts). */
export type ItestTx = postgres.TransactionSql<Record<string, never>>;
/** A connection taken out of a pool with `reserve()`; it never idles out (Phase 4: suite mutex). */
export type ItestReservedSql = postgres.ReservedSql<Record<string, never>>;
export type ItestDriver = (options: postgres.Options<Record<string, never>>) => ItestSql;

type Db = IntegrationEnvironment["db"];

/** Test connections are small pools; the existing tests use 1–6. */
const MAX_POOL = 10;

/** Explicit endpoint fields; brackets are stripped from an IPv6 literal. */
function endpoint(db: Db) {
  return {
    host: db.host.replace(/^\[(.*)\]$/, "$1"),
    port: db.port,
    path: undefined,
    database: db.database,
    username: db.role,
    password: db.password.reveal(),
    ssl: false,
  } as const;
}

/** Driver options for the gate's probe connection. Throws unless `db` is a gate's probe target. */
export function probeConnectionOptions(db: unknown): postgres.Options<Record<string, never>> {
  assertProbeTarget(db);
  return {
    ...endpoint(db),
    max: 1,
    prepare: false,
    fetch_types: false,
    debug: false,
    idle_timeout: 5,
    connect_timeout: 10,
    max_lifetime: null,
    connection: {
      application_name: "kolekto-itest-probe",
      default_transaction_read_only: true,
      statement_timeout: 5_000,
    },
  };
}

/** Driver options for a test connection. Throws unless `env` came from a successful gate.verify(). */
export function verifiedConnectionOptions(env: unknown, opts: { readonly max: number }): postgres.Options<Record<string, never>> {
  assertVerifiedEnvironment(env);
  if (!Number.isInteger(opts.max) || opts.max < 1 || opts.max > MAX_POOL) {
    throw refuse("CONNECTION_OPTIONS_INVALID", `max must be an integer from 1 to ${MAX_POOL}.`);
  }
  return {
    ...endpoint(env.db),
    max: opts.max,
    prepare: false,
    fetch_types: true,
    debug: false,
    transform: { undefined: null },
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: null,
    connection: {
      application_name: "kolekto-itest",
      // Approval checklist R10: a hung test must not hold locks indefinitely.
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  };
}

/** Opens a test connection on the verified test stack. The only connection factory integration files may use. */
export function connectVerified(env: unknown, opts: { readonly max: number }, driver: ItestDriver = postgres): ItestSql {
  return driver(verifiedConnectionOptions(env, opts));
}

/** The test stack's least-privilege worker role (`npm run itest:worker-role`). */
export const WORKER_DB_ROLE = "kolekto_itest_worker";

/**
 * Phase 7: a connection as the worker role, on the verified endpoint only, used to
 * prove what that role is refused. The password is the run's short-lived credential.
 */
export function connectAsWorkerRole(env: unknown, password: Secret, driver: ItestDriver = postgres): ItestSql {
  assertVerifiedEnvironment(env);
  return driver({
    ...endpoint(env.db),
    username: WORKER_DB_ROLE,
    password: password.reveal(),
    max: 1,
    prepare: false,
    fetch_types: false,
    debug: false,
    onnotice: () => {},
    idle_timeout: 5,
    connect_timeout: 10,
    max_lifetime: null,
    connection: { application_name: "kolekto-itest-worker-probe", statement_timeout: 5_000 },
  });
}

/** The real ReadOnlySessionOpener used by the gate's probes. */
export async function openProbeSession(db: Db, driver: ItestDriver = postgres): Promise<ReadOnlySession> {
  const sql = driver(probeConnectionOptions(db));
  return {
    async query(text) {
      if (!PROBE_STATEMENTS.has(text)) {
        throw refuse("PROBE_STATEMENT_REFUSED", "The probe session runs only the two constant read-only probe statements.");
      }
      return sql.begin("read only", (tx) => tx.unsafe(text));
    },
    close: () => sql.end({ timeout: 2 }),
  };
}

/**
 * Gate dependencies for a real integration file: the process environment
 * (set by the integration runner) and the read-only probes over
 * openProbeSession. Integration files must create their gate with this.
 */
export function liveGateDeps(): IntegrationGateDeps {
  const open = (db: Db) => openProbeSession(db);
  return {
    env: process.env,
    probeIdentity: createIdentityProbe(open),
    readPauseSwitch: createPauseSwitchReader(open),
  };
}
