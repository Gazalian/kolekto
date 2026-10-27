/**
 * email-factory.ts — turns validated configuration into a provider.
 *
 * The configuration type is declared HERE, structurally, rather than imported
 * from @kolekto/config: this package must not depend on the config package, and
 * `loadEmailConfig()` returns an object that satisfies this shape. The caller
 * (the worker) does `createEmailProvider(loadEmailConfig(environment))`.
 *
 * The factory is deliberately dumb. Every decision about WHETHER a provider may
 * run in this environment is made by the startup guards in
 * packages/config/src/email.ts, before this is reached. The factory only
 * refuses what it cannot construct, so an unknown name fails closed.
 */

import { EmailProviderError, type EmailProvider } from "./email-provider.ts";
import { FakeEmailProvider } from "./fake-email-provider.ts";
import { MailpitEmailProvider } from "./mailpit-email-provider.ts";
import { SesEmailProvider, type SesEmailSecret } from "./ses-email-provider.ts";

export type EmailAdapterConfig =
  | { readonly provider: "fake" }
  | {
      readonly provider: "mailpit";
      readonly from: string;
      readonly smtpHost: string;
      readonly smtpPort: number;
    }
  | {
      readonly provider: "ses";
      readonly from: string;
      readonly region: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: SesEmailSecret;
      readonly sessionToken?: SesEmailSecret;
      readonly configurationSetName?: string;
      readonly httpTimeoutMs?: number;
      readonly requireProductionAccess?: boolean;
      readonly localL4Daily: number;
      readonly localL5PerSecond: number;
    };

/**
 * The async variant builds providers that need network calls at startup
 * (SES's `GetAccount`). Fake and mailpit never need the network; use
 * `createEmailProvider` for them. The worker always calls this one.
 */
export async function createEmailProviderAsync(config: EmailAdapterConfig): Promise<EmailProvider> {
  if (config.provider === "ses") {
    // Build the SES options with only the fields that are actually set, so
    // the exactOptionalPropertyTypes contract is satisfied without passing
    // explicit `undefined`s.
    const sesOpts = {
      region: config.region,
      from: config.from,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      localL4Daily: config.localL4Daily,
      localL5PerSecond: config.localL5PerSecond,
      ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
      ...(config.configurationSetName !== undefined ? { configurationSetName: config.configurationSetName } : {}),
      ...(config.httpTimeoutMs !== undefined ? { httpTimeoutMs: config.httpTimeoutMs } : {}),
      ...(config.requireProductionAccess !== undefined ? { requireProductionAccess: config.requireProductionAccess } : {}),
    };
    return SesEmailProvider.create(sesOpts);
  }
  return createEmailProvider(config);
}

export function createEmailProvider(config: EmailAdapterConfig): EmailProvider {
  switch (config.provider) {
    case "fake":
      return new FakeEmailProvider();
    case "mailpit":
      return new MailpitEmailProvider({ host: config.smtpHost, port: config.smtpPort, from: config.from });
    case "ses":
      throw new EmailProviderError(
        "permanent",
        "adapter_misconfigured",
        "the SES adapter requires an async startup check (GetAccount); call createEmailProviderAsync",
      );
    default: {
      // Unreachable for typed callers; reachable from untyped input, where failing closed is the point.
      const unknown: never = config;
      void unknown;
      throw new EmailProviderError("permanent", "adapter_misconfigured", "no email provider is implemented for this configuration");
    }
  }
}
