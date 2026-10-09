/**
 * email.ts — email configuration and the guards that decide which provider may run where.
 *
 * M13.2 / P1. docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md, §10.5.
 * Same philosophy as env.ts (ADR 0007): fail at startup, no defaults for anything
 * that decides where mail goes, and every non-production process asserts it is
 * not about to behave like production.
 *
 * ── VARIABLES (server-only; none is, or may be, NEXT_PUBLIC_*) ──────────────
 *   EMAIL_PROVIDER     required. "fake" | "mailpit" today. A real provider name
 *                      is added in P9 after selection (D-PROVIDER); until then
 *                      none exists, so production cannot start email at all.
 *   EMAIL_FROM         required. A single plain address.
 *   APP_BASE_URL       required. Origin used for links in messages.
 *   EMAIL_API_KEY      required for a real provider; must be UNSET for fake and
 *                      mailpit (a credential next to a local provider is a
 *                      misconfiguration, not a convenience).
 *   EMAIL_SMTP_HOST,
 *   EMAIL_SMTP_PORT    required for mailpit only; the host must be loopback.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────
 *   production   a real provider only. "fake" and "mailpit" are refused.
 *   staging      "fake" or a real provider. "mailpit" is refused (no catcher there).
 *   local        "fake" or "mailpit". A real provider is refused, always.
 *   GitHub CI    a real provider is refused regardless of KOLEKTO_ENV.
 *   any          a credential-like value in a NEXT_PUBLIC_* variable is refused.
 *
 * Secrets: `apiKey` is wrapped so that console.log, JSON.stringify, string
 * interpolation and util.inspect all print "[redacted]". The only way to the
 * value is the explicit `reveal()`. No error message in this file contains a
 * variable's value — only its name.
 */

import { ConfigError, type KolektoEnvironment } from "./env.ts";

// util.inspect's custom-inspect symbol is registered globally; using Symbol.for avoids importing
// node:util, which would break any client bundle that imports this package for other reasons.
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

export type LocalEmailProviderName = "fake" | "mailpit";

/**
 * Real providers, i.e. ones that can deliver to a real mailbox. EMPTY ON PURPOSE:
 * none is selected or implemented. Adding a name here is the P9 change and must
 * come with its adapter, its own tests and the approvals listed in §14.
 */
export const REAL_EMAIL_PROVIDERS: readonly string[] = [];

const LOCAL_PROVIDERS: readonly LocalEmailProviderName[] = ["fake", "mailpit"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// ── Secret wrapper ───────────────────────────────────────────────────────────

export interface EmailSecret {
  /** The only way to obtain the value. Call it at the point of use; do not store the result. */
  reveal(): string;
  toString(): string;
  toJSON(): string;
}

const REDACTED = "[redacted]";

export function createEmailSecret(value: string): EmailSecret {
  const secret = {
    reveal: () => value,
    toString: () => REDACTED,
    toJSON: () => REDACTED,
    [INSPECT_CUSTOM]: () => REDACTED,
  };
  return Object.freeze(secret);
}

// ── Result types ─────────────────────────────────────────────────────────────

interface EmailConfigBase {
  readonly from: string;
  /** Origin only (scheme + host + port), no trailing slash. */
  readonly appBaseUrl: string;
}

export interface FakeEmailConfig extends EmailConfigBase {
  readonly provider: "fake";
}

export interface MailpitEmailConfig extends EmailConfigBase {
  readonly provider: "mailpit";
  readonly smtpHost: string;
  readonly smtpPort: number;
}

/** A provider that can reach real mailboxes. No such provider exists yet; this shape is for P9. */
export interface RealEmailConfig extends EmailConfigBase {
  readonly provider: string;
  readonly apiKey: EmailSecret;
}

/** What `loadEmailConfig` returns today. Real providers are structurally impossible until P9. */
export type EmailConfig = FakeEmailConfig | MailpitEmailConfig;

type Env = Readonly<Record<string, string | undefined>>;

export interface EvaluateEmailOptions {
  /** Test seam: the set of names treated as real providers. Defaults to REAL_EMAIL_PROVIDERS. */
  readonly realProviders?: readonly string[];
}

// ── Evaluation (pure) ────────────────────────────────────────────────────────

function value(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

function requiredVar(env: Env, name: string): string {
  const v = value(env, name);
  if (v === undefined) {
    throw new ConfigError(
      `Missing required environment variable ${name}. Email configuration has no defaults on purpose — ` +
        `see docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md §10.5 and .env.example.`,
    );
  }
  return v;
}

// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;
const PLAIN_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

function assertNoPublicEmailVariables(env: Env, apiKey: string | undefined): void {
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    if (/(EMAIL|SMTP|MAIL)/i.test(name)) {
      throw new ConfigError(
        `REFUSING TO START: ${name} is an email setting exposed through the NEXT_PUBLIC_ prefix. ` +
          `Email configuration is server-only; NEXT_PUBLIC_* values are shipped to browsers.`,
      );
    }
    if (apiKey !== undefined && raw !== undefined && raw.trim() === apiKey) {
      throw new ConfigError(
        `REFUSING TO START: ${name} holds the same value as EMAIL_API_KEY. A credential must never be ` +
          `exposed through a NEXT_PUBLIC_* variable.`,
      );
    }
  }
}

function parseBaseUrl(raw: string, environment: KolektoEnvironment): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("APP_BASE_URL is not a valid absolute URL (for example https://app.example.com).");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("APP_BASE_URL must use http or https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("APP_BASE_URL must not contain credentials.");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (environment === "local") {
    if (!loopback) {
      throw new ConfigError(
        'REFUSING TO START: KOLEKTO_ENV is "local" but APP_BASE_URL is not this machine. Links in local email ' +
          "must never point at a hosted deployment.",
      );
    }
  } else {
    if (loopback) {
      throw new ConfigError(`REFUSING TO START: KOLEKTO_ENV is "${environment}" but APP_BASE_URL points at this machine.`);
    }
    if (url.protocol !== "https:") {
      throw new ConfigError(`REFUSING TO START: KOLEKTO_ENV is "${environment}" and APP_BASE_URL is not https.`);
    }
  }
  return url.origin;
}

/**
 * Validate email configuration against the environment it will run in.
 * Pure: reads only its arguments, so every rule is testable without touching process.env.
 */
export function evaluateEmailConfig(
  env: Env,
  environment: KolektoEnvironment,
  options: EvaluateEmailOptions = {},
): EmailConfig | RealEmailConfig {
  const realProviders = options.realProviders ?? REAL_EMAIL_PROVIDERS;
  const apiKey = value(env, "EMAIL_API_KEY");

  assertNoPublicEmailVariables(env, apiKey);

  const provider = requiredVar(env, "EMAIL_PROVIDER");
  const isLocalProvider = (LOCAL_PROVIDERS as readonly string[]).includes(provider);
  const isRealProvider = realProviders.includes(provider);

  if (!isLocalProvider && !isRealProvider) {
    // The value is deliberately not echoed: operators paste secrets into the wrong variable.
    throw new ConfigError(
      `EMAIL_PROVIDER is not a supported provider. Supported: ${[...LOCAL_PROVIDERS, ...realProviders].join(", ")}.`,
    );
  }

  // ── Which provider may run in which environment ────────────────────────────
  if (environment === "production" && isLocalProvider) {
    throw new ConfigError(
      `REFUSING TO START: KOLEKTO_ENV is "production" and EMAIL_PROVIDER is a local-only provider ("${provider}"). ` +
        `Production must not use a provider that does not deliver real mail. ` +
        (realProviders.length === 0 ? "No production email provider is implemented yet (D-PROVIDER)." : ""),
    );
  }
  if (provider === "mailpit" && environment !== "local") {
    throw new ConfigError(`REFUSING TO START: the "mailpit" provider is for KOLEKTO_ENV=local only, not "${environment}".`);
  }
  if (isRealProvider) {
    if (environment === "local") {
      throw new ConfigError(
        'REFUSING TO START: KOLEKTO_ENV is "local" and EMAIL_PROVIDER is a real provider. ' +
          "Local development must never be able to send real email. Use EMAIL_PROVIDER=mailpit.",
      );
    }
    if (env["GITHUB_ACTIONS"] === "true") {
      throw new ConfigError(
        "REFUSING TO START: a real email provider was selected in CI. CI must never send real email; " +
          "use EMAIL_PROVIDER=fake or mailpit.",
      );
    }
  }

  // ── Common settings ────────────────────────────────────────────────────────
  const from = requiredVar(env, "EMAIL_FROM");
  if (from.length > 254 || HAS_CONTROL.test(from) || !PLAIN_ADDRESS.test(from)) {
    throw new ConfigError("EMAIL_FROM must be a single plain email address (no display name, no line breaks).");
  }
  const appBaseUrl = parseBaseUrl(requiredVar(env, "APP_BASE_URL"), environment);

  // ── Per-provider settings ──────────────────────────────────────────────────
  if (isLocalProvider) {
    if (apiKey !== undefined) {
      throw new ConfigError(
        `REFUSING TO START: EMAIL_API_KEY is set but EMAIL_PROVIDER is a local provider ("${provider}"). ` +
          "Unset EMAIL_API_KEY. A credential beside a local provider is how real mail gets sent by accident.",
      );
    }
    if (provider === "fake") {
      return Object.freeze({ provider: "fake", from, appBaseUrl });
    }
    const smtpHost = requiredVar(env, "EMAIL_SMTP_HOST");
    const rawPort = requiredVar(env, "EMAIL_SMTP_PORT");
    if (!LOOPBACK_HOSTS.has(smtpHost.toLowerCase())) {
      throw new ConfigError("REFUSING TO START: EMAIL_SMTP_HOST must be a loopback address for the mailpit provider.");
    }
    const smtpPort = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) {
      throw new ConfigError("EMAIL_SMTP_PORT must be a TCP port number between 1 and 65535.");
    }
    return Object.freeze({ provider: "mailpit", from, appBaseUrl, smtpHost, smtpPort });
  }

  // Real provider (none exists until P9).
  if (apiKey === undefined || apiKey.length < 8) {
    throw new ConfigError(`EMAIL_API_KEY is required for provider "${provider}" and looks too short to be a real key.`);
  }
  return Object.freeze({ provider, from, appBaseUrl, apiKey: createEmailSecret(apiKey) });
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Load email configuration from process.env for the given environment.
 * The environment is passed in (from `loadConfig().environment`) so this module
 * does not need the Supabase variables to be present.
 *
 * Returns the local-provider shapes only. A real provider cannot be returned
 * until one is registered in REAL_EMAIL_PROVIDERS (P9), so a production process
 * that reaches here throws.
 */
export function loadEmailConfig(environment: KolektoEnvironment): EmailConfig {
  if (typeof window !== "undefined") {
    throw new ConfigError(
      "loadEmailConfig() was called in a browser context. Email configuration is server-only. This is a bug, " +
        "not a configuration problem.",
    );
  }
  const config = evaluateEmailConfig(process.env, environment);
  if (config.provider === "fake" || config.provider === "mailpit") return config as EmailConfig;
  // Unreachable while REAL_EMAIL_PROVIDERS is empty; fails closed if someone registers a provider without wiring it.
  throw new ConfigError("A real email provider was configured but no adapter is wired for it yet (P9).");
}

/** A log-safe description. Names the provider and sender; never a credential. */
export function describeEmailConfig(config: EmailConfig | RealEmailConfig): string {
  return `email provider=${config.provider} from=${config.from} baseUrl=${config.appBaseUrl}`;
}
