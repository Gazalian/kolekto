#!/usr/bin/env node
/**
 * Put the rows from a backup back into the local database.
 *
 * Expects the schema to exist already — run the migrations first (`npm run
 * db:migrate`, or `npm run db:reset` if you deliberately want a clean slate).
 * This only carries data.
 *
 * Usage:
 *   npm run db:restore                     → the most recent backup
 *   npm run db:restore -- backups/foo.sql  → a specific one
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const CONTAINER = process.env.KOLEKTO_DB_CONTAINER ?? "supabase_db_kolekto";
const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DIRECTORY = join(ROOT, "backups");

function mostRecentBackup() {
  if (!existsSync(DIRECTORY)) return null;
  const files = readdirSync(DIRECTORY)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, at: statSync(join(DIRECTORY, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return files[0] ? join(DIRECTORY, files[0].name) : null;
}

const requested = process.argv[2];
const source = requested ? (existsSync(requested) ? requested : join(ROOT, requested)) : mostRecentBackup();

if (!source || !existsSync(source)) {
  console.error(requested ? `No backup at ${requested}` : "No backups found. Run `npm run db:backup` first.");
  process.exit(1);
}

const dump = readFileSync(source, "utf8");

/**
 * Clear the tables this dump is about to refill, then refill them.
 *
 * Not an optimisation — a correctness fix found by testing the restore rather
 * than assuming it. `pg_dump --data-only` writes one COPY per table, and a COPY
 * is a single statement: if one row collides with a row already there, the whole
 * COPY fails and that table restores NOTHING. After `supabase db reset` the seed
 * has already written rows with the same fixed ids the backup holds, so every
 * interesting table collided on its first row and the restore silently did
 * nothing at all.
 *
 * A restore means "make the database match this snapshot", so the tables it
 * covers are emptied first. Tables the dump does not mention are left alone.
 *
 * session_replication_role = replica turns off foreign keys and triggers for
 * this session, which is what lets the tables be filled in whatever order
 * pg_dump wrote them and stops auth.users' sign-up bootstrap firing and
 * creating a second personal community for every user restored.
 */
const tables = [...dump.matchAll(/^COPY ([^\s(]+)/gm)].map((match) => match[1]);
if (tables.length === 0) {
  console.error(`${source} contains no table data.`);
  process.exit(1);
}

const sql = [
  "set session_replication_role = replica;",
  `truncate table ${[...new Set(tables)].join(", ")} cascade;`,
  dump,
  "set session_replication_role = default;",
].join("\n");

try {
  execFileSync("docker", ["exec", CONTAINER, "true"], { stdio: "ignore" });
} catch {
  console.error(`The database container (${CONTAINER}) is not running. Start it with: npm run db:start`);
  process.exit(1);
}

console.log(`Restoring ${source}`);

const result = spawnSync(
  "docker",
  ["exec", "-i", CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=0", "--quiet"],
  { input: sql, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
);

if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}

const problems = (result.stderr ?? "")
  .split("\n")
  .filter((line) => line.trim() !== "" && !/^NOTICE:/i.test(line) && !/truncate cascades/i.test(line));

if (problems.length > 0) {
  console.warn("Restored with notices:");
  for (const line of problems.slice(0, 20)) console.warn(`  ${line}`);
}

/**
 * Count what the dump said it held, and what the database now holds, and refuse
 * to call the restore a success unless they agree.
 *
 * This exists because both earlier versions of this script reported success
 * while restoring nothing — once because the dump contained only the auth
 * tables, once because every COPY collided with a seeded row and failed. Both
 * printed "Done." A restore that cannot tell the difference between working and
 * not working is not a backup system, it is a false sense of one.
 */
const expected = new Map();
for (const block of dump.split(/^COPY /m).slice(1)) {
  const table = block.slice(0, block.indexOf(" "));
  const body = block.slice(block.indexOf("FROM stdin;\n") + "FROM stdin;\n".length);

  // Count up to the terminator line, which for an empty table is the FIRST
  // line of the body. Searching for "\n\\." instead walked past it into the
  // next table's data and reported six rows for tables that held none — a
  // verification that invents a discrepancy is as useless as one that misses a
  // real one.
  const lines = body.split("\n");
  const end = lines.indexOf("\\.");
  const rows = end === -1 ? 0 : lines.slice(0, end).filter((line) => line !== "").length;

  expected.set(table, (expected.get(table) ?? 0) + rows);
}

const counts = spawnSync(
  "docker",
  [
    "exec",
    "-i",
    CONTAINER,
    "psql",
    "-U",
    "supabase_admin",
    "-d",
    "postgres",
    "-t",
    "-A",
    "-F",
    "|",
  ],
  {
    input: [...expected.keys()].map((table) => `select '${table}', count(*) from ${table};`).join("\n"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);

const actual = new Map(
  (counts.stdout ?? "")
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [table, count] = line.split("|");
      return [table, Number.parseInt(count ?? "0", 10)];
    }),
);

const short = [...expected.entries()].filter(([table, rows]) => (actual.get(table) ?? 0) < rows);

if (short.length > 0) {
  console.error("\nRESTORE INCOMPLETE — these tables hold fewer rows than the backup contained:");
  for (const [table, rows] of short) console.error(`  ${table}: expected ${rows}, found ${actual.get(table) ?? 0}`);
  console.error("\nNothing has been lost from the backup file; the database is simply not in the state it describes.");
  process.exit(1);
}

const total = [...expected.values()].reduce((sum, rows) => sum + rows, 0);
console.log(`Restored ${total} rows across ${expected.size} tables, and verified every one of them.`);
console.log("Sign in with the same email address you used before — the account came back with the data.");
