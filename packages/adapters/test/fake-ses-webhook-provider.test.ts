import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeSesSnsWebhookProvider } from "../src/fake-ses-webhook-provider.ts";

const SECRET = "unit-test-shared-secret-not-real";
const TOPIC = "arn:aws:sns:eu-west-1:123456789012:kolekto-ses-feedback";

function makeAdapter(opts: Partial<ConstructorParameters<typeof FakeSesSnsWebhookProvider>[0]> = {}): FakeSesSnsWebhookProvider {
  return new FakeSesSnsWebhookProvider({ expectedTopicArn: TOPIC, sharedSecret: SECRET, ...opts });
}

function signAndEncode(body: unknown, provider: FakeSesSnsWebhookProvider): { rawBody: Uint8Array; headers: Record<string, string> } {
  const text = JSON.stringify(body);
  const rawBody = new TextEncoder().encode(text);
  const sig = provider.sign(rawBody);
  return { rawBody, headers: { "x-fake-sns-signature": sig } };
}

const BASE_NOTIFICATION = {
  Type: "Notification",
  MessageId: "FAKE-SNS-MSG-0001",
  TopicArn: TOPIC,
  Timestamp: "2026-10-22T10:00:00.000Z",
  Signature: "ignored-by-fake",
  SignatureVersion: "2",
  SigningCertURL: "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-x.pem",
  Message: JSON.stringify({
    eventType: "Delivery",
    mail: { messageId: "SES-MSG-SENT-001" },
    delivery: { timestamp: "2026-10-22T10:00:01.000Z", recipients: ["ok@example.test"] },
  }),
};

describe("FakeSesSnsWebhookProvider — signature verification", () => {
  it("rejects a request without a signature header", async () => {
    const p = makeAdapter();
    const { rawBody } = signAndEncode(BASE_NOTIFICATION, p);
    const result = await p.authenticate({ rawBody });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "missing_signature");
  });

  it("rejects a request whose signature does not match the body", async () => {
    const p = makeAdapter();
    const { rawBody, headers } = signAndEncode(BASE_NOTIFICATION, p);
    const result = await p.authenticate({ rawBody, headers: { ...headers, "x-fake-sns-signature": "deadbeef" } });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "bad_signature");
  });

  it("accepts a signed Notification and returns the authenticated envelope", async () => {
    const p = makeAdapter();
    const { rawBody, headers } = signAndEncode(BASE_NOTIFICATION, p);
    const result = await p.authenticate({ rawBody, headers });
    assert.equal(result.outcome, "authentic");
    if (result.outcome === "authentic") {
      assert.equal(result.envelope.identity.providerEventId, "FAKE-SNS-MSG-0001");
      assert.equal(result.envelope.identity.snsTopicArn, TOPIC);
      assert.equal(result.envelope.type, "Notification");
      assert.notEqual(result.envelope.sesMessage, null);
    }
  });

  it("rejects a signed body with the wrong topic ARN", async () => {
    const p = makeAdapter();
    const body = { ...BASE_NOTIFICATION, TopicArn: "arn:aws:sns:eu-west-1:123456789012:somebody-else" };
    const { rawBody, headers } = signAndEncode(body, p);
    const result = await p.authenticate({ rawBody, headers });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "unexpected_topic_arn");
  });

  it("rejects a message type we don't accept", async () => {
    const p = makeAdapter();
    const body = { ...BASE_NOTIFICATION, Type: "Something else" };
    const { rawBody, headers } = signAndEncode(body, p);
    const result = await p.authenticate({ rawBody, headers });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "unexpected_message_type");
  });

  it("rejects a malformed JSON body", async () => {
    const p = makeAdapter();
    const rawBody = new TextEncoder().encode("not json");
    const headers = { "x-fake-sns-signature": p.sign(rawBody) };
    const result = await p.authenticate({ rawBody, headers });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "unparseable");
  });

  it("rejects a body with no MessageId", async () => {
    const p = makeAdapter();
    const body: Record<string, unknown> = { ...BASE_NOTIFICATION };
    delete body.MessageId;
    const { rawBody, headers } = signAndEncode(body, p);
    const result = await p.authenticate({ rawBody, headers });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "missing_event_id");
  });
});

describe("FakeSesSnsWebhookProvider — classification", () => {
  async function auth(body: unknown): ReturnType<FakeSesSnsWebhookProvider["authenticate"]> {
    const p = makeAdapter();
    const { rawBody, headers } = signAndEncode(body, p);
    return p.authenticate({ rawBody, headers });
  }
  const classify = (adapter: FakeSesSnsWebhookProvider, envelope: Parameters<FakeSesSnsWebhookProvider["classifyEvent"]>[0]) =>
    adapter.classifyEvent(envelope);

  it("classifies Delivery and extracts the SES message id + recipients", async () => {
    const r = await auth(BASE_NOTIFICATION);
    assert.equal(r.outcome, "authentic");
    if (r.outcome !== "authentic") return;
    const e = classify(makeAdapter(), r.envelope);
    assert.equal(e.normalizedEventType, "delivery");
    assert.equal(e.providerEventType, "Delivery");
    assert.equal(e.providerMessageId, "SES-MSG-SENT-001");
    assert.deepEqual(e.recipientAddresses, ["ok@example.test"]);
    assert.equal(e.deliveredAt, "2026-10-22T10:00:01.000Z");
  });

  it("classifies a permanent Bounce", async () => {
    const body = {
      ...BASE_NOTIFICATION,
      MessageId: "FAKE-SNS-BOUNCE-PERM",
      Message: JSON.stringify({
        eventType: "Bounce",
        mail: { messageId: "SES-MSG-100" },
        bounce: {
          bounceType: "Permanent",
          feedbackId: "FBID-100",
          bouncedRecipients: [{ emailAddress: "Bounced@Example.TEST" }],
        },
      }),
    };
    const r = await auth(body);
    assert.equal(r.outcome, "authentic");
    if (r.outcome !== "authentic") return;
    const e = makeAdapter().classifyEvent(r.envelope);
    assert.equal(e.normalizedEventType, "bounce_permanent");
    assert.equal(e.feedbackId, "FBID-100");
    assert.deepEqual(e.recipientAddresses, ["bounced@example.test"]);
  });

  it("classifies a transient Bounce (bounceType Transient and Undetermined both)", async () => {
    const transient = {
      ...BASE_NOTIFICATION,
      MessageId: "FAKE-SNS-BOUNCE-T",
      Message: JSON.stringify({
        eventType: "Bounce",
        mail: { messageId: "SES-MSG-T" },
        bounce: { bounceType: "Transient", feedbackId: "FBID-T", bouncedRecipients: [{ emailAddress: "t@example.test" }] },
      }),
    };
    const undetermined = {
      ...BASE_NOTIFICATION,
      MessageId: "FAKE-SNS-BOUNCE-U",
      Message: JSON.stringify({
        eventType: "Bounce",
        mail: { messageId: "SES-MSG-U" },
        bounce: { bounceType: "Undetermined", feedbackId: "FBID-U", bouncedRecipients: [{ emailAddress: "u@example.test" }] },
      }),
    };
    for (const body of [transient, undetermined]) {
      const r = await auth(body);
      assert.equal(r.outcome, "authentic");
      if (r.outcome !== "authentic") continue;
      const e = makeAdapter().classifyEvent(r.envelope);
      assert.equal(e.normalizedEventType, "bounce_transient");
    }
  });

  it("classifies a Complaint", async () => {
    const body = {
      ...BASE_NOTIFICATION,
      MessageId: "FAKE-SNS-COMPLAINT",
      Message: JSON.stringify({
        eventType: "Complaint",
        mail: { messageId: "SES-MSG-C" },
        complaint: { feedbackId: "FBID-C", complainedRecipients: [{ emailAddress: "c@example.test" }] },
      }),
    };
    const r = await auth(body);
    assert.equal(r.outcome, "authentic");
    if (r.outcome !== "authentic") return;
    const e = makeAdapter().classifyEvent(r.envelope);
    assert.equal(e.normalizedEventType, "complaint");
    assert.equal(e.feedbackId, "FBID-C");
    assert.deepEqual(e.recipientAddresses, ["c@example.test"]);
  });

  it("classifies Reject and Rendering Failure", async () => {
    const reject = { ...BASE_NOTIFICATION, MessageId: "F-R", Message: JSON.stringify({ eventType: "Reject", mail: { messageId: "SES-R" } }) };
    const render = { ...BASE_NOTIFICATION, MessageId: "F-RF", Message: JSON.stringify({ eventType: "Rendering Failure", mail: { messageId: "SES-RF" } }) };
    for (const [body, want] of [[reject, "rejection"], [render, "rendering_failure"]] as const) {
      const r = await auth(body);
      assert.equal(r.outcome, "authentic");
      if (r.outcome !== "authentic") continue;
      const e = makeAdapter().classifyEvent(r.envelope);
      assert.equal(e.normalizedEventType, want);
    }
  });

  it("classifies an unknown event as 'other'", async () => {
    const body = { ...BASE_NOTIFICATION, MessageId: "F-OTH", Message: JSON.stringify({ eventType: "Something-New", mail: { messageId: "SES-X" } }) };
    const r = await auth(body);
    assert.equal(r.outcome, "authentic");
    if (r.outcome !== "authentic") return;
    const e = makeAdapter().classifyEvent(r.envelope);
    assert.equal(e.normalizedEventType, "other");
  });

  it("silently drops malformed recipient addresses from the recipient list", async () => {
    const body = {
      ...BASE_NOTIFICATION,
      MessageId: "F-BAD-ADDR",
      Message: JSON.stringify({
        eventType: "Delivery",
        mail: { messageId: "SES-BAD-ADDR" },
        delivery: {
          timestamp: "2026-10-22T10:00:01.000Z",
          recipients: ["ok@example.test", "no at sign", ""],
        },
      }),
    };
    const r = await auth(body);
    assert.equal(r.outcome, "authentic");
    if (r.outcome !== "authentic") return;
    const e = makeAdapter().classifyEvent(r.envelope);
    assert.deepEqual(e.recipientAddresses, ["ok@example.test"]);
  });
});

describe("FakeSesSnsWebhookProvider — SubscriptionConfirmation", () => {
  const SUB_BODY = {
    Type: "SubscriptionConfirmation",
    MessageId: "FAKE-SUB-0001",
    TopicArn: TOPIC,
    Timestamp: "2026-10-22T10:00:00.000Z",
    Signature: "ignored",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.eu-west-1.amazonaws.com/x.pem",
    Message: "please confirm",
    Token: "token-abc",
    SubscribeURL: "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc",
  };

  it("authenticates and surfaces the SubscribeURL", async () => {
    const p = makeAdapter();
    const { rawBody, headers } = signAndEncode(SUB_BODY, p);
    const r = await p.authenticate({ rawBody, headers });
    assert.equal(r.outcome, "authentic");
    if (r.outcome !== "authentic") return;
    assert.equal(r.envelope.type, "SubscriptionConfirmation");
    assert.equal(r.envelope.subscribeUrl, SUB_BODY.SubscribeURL);
  });

  it("confirmSubscription records the visited URL and reports success", async () => {
    const p = makeAdapter();
    const r = await p.confirmSubscription(SUB_BODY.SubscribeURL);
    assert.equal(r.outcome, "confirmed");
    assert.deepEqual(p.confirmedSubscriptions, [SUB_BODY.SubscribeURL]);
  });

  it("confirmSubscription reports scripted rejection when configured", async () => {
    const p = makeAdapter({ confirmSubscriptionSucceeds: false });
    const r = await p.confirmSubscription(SUB_BODY.SubscribeURL);
    assert.equal(r.outcome, "rejected");
  });
});
