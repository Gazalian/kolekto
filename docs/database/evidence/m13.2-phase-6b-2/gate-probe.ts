// Read-only preflight probe (M13.2 Phase 6B-2 retry). Runs the real gate verify/postflight and the
// lane's pure file checks. It never calls runIntegrationLane, runTests or connectVerified, and prints
// no password, stack ID or connection string.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2]!;
const sup = (f: string) => pathToFileURL(path.join(repo, "apps/worker/test/support", f)).href;
const { loadIntegrationEnvironment, ITEST_ENV_FILE_PATH } = await import(sup("itest-env-file.ts"));
const { createIntegrationGate } = await import(sup("itest-gate.ts"));
const { liveGateDeps } = await import(sup("itest-db.ts"));
const lane = await import(sup("itest-lane.ts"));

const loaded = await loadIntegrationEnvironment({ processEnv: process.env, readFile: (p: string) => readFile(p, "utf8"), filePath: ITEST_ENV_FILE_PATH });
const live = liveGateDeps();
let facts: Record<string, unknown> = {};
const gate = createIntegrationGate({
  ...live,
  env: { ...loaded, KOLEKTO_ITEST_REQUIRED: "1" },
  probeIdentity: async (db: unknown) => {
    const f = (await live.probeIdentity(db as never)) as Record<string, unknown>;
    facts = f;
    return f;
  },
});
const env = await gate.verify();
console.log("gate.verify: accepted");
console.log("endpoint db:", `${env.db.host}:${env.db.port}`, "role", env.db.role, "database", env.db.database);
console.log("endpoint smtp:", `${env.smtp.host}:${env.smtp.port}`, "mailpit api:", env.mailpitApi.origin);
console.log("identity:", JSON.stringify({ currentUser: facts["currentUser"], sessionUser: facts["sessionUser"], currentDatabase: facts["currentDatabase"], serverPort: facts["serverPort"], declaredHostPort: facts["declaredHostPort"], transactionReadOnly: facts["transactionReadOnly"], stackIdSet: typeof facts["stackId"] === "string" && (facts["stackId"] as string).length > 0 }));
await gate.postflight();
console.log("gate.postflight: accepted");

const dir = path.join(lane.WORKER_ROOT, lane.INTEGRATION_DIR);
const names = (await readdir(dir, { recursive: true })).filter((e: string) => e.endsWith(".test.ts")).sort();
const listed = await Promise.all(names.map(async (rel: string) => {
  const filePath = path.join(lane.INTEGRATION_DIR, rel);
  return { path: filePath, source: await readFile(path.join(lane.WORKER_ROOT, filePath), "utf8") };
}));
const files = lane.checkIntegrationFiles(listed, lane.INTEGRATION_MANIFEST);
lane.checkSmtpDeclarations(listed, lane.SMTP_INTEGRATION_FILES);
console.log("manifest:", lane.INTEGRATION_MANIFEST.length, "disk:", files.length, "checks passed");
console.log("smtp files:", lane.SMTP_INTEGRATION_FILES.map((f: string) => path.posix.basename(f)).join(", "));
const withMode = lane.selectLaneFiles(files, lane.SMTP_INTEGRATION_FILES, lane.parseLaneArgs(["--with-smtp"]));
const withoutMode = lane.selectLaneFiles(files, lane.SMTP_INTEGRATION_FILES, lane.parseLaneArgs(["--without-smtp"]));
console.log("--with-smtp run/withheld:", withMode.run.length, withMode.withheld.length, "--without-smtp run/withheld:", withoutMode.run.length, withoutMode.withheld.length);
for (const args of [[], ["--linked"]]) {
  try {
    lane.parseLaneArgs(args);
    console.log(JSON.stringify(args), "accepted (unexpected)");
  } catch (e) {
    console.log(JSON.stringify(args), "refused:", (e as { violations?: { code: string }[] }).violations?.map((v) => v.code).join(","));
  }
}
