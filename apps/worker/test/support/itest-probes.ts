/**
 * itest-probes.ts — the gate's two read-only probes (M13.2 Phase 1b).
 *
 * Pure with respect to I/O: each probe receives a ReadOnlySessionOpener and
 * only maps the rows it returns, so unit tests drive every branch with mocked
 * query results. The real opener (itest-db.ts) is the only code that connects.
 *
 *   createIdentityProbe     runs IDENTITY_PROBE_SQL; the result is judged by
 *                           verifyLiveIdentity (itest-environment.ts).
 *   createPauseSwitchReader runs PAUSE_SWITCH_PROBE_SQL; the result is judged
 *                           by checkPauseSwitch (itest-gate.ts).
 *
 * Neither probe has a write path: a session runs only the two constant
 * statements in PROBE_STATEMENTS, inside a read-only transaction. A probe
 * never updates or inserts the pause switch, not even to repair a missing or
 * malformed row; such a row is a refusal.
 *
 * Anything other than exactly the expected columns is inconclusive. Row
 * counts are passed on unchanged so the judges can tell "missing" (0) from
 * "duplicated" (> 1). No value is ever echoed into an error.
 */

import { IDENTITY_PROBE_SQL, refuse, type GateViolationCode, type IntegrationEnvironment } from "./itest-environment.ts";
import { PAUSE_SWITCH_PROBE_SQL, type IdentityProbe, type PauseSwitchReader, type PauseSwitchState } from "./itest-gate.ts";

/** The only statements a probe session will run. */
export const PROBE_STATEMENTS: ReadonlySet<string> = new Set([IDENTITY_PROBE_SQL, PAUSE_SWITCH_PROBE_SQL]);

/** A single-use, read-only connection opened for one probe and closed after it. */
export interface ReadOnlySession {
  /** Runs one statement from PROBE_STATEMENTS in a read-only transaction; resolves to its rows. */
  query(text: string): Promise<unknown>;
  close(): Promise<void>;
}

export type ReadOnlySessionOpener = (db: IntegrationEnvironment["db"]) => Promise<ReadOnlySession>;

const IDENTITY_COLUMNS = ["role_name", "session_role_name", "database_name", "server_port", "stack_id", "declared_host_port", "transaction_read_only"] as const;
const PAUSE_SWITCH_COLUMNS = ["email_sending_enabled"] as const;

type Row = Readonly<Record<string, unknown>>;

/** Returns the rows only if the result is an array of plain rows with exactly `columns`. */
function exactRows(result: unknown, columns: readonly string[], code: GateViolationCode, what: string): readonly Row[] {
  if (!Array.isArray(result)) {
    throw refuse(code, `${what} did not return a row set.`);
  }
  for (const row of result as unknown[]) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw refuse(code, `${what} returned a malformed row.`);
    }
    const keys = Object.keys(row);
    if (keys.length !== columns.length || !columns.every((c) => keys.includes(c))) {
      throw refuse(code, `${what} returned unexpected columns.`);
    }
  }
  return result as readonly Row[];
}

/**
 * Maps the identity probe's rows to the facts verifyLiveIdentity judges.
 * Value types are not coerced here: a string port or a numeric role stays
 * as it is and is rejected as inconclusive by verifyLiveIdentity.
 */
export function identityFactsFromRows(result: unknown): unknown {
  const rows = exactRows(result, IDENTITY_COLUMNS, "IDENTITY_INCONCLUSIVE", "The identity probe");
  if (rows.length !== 1) {
    throw refuse("IDENTITY_INCONCLUSIVE", `The identity probe returned ${rows.length} rows, expected exactly 1.`);
  }
  const row = rows[0]!;
  return {
    rowCount: 1,
    currentUser: row["role_name"],
    sessionUser: row["session_role_name"],
    currentDatabase: row["database_name"],
    serverPort: row["server_port"],
    stackId: row["stack_id"],
    declaredHostPort: row["declared_host_port"],
    transactionReadOnly: row["transaction_read_only"],
  };
}

/**
 * Maps the pause-switch rows to the state checkPauseSwitch judges: 0 rows is
 * "missing", more than 1 is "duplicated", and the value is passed through
 * untouched so anything but the boolean `false` is refused there.
 */
export function pauseSwitchStateFromRows(result: unknown): PauseSwitchState {
  const rows = exactRows(result, PAUSE_SWITCH_COLUMNS, "PAUSE_SWITCH_INCONCLUSIVE", "The pause-switch read");
  return { rowCount: rows.length, enabled: rows.length === 1 ? rows[0]!["email_sending_enabled"] : undefined };
}

async function withSession<T>(open: ReadOnlySessionOpener, db: IntegrationEnvironment["db"], sql: string, map: (rows: unknown) => T): Promise<T> {
  const session = await open(db);
  try {
    return map(await session.query(sql));
  } finally {
    // A failed close does not change what was read; the gate's timeout bounds a hanging one.
    await session.close().catch(() => {});
  }
}

export function createIdentityProbe(open: ReadOnlySessionOpener): IdentityProbe {
  return (db) => withSession(open, db, IDENTITY_PROBE_SQL, identityFactsFromRows);
}

export function createPauseSwitchReader(open: ReadOnlySessionOpener): PauseSwitchReader {
  return (db) => withSession(open, db, PAUSE_SWITCH_PROBE_SQL, pauseSwitchStateFromRows);
}
