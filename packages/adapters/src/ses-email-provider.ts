/**
 * ses-email-provider.ts — the Amazon SES v2 sending adapter (M13.2 P9-4).
 *
 * docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md §10.6.2, §10.6.3,
 * §10.6.4. docs/product/M13.2-P9-4-SES-SENDING-ADAPTER-DESIGN.md.
 *
 * ── CONTRACT ────────────────────────────────────────────────────────────────
 * Implements EmailProvider with `name: "ses"` and `idempotency: "none"`.
 * SESv2 SendEmail does NOT accept a caller-supplied idempotency token;
 * MessageId is server-generated. The sender (P5) therefore maps every
 * ambiguous outcome against this adapter to dead/outcome_unknown and the
 * worker's `recoverExpiredLeases` routes expired leases to
 * `app.resolve_lease_ambiguous` (P9-4 migration 20261025100000).
 *
 * ── STARTUP CHECK ───────────────────────────────────────────────────────────
 * Call GetAccount once at construction. Log provider-reported numbers next
 * to the configured L4/L5. Refuse to start when any of:
 *   · SES account-level sending is disabled (SendingEnabled=false).
 *   · We are in production but the account is still in sandbox mode
 *     (ProductionAccessEnabled=false).
 *   · Local L4 >= Max24HourSend or local L5 >= MaxSendRate (safety limits
 *     must sit strictly below the provider's own).
 * Any such failure throws EmailProviderError "adapter_misconfigured", which
 * the sender maps to `halt`.
 *
 * ── REDACTION ───────────────────────────────────────────────────────────────
 * Credentials pass through as EmailSecret wrappers. The adapter never logs,
 * stringifies or dumps them. Error messages name fields, not values. The
 * recipient address is passed to SES only inside the Destination.ToAddresses
 * array — never into subject, body, logs or thrown messages.
 */

import {
  type GetAccountCommandOutput,
  GetAccountCommand,
  MessageRejected,
  MailFromDomainNotVerifiedException,
  SendEmailCommand,
  SendingPausedException,
  SESv2Client,
  TooManyRequestsException,
} from "@aws-sdk/client-sesv2";

import {
  assertValidEmailRequest,
  EmailProviderError,
  type EmailIdempotency,
  type EmailProvider,
  type EmailSendRequest,
  type EmailSendResult,
} from "./email-provider.ts";

/** Minimal shape for the EmailSecret wrapper from @kolekto/config. */
export interface SesEmailSecret {
  reveal(): string;
}

export interface SesEmailProviderOptions {
  readonly region: string;
  readonly from: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: SesEmailSecret;
  readonly sessionToken?: SesEmailSecret;
  readonly configurationSetName?: string;
  /** Per-request timeout in ms. Default 10_000. */
  readonly httpTimeoutMs?: number;
  /** When true the adapter refuses to start if ProductionAccessEnabled is false. */
  readonly requireProductionAccess?: boolean;
  /**
   * Local safety ceilings; GetAccount must report numbers strictly higher.
   * Passed in so the adapter does not depend on the DB (the authority for
   * these numbers is `app.notification_send_limits`).
   */
  readonly localL4Daily: number;
  readonly localL5PerSecond: number;
  /**
   * Injectable for tests. If provided, the adapter uses it in place of the
   * real `SESv2Client`. The spec covers: `send(SendEmailCommand)` and
   * `send(GetAccountCommand)`.
   */
  readonly clientFactory?: (opts: SesClientFactoryOptions) => SesClientLike;
  /** Injectable sink for the one-shot startup log line. */
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface SesClientFactoryOptions {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly httpTimeoutMs: number;
}

/** The minimal client surface the adapter uses. Lets tests inject a scripted transport. */
export interface SesClientLike {
  send(command: SendEmailCommand | GetAccountCommand): Promise<unknown>;
}

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export class SesEmailProvider implements EmailProvider {
  readonly name = "ses" as const;
  readonly idempotency: EmailIdempotency = "none";

  private readonly client: SesClientLike;
  private readonly from: string;
  private readonly configurationSetName: string | undefined;

  private constructor(client: SesClientLike, from: string, configurationSetName: string | undefined) {
    this.client = client;
    this.from = from;
    this.configurationSetName = configurationSetName;
  }

  /**
   * Build the adapter and run the one-shot GetAccount startup check. Throws
   * EmailProviderError('adapter_misconfigured') on any refusal condition.
   * The sender maps that to `halt`, so a misconfigured deployment runs
   * maintenance (lease recovery, 72-hour expiry, ledger purge) with no
   * provider calls.
   */
  static async create(options: SesEmailProviderOptions): Promise<SesEmailProvider> {
    const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const factoryOptions: SesClientFactoryOptions = options.sessionToken
      ? {
          region: options.region,
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey.reveal(),
          sessionToken: options.sessionToken.reveal(),
          httpTimeoutMs,
        }
      : {
          region: options.region,
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey.reveal(),
          httpTimeoutMs,
        };
    const client = (options.clientFactory ?? defaultClientFactory)(factoryOptions);

    const account = await runGetAccount(client);
    assertAccountSafe(account, options);
    emitStartupLog(options, account);

    return new SesEmailProvider(client, options.from, options.configurationSetName);
  }

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    assertValidEmailRequest(request);

    const command = new SendEmailCommand({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [request.message.to] },
      Content: {
        Simple: {
          Subject: { Data: request.message.subject, Charset: "UTF-8" },
          Body: buildBody(request.message.text, request.message.html),
        },
      },
      EmailTags: [{ Name: "delivery_id", Value: request.idempotencyKey }],
      ConfigurationSetName: this.configurationSetName,
    });

    let response: unknown;
    try {
      response = await this.client.send(command);
    } catch (err) {
      throw mapSendError(err);
    }

    const providerMessageId = extractMessageId(response);
    if (providerMessageId === null) {
      // SES returned a 200 with no MessageId — treat as a protocol error.
      // The call either did not deliver or did deliver without evidence;
      // without a MessageId we can't correlate the webhook event either.
      throw new EmailProviderError(
        "permanent",
        "provider_protocol_error",
        "SES SendEmail returned no MessageId",
      );
    }
    return { providerMessageId };
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function defaultClientFactory(opts: SesClientFactoryOptions): SesClientLike {
  const credentials = opts.sessionToken
    ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, sessionToken: opts.sessionToken }
    : { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey };
  return new SESv2Client({
    region: opts.region,
    credentials,
    requestHandler: {
      requestTimeout: opts.httpTimeoutMs,
      connectionTimeout: opts.httpTimeoutMs,
    },
  });
}

interface AccountSnapshot {
  readonly sendingEnabled: boolean;
  readonly productionAccessEnabled: boolean;
  readonly max24HourSend: number;
  readonly maxSendRate: number;
}

async function runGetAccount(client: SesClientLike): Promise<AccountSnapshot> {
  let output: GetAccountCommandOutput;
  try {
    output = (await client.send(new GetAccountCommand({}))) as GetAccountCommandOutput;
  } catch (err) {
    throw new EmailProviderError(
      "permanent",
      "adapter_misconfigured",
      `SES GetAccount failed at startup: ${describeAwsError(err)}`,
    );
  }

  return {
    sendingEnabled: output.SendingEnabled ?? false,
    productionAccessEnabled: output.ProductionAccessEnabled ?? false,
    max24HourSend: Number(output.SendQuota?.Max24HourSend ?? 0),
    maxSendRate: Number(output.SendQuota?.MaxSendRate ?? 0),
  };
}

function assertAccountSafe(account: AccountSnapshot, options: SesEmailProviderOptions): void {
  if (!account.sendingEnabled) {
    throw new EmailProviderError(
      "permanent",
      "adapter_misconfigured",
      "SES account-level sending is disabled (SendingEnabled=false). Nothing will be sent.",
    );
  }
  if (options.requireProductionAccess === true && !account.productionAccessEnabled) {
    throw new EmailProviderError(
      "permanent",
      "adapter_misconfigured",
      "SES account is in sandbox mode (ProductionAccessEnabled=false) but production access is required.",
    );
  }
  if (!(options.localL4Daily < account.max24HourSend)) {
    throw new EmailProviderError(
      "permanent",
      "adapter_misconfigured",
      `Local L4 daily cap (${options.localL4Daily}) is not strictly below SES Max24HourSend (${account.max24HourSend}).`,
    );
  }
  if (!(options.localL5PerSecond < account.maxSendRate)) {
    throw new EmailProviderError(
      "permanent",
      "adapter_misconfigured",
      `Local L5 per-second cap (${options.localL5PerSecond}) is not strictly below SES MaxSendRate (${account.maxSendRate}).`,
    );
  }
}

function emitStartupLog(options: SesEmailProviderOptions, account: AccountSnapshot): void {
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  log({
    msg: "ses_adapter_startup",
    provider: "ses",
    idempotency: "none",
    region: options.region,
    configuration_set: options.configurationSetName ?? null,
    http_timeout_ms: options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    ses_sending_enabled: account.sendingEnabled,
    ses_production_access_enabled: account.productionAccessEnabled,
    ses_max_24_hour_send: account.max24HourSend,
    ses_max_send_rate: account.maxSendRate,
    local_l4_daily: options.localL4Daily,
    local_l5_per_second: options.localL5PerSecond,
  });
}

function buildBody(text: string, html: string | undefined): { Text: { Data: string; Charset: string }; Html?: { Data: string; Charset: string } } {
  const body: { Text: { Data: string; Charset: string }; Html?: { Data: string; Charset: string } } = {
    Text: { Data: text, Charset: "UTF-8" },
  };
  if (html !== undefined) body.Html = { Data: html, Charset: "UTF-8" };
  return body;
}

function extractMessageId(response: unknown): string | null {
  if (response === null || typeof response !== "object") return null;
  const id = (response as { MessageId?: unknown }).MessageId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Map an SES/AWS error to an EmailProviderError (stable Kolekto code).
 * The mapping is table-driven and documented in §10.6.4 of the decision
 * record. Message strings contain field/code names only — never the
 * recipient address or any value we received from SES verbatim.
 */
function mapSendError(err: unknown): EmailProviderError {
  // Already a Kolekto error (e.g. `invalid_message` from assertValid): pass through.
  if (err instanceof EmailProviderError) return err;

  // AWS structured exceptions, by class.
  if (err instanceof MessageRejected) {
    return new EmailProviderError("permanent", "provider_rejected_permanent", "SES MessageRejected");
  }
  if (err instanceof MailFromDomainNotVerifiedException) {
    return new EmailProviderError("permanent", "provider_rejected_permanent", "SES MailFromDomainNotVerified");
  }
  if (err instanceof SendingPausedException) {
    return new EmailProviderError("transient", "provider_rejected_transient", "SES account sending is paused");
  }
  if (err instanceof TooManyRequestsException) {
    return new EmailProviderError("transient", "provider_rejected_transient", "SES throttling");
  }

  // AbortError (our timeout) is unambiguous as "may have landed" — the
  // request body may already have been written to the socket.
  const name = extractName(err);
  if (name === "AbortError" || name === "TimeoutError") {
    return new EmailProviderError("transient", "provider_timeout", "SES send timed out", true);
  }

  // Status-code-driven mapping for HTTP errors the SDK did not model as a
  // typed exception. 429 and 5xx are retryable; 5xx is ambiguous (we may
  // have reached the service before the error path kicked in).
  const status = extractHttpStatus(err);
  if (status === 429) {
    return new EmailProviderError("transient", "provider_rejected_transient", "SES HTTP 429");
  }
  if (status >= 500 && status <= 599) {
    return new EmailProviderError("transient", "provider_unreachable", `SES HTTP ${status}`, true);
  }

  // Pre-connect network failure (DNS, connection refused): unambiguous.
  if (name === "ENOTFOUND" || name === "ECONNREFUSED" || name === "EAI_AGAIN") {
    return new EmailProviderError("transient", "provider_unreachable", `SES network error ${name}`, false);
  }

  // Connection drop AFTER request started: the SDK often surfaces this as a
  // generic error with code ECONNRESET or similar. Treat as ambiguous.
  if (name === "ECONNRESET" || name === "EPIPE") {
    return new EmailProviderError("transient", "provider_unreachable", `SES stream dropped ${name}`, true);
  }

  // Signature error means our SigV4 is wrong — this is a bug or stale clock.
  if (name === "SignatureDoesNotMatch" || name === "InvalidSignatureException") {
    return new EmailProviderError("permanent", "provider_protocol_error", "SES signature mismatch");
  }

  // Credential or authorization failure.
  if (name === "UnauthorizedOperation" || name === "AccessDenied" || status === 403) {
    return new EmailProviderError("permanent", "adapter_misconfigured", `SES access denied (${name || status})`);
  }

  // Configuration set missing (an operator-fixable misconfiguration).
  if (name === "ConfigurationSetDoesNotExistException" || name === "ConfigurationSetDoesNotExist") {
    return new EmailProviderError("permanent", "adapter_misconfigured", "SES configuration set does not exist");
  }

  // Anything else: default to transient without the ambiguous flag. The
  // sender will retry it on attempt 2/3 and dead/retries_exhausted after.
  return new EmailProviderError("transient", "provider_rejected_transient", `SES unmapped error ${name || "unknown"}`);
}

function extractName(err: unknown): string {
  if (err === null || typeof err !== "object") return "";
  const n = (err as { name?: unknown; Code?: unknown; code?: unknown }).name
    ?? (err as { Code?: unknown }).Code
    ?? (err as { code?: unknown }).code;
  return typeof n === "string" ? n : "";
}

function extractHttpStatus(err: unknown): number {
  if (err === null || typeof err !== "object") return 0;
  const metadata = (err as { $metadata?: unknown }).$metadata;
  if (metadata === null || typeof metadata !== "object") return 0;
  const code = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof code === "number" ? code : 0;
}

function describeAwsError(err: unknown): string {
  const name = extractName(err);
  const status = extractHttpStatus(err);
  if (name && status) return `${name} HTTP ${status}`;
  if (name) return name;
  if (status) return `HTTP ${status}`;
  return "unknown";
}
