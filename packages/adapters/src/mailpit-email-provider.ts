/**
 * mailpit-email-provider.ts — SMTP to a Mailpit on this machine. Development and CI only.
 *
 * M13.2 / P1. Mailpit catches mail and shows it in a web UI (published at
 * http://127.0.0.1:54324 by `supabase start`); nothing is relayed onward. That
 * is the whole point: the sender can be exercised end to end — recipient
 * selection, content, retries — with no possibility of a real mailbox
 * receiving anything.
 *
 * ── WHY A SMALL HAND-WRITTEN CLIENT AND NOT A LIBRARY ───────────────────────
 * Production providers are HTTPS APIs (P9), so SMTP is needed only to talk to
 * a local catcher. A general SMTP/MIME dependency would add a supply-chain
 * surface to a package that is the only outbound caller (ADR 0001) in exchange
 * for features this adapter must not have: TLS negotiation, authentication,
 * relaying, pooling. What it does instead is narrow and checked:
 *   - connects only to a loopback host, and refuses to be constructed otherwise;
 *   - no AUTH, no STARTTLS — a server that wants them is not a local catcher;
 *   - every header value is validated free of CR/LF before use (header
 *     injection), the subject is RFC 2047-encoded, and bodies are base64 so no
 *     body line can be mistaken for SMTP dot-termination or a MIME boundary.
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 * SMTP has none. `idempotency` is "none": a repeated send delivers a second
 * copy. The Message-ID is derived from the idempotency key so the duplicate is
 * visible in Mailpit, which is how P8 proves duplicate prevention works above
 * this layer rather than relying on this one.
 *
 * ── THE AMBIGUOUS CASE ──────────────────────────────────────────────────────
 * If the connection drops after the message body has been sent but before the
 * server's final reply, the message may or may not have been accepted. That is
 * reported as a *transient* `provider_unreachable` with `ambiguous: true`; a
 * retry can duplicate. Failures before the DATA phase carry `ambiguous: false`
 * because nothing sendable was transmitted, and explicit server rejections
 * carry `ambiguous: false` because the outcome is known. This
 * is the residual external-delivery risk the decision record documents (§10.3)
 * and is why this adapter reports `idempotency: "none"`.
 */

import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

import {
  assertValidEmailRequest,
  EmailProviderError,
  isValidEmailAddress,
  type EmailProvider,
  type EmailSendRequest,
  type EmailSendResult,
} from "./email-provider.ts";

export interface MailpitEmailProviderOptions {
  readonly host: string;
  readonly port: number;
  readonly from: string;
  /** Socket inactivity timeout in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MESSAGE_ID_DOMAIN = "kolekto.invalid"; // RFC 2606: can never resolve.

export class MailpitEmailProvider implements EmailProvider {
  readonly name = "mailpit" as const;
  readonly idempotency = "none" as const;

  readonly #host: string;
  readonly #port: number;
  readonly #from: string;
  readonly #timeoutMs: number;

  constructor(options: MailpitEmailProviderOptions) {
    if (!LOOPBACK_HOSTS.has(options.host.toLowerCase())) {
      throw misconfigured("the Mailpit adapter connects to this machine only; the host is not a loopback address");
    }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw misconfigured("the Mailpit adapter port is not a valid TCP port");
    }
    if (!isValidEmailAddress(options.from)) {
      throw misconfigured("the Mailpit adapter sender address is not a valid email address");
    }
    this.#host = options.host.replace(/^\[|\]$/g, "");
    this.#port = options.port;
    this.#from = options.from;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    assertValidEmailRequest(request);
    const messageId = messageIdFor(request.idempotencyKey);
    const data = buildMessage(this.#from, request, messageId);
    await smtpTransaction({
      host: this.#host,
      port: this.#port,
      timeoutMs: this.#timeoutMs,
      from: this.#from,
      to: request.message.to,
      data,
    });
    return { providerMessageId: messageId };
  }
}

function misconfigured(message: string): EmailProviderError {
  return new EmailProviderError("permanent", "adapter_misconfigured", message);
}

// ── Message construction ─────────────────────────────────────────────────────

function messageIdFor(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return `${digest}@${MESSAGE_ID_DOMAIN}`;
}

/** Wrap base64 at 76 columns with CRLF, as MIME requires. */
function base64Lines(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return (encoded.match(/.{1,76}/g) ?? []).join("\r\n");
}

/** RFC 2047 encoded-word, used whenever the subject is not plain printable ASCII. */
function encodeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(subject) && !subject.includes("=?")) return subject;
  // Encoded-words are limited to 75 characters, so split on code points, never mid-character.
  const words: string[] = [];
  let current = "";
  for (const char of subject) {
    const candidate = current + char;
    if (Buffer.from(candidate, "utf8").length > 40) {
      words.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) words.push(current);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

function buildMessage(from: string, request: EmailSendRequest, messageId: string): string {
  const { message, idempotencyKey } = request;
  const headers: string[] = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeSubject(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "X-Kolekto-Adapter: mailpit",
  ];
  // Only a printable-ASCII key may travel as a header; otherwise the Message-ID (a hash) already identifies it.
  // eslint-disable-next-line no-control-regex
  if (/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) headers.push(`X-Kolekto-Idempotency-Key: ${idempotencyKey}`);

  const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(message.text)].join("\r\n");

  if (message.html === undefined) {
    return `${headers.join("\r\n")}\r\n${textPart}\r\n`;
  }

  const boundary = `kolekto-${randomBytes(12).toString("hex")}`;
  const htmlPart = ["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(message.html)].join("\r\n");
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    textPart,
    `--${boundary}`,
    htmlPart,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** SMTP dot-stuffing. Bodies are base64 so this never fires today; it keeps the framing safe if that changes. */
function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, "$1..");
}

// ── SMTP transaction ─────────────────────────────────────────────────────────

interface SmtpReply {
  readonly code: number;
}

interface SmtpTransaction {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly from: string;
  readonly to: string;
  readonly data: string;
}

function smtpTransaction(t: SmtpTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: t.host, port: t.port });
    socket.setEncoding("utf8");
    socket.setTimeout(t.timeoutMs);

    let buffer = "";
    let waiting: ((reply: SmtpReply) => void) | undefined;
    const ready: SmtpReply[] = [];
    let settled = false;
    let dataSent = false;
    let confirmed = false; // the server accepted the message; only the courtesy QUIT remains

    const finish = (error?: EmailProviderError): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    const pump = (): void => {
      // A reply ends at a line whose fourth character is a space ("250 OK"); "250-..." continues it.
      for (;;) {
        const lines = buffer.split("\r\n");
        const complete = lines.slice(0, -1);
        const endIndex = complete.findIndex((line) => /^\d{3} /.test(line) || /^\d{3}$/.test(line));
        if (endIndex === -1) return;
        const last = complete[endIndex] ?? "";
        buffer = lines.slice(endIndex + 1).join("\r\n");
        const reply: SmtpReply = { code: Number(last.slice(0, 3)) };
        if (waiting) {
          const w = waiting;
          waiting = undefined;
          w(reply);
        } else {
          ready.push(reply);
        }
      }
    };

    const nextReply = (): Promise<SmtpReply> =>
      new Promise<SmtpReply>((res) => {
        const queued = ready.shift();
        if (queued) res(queued);
        else waiting = res;
      });

    const expect = async (accepted: readonly number[]): Promise<SmtpReply> => {
      const reply = await nextReply();
      if (accepted.includes(reply.code)) return reply;
      if (reply.code >= 400 && reply.code < 500) {
        throw new EmailProviderError("transient", "provider_rejected_transient", `SMTP server deferred the message (${reply.code})`, false);
      }
      if (reply.code >= 500 && reply.code < 600) {
        throw new EmailProviderError("permanent", "provider_rejected_permanent", `SMTP server rejected the message (${reply.code})`, false);
      }
      throw new EmailProviderError("permanent", "provider_protocol_error", `unexpected SMTP reply (${reply.code})`, false);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      pump();
    });
    socket.on("timeout", () => {
      if (confirmed) return;
      // A timeout before DATA was sent proves nothing was accepted. At or
      // after DATA the message may have been accepted without the reply
      // arriving, so the outcome is ambiguous.
      finish(new EmailProviderError("transient", "provider_timeout", "SMTP connection timed out", dataSent));
    });
    socket.on("error", () => {
      if (confirmed) return;
      finish(new EmailProviderError("transient", "provider_unreachable", "SMTP connection failed", dataSent));
    });
    socket.on("close", () => {
      if (confirmed) {
        finish();
        return;
      }
      // Closed before the server confirmed. After the body was sent this is the ambiguous case described in the header.
      finish(
        new EmailProviderError(
          "transient",
          "provider_unreachable",
          dataSent ? "SMTP connection closed before the server confirmed the message" : "SMTP connection closed unexpectedly",
          dataSent,
        ),
      );
    });

    const write = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    void (async () => {
      try {
        await expect([220]);
        write(`EHLO ${MESSAGE_ID_DOMAIN}`);
        await expect([250]);
        write(`MAIL FROM:<${t.from}>`);
        await expect([250]);
        write(`RCPT TO:<${t.to}>`);
        await expect([250, 251]);
        write("DATA");
        await expect([354]);
        dataSent = true;
        socket.write(`${dotStuff(t.data)}\r\n.\r\n`);
        await expect([250]);
        confirmed = true;
        // Flush QUIT before closing; destroying the socket straight away would drop it.
        socket.end("QUIT\r\n", () => finish());
      } catch (error) {
        finish(error instanceof EmailProviderError ? error : new EmailProviderError("transient", "provider_unreachable", "SMTP transaction failed", false));
      }
    })();
  });
}
