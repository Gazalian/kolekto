import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EmailProviderError } from "../src/email-provider.ts";
import { createEmailProvider, type EmailAdapterConfig } from "../src/email-factory.ts";
import { FakeEmailProvider } from "../src/fake-email-provider.ts";
import { MailpitEmailProvider } from "../src/mailpit-email-provider.ts";

describe("createEmailProvider", () => {
  it("builds the fake", () => {
    const p = createEmailProvider({ provider: "fake" });
    assert.ok(p instanceof FakeEmailProvider);
  });

  it("builds the Mailpit adapter from validated config", () => {
    const p = createEmailProvider({ provider: "mailpit", from: "no-reply@kolekto.example", smtpHost: "127.0.0.1", smtpPort: 54325 });
    assert.ok(p instanceof MailpitEmailProvider);
  });

  it("still refuses a non-loopback Mailpit host even if the config guard were bypassed", () => {
    assert.throws(
      () => createEmailProvider({ provider: "mailpit", from: "no-reply@kolekto.example", smtpHost: "smtp.example.com", smtpPort: 25 }),
      (e: unknown) => e instanceof EmailProviderError && e.code === "adapter_misconfigured",
    );
  });

  it("fails closed on an unknown provider from untyped input", () => {
    assert.throws(
      () => createEmailProvider({ provider: "resend" } as unknown as EmailAdapterConfig),
      (e: unknown) => e instanceof EmailProviderError && e.code === "adapter_misconfigured",
    );
  });
});
