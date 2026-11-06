/**
 * itest-smtp-fault-proxy.ts — scripted SMTP failures in front of the test Mailpit (M13.2 Phase 7).
 *
 * Mailpit accepts everything, so it cannot produce a rejection or the ambiguous case where a message
 * is delivered but the client never hears so. This small TCP proxy can, and because it really does
 * forward to Mailpit it can prove what Mailpit received.
 *
 * It cannot reach anything else. The upstream host is the constant literal 127.0.0.1 and there is no
 * option for it; startFaultProxy takes its port only from a verified gate environment. The listener
 * binds 127.0.0.1 on an ephemeral port. No DNS lookup, TLS, AUTH or relay exists here.
 *
 * Only command verbs are recorded (MAIL, RCPT, DATA, …), never their arguments, so an address or a
 * message body never reaches the proxy's log.
 */

import net from "node:net";

import { DEV_PORT_RANGE, ITEST_PORT_RANGE } from "./itest-environment.ts";
import { assertVerifiedEnvironment, type VerifiedIntegrationEnvironment } from "./itest-gate.ts";

const UPSTREAM_HOST = "127.0.0.1";

export type FaultScript =
  /** Relays everything. */
  | { readonly kind: "pass" }
  /** Answers this code itself when the client sends the verb, and forwards nothing further. */
  | { readonly kind: "reject"; readonly verb: "MAIL" | "RCPT" | "DATA"; readonly code: number }
  /** Forwards the body so Mailpit accepts it, then drops the client before it sees the 250. */
  | { readonly kind: "deliver-then-drop" }
  /** Holds the body back and never answers: the client waits. Nothing reaches Mailpit. */
  | { readonly kind: "hold-after-data" }
  /** Holds the body back until release(), then relays everything: a send that pauses, then succeeds. */
  | { readonly kind: "hold-until-released" };

export interface FaultProxy {
  readonly port: number;
  setScript(script: FaultScript): void;
  /** Lets a "hold-until-released" connection continue. */
  release(): void;
  /** One entry per client connection: the verbs seen and what the proxy did. Never an argument. */
  connections(): readonly { readonly verbs: readonly string[]; readonly outcome: string }[];
  close(): Promise<void>;
}

/** The core, with the upstream host fixed. Exported for unit tests against an in-process upstream. */
export function startLoopbackFaultProxy(upstreamPort: number, initial: FaultScript): Promise<FaultProxy> {
  let script = initial;
  const log: { verbs: string[]; outcome: string }[] = [];
  const sockets = new Set<net.Socket>();
  let holdReleased = false;
  const heldFlushers = new Set<() => void>();

  const server = net.createServer((client) => {
    const entry = { verbs: [] as string[], outcome: "open" };
    log.push(entry);
    const active = script;
    const upstream = net.createConnection({ host: UPSTREAM_HOST, port: upstreamPort });
    sockets.add(client);
    sockets.add(upstream);
    let inBody = false;
    let bodyEnded = false;
    let rejected = false;
    let buffered = "";
    // Body chunks waiting for release(). Only ever forwarded, never read or recorded.
    const heldBody: string[] = [];
    heldFlushers.add(() => {
      for (const chunk of heldBody) upstream.write(chunk, "latin1");
      heldBody.length = 0;
    });

    const shut = (outcome: string) => {
      if (entry.outcome === "open") entry.outcome = outcome;
      client.destroy();
      upstream.destroy();
    };

    upstream.setEncoding("latin1");
    client.setEncoding("latin1");

    upstream.on("data", (chunk: string) => {
      if (active.kind === "deliver-then-drop" && bodyEnded) {
        // Mailpit answered the body. The client never sees it.
        shut("delivered-then-dropped");
        return;
      }
      client.write(chunk, "latin1");
    });

    client.on("data", (chunk: string) => {
      if (rejected) return;
      if (inBody) {
        // Only the tail is kept: enough to see the terminator, never the message.
        buffered = (buffered + chunk).slice(-5);
        if (buffered === "\r\n.\r\n") {
          inBody = false;
          bodyEnded = true;
          buffered = "";
        }
        if (active.kind === "hold-after-data") {
          if (bodyEnded) entry.outcome = "held-after-data";
          return;
        }
        if (active.kind === "hold-until-released" && !holdReleased) {
          heldBody.push(chunk);
          return;
        }
        upstream.write(chunk, "latin1");
        return;
      }
      buffered += chunk;
      let index = buffered.indexOf("\r\n");
      while (index !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        const verb = line.split(/[\s:]/, 1)[0]?.toUpperCase() ?? "";
        entry.verbs.push(verb);
        if (active.kind === "reject" && active.verb === verb) {
          entry.outcome = `rejected-${active.code}`;
          rejected = true;
          client.write(`${active.code} scripted by the test fault proxy\r\n`);
          upstream.destroy();
          return;
        }
        upstream.write(`${line}\r\n`, "latin1");
        if (verb === "DATA") {
          inBody = true;
          buffered = "";
          return;
        }
        index = buffered.indexOf("\r\n");
      }
    });

    client.on("close", () => shut("client-closed"));
    upstream.on("close", () => {
      // A rejection is already on its way to the client, which closes when it reads it.
      if (!rejected && (active.kind !== "hold-after-data" || !bodyEnded)) client.destroy();
    });
    client.on("error", () => shut("client-error"));
    upstream.on("error", () => shut("upstream-error"));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, UPSTREAM_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fault proxy has no port"));
        return;
      }
      resolve({
        port: address.port,
        setScript(next) {
          script = next;
        },
        release() {
          holdReleased = true;
          for (const flush of heldFlushers) flush();
        },
        connections: () => log,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** A proxy in front of the verified test Mailpit, and nothing else. */
export function startFaultProxy(env: VerifiedIntegrationEnvironment, initial: FaultScript): Promise<FaultProxy> {
  assertVerifiedEnvironment(env);
  return startLoopbackFaultProxy(env.smtp.port, initial);
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, UPSTREAM_HOST, () => {
      const address = probe.address();
      const port = address !== null && typeof address !== "string" ? address.port : 0;
      probe.close(() => (port === 0 ? reject(new Error("no port")) : resolve(port)));
    });
  });
}

/** A loopback port with nothing listening, for the refused-connection case. Never one the stacks use. */
export async function findClosedLoopbackPort(): Promise<number> {
  for (;;) {
    const port = await freeLoopbackPort();
    const reserved = [DEV_PORT_RANGE, ITEST_PORT_RANGE].some((r) => port >= r.min && port <= r.max);
    if (!reserved) return port;
  }
}
