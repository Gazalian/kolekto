import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertValidEmailRequest,
  EmailProviderError,
  isValidEmailAddress,
  type EmailSendRequest,
} from "../src/email-provider.ts";

const good: EmailSendRequest = {
  idempotencyKey: "0198f0aa-0000-7000-8000-000000000001",
  message: { to: "ada@example.com", subject: "Welcome", text: "Hello Ada" },
};

function withMessage(patch: Partial<EmailSendRequest["message"]>, key = good.idempotencyKey): EmailSendRequest {
  return { idempotencyKey: key, message: { ...good.message, ...patch } };
}

function rejects(request: EmailSendRequest, pattern: RegExp): void {
  assert.throws(
    () => assertValidEmailRequest(request),
    (err: unknown) =>
      err instanceof EmailProviderError && err.kind === "permanent" && err.code === "invalid_message" && pattern.test(err.message),
  );
}

describe("isValidEmailAddress", () => {
  it("accepts ordinary addresses", () => {
    for (const a of ["ada@example.com", "a.b+tag@sub.example.co.ke", "x_y-z@example.org"]) assert.ok(isValidEmailAddress(a), a);
  });

  it("rejects malformed, multiple, display-name and injected addresses", () => {
    const bad = [
      "",
      "no-at-sign",
      "a@b",
      "a@@b.com",
      "Ada <ada@example.com>",
      "a@example.com, b@example.com",
      "a@example.com\r\nBcc: evil@example.com",
      "a@example.com\nX: y",
      "a b@example.com",
      ".a@example.com",
      "a..b@example.com",
      "a@-example.com",
      "a@example..com",
      `${"x".repeat(65)}@example.com`,
      `a@${"x".repeat(250)}.com`,
      `a@example.com${String.fromCharCode(0x2028)}`,
    ];
    for (const a of bad) assert.ok(!isValidEmailAddress(a), JSON.stringify(a));
  });
});

describe("assertValidEmailRequest", () => {
  it("accepts a well-formed request, with and without html", () => {
    assert.doesNotThrow(() => assertValidEmailRequest(good));
    assert.doesNotThrow(() => assertValidEmailRequest(withMessage({ html: "<p>Hello</p>" })));
  });

  it("rejects a bad recipient without echoing it", () => {
    let message = "";
    try {
      assertValidEmailRequest(withMessage({ to: "secret.person@@example.com" }));
    } catch (err) {
      message = (err as Error).message;
    }
    assert.match(message, /message\.to/);
    assert.ok(!message.includes("secret.person"));
  });

  it("rejects header injection through the subject", () => {
    rejects(withMessage({ subject: "Hi\r\nBcc: evil@example.com" }), /subject/);
    rejects(withMessage({ subject: "Hi\nthere" }), /subject/);
    rejects(withMessage({ subject: `Hi${String.fromCharCode(0x2029)}there` }), /subject/);
  });

  it("rejects an empty or oversized subject, and an empty text part", () => {
    rejects(withMessage({ subject: "  " }), /subject/);
    rejects(withMessage({ subject: "x".repeat(201) }), /subject/);
    rejects(withMessage({ text: "   " }), /plain-text/);
  });

  it("rejects an empty html part when one is supplied", () => {
    rejects(withMessage({ html: "  " }), /html/);
  });

  it("rejects bad idempotency keys", () => {
    rejects(withMessage({}, ""), /idempotencyKey/);
    rejects(withMessage({}, "k\r\nX: y"), /idempotencyKey/);
    rejects(withMessage({}, "k".repeat(201)), /idempotencyKey/);
  });
});

describe("EmailProviderError", () => {
  it("carries a kind and a stable code", () => {
    const e = new EmailProviderError("transient", "provider_timeout", "x");
    assert.equal(e.kind, "transient");
    assert.equal(e.code, "provider_timeout");
    assert.equal(e.name, "EmailProviderError");
    assert.ok(e instanceof Error);
  });

  it("defaults to unambiguous so existing call sites keep their meaning", () => {
    const e = new EmailProviderError("transient", "provider_unreachable", "x");
    assert.equal(e.ambiguous, false);
  });

  it("records an explicitly ambiguous outcome", () => {
    const e = new EmailProviderError("transient", "provider_timeout", "x", true);
    assert.equal(e.kind, "transient");
    assert.equal(e.code, "provider_timeout");
    assert.equal(e.ambiguous, true);
  });
});
