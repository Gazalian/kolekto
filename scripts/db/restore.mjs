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

// A restore adds rows the database may already hold — the seed writes some of
// them on every reset. Existing rows are left alone rather than duplicated or
// overwritten: ON CONFLICT DO NOTHING is not something pg_dump emits, so the
// insert is wrapped per statement and conflicts are reported, not fatal.
const sql = readFileSync(source, "utf8");

try {
  execFileSync("docker", ["exec", CONTAINER, "true"], { stdio: "ignore" });
} catch {
  console.error(`The database container (${CONTAINER}) is not running. Start it with: npm run db:start`);
  process.exit(1);
}

console.log(`Restoring ${source}`);

const result = spawnSync(
  "docker",
  ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=0", "--quiet"],
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
