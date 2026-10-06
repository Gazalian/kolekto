import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fromNaira, kobo } from "@kolekto/domain";

import {
  createFakePaymentProvider,
  FAKE_PROVIDER_EPOCH,
  type FakeScenario,
} from "../src/fake-payment-provider.ts";
import { createPaymentProvider, isOk } from "../src/payment-provider.ts";
import {
  FIXTURE_AMOUNT,
  FIXTURE_EVENT_ID,
  FIXTURE_EVENT_ID_OTHER,
  FIXTURE_REFERENCE,
  FIXTURE_REFERENCE_OTHER,
  fixtureBodyWithoutEventId,
  fixtureChargeSuccessBody,
  fixtureInitializationRequest,
  fixtureMalformedBody,
  fixtureTransferSuccessBody,
  fixtureUnsupportedEventBody,
} from "../src/fixtures.ts";

const SECRET = "test-webhook-secret-not-a-real-one";

function provider(scenarios: Record<string, FakeScenario> = {}, reportedFee = fromNaira("150")) {
  return createFakePaymentProvider({ webhookSecret: SECRET, scenarios, reportedFee });
}

describe("the real provider seam is not implemented", () => {
  it("throws rather than quietly returning something that looks like a gateway", () => {
    // The failure mode being guarded against is somebody believing payments work.
    assert.throws(() => createPaymentProvider("paystack"), /not implemented|M8\.9/);
    assert.throws(() => createPaymentProvider("fake"), /not implemented|M8\.9/);
  });
});

describe("the fake makes no network request and is obviously a fake", () => {
  it("is named `fake` and checks out to a domain that cannot resolve", async () => {
    const p = provider();
    const result = await p.initialize(fixtureInitializationRequest());

    assert.ok(isOk(result));
    assert.equal(p.name, "fake");
    // RFC 2606 reserves `.invalid`; this URL can never resolve anywhere.
    assert.match(result.value.checkoutUrl, /^https:\/\/fake-provider\.invalid\//);
    assert.match(result.value.providerAccessCode ?? "", /^FAKE_ACC_/);
  });

  it("refuses to be constructed without a signing secret", () => {
    // A blank signing secret verifies every forgery.
    assert.throws(() => createFakePaymentProvider({ webhookSecret: "" }), /signing secret|webhook secret/i);
    assert.throws(() => createFakePaymentProvider({ webhookSecret: "   " }), /signing secret|webhook secret/i);
  });
});

describe("determinism", () => {
  it("produces the same ids and timestamps across separate instances", async () => {
    const first = provider();
    const second = provider();

    await first.initialize(fixtureInitializationRequest());
    await second.initialize(fixtureInitializationRequest());

    const a = await first.verify(FIXTURE_REFERENCE);
    const b = await second.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(a) && isOk(b));
    assert.equal(a.value.providerTransactionId, b.value.providerTransactionId, "same reference, same id");
    assert.equal(a.value.createdAt.toISOString(), b.value.createdAt.toISOString());
    assert.equal(a.value.paidAt?.toISOString(), FAKE_PROVIDER_EPOCH.toISOString());
  });

  it("derives ids from the reference, not from a call counter", async () => {
    // A counter would make a test's expected ids depend on how many tests ran
    // before it — coupling that is invisible from a failing assertion.
    const p = provider();
    await p.initialize(fixtureInitializationRequest());
    await p.initialize(fixtureInitializationRequest({ reference: FIXTURE_REFERENCE_OTHER }));

    const one = await p.verify(FIXTURE_REFERENCE);
    const two = await p.verify(FIXTURE_REFERENCE_OTHER);
    const oneAgain = await p.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(one) && isOk(two) && isOk(oneAgain));
    assert.equal(one.value.providerTransactionId, oneAgain.value.providerTransactionId);
    assert.notEqual(one.value.providerTransactionId, two.value.providerTransactionId);
  });

  it("is idempotent on the reference: initializing twice gives the same checkout", async () => {
    const p = provider();
    const first = await p.initialize(fixtureInitializationRequest());
    const second = await p.initialize(fixtureInitializationRequest());

    assert.ok(isOk(first) && isOk(second));
    assert.equal(first.value.checkoutUrl, second.value.checkoutUrl, "the same reference is the same payment");
  });
});

describe("payment outcomes", () => {
  it("reports success with a provider fee", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "success" });
    await p.initialize(fixtureInitializationRequest());
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(result));
    assert.equal(result.value.status, "succeeded");
    assert.equal(result.value.amount, FIXTURE_AMOUNT);
    assert.equal(result.value.providerFee, fromNaira("150"));
    assert.notEqual(result.value.paidAt, null);
  });

  it("distinguishes a fee of zero from a fee the provider did not report (D-11, PA-05)", async () => {
    // `null` means "not reported", which is not the same as zero. Until the
    // provider reports, Kolekto's modelled estimate applies; the moment it does,
    // the reported figure is that transaction's truth.
    const p = provider({ [FIXTURE_REFERENCE]: "success_without_reported_fee" });
    await p.initialize(fixtureInitializationRequest());
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(result));
    assert.equal(result.value.status, "succeeded");
    assert.equal(result.value.providerFee, null, "not reported, not zero");

    const withZero = provider({ [FIXTURE_REFERENCE]: "success" }, kobo(0n));
    await withZero.initialize(fixtureInitializationRequest());
    const zero = await withZero.verify(FIXTURE_REFERENCE);
    assert.ok(isOk(zero));
    assert.equal(zero.value.providerFee, kobo(0n), "zero is a reported figure");
  });

  it("reports pending without a paid timestamp or a fee", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "pending" });
    await p.initialize(fixtureInitializationRequest());
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(result));
    assert.equal(result.value.status, "pending");
    assert.equal(result.value.paidAt, null, "unresolved money has no paid time");
    assert.equal(result.value.providerFee, null, "and no fee has been charged");
  });

  it("distinguishes a refusal from an abandonment", async () => {
    const failed = provider({ [FIXTURE_REFERENCE]: "payment_failed" });
    await failed.initialize(fixtureInitializationRequest());
    const f = await failed.verify(FIXTURE_REFERENCE);

    const abandoned = provider({ [FIXTURE_REFERENCE]: "abandoned" });
    await abandoned.initialize(fixtureInitializationRequest());
    const a = await abandoned.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(f) && isOk(a));
    assert.equal(f.value.status, "failed");
    assert.equal(a.value.status, "abandoned", "nobody refused anything; the contributor walked away");
  });

  it("refuses an initialization when configured to", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "initialization_refused" });
    const result = await p.initialize(fixtureInitializationRequest());

    assert.equal(result.outcome, "refused");
    if (result.outcome === "refused") {
      assert.equal(result.providerCode, "FAKE_REFUSED");
    }
  });

  it("reports not_found for a reference the provider never saw", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "not_found" });
    const result = await p.verify(FIXTURE_REFERENCE);
    assert.equal(result.outcome, "not_found");
  });
});

describe("mismatches are reported, never smoothed over", () => {
  it("reports an amount that differs from the one requested", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "amount_mismatch" });
    await p.initialize(fixtureInitializationRequest());
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(result));
    assert.equal(result.value.status, "succeeded");
    assert.notEqual(result.value.amount, FIXTURE_AMOUNT, "the caller must compare and park this");
    // The boundary's job is to report both figures faithfully. Deciding what to
    // do about the difference belongs to the payment path, which parks it as
    // needs_review rather than accepting or rejecting it.
    assert.equal(result.value.amount, FIXTURE_AMOUNT + 100n);
  });

  it("reports a currency that differs", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "currency_mismatch" });
    await p.initialize(fixtureInitializationRequest());
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(result));
    assert.equal(result.value.currency, "USD");
    assert.notEqual(result.value.currency, "NGN");
  });

  it("normalises an unmappable status to `unrecognised` and keeps the original word", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "unrecognised_status" });
    await p.initialize(fixtureInitializationRequest());
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(result));
    // Never silently mapped to failed or succeeded. A status nobody mapped is a
    // case for a human, not a guess.
    assert.equal(result.value.status, "unrecognised");
    assert.equal(result.value.providerStatusRaw, "some_status_nobody_mapped");
    assert.equal(result.value.paidAt, null);
  });
});

describe("unknown outcomes — a timeout is not a failure (D-27)", () => {
  it("returns `unknown` rather than throwing, so it cannot be caught as an error", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "verify_timeout" });
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.equal(result.outcome, "unknown");
    assert.notEqual(result.outcome, "refused");
    assert.notEqual(result.outcome, "not_found");
  });

  it("marks a timed-out verify as safe to retry, because a verify is a read", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "verify_timeout" });
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.equal(result.outcome, "unknown");
    if (result.outcome === "unknown") {
      assert.equal(result.safeToRetry, true);
      assert.match(result.reason, /timed out/i);
    }
  });

  it("marks a timed-out initialization as NOT safe to retry, because a checkout may exist", async () => {
    const p = provider({ [FIXTURE_REFERENCE]: "initialization_timeout" });
    const result = await p.initialize(fixtureInitializationRequest());

    assert.equal(result.outcome, "unknown");
    if (result.outcome === "unknown") {
      assert.equal(result.safeToRetry, false, "this is the case that could charge somebody twice");
    }
  });
});

describe("webhook authentication", () => {
  it("accepts a correctly signed body and returns its identity", () => {
    const p = provider();
    const body = fixtureChargeSuccessBody();
    const result = p.authenticateWebhook(body, { "x-fake-signature": p.signWebhook(body) });

    assert.equal(result.outcome, "authentic");
    if (result.outcome === "authentic") {
      assert.equal(result.identity.providerEventId, FIXTURE_EVENT_ID);
      assert.equal(result.identity.providerEventType, "charge.success");
      assert.equal(result.identity.provider, "fake");
    }
  });

  it("rejects a forged signature", () => {
    const p = provider();
    const body = fixtureChargeSuccessBody();
    const result = p.authenticateWebhook(body, { "x-fake-signature": "0".repeat(128) });

    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "bad_signature");
  });

  it("rejects a body signed with the wrong secret", () => {
    const attacker = createFakePaymentProvider({ webhookSecret: "some-other-secret" });
    const p = provider();
    const body = fixtureChargeSuccessBody();

    const result = p.authenticateWebhook(body, { "x-fake-signature": attacker.signWebhook(body) });
    assert.equal(result.outcome, "rejected");
  });

  it("rejects a signature over different bytes — a tampered body cannot keep its signature", () => {
    const p = provider();
    const original = fixtureChargeSuccessBody();
    const signature = p.signWebhook(original);
    const tampered = fixtureChargeSuccessBody({ reference: "KLK-SOMEONE-ELSES-REFERENCE" });

    const result = p.authenticateWebhook(tampered, { "x-fake-signature": signature });
    assert.equal(result.outcome, "rejected");
  });

  it("rejects a missing signature header", () => {
    const p = provider();
    const result = p.authenticateWebhook(fixtureChargeSuccessBody(), {});

    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "missing_signature");
  });

  it("finds the header whatever case the provider sent it in", () => {
    const p = provider();
    const body = fixtureChargeSuccessBody();
    const result = p.authenticateWebhook(body, { "X-Fake-Signature": p.signWebhook(body) });

    assert.equal(result.outcome, "authentic");
  });

  it("checks the signature before parsing, and then reports unparseable", () => {
    const p = provider();
    const body = fixtureMalformedBody();
    const result = p.authenticateWebhook(body, { "x-fake-signature": p.signWebhook(body) });

    // Authentic bytes, invalid JSON: the signature step passed and the parse step
    // failed, which is the correct order. An unsigned malformed body must fail on
    // the signature, not the parse.
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "unparseable");

    const unsigned = p.authenticateWebhook(body, {});
    assert.equal(unsigned.outcome, "rejected");
    if (unsigned.outcome === "rejected") assert.equal(unsigned.rejection.reason, "missing_signature");
  });

  it("rejects an authentic body that carries no event id", () => {
    // Without an event id there is no idempotency key, so a redelivery could not
    // be deduplicated. Storing it would break the guarantee that a duplicate has
    // no second effect.
    const p = provider();
    const body = fixtureBodyWithoutEventId();
    const result = p.authenticateWebhook(body, { "x-fake-signature": p.signWebhook(body) });

    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "missing_event_id");
  });
});

describe("duplicate and repeated delivery", () => {
  it("gives the same identity for the same event delivered five times", () => {
    // Paystack retries every 3 minutes for the first 4 attempts, then hourly for
    // up to 72 hours (PA-02). The identity must be stable across all of them, or
    // the database's unique index cannot deduplicate.
    const p = provider();
    const body = fixtureChargeSuccessBody();
    const signature = p.signWebhook(body);

    const identities = Array.from({ length: 5 }, () => {
      const result = p.authenticateWebhook(body, { "x-fake-signature": signature });
      assert.equal(result.outcome, "authentic");
      return result.outcome === "authentic" ? result.identity.providerEventId : null;
    });

    assert.deepEqual(new Set(identities), new Set([FIXTURE_EVENT_ID]));
  });

  it("gives different identities to genuinely different events", () => {
    const p = provider();
    const first = fixtureChargeSuccessBody({ eventId: FIXTURE_EVENT_ID });
    const second = fixtureChargeSuccessBody({ eventId: FIXTURE_EVENT_ID_OTHER });

    const a = p.authenticateWebhook(first, { "x-fake-signature": p.signWebhook(first) });
    const b = p.authenticateWebhook(second, { "x-fake-signature": p.signWebhook(second) });

    assert.ok(a.outcome === "authentic" && b.outcome === "authentic");
    assert.notEqual(a.identity.providerEventId, b.identity.providerEventId);
  });

  it("verifying repeatedly is a read and changes nothing", async () => {
    const p = provider();
    await p.initialize(fixtureInitializationRequest());

    const results = await Promise.all([
      p.verify(FIXTURE_REFERENCE),
      p.verify(FIXTURE_REFERENCE),
      p.verify(FIXTURE_REFERENCE),
    ]);

    const ids = results.map((r) => (isOk(r) ? r.value.providerTransactionId : null));
    assert.equal(new Set(ids).size, 1, "three verifies, one transaction");
    assert.equal(p.verifyCalls.length, 3, "and the fake recorded all three, so a retry loop is visible");
  });
});

describe("webhook subject parsing", () => {
  it("identifies a transaction event by its reference", () => {
    const p = provider();
    const subject = p.parseWebhookSubject(fixtureChargeSuccessBody());

    assert.equal(subject.kind, "transaction");
    if (subject.kind === "transaction") assert.equal(subject.providerReference, FIXTURE_REFERENCE);
  });

  it("identifies a transfer event by its transfer reference, not a charge reference", () => {
    const p = provider();
    const subject = p.parseWebhookSubject(fixtureTransferSuccessBody());

    assert.equal(subject.kind, "transfer");
    if (subject.kind === "transfer") assert.equal(subject.transferReference, "KLK-TRF-0000000001");
  });

  it("marks an event type it does not handle as unsupported rather than guessing", () => {
    const p = provider();
    const subject = p.parseWebhookSubject(fixtureUnsupportedEventBody());

    assert.equal(subject.kind, "unsupported");
    if (subject.kind === "unsupported") {
      assert.equal(subject.providerEventType, "some.event.kolekto.does.not.handle");
    }
  });

  it("does not throw on a malformed body", () => {
    const p = provider();
    const subject = p.parseWebhookSubject(fixtureMalformedBody());
    assert.equal(subject.kind, "unsupported");
  });
});

describe("the boundary keeps provider payloads out of the domain", () => {
  it("carries the raw payload for evidence, clearly labelled synthetic", async () => {
    const p = provider();
    await p.initialize(fixtureInitializationRequest());
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(result));
    const raw = result.value.rawPayload as { __fake?: boolean; __note?: string };
    assert.equal(raw.__fake, true, "nothing here is a recording of a real gateway");
    assert.match(raw.__note ?? "", /Synthetic/);
  });

  it("returns money as branded Kobo, never a number", async () => {
    const p = provider();
    await p.initialize(fixtureInitializationRequest());
    const result = await p.verify(FIXTURE_REFERENCE);

    assert.ok(isOk(result));
    // ADR 0003: a provider amount crossing this boundary is already integer kobo.
    // If it arrived as a float or a string, the boundary is the place that failed.
    assert.equal(typeof result.value.amount, "bigint");
    assert.equal(typeof (result.value.providerFee as bigint), "bigint");
  });

  it("echoes Kolekto's own reference rather than inventing one", async () => {
    const p = provider();
    const init = await p.initialize(fixtureInitializationRequest());
    assert.ok(isOk(init));
    assert.equal(init.value.reference, FIXTURE_REFERENCE, "the reference is ours; the provider echoes it");

    const verified = await p.verify(FIXTURE_REFERENCE);
    assert.ok(isOk(verified));
    assert.equal(verified.value.providerReference, FIXTURE_REFERENCE);
  });

  it("records what it was asked, so a test can catch an unintended extra call", async () => {
    const p = provider();
    await p.initialize(fixtureInitializationRequest());

    assert.equal(p.initializeCalls.length, 1);
    assert.equal(p.initializeCalls[0]?.reference, FIXTURE_REFERENCE);
    assert.equal(p.initializeCalls[0]?.amount, FIXTURE_AMOUNT);
    // The provider is told what to charge. It is never asked.
    assert.equal(p.initializeCalls[0]?.currency, "NGN");
  });
});
