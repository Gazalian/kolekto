import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { EmailProviderError, type EmailSendRequest } from "../src/email-provider.ts";
import { MailpitEmailProvider } from "../src/mailpit-email-provider.ts";
import { closedPort, startSmtpServer, type SmtpTestServer } from "./smtp-test-server.ts";

const FROM = "no-reply@kolekto.example";
const KEY = "0198f0aa-0000-7000-8000-0000000000aa";

function req(patch: Partial<EmailSendRequest["message"]> = {}, key = KEY): EmailSendRequest {
  return { idempotencyKey: key, message: { to: "ada@example.com", subject: "Welcome to KWASU", text: "Your member ID is KWASU/0021.", ...patch } };
}

/** Split a raw RFC 5322 message into headers and body at the first blank line. */
function split(raw: string): { headers: string; body: string } {
  const at = raw.indexOf("\r\n\r\n");
  return { headers: raw.slice(0, at), body: raw.slice(at + 4) };
}

const decode = (b64: string): string => Buffer.from(b64.replace(/\r\n/g, ""), "base64").toString("utf8");

/** QUIT is sent after the adapter's promise settles' work is done; give the server a moment to read it. */
async function quitSeen(s: SmtpTestServer): Promise<void> {
  for (let i = 0; i < 100 && !s.commands.includes("QUIT"); i += 1) await new Promise((r) => setTimeout(r, 10));
}
let server: SmtpTestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function provider(script?: Parameters<typeof startSmtpServer>[0], timeoutMs = 2_000): Promise<MailpitEmailProvider> {
  server = await startSmtpServer(script);
  return new MailpitEmailProvider({ host: "127.0.0.1", port: server.port, from: FROM, timeoutMs });
}

describe("MailpitEmailProvider: construction refuses anything but a local catcher", () => {
  it("rejects a non-loopback host", () => {
    for (const host of ["smtp.example.com", "10.0.0.5", "192.168.1.10", "0.0.0.0", "127.0.0.1.evil.example"]) {
      assert.throws(
        () => new MailpitEmailProvider({ host, port: 1025, from: FROM }),
        (e: unknown) => e instanceof EmailProviderError && e.code === "adapter_misconfigured",
        host,
      );
    }
  });

  it("accepts loopback hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "LOCALHOST"]) {
      assert.doesNotThrow(() => new MailpitEmailProvider({ host, port: 1025, from: FROM }), host);
    }
  });

  it("rejects a bad port or sender", () => {
    for (const port of [0, -1, 70_000, 1.5, Number.NaN]) {
      assert.throws(() => new MailpitEmailProvider({ host: "127.0.0.1", port, from: FROM }), EmailProviderError);
    }
    assert.throws(() => new MailpitEmailProvider({ host: "127.0.0.1", port: 1025, from: "Kolekto <a@b.example>" }), EmailProviderError);
  });

  it("reports that it has no idempotency", () => {
    const p = new MailpitEmailProvider({ host: "127.0.0.1", port: 1025, from: FROM });
    assert.equal(p.name, "mailpit");
    assert.equal(p.idempotency, "none");
  });
});

describe("MailpitEmailProvider: the SMTP conversation", () => {
  it("speaks EHLO, MAIL, RCPT, DATA, QUIT in order and returns a deterministic message id", async () => {
    const p = await provider();
    const result = await p.send(req());
    await quitSeen(server!);
    assert.deepEqual(server!.commands, ["EHLO kolekto.invalid", `MAIL FROM:<${FROM}>`, "RCPT TO:<ada@example.com>", "DATA", "QUIT"]);
    assert.match(result.providerMessageId, /^[0-9a-f]{32}@kolekto\.invalid$/);
    assert.equal(server!.messages.length, 1);

    const again = await p.send(req());
    assert.equal(again.providerMessageId, result.providerMessageId, "same key, same Message-ID");
    assert.equal(server!.messages.length, 2, "SMTP has no idempotency: a repeat is a second copy");
  });

  it("sends a plain-text message with correct headers and a base64 body", async () => {
    const p = await provider();
    const result = await p.send(req());
    const { headers, body } = split(server!.messages[0]!.raw);
    assert.match(headers, new RegExp(`^From: ${FROM}$`, "m"));
    assert.match(headers, /^To: ada@example\.com$/m);
    assert.match(headers, /^Subject: Welcome to KWASU$/m);
    assert.match(headers, /^MIME-Version: 1\.0$/m);
    assert.match(headers, new RegExp(`^Message-ID: <${result.providerMessageId}>$`, "m"));
    assert.match(headers, new RegExp(`^X-Kolekto-Idempotency-Key: ${KEY}$`, "m"));
    assert.match(headers, /^Content-Type: text\/plain; charset=utf-8$/m);
    assert.match(headers, /^Content-Transfer-Encoding: base64$/m);
    assert.equal(decode(body), "Your member ID is KWASU/0021.");
  });

  it("sends multipart/alternative with both parts when html is supplied", async () => {
    const p = await provider();
    await p.send(req({ html: "<p>Your member ID is <b>KWASU/0021</b>.</p>" }));
    const { headers, body } = split(server!.messages[0]!.raw);
    const boundary = /Content-Type: multipart\/alternative; boundary="([^"]+)"/.exec(headers)?.[1];
    assert.ok(boundary, "multipart header with a boundary");
    const parts = body.split(`--${boundary}`).filter((s) => s.trim() !== "" && s.trim() !== "--");
    assert.equal(parts.length, 2);
    assert.match(parts[0]!, /text\/plain/);
    assert.match(parts[1]!, /text\/html/);
    assert.equal(decode(parts[0]!.split("\r\n\r\n")[1]!), "Your member ID is KWASU/0021.");
    assert.equal(decode(parts[1]!.split("\r\n\r\n")[1]!), "<p>Your member ID is <b>KWASU/0021</b>.</p>");
    assert.ok(body.includes(`--${boundary}--`), "closing boundary");
  });

  it("round-trips non-ASCII names and subjects (RFC 2047) and HTML-like text untouched", async () => {
    const p = await provider();
    const subject = "Ẹ káàbọ̀, Adébáyọ̀ — you're in";
    const text = "Name: <script>alert(1)</script> & “quotes” ✓\n.leading dot line\n\n..two dots";
    await p.send(req({ subject, text }));
    const { headers, body } = split(server!.messages[0]!.raw);
    const unfolded = headers.replace(/\r\n /g, " ");
    const subjectLine = /^Subject: (.*)$/m.exec(unfolded)?.[1] ?? "";
    assert.ok(subjectLine.startsWith("=?UTF-8?B?"), "non-ASCII subject is encoded-word");
    const decodedSubject = [...subjectLine.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8")).join("");
    assert.equal(decodedSubject, subject);
    assert.equal(decode(body), text, "body is carried verbatim; dot lines cannot end the DATA phase");
    assert.equal(server!.messages.length, 1);
  });

  it("keeps every encoded-word within the 75-character limit", async () => {
    const p = await provider();
    await p.send(req({ subject: "Ẹ".repeat(60) }));
    const { headers } = split(server!.messages[0]!.raw);
    for (const word of headers.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? []) assert.ok(word.length <= 75, `${word.length}: ${word}`);
  });

  it("omits the key header when the key is not printable ASCII", async () => {
    const p = await provider();
    await p.send(req({}, "kéy-ünïcode"));
    assert.ok(!/X-Kolekto-Idempotency-Key/.test(split(server!.messages[0]!.raw).headers));
  });
});

describe("MailpitEmailProvider: injection and validation happen before any connection", () => {
  it("never connects for a request that fails validation", async () => {
    const p = await provider();
    const attempts: EmailSendRequest[] = [
      req({ subject: "Hi\r\nBcc: evil@example.com" }),
      req({ to: "ada@example.com\r\nRCPT TO:<evil@example.com>" }),
      req({ to: "a@example.com, b@example.com" }),
      req({ text: "" }),
      req({}, "key\r\nX-Injected: 1"),
    ];
    for (const attempt of attempts) {
      await assert.rejects(p.send(attempt), (e: unknown) => e instanceof EmailProviderError && e.code === "invalid_message" && e.kind === "permanent");
    }
    assert.equal(server!.connections(), 0);
  });

  it("a body that contains MIME-boundary-looking or SMTP-terminator text cannot alter the framing", async () => {
    const p = await provider();
    const hostile = "line\r\n.\r\nQUIT\r\n--kolekto-fake\r\nRCPT TO:<evil@example.com>";
    await p.send(req({ text: hostile, html: `<p>${hostile}</p>` }));
    await quitSeen(server!);
    assert.equal(server!.messages.length, 1);
    assert.deepEqual(server!.messages[0]!.rcptTo, ["ada@example.com"]);
    assert.deepEqual(server!.commands, ["EHLO kolekto.invalid", `MAIL FROM:<${FROM}>`, "RCPT TO:<ada@example.com>", "DATA", "QUIT"]);
  });
});

describe("MailpitEmailProvider: failure classification", () => {
  it("a 4xx reply is transient", async () => {
    const p = await provider({ rcptTo: "451 4.3.0 try later" });
    await assert.rejects(p.send(req()), (e: unknown) => e instanceof EmailProviderError && e.kind === "transient" && e.code === "provider_rejected_transient");
  });

  it("a 5xx reply is permanent, and the server's text and the address are not in our error", async () => {
    const p = await provider({ rcptTo: "550 5.1.1 <ada@example.com> user unknown" });
    await assert.rejects(p.send(req()), (e: unknown) => {
      return (
        e instanceof EmailProviderError &&
        e.kind === "permanent" &&
        e.code === "provider_rejected_permanent" &&
        !e.message.includes("ada@example.com") &&
        !e.message.includes("user unknown")
      );
    });
  });

  it("a 5xx after the body is permanent", async () => {
    const p = await provider({ afterData: "554 5.7.1 rejected" });
    await assert.rejects(p.send(req()), (e: unknown) => e instanceof EmailProviderError && e.kind === "permanent");
  });

  it("an unexpected reply code is a permanent protocol error", async () => {
    const p = await provider({ mailFrom: "300 what" });
    await assert.rejects(p.send(req()), (e: unknown) => e instanceof EmailProviderError && e.code === "provider_protocol_error" && e.kind === "permanent");
  });

  it("a refused connection is transient and unreachable", async () => {
    const port = await closedPort();
    const p = new MailpitEmailProvider({ host: "127.0.0.1", port, from: FROM, timeoutMs: 1_000 });
    await assert.rejects(p.send(req()), (e: unknown) => e instanceof EmailProviderError && e.kind === "transient" && e.code === "provider_unreachable");
  });

  it("a server that never greets times out as transient", async () => {
    const p = await provider({ greeting: "" }, 150);
    await assert.rejects(p.send(req()), (e: unknown) => e instanceof EmailProviderError && e.kind === "transient" && e.code === "provider_timeout");
  });

  it("a drop after the body is sent is transient: the ambiguous case is reported, never hidden", async () => {
    const p = await provider({ afterData: null });
    await assert.rejects(p.send(req()), (e: unknown) => {
      return e instanceof EmailProviderError && e.kind === "transient" && e.code === "provider_unreachable" && /before the server confirmed/.test(e.message);
    });
    assert.equal(server!.messages.length, 1, "the server did receive it — which is why a retry can duplicate");
  });
});
