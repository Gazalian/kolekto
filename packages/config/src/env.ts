/**
 * env.ts — environment loading, with the guards that were added to the previous
 * system one incident at a time.
 *
 * ADR 0007. Three behaviours, each earned:
 *
 *   1. FAIL AT IMPORT, NOT AT USE. The previous backend's `utils/client.js`
 *      called `assertSupabaseConfig()` at import time and threw immediately if
 *      the URL or service-role key was missing. Its own comment records why:
 *      "a deliberate fail-fast guard against the anon-key-in-service-role-slot
 *      incident it documents inline." A missing variable becomes a startup
 *      failure, never a runtime surprise on the money path.
 *
 *   2. NO DEFAULTS. Not for the Supabase URL, not for keys, not for anything
 *      that decides which database is being written to. A default is how a
 *      fresh clone ends up talking to production.
 *
 *   3. NON-PRODUCTION ASSERTS IT IS NOT PRODUCTION. The previous repository's
 *      integration tests hard-refused to run against the production project
 *      ref. That guard was right and too narrow — it protected the tests and
 *      nothing else. Here every non-production process checks.
 */

export type KolektoEnvironment = "local" | "staging" | "production";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env.local and fill it in. ` +
        `Nothing is defaulted here on purpose — see docs/adr/0007-environment-isolation.md.`,
    );
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function parseEnvironment(raw: string): KolektoEnvironment {
  if (raw === "local" || raw === "staging" || raw === "production") return raw;
  throw new ConfigError(
    `KOLEKTO_ENV is ${JSON.stringify(raw)}. It must be exactly one of: local, staging, production.`,
  );
}

/** Pull the Supabase project ref out of a project URL, so it can be compared against the production ref. */
export function projectRefFromUrl(url: string): string | null {
  return /^https:\/\/([a-z0-9]{20})\.supabase\.(co|in)/.exec(url)?.[1] ?? null;
}

export interface KolektoConfig {
  readonly environment: KolektoEnvironment;
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly projectRef: string | null;
  readonly logLevel: string;
}

let cached: KolektoConfig | undefined;

/**
 * Load and validate configuration. Called once at process start; throws rather
 * than returning a partially valid object.
 */
export function loadConfig(): KolektoConfig {
  if (cached) return cached;

  const environment = parseEnvironment(required("KOLEKTO_ENV"));
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const supabasePublishableKey = required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const projectRef = projectRefFromUrl(supabaseUrl);

  assertEnvironmentTarget({
    environment,
    supabaseUrl,
    projectRef,
    expectedProjectRef: optional("KOLEKTO_EXPECTED_PROJECT_REF"),
  });
  assertNotProduction({ environment, supabaseUrl, projectRef });

  cached = {
    environment,
    supabaseUrl,
    supabasePublishableKey,
    projectRef,
    logLevel: optional("LOG_LEVEL") ?? "info",
  };
  return cached;
}

/**
 * The guard that matters most.
 *
 * A local or staging process pointed at the production project is not a
 * misconfiguration to be logged — it is a process that must not continue. This
 * has happened: the previous admin panel carries explicit handling for a
 * session token signed by a different Supabase project, which is what that
 * looks like from the other end.
 */
export function assertNotProduction(input: {
  environment: KolektoEnvironment;
  supabaseUrl: string;
  projectRef: string | null;
}): void {
  if (input.environment === "production") return;

  const productionRef = optional("KOLEKTO_PRODUCTION_PROJECT_REF");
  if (!productionRef) return; // Nothing to compare against; nothing to assert.

  if (input.projectRef && input.projectRef === productionRef) {
    throw new ConfigError(
      `REFUSING TO START: KOLEKTO_ENV is "${input.environment}" but NEXT_PUBLIC_SUPABASE_URL points at the ` +
        `PRODUCTION Supabase project (${productionRef}). ` +
        `A non-production process must never read or write production data. ` +
        `Check your .env.local.`,
    );
  }
}

/**
 * The legacy estate: the previous Kolekto's live production project and its test
 * project. The new application never connects to either, in any environment —
 * migration reads the verified D1 backup files, never a legacy database.
 *
 * Deliberately a constant, not configuration. These refs are not secrets (a ref
 * is in every URL a browser sees), and they never change. The guard they replace
 * read its one ref from an environment variable, which meant a missing variable
 * silently switched the guard off — the failure mode this closes.
 */
export const LEGACY_PROJECT_REFS: Readonly<Record<string, string>> = Object.freeze({
  busfgcmbndleljklrcbd: "the LEGACY PRODUCTION project",
  lpeeckqsltxohppheucz: "the LEGACY TEST project",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** True when the URL addresses this machine — the local Supabase stack. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Each environment may only talk to its own kind of database.
 *
 *   every environment   refuses the legacy estate, however the URL is spelled
 *   local               must be this machine
 *   staging             must be a hosted project whose ref equals
 *                       KOLEKTO_EXPECTED_PROJECT_REF — two independent settings
 *                       that have to agree, so a mistyped or copied URL fails
 *   production          nothing further here; it is controlled separately, and
 *                       assertNotProduction keeps non-production away from it
 */
export function assertEnvironmentTarget(input: {
  environment: KolektoEnvironment;
  supabaseUrl: string;
  projectRef: string | null;
  expectedProjectRef: string | undefined;
}): void {
  const url = input.supabaseUrl.toLowerCase();
  for (const [ref, what] of Object.entries(LEGACY_PROJECT_REFS)) {
    if (input.projectRef === ref || url.includes(ref)) {
      throw new ConfigError(
        `REFUSING TO START: NEXT_PUBLIC_SUPABASE_URL points at ${what} (${ref}). ` +
          `The new Kolekto never connects to the legacy estate, in any environment. ` +
          `See docs/environments/staging.md.`,
      );
    }
  }

  if (input.environment === "production") return;

  if (input.environment === "local") {
    if (!isLoopbackUrl(input.supabaseUrl)) {
      throw new ConfigError(
        `REFUSING TO START: KOLEKTO_ENV is "local" but NEXT_PUBLIC_SUPABASE_URL is not this machine. ` +
          `Local talks only to the local Supabase stack (http://127.0.0.1:54321). ` +
          `To use a hosted project, set KOLEKTO_ENV to that project's environment.`,
      );
    }
    return;
  }

  // staging
  if (!input.projectRef) {
    throw new ConfigError(
      `REFUSING TO START: KOLEKTO_ENV is "staging" but NEXT_PUBLIC_SUPABASE_URL is not a hosted Supabase ` +
        `project URL (https://<ref>.supabase.co).`,
    );
  }
  if (!input.expectedProjectRef) {
    throw new ConfigError(
      `REFUSING TO START: KOLEKTO_ENV is "staging" and the URL points at project ${input.projectRef}, but ` +
        `KOLEKTO_EXPECTED_PROJECT_REF is not set. A hosted project must be named explicitly before this ` +
        `process will use it.`,
    );
  }
  if (input.projectRef !== input.expectedProjectRef) {
    throw new ConfigError(
      `REFUSING TO START: NEXT_PUBLIC_SUPABASE_URL points at project ${input.projectRef}, but ` +
        `KOLEKTO_EXPECTED_PROJECT_REF is ${input.expectedProjectRef}. The two must name the same project.`,
    );
  }
}

/**
 * Service-role access. Separated from `loadConfig` deliberately: the key is not
 * part of general configuration, and the only way to obtain it is to call a
 * function whose name says what you are doing.
 *
 * SEC-15: the service-role key is never shipped to the client and is available
 * only to server functions and workers. Any bundler that follows an import of
 * this into client code is a bug the `NEXT_PUBLIC_` naming convention cannot
 * catch on its own.
 */
export function loadServiceRoleKey(): string {
  if (typeof window !== "undefined") {
    throw new ConfigError(
      "loadServiceRoleKey() was called in a browser context. The service-role key bypasses RLS and must never " +
        "reach the client (SEC-15). This is a bug, not a configuration problem.",
    );
  }
  return required("SUPABASE_SERVICE_ROLE_KEY");
}

/**
 * Direct Postgres connection string. Separated from `loadConfig` for the same
 * reason as `loadServiceRoleKey`: obtaining it is a deliberate act, not a side
 * effect of reading general configuration.
 *
 * Used by `@kolekto/db` to call the `app` schema's SECURITY DEFINER write
 * functions (20260918140100_application_write_functions.sql) — PostgREST
 * serves `public` only (supabase/config.toml, `[api] schemas = ["public"]`),
 * so `app.create_member` and the rest are reachable only over a direct
 * connection, never through `supabase.rpc()`. The connection then sets
 * `role` and `request.jwt.claims` per call to impersonate the acting user
 * (or `anon`), the same pattern `supabase/tests` uses — so the write
 * functions' `app.has_permission` checks and RLS both still apply. Never sent
 * to the browser.
 */
export function loadDatabaseUrl(): string {
  if (typeof window !== "undefined") {
    throw new ConfigError(
      "loadDatabaseUrl() was called in a browser context. A direct Postgres connection string must never reach " +
        "the client. This is a bug, not a configuration problem.",
    );
  }
  return required("SUPABASE_DB_URL");
}

/**
 * The key that signs a contributor's identification cookie.
 *
 * A contributor has no account and no Supabase session (PRD 0.3). Once they
 * have found themselves on a community's roll, the server has to remember
 * which member that was, and the browser must not be able to change the answer
 * — substituting another member id would be substituting another person.
 *
 * So the cookie carries a signature, this is the key, and it is server-only for
 * the same reason as the service-role key: anyone holding it can mint an
 * identification for any member id they can guess.
 */
export function loadSessionSecret(): string {
  if (typeof window !== "undefined") {
    throw new ConfigError(
      "loadSessionSecret() was called in a browser context. The key that signs contributor identification must " +
        "never reach the client — with it, a browser could claim to be any member. This is a bug, not a " +
        "configuration problem.",
    );
  }
  const secret = required("KOLEKTO_SESSION_SECRET");
  if (secret.length < 32) {
    throw new ConfigError(
      "KOLEKTO_SESSION_SECRET is shorter than 32 characters. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  return secret;
}

/**
 * The key for the withdrawal one-time code HMAC (owner decision 2026-11-19).
 * Needed by the web server (to hash what the member typed) and the worker
 * (to hash the code it emails). Never in the database, never in the browser.
 */
export function loadWithdrawalOtpSecret(): string {
  if (typeof window !== "undefined") {
    throw new ConfigError(
      "loadWithdrawalOtpSecret() was called in a browser context. The withdrawal code key must never reach the " +
        "client. This is a bug, not a configuration problem.",
    );
  }
  const secret = required("KOLEKTO_WITHDRAWAL_OTP_SECRET");
  if (secret.length < 32) {
    throw new ConfigError(
      "KOLEKTO_WITHDRAWAL_OTP_SECRET is shorter than 32 characters. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  return secret;
}

/**
 * The membership server key (product doc §F4.5). Since owner decision A1
 * (2026-11-23, migration 20261123120000) membership IDs are stored as
 * plaintext and this key no longer protects them. It is used for two things:
 * the keyed hash of a caller's IP for rate limiting, and the legacy
 * fingerprint check that keeps two unrecoverable revoked itest IDs reserved
 * (owner decision D1). Never in the database, never in the browser, never
 * given to the admin application.
 */
export function loadMembershipIdSecret(): string {
  if (typeof window !== "undefined") {
    throw new ConfigError(
      "loadMembershipIdSecret() was called in a browser context. The membership ID key must never reach the " +
        "client. This is a bug, not a configuration problem.",
    );
  }
  const secret = required("KOLEKTO_MEMBERSHIP_ID_SECRET");
  if (secret.length < 32) {
    throw new ConfigError(
      "KOLEKTO_MEMBERSHIP_ID_SECRET is shorter than 32 characters. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  return secret;
}

/**
 * Where the web server may read the caller's IP address from, for the
 * membership-ID rate limit (Phase 2 of the session 67 security task).
 *
 * A request header is something the caller can write. It is evidence of the
 * caller's address only when infrastructure we control set it and nothing in
 * front of that infrastructure can reach the app. So the trusted source is
 * named per deployment, never guessed:
 *
 *   local         KOLEKTO_ENV=local only (and the default there). The
 *                 rightmost X-Forwarded-For entry, which `next start`/`next dev`
 *                 fill from the socket when the request has none. Spoofable,
 *                 and that is acceptable on a developer's own machine only.
 *   vercel        Vercel's `x-vercel-forwarded-for`, exactly one address.
 *                 Staging. Verify on the first deploy (docs/deployment/staging.md).
 *   xff-hops:N    N (1–3) trusted proxies that each APPEND to X-Forwarded-For;
 *                 the client is the Nth entry from the right. Safe only when the
 *                 app cannot be reached except through those proxies
 *                 (docs/deployment/production.md). AWS production: PENDING.
 *
 * Staging and production have no default: unset or unrecognised is a
 * ConfigError, which the caller turns into "temporarily unavailable" — never
 * into a guess. The raw value is not echoed back.
 */
export type ClientIpSource =
  | { readonly mode: "local" }
  | { readonly mode: "vercel" }
  | { readonly mode: "xff-hops"; readonly hops: 1 | 2 | 3 };

const CLIENT_IP_SOURCE_VAR = "KOLEKTO_CLIENT_IP_SOURCE";
const CLIENT_IP_SOURCE_VALUES = "local (KOLEKTO_ENV=local only), vercel, xff-hops:1, xff-hops:2, xff-hops:3";

/** Pure parser behind `loadClientIpSource`, so each environment can be tested without touching process.env. */
export function parseClientIpSource(raw: string | undefined, environment: KolektoEnvironment): ClientIpSource {
  const value = raw?.trim() ?? "";
  if (value === "") {
    if (environment === "local") return { mode: "local" };
    throw new ConfigError(
      `${CLIENT_IP_SOURCE_VAR} is not set. It is required when KOLEKTO_ENV is "${environment}", because the ` +
        `membership-ID rate limit must know which proxy header to trust. Allowed: ${CLIENT_IP_SOURCE_VALUES}. ` +
        `See docs/deployment/staging.md and docs/deployment/production.md.`,
    );
  }
  if (value === "local") {
    if (environment === "local") return { mode: "local" };
    throw new ConfigError(
      `${CLIENT_IP_SOURCE_VAR}=local is allowed only when KOLEKTO_ENV is "local" (it trusts a header any caller ` +
        `can send). KOLEKTO_ENV is "${environment}".`,
    );
  }
  if (value === "vercel") return { mode: "vercel" };
  const hops = /^xff-hops:([1-3])$/.exec(value)?.[1];
  if (hops) return { mode: "xff-hops", hops: Number(hops) as 1 | 2 | 3 };
  throw new ConfigError(`${CLIENT_IP_SOURCE_VAR} has an unsupported value. Allowed: ${CLIENT_IP_SOURCE_VALUES}.`);
}

/** The configured client-IP source. Throws ConfigError when it is missing, invalid, or local-only outside local. */
export function loadClientIpSource(): ClientIpSource {
  if (typeof window !== "undefined") {
    throw new ConfigError(
      "loadClientIpSource() was called in a browser context. Client-IP resolution is server-only. This is a bug, " +
        "not a configuration problem.",
    );
  }
  const environment = parseEnvironment(required("KOLEKTO_ENV"));
  return parseClientIpSource(process.env[CLIENT_IP_SOURCE_VAR], environment);
}

/** Reset the cache. Tests only. */
export function resetConfigCache(): void {
  cached = undefined;
}
