/**
 * fake-email-provider.ts — a deterministic email provider for tests.
 *
 * Same three properties as fake-payment-provider.ts, and for the same reason:
 *
 * 1. **No network. Ever.** No socket, no fetch, no clock read.
 * 2. **Deterministic.** The provider message id is derived from the idempotency
 *    key, so a failing test is reproducible from its output alone.
 * 3. **Obviously not real.** `name` is "fake" and every id is prefixed
 *    `FAKE_EMAIL_`. Nothing here can be mistaken for working email, which
 *    matters because the failure being guarded against is somebody believing
 *    mail is being delivered. The startup guard (packages/config/src/email.ts)
 *    refuses this adapter in production for the same reason.
 *
 * It models a provider WITH idempotency support (`idempotency: "provider"`): a
 * repeated key returns the first result and records no second message. That is
 * the behaviour the sender (P5) is specified against. Tests for a provider
 * WITHOUT it construct the fake with `{ idempotency: "none" }`, where a repeat
 * is recorded again — the duplicate the decision record's §10.3 describes.
 *
 * Failure injection is scripted, in order, via `enqueue`. Once the script is
 * exhausted every send succeeds, so a test states exactly the failures it
 * wants and nothing else.
 */

import { createHash } from "node:crypto";

import {
  assertValidEmailRequest,
  EmailProviderError,
  type EmailErrorCode,
  type EmailIdempotency,
  type EmailProvider,
  type EmailSendRequest,
  type EmailSendResult,
} from "./email-provider.ts";

export type FakeEmailOutcome =
  | {
      readonly type: "transient";
      readonly code?: Extract<EmailErrorCode, "provider_unreachable" | "provider_timeout" | "provider_rejected_transient">;
      /**
       * Whether the scripted failure happened after the provider may have
       * accepted the message. Defaults to true for `provider_timeout` (a
       * timeout never proves the message was not accepted) and to false
       * otherwise, so a refused connection stays unambiguous unless a test
       * explicitly scripts a drop after sending.
       */
      readonly ambiguous?: boolean;
    }
  | { readonly type: "permanent"; readonly code?: Extract<EmailErrorCode, "provider_rejected_permanent" | "provider_protocol_error"> };

export interface FakeEmailProviderOptions {
  readonly idempotency?: EmailIdempotency;
}

export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake" as const;
  readonly idempotency: EmailIdempotency;

  #outbox: EmailSendRequest[] = [];
  #results = new Map<string, EmailSendResult>();
  #script: FakeEmailOutcome[] = [];
  #attempts = 0;

  constructor(options: FakeEmailProviderOptions = {}) {
    this.idempotency = options.idempotency ?? "provider";
  }

  /** Messages the fake "delivered", in order. Copies — mutating them changes nothing. */
  get outbox(): readonly EmailSendRequest[] {
    return this.#outbox.map((r) => ({ idempotencyKey: r.idempotencyKey, message: { ...r.message } }));
  }

  /** Every call to `send` that passed validation, including failed and de-duplicated ones. */
  get attempts(): number {
    return this.#attempts;
  }

  /** Queue outcomes for the next sends, consumed first-in first-out. */
  enqueue(...outcomes: FakeEmailOutcome[]): void {
    this.#script.push(...outcomes);
  }

  reset(): void {
    this.#outbox = [];
    this.#results.clear();
    this.#script = [];
    this.#attempts = 0;
  }

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    assertValidEmailRequest(request);
    this.#attempts += 1;

    if (this.idempotency === "provider") {
      const prior = this.#results.get(request.idempotencyKey);
      if (prior) return prior;
    }

    const scripted = this.#script.shift();
    if (scripted) throw failureFor(scripted);

    const position = this.idempotency === "provider" ? 0 : this.#outbox.length;
    const result: EmailSendResult = { providerMessageId: fakeMessageId(request.idempotencyKey, position) };
    this.#outbox.push({ idempotencyKey: request.idempotencyKey, message: { ...request.message } });
    if (this.idempotency === "provider") this.#results.set(request.idempotencyKey, result);
    return result;
  }
}

function failureFor(outcome: FakeEmailOutcome): EmailProviderError {
  if (outcome.type === "transient") {
    const code = outcome.code ?? "provider_unreachable";
    const ambiguous = outcome.ambiguous ?? code === "provider_timeout";
    return new EmailProviderError("transient", code, "fake provider: scripted transient failure", ambiguous);
  }
  return new EmailProviderError("permanent", outcome.code ?? "provider_rejected_permanent", "fake provider: scripted permanent failure", false);
}

/**
 * With provider-side idempotency the id depends only on the key. Without it the
 * position is mixed in, so two copies of the "same" message get distinct ids,
 * as a real provider's two accepted sends would.
 */
function fakeMessageId(idempotencyKey: string, position: number): string {
  const digest = createHash("sha256").update(`${idempotencyKey}\u0000${position}`).digest("hex");
  return `FAKE_EMAIL_${digest.slice(0, 16)}`;
}
