/**
 * fixtures.ts — reusable webhook bodies and requests for provider tests.
 *
 * ── THESE ARE SYNTHETIC, NOT RECORDINGS ─────────────────────────────────────
 *
 * Nothing here was captured from a live gateway. Paystack's exact response
 * shapes are not established for this project — PA-05, PA-06, PA-10 and others
 * are UNVERIFIED or UNKNOWN — and writing a "recorded" fixture from a guess
 * would put an invention about provider behaviour into the one place tests treat
 * as ground truth.
 *
 * So each body below is deliberately minimal: an event id, an event type, and a
 * reference. Those three are what the boundary actually needs, and all three are
 * established (PA-01 for the signature, PA-03 for the event id). When a real
 * Paystack test account exists, real payloads replace these and the test
 * expectations should not need to change — that is the check on whether this
 * boundary was drawn in the right place.
 *
 * Every string carries no personal data. Names, emails and phone numbers here
 * are placeholders on `example.test`, a reserved domain.
 */

import { fromNaira, type Kobo } from "@kolekto/domain";

import type { PaymentInitializationRequest } from "./payment-provider.ts";

/** A reference shaped like Kolekto's own: server-generated, unique, ours. */
export const FIXTURE_REFERENCE = "KLK-TEST-0000000001";

/** A second one, for duplicate and isolation tests. */
export const FIXTURE_REFERENCE_OTHER = "KLK-TEST-0000000002";

export const FIXTURE_EVENT_ID = "fake_evt_0000000001";
export const FIXTURE_EVENT_ID_OTHER = "fake_evt_0000000002";

/** A payment initialization request with every field a real one carries. */
export function fixtureInitializationRequest(
  overrides: Partial<PaymentInitializationRequest> = {},
): PaymentInitializationRequest {
  return {
    reference: FIXTURE_REFERENCE,
    amount: fromNaira("10000"),
    currency: "NGN",
    callbackUrl: "https://staging.example.test/pay/callback",
    contributorEmail: "contributor@example.test",
    metadata: { collection_slug: "founders-dinner", community_slug: "test-community" },
    subaccountCode: null,
    ...overrides,
  };
}

/** The amount the fixtures use, so a test does not restate it. */
export const FIXTURE_AMOUNT: Kobo = fromNaira("10000");

/**
 * A charge-success webhook body.
 *
 * `id` is the provider event id and the idempotency key; `data.reference` is
 * Kolekto's own reference, which is what the processor verifies against the
 * provider. Nothing else in the body is load-bearing, on purpose — a webhook is a
 * trigger to verify, never evidence (A7).
 */
export function fixtureChargeSuccessBody(
  options: { eventId?: string; reference?: string } = {},
): Uint8Array {
  return encodeBody({
    id: options.eventId ?? FIXTURE_EVENT_ID,
    event: "charge.success",
    data: { reference: options.reference ?? FIXTURE_REFERENCE },
  });
}

export function fixtureChargeFailedBody(options: { eventId?: string; reference?: string } = {}): Uint8Array {
  return encodeBody({
    id: options.eventId ?? FIXTURE_EVENT_ID,
    event: "charge.failed",
    data: { reference: options.reference ?? FIXTURE_REFERENCE },
  });
}

/** A transfer event, for the payout path. Carries a transfer reference, not a charge reference. */
export function fixtureTransferSuccessBody(options: { eventId?: string; transferCode?: string } = {}): Uint8Array {
  return encodeBody({
    id: options.eventId ?? FIXTURE_EVENT_ID,
    event: "transfer.success",
    data: { transfer_code: options.transferCode ?? "KLK-TRF-0000000001" },
  });
}

/** An event type Kolekto has no handler for. Must be stored and ignored, never rejected. */
export function fixtureUnsupportedEventBody(options: { eventId?: string } = {}): Uint8Array {
  return encodeBody({
    id: options.eventId ?? FIXTURE_EVENT_ID,
    event: "some.event.kolekto.does.not.handle",
    data: {},
  });
}

/** A body with no event id at all — it cannot be deduplicated, so it must be refused. */
export function fixtureBodyWithoutEventId(): Uint8Array {
  return encodeBody({ event: "charge.success", data: { reference: FIXTURE_REFERENCE } });
}

/** Not JSON. The signature check must still run first, and this must fail after it. */
export function fixtureMalformedBody(): Uint8Array {
  return new TextEncoder().encode("{ this is not json");
}

function encodeBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
