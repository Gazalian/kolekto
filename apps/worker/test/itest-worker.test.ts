/**
 * itest-worker.test.ts — M13.2 Phase 7. Unit tests of the real-worker harness: the child's
 * environment, the log scan, the lane's runtime group and the fault proxy. No database and no worker;
 * the proxy runs against an in-process stand-in on loopback.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { IntegrationGateError, parseIntegrationEnvironment, Secret } from "./support/itest-environment.ts";
import { createIntegrationGate, type VerifiedIntegrationEnvironment } from "./support/itest-gate.ts";
import { parseLaneArgs, runIntegrationLane, selectLaneFiles, SWITCH_GRANT_VARIABLE, WORKER_RELIABILITY_FILES, WORKER_RUNTIME_FILES, type LaneDeps, type SourceFile } from "./support/itest-lane.ts";
import { assertSeedOwned } from "./support/itest-queue-seed.ts";
import { findClosedLoopbackPort, startFaultProxy, startLoopbackFaultProxy, type FaultProxy } from "./support/itest-smtp-fault-proxy.ts";
import { ALLOW_SWITCH_VARIABLE, withSendingEnabled, type SwitchContext } from "./support/itest-switch.ts";
import { assertEvidenceFolderWritable, assertQueueUpdateColumns, buildWorkerEnv, parseRemoteAddresses, QUEUE_FROZEN_COLUMNS, QUEUE_UPDATE_COLUMNS, RUNTIME_EVIDENCE_DIR, scanWorkerLog, SEALED_EVIDENCE_FOLDERS, workerBuildArgs } from "./support/itest-worker.ts";

const SUPPORT = fileURLToPath(new URL("./support/", import.meta.url));
const STACK_ID = "7e0a4a5c-1b1d-4a6f-9f43-0c9b2d3e4f50";
const PASSWORD = "itest-owner-password-long-enough";
const ENV = {
  KOLEKTO_ITEST_REQUIRED: "1",
  KOLEKTO_ITEST_DB_URL: `postgresql://kolekto_itest:${PASSWORD}@127.0.0.1:55422/postgres`,
  KOLEKTO_ITEST_SMTP_PORT: "55425",
  KOLEKTO_ITEST_MAILPIT_API: "http://127.0.0.1:55424",
  KOLEKTO_ITEST_STACK_ID: STACK_ID,
};

async function verifiedEnv(): Promise<VerifiedIntegrationEnvironment> {
  const gate = createIntegrationGate({
    env: ENV,
    probeIdentity: async () => ({
      rowCount: 1, currentUser: "kolekto_itest", sessionUser: "kolekto_itest", currentDatabase: "postgres", serverPort: 5432,
      stackId: STACK_ID, declaredHostPort: "55422", transactionReadOnly: "on",
    }),
    readPauseSwitch: async () => ({ rowCount: 1, enabled: false }),
  });
  return gate.verify();
}

describe("new runs cannot touch sealed evidence (R-5)", () => {
  const ROOT = path.resolve("evidence-root");

  it("the harness's default output is not a sealed folder", () => {
    assert.doesNotThrow(() => assertEvidenceFolderWritable(RUNTIME_EVIDENCE_DIR));
    for (const folder of SEALED_EVIDENCE_FOLDERS) assert.ok(!RUNTIME_EVIDENCE_DIR.includes(folder), folder);
  });

  it("every sealed folder, and anything inside one, is refused, however the path is spelled", () => {
    assert.deepEqual([...SEALED_EVIDENCE_FOLDERS], ["m13.2-phase-6b-2", "m13.2-phase-7", "m13.2-phase-8"]);
    for (const folder of SEALED_EVIDENCE_FOLDERS) {
      for (const dir of [path.join(ROOT, folder), path.join(ROOT, folder, "runtime", "tag"), path.join(ROOT, "new", "..", folder, "runtime")]) {
        assert.throws(() => assertEvidenceFolderWritable(dir, ROOT), (e: unknown) => e instanceof IntegrationGateError && e.has("EVIDENCE_SEALED"), dir);
      }
    }
  });

  it("a new folder is allowed, including one whose name only starts the same", () => {
    assert.doesNotThrow(() => assertEvidenceFolderWritable(path.join(ROOT, "m13.2-regression", "runtime"), ROOT));
    assert.doesNotThrow(() => assertEvidenceFolderWritable(path.join(ROOT, "m13.2-phase-8-rerun", "runtime"), ROOT));
  });

  it("the new lane script refuses the sealed folders, and only reads from them", () => {
    const script = readFileSync(path.join(SUPPORT, "..", "..", "..", "..", "scripts", "itest", "run-lane.sh"), "utf8");
    for (const folder of SEALED_EVIDENCE_FOLDERS) assert.ok(script.includes(folder), folder);
    assert.match(script, /refusing: \$folder is sealed/);
    assert.match(script, /lane="\$repo\/docs\/database\/evidence\/\$folder\/lane"/);
    assert.equal([...script.matchAll(/m13\.2-phase-8\/method\/state\.sql/g)].length, 1);
    assert.doesNotMatch(script, /> *"?\$repo\/docs\/database\/evidence\/m13\.2-phase/, "nothing is redirected into a sealed folder");
  });
});

describe("the worker role's queue columns (R-3)", () => {
  const read = (over: Record<string, boolean> = {}) => ({ update_vt: true, update_read_ct: true, update_headers: true, update_message: false, update_enqueued_at: false, update_msg_id: false, ...over });
  const refused = (e: unknown) => e instanceof IntegrationGateError && e.has("WORKER_ROLE_INVALID");

  it("accepts exactly the narrowed set", () => {
    assert.doesNotThrow(() => assertQueueUpdateColumns(read()));
  });

  it("refuses a role that can rewrite a message body, falsify its age or change its id", () => {
    for (const column of QUEUE_FROZEN_COLUMNS) assert.throws(() => assertQueueUpdateColumns(read({ [`update_${column}`]: true })), refused, column);
  });

  it("refuses the table-wide grant the Phase 8 role held, so the test stack must be narrowed before a worker lane", () => {
    assert.throws(() => assertQueueUpdateColumns(read({ update_message: true, update_enqueued_at: true, update_msg_id: true })), refused);
  });

  it("refuses a role that cannot write what pgmq.read and the worker write", () => {
    for (const column of QUEUE_UPDATE_COLUMNS) assert.throws(() => assertQueueUpdateColumns(read({ [`update_${column}`]: false })), refused, column);
  });

  it("fails closed on a reading that says nothing", () => {
    assert.throws(() => assertQueueUpdateColumns({}), refused);
  });

  it("LP-3 asserts both refusals against the real role, for when the lane runs", () => {
    const source = readFileSync(path.join(SUPPORT, "..", "integration", "notification-worker-runtime.integration.test.ts"), "utf8");
    assert.ok(source.includes("q_notification_events set message = "));
    assert.ok(source.includes("q_notification_events set enqueued_at = "));
  });
});

describe("E6, E7 and P9-4 cannot pass just because sending is paused", () => {
  const source = readFileSync(path.join(SUPPORT, "..", "integration", "notification-sender.integration.test.ts"), "utf8");
  const body = (title: string, next: string) => source.slice(source.indexOf(title), source.indexOf(next, source.indexOf(title)));

  it("each proves the reason, and E6 and E7 first prove the same row was claimable", () => {
    const e6 = body('it("E6:', 'it("E7:');
    const e7 = source.slice(source.indexOf('it("E7:'));
    const p94 = body('it("P9-4:', "// R11");
    for (const [name, test] of [["E6", e6], ["E7", e7]] as const) {
      const control = test.indexOf("assertClaimableNow(sql, id)");
      const change = test.indexOf("update public.notification_deliveries");
      const reason = test.indexOf("assertNothingDue(sql)");
      const sender = test.indexOf("sendOneClaimed");
      assert.ok(control >= 0 && control < change && change < reason && reason < sender, name);
    }
    assert.ok(p94.indexOf("assertNothingDue(sql)") >= 0 && p94.indexOf("assertNothingDue(sql)") < p94.indexOf("sendOneClaimed"));
  });

  it("the helpers demand the database's own reason, not the sender's summary of it", () => {
    assert.match(source, /assert\.equal\(control\.reason, "claimed"/);
    assert.match(source, /assert\.equal\(claim\.reason, "empty"/);
  });
});

describe("the pause-switch proposal's inventory", () => {
  const REPO = path.join(SUPPORT, "..", "..", "..", "..");
  const proposal = readFileSync(path.join(REPO, "docs", "database", "proposals", "M13.2-FINAL-pause-switch-enforcement.proposed.sql"), "utf8");
  const superseded = readFileSync(path.join(REPO, "docs", "database", "proposals", "M13.2-P8-pause-switch-enforcement.proposed.sql"), "utf8");
  const integration = (name: string) => readFileSync(path.join(SUPPORT, "..", "integration", `${name}.integration.test.ts`), "utf8");

  it("the function it would install is the one the Phase 8 file proposed: only the header changed", () => {
    const fn = (text: string) => text.slice(text.indexOf("create or replace function")).replaceAll("\r\n", "\n");
    assert.equal(fn(proposal), fn(superseded));
  });

  it("lists 18 numbered tests, each a real test title in the file it names", () => {
    const listed = [...proposal.matchAll(/^--\s+(\d+)\.\s+(.+)$/gm)].map((m) => [Number(m[1]), m[2]!.trim()] as const);
    assert.deepEqual(listed.map(([n]) => n), Array.from({ length: 18 }, (_, i) => i + 1));
    const files = ["notification-sender", "notification-sender-mailpit", "notification-e2e-mailpit", "notification-send-claim"].map(integration);
    for (const [n, title] of listed) assert.ok(files.some((f) => f.includes(`it("${title}`)), `${n}: ${title}`);
  });

  it("the counts agree with what the test files really do", () => {
    const calls = (source: string, name: string) => [...source.matchAll(new RegExp(String.raw`\b${name}\(`, "g"))].length;
    assert.equal(calls(integration("notification-rate-limit"), "claimNextDelivery"), 0, "rate-limit never uses the unscoped claim");
    assert.equal(calls(integration("notification-rate-limit"), "sendOneClaimed"), 0);
    assert.ok(calls(integration("notification-send-claim"), "claimNextDelivery") >= 2);
    assert.match(proposal, /notification-rate-limit: 0 of 3/);
    assert.match(proposal, /37_notification_send_claims\.sql: 7 of 59 assertions/);
    const pgtap = readFileSync(path.join(REPO, "supabase", "tests", "37_notification_send_claims.sql"), "utf8");
    assert.equal([...pgtap.matchAll(/^\s*\(select \w+ from app\.claim_next_notification_delivery\(/gm)].length, 2);
    assert.match(pgtap, /select plan\(59\);/);
  });
});

describe("the runbook's corrections (R-6, R-7)", () => {
  const runbook = readFileSync(path.join(SUPPORT, "..", "..", "..", "..", "docs", "runbooks", "worker-deployment-operator-guide.md"), "utf8");

  it("holds no 90-second drain reference, and all four corrected values are there", () => {
    assert.doesNotMatch(runbook, /drain budget[^.\n]{0,20}\b90\b|terminationGracePeriodSeconds: 90|TimeoutStopSec=90|≥ 90 s/);
    assert.match(runbook, /drain budget \(150 s\)/);
    assert.match(runbook, /terminationGracePeriodSeconds: 150/);
    assert.match(runbook, /TimeoutStopSec=150/);
    assert.match(runbook, /drain budget must be ≥ 150 s/);
  });

  it("the unit's start limit is in [Unit], not [Service]", () => {
    const unit = /```ini\r?\n([\s\S]*?)```/.exec(runbook)?.[1] ?? "";
    const section = (name: string) => new RegExp(String.raw`\[${name}\]([\s\S]*?)(?=\n\[|$)`).exec(unit)?.[1] ?? "";
    assert.match(section("Unit"), /^StartLimitIntervalSec=300$/m);
    assert.match(section("Unit"), /^StartLimitBurst=3$/m);
    assert.doesNotMatch(section("Service"), /StartLimit/);
    assert.match(section("Service"), /^TimeoutStopSec=150$/m);
    assert.match(section("Service"), /^KillSignal=SIGTERM$/m);
    assert.match(section("Service"), /^Restart=on-failure$/m);
  });
});

describe("the worker child's environment", () => {
  const WORKER_PASSWORD = new Secret("worker-password-for-this-run");

  it("is built from nothing: dangerous ambient variables never reach the child", async () => {
    const env = await verifiedEnv();
    const child = buildWorkerEnv(env, { database: { kind: "verified", password: WORKER_PASSWORD } }, {
      PATH: "/bin", SystemRoot: "C:\\Windows",
      SUPABASE_DB_URL: "postgresql://postgres:postgres@prod.supabase.co:5432/postgres",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", EMAIL_API_KEY: "key", EMAIL_AWS_SECRET_ACCESS_KEY: "secret",
      NODE_OPTIONS: "--require evil.js", PGHOST: "prod", PGPASSWORD: "x", KOLEKTO_ITEST_DB_URL: "x", GITHUB_ACTIONS: "true",
    });
    assert.deepEqual(Object.keys(child).sort(), [
      "APP_BASE_URL", "EMAIL_FROM", "EMAIL_PROVIDER", "EMAIL_SMTP_HOST", "EMAIL_SMTP_PORT", "KOLEKTO_ENV",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "PATH", "PGAPPNAME", "SUPABASE_DB_URL", "SystemRoot",
    ]);
    assert.equal(child["KOLEKTO_ENV"], "local", "the config layer then refuses a real provider");
    assert.equal(child["EMAIL_PROVIDER"], "mailpit");
    assert.equal(child["EMAIL_SMTP_HOST"], "127.0.0.1");
    assert.equal(child["EMAIL_SMTP_PORT"], "55425");
    assert.equal(child["PGAPPNAME"], "kolekto-itest-worker");
  });

  it("connects as the worker role to the verified endpoint, never with the owner password", async () => {
    const env = await verifiedEnv();
    const child = buildWorkerEnv(env, { database: { kind: "verified", password: WORKER_PASSWORD } }, {});
    const url = new URL(child["SUPABASE_DB_URL"]!);
    assert.equal(url.username, "kolekto_itest_worker");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "55422");
    assert.equal(url.pathname, "/postgres");
    assert.ok(!child["SUPABASE_DB_URL"]!.includes(PASSWORD));
  });

  it("the invalid-configuration targets stay on loopback, and a port override only changes the port", async () => {
    const env = await verifiedEnv();
    assert.equal(buildWorkerEnv(env, { database: { kind: "unset" } }, {})["SUPABASE_DB_URL"], undefined);
    assert.equal(new URL(buildWorkerEnv(env, { database: { kind: "closed-port", port: 9, password: WORKER_PASSWORD } }, {})["SUPABASE_DB_URL"]!).hostname, "127.0.0.1");
    assert.equal(buildWorkerEnv(env, { database: { kind: "wrong-password", password: WORKER_PASSWORD } }, {})["SUPABASE_DB_URL"]!.includes("@127.0.0.1:55422/"), true);
    assert.ok(buildWorkerEnv(env, { database: { kind: "malformed-url", password: WORKER_PASSWORD } }, {})["SUPABASE_DB_URL"]!.includes("@127.0.0.1:"));
    const proxied = buildWorkerEnv(env, { database: { kind: "unset" }, smtpPort: 40001 }, {});
    assert.equal(proxied["EMAIL_SMTP_HOST"], "127.0.0.1");
    assert.equal(proxied["EMAIL_SMTP_PORT"], "40001");
    assert.throws(() => buildWorkerEnv(env, { database: { kind: "unset" }, smtpPort: 0 }, {}), (e: unknown) => e instanceof IntegrationGateError && e.has("WORKER_ENV_INVALID"));
    assert.equal(buildWorkerEnv(env, { database: { kind: "unset" }, provider: "none" }, {})["EMAIL_PROVIDER"], undefined);
    assert.equal(buildWorkerEnv(env, { database: { kind: "unset" }, provider: "unsupported" }, {})["EMAIL_SMTP_HOST"], undefined);
  });

  it("never points the worker at a developer-stack port, even a closed one", async () => {
    const env = await verifiedEnv();
    const invalid = (e: unknown) => e instanceof IntegrationGateError && e.has("WORKER_ENV_INVALID");
    assert.throws(() => buildWorkerEnv(env, { database: { kind: "closed-port", port: 54322, password: WORKER_PASSWORD } }, {}), invalid);
    assert.throws(() => buildWorkerEnv(env, { database: { kind: "unset" }, smtpPort: 54325 }, {}), invalid);
  });

  it("refuses an environment no gate issued", () => {
    const parsed = parseIntegrationEnvironment(ENV);
    assert.throws(() => buildWorkerEnv(parsed as VerifiedIntegrationEnvironment, { database: { kind: "unset" } }, {}), (e: unknown) => e instanceof IntegrationGateError && e.has("NOT_VERIFIED"));
  });

  it("builds with the package's own esbuild flags, to a git-ignored path", () => {
    const pkg = JSON.parse(readFileSync(path.join(SUPPORT, "..", "..", "package.json"), "utf8")) as { scripts: { build: string } };
    const args = workerBuildArgs("esbuild");
    for (const flag of pkg.scripts.build.split(" ").filter((f) => f.startsWith("--") && !f.startsWith("--outfile"))) {
      assert.ok(args.includes(flag), flag);
    }
    assert.ok(args.includes("--outfile=dist/itest/index.js"));
    assert.ok(!args.includes("--env-file"));
  });
});

describe("the worker log scan", () => {
  it("finds every sensitive shape and exact secret, and passes ordinary log lines", () => {
    const secret = new Secret("abc-secret-value+1");
    for (const [line, label] of [
      ["postgresql://u:p@127.0.0.1/x", "connection URL"],
      ["postgres://u@h", "connection URL"],
      ["to itest+abcd1234-7@worker-runtime.example.test", "run-scoped recipient address"],
      ["reached real.person@example.com", "address-shaped text"],
      ["call +2348012345678", "phone number"],
      ["Failing row contains (x)", "Failing row detail"],
      ["SCRAM-SHA-256$4096:abc", "SCRAM verifier"],
      ["value abc-secret-value+1", "run secret 1"],
      ["value abc-secret-value%2B1", "run secret 1"],
    ] as const) {
      assert.ok(scanWorkerLog(line, [secret]).includes(label), `${line} → ${label}`);
    }
    const clean = [
      "Kolekto worker: connected. Polling notification_events queue.",
      'Failed to process message 12 (read_ct=1): {"name":"PostgresError","code":"22P02","severity":"ERROR"}',
      '{"msg":"notification_send_health","email_sending_enabled":false}',
      "Email sender configured: provider=mailpit, idempotency=none.",
    ].join("\n");
    assert.deepEqual(scanWorkerLog(clean, [secret]), []);
  });
});

describe("the lane's worker-runtime group", () => {
  const A = "test/integration/a.test.ts";
  const R = "test/integration/r.test.ts";
  const GATED = `import { createIntegrationGate } from "../support/itest-gate.ts";
import { connectVerified, liveGateDeps } from "../support/itest-db.ts";
const gate = createIntegrationGate(liveGateDeps());
await gate.verify(); await gate.postflight(); connectVerified(gate.verified(), { max: 1 });`;
  const FILES: readonly SourceFile[] = [{ path: A, source: GATED }, { path: R, source: `${GATED}\nconst s = gate.verified().smtp;` }];

  function lane(smtpMode: "with" | "without" | "worker-runtime") {
    const spawned: { files: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const log: string[] = [];
    const deps: LaneDeps = {
      env: ENV,
      listIntegrationFiles: async () => FILES,
      runTests: async (files, env) => {
        spawned.push({ files, env });
        return { code: 0, signal: null, output: "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n" };
      },
      log: (t) => log.push(t),
      manifest: [A, R],
      smtpFiles: [R],
      smtpMode,
      runtimeFiles: [R],
    };
    return { deps, spawned, log };
  }

  it("parses --worker-runtime, alone, and still refuses anything else", () => {
    assert.equal(parseLaneArgs(["--worker-runtime"]), "worker-runtime");
    for (const argv of [["--worker-runtime", "--with-smtp"], ["--worker-runtime", "--worker-runtime"], ["--runtime"], ["--worker-runtime", "--linked"]]) {
      assert.throws(() => parseLaneArgs(argv), IntegrationGateError, JSON.stringify(argv));
    }
    assert.deepEqual(selectLaneFiles([A, R], [R], "worker-runtime", [R]), { run: [R], withheld: [A] });
    assert.throws(() => selectLaneFiles([A], [A], "worker-runtime", [R]), IntegrationGateError);
  });

  it("--worker-runtime starts only that file, says the run is partial, and grants the switch to that child", async () => {
    const l = lane("worker-runtime");
    assert.equal(await runIntegrationLane(l.deps), 0);
    assert.deepEqual(l.spawned[0]!.files, [R]);
    assert.equal(l.spawned[0]!.env[SWITCH_GRANT_VARIABLE], "1");
    assert.match(l.log.join("\n"), /WORKER RUNTIME ONLY \(partial run, not the full suite\)/);
  });

  it("--with-smtp runs everything and grants the switch; --without-smtp withholds the file and grants nothing", async () => {
    const full = lane("with");
    assert.equal(await runIntegrationLane(full.deps), 0);
    assert.deepEqual(full.spawned[0]!.files, [A, R]);
    assert.equal(full.spawned[0]!.env[SWITCH_GRANT_VARIABLE], "1");
    const none = lane("without");
    assert.equal(await runIntegrationLane(none.deps), 0);
    assert.deepEqual(none.spawned[0]!.files, [A]);
    assert.equal(none.spawned[0]!.env[SWITCH_GRANT_VARIABLE], undefined, "no grant without the runtime file");
  });

  it("the grant cannot come from the shell: the real entry refuses an ambient KOLEKTO_ITEST_* variable", async () => {
    const { findAmbientItestVariables } = await import("./support/itest-env-file.ts");
    assert.deepEqual(findAmbientItestVariables({ [SWITCH_GRANT_VARIABLE]: "1" }), [SWITCH_GRANT_VARIABLE]);
    assert.equal(WORKER_RUNTIME_FILES.length, 2);
  });

  it("--worker-reliability starts only the F-13, F-14 and F-15 file, says the run is partial, and grants the switch to that child", async () => {
    const files = [WORKER_RELIABILITY_FILES[0]!, ...WORKER_RUNTIME_FILES.filter((f) => f !== WORKER_RELIABILITY_FILES[0]), A];
    assert.equal(parseLaneArgs(["--worker-reliability"]), "worker-reliability");
    assert.throws(() => parseLaneArgs(["--worker-reliability", "--worker-runtime"]), IntegrationGateError);
    assert.deepEqual(selectLaneFiles(files, files, "worker-reliability", WORKER_RUNTIME_FILES).run, [...WORKER_RELIABILITY_FILES]);
    assert.ok(WORKER_RELIABILITY_FILES.every((f) => WORKER_RUNTIME_FILES.includes(f)), "so the switch grant reaches it");

    const spawned: Readonly<Record<string, string>>[] = [];
    const log: string[] = [];
    const code = await runIntegrationLane({
      env: ENV,
      listIntegrationFiles: async () => files.map((path) => ({ path, source: `${GATED}\nconst s = gate.verified().smtp;` })),
      runTests: async (_, env) => {
        spawned.push(env);
        return { code: 0, signal: null, output: "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n" };
      },
      log: (t) => log.push(t),
      manifest: files,
      smtpFiles: files,
      smtpMode: "worker-reliability",
      runtimeFiles: WORKER_RUNTIME_FILES,
    });
    assert.equal(code, 0);
    assert.equal(spawned[0]![SWITCH_GRANT_VARIABLE], "1");
    assert.match(log.join("\n"), /WORKER RELIABILITY ONLY \(partial run, not the full suite\)/);
  });
});

describe("the remote-address sampler", () => {
  it("reads only this process's TCP connections and ignores listeners", () => {
    const netstat = [
      "  TCP    127.0.0.1:50000   127.0.0.1:55422   ESTABLISHED   42",
      "  TCP    127.0.0.1:50001   127.0.0.1:55425   TIME_WAIT     42",
      "  TCP    0.0.0.0:135       0.0.0.0:0         LISTENING     42",
      "  TCP    [::]:445          [::]:0            LISTENING     42",
      "  TCP    10.0.0.2:50002    93.184.216.34:443 ESTABLISHED   43",
      "  TCP    10.0.0.2:50003    93.184.216.34:443 ESTABLISHED   42",
      "  UDP    0.0.0.0:53        *:*                             42",
    ].join("\r\n");
    assert.deepEqual(parseRemoteAddresses(netstat, 42), ["127.0.0.1", "93.184.216.34"], "another process's connection is not counted; this one's is");
    assert.deepEqual(parseRemoteAddresses(netstat, 99), []);
  });
});

describe("the pause-switch helper refuses before touching anything", () => {
  it("without the lane's grant no statement runs", async () => {
    let queries = 0;
    const counting = new Proxy({}, { get: () => () => { queries += 1; throw new Error("no query may run"); } });
    const ctx = { env: await verifiedEnv(), sql: counting, assertMutexHeld: async () => {}, ownsCommunity: () => true } as unknown as SwitchContext;
    assert.equal(process.env[ALLOW_SWITCH_VARIABLE], undefined, "npm test never has the grant");
    await assert.rejects(withSendingEnabled(ctx, async () => {}), (e: unknown) => e instanceof IntegrationGateError && e.has("SWITCH_WRITE_REFUSED"));
    assert.equal(queries, 0);
  });
});

describe("the owned queue seed", () => {
  const owner = { owns: (id: string) => id === "mine" };
  it("refuses a message for a community the current test did not create", () => {
    assert.doesNotThrow(() => assertSeedOwned(owner, { community_id: "mine" }));
    for (const message of [{ community_id: "other" }, {}, { community_id: 7 }]) {
      assert.throws(() => assertSeedOwned(owner, message), (e: unknown) => e instanceof IntegrationGateError && e.has("QUEUE_SEED_NOT_OWNED"));
    }
  });
});

// ── The fault proxy, against a small SMTP stand-in on loopback ────────────────

function fakeSmtp(): Promise<{ port: number; bodies: () => number; close: () => Promise<void> }> {
  let bodies = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("latin1");
    socket.write("220 fake\r\n");
    let inData = false;
    let tail = "";
    socket.on("data", (chunk: string) => {
      if (inData) {
        tail = (tail + chunk).slice(-5);
        if (tail === "\r\n.\r\n") {
          inData = false;
          bodies += 1;
          socket.write("250 accepted\r\n");
        }
        return;
      }
      for (const line of chunk.split("\r\n").filter(Boolean)) {
        if (line === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        bodies: () => bodies,
        close: () => {
          for (const s of sockets) s.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** A minimal client: sends each command after the previous reply; returns the codes seen, or "closed". */
function converse(port: number, lines: readonly string[]): Promise<(number | "closed")[]> {
  return new Promise((resolve) => {
    const seen: (number | "closed")[] = [];
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("latin1");
    let next = 0;
    socket.on("data", (chunk: string) => {
      for (const reply of chunk.split("\r\n").filter(Boolean)) {
        seen.push(Number(reply.slice(0, 3)));
        if (next < lines.length) socket.write(lines[next++]!);
        else socket.destroy();
      }
    });
    socket.on("close", () => {
      if (next < lines.length || seen.length <= lines.length) seen.push("closed");
      resolve(seen);
    });
    socket.on("error", () => {});
  });
}

const CONVERSATION = ["EHLO x\r\n", "MAIL FROM:<a@b.test>\r\n", "RCPT TO:<c@d.test>\r\n", "DATA\r\n", "Subject: s\r\n\r\nbody\r\n.\r\n", "QUIT\r\n"];

describe("the SMTP fault proxy", () => {
  async function withProxy(script: Parameters<typeof startLoopbackFaultProxy>[1], fn: (p: FaultProxy, upstream: Awaited<ReturnType<typeof fakeSmtp>>) => Promise<void>) {
    const upstream = await fakeSmtp();
    const proxy = await startLoopbackFaultProxy(upstream.port, script);
    try {
      await fn(proxy, upstream);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  }

  it("passes a whole conversation through and records verbs only", async () => {
    await withProxy({ kind: "pass" }, async (proxy, upstream) => {
      const codes = await converse(proxy.port, CONVERSATION);
      assert.deepEqual(codes.slice(0, 7), [220, 250, 250, 250, 354, 250, 221]);
      assert.equal(upstream.bodies(), 1);
      assert.deepEqual(proxy.connections()[0]!.verbs, ["EHLO", "MAIL", "RCPT", "DATA", "QUIT"]);
      assert.ok(!JSON.stringify(proxy.connections()).includes("c@d.test"), "no address in the proxy's record");
    });
  });

  it("answers a scripted rejection itself; nothing reaches the upstream body", async () => {
    await withProxy({ kind: "reject", verb: "RCPT", code: 451 }, async (proxy, upstream) => {
      const codes = await converse(proxy.port, CONVERSATION.slice(0, 3));
      assert.deepEqual(codes.slice(0, 4), [220, 250, 250, 451]);
      assert.equal(upstream.bodies(), 0);
      assert.equal(proxy.connections()[0]!.outcome, "rejected-451");
    });
  });

  it("deliver-then-drop: the upstream accepts the body, the client never sees the reply", async () => {
    await withProxy({ kind: "deliver-then-drop" }, async (proxy, upstream) => {
      const codes = await converse(proxy.port, CONVERSATION);
      assert.deepEqual(codes, [220, 250, 250, 250, 354, "closed"]);
      assert.equal(upstream.bodies(), 1);
      assert.equal(proxy.connections()[0]!.outcome, "delivered-then-dropped");
    });
  });

  it("hold-after-data: the body never reaches the upstream and the client hears nothing", async () => {
    await withProxy({ kind: "hold-after-data" }, async (proxy, upstream) => {
      const conversation = converse(proxy.port, CONVERSATION.slice(0, 5));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(upstream.bodies(), 0);
      assert.equal(proxy.connections()[0]!.outcome, "held-after-data");
      await proxy.close();
      assert.deepEqual(await conversation, [220, 250, 250, 250, 354, "closed"]);
    });
  });

  it("hold-until-released: the body waits, then reaches the upstream, and the client hears the reply", async () => {
    await withProxy({ kind: "hold-until-released" }, async (proxy, upstream) => {
      const conversation = converse(proxy.port, CONVERSATION);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(upstream.bodies(), 0, "held");
      proxy.release();
      assert.deepEqual((await conversation).slice(0, 7), [220, 250, 250, 250, 354, 250, 221]);
      assert.equal(upstream.bodies(), 1);
    });
  });

  it("a later script applies to the next connection only", async () => {
    await withProxy({ kind: "reject", verb: "MAIL", code: 550 }, async (proxy, upstream) => {
      await converse(proxy.port, CONVERSATION.slice(0, 2));
      proxy.setScript({ kind: "pass" });
      await converse(proxy.port, CONVERSATION);
      assert.equal(upstream.bodies(), 1);
      assert.equal(proxy.connections().length, 2);
    });
  });

  it("cannot forward anywhere but loopback: the host is a constant, and the public entry needs a verified environment", async () => {
    const source = readFileSync(path.join(SUPPORT, "itest-smtp-fault-proxy.ts"), "utf8");
    assert.equal([...source.matchAll(/createConnection\(/g)].length, 1, "one outbound connection site");
    assert.match(source, /net\.createConnection\(\{ host: UPSTREAM_HOST, port: upstreamPort \}\)/);
    assert.match(source, /^const UPSTREAM_HOST = "127\.0\.0\.1";$/m);
    assert.throws(() => startFaultProxy(parseIntegrationEnvironment(ENV) as VerifiedIntegrationEnvironment, { kind: "pass" }), (e: unknown) => e instanceof IntegrationGateError && e.has("NOT_VERIFIED"));
    assert.equal(typeof (await findClosedLoopbackPort()), "number");
  });
});
