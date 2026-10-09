/**
 * smtp-test-server.ts — a scriptable, in-process SMTP server for adapter tests.
 *
 * Listens on 127.0.0.1 on an ephemeral port, records the command transcript and
 * each received message, and lets a test script the reply to any stage. This is
 * what lets the Mailpit adapter be tested at protocol level on any machine,
 * with no Docker and no real Mailpit. (Real Mailpit is exercised in P8.)
 */

import net from "node:net";

export interface SmtpScript {
  /** Replace the greeting. Use "" to send none (simulates a hung server). */
  readonly greeting?: string;
  readonly mailFrom?: string;
  readonly rcptTo?: string;
  /** Reply after the message body. Use null to drop the connection instead. */
  readonly afterData?: string | null;
}

export interface ReceivedMessage {
  readonly mailFrom: string;
  readonly rcptTo: string[];
  readonly raw: string;
}

export interface SmtpTestServer {
  readonly port: number;
  readonly commands: string[];
  readonly messages: ReceivedMessage[];
  readonly connections: () => number;
  close(): Promise<void>;
}

export async function startSmtpServer(script: SmtpScript = {}): Promise<SmtpTestServer> {
  const commands: string[] = [];
  const messages: ReceivedMessage[] = [];
  let connectionCount = 0;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");

    let buffer = "";
    let inData = false;
    let mailFrom = "";
    let rcptTo: string[] = [];
    let body = "";

    const reply = (line: string): void => {
      if (line !== "") socket.write(`${line}\r\n`);
    };

    reply(script.greeting ?? "220 smtp.test ESMTP ready");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          body = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push({ mailFrom, rcptTo, raw: body });
          if (script.afterData === null) {
            socket.destroy();
            return;
          }
          reply(script.afterData ?? "250 2.0.0 Ok: queued");
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        commands.push(line);
        const verb = line.split(/[ :]/)[0]?.toUpperCase();
        if (verb === "EHLO") reply("250-smtp.test\r\n250 8BITMIME");
        else if (verb === "MAIL") {
          mailFrom = /<(.*)>/.exec(line)?.[1] ?? "";
          reply(script.mailFrom ?? "250 2.1.0 Ok");
        } else if (verb === "RCPT") {
          const to = /<(.*)>/.exec(line)?.[1] ?? "";
          const scripted = script.rcptTo ?? "250 2.1.5 Ok";
          if (scripted.startsWith("25")) rcptTo = [...rcptTo, to];
          reply(scripted);
        } else if (verb === "DATA") {
          reply("354 End data with <CR><LF>.<CR><LF>");
          inData = true;
        } else if (verb === "QUIT") {
          reply("221 Bye");
          socket.end();
        } else reply("502 5.5.2 Command not recognized");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("SMTP test server failed to bind");

  return {
    port: address.port,
    commands,
    messages,
    connections: () => connectionCount,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port that nothing listens on: bind an ephemeral port, then release it. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
