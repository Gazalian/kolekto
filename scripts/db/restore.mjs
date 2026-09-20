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

// Duplicate-key notices are expected when restoring over seeded rows and are
// not failures; anything else is worth reading.
const problems = (result.stderr ?? "")
  .split("\n")
  .filter((line) => line.trim() !== "" && !/duplicate key value|already exists/i.test(line));

if (problems.length > 0) {
  console.warn("Restored with notices:");
  for (const line of problems.slice(0, 20)) console.warn(`  ${line}`);
}

console.log("Done. Sign in with the same email address you used before — the account came back with the data.");
