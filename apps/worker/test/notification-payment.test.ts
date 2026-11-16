import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertValidEmailRequest } from "@kolekto/adapters";

import { renderTemplate, receiptUrl, buildTemplatedMessage } from "../src/notification-email-templates.ts";
import {
  buildPaymentPayload,
  isPaymentAction,
  paymentDedupeKey,
  PAYMENT_ACTIONS,
  type PaymentContextRow,
} from "../src/notification-payment.ts";
import { parseAuditMessage, WATCHED_ACTIONS } from "../src/notification-rules.ts";
import { eventChannelRequirement, emailSendClass, eventPolicy } from "../src/communication-policy.ts";
import { FEE_ALARM_SEVERITY, summarizeFeeAlarms } from "../src/payment-fee-alarm.ts";

const ATTEMPT = "0190d6a0-0000-7000-8000-000000000001";
const COMMUNITY = "0190d6a0-0000-7000-8000-0000000000c1";
const REF = "KLK-0123456789ABCDEFGHJKMNPQRS";

function msg(action: string) {
  const r = parseAuditMessage({
    audit_log_id: "0190d6a0-0000-7000-8000-0000000000a1",
    community_id: COMMUNITY,
    action,
    actor_type: "system",
    actor_user_id: null,
    actor_name: "",
    object_type: "payment_attempt",
    object_id: ATTEMPT,
    after_state: { reference: REF },
    created_at: new Date().toISOString(),
  });
  assert.ok(r.ok);
  return r.message;
}

const CTX: PaymentContextRow = {
  attempt_id: ATTEMPT,
  community_id: COMMUNITY,
  community_name: "Biochem Class '26",
  community_slug: "biochem-26",
  collection_name: "Dinner <tickets>",
  collection_slug: "dinner",
  reference: REF,
  status: "completed",
  contributor_name: "Adaeze Ọkọnkwọ",
  contributor_email: "ada@example.com",
  amount_kobo: "255000",
  contribution_kobo: "250000",
  platform_fee_kobo: "1250",
  gateway_fee_kobo: "3750",
  vat_kobo: "0",
  total_fees_kobo: "5000",
  fee_bearer: "contributor_pays",
  paid_at: new Date("2026-11-16T09:00:00Z"),
  channel: "card",
  failure_code: null,
  review_reason: null,
  provider: "paystack",
  provider_access_code: "ib08os71ijqlae9",
};

describe("payment notification events", () => {
  it("all four are watched, essential, transactional and always sent by email", () => {
    for (const action of PAYMENT_ACTIONS) {
      assert.ok((WATCHED_ACTIONS as readonly string[]).includes(action), action);
      assert.ok(isPaymentAction(action));
      assert.equal(eventPolicy(action)?.category, "essential");
      assert.equal(eventPolicy(action)?.emailFanout, "payer");
      assert.equal(eventChannelRequirement(action, "email")?.kind, "always");
      assert.equal(emailSendClass("essential"), "transactional");
    }
    assert.equal(isPaymentAction("collection.remind_unpaid"), false);
  });

  it("dedupe keys are one per payment and kind, in the delivery table's format", () => {
    const keys = PAYMENT_ACTIONS.map((a) => paymentDedupeKey(a, ATTEMPT));
    assert.equal(new Set(keys).size, 4);
    for (const k of keys) assert.match(k, /^[a-z][a-z_]{2,40}:[A-Za-z0-9-]{1,100}$/);
    assert.equal(paymentDedupeKey("payment.captured", ATTEMPT), `receipt:${ATTEMPT}`);
  });

  it("the payload never carries the payer's address or phone", () => {
    for (const action of PAYMENT_ACTIONS) {
      const json = JSON.stringify(buildPaymentPayload(action, msg(action), CTX));
      assert.ok(!json.includes("ada@example.com"), action);
      for (const key of Object.keys(JSON.parse(json))) assert.ok(!/email|phone|address|reason|recipient/i.test(key), `${action}: ${key}`);
    }
  });

  it("redacts an address typed as a name and drops a malformed reference", () => {
    const p = buildPaymentPayload("payment.captured", msg("payment.captured"), { ...CTX, contributor_name: "me@evil.example", reference: "KLK-bad" });
    assert.equal(p["payer_name"], "[email removed]");
    assert.equal(p["payment_reference"], null);
  });

  it("receipt payload has the fee lines, paid_at and channel; failed has a coarse failure kind", () => {
    const r = buildPaymentPayload("payment.captured", msg("payment.captured"), CTX);
    assert.equal(r["gateway_fee_kobo"], "3750");
    assert.equal(r["paid_at"], "2026-11-16T09:00:00.000Z");
    assert.equal(r["channel"], "card");
    const f = buildPaymentPayload("payment.failed", msg("payment.failed"), { ...CTX, status: "failed", failure_code: "provider_abandoned" });
    assert.equal(f["failure_kind"], "not_completed");
    const d = buildPaymentPayload("payment.failed", msg("payment.failed"), { ...CTX, status: "failed", failure_code: "provider_failed" });
    assert.equal(d["failure_kind"], "declined");
  });

  it("initialized payload has the Paystack checkout URL; non-paystack or missing code gives null", () => {
    const init = buildPaymentPayload("payment.initialized", msg("payment.initialized"), CTX);
    assert.equal(init["checkout_url"], "https://checkout.paystack.com/ib08os71ijqlae9");
    const fake = buildPaymentPayload("payment.initialized", msg("payment.initialized"), { ...CTX, provider: "fake" });
    assert.equal(fake["checkout_url"], null);
    const noCode = buildPaymentPayload("payment.initialized", msg("payment.initialized"), { ...CTX, provider_access_code: null });
    assert.equal(noCode["checkout_url"], null);
  });
});

describe("payment email templates", () => {
  const base = "https://kolekto.example";
  const payloadFor = (action: (typeof PAYMENT_ACTIONS)[number]) => buildPaymentPayload(action, msg(action), CTX);

  it("the receipt shows amounts in naira from integer kobo, the reference, and a receipt link", () => {
    const r = renderTemplate({ eventType: "payment.captured", payload: payloadFor("payment.captured"), appBaseUrl: base })!;
    assert.match(r.subject, /^Payment receipt: ₦2,550\.00 to Dinner <tickets>$/);
    for (const want of ["Contribution: ₦2,500.00", "Processing fee: ₦37.50", "Kolekto fee: ₦12.50", "Total paid: ₦2,550.00", `Reference: ${REF}`, "Paid with: Card"]) {
      assert.ok(r.text.includes(want), want);
    }
    assert.ok(r.text.includes(`${base}/biochem-26/dinner/payment/receipt?reference=${REF}`));
    assert.ok(r.html.includes("Dinner &lt;tickets&gt;"), "HTML-escaped");
    assert.ok(!r.html.includes("<tickets>"));
    assert.ok(!r.text.includes("VAT"), "zero VAT is not shown");
  });

  it("a host-absorbed receipt shows no fee lines", () => {
    const p = buildPaymentPayload("payment.captured", msg("payment.captured"), { ...CTX, fee_bearer: "community_absorbs", amount_kobo: "250000" });
    const r = renderTemplate({ eventType: "payment.captured", payload: p, appBaseUrl: base })!;
    assert.ok(!r.text.includes("Processing fee") && !r.text.includes("Kolekto fee"));
    assert.ok(r.text.includes("Total paid: ₦2,500.00"));
  });

  it("started email includes the Paystack checkout link, review and failed emails say the right thing", () => {
    const started = renderTemplate({ eventType: "payment.initialized", payload: payloadFor("payment.initialized"), appBaseUrl: base })!;
    assert.match(started.subject, /^Payment started: /);
    assert.ok(started.text.includes("no money is taken unless the payment is completed"));
    assert.ok(started.text.includes("https://checkout.paystack.com/ib08os71ijqlae9"), "checkout link in text");
    assert.ok(started.html.includes("https://checkout.paystack.com/ib08os71ijqlae9"), "checkout link in html");
    assert.ok(started.text.includes("Complete your payment"), "CTA label");
    const review = renderTemplate({ eventType: "payment.needs_review", payload: payloadFor("payment.needs_review"), appBaseUrl: base })!;
    assert.ok(review.text.includes("You do not need to pay again"));
    const failed = renderTemplate({ eventType: "payment.failed", payload: payloadFor("payment.failed"), appBaseUrl: base })!;
    assert.match(failed.subject, /^Payment not completed: /);
    assert.ok(failed.text.includes("We have not received this payment"));
    assert.ok(failed.text.includes(`${base}/biochem-26/dinner`));
  });

  it("started email has no checkout link for a non-paystack provider or missing access code", () => {
    const noProvider = buildPaymentPayload("payment.initialized", msg("payment.initialized"), { ...CTX, provider: "fake", provider_access_code: "FAKE_ACC_123" });
    const r1 = renderTemplate({ eventType: "payment.initialized", payload: noProvider, appBaseUrl: base })!;
    assert.ok(!r1.text.includes("checkout.paystack.com"), "no link for fake provider");
    const noCode = buildPaymentPayload("payment.initialized", msg("payment.initialized"), { ...CTX, provider_access_code: null });
    const r2 = renderTemplate({ eventType: "payment.initialized", payload: noCode, appBaseUrl: base })!;
    assert.ok(!r2.text.includes("checkout.paystack.com"), "no link when access code is null");
  });

  it("is complete without a base URL (no link), and produces a valid provider message", () => {
    const r = renderTemplate({ eventType: "payment.captured", payload: payloadFor("payment.captured") })!;
    assert.ok(!r.text.includes("http"));
    const m = buildTemplatedMessage("ada@example.com", { eventType: "payment.captured", payload: payloadFor("payment.captured") });
    assert.doesNotThrow(() => assertValidEmailRequest({ idempotencyKey: "k", message: m }));
  });

  it("receiptUrl refuses a malformed reference or slug", () => {
    assert.equal(receiptUrl(base, "biochem-26", "dinner", "KLK-nope"), null);
    assert.equal(receiptUrl(base, "../x", "dinner", REF), null);
    assert.equal(receiptUrl(undefined, "biochem-26", "dinner", REF), null);
  });
});

describe("M8.7 fee alarm summary", () => {
  it("groups by alarm with bigint totals and severities, ignoring junk rows", () => {
    const out = summarizeFeeAlarms([
      { alarm: "provider_fee_exceeds_estimate", channel: "card", overrun_kobo: "1250" },
      { alarm: "provider_fee_exceeds_estimate", channel: "card", overrun_kobo: "600" },
      { alarm: "provider_fee_exceeds_fee_charged", channel: null, overrun_kobo: "100" },
      { alarm: "something_else", channel: "card", overrun_kobo: "9" },
      { alarm: "provider_fee_exceeds_estimate", channel: "bank", overrun_kobo: "-5" },
      { alarm: "provider_fee_exceeds_estimate", channel: "bank", overrun_kobo: "0" },
    ]);
    assert.deepEqual(out, [
      {
        msg: "payment_fee_alarm",
        alarm: "provider_fee_exceeds_fee_charged",
        severity: "critical",
        window_hours: 24,
        contributions: 1,
        total_overrun_kobo: "100",
        max_overrun_kobo: "100",
        channels: ["unknown"],
      },
      {
        msg: "payment_fee_alarm",
        alarm: "provider_fee_exceeds_estimate",
        severity: "warning",
        window_hours: 24,
        contributions: 2,
        total_overrun_kobo: "1850",
        max_overrun_kobo: "1250",
        channels: ["card"],
      },
    ]);
    assert.equal(FEE_ALARM_SEVERITY.provider_fee_exceeds_fee_charged, "critical");
  });

  it("is silent with no rows", () => {
    assert.deepEqual(summarizeFeeAlarms([]), []);
  });
});
