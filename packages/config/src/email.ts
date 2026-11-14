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
 * Real providers, i.e. ones that can deliver to a real mailbox. P9-4 adds
 * "ses"; the adapter still refuses to start until GetAccount's
 * ProductionAccessEnabled matches the environment and L4/L5 sit strictly
 * below SES's own quotas, and the sender pause switch remains false until
 * the operator release gates in §10.6.4 are met.
 */
export const REAL_EMAIL_PROVIDERS: readonly string[] = ["ses"];

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

/**
 * SES sending config (P9-4). The access key / secret / optional session
 * token come from the operator's secret store, never from a committed file.
 * The adapter still runs its own GetAccount reconciliation at startup
 * (§3.3 of the P9-4 design); this shape is only what config loading
 * produces.
 */
export interface SesEmailConfig extends EmailConfigBase {
  readonly provider: "ses";
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: EmailSecret;
  readonly sessionToken?: EmailSecret;
  readonly configurationSetName?: string;
  readonly httpTimeoutMs?: number;
}

/** A provider that can reach real mailboxes. No such provider exists yet; this shape is for P9. */
export interface RealEmailConfig extends EmailConfigBase {
  readonly provider: string;
  readonly apiKey: EmailSecret;
}

/** What `loadEmailConfig` returns today. */
export type EmailConfig = FakeEmailConfig | MailpitEmailConfig | SesEmailConfig;

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

function assertNoPublicEmailVariables(env: Env, secrets: readonly string[]): void {
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    if (/(EMAIL|SMTP|MAIL|AWS|SES)/i.test(name)) {
      throw new ConfigError(
        `REFUSING TO START: ${name} is an email / AWS / SES setting exposed through the NEXT_PUBLIC_ prefix. ` +
          `Email configuration is server-only; NEXT_PUBLIC_* values are shipped to browsers.`,
      );
    }
    const trimmed = raw?.trim();
    if (trimmed === undefined || trimmed === "") continue;
    for (const secret of secrets) {
      if (trimmed === secret) {
        throw new ConfigError(
          `REFUSING TO START: ${name} holds the same value as an email credential. A credential must never be ` +
            `exposed through a NEXT_PUBLIC_* variable.`,
        );
      }
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
  const sesSecret = value(env, "EMAIL_AWS_SECRET_ACCESS_KEY");
  const sesSessionToken = value(env, "EMAIL_AWS_SESSION_TOKEN");

  assertNoPublicEmailVariables(
    env,
    [apiKey, sesSecret, sesSessionToken].filter((s): s is string => s !== undefined),
  );

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

  // ── Real provider: SES (P9-4) ──────────────────────────────────────────────
  if (provider === "ses") {
    if (apiKey !== undefined) {
      throw new ConfigError(
        "REFUSING TO START: EMAIL_API_KEY is set but EMAIL_PROVIDER=ses. The SES adapter uses " +
          "EMAIL_AWS_ACCESS_KEY_ID and EMAIL_AWS_SECRET_ACCESS_KEY, not EMAIL_API_KEY.",
      );
    }
    const region = requiredVar(env, "EMAIL_AWS_REGION");
    const AWS_REGION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
    if (!AWS_REGION_PATTERN.test(region)) {
      throw new ConfigError("EMAIL_AWS_REGION is not a well-formed AWS region string (expected e.g. eu-west-1).");
    }
    const accessKeyId = requiredVar(env, "EMAIL_AWS_ACCESS_KEY_ID");
    if (accessKeyId.length < 16 || !/^[A-Z0-9]+$/.test(accessKeyId)) {
      // IAM access key ids are 20 chars of [A-Z0-9]. Reject anything that
      // obviously isn't one so a mistyped value fails loudly at startup.
      throw new ConfigError("EMAIL_AWS_ACCESS_KEY_ID does not look like an AWS access key id.");
    }
    const secretAccessKeyRaw = requiredVar(env, "EMAIL_AWS_SECRET_ACCESS_KEY");
    if (secretAccessKeyRaw.length < 20) {
      throw new ConfigError("EMAIL_AWS_SECRET_ACCESS_KEY looks too short to be a real secret.");
    }
    const sessionTokenRaw = value(env, "EMAIL_AWS_SESSION_TOKEN");
    const configurationSetName = value(env, "EMAIL_AWS_CONFIGURATION_SET");
    const rawTimeout = value(env, "EMAIL_SES_SEND_TIMEOUT_MS");
    let httpTimeoutMs: number | undefined;
    if (rawTimeout !== undefined) {
      const parsed = Number(rawTimeout);
      if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
        throw new ConfigError("EMAIL_SES_SEND_TIMEOUT_MS must be an integer between 1000 and 60000.");
      }
      httpTimeoutMs = parsed;
    }
    const sesConfig: SesEmailConfig = Object.freeze({
      provider: "ses",
      from,
      appBaseUrl,
      region,
      accessKeyId,
      secretAccessKey: createEmailSecret(secretAccessKeyRaw),
      ...(sessionTokenRaw !== undefined ? { sessionToken: createEmailSecret(sessionTokenRaw) } : {}),
      ...(configurationSetName !== undefined ? { configurationSetName } : {}),
      ...(httpTimeoutMs !== undefined ? { httpTimeoutMs } : {}),
    });
    return sesConfig;
  }

  // Any other registered real provider (none at present, kept as the
  // generic fallback shape so adding one later is a one-line change).
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
  if (config.provider === "fake" || config.provider === "mailpit" || config.provider === "ses") {
    return config as EmailConfig;
  }
  // Fallback for any future RealEmailConfig that lands in REAL_EMAIL_PROVIDERS
  // without a matching case here — fails closed with a clear message.
  throw new ConfigError(`A real email provider "${config.provider}" was configured but no adapter is wired for it yet.`);
}

/** A log-safe description. Names the provider and sender; never a credential. */
export function describeEmailConfig(config: EmailConfig | RealEmailConfig): string {
  return `email provider=${config.provider} from=${config.from} baseUrl=${config.appBaseUrl}`;
}

// ── SES/SNS ingestion configuration (M13.2 P9-2) ─────────────────────────────
//
// The webhook route accepts SES delivery feedback via SNS. These two variables
// configure WHERE events are expected to come from. They are server-only (no
// NEXT_PUBLIC_* permitted, same guard as the sending config); nothing here
// adds AWS credentials — SNS signature verification uses the signed envelope
// plus a cert fetched from a strict hostname allowlist, and never a shared
// secret. "Fail closed": when the route is enabled and either variable is
// missing or malformed, the loader throws rather than returning a partial
// shape, so a misconfigured deploy cannot silently accept forged events.

/** Narrow regexes for the two SES ingestion variables. Reused by evaluator and tests. */
const AWS_REGION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const SNS_TOPIC_ARN_PATTERN = /^arn:aws(?:-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/;

export interface SesIngestionConfig {
  readonly region: string;
  readonly topicArn: string;
  /**
   * The SNS SignatureVersion values the adapter will accept. The webhook
   * route refuses anything else as `unsupported_signature_version`.
   *
   * Default is `["2"]` only — SignatureVersion 2 (RSA-SHA256) is AWS's
   * current recommendation and the default for new topics. Operators who
   * need to accept SignatureVersion 1 for a legacy topic they cannot
   * reconfigure can set `EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1=true` to expand
   * the accepted set to `["1", "2"]`. The runbook explains the operational
   * posture.
   */
  readonly acceptedSignatureVersions: readonly string[];
}

function assertNoPublicAwsVariables(env: Env): void {
  for (const name of Object.keys(env)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    if (/(AWS|SES|SNS)/i.test(name)) {
      throw new ConfigError(
        `REFUSING TO START: ${name} is an AWS/SES/SNS setting exposed through the NEXT_PUBLIC_ prefix. ` +
          `AWS configuration is server-only; NEXT_PUBLIC_* values are shipped to browsers.`,
      );
    }
  }
}

/**
 * Validate SES ingestion configuration against the environment it will run in.
 * Pure: reads only its arguments, so every rule is testable without touching
 * process.env.
 *
 * Returns null when NEITHER variable is set — the ingestion endpoint is
 * disabled in that process and must refuse to serve requests. Returns the
 * validated shape when BOTH are set and consistent. Throws when exactly one
 * is set (half-configured), when the values are malformed, when the ARN's
 * region segment disagrees with EMAIL_AWS_REGION, or when a credential-like
 * NEXT_PUBLIC_* exists for an AWS setting.
 */
export function evaluateSesIngestionConfig(env: Env): SesIngestionConfig | null {
  assertNoPublicAwsVariables(env);

  const region = value(env, "EMAIL_AWS_REGION");
  const topicArn = value(env, "EMAIL_AWS_SNS_TOPIC_ARN");

  if (region === undefined && topicArn === undefined) {
    return null;
  }
  if (region === undefined || topicArn === undefined) {
    throw new ConfigError(
      "REFUSING TO START: SES ingestion variables are only half configured. " +
        "Set BOTH EMAIL_AWS_REGION and EMAIL_AWS_SNS_TOPIC_ARN, or unset both to disable the ingestion endpoint.",
    );
  }

  if (!AWS_REGION_PATTERN.test(region)) {
    throw new ConfigError("EMAIL_AWS_REGION is not a well-formed AWS region string (expected e.g. eu-west-1).");
  }
  if (!SNS_TOPIC_ARN_PATTERN.test(topicArn)) {
    throw new ConfigError("EMAIL_AWS_SNS_TOPIC_ARN is not a well-formed AWS SNS Topic ARN.");
  }
  // The ARN's region segment MUST match the configured region. Two independent
  // settings that have to agree — a mistyped or copy-pasted value fails here.
  const arnRegion = topicArn.split(":")[3];
  if (arnRegion !== region) {
    throw new ConfigError(
      "REFUSING TO START: EMAIL_AWS_SNS_TOPIC_ARN's region segment does not match EMAIL_AWS_REGION.",
    );
  }

  // SignatureVersion policy (M13.2 P9-2.1 / issue #17). Default: v2 only.
  // Operators who need v1 for a legacy topic opt in explicitly.
  const allowV1Raw = value(env, "EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1");
  let acceptedSignatureVersions: readonly string[];
  if (allowV1Raw === undefined) {
    acceptedSignatureVersions = ["2"];
  } else if (allowV1Raw === "true") {
    acceptedSignatureVersions = ["1", "2"];
  } else if (allowV1Raw === "false") {
    acceptedSignatureVersions = ["2"];
  } else {
    throw new ConfigError(
      'EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1 must be the literal string "true" or "false", or unset for the default v2-only policy.',
    );
  }

  return Object.freeze({
    region,
    topicArn,
    acceptedSignatureVersions: Object.freeze([...acceptedSignatureVersions]),
  });
}

/**
 * Load SES ingestion config from process.env. Server-only.
 *
 * Returns null (ingestion disabled) when neither variable is set. The webhook
 * route uses this directly: a null result means refuse 503 at the route, not
 * silently accept.
 */
export function loadSesIngestionConfig(): SesIngestionConfig | null {
  if (typeof window !== "undefined") {
    throw new ConfigError(
      "loadSesIngestionConfig() was called in a browser context. SES ingestion configuration is server-only.",
    );
  }
  return evaluateSesIngestionConfig(process.env);
}

/** A log-safe description. Names the region and ARN tail; the ARN itself is not a secret. */
export function describeSesIngestionConfig(config: SesIngestionConfig): string {
  return `ses ingestion region=${config.region} topic=${config.topicArn}`;
}
