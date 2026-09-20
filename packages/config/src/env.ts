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

/** Reset the cache. Tests only. */
export function resetConfigCache(): void {
  cached = undefined;
}
