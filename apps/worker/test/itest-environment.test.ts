/**
 * itest-environment.test.ts — M13.2 Phase 1a: integration-test environment identity.
 *
 * Pure unit tests: every input is a plain object. No database, SMTP or Mailpit.
 * Credentials and stack IDs below are generated per run and are fake.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";

import {
  IDENTITY_PROBE_SQL,
  ITEST_CONTAINER_DB_PORT,
  ITEST_DB_ROLE,
  ITEST_ENV,
  IntegrationGateError,
  parseIntegrationEnvironment,
  verifyLiveIdentity,
  type EnvSource,
  type GateViolationCode,
  type IdentityFacts,
} from "./support/itest-environment.ts";

const PASSWORD = randomBytes(18).toString("base64url");
const STACK_ID = randomUUID();

function validEnv(overrides: Record<string, string | undefined> = {}): EnvSource {
  return {
    KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422/postgres`,
    KOLEKTO_ITEST_SMTP_PORT: "55425",
    KOLEKTO_ITEST_MAILPIT_API: "http://127.0.0.1:55424",
    KOLEKTO_ITEST_STACK_ID: STACK_ID,
    ...overrides,
  };
}

function refusal(fn: () => unknown): IntegrationGateError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof IntegrationGateError, `expected IntegrationGateError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the gate to refuse");
}

function assertRefused(env: EnvSource, code: GateViolationCode): IntegrationGateError {
  const error = refusal(() => parseIntegrationEnvironment(env));
  assert.ok(error.has(code), `expected ${code}, got ${error.violations.map((v) => v.code).join(", ")}`);
  return error;
}

function validFacts(overrides: Partial<IdentityFacts> = {}): IdentityFacts {
  return {
    rowCount: 1,
    currentUser: ITEST_DB_ROLE,
    sessionUser: ITEST_DB_ROLE,
    currentDatabase: "postgres",
    serverPort: ITEST_CONTAINER_DB_PORT,
    stackId: STACK_ID,
    declaredHostPort: "55422",
    transactionReadOnly: "on",
    ...overrides,
  };
}

describe("integration environment — valid identity", () => {
  it("accepts a complete, consistent test-stack configuration", () => {
    const config = parseIntegrationEnvironment(validEnv());
    assert.equal(config.db.host, "127.0.0.1");
    assert.equal(config.db.port, 55422);
    assert.equal(config.db.database, "postgres");
    assert.equal(config.db.role, ITEST_DB_ROLE);
    assert.equal(config.db.url.reveal(), validEnv()["KOLEKTO_ITEST_DB_URL"]);
    assert.deepEqual(config.smtp, { host: "127.0.0.1", port: 55425 });
    assert.deepEqual(config.mailpitApi, { origin: "http://127.0.0.1:55424", port: 55424 });
    assert.equal(config.stackId.reveal(), STACK_ID);
    assert.ok(Object.isFrozen(config) && Object.isFrozen(config.db));
  });

  it("accepts the IPv6 loopback literal", () => {
    const config = parseIntegrationEnvironment(validEnv({
      KOLEKTO_ITEST_DB_URL: `postgres://${ITEST_DB_ROLE}:${PASSWORD}@[::1]:55422/postgres`,
      KOLEKTO_ITEST_MAILPIT_API: "http://[::1]:55424/",
    }));
    assert.equal(config.db.host, "[::1]");
  });

  it("passes live identity when role, database, port and stack ID all match", () => {
    verifyLiveIdentity(parseIntegrationEnvironment(validEnv()), validFacts());
  });
});

describe("integration environment — missing configuration", () => {
  for (const name of Object.values(ITEST_ENV)) {
    it(`refuses when ${name} is missing or empty`, () => {
      for (const value of [undefined, ""]) {
        const error = assertRefused(validEnv({ [name]: value }), "ENV_MISSING");
        assert.match(error.message, new RegExp(name));
      }
    });
  }

  it("refuses an empty environment with one violation per variable", () => {
    const error = assertRefused({}, "ENV_MISSING");
    assert.equal(error.violations.filter((v) => v.code === "ENV_MISSING").length, 4);
  });

  it("missing Mailpit configuration is a refusal, not a default to the developer inbox", () => {
    const error = assertRefused(validEnv({ KOLEKTO_ITEST_MAILPIT_API: undefined }), "ENV_MISSING");
    assert.match(error.message, /KOLEKTO_ITEST_MAILPIT_API/);
  });

  it("never falls back to the developer variables", () => {
    const error = assertRefused({
      SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      EMAIL_SMTP_HOST: "127.0.0.1",
      EMAIL_SMTP_PORT: "54325",
      MAILPIT_API: "http://127.0.0.1:54324",
    }, "ENV_MISSING");
    assert.equal(error.violations.length, 4);
  });

  it("ignores developer variables that sit alongside a valid test configuration", () => {
    const config = parseIntegrationEnvironment(validEnv({ SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", MAILPIT_API: "http://127.0.0.1:54324" }));
    assert.equal(config.db.port, 55422);
    assert.equal(config.mailpitApi.port, 55424);
  });
});

describe("integration environment — malformed variables", () => {
  it("refuses values with surrounding whitespace or control characters", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_SMTP_PORT: " 55425" }), "ENV_MALFORMED");
    assertRefused(validEnv({ KOLEKTO_ITEST_STACK_ID: `${STACK_ID}\n` }), "ENV_MALFORMED");
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `${validEnv()["KOLEKTO_ITEST_DB_URL"]}\u0000` }), "ENV_MALFORMED");
  });

  for (const port of ["abc", "0", "055425", "55425abc", "70000", "-55425", "5.5"]) {
    it(`refuses SMTP port ${JSON.stringify(port)}`, () => {
      assertRefused(validEnv({ KOLEKTO_ITEST_SMTP_PORT: port }), "ENV_MALFORMED");
    });
  }

  it("refuses a database URL that does not parse or uses another scheme", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: "not a url" }), "DB_URL_INVALID");
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `mysql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422/postgres` }), "DB_URL_INVALID");
  });

  it("refuses query parameters that could override host, port or user", () => {
    for (const query of ["?host=10.0.0.5", "?sslmode=require", "?options=-crole%3Dpostgres", "#x"]) {
      assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422/postgres${query}` }), "DB_URL_INVALID");
    }
  });

  it("refuses a database URL without an explicit port", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1/postgres` }), "DB_URL_INVALID");
  });

  it("refuses a missing, nested or non-identifier database name", () => {
    for (const path of ["", "/", "/a/b", "/1db", "/db-name"]) {
      assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422${path}` }), "DB_NAME_INVALID");
    }
  });

  it("refuses any role other than the test role", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://someone:${PASSWORD}@127.0.0.1:55422/postgres` }), "DB_ROLE_NOT_TEST_ROLE");
  });

  it("refuses a missing or short password", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}@127.0.0.1:55422/postgres` }), "DB_PASSWORD_WEAK");
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:short@127.0.0.1:55422/postgres` }), "DB_PASSWORD_WEAK");
  });

  it("refuses malformed percent-encoding in the credentials", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:%E0%A4%A@127.0.0.1:55422/postgres` }), "DB_URL_INVALID");
  });

  for (const id of ["on", "true", "00000000-0000-0000-0000-000000000000", STACK_ID.toUpperCase(), "6ba7b810-9dad-11d1-80b4-00c04fd430c8", STACK_ID.slice(0, -1)]) {
    it(`refuses stack ID ${JSON.stringify(id === STACK_ID.toUpperCase() ? "<uppercase uuid>" : id)}`, () => {
      assertRefused(validEnv({ KOLEKTO_ITEST_STACK_ID: id }), "STACK_ID_INVALID");
    });
  }

  it("refuses a Mailpit API that is not a bare http origin with an explicit port", () => {
    for (const api of ["https://127.0.0.1:55424", "ftp://127.0.0.1:55424", "http://127.0.0.1", "http://127.0.0.1:55424/api/v1", "http://u:p@127.0.0.1:55424", "http://127.0.0.1:55424?x=1", "garbage"]) {
      assertRefused(validEnv({ KOLEKTO_ITEST_MAILPIT_API: api }), "MAILPIT_URL_INVALID");
    }
  });

  it("refuses ports outside the test-stack range", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:5432/postgres` }), "DB_PORT_OUTSIDE_TEST_RANGE");
    assertRefused(validEnv({ KOLEKTO_ITEST_SMTP_PORT: "1025" }), "SMTP_PORT_OUTSIDE_TEST_RANGE");
    assertRefused(validEnv({ KOLEKTO_ITEST_MAILPIT_API: "http://127.0.0.1:8025" }), "MAILPIT_PORT_OUTSIDE_TEST_RANGE");
  });

  it("refuses endpoints that share a port (split or copied configuration)", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_SMTP_PORT: "55422" }), "PORTS_NOT_DISTINCT");
    assertRefused(validEnv({ KOLEKTO_ITEST_SMTP_PORT: "55424" }), "PORTS_NOT_DISTINCT");
  });

  it("refuses ambient libpq variables that could redirect the connection", () => {
    const error = assertRefused(validEnv({ PGHOST: "10.0.0.5", PGPORT: "5432" }), "AMBIENT_PG_OVERRIDE");
    assert.match(error.message, /PGHOST, PGPORT/);
  });
});

describe("integration environment — developer database rejection", () => {
  it("refuses the developer stack's own URL", () => {
    const error = assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }), "DB_PORT_DEVELOPER");
    assert.ok(error.has("DB_DEVELOPER_CREDENTIALS"));
  });

  it("refuses a developer port even with test-role credentials", () => {
    for (const port of [54320, 54322, 54329]) {
      assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:${port}/postgres` }), "DB_PORT_DEVELOPER");
    }
  });

  it("refuses developer credentials even on a test port", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55422/postgres" }), "DB_DEVELOPER_CREDENTIALS");
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://supabase_admin:${PASSWORD}@127.0.0.1:55422/postgres` }), "DB_DEVELOPER_CREDENTIALS");
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:postgres@127.0.0.1:55422/postgres` }), "DB_DEVELOPER_CREDENTIALS");
  });

  it("refuses a live connection that carries no stack marker (the developer database)", () => {
    const config = parseIntegrationEnvironment(validEnv());
    const error = refusal(() => verifyLiveIdentity(config, validFacts({ stackId: null })));
    assert.ok(error.has("IDENTITY_STACK_MISSING"));
    assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ stackId: "" }))).has("IDENTITY_STACK_MISSING"));
  });

  it("refuses a live connection authenticated as a stock Supabase role", () => {
    const config = parseIntegrationEnvironment(validEnv());
    const error = refusal(() => verifyLiveIdentity(config, validFacts({ currentUser: "postgres", sessionUser: "postgres" })));
    assert.ok(error.has("IDENTITY_ROLE_MISMATCH"));
    assert.match(error.message, /developer database/);
  });
});

describe("integration environment — staging and production rejection", () => {
  const remote = [
    "aws-0-eu-west-1.pooler.supabase.com:6543",
    "db.abcdefghijklmnopqrst.supabase.co:5432",
    "db.abcdefghijklmnopqrst.supabase.co:55422",
  ];
  for (const hostPort of remote) {
    it(`refuses hosted Supabase ${hostPort}`, () => {
      assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@${hostPort}/postgres` }), "DB_HOST_REMOTE");
    });
  }

  for (const host of ["staging-db.kolekto.example", "prod.internal", "10.0.0.5", "192.168.1.20", "127.0.0.2", "localhost", "0.0.0.0"]) {
    it(`refuses non-literal-loopback host ${host}`, () => {
      assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@${host}:55422/postgres` }), "DB_HOST_NOT_LOOPBACK");
    });
  }

  it("refuses a remote Mailpit API host", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_MAILPIT_API: "http://mail.staging.example:55424" }), "MAILPIT_HOST_NOT_LOOPBACK");
    assertRefused(validEnv({ KOLEKTO_ITEST_MAILPIT_API: "http://localhost:55424" }), "MAILPIT_HOST_NOT_LOOPBACK");
  });
});

describe("integration environment — developer Mailpit rejection", () => {
  it("refuses the developer Mailpit web/API endpoint", () => {
    const error = assertRefused(validEnv({ KOLEKTO_ITEST_MAILPIT_API: "http://127.0.0.1:54324" }), "MAILPIT_DEVELOPER");
    assert.match(error.message, /developer Mailpit/);
  });

  it("refuses the developer Mailpit SMTP listener", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_SMTP_PORT: "54325" }), "SMTP_DEVELOPER");
  });

  it("refuses any developer-range Mailpit port", () => {
    assertRefused(validEnv({ KOLEKTO_ITEST_MAILPIT_API: "http://127.0.0.1:54321" }), "MAILPIT_DEVELOPER");
    assertRefused(validEnv({ KOLEKTO_ITEST_SMTP_PORT: "54329" }), "SMTP_DEVELOPER");
  });
});

describe("integration environment — live identity mismatches", () => {
  const config = parseIntegrationEnvironment(validEnv());

  it("refuses a different stack ID (another or stale test stack)", () => {
    assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ stackId: randomUUID() }))).has("IDENTITY_STACK_MISMATCH"));
  });

  it("refuses the legacy boolean marker value", () => {
    assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ stackId: "on" }))).has("IDENTITY_STACK_MISMATCH"));
  });

  it("refuses a session that switched role (session_user differs)", () => {
    assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ sessionUser: "postgres" }))).has("IDENTITY_ROLE_MISMATCH"));
  });

  it("refuses a database or declared host port that differs from the URL", () => {
    assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ currentDatabase: "kolekto_itest" }))).has("IDENTITY_DATABASE_MISMATCH"));
    assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ declaredHostPort: "55423" }))).has("IDENTITY_PORT_MISMATCH"));
  });

  it("treats a null server port, a wrong row count or a malformed result as inconclusive", () => {
    assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ serverPort: null }))).has("IDENTITY_INCONCLUSIVE"));
    for (const rowCount of [0, 2]) {
      assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ rowCount }))).has("IDENTITY_INCONCLUSIVE"));
    }
    for (const facts of [null, undefined, {}, "row", { ...validFacts(), serverPort: "5432" }, { ...validFacts(), currentUser: undefined }]) {
      assert.ok(refusal(() => verifyLiveIdentity(config, facts)).has("IDENTITY_INCONCLUSIVE"));
    }
  });

  it("reports every mismatch at once", () => {
    const error = refusal(() => verifyLiveIdentity(config, validFacts({ currentUser: "postgres", currentDatabase: "x", serverPort: 1, declaredHostPort: "1", stackId: null })));
    for (const code of ["IDENTITY_ROLE_MISMATCH", "IDENTITY_BUILTIN_ROLE", "IDENTITY_DATABASE_MISMATCH", "IDENTITY_SERVER_PORT_UNEXPECTED", "IDENTITY_PORT_MISMATCH", "IDENTITY_STACK_MISSING"] as const) {
      assert.ok(error.has(code), code);
    }
  });

  it("probe SQL is a single read-only select of the stack setting", () => {
    assert.match(IDENTITY_PROBE_SQL, /^select /);
    assert.match(IDENTITY_PROBE_SQL, /current_setting\('kolekto\.itest_stack', true\)/);
    assert.doesNotMatch(IDENTITY_PROBE_SQL, /;|\b(insert|update|delete|alter|set_config|create|drop)\b/i);
  });
});

describe("integration environment — secret-safe errors", () => {
  function rendered(error: IntegrationGateError): string {
    return [error.message, String(error), error.stack ?? "", inspect(error, { depth: 10 }), JSON.stringify(error)].join("\n");
  }

  it("never prints the password, the URL or the stack ID in a refusal", () => {
    const dbUrl = `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@db.abcdefghijklmnopqrst.supabase.co:54322/postgres?sslmode=require`;
    const errors = [
      refusal(() => parseIntegrationEnvironment(validEnv({ KOLEKTO_ITEST_DB_URL: dbUrl }))),
      refusal(() => parseIntegrationEnvironment(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://postgres:${PASSWORD}@10.1.2.3:54322/postgres` }))),
      refusal(() => parseIntegrationEnvironment(validEnv({ KOLEKTO_ITEST_DB_URL: `::not a url::${PASSWORD}` }))),
      refusal(() => parseIntegrationEnvironment(validEnv({ KOLEKTO_ITEST_STACK_ID: `${STACK_ID}-x` }))),
      refusal(() => verifyLiveIdentity(parseIntegrationEnvironment(validEnv()), validFacts({ stackId: randomUUID() }))),
    ];
    for (const error of errors) {
      const text = rendered(error);
      assert.ok(!text.includes(PASSWORD), "password leaked");
      assert.ok(!text.includes(STACK_ID), "stack ID leaked");
      assert.ok(!text.includes("supabase.co"), "host leaked");
      assert.ok(!text.includes("10.1.2.3"), "host leaked");
      assert.equal(error.cause, undefined, "no chained cause (URL errors embed their input)");
    }
  });

  it("redacts secrets when a validated configuration is logged or serialised", () => {
    const config = parseIntegrationEnvironment(validEnv());
    for (const text of [inspect(config, { depth: 10 }), JSON.stringify(config), String(config.db.url), `${config.stackId}`]) {
      assert.ok(!text.includes(PASSWORD), "password leaked");
      assert.ok(!text.includes(STACK_ID), "stack ID leaked");
    }
    assert.match(JSON.stringify(config), /\[redacted\]/);
  });
});

// ── Phase 1b ───────────────────────────────────────────────────────────────────

describe("integration environment — Phase 1b connection identity", () => {
  const config = parseIntegrationEnvironment(validEnv());

  it("checks inet_server_port() against the container port, never the host port", () => {
    // A Docker-published Postgres reports its container port (5432), not 55422.
    verifyLiveIdentity(config, validFacts({ serverPort: ITEST_CONTAINER_DB_PORT }));
    assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ serverPort: 55422 }))).has("IDENTITY_SERVER_PORT_UNEXPECTED"));
  });

  it("matches the dialled host port against the port recorded in the test database", () => {
    for (const declaredHostPort of [null, ""]) {
      assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ declaredHostPort }))).has("IDENTITY_PORT_UNDECLARED"));
    }
    for (const declaredHostPort of ["54322", "55423", " 55422", "055422"]) {
      assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ declaredHostPort }))).has("IDENTITY_PORT_MISMATCH"), declaredHostPort);
    }
  });

  it("refuses a probe that did not run read-only", () => {
    for (const transactionReadOnly of ["off", "", "true"]) {
      assert.ok(refusal(() => verifyLiveIdentity(config, validFacts({ transactionReadOnly }))).has("IDENTITY_NOT_READ_ONLY"));
    }
    assert.ok(refusal(() => verifyLiveIdentity(config, { ...validFacts(), transactionReadOnly: true })).has("IDENTITY_INCONCLUSIVE"));
  });

  it("refuses every built-in Postgres or Supabase role, including after SET ROLE", () => {
    for (const role of ["postgres", "supabase_admin", "supabase_auth_admin", "authenticator", "service_role", "anon", "authenticated", "pg_monitor", "pg_read_all_data"]) {
      const error = refusal(() => verifyLiveIdentity(config, validFacts({ currentUser: role })));
      assert.ok(error.has("IDENTITY_BUILTIN_ROLE") && error.has("IDENTITY_ROLE_MISMATCH"), role);
    }
    const other = refusal(() => verifyLiveIdentity(config, validFacts({ sessionUser: "kolekto_app" })));
    assert.ok(other.has("IDENTITY_ROLE_MISMATCH") && !other.has("IDENTITY_BUILTIN_ROLE"));
  });

  it("refuses built-in roles in the URL as developer credentials", () => {
    for (const role of ["supabase_auth_admin", "pg_monitor"]) {
      assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${role}:${PASSWORD}@127.0.0.1:55422/postgres` }), "DB_DEVELOPER_CREDENTIALS");
    }
  });

  it("the probe reads the stack ID, the declared host port and transaction_read_only, and nothing else", () => {
    assert.match(IDENTITY_PROBE_SQL, /current_setting\('kolekto\.itest_db_host_port', true\) as declared_host_port/);
    assert.match(IDENTITY_PROBE_SQL, /current_setting\('transaction_read_only'\) as transaction_read_only/);
    assert.doesNotMatch(IDENTITY_PROBE_SQL, /;|\b(insert|update|delete|alter|set_config|create|drop|set)\s/i);
  });
});

describe("integration environment — Phase 1b developer counterparts and URL overrides", () => {
  it("refuses a test URL that reuses the developer URL's host and port", () => {
    const error = assertRefused(validEnv({ SUPABASE_DB_URL: `postgresql://postgres:postgres@127.0.0.1:55422/postgres` }), "DB_MATCHES_DEVELOPER");
    assert.match(error.message, /SUPABASE_DB_URL/);
  });

  it("refuses a test URL that reuses the developer password, without printing it", () => {
    const error = assertRefused(validEnv({ DATABASE_URL: `postgresql://postgres:${PASSWORD}@127.0.0.1:54322/postgres` }), "DB_MATCHES_DEVELOPER");
    assert.ok(!error.message.includes(PASSWORD));
  });

  it("refuses Mailpit or SMTP ports copied from the developer variables", () => {
    assertRefused(validEnv({ MAILPIT_API: "http://127.0.0.1:55424" }), "MAILPIT_DEVELOPER");
    assertRefused(validEnv({ EMAIL_SMTP_PORT: "55425" }), "SMTP_DEVELOPER");
  });

  it("refuses every ambient PG* variable postgres.js or libpq would read, by name only", () => {
    const error = assertRefused(validEnv({ PGPASSWORD: "leaked-value", PGSSLMODE: "disable", pgappname: "x", PGTARGETSESSIONATTRS: "any" }), "AMBIENT_PG_OVERRIDE");
    for (const name of ["PGPASSWORD", "PGSSLMODE", "pgappname", "PGTARGETSESSIONATTRS"]) assert.match(error.message, new RegExp(name));
    assert.ok(!error.message.includes("leaked-value"));
  });

  it("refuses URL query strings, multi-host URLs and encoded host lists", () => {
    for (const query of ["?options=-c%20role%3Dpostgres", "?target_session_attrs=any", "?application_name=x", "?"]) {
      assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422/postgres${query}` }), "DB_URL_INVALID");
    }
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1:55422,10.0.0.1:5432/postgres` }), "DB_URL_INVALID");
    assertRefused(validEnv({ KOLEKTO_ITEST_DB_URL: `postgresql://${ITEST_DB_ROLE}:${PASSWORD}@127.0.0.1%2c10.0.0.1:55422/postgres` }), "DB_HOST_NOT_LOOPBACK");
  });

  it("keeps the decoded password as a redacted Secret", () => {
    const config = parseIntegrationEnvironment(validEnv());
    assert.equal(config.db.password.reveal(), PASSWORD);
    for (const text of [String(config.db.password), JSON.stringify(config.db), inspect(config.db, { depth: 5 })]) {
      assert.ok(!text.includes(PASSWORD));
    }
  });
});
