/**
 * itest-env-file.ts — how `npm run test:integration` gets its configuration (M13.2 Phase 1c).
 *
 * Decision (Phase 1b report §9.2): the runner itself reads exactly one file,
 * `<repository root>/.env.itest`, written by the Phase 3 test-stack bootstrap
 * and git-ignored by the existing `.env.*` rule. `node --env-file` is not used:
 * it silently lets an already-exported variable win over the file, and it would
 * load the values into the runner's whole process environment.
 *
 * Rules (all fail closed, before any integration file is listed or spawned):
 *   1. No ambient KOLEKTO_ITEST_* variable may be set in the runner's own
 *      environment (ITEST_ENV_AMBIENT). The file is the only source, so a stale
 *      shell export can never override or complement it. Checked before the
 *      file is read.
 *   2. The file must exist (ENV_FILE_MISSING) and be readable
 *      (ENV_FILE_UNREADABLE, errno only).
 *   3. Strict format (ENV_FILE_INVALID): at most 4 KiB; `KEY=value` lines, blank
 *      lines and `#` comment lines only (one leading UTF-8 BOM is tolerated); keys
 *      limited to the four KOLEKTO_ITEST_* names the gate reads; no duplicates;
 *      no quoted values; no `export` prefix. Refusals name a line number or a
 *      key, never a value.
 *   4. No fallback: `.env.local`, `.env`, `SUPABASE_DB_URL`, `DATABASE_URL`,
 *      `EMAIL_*` and `MAILPIT_API` are never read as a source. A missing or
 *      incomplete file is a refusal; parseIntegrationEnvironment then refuses any
 *      missing or invalid value (ENV_MISSING, …).
 *
 * The result is the runner's environment with the four file values added. The
 * lane still validates it statically and still hands the child test process
 * only the allow-listed environment (buildChildEnv), so the child receives the
 * file values and OS essentials — nothing else.
 *
 * This module never creates or writes `.env.itest`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { ITEST_ENV, IntegrationGateError, refuse, type EnvSource, type GateViolation } from "./itest-environment.ts";

export const ITEST_ENV_FILE_NAME = ".env.itest";

/** `<repository root>/.env.itest` (this file lives in apps/worker/test/support/). */
export const ITEST_ENV_FILE_PATH = fileURLToPath(new URL(`../../../../${ITEST_ENV_FILE_NAME}`, import.meta.url));

export const MAX_ENV_FILE_BYTES = 4096;

const ALLOWED_KEYS: ReadonlySet<string> = new Set(Object.values(ITEST_ENV));
const AMBIENT_PREFIX = "KOLEKTO_ITEST_";
const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** Names (never values) of KOLEKTO_ITEST_* variables already present in the runner's environment. */
export function findAmbientItestVariables(env: EnvSource): string[] {
  return Object.keys(env)
    .filter((k) => k.toUpperCase().startsWith(AMBIENT_PREFIX) && env[k] !== undefined)
    .sort();
}

/** Parses .env.itest text strictly. Returns only the allowed keys; throws one refusal listing every problem. */
export function parseItestEnvFile(text: string): Readonly<Record<string, string>> {
  if (typeof text !== "string") throw refuse("ENV_FILE_INVALID", `${ITEST_ENV_FILE_NAME} is not text.`);
  if (Buffer.byteLength(text, "utf8") > MAX_ENV_FILE_BYTES) {
    throw refuse("ENV_FILE_INVALID", `${ITEST_ENV_FILE_NAME} is larger than ${MAX_ENV_FILE_BYTES} bytes.`);
  }
  const out: GateViolation[] = [];
  const values: Record<string, string> = {};
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line === "" || line.startsWith("#")) return;
    const m = LINE.exec(line);
    if (m === null) {
      out.push({ code: "ENV_FILE_INVALID", message: `${ITEST_ENV_FILE_NAME} line ${n} is not a KEY=value line.` });
      return;
    }
    const [, key, value] = m as unknown as [string, string, string];
    if (!ALLOWED_KEYS.has(key)) {
      out.push({ code: "ENV_FILE_INVALID", message: `${ITEST_ENV_FILE_NAME} line ${n} sets ${key}; only ${[...ALLOWED_KEYS].join(", ")} are allowed.` });
      return;
    }
    if (Object.hasOwn(values, key)) {
      out.push({ code: "ENV_FILE_INVALID", message: `${ITEST_ENV_FILE_NAME} sets ${key} more than once (line ${n}).` });
      return;
    }
    if (/^["']/.test(value)) {
      out.push({ code: "ENV_FILE_INVALID", message: `${ITEST_ENV_FILE_NAME} line ${n}: quoted values are not supported.` });
      return;
    }
    values[key] = value;
  });
  if (out.length > 0) throw new IntegrationGateError(out);
  return Object.freeze(values);
}

export interface EnvFileDeps {
  readonly processEnv: EnvSource;
  readonly readFile: (filePath: string) => Promise<string>;
  readonly filePath: string;
}

/**
 * The integration lane's environment: the runner's own environment plus the
 * four values from .env.itest, or a refusal. Never falls back to anything else.
 */
export async function loadIntegrationEnvironment(deps: EnvFileDeps): Promise<EnvSource> {
  const ambient = findAmbientItestVariables(deps.processEnv);
  if (ambient.length > 0) {
    throw refuse("ITEST_ENV_AMBIENT", `${ambient.join(", ")} ${ambient.length === 1 ? "is" : "are"} set in the shell. The integration lane reads its configuration only from ${ITEST_ENV_FILE_NAME}; unset ${ambient.length === 1 ? "it" : "them"}.`);
  }
  let text: string;
  try {
    text = await deps.readFile(deps.filePath);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      throw refuse("ENV_FILE_MISSING", `${ITEST_ENV_FILE_NAME} was not found at the repository root (${path.basename(path.dirname(deps.filePath))}/${ITEST_ENV_FILE_NAME}). It is written by the Phase 3 test-stack bootstrap; there is no fallback.`);
    }
    const tag = typeof code === "string" && /^E[A-Z]{2,20}$/.test(code) ? ` (code ${code})` : "";
    throw refuse("ENV_FILE_UNREADABLE", `${ITEST_ENV_FILE_NAME} could not be read${tag}. Details withheld.`);
  }
  return Object.freeze({ ...deps.processEnv, ...parseItestEnvFile(text) });
}
