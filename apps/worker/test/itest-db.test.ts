/**
 * itest-db.test.ts — M13.2 Phase 1b: the gate's read-only probes and the only
 * connection factory integration code may use.
 *
 * Mocked query results only. The probes run against a fake ReadOnlySession;
 * the connection factory is given a spy driver that records its options and
 * never connects. No database, SMTP or Mailpit is reached.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";

import {
  IDENTITY_PROBE_SQL,
  ITEST_CONTAINER_DB_PORT,
  ITEST_DB_ROLE,
  IntegrationGateError,
  parseIntegrationEnvironment,
  type EnvSource,
  type GateViolationCode,
  type IntegrationEnvironment,
} from "./support/itest-environment.ts";
import {
  createIntegrationGate,
  findForbiddenSwitchWrites,
  PAUSE_SWITCH_PROBE_SQL,
  type IntegrationGateDeps,
} from "./support/itest-gate.ts";
import {
  createIdentityProbe,
  createPauseSwitchReader,
  identityFactsFromRows,
  pauseSwitchStateFromRows,
  type ReadOnlySession,
  type ReadOnlySessionOpener,
} from "./support/itest-probes.ts";
import {
  connectVerified,
  liveGateDeps,
  openProbeSession,
  probeConnectionOptions,
  verifiedConnectionOptions,
  type ItestDriver,
  type ItestSql,
} from "./support/itest-db.ts";

const PASSWORD = randomBytes(18).toString("base64url");
const STACK_ID = randomUUID();

type Db = IntegrationEnvironment["db"];

function testEnv(overrides: Record<string, string | undefined> = {}): EnvSource {
  return {
    KOLEKTO_ITEST_REQUIRED: "1",
    KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422/postgres`,
    KOLEKTO_ITEST_SMTP_PORT: "55425",
    KOLEKTO_ITEST_MAILPIT_API: "http://127.0.0.1:55424",
    KOLEKTO_ITEST_STACK_ID: STACK_ID,
    ...overrides,
  };
}

/** The row Postgres would return for the identity probe on the real test stack. */
function identityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role_name: ITEST_DB_ROLE,
    session_role_name: ITEST_DB_ROLE,
    database_name: "postgres",
    server_port: ITEST_CONTAINER_DB_PORT,
    stack_id: STACK_ID,
    declared_host_port: "55422",
    transaction_read_only: "on",
    ...overrides,
  };
}

const SWITCH_OFF_ROWS = [{ email_sending_enabled: false }];

interface FakeDb {
  readonly open: ReadOnlySessionOpener;
  readonly statements: string[];
  readonly opened: Db[];
  closed: number;
}

/** A fake opener whose sessions answer the two probe statements from fixed results. */
function fakeDb(results: { identity?: unknown; switchStates?: readonly unknown[]; failQuery?: Error } = {}): FakeDb {
  const switchStates = results.switchStates ?? [SWITCH_OFF_ROWS, SWITCH_OFF_ROWS];
  let switchReads = 0;
  const fake: FakeDb = {
    statements: [],
    opened: [],
    closed: 0,
    open: async (db) => {
      fake.opened.push(db);
      const session: ReadOnlySession = {
        async query(text) {
          fake.statements.push(text);
          if (results.failQuery) throw results.failQuery;
          if (text === IDENTITY_PROBE_SQL) return "identity" in results ? results.identity : [identityRow()];
          if (text === PAUSE_SWITCH_PROBE_SQL) return switchStates[switchReads++];
          throw new Error("unexpected statement");
        },
        async close() {
          fake.closed++;
        },
      };
      return session;
    },
  };
  return fake;
}

function gateDeps(fake: FakeDb, env: EnvSource = testEnv()): IntegrationGateDeps {
  return { env, probeIdentity: createIdentityProbe(fake.open), readPauseSwitch: createPauseSwitchReader(fake.open) };
}

async function refusalOf(promise: Promise<unknown>): Promise<IntegrationGateError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof IntegrationGateError, `expected IntegrationGateError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a refusal");
}

function refusalSync(fn: () => unknown): IntegrationGateError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof IntegrationGateError, `expected IntegrationGateError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a refusal");
}

async function refusedWith(rows: unknown, code: GateViolationCode): Promise<void> {
  const fake = fakeDb({ identity: rows });
  const error = await refusalOf(createIntegrationGate(gateDeps(fake)).verify());
  assert.ok(error.has(code), `expected ${code}, got ${error.violations.map((v) => v.code).join(", ")}`);
  assert.equal(fake.statements.filter((s) => s === PAUSE_SWITCH_PROBE_SQL).length, 0, "the switch is not read after an identity refusal");
}

/** Spy driver: records options, returns an object that fails loudly if anything tries to query. */
function spyDriver() {
  const calls: unknown[] = [];
  const driver: ItestDriver = (options) => {
    calls.push(options);
    return new Proxy({}, { get: () => { throw new Error("spy driver: no query may run in a unit test"); } }) as unknown as ItestSql;
  };
  return { driver, calls };
}

/** A verified environment and the db object the gate probed, from a fully mocked gate. */
async function verifiedFixture(env: EnvSource = testEnv()) {
  const fake = fakeDb();
  const verified = await createIntegrationGate(gateDeps(fake, env)).verify();
  return { verified, probedDb: fake.opened[0]! };
}

// ── Phase 1b-A: identity probe ────────────────────────────────────────────────

describe("identity probe — mocked query results", () => {
  it("accepts the correct test-database identity and closes its session", async () => {
    const fake = fakeDb();
    const env = await createIntegrationGate(gateDeps(fake)).verify();
    assert.equal(env.db.role, ITEST_DB_ROLE);
    assert.deepEqual(fake.statements, [IDENTITY_PROBE_SQL, PAUSE_SWITCH_PROBE_SQL]);
    assert.equal(fake.closed, 2, "one single-use session per probe, both closed");
    assert.equal(fake.opened[0], env.db, "the probe targets the gate's own validated endpoint");
  });

  it("refuses an incorrect login role", async () => {
    await refusedWith([identityRow({ role_name: "kolekto_app" })], "IDENTITY_ROLE_MISMATCH");
    await refusedWith([identityRow({ session_role_name: "someone" })], "IDENTITY_ROLE_MISMATCH");
  });

  it("refuses a built-in role (developer database or SET ROLE)", async () => {
    await refusedWith([identityRow({ role_name: "postgres", session_role_name: "postgres" })], "IDENTITY_BUILTIN_ROLE");
    await refusedWith([identityRow({ role_name: "supabase_admin" })], "IDENTITY_BUILTIN_ROLE");
  });

  it("refuses a missing stack ID", async () => {
    await refusedWith([identityRow({ stack_id: null })], "IDENTITY_STACK_MISSING");
    await refusedWith([identityRow({ stack_id: "" })], "IDENTITY_STACK_MISSING");
  });

  it("refuses a mismatched stack ID", async () => {
    await refusedWith([identityRow({ stack_id: randomUUID() })], "IDENTITY_STACK_MISMATCH");
    await refusedWith([identityRow({ stack_id: "on" })], "IDENTITY_STACK_MISMATCH");
  });

  it("refuses an incorrect connection configuration", async () => {
    await refusedWith([identityRow({ database_name: "kolekto" })], "IDENTITY_DATABASE_MISMATCH");
    await refusedWith([identityRow({ declared_host_port: "55423" })], "IDENTITY_PORT_MISMATCH");
    await refusedWith([identityRow({ declared_host_port: null })], "IDENTITY_PORT_UNDECLARED");
    await refusedWith([identityRow({ server_port: 55422 })], "IDENTITY_SERVER_PORT_UNEXPECTED");
    await refusedWith([identityRow({ server_port: null })], "IDENTITY_INCONCLUSIVE");
    await refusedWith([identityRow({ transaction_read_only: "off" })], "IDENTITY_NOT_READ_ONLY");
  });

  it("refuses the developer database as it would answer (stock role, no markers)", async () => {
    const devRow = identityRow({ role_name: "postgres", session_role_name: "postgres", stack_id: null, declared_host_port: null });
    const fake = fakeDb({ identity: [devRow] });
    const error = await refusalOf(createIntegrationGate(gateDeps(fake)).verify());
    for (const code of ["IDENTITY_ROLE_MISMATCH", "IDENTITY_BUILTIN_ROLE", "IDENTITY_STACK_MISSING", "IDENTITY_PORT_UNDECLARED"] as const) {
      assert.ok(error.has(code), code);
    }
  });

  it("treats any malformed result as inconclusive (fail closed)", async () => {
    const malformed: unknown[] = [
      undefined,
      null,
      "row",
      {},
      [],
      [identityRow(), identityRow()],
      [null],
      [[1, 2]],
      [{ ...identityRow(), extra: 1 }],
      [(() => { const r = identityRow(); delete r["stack_id"]; return r; })()],
      [identityRow({ server_port: "5432" })],
      [identityRow({ role_name: 42 })],
      [identityRow({ transaction_read_only: true })],
    ];
    for (const rows of malformed) {
      await refusedWith(rows, "IDENTITY_INCONCLUSIVE");
    }
  });

  it("maps rows without coercing types", () => {
    const facts = identityFactsFromRows([identityRow()]) as Record<string, unknown>;
    assert.deepEqual(facts, {
      rowCount: 1,
      currentUser: ITEST_DB_ROLE,
      sessionUser: ITEST_DB_ROLE,
      currentDatabase: "postgres",
      serverPort: ITEST_CONTAINER_DB_PORT,
      stackId: STACK_ID,
      declaredHostPort: "55422",
      transactionReadOnly: "on",
    });
  });

  it("a failing query is a redacted refusal and the session is still closed", async () => {
    const leaky = Object.assign(new Error(`connect to postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422 failed`), { code: "ECONNREFUSED" });
    const fake = fakeDb({ failQuery: leaky });
    const error = await refusalOf(createIntegrationGate(gateDeps(fake)).verify());
    assert.ok(error.has("IDENTITY_PROBE_FAILED"));
    assert.ok(!error.message.includes(PASSWORD));
    assert.ok(!inspect(error, { depth: 5 }).includes(PASSWORD));
    assert.equal(fake.closed, 1);
  });
});

// ── Phase 1b-B: pause-switch reader ───────────────────────────────────────────

describe("pause-switch reader — mocked query results", () => {
  async function readerRefusal(rows: unknown): Promise<IntegrationGateError> {
    const fake = fakeDb({ switchStates: [rows] });
    return refusalOf(createIntegrationGate(gateDeps(fake)).verify());
  }

  it("passes when exactly one row reads false, and reads again after the file", async () => {
    const fake = fakeDb();
    const gate = createIntegrationGate(gateDeps(fake));
    await gate.verify();
    await gate.postflight();
    assert.equal(fake.statements.filter((s) => s === PAUSE_SWITCH_PROBE_SQL).length, 2);
  });

  it("fails when the switch is true, before or after the file", async () => {
    assert.ok((await readerRefusal([{ email_sending_enabled: true }])).has("PAUSE_SWITCH_ON"));
    const fake = fakeDb({ switchStates: [SWITCH_OFF_ROWS, [{ email_sending_enabled: true }]] });
    const gate = createIntegrationGate(gateDeps(fake));
    await gate.verify();
    assert.ok((await refusalOf(gate.postflight())).has("PAUSE_SWITCH_ON"));
  });

  it("fails on a missing switch row", async () => {
    assert.ok((await readerRefusal([])).has("PAUSE_SWITCH_ROW_MISSING"));
  });

  it("fails on duplicate switch rows", async () => {
    for (const rows of [[{ email_sending_enabled: false }, { email_sending_enabled: false }], [{ email_sending_enabled: false }, { email_sending_enabled: true }]]) {
      const error = await readerRefusal(rows);
      assert.ok(error.has("PAUSE_SWITCH_INCONCLUSIVE"));
      assert.match(error.message, /returned 2 rows/);
    }
  });

  it("fails on a malformed result", async () => {
    const malformed: unknown[] = [
      undefined,
      null,
      { email_sending_enabled: false },
      [{ email_sending_enabled: "false" }],
      [{ email_sending_enabled: null }],
      [{ email_sending_enabled: 0 }],
      [{ enabled: false }],
      [{ email_sending_enabled: false, id: true }],
      [null],
    ];
    for (const rows of malformed) {
      assert.ok((await readerRefusal(rows)).has("PAUSE_SWITCH_INCONCLUSIVE"), JSON.stringify(rows));
    }
  });

  it("only ever runs the read-only select: no update or insert path exists", async () => {
    const fake = fakeDb({ switchStates: [[], SWITCH_OFF_ROWS] });
    await refusalOf(createIntegrationGate(gateDeps(fake)).verify());
    assert.deepEqual(fake.statements, [IDENTITY_PROBE_SQL, PAUSE_SWITCH_PROBE_SQL], "a missing row is reported, never repaired");
    for (const sql of fake.statements) assert.deepEqual(findForbiddenSwitchWrites(sql), []);
    assert.match(PAUSE_SWITCH_PROBE_SQL, /^select email_sending_enabled from public\.notification_sender_state$/);
  });

  it("maps rows into the state checkPauseSwitch judges", () => {
    assert.deepEqual(pauseSwitchStateFromRows([{ email_sending_enabled: false }]), { rowCount: 1, enabled: false });
    assert.deepEqual(pauseSwitchStateFromRows([]), { rowCount: 0, enabled: undefined });
    assert.deepEqual(pauseSwitchStateFromRows([{ email_sending_enabled: true }, { email_sending_enabled: true }]), { rowCount: 2, enabled: undefined });
  });
});

// ── Phase 1b-C: connection enforcement ────────────────────────────────────────

describe("connection factory — only verified environments, explicit options", () => {
  it("builds test-connection options field by field, never from the URL string", async () => {
    const { verified } = await verifiedFixture();
    const options = verifiedConnectionOptions(verified, { max: 2 }) as Record<string, unknown>;
    assert.equal(options["host"], "127.0.0.1");
    assert.equal(options["port"], 55422);
    assert.equal(options["database"], "postgres");
    assert.equal(options["username"], ITEST_DB_ROLE);
    assert.equal(options["password"], PASSWORD);
    assert.equal(options["ssl"], false);
    assert.equal(options["path"], undefined, "never a Unix socket");
    assert.equal(options["max"], 2);
    assert.ok(!JSON.stringify(options).includes("postgresql://"), "no URL string is passed to the driver");
    assert.deepEqual(options["connection"], { application_name: "kolekto-itest", lock_timeout: 10_000, idle_in_transaction_session_timeout: 60_000 });
  });

  it("strips the brackets of an IPv6 loopback literal", async () => {
    const { verified } = await verifiedFixture(testEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@[::1]:55422/postgres` }));
    assert.equal((verifiedConnectionOptions(verified, { max: 1 }) as Record<string, unknown>)["host"], "::1");
  });

  it("connectVerified hands the driver an options object for a verified environment", async () => {
    const { verified } = await verifiedFixture();
    const spy = spyDriver();
    connectVerified(verified, { max: 3 }, spy.driver);
    assert.equal(spy.calls.length, 1);
    assert.equal(typeof spy.calls[0], "object");
    assert.equal((spy.calls[0] as Record<string, unknown>)["max"], 3);
  });

  it("makes no database connection for an unverified environment", () => {
    const parsed = parseIntegrationEnvironment(testEnv());
    for (const env of [parsed, { ...parsed }, { db: parsed.db }, {}, null, undefined, "postgresql://x"]) {
      const spy = spyDriver();
      assert.ok(refusalSync(() => connectVerified(env, { max: 1 }, spy.driver)).has("NOT_VERIFIED"));
      assert.equal(spy.calls.length, 0, "the driver is never constructed");
    }
  });

  it("refuses an out-of-range pool size", async () => {
    const { verified } = await verifiedFixture();
    for (const max of [0, -1, 11, 1.5, Number.NaN]) {
      const spy = spyDriver();
      assert.ok(refusalSync(() => connectVerified(verified, { max }, spy.driver)).has("CONNECTION_OPTIONS_INVALID"));
      assert.equal(spy.calls.length, 0);
    }
  });

  it("the probe connection is read-only, single-use and only for the gate's own target", async () => {
    const { probedDb } = await verifiedFixture();
    const options = probeConnectionOptions(probedDb) as Record<string, unknown>;
    assert.equal(options["max"], 1);
    assert.equal(options["fetch_types"], false);
    assert.deepEqual(options["connection"], { application_name: "kolekto-itest-probe", default_transaction_read_only: true, statement_timeout: 5_000 });

    const parsed = parseIntegrationEnvironment(testEnv());
    for (const db of [parsed.db, { ...probedDb }, {}, null]) {
      assert.ok(refusalSync(() => probeConnectionOptions(db)).has("PROBE_TARGET_UNISSUED"));
    }
  });

  it("openProbeSession refuses an unissued endpoint before constructing the driver", async () => {
    const spy = spyDriver();
    const parsed = parseIntegrationEnvironment(testEnv());
    assert.ok((await refusalOf(openProbeSession(parsed.db, spy.driver))).has("PROBE_TARGET_UNISSUED"));
    assert.equal(spy.calls.length, 0);
  });

  it("a probe session runs only the two constant statements, each in `begin read only`", async () => {
    const { probedDb } = await verifiedFixture();
    const begins: string[] = [];
    const unsafe: string[] = [];
    let ended = 0;
    const driver: ItestDriver = () => ({
      begin: async (mode: string, cb: (tx: unknown) => unknown) => {
        begins.push(mode);
        return cb({ unsafe: async (text: string) => { unsafe.push(text); return []; } });
      },
      end: async () => { ended++; },
    }) as unknown as ItestSql;

    const session = await openProbeSession(probedDb, driver);
    assert.ok((await refusalOf(session.query("update public.notification_sender_state set email_sending_enabled = false"))).has("PROBE_STATEMENT_REFUSED"));
    assert.deepEqual(begins, [], "a refused statement never opens a transaction");
    await session.query(IDENTITY_PROBE_SQL);
    await session.query(PAUSE_SWITCH_PROBE_SQL);
    assert.deepEqual(begins, ["read only", "read only"]);
    assert.deepEqual(unsafe, [IDENTITY_PROBE_SQL, PAUSE_SWITCH_PROBE_SQL]);
    await session.close();
    assert.equal(ended, 1);
  });

  it("makes no database connection when the configuration is invalid", async () => {
    const invalid: readonly EnvSource[] = [
      {},
      testEnv({ KOLEKTO_ITEST_REQUIRED: undefined }),
      testEnv({ KOLEKTO_ITEST_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }),
      testEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres` }),
      testEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422/postgres?options=-c%20role%3Dpostgres` }),
      testEnv({ PGHOST: "10.0.0.5" }),
      testEnv({ SUPABASE_DB_URL: `postgresql://postgres:${PASSWORD}@127.0.0.1:54322/postgres` }),
    ];
    for (const env of invalid) {
      const fake = fakeDb();
      await refusalOf(createIntegrationGate(gateDeps(fake, env)).verify());
      assert.equal(fake.opened.length, 0, "no probe session was opened");
    }
  });

  it("liveGateDeps wires the real probes but connects to nothing on its own", async () => {
    const deps = liveGateDeps();
    assert.equal(deps.env, process.env);
    assert.equal(typeof deps.probeIdentity, "function");
    assert.equal(typeof deps.readPauseSwitch, "function");
    // With an empty environment the gate refuses before any probe can run.
    const error = await refusalOf(createIntegrationGate({ ...deps, env: {} }).verify());
    assert.ok(error.has("NOT_REQUIRED_MODE"));
  });
});
