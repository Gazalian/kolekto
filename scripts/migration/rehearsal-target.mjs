#!/usr/bin/env node
/**
 * Create or destroy the isolated rehearsal target — a disposable postgres 17
 * container **separate** from the local development stack.
 *
 * Usage:
 *   node scripts/migration/rehearsal-target.mjs up      → create + apply migrations
 *   node scripts/migration/rehearsal-target.mjs down    → stop + remove
 *   node scripts/migration/rehearsal-target.mjs status  → show state
 *
 * It is:
 *   · NOT the development database (that is `supabase_db_kolekto` on 54322)
 *   · NOT staging  (that is a hosted Supabase project)
 *   · NOT legacy production or legacy test
 *   · Named `kolekto-rehearsal-target`, listens on 127.0.0.1:5455, database
 *     `rehearsal`. It carries none of the platform's auth/storage/realtime
 *     machinery — the importer never uses them.
 *
 * Every `down` prompts once with a warning naming the container it will
 * remove. The script refuses to touch any container whose name does not
 * exactly match. A single-word confirmation is required unless
 * REHEARSAL_CONFIRM_DESTROY=yes is set.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const NAME = "kolekto-rehearsal-target";
const HOST_PORT = 5455;
const IMAGE = "postgres:17"; // plain image; the five Supabase-only extensions are stripped in-memory (§D2 approach)
const DB = "postgres"; // pg_cron.database_name is fixed at "postgres" in the Supabase image
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations");

const execFileP = promisify(execFile);
const REFUSED = { development: "supabase_db_kolekto", legacy_read_only: "kolekto-legacy-restore-ro", legacy_old: "kolekto-legacy-restore" };

async function containerState(name) {
  try {
    const { stdout } = await execFileP("docker", ["inspect", "--format", "{{.State.Status}}", name]);
    return stdout.trim();
  } catch { return "absent"; }
}

async function ensureNotProtected(name) {
  for (const [why, protectedName] of Object.entries(REFUSED)) {
    if (name === protectedName) throw new Error(`refusing to touch ${protectedName} (${why})`);
  }
}

async function up() {
  await ensureNotProtected(NAME);
  const state = await containerState(NAME);
  if (state === "running") { console.log(`${NAME} already running on ${HOST_PORT}`); }
  else if (state === "exited") { await execFileP("docker", ["start", NAME]); console.log("started existing container"); }
  else {
    console.log(`creating ${NAME} → 127.0.0.1:${HOST_PORT}, image ${IMAGE}`);
    // `trust` auth: safe here because the container listens on 127.0.0.1 only
    // and holds no real data. Nothing on this port is ever legacy or production.
    await execFileP("docker", [
      "run", "-d", "--name", NAME,
      "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
      "-e", "POSTGRES_PASSWORD=disposable",
      "-p", `127.0.0.1:${HOST_PORT}:5432`,
      IMAGE,
    ]);
  }
  // wait for ready
  for (let i = 0; i < 60; i++) {
    try { await execFileP("docker", ["exec", NAME, "pg_isready", "-U", "postgres", "-q"]); break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  // The rehearsal target lives in the container's default `postgres` database
  // because Supabase's image pins pg_cron to that name. Nothing else uses the
  // container, so this is not shared with anything.
  // Supabase-flavoured migrations expect these roles/schemas. Create the minimum shim.
  const shim = `
    -- Roles the migrations reference. The Supabase image already ships all of
    -- these; this DO-block is defensive for a bare postgres image.
    do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin;          exception when duplicate_object then null; end $$;
    do $$ begin create role anon nologin;                   exception when duplicate_object then null; end $$;
    do $$ begin create role supabase_admin superuser;       exception when duplicate_object then null; end $$;
    grant service_role, authenticated, anon, supabase_admin to postgres;
    create schema if not exists extensions;
    create schema if not exists cron;                                     -- stubs so GRANTs referencing cron.* resolve
    create schema if not exists net;
    grant usage on schema extensions, cron, net to public;
    create extension if not exists pgcrypto      with schema extensions;
    create extension if not exists "uuid-ossp"   with schema extensions;
    create extension if not exists citext        with schema extensions;
    create extension if not exists pg_stat_statements with schema extensions;
    -- storage schema stubs (the collection_cover migration references storage.buckets/objects)
    create schema if not exists storage;
    grant usage on schema storage to postgres, service_role, authenticated, anon;
    create table if not exists storage.buckets (
      id text primary key, name text, public boolean default false, owner uuid,
      created_at timestamptz default now(), updated_at timestamptz default now(),
      file_size_limit bigint, allowed_mime_types text[]
    );
    create table if not exists storage.objects (
      id uuid primary key default extensions.gen_random_uuid(),
      bucket_id text references storage.buckets(id), name text, owner uuid,
      created_at timestamptz default now(), updated_at timestamptz default now(),
      last_accessed_at timestamptz, metadata jsonb, version text
    );
    grant all on all tables in schema storage to postgres, service_role;
    -- auth schema and a tiny auth.users shape (Supabase parity)
    create schema if not exists auth;
    grant usage on schema auth to postgres, service_role, authenticated, anon;
    do $$ begin
      if not exists (select 1 from pg_tables where schemaname='auth' and tablename='users') then
        create table auth.users (
          id uuid primary key,
          instance_id uuid,
          aud text, role text,
          email extensions.citext unique,
          encrypted_password text,
          raw_user_meta_data jsonb default '{}'::jsonb,
          raw_app_meta_data jsonb default '{}'::jsonb,
          phone text,
          created_at timestamptz default now(),
          updated_at timestamptz default now()
        );
      end if;
    end $$;
    create or replace function auth.uid() returns uuid language sql stable as $u$
      select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid
    $u$;
    grant all on all tables in schema auth to postgres, service_role;
  `;
  await execFileP("docker", ["exec", "-i", NAME, "psql", "-X", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-c", shim]);

  // Apply migrations in order
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const { readFile } = await import("node:fs/promises");
  // Strip the five extensions the plain postgres:17 image does not have. The
  // exact same five the D2 restore skipped (D2-RESTORE-VERIFICATION.md §7).
  // This edits the SQL sent to postgres for the rehearsal target only. The
  // migration files on disk are untouched.
  const UNAVAILABLE = /^\s*(create extension|comment on extension)[^\n;]*\b(pg_cron|pg_net|hypopg|index_advisor|supabase_vault|pgmq|pgtap)\b/i;
  const strip = (sql) => sql.split(/\n/).map((line) => UNAVAILABLE.test(line) ? `-- [rehearsal-target] skipped: ${line.trim()}` : line).join("\n");
  for (const f of files) {
    const sql = strip(await readFile(join(MIGRATIONS_DIR, f), "utf8"));
    process.stdout.write(`  ${f} … `);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn("docker", ["exec", "-i", NAME, "psql", "-X", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1"]);
        let err = "";
        child.stderr.on("data", (d) => { err += d.toString(); });
        child.stdin.end(sql);
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${f}: exit ${code}\n${err.slice(0, 800)}`)));
      });
      process.stdout.write("ok\n");
    } catch (e) {
      process.stdout.write("FAIL\n");
      console.error(String(e));
      process.exit(1);
    }
  }
  console.log(`✓ rehearsal target ready: postgres://postgres@127.0.0.1:${HOST_PORT}/${DB}`);
}

async function down() {
  await ensureNotProtected(NAME);
  const state = await containerState(NAME);
  if (state === "absent") { console.log(`${NAME} does not exist`); return; }
  const confirmed = process.env.REHEARSAL_CONFIRM_DESTROY === "yes";
  if (!confirmed) {
    const rl = createInterface({ input, output });
    const answer = await rl.question(`This will remove the container ${NAME}. Type "yes" to confirm: `);
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") { console.log("aborted"); return; }
  }
  await execFileP("docker", ["rm", "-f", NAME]);
  console.log(`removed ${NAME}`);
}

async function status() {
  const state = await containerState(NAME);
  console.log(`container: ${NAME}   state: ${state}   host port: ${HOST_PORT}   database: ${DB}`);
  console.log(`connect (from host): PGPASSWORD=<container-only> psql -h 127.0.0.1 -p ${HOST_PORT} -U postgres -d ${DB}`);
  console.log(`isolated from: local dev (${REFUSED.development}), D2 restore (${REFUSED.legacy_read_only}), any hosted project`);
}

const cmd = process.argv[2];
switch (cmd) {
  case "up": await up(); break;
  case "down": await down(); break;
  case "status": await status(); break;
  default: console.log("usage: rehearsal-target.mjs <up|down|status>"); process.exit(1);
}
