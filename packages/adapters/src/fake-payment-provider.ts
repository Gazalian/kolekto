/**
 * fake-payment-provider.ts — a deterministic payment provider for tests.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 *
 * Every financial path Kolekto builds between now and the Paystack adapter has
 * to be exercised against *something*. This is that something, and it is built
 * before the real adapter on purpose: by the time M8.9 writes an HTTP client,
 * every behaviour it must produce is already specified by a test here.
 *
 * ── THREE PROPERTIES, AND THEY ARE THE WHOLE POINT ──────────────────────────
 *
 * 1. **No network. Ever.** There is no fetch, no socket, no clock read that
 *    could vary. Grep this file for `fetch` and find nothing.
 * 2. **Deterministic.** The same scenario and the same reference produce the
 *    same ids, the same timestamps and the same fee, on every run and on every
 *    machine. Ids are derived from the reference, not from a counter or a UUID
 *    generator, so a test failure is reproducible from its output alone.
 * 3. **Obviously not real.** `name` is `"fake"`, every id is prefixed `FAKE_`,
 *    and the checkout URL points at `fake-provider.invalid` — a domain reserved
 *    by RFC 2606 that can never resolve. Nothing here can be mistaken for a
 *    working payment integration, which matters because the failure mode being
 *    guarded against is somebody believing payments work.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It does not imitate Paystack's JSON. The raw payloads it produces are clearly
 * synthetic and labelled as such. Paystack's exact response shapes are not
 * established (PA-05, PA-06 and others are UNVERIFIED or UNKNOWN), and inventing
 * them here would put guesses about a provider into a file that tests would then
 * enshrine. What *is* established — the HMAC SHA-512 webhook signature over the
 * raw body (PA-01) — is implemented faithfully, because that one is documented.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { kobo, type Kobo } from "@kolekto/domain";

import type {
  PaymentInitialization,
  PaymentInitializationRequest,
  PaymentProvider,
  ProviderEventIdentity,
  ProviderEventSubject,
  ProviderPaymentStatus,
  ProviderResult,
  ProviderTransaction,
  WebhookAuthentication,
} from "./payment-provider.ts";

/**
 * How the fake should behave for a given reference.
 *
 * Every scenario the M8.2 brief asks for is here, and each one exists because
 * some real path has to handle it.
 */
export type FakeScenario =
  /** Initialization succeeds; the payment then resolves as `succeeded` on verify. */
  | "success"
  /** The provider refuses to start the payment at all. */
  | "initialization_refused"
  /** Initialization succeeds; verify says the payment is still in flight. */
  | "pending"
  /** Initialization succeeds; verify says the provider refused the payment. */
  | "payment_failed"
  /** The contributor abandoned checkout. Not a refusal. */
  | "abandoned"
  /**
   * Verify succeeds but reports an amount that differs from what was requested.
   * The path under test must park this, never silently accept it.
   */
  | "amount_mismatch"
  /** Verify succeeds but reports a different currency. */
  | "currency_mismatch"
  /** The provider returns a status Kolekto has no mapping for. */
  | "unrecognised_status"
  /** Verify times out. `unknown`, never `failed` (D-27). */
  | "verify_timeout"
  /** Initialization times out — the dangerous one: a checkout may exist. */
  | "initialization_timeout"
  /** The provider has never heard of the reference. */
  | "not_found"
  /** Succeeds, but the provider reports no fee, which is not the same as zero (D-11, PA-05). */
  | "success_without_reported_fee";

export interface FakeProviderOptions {
  /**
   * The signing secret for webhook authentication. A test value; the fake has no
   * default, because a default signing secret is how a test secret reaches a
   * place that matters.
   */
  readonly webhookSecret: string;
  /**
   * Which scenario applies to which Kolekto reference. A reference with no entry
   * uses `defaultScenario`.
   */
  readonly scenarios?: Readonly<Record<string, FakeScenario>>;
  readonly defaultScenario?: FakeScenario;
  /**
   * The fee the fake reports, in kobo, for scenarios that report one.
   *
   * Deliberately NOT derived from the amount by a percentage. The fake must not
   * contain a second fee calculation — there is exactly one, in
   * `packages/domain/src/fees.ts` (D-12), and a percentage here would be a
   * second one that tests would then trust.
   */
  readonly reportedFee?: Kobo;
}

/** The instant every fake transaction is stamped with. Fixed, so tests are reproducible. */
export const FAKE_PROVIDER_EPOCH = new Date("2026-09-24T12:00:00.000Z");

/**
 * A stable pseudo-id derived from a reference.
 *
 * A hash, not a counter: a counter makes a test's expected ids depend on how many
 * tests ran before it, which is the kind of coupling that makes a suite fragile
 * in a way nobody can see from the failing test.
 */
function stableId(prefix: string, reference: string): string {
  const digest = createHmac("sha256", "kolekto-fake-provider").update(reference).digest("hex");
  return `${prefix}${digest.slice(0, 16)}`;
}

const STATUS_BY_SCENARIO: Readonly<Record<FakeScenario, ProviderPaymentStatus>> = {
  success: "succeeded",
  success_without_reported_fee: "succeeded",
  amount_mismatch: "succeeded",
  currency_mismatch: "succeeded",
  pending: "pending",
  payment_failed: "failed",
  abandoned: "abandoned",
  unrecognised_status: "unrecognised",
  initialization_refused: "failed",
  verify_timeout: "pending",
  initialization_timeout: "pending",
  not_found: "failed",
};

/** The provider's own status word, which Kolekto stores but never branches on. */
const RAW_STATUS_BY_SCENARIO: Readonly<Record<FakeScenario, string>> = {
  success: "success",
  success_without_reported_fee: "success",
  amount_mismatch: "success",
  currency_mismatch: "success",
  pending: "ongoing",
  payment_failed: "failed",
  abandoned: "abandoned",
  unrecognised_status: "some_status_nobody_mapped",
  initialization_refused: "failed",
  verify_timeout: "ongoing",
  initialization_timeout: "ongoing",
  not_found: "failed",
};

/**
 * A deterministic, offline payment provider.
 *
 * Also records what it was asked to do, so a test can assert that a path called
 * the provider once rather than three times — which is how you catch a retry
 * loop that happens to produce the right answer.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake" as const;

  readonly initializeCalls: PaymentInitializationRequest[] = [];
  readonly verifyCalls: string[] = [];

  #amountsByReference = new Map<string, Kobo>();

  // Declared explicitly rather than as a constructor parameter property: Node's
  // strip-only TypeScript mode, which is how this package's tests run, does not
  // support that shorthand.
  readonly options: FakeProviderOptions;

  constructor(options: FakeProviderOptions) {
    if (options.webhookSecret.trim() === "") {
      throw new Error("FakePaymentProvider needs a webhook secret. A blank signing secret verifies everything.");
    }
    this.options = options;
  }

  scenarioFor(reference: string): FakeScenario {
    return this.options.scenarios?.[reference] ?? this.options.defaultScenario ?? "success";
  }

  async initialize(request: PaymentInitializationRequest): Promise<ProviderResult<PaymentInitialization>> {
    this.initializeCalls.push(request);
    const scenario = this.scenarioFor(request.reference);

    if (scenario === "initialization_refused") {
      return {
        outcome: "refused",
        providerCode: "FAKE_REFUSED",
        message: "The fake provider was configured to refuse this initialization.",
      };
    }

    if (scenario === "initialization_timeout") {
      // The dangerous case, and why `safeToRetry` exists. A timed-out
      // initialization may have created a checkout at the provider, so the
      // caller must not simply try again with the same reference and assume
      // nothing happened.
      return {
        outcome: "unknown",
        reason: "The fake provider timed out during initialization. A checkout may or may not exist.",
        safeToRetry: false,
      };
    }

    // Remember what we were asked to charge, so `verify` can report the same
    // figure — or, for the mismatch scenario, deliberately a different one.
    this.#amountsByReference.set(request.reference, request.amount);

    return {
      outcome: "ok",
      value: {
        provider: this.name,
        reference: request.reference,
        // RFC 2606 reserves `.invalid`. This URL can never resolve, anywhere.
        checkoutUrl: `https://fake-provider.invalid/checkout/${stableId("FAKE_ACC_", request.reference)}`,
        providerAccessCode: stableId("FAKE_ACC_", request.reference),
      },
    };
  }

  async verify(reference: string): Promise<ProviderResult<ProviderTransaction>> {
    this.verifyCalls.push(reference);
    const scenario = this.scenarioFor(reference);

    if (scenario === "not_found") return { outcome: "not_found" };

    if (scenario === "verify_timeout") {
      // A verify is a READ. Retrying it cannot move money, so this one is safe
      // to retry — unlike a transfer, where the same outcome is not.
      return {
        outcome: "unknown",
        reason: "The fake provider timed out during verification.",
        safeToRetry: true,
      };
    }

    const requested = this.#amountsByReference.get(reference) ?? kobo(0n);
    const status = STATUS_BY_SCENARIO[scenario];
    const succeeded = status === "succeeded";

    const amount = scenario === "amount_mismatch" ? kobo(requested + 100n) : requested;
    const currency = scenario === "currency_mismatch" ? "USD" : "NGN";
    const providerFee =
      scenario === "success_without_reported_fee" ? null : (this.options.reportedFee ?? kobo(0n));

    return {
      outcome: "ok",
      value: {
        provider: this.name,
        providerTransactionId: stableId("FAKE_TXN_", reference),
        providerReference: reference,
        status,
        providerStatusRaw: RAW_STATUS_BY_SCENARIO[scenario],
        amount,
        currency,
        // A provider that has not resolved a payment has not charged a fee.
        providerFee: succeeded ? providerFee : null,
        paidAt: succeeded ? FAKE_PROVIDER_EPOCH : null,
        createdAt: FAKE_PROVIDER_EPOCH,
        channel: succeeded ? "fake_channel" : null,
        authorizationReference: succeeded ? stableId("FAKE_AUTH_", reference) : null,
        rawPayload: {
          // Clearly synthetic, and labelled so nobody mistakes it for a captured
          // Paystack response. Paystack's exact shapes are not established.
          __fake: true,
          __note: "Synthetic payload from FakePaymentProvider. Not a recording of any real gateway.",
          reference,
          scenario,
          status: RAW_STATUS_BY_SCENARIO[scenario],
        },
      },
    };
  }

  /**
   * Verify a webhook signature: HMAC SHA-512 over the raw bytes, hex, compared
   * in constant time.
   *
   * This is the one gateway behaviour that is ESTABLISHED (PA-01), so the fake
   * implements it faithfully rather than stubbing it — which means the webhook
   * path can be tested against real signature arithmetic, including forgery.
   */
  authenticateWebhook(rawBody: Uint8Array, headers: Readonly<Record<string, string>>): WebhookAuthentication {
    const provided = headerValue(headers, "x-fake-signature");
    if (provided === null) return { outcome: "rejected", rejection: { reason: "missing_signature" } };

    const expected = createHmac("sha512", this.options.webhookSecret).update(rawBody).digest("hex");

    // Compare in constant time, and only after a length check — timingSafeEqual
    // throws on unequal lengths, and a thrown error here would be a rejection
    // routed through the wrong path.
    const providedBytes = Buffer.from(provided, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    const matches =
      providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);

    if (!matches) return { outcome: "rejected", rejection: { reason: "bad_signature" } };

    // Only now is the body interpreted. The signature is checked against bytes,
    // before anything parses them.
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
    } catch (error) {
      return {
        outcome: "rejected",
        rejection: { reason: "unparseable", detail: error instanceof Error ? error.message : String(error) },
      };
    }

    const identity = identityFrom(parsed);
    if (identity === null) return { outcome: "rejected", rejection: { reason: "missing_event_id" } };

    return { outcome: "authentic", identity };
  }

  parseWebhookSubject(rawBody: Uint8Array): ProviderEventSubject {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
    } catch {
      return { kind: "unsupported", providerEventType: "unparseable" };
    }

    const body = parsed as { event?: unknown; data?: { reference?: unknown; transfer_code?: unknown } };
    const eventType = typeof body.event === "string" ? body.event : "unknown";

    if (eventType.startsWith("charge.") && typeof body.data?.reference === "string") {
      return { kind: "transaction", providerReference: body.data.reference };
    }
    if (eventType.startsWith("transfer.") && typeof body.data?.transfer_code === "string") {
      return { kind: "transfer", transferReference: body.data.transfer_code };
    }
    return { kind: "unsupported", providerEventType: eventType };
  }

  /**
   * Sign a body the way this fake expects, so a test can produce an authentic
   * webhook. Test-only by construction: it is a method on the fake.
   */
  signWebhook(rawBody: Uint8Array): string {
    return createHmac("sha512", this.options.webhookSecret).update(rawBody).digest("hex");
  }
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | null {
  // Header names are case-insensitive, and a provider is not obliged to send the
  // casing the documentation uses.
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

function identityFrom(parsed: unknown): ProviderEventIdentity | null {
  const body = parsed as { id?: unknown; event?: unknown };
  const id = typeof body.id === "string" ? body.id : typeof body.id === "number" ? String(body.id) : null;
  if (id === null || id.trim() === "") return null;

  return {
    provider: "fake",
    providerEventId: id,
    providerEventType: typeof body.event === "string" ? body.event : "unknown",
  };
}

/** Construct the fake. Named so a grep for `createPaymentProvider` finds only the real seam. */
export function createFakePaymentProvider(options: FakeProviderOptions): FakePaymentProvider {
  return new FakePaymentProvider(options);
}
