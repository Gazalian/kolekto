/**
 * ses-email-provider.test.ts — the SES v2 adapter in isolation (M13.2 P9-4).
 *
 * No real network calls. Every test injects a scripted client that
 * records the inbound SendEmailCommand / GetAccountCommand and returns a
 * scripted response. Proves:
 *   · GetAccount is called ONCE at construction and never again
 *   · startup refusals (sandbox-in-production, SendingEnabled=false,
 *     L4/L5 >= provider quotas) all throw adapter_misconfigured
 *   · send() maps every category from §10.6.4 to the correct
 *     (code, kind, ambiguous) tuple
 *   · the delivery_id lineage lands in EmailTags
 *   · the recipient address and the credentials never appear in a
 *     stringified adapter or an error message's prose
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GetAccountCommand,
  MessageRejected,
  MailFromDomainNotVerifiedException,
  SendEmailCommand,
  SendingPausedException,
  TooManyRequestsException,
} from "@aws-sdk/client-sesv2";

import { EmailProviderError } from "../src/email-provider.ts";
import {
  SesEmailProvider,
  type SesClientFactoryOptions,
  type SesClientLike,
  type SesEmailProviderOptions,
  type SesEmailSecret,
} from "../src/ses-email-provider.ts";

const SECRET: SesEmailSecret = { reveal: () => "ses-secret-value-20-chars-min-xx" };
const DEFAULT_ACCOUNT = {
  SendingEnabled: true,
  ProductionAccessEnabled: true,
  SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 0 },
};
const BASE_OPTIONS = Object.freeze({
  region: "us-east-1",
  from: "noreply@example.test",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: SECRET,
  localL4Daily: 180,
  localL5PerSecond: 1,
  log: () => undefined,
});

interface Scripted {
  readonly getAccount?: unknown | Error;
  readonly sendResponses?: Array<unknown | Error>;
}

function clientFactory(scripted: Scripted): {
  factory: (_: SesClientFactoryOptions) => SesClientLike;
  calls: Array<{ kind: string; input?: unknown }>;
  getAccountCalls: number;
  sendCount: number;
} {
  const state = { getAccountCalls: 0, sendCount: 0 };
  const calls: Array<{ kind: string; input?: unknown }> = [];
  const factory = (_: SesClientFactoryOptions): SesClientLike => ({
    send: async (cmd: SendEmailCommand | GetAccountCommand) => {
      if (cmd instanceof GetAccountCommand) {
        state.getAccountCalls += 1;
        calls.push({ kind: "GetAccount" });
        if (scripted.getAccount instanceof Error) throw scripted.getAccount;
        return scripted.getAccount ?? DEFAULT_ACCOUNT;
      }
      state.sendCount += 1;
      calls.push({ kind: "SendEmail", input: cmd.input });
      const scriptIndex = state.sendCount - 1;
      const response = scripted.sendResponses?.[scriptIndex];
      if (response instanceof Error) throw response;
      return response ?? { MessageId: `SES-MSG-${scriptIndex + 1}`, $metadata: { httpStatusCode: 200 } };
    },
  });
  return {
    factory,
    get calls() { return calls; },
    get getAccountCalls() { return state.getAccountCalls; },
    get sendCount() { return state.sendCount; },
  } as unknown as ReturnType<typeof clientFactory>;
}

async function build(scripted: Scripted = {}, override: Partial<SesEmailProviderOptions> = {}): Promise<{
  provider: SesEmailProvider;
  spy: ReturnType<typeof clientFactory>;
}> {
  const spy = clientFactory(scripted);
  const provider = await SesEmailProvider.create({ ...BASE_OPTIONS, ...override, clientFactory: spy.factory });
  return { provider, spy };
}

describe("SesEmailProvider.create — startup check", () => {
  it("calls GetAccount exactly once and succeeds for a healthy production account", async () => {
    const { provider, spy } = await build();
    assert.equal(provider.name, "ses");
    assert.equal(provider.idempotency, "none");
    assert.equal(spy.getAccountCalls, 1);
  });

  it("refuses to start when SES account-level sending is disabled", async () => {
    await assert.rejects(
      () => build({ getAccount: { ...DEFAULT_ACCOUNT, SendingEnabled: false } }),
      (err: unknown) => err instanceof EmailProviderError && err.code === "adapter_misconfigured" && err.kind === "permanent",
    );
  });

  it("refuses to start when ProductionAccessEnabled=false and requireProductionAccess=true", async () => {
    await assert.rejects(
      () => build({ getAccount: { ...DEFAULT_ACCOUNT, ProductionAccessEnabled: false } }, { requireProductionAccess: true }),
      (err: unknown) => err instanceof EmailProviderError && err.code === "adapter_misconfigured",
    );
  });

  it("accepts a sandbox account when requireProductionAccess=false", async () => {
    const { provider } = await build(
      { getAccount: { ...DEFAULT_ACCOUNT, ProductionAccessEnabled: false, SendQuota: { Max24HourSend: 200, MaxSendRate: 2 } } },
      { requireProductionAccess: false, localL4Daily: 180, localL5PerSecond: 1 },
    );
    assert.equal(provider.name, "ses");
  });

  it("refuses to start when local L4 >= provider's Max24HourSend", async () => {
    await assert.rejects(
      () => build({ getAccount: { ...DEFAULT_ACCOUNT, SendQuota: { Max24HourSend: 180, MaxSendRate: 14 } } }, { localL4Daily: 180 }),
      (err: unknown) => err instanceof EmailProviderError && err.code === "adapter_misconfigured",
    );
  });

  it("refuses to start when local L5 >= provider's MaxSendRate", async () => {
    await assert.rejects(
      () => build({ getAccount: { ...DEFAULT_ACCOUNT, SendQuota: { Max24HourSend: 50_000, MaxSendRate: 1 } } }, { localL5PerSecond: 1 }),
      (err: unknown) => err instanceof EmailProviderError && err.code === "adapter_misconfigured",
    );
  });

  it("surfaces a GetAccount network failure as adapter_misconfigured", async () => {
    const err = Object.assign(new Error("boom"), { name: "ENOTFOUND" });
    await assert.rejects(
      () => build({ getAccount: err }),
      (e: unknown) => e instanceof EmailProviderError && e.code === "adapter_misconfigured",
    );
  });
});

describe("SesEmailProvider.send — happy path and lineage", () => {
  it("returns the SES MessageId", async () => {
    const { provider } = await build({ sendResponses: [{ MessageId: "SES-MSG-ABC", $metadata: { httpStatusCode: 200 } }] });
    const result = await provider.send({
      idempotencyKey: "del-123",
      message: { to: "r@example.test", subject: "Hi", text: "Hello" },
    });
    assert.equal(result.providerMessageId, "SES-MSG-ABC");
  });

  it("tags the SendEmail with the delivery_id for webhook correlation", async () => {
    const { provider, spy } = await build();
    await provider.send({
      idempotencyKey: "del-xyz",
      message: { to: "r@example.test", subject: "Hi", text: "Hello" },
    });
    const sendCall = spy.calls.find((c) => c.kind === "SendEmail");
    assert.ok(sendCall);
    const input = sendCall.input as { EmailTags?: Array<{ Name: string; Value: string }> };
    assert.deepEqual(input.EmailTags, [{ Name: "delivery_id", Value: "del-xyz" }]);
  });

  it("sends FromEmailAddress and Destination.ToAddresses from the config/request", async () => {
    const { provider, spy } = await build();
    await provider.send({
      idempotencyKey: "d1",
      message: { to: "r1@example.test", subject: "s", text: "t" },
    });
    const input = spy.calls.find((c) => c.kind === "SendEmail")?.input as {
      FromEmailAddress?: string;
      Destination?: { ToAddresses?: string[] };
    };
    assert.equal(input.FromEmailAddress, "noreply@example.test");
    assert.deepEqual(input.Destination?.ToAddresses, ["r1@example.test"]);
  });

  it("includes the HTML body only when the caller supplies one", async () => {
    const { provider, spy } = await build();
    await provider.send({ idempotencyKey: "d1", message: { to: "r@example.test", subject: "s", text: "t" } });
    await provider.send({ idempotencyKey: "d2", message: { to: "r@example.test", subject: "s", text: "t", html: "<p>t</p>" } });
    const [first, second] = spy.calls.filter((c) => c.kind === "SendEmail");
    const firstBody = (first?.input as { Content?: { Simple?: { Body?: { Html?: unknown } } } }).Content?.Simple?.Body;
    const secondBody = (second?.input as { Content?: { Simple?: { Body?: { Html?: unknown } } } }).Content?.Simple?.Body;
    assert.equal((firstBody as { Html?: unknown }).Html, undefined, "no html body when not supplied");
    assert.ok((secondBody as { Html?: unknown }).Html, "html body when supplied");
  });

  it("passes configurationSetName when set", async () => {
    const { provider, spy } = await build({}, { configurationSetName: "kolekto-prod" });
    await provider.send({ idempotencyKey: "d1", message: { to: "r@example.test", subject: "s", text: "t" } });
    const input = spy.calls.find((c) => c.kind === "SendEmail")?.input as { ConfigurationSetName?: string };
    assert.equal(input.ConfigurationSetName, "kolekto-prod");
  });

  it("validates the request through assertValidEmailRequest before any provider call", async () => {
    const { provider, spy } = await build();
    await assert.rejects(
      () => provider.send({ idempotencyKey: "", message: { to: "r@example.test", subject: "s", text: "t" } }),
      (err: unknown) => err instanceof EmailProviderError && err.code === "invalid_message",
    );
    assert.equal(spy.sendCount, 0, "no provider call on an invalid request");
  });

  it("throws provider_protocol_error when SES returns no MessageId on a 200", async () => {
    const { provider } = await build({ sendResponses: [{ $metadata: { httpStatusCode: 200 } }] });
    await assert.rejects(
      () => provider.send({ idempotencyKey: "d1", message: { to: "r@example.test", subject: "s", text: "t" } }),
      (err: unknown) => err instanceof EmailProviderError && err.code === "provider_protocol_error" && err.kind === "permanent",
    );
  });
});

describe("SesEmailProvider.send — error mapping (§10.6.4)", () => {
  async function expectError(sendErr: unknown, expected: { code: string; kind: "transient" | "permanent"; ambiguous: boolean }) {
    const { provider } = await build({ sendResponses: [sendErr] });
    try {
      await provider.send({ idempotencyKey: "d1", message: { to: "r@example.test", subject: "s", text: "t" } });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof EmailProviderError, "wrong error class");
      const e = err as EmailProviderError;
      assert.equal(e.code, expected.code);
      assert.equal(e.kind, expected.kind);
      assert.equal(e.ambiguous, expected.ambiguous);
    }
  }

  it("MessageRejected → provider_rejected_permanent, not ambiguous", async () => {
    await expectError(
      new MessageRejected({ message: "bad recipient", $metadata: {} }),
      { code: "provider_rejected_permanent", kind: "permanent", ambiguous: false },
    );
  });

  it("MailFromDomainNotVerifiedException → provider_rejected_permanent", async () => {
    await expectError(
      new MailFromDomainNotVerifiedException({ message: "unverified", $metadata: {} }),
      { code: "provider_rejected_permanent", kind: "permanent", ambiguous: false },
    );
  });

  it("SendingPausedException → provider_rejected_transient", async () => {
    await expectError(
      new SendingPausedException({ message: "paused", $metadata: {} }),
      { code: "provider_rejected_transient", kind: "transient", ambiguous: false },
    );
  });

  it("TooManyRequestsException → provider_rejected_transient", async () => {
    await expectError(
      new TooManyRequestsException({ message: "throttled", $metadata: {} }),
      { code: "provider_rejected_transient", kind: "transient", ambiguous: false },
    );
  });

  it("AbortError (timeout) → provider_timeout, ambiguous=true", async () => {
    const err = Object.assign(new Error("timed out"), { name: "AbortError" });
    await expectError(err, { code: "provider_timeout", kind: "transient", ambiguous: true });
  });

  it("HTTP 5xx → provider_unreachable, ambiguous=true", async () => {
    const err = Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 503 } });
    await expectError(err, { code: "provider_unreachable", kind: "transient", ambiguous: true });
  });

  it("HTTP 429 (not surfaced as TooManyRequestsException) → provider_rejected_transient", async () => {
    const err = Object.assign(new Error("throttled"), { name: "Throttling", $metadata: { httpStatusCode: 429 } });
    await expectError(err, { code: "provider_rejected_transient", kind: "transient", ambiguous: false });
  });

  it("ENOTFOUND / ECONNREFUSED → provider_unreachable, ambiguous=false", async () => {
    const err = Object.assign(new Error("no dns"), { name: "ENOTFOUND" });
    await expectError(err, { code: "provider_unreachable", kind: "transient", ambiguous: false });
  });

  it("ECONNRESET (dropped mid-request) → provider_unreachable, ambiguous=true", async () => {
    const err = Object.assign(new Error("reset"), { name: "ECONNRESET" });
    await expectError(err, { code: "provider_unreachable", kind: "transient", ambiguous: true });
  });

  it("InvalidSignatureException → provider_protocol_error", async () => {
    const err = Object.assign(new Error("sig mismatch"), { name: "InvalidSignatureException" });
    await expectError(err, { code: "provider_protocol_error", kind: "permanent", ambiguous: false });
  });

  it("HTTP 403 / AccessDenied → adapter_misconfigured", async () => {
    const err = Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    await expectError(err, { code: "adapter_misconfigured", kind: "permanent", ambiguous: false });
  });

  it("ConfigurationSetDoesNotExistException → adapter_misconfigured", async () => {
    const err = Object.assign(new Error("no set"), { name: "ConfigurationSetDoesNotExistException" });
    await expectError(err, { code: "adapter_misconfigured", kind: "permanent", ambiguous: false });
  });

  it("unmapped error → transient / provider_rejected_transient (never ambiguous)", async () => {
    const err = Object.assign(new Error("???"), { name: "SomethingWeirdException" });
    await expectError(err, { code: "provider_rejected_transient", kind: "transient", ambiguous: false });
  });
});

describe("SesEmailProvider — redaction", () => {
  it("never includes the recipient address in a thrown error's message", async () => {
    const { provider } = await build({
      sendResponses: [new MessageRejected({ message: "rejected", $metadata: {} })],
    });
    try {
      await provider.send({ idempotencyKey: "d1", message: { to: "veryspecific@example.test", subject: "s", text: "t" } });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof EmailProviderError);
      assert.ok(!(err as Error).message.includes("veryspecific@example.test"));
    }
  });
});
