import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { FakeSesSnsWebhookProvider } from "@kolekto/adapters";

// Vitest runs this module in a plain Node environment where the Next.js
// virtual `"server-only"` marker is not resolvable. The marker's sole job is
// to fail client-side bundling of a module; in tests it is a no-op.
vi.mock("server-only", () => ({}));

/**
 * route.test.ts — vitest route-handler tests for /api/webhooks/ses.
 *
 * The database boundary (@kolekto/db) is mocked at module level so this
 * test exercises the route's branching, status codes and side-effect
 * dispatch without reaching a live Postgres. Signature verification runs
 * against real HMAC arithmetic through the fake adapter — the signing path
 * is still exercised, just with a shared secret rather than RSA.
 *
 * Everything the route calls into @kolekto/db has a mock recorder here. A
 * test can assert the exact call shape (not just that something ran).
 */

const insertEmailDeliveryEvent = vi.fn();
const recordSesSuppression = vi.fn();
const recordSesDeliveryEvent = vi.fn();

vi.mock("@kolekto/db", () => ({
  insertEmailDeliveryEvent: (...args: unknown[]) => insertEmailDeliveryEvent(...args),
  recordSesSuppression: (...args: unknown[]) => recordSesSuppression(...args),
  recordSesDeliveryEvent: (...args: unknown[]) => recordSesDeliveryEvent(...args),
}));

const SHARED_SECRET = "unit-test-fake-webhook-secret-xyz";
const TOPIC = "arn:aws:sns:eu-west-1:123456789012:kolekto-ses-feedback";

function makeFake(): FakeSesSnsWebhookProvider {
  return new FakeSesSnsWebhookProvider({ expectedTopicArn: TOPIC, sharedSecret: SHARED_SECRET });
}

function makeRequest(body: unknown, provider: FakeSesSnsWebhookProvider, overrides: { headers?: Record<string, string>; method?: string } = {}): Request {
  const text = JSON.stringify(body);
  const headers = new Headers({
    "content-type": "text/plain; charset=UTF-8",
    "x-fake-sns-signature": provider.sign(new TextEncoder().encode(text)),
    ...(overrides.headers ?? {}),
  });
  return new Request("https://app.example.test/api/webhooks/ses", {
    method: overrides.method ?? "POST",
    headers,
    body: text,
  });
}

function notification(id: string, sesMessage: unknown): Record<string, unknown> {
  return {
    Type: "Notification",
    MessageId: id,
    TopicArn: TOPIC,
    Timestamp: new Date().toISOString(),
    Signature: "ignored-by-fake",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.eu-west-1.amazonaws.com/x.pem",
    Message: JSON.stringify(sesMessage),
  };
}

async function reloadRoute(): Promise<{
  POST: (req: Request) => Promise<Response>;
  GET: () => Promise<Response>;
  PUT: () => Promise<Response>;
  setAdapter: (p: FakeSesSnsWebhookProvider | null) => void;
  clearCache: () => void;
}> {
  vi.resetModules();
  const route = await import("./route.ts");
  const adapterMod = await import("./adapter.ts");
  return {
    POST: route.POST,
    GET: route.GET,
    PUT: route.PUT,
    setAdapter: adapterMod.setSesWebhookAdapterForTesting,
    clearCache: adapterMod.clearSesWebhookAdapterForTesting,
  };
}

beforeEach(() => {
  insertEmailDeliveryEvent.mockReset();
  recordSesSuppression.mockReset();
  recordSesDeliveryEvent.mockReset();
});

afterEach(async () => {
  // Reset the adapter cache so each test starts fresh.
  const { clearCache } = await reloadRoute();
  clearCache();
});

describe("POST /api/webhooks/ses — method + content gates", () => {
  it("returns 405 for GET", async () => {
    const { GET } = await reloadRoute();
    const response = await GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns 405 for PUT", async () => {
    const { PUT } = await reloadRoute();
    const response = await PUT();
    expect(response.status).toBe(405);
  });

  it("returns 415 for an unsupported content type", async () => {
    const { POST, setAdapter } = await reloadRoute();
    setAdapter(makeFake());
    const request = new Request("https://app.example.test/api/webhooks/ses", {
      method: "POST",
      headers: { "content-type": "text/html" },
      body: "<html></html>",
    });
    const response = await POST(request);
    expect(response.status).toBe(415);
  });

  it("returns 413 for an oversized Content-Length header", async () => {
    const { POST, setAdapter } = await reloadRoute();
    setAdapter(makeFake());
    const request = new Request("https://app.example.test/api/webhooks/ses", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": String(300 * 1024) },
      body: "{}",
    });
    const response = await POST(request);
    expect(response.status).toBe(413);
  });

  it("returns 503 when SES ingestion is not configured", async () => {
    const { POST, setAdapter } = await reloadRoute();
    setAdapter(null);
    const request = new Request("https://app.example.test/api/webhooks/ses", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const response = await POST(request);
    expect(response.status).toBe(503);
  });
});

describe("POST /api/webhooks/ses — signature and envelope rejection", () => {
  it("returns 400 missing_signature when no signature header is present", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    const body = notification("SNS-R-001", { eventType: "Delivery", mail: { messageId: "SES-R-001" } });
    const request = new Request("https://app.example.test/api/webhooks/ses", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(body),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("missing_signature");
  });

  it("returns 400 bad_signature when the signature does not match the body", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    const body = notification("SNS-R-002", { eventType: "Delivery", mail: { messageId: "SES-R-002" } });
    const request = new Request("https://app.example.test/api/webhooks/ses", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-fake-sns-signature": "deadbeef" },
      body: JSON.stringify(body),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("bad_signature");
  });

  it("returns 400 unexpected_topic_arn when the ARN does not match", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    const body = {
      ...notification("SNS-R-003", { eventType: "Delivery", mail: { messageId: "SES-R-003" } }),
      TopicArn: "arn:aws:sns:eu-west-1:123456789012:somebody-else",
    };
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("unexpected_topic_arn");
  });
});

describe("POST /api/webhooks/ses — Notification happy paths", () => {
  it("writes the event ledger and transitions sent → delivered for Delivery", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    insertEmailDeliveryEvent.mockResolvedValue({ inserted: true });
    recordSesDeliveryEvent.mockResolvedValue(1);
    const body = notification("SNS-D-001", {
      eventType: "Delivery",
      mail: { messageId: "SES-D-100" },
      delivery: { timestamp: "2026-10-22T10:00:01.000Z", recipients: ["ok@example.test"] },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(insertEmailDeliveryEvent).toHaveBeenCalledTimes(1);
    const call = insertEmailDeliveryEvent.mock.calls[0]![0] as { normalizedEventType: string; providerMessageId: string | null };
    expect(call.normalizedEventType).toBe("delivery");
    expect(call.providerMessageId).toBe("SES-D-100");
    expect(recordSesDeliveryEvent).toHaveBeenCalledWith({ providerMessageId: "SES-D-100", deliveredAt: "2026-10-22T10:00:01.000Z" });
  });

  it("writes a suppression on a permanent Bounce", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    insertEmailDeliveryEvent.mockResolvedValue({ inserted: true });
    recordSesSuppression.mockResolvedValue(undefined);
    const body = notification("SNS-B-100", {
      eventType: "Bounce",
      mail: { messageId: "SES-B-100" },
      bounce: {
        bounceType: "Permanent",
        feedbackId: "FBID-100",
        bouncedRecipients: [{ emailAddress: "bounced@example.test" }],
      },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(recordSesSuppression).toHaveBeenCalledWith({
      address: "bounced@example.test",
      reason: "hard_bounce",
      feedbackId: "FBID-100",
      providerMessageId: "SES-B-100",
    });
  });

  it("writes a complaint suppression", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    insertEmailDeliveryEvent.mockResolvedValue({ inserted: true });
    recordSesSuppression.mockResolvedValue(undefined);
    const body = notification("SNS-C-100", {
      eventType: "Complaint",
      mail: { messageId: "SES-C-100" },
      complaint: { feedbackId: "FBID-C-100", complainedRecipients: [{ emailAddress: "x@example.test" }] },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(recordSesSuppression).toHaveBeenCalledWith({
      address: "x@example.test",
      reason: "complaint",
      feedbackId: "FBID-C-100",
      providerMessageId: "SES-C-100",
    });
  });

  it("transient bounces do NOT suppress but DO write to the ledger", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    insertEmailDeliveryEvent.mockResolvedValue({ inserted: true });
    const body = notification("SNS-T-100", {
      eventType: "Bounce",
      mail: { messageId: "SES-T-100" },
      bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "t@example.test" }] },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(insertEmailDeliveryEvent).toHaveBeenCalledTimes(1);
    expect(recordSesSuppression).not.toHaveBeenCalled();
  });

  it("skips the side effect when the event row was a duplicate", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    insertEmailDeliveryEvent.mockResolvedValue({ inserted: false });
    const body = notification("SNS-DUP-001", {
      eventType: "Bounce",
      mail: { messageId: "SES-D" },
      bounce: { bounceType: "Permanent", feedbackId: "FBID", bouncedRecipients: [{ emailAddress: "d@example.test" }] },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(recordSesSuppression).not.toHaveBeenCalled();
    const payload = (await response.json()) as { outcome: string };
    expect(payload.outcome).toBe("duplicate");
  });
});

describe("POST /api/webhooks/ses — SubscriptionConfirmation", () => {
  it("confirms a subscription and does not touch the ledger", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    const body = {
      Type: "SubscriptionConfirmation",
      MessageId: "SNS-SUB-001",
      TopicArn: TOPIC,
      Timestamp: new Date().toISOString(),
      Signature: "ignored",
      SignatureVersion: "2",
      SigningCertURL: "https://sns.eu-west-1.amazonaws.com/x.pem",
      Message: "please confirm",
      Token: "token-abc",
      SubscribeURL: "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc",
    };
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(insertEmailDeliveryEvent).not.toHaveBeenCalled();
    expect(provider.confirmedSubscriptions).toEqual([body.SubscribeURL]);
  });

  it("returns 400 when the SubscribeURL confirm is refused", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = new FakeSesSnsWebhookProvider({
      expectedTopicArn: TOPIC,
      sharedSecret: SHARED_SECRET,
      confirmSubscriptionSucceeds: false,
    });
    setAdapter(provider);
    const body = {
      Type: "SubscriptionConfirmation",
      MessageId: "SNS-SUB-002",
      TopicArn: TOPIC,
      Timestamp: new Date().toISOString(),
      Signature: "ignored",
      SignatureVersion: "2",
      SigningCertURL: "https://sns.eu-west-1.amazonaws.com/x.pem",
      Message: "please confirm",
      Token: "token-xyz",
      SubscribeURL: "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=xyz",
    };
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("subscribe_url_refused");
  });
});

describe("POST /api/webhooks/ses — error paths", () => {
  it("returns 500 ledger_write_failed when the event insert throws", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    insertEmailDeliveryEvent.mockRejectedValue(new Error("db down"));
    const body = notification("SNS-ERR-001", { eventType: "Delivery", mail: { messageId: "SES-ERR" } });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("ledger_write_failed");
    // Nothing leaky in the response body
    expect(JSON.stringify(payload)).not.toContain("db down");
  });

  it("suppresses even when a per-address write throws (one bad entry does not stop the rest)", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    insertEmailDeliveryEvent.mockResolvedValue({ inserted: true });
    recordSesSuppression
      .mockRejectedValueOnce(new Error("first fails"))
      .mockResolvedValueOnce(undefined);
    const body = notification("SNS-B-MULTI", {
      eventType: "Bounce",
      mail: { messageId: "SES-M" },
      bounce: {
        bounceType: "Permanent",
        feedbackId: "FBID-M",
        bouncedRecipients: [{ emailAddress: "first@example.test" }, { emailAddress: "second@example.test" }],
      },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(recordSesSuppression).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/webhooks/ses — no sensitive data in responses", () => {
  it("neither echoes recipient addresses nor raw payloads", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    insertEmailDeliveryEvent.mockResolvedValue({ inserted: true });
    recordSesDeliveryEvent.mockResolvedValue(1);
    const body = notification("SNS-NO-LEAK", {
      eventType: "Delivery",
      mail: { messageId: "SES-LEAK" },
      delivery: { timestamp: "2026-10-22T10:00:01.000Z", recipients: ["private@example.test"] },
    });
    const response = await POST(makeRequest(body, provider));
    const bodyText = await response.text();
    expect(bodyText).not.toContain("private@example.test");
    expect(bodyText).not.toContain("SES-LEAK");
  });
});
