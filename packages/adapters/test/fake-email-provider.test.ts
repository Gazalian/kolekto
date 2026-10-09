import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EmailProviderError, type EmailSendRequest } from "../src/email-provider.ts";
import { FakeEmailProvider } from "../src/fake-email-provider.ts";

function request(key: string, to = "ada@example.com"): EmailSendRequest {
  return { idempotencyKey: key, message: { to, subject: "Welcome", text: "Hello", html: "<p>Hello</p>" } };
}

describe("FakeEmailProvider", () => {
  it("is obviously not real", async () => {
    const fake = new FakeEmailProvider();
    assert.equal(fake.name, "fake");
    const { providerMessageId } = await fake.send(request("k1"));
    assert.match(providerMessageId, /^FAKE_EMAIL_[0-9a-f]{16}$/);
  });

  it("is deterministic: same key, same id, on every instance", async () => {
    const a = await new FakeEmailProvider().send(request("same-key"));
    const b = await new FakeEmailProvider().send(request("same-key"));
    assert.deepEqual(a, b);
    const c = await new FakeEmailProvider().send(request("other-key"));
    assert.notEqual(a.providerMessageId, c.providerMessageId);
  });

  it("records what it was asked to send, in order", async () => {
    const fake = new FakeEmailProvider();
    await fake.send(request("k1", "a@example.com"));
    await fake.send(request("k2", "b@example.com"));
    assert.deepEqual(fake.outbox.map((r) => r.message.to), ["a@example.com", "b@example.com"]);
    assert.equal(fake.outbox[0]?.message.html, "<p>Hello</p>");
  });

  it("hands out copies, so tests cannot corrupt its record", async () => {
    const fake = new FakeEmailProvider();
    await fake.send(request("k1"));
    const copy = fake.outbox;
    (copy[0] as { message: { subject: string } }).message.subject = "tampered";
    assert.equal(fake.outbox[0]?.message.subject, "Welcome");
  });

  it("validates exactly as a real adapter does", async () => {
    const fake = new FakeEmailProvider();
    await assert.rejects(
      fake.send({ idempotencyKey: "k", message: { to: "x@example.com", subject: "a\r\nb", text: "t" } }),
      (e: unknown) => e instanceof EmailProviderError && e.code === "invalid_message" && e.kind === "permanent",
    );
    assert.equal(fake.outbox.length, 0);
    assert.equal(fake.attempts, 0, "an invalid request never reaches the provider");
  });

  describe("provider-side idempotency (the default)", () => {
    it("reports it", () => {
      assert.equal(new FakeEmailProvider().idempotency, "provider");
    });

    it("a repeated key delivers one message and returns the first result", async () => {
      const fake = new FakeEmailProvider();
      const first = await fake.send(request("dup"));
      const second = await fake.send(request("dup"));
      assert.deepEqual(first, second);
      assert.equal(fake.outbox.length, 1);
      assert.equal(fake.attempts, 2);
    });

    it("a de-duplicated repeat does not consume a scripted failure", async () => {
      const fake = new FakeEmailProvider();
      await fake.send(request("dup"));
      fake.enqueue({ type: "transient" });
      await fake.send(request("dup")); // served from the idempotency record
      await assert.rejects(fake.send(request("fresh")), EmailProviderError); // the failure is still waiting
    });
  });

  describe("without provider idempotency", () => {
    it("reports it, and a repeat delivers a second copy with a distinct id", async () => {
      const fake = new FakeEmailProvider({ idempotency: "none" });
      assert.equal(fake.idempotency, "none");
      const first = await fake.send(request("dup"));
      const second = await fake.send(request("dup"));
      assert.equal(fake.outbox.length, 2);
      assert.notEqual(first.providerMessageId, second.providerMessageId);
    });
  });

  describe("scripted failures", () => {
    it("fail in order, then succeed", async () => {
      const fake = new FakeEmailProvider();
      fake.enqueue({ type: "transient" }, { type: "permanent", code: "provider_protocol_error" });

      await assert.rejects(fake.send(request("k")), (e: unknown) => e instanceof EmailProviderError && e.kind === "transient" && e.code === "provider_unreachable");
      await assert.rejects(fake.send(request("k")), (e: unknown) => e instanceof EmailProviderError && e.kind === "permanent" && e.code === "provider_protocol_error");
      const ok = await fake.send(request("k"));
      assert.match(ok.providerMessageId, /^FAKE_EMAIL_/);
      assert.equal(fake.outbox.length, 1, "failed attempts are not delivered");
      assert.equal(fake.attempts, 3);
    });

    it("failure messages are ours, not a provider's, and name no recipient", async () => {
      const fake = new FakeEmailProvider();
      fake.enqueue({ type: "permanent" });
      await assert.rejects(fake.send(request("k", "private.person@example.com")), (e: unknown) => {
        return e instanceof EmailProviderError && !e.message.includes("private.person");
      });
    });

    it("reset clears the outbox, results, script and counters", async () => {
      const fake = new FakeEmailProvider();
      await fake.send(request("k"));
      fake.enqueue({ type: "transient" });
      fake.reset();
      assert.equal(fake.outbox.length, 0);
      assert.equal(fake.attempts, 0);
      await fake.send(request("k")); // would have failed, and would have been de-duplicated, before reset
      assert.equal(fake.outbox.length, 1);
    });
  });
});
