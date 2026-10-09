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

export type EmailAdapterConfig =
  | { readonly provider: "fake" }
  | {
      readonly provider: "mailpit";
      readonly from: string;
      readonly smtpHost: string;
      readonly smtpPort: number;
    };

export function createEmailProvider(config: EmailAdapterConfig): EmailProvider {
  switch (config.provider) {
    case "fake":
      return new FakeEmailProvider();
    case "mailpit":
      return new MailpitEmailProvider({ host: config.smtpHost, port: config.smtpPort, from: config.from });
    default: {
      // Unreachable for typed callers; reachable from untyped input, where failing closed is the point.
      const unknown: never = config;
      void unknown;
      throw new EmailProviderError("permanent", "adapter_misconfigured", "no email provider is implemented for this configuration");
    }
  }
}
