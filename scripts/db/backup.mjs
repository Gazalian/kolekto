#!/usr/bin/env node
/**
 * Snapshot the local database's DATA — yours, not the schema's.
 *
 * Why this exists: `supabase db reset` drops the database and re-seeds it. It
 * is the standard way to apply a new migration locally, and it deletes every
 * community, collection, member and audit row someone created by hand, plus the
 * `auth.users` row they sign in with. That is a development workflow eating a
 * person's work, and it happened here on 2026-09-20 before this script existed.
 *
 * What it captures:
 *   · every table in `public` (the whole application record)
 *   · `auth.users` and `auth.identities`, so the same email signs in afterwards
 *     to the same account rather than a new one
 *
 * Data only: the schema comes from `supabase/migrations`, which is the only
 * thing allowed to define it (ADR 0007). Restoring therefore means "apply the
 * migrations, then put the rows back", which is `npm run db:restore`.
 *
 * Usage:
 *   npm run db:backup            → backups/kolekto-<timestamp>.sql
 *   npm run db:backup -- my-name → backups/my-name.sql
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const CONTAINER = process.env.KOLEKTO_DB_CONTAINER ?? "supabase_db_kolekto";
const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DIRECTORY = join(ROOT, "backups");

const label = process.argv[2] ?? `kolekto-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const target = join(DIRECTORY, `${label}.sql`);

// --disable-triggers: the schema is full of guards that exist to stop a person
// deleting financial history (COL-14, OBL-05, the append-only audit log). They
// would also fire during a restore, where they are wrong — a restore is not an
// edit, it is putting back what was already there.
const args = [
  "exec",
  CONTAINER,
  "pg_dump",
  "-U",
  "postgres",
  "--data-only",
  "--disable-triggers",
  "--no-owner",
  "--schema",
  "public",
  "--table",
  "auth.users",
  "--table",
  "auth.identities",
  "postgres",
];

try {
  mkdirSync(DIRECTORY, { recursive: true });
  const dump = execFileSync("docker", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

  if (dump.trim() === "") {
    console.error("The dump came back empty. Is the local stack running (npm run db:start)?");
    process.exit(1);
  }

  writeFileSync(target, dump, "utf8");
  const { size } = statSync(target);
  console.log(`Saved ${(size / 1024).toFixed(1)} KB to ${target}`);
  console.log("Restore it with:  npm run db:restore");
} catch (error) {
  console.error("Backup failed:", error instanceof Error ? error.message : error);
  console.error(`Is the database container running? Expected one named ${CONTAINER}.`);
  process.exit(1);
}
