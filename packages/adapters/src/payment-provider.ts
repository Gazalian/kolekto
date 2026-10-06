/**
 * payment-provider.ts — the boundary between Kolekto's money model and a
 * payment gateway.
 *
 * ── STATUS: CONTRACT ONLY. NO GATEWAY IS IMPLEMENTED. ───────────────────────
 *
 * M8.2 defines this seam and a deterministic fake that satisfies it. The
 * Paystack adapter is M8.9 and needs a test account and a public staging URL,
 * neither of which exists. Nothing in this file makes a network request and
 * nothing in this file knows what Paystack's JSON looks like.
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
 *
 * **Kolekto's domain never sees a provider's payload.** Everything crossing this
 * boundary is a Kolekto-owned type, normalised here. The previous estate had
 * `api.paystack.co` in five call sites across three runtimes, and Paystack's
 * field names reached the ledger, the wallet refresh and the reconciliation
 * script. The consequence was not ugliness — it was that FIN-02's settlement
 * swap was not achievable, and that a change in the provider's response shape
 * was a change to financial code.
 *
 * So: a provider adapter maps its own payload into the types below and is the
 * only thing that ever sees the original. `rawPayload` is carried for evidence
 * and storage, never for business logic — see the note on it.
 *
 * ── UNCERTAINTY IS PART OF THE CONTRACT ─────────────────────────────────────
 *
 * The single most important design choice here. Every call that can leave
 * Kolekto not knowing what happened returns that as a **value**, not an
 * exception:
 *
 *     ok        → the provider answered, and this is the answer
 *     not_found → the provider answered, and it has no such thing
 *     unknown   → we do not know. A timeout, a transport failure, a 5xx.
 *     refused   → the provider answered and rejected the request
 *
 * `unknown` exists because **a timeout is not a failure** (D-27). On a transfer
 * it may mean the money moved. The old system had no such state, so a timeout
 * looked like a failure, and a retry could pay a bank twice. Making `unknown` a
 * value rather than a thrown error means a caller cannot accidentally treat it
 * as failure by catching too broadly.
 */

import type { Kobo } from "@kolekto/domain";

/** Which gateway. Part of every external identity, because two gateways may issue the same id. */
export type ProviderName = "paystack" | "fake";

/**
 * A payment's status, in Kolekto's vocabulary.
 *
 * The provider's own word is kept alongside it (`providerStatusRaw`) because a
 * mapping loses information and a reconciliation two years from now may need
 * the original. But nothing downstream branches on the raw string.
 */
export type ProviderPaymentStatus =
  /** The provider has the payment and has not resolved it. */
  | "pending"
  /** Money was taken. The only status that may lead to a capture. */
  | "succeeded"
  /** The provider says it will not succeed. */
  | "failed"
  /** The contributor walked away. Distinct from `failed`: nothing was refused. */
  | "abandoned"
  /**
   * The provider's status does not map onto any of the above. Never treated as
   * failure, never treated as success — it becomes `needs_review`, which is a
   * state where money is safe and a human looks.
   */
  | "unrecognised";

/**
 * The result of asking a provider anything.
 *
 * A discriminated union rather than `T | null` plus exceptions, so that
 * "we do not know" cannot be silently collapsed into "it failed".
 */
export type ProviderResult<T> =
  | { readonly outcome: "ok"; readonly value: T }
  | { readonly outcome: "not_found" }
  | {
      readonly outcome: "unknown";
      /** Why we do not know: a timeout, a transport error, a 5xx. For an operator to read. */
      readonly reason: string;
      /** True when a retry is safe. False for anything that may have moved money. */
      readonly safeToRetry: boolean;
    }
  | {
      readonly outcome: "refused";
      /** The provider's own error code, kept verbatim. */
      readonly providerCode: string | null;
      readonly message: string;
    };

/** Narrowing helper, so callers do not hand-write the check and get it wrong. */
export function isOk<T>(result: ProviderResult<T>): result is { outcome: "ok"; value: T } {
  return result.outcome === "ok";
}

/**
 * What Kolekto sends a provider to start a payment.
 *
 * **Everything here is server-derived and already frozen onto a payment
 * attempt.** No field on this object may originate from a browser. The amount
 * in particular is resolved by `packages/domain/contribution.ts` against the
 * collection's own configuration, and the provider is told what to charge — it
 * is never asked.
 */
export interface PaymentInitializationRequest {
  /**
   * Kolekto's own reference, and the idempotency key for the whole payment.
   * Generated server-side, unique, and given to the provider so both sides
   * share one key (D-25).
   */
  readonly reference: string;
  /** What the contributor is charged, including any fees they bear. */
  readonly amount: Kobo;
  readonly currency: "NGN";
  /** Where the contributor is sent afterwards. A hint for the receipt, never evidence of payment. */
  readonly callbackUrl: string;
  /** For the provider's own receipt. Not an identity Kolekto relies on. */
  readonly contributorEmail: string | null;
  /**
   * Opaque to the provider, echoed back on the transaction. Kolekto resolves a
   * payment by its `reference`, never by metadata, because metadata is the thing
   * that went missing in the legacy unattributed set.
   */
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * Which organiser subaccount the provider should attribute the money to, if
   * the settlement model uses one (D-01). `null` means no split.
   *
   * Note that a subaccount is per-organiser, not per-collection (PA-07), so this
   * does **not** carry Kolekto's collection attribution. That lives only in
   * Kolekto's own records, which is why it must be recorded at capture time.
   */
  readonly subaccountCode: string | null;
}

/** What the provider gives back when a payment is successfully started. */
export interface PaymentInitialization {
  readonly provider: ProviderName;
  /** Kolekto's reference, echoed. Asserted equal to what was sent. */
  readonly reference: string;
  /** Where to send the contributor. */
  readonly checkoutUrl: string;
  /** The provider's own handle for this checkout, if it issues one. */
  readonly providerAccessCode: string | null;
}

/**
 * The provider's statement of fact about one transaction.
 *
 * Deliberately *not* merged with Kolekto's payment attempt. An attempt is our
 * intent to be paid; this is somebody else's account of what happened.
 * Conflating them is how "amount mismatch" becomes unanswerable — you need both
 * numbers to notice they differ.
 */
export interface ProviderTransaction {
  readonly provider: ProviderName;
  /** The gateway's own id. Text, because some gateways use integers and some do not. */
  readonly providerTransactionId: string;
  /** The reference the gateway echoes. For Kolekto-initiated payments, ours. */
  readonly providerReference: string;
  readonly status: ProviderPaymentStatus;
  /** The provider's own status word, unmapped. Stored, never branched on. */
  readonly providerStatusRaw: string;
  /** The gateway's amount. Compared against ours; never trusted over ours. */
  readonly amount: Kobo;
  readonly currency: string;
  /**
   * The fee the provider says it charged.
   *
   * `null` means **the provider did not report one**, which is not the same as
   * zero. Until it reports, Kolekto's modelled estimate applies (D-11), and the
   * moment it does report, the reported figure is that transaction's truth.
   * Whether verification returns a settled fee or an estimate is PA-05, and
   * still UNVERIFIED — so a `null` here is a legitimate state, not a bug.
   */
  readonly providerFee: Kobo | null;
  /** When the provider says the money was taken. Null unless status is `succeeded`. */
  readonly paidAt: Date | null;
  readonly createdAt: Date;
  /** Card, bank transfer, USSD… the provider's word. Informational. */
  readonly channel: string | null;
  /**
   * A reusable payment instrument token, if the provider issued one.
   *
   * Stored hashed unless a decision says otherwise, and **never** used to charge
   * anybody automatically: stored-card recurring billing is O-12, an open
   * founder decision with its own consent and mandate questions.
   */
  readonly authorizationReference: string | null;
  /**
   * The provider's payload, verbatim.
   *
   * **For storage and evidence only.** No domain code may read a field out of
   * this. It exists because a reconciliation years from now needs the bytes
   * rather than somebody's mapping of them, and because the legacy system stored
   * none and could not answer what the provider had actually said.
   *
   * It may contain contributor PII, so it is written only to
   * `financial_events.payload`, which no client role can read.
   */
  readonly rawPayload: unknown;
}

/**
 * A webhook's identity, established by checking its signature.
 *
 * Returned *before* the body is interpreted. The signature is verified against
 * the raw bytes exactly as received (PA-01: HMAC SHA-512 over the raw payload,
 * in `x-paystack-signature`) — not against a re-serialised body, which would
 * change the bytes and break the hash.
 */
export interface ProviderEventIdentity {
  readonly provider: ProviderName;
  /** The provider's own event id. THIS is the webhook idempotency key (D-25). */
  readonly providerEventId: string;
  /** The provider's own event type, verbatim. */
  readonly providerEventType: string;
}

/** Why a webhook was rejected. A rejected webhook is never stored as an event. */
export type WebhookRejection =
  | { readonly reason: "missing_signature" }
  | { readonly reason: "bad_signature" }
  | { readonly reason: "unparseable"; readonly detail: string }
  | { readonly reason: "missing_event_id" };

export type WebhookAuthentication =
  | { readonly outcome: "authentic"; readonly identity: ProviderEventIdentity }
  | { readonly outcome: "rejected"; readonly rejection: WebhookRejection };

/**
 * What a webhook body turned out to be about.
 *
 * A webhook is a **trigger to verify**, never evidence on its own (A7). Even a
 * correctly signed body tells Kolekto what the provider *sent*, not what it
 * currently *holds* — so the processing path takes the reference out of here and
 * calls `verify()`. This type therefore deliberately carries a reference and a
 * kind, and not an amount anybody should act on.
 */
export type ProviderEventSubject =
  | { readonly kind: "transaction"; readonly providerReference: string }
  | { readonly kind: "transfer"; readonly transferReference: string }
  | { readonly kind: "unsupported"; readonly providerEventType: string };

/**
 * The seam. Every gateway call in Kolekto goes through an implementation of
 * this, and `api.paystack.co` may appear only in this package — asserted by the
 * fourth source-tree invariant.
 */
export interface PaymentProvider {
  readonly name: ProviderName;

  /**
   * Start a payment. Takes an already-frozen request; never a client's numbers.
   *
   * Idempotent on `reference`: initialising the same reference twice must return
   * an equivalent checkout rather than creating a second charge.
   */
  initialize(request: PaymentInitializationRequest): Promise<ProviderResult<PaymentInitialization>>;

  /**
   * Ask the provider what actually happened. **The only way a payment is
   * believed.**
   *
   * Called by the redirect, by the webhook processor, and by the sweep. All
   * three converge here, which is why the downstream writes have to be
   * conflict-based rather than check-then-insert.
   */
  verify(reference: string): Promise<ProviderResult<ProviderTransaction>>;

  /**
   * Check a webhook's signature against the raw bytes and return its identity.
   *
   * Synchronous and total: it returns a rejection rather than throwing, because
   * "this body is not authentic" is an expected outcome on a public endpoint and
   * an exception invites a catch that treats it as a server error.
   */
  authenticateWebhook(rawBody: Uint8Array, headers: Readonly<Record<string, string>>): WebhookAuthentication;

  /** What the body is about, so the processor knows which reference to verify. */
  parseWebhookSubject(rawBody: Uint8Array): ProviderEventSubject;
}

/**
 * Settlement information, where a provider reports it.
 *
 * Separate from `ProviderTransaction` because provider settlement (the gateway
 * moved money to a bank) and Kolekto's own balance release (Kolekto decides an
 * organiser's money is available) are different events, and the old system ran
 * them together (L4). Whether a settlement can be decomposed into the
 * transactions it covers is PA-10, **UNKNOWN**, which is why `transactionIds`
 * is nullable rather than an array that might quietly be empty.
 */
export interface ProviderSettlement {
  readonly provider: ProviderName;
  readonly providerSettlementId: string;
  readonly amount: Kobo;
  readonly currency: string;
  readonly settledAt: Date;
  /** `null` means the provider does not tell us which transactions this covers (PA-10). */
  readonly transactionIds: readonly string[] | null;
  readonly rawPayload: unknown;
}

/**
 * Not implemented, and deliberately so.
 *
 * The real adapter is M8.9 and is gated on a Paystack test account, a public
 * staging URL, and written answers to PA-04 through PA-09. An adapter written
 * against a guess about provider behaviour is worse than none, because it will
 * be trusted.
 */
export function createPaymentProvider(_name: ProviderName): PaymentProvider {
  throw new Error(
    "No payment provider is implemented. The Paystack adapter is M8.9 and needs a test account, a public " +
      "staging webhook URL, and PA-04…PA-09 answered in writing. Use createFakePaymentProvider() in tests.",
  );
}
