#!/usr/bin/env node
/**
 * membership-id-plaintext-backfill.mjs — ITEST ONLY, one-time.
 *
 * Owner decision A1 (2026-11-23): membership IDs are stored as plaintext.
 * Migration 20261123120000 adds the plaintext columns; this script fills them
 * for the LIVE rows issued under the old encrypted design (20261123100100), by
 * decrypting each row's AES-256-GCM ciphertext with the itest secret.
 *
 *   node scripts/itest/membership-id-plaintext-backfill.mjs            # dry run (default): reads, verifies, writes nothing
 *   node scripts/itest/membership-id-plaintext-backfill.mjs --apply    # one transaction; all rows or none
 *
 * For every live row with a ciphertext and no plaintext it checks, before any
 * write, that:
 *   · the ciphertext decrypts under the row's own community + member binding;
 *   · HMAC(lookup key, community:canonical(ID)) equals the row's stored id_hash;
 *   · the ID starts with the row's prefix + separator and ends with its last2.
 * If ANY row fails, nothing is written and the script exits non-zero.
 *
 * Revoked rows are never touched: their ciphertext was erased by design, and
 * they stay as permanently reserved fingerprints (owner decision D1).
 *
 * Never prints, logs or returns a plaintext ID — only the masked form.
 * Refuses any database other than the itest stack on 127.0.0.1:55422.
 */

import { createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SECRET_FILE = path.join(REPO_ROOT, ".claude", "itest-membership-secret.local");
const ITEST_DB_URL = "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
const KEY_VERSION = 1;
const APPLY = process.argv.includes("--apply");

function refuse(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

const dbUrl = process.env.SUPABASE_DB_URL ?? ITEST_DB_URL;
{
  const u = new URL(dbUrl);
  if (u.hostname !== "127.0.0.1" || u.port !== "55422") refuse(`not the itest database (${u.hostname}:${u.port}).`);
}

let secret;
try {
  secret = readFileSync(SECRET_FILE, "utf8").split(/\r?\n/)[0];
} catch {
  refuse(`cannot read ${path.relative(REPO_ROOT, SECRET_FILE)}.`);
}
if (!secret || secret.length < 32) refuse("the itest membership secret is missing or too short.");

// ── The 20261123100100 key schedule and formats (apps/web/lib/membership-id.ts at that version) ──
function deriveKey(purpose) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), `kolekto-membership-id:${purpose}:v${KEY_VERSION}`, 32));
}
const LOOKUP_KEY = deriveKey("lookup");
const DISPLAY_KEY = deriveKey("display");

function canonical(raw) {
  return raw.toUpperCase().replace(/[\s/\-_.]+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}
function lookupHash(communityId, fullId) {
  return createHmac("sha256", LOOKUP_KEY).update(`${communityId}:${canonical(fullId)}`).digest();
}
function decrypt(communityId, memberId, ciphertext) {
  const match = /^v(\d+)\.([A-Za-z0-9_-]+)$/.exec(ciphertext);
  if (!match || Number(match[1]) !== KEY_VERSION) return null;
  const raw = Buffer.from(match[2], "base64url");
  if (raw.length < 12 + 16 + 1) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", DISPLAY_KEY, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${communityId}:${memberId}`, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });

try {
  const [marker] = await sql`select exists (select 1 from pg_roles where rolname = 'kolekto_itest_worker') as itest`;
  if (!marker?.itest) refuse("the connected database has no kolekto_itest_worker role; it is not the itest stack.");
  const [hasFn] = await sql`select to_regprocedure('app.backfill_membership_id_plaintext(uuid, text)') is not null as ok`;
  // A dry run may run before the migration (it only reads and decrypts); --apply needs it.
  if (APPLY && !hasFn?.ok) refuse("migration 20261123120000 is not applied (app.backfill_membership_id_plaintext is missing).");
  const migrated = hasFn?.ok === true;

  const rows = migrated
    ? await sql`
        select id, community_id, member_id, id_hash, id_ciphertext, prefix, separator, last2
        from public.membership_ids
        where revoked_at is null and membership_id is null and id_ciphertext is not null
        order by issued_at, id`
    : await sql`
        select id, community_id, member_id, id_hash, id_ciphertext, prefix, separator, last2
        from public.membership_ids
        where revoked_at is null and id_ciphertext is not null
        order by issued_at, id`;
  const [{ legacy }] = await sql`
    select count(*)::int as legacy from public.membership_ids where id_ciphertext is null`;

  console.log(`mode: ${APPLY ? "APPLY" : "dry run"}; live rows to backfill: ${rows.length}; fingerprint-only rows left untouched: ${legacy}`);

  const plan = [];
  let failures = 0;
  for (const r of rows) {
    const masked = `${r.prefix}${r.separator}…${r.last2}`;
    const fullId = decrypt(r.community_id, r.member_id, r.id_ciphertext);
    const checks = {
      decrypts: fullId !== null,
      hashMatches: fullId !== null && r.id_hash !== null && timingSafeEqual(lookupHash(r.community_id, fullId), Buffer.from(r.id_hash)),
      shapeMatches: fullId !== null && fullId.startsWith(`${r.prefix}${r.separator}`) && fullId.endsWith(r.last2),
    };
    const ok = checks.decrypts && checks.hashMatches && checks.shapeMatches;
    if (!ok) failures += 1;
    console.log(`  ${r.id}  ${masked}  ${ok ? "ok" : `FAILED ${JSON.stringify(checks)}`}`);
    if (ok) plan.push({ id: r.id, fullId });
  }

  if (failures > 0) {
    console.error(`${failures} row(s) failed verification. Nothing was written.`);
    process.exitCode = 1;
  } else if (!APPLY) {
    console.log("dry run: every row verified; nothing written. Re-run with --apply to write.");
  } else {
    await sql.begin(async (tx) => {
      for (const p of plan) await tx`select app.backfill_membership_id_plaintext(${p.id}, ${p.fullId})`;
      const [{ missing }] = await tx`
        select count(*)::int as missing from public.membership_ids where revoked_at is null and membership_id is null`;
      if (missing !== 0) throw new Error(`after backfill ${missing} live row(s) still lack plaintext; rolled back`);
    });
    console.log(`applied: ${plan.length} row(s) backfilled in one transaction.`);
  }
} catch (error) {
  // Error text from the database never contains the ID (the SQL functions do not echo it).
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
