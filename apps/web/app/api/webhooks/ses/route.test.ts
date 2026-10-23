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
 * The DB mocks reflect the M13.2 P9-2.1 orchestration: insert-or-reuse via
 * `recordSesNotification`, then mark the ledger row succeeded or failed
 * depending on the side-effect outcome.
 */

const recordSesNotification = vi.fn();
const markSesNotificationSucceeded = vi.fn();
const markSesNotificationFailed = vi.fn();
const recordSesSuppression = vi.fn();
const recordSesDeliveryEvent = vi.fn();

vi.mock("@kolekto/db", () => ({
  recordSesNotification: (...args: unknown[]) => recordSesNotification(...args),
  markSesNotificationSucceeded: (...args: unknown[]) => markSesNotificationSucceeded(...args),
  markSesNotificationFailed: (...args: unknown[]) => markSesNotificationFailed(...args),
  recordSesSuppression: (...args: unknown[]) => recordSesSuppression(...args),
  recordSesDeliveryEvent: (...args: unknown[]) => recordSesDeliveryEvent(...args),
}));

const SHARED_SECRET = "unit-test-fake-webhook-secret-xyz";
const TOPIC = "arn:aws:sns:eu-west-1:123456789012:kolekto-ses-feedback";

function makeFake(): FakeSesSnsWebhookProvider {
  return new FakeSesSnsWebhookProvider({ expectedTopicArn: TOPIC, sharedSecret: SHARED_SECRET });
}

/**
 * Default DB stubs that model a fresh event row: inserted, previously not
 * succeeded. Tests override as needed.
 */
function setDefaultLedgerBehaviour(eventId = "evt_00000000_0000_0000_0000_000000000001"): void {
  recordSesNotification.mockResolvedValue({
    eventId,
    inserted: true,
    previouslySucceeded: false,
    processingAttempts: 0,
  });
  markSesNotificationSucceeded.mockResolvedValue(1);
  markSesNotificationFailed.mockResolvedValue(1);
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
  recordSesNotification.mockReset();
  markSesNotificationSucceeded.mockReset();
  markSesNotificationFailed.mockReset();
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

  it("returns 413 for an oversized Content-Length header (B)", async () => {
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

  it("returns 413 for an oversized body WITHOUT Content-Length (B — streaming cap)", async () => {
    const { POST, setAdapter } = await reloadRoute();
    setAdapter(makeFake());

    // Build a ReadableStream of 300 KiB in chunks, no Content-Length header.
    const totalBytes = 300 * 1024;
    const chunkSize = 32 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (totalBytes <= 0) {
          controller.close();
          return;
        }
        let sent = 0;
        while (sent < totalBytes) {
          const n = Math.min(chunkSize, totalBytes - sent);
          controller.enqueue(new Uint8Array(n));
          sent += n;
        }
        controller.close();
      },
    });

    const request = new Request("https://app.example.test/api/webhooks/ses", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: stream,
      // Node's fetch requires duplex: "half" for streaming request bodies.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await POST(request);
    expect(response.status).toBe(413);
    // The streaming cap must trigger BEFORE the body is fully buffered —
    // and the ledger must not be touched for a payload we never authenticated.
    expect(recordSesNotification).not.toHaveBeenCalled();
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
    // Nothing should hit the DB for an unauthenticated request.
    expect(recordSesNotification).not.toHaveBeenCalled();
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
  it("writes the event ledger, transitions sent → delivered, marks succeeded on Delivery", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    setDefaultLedgerBehaviour("evt_delivery_1");
    recordSesDeliveryEvent.mockResolvedValue(1);
    const body = notification("SNS-D-001", {
      eventType: "Delivery",
      mail: { messageId: "SES-D-100" },
      delivery: { timestamp: "2026-10-22T10:00:01.000Z", recipients: ["ok@example.test"] },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(recordSesNotification).toHaveBeenCalledTimes(1);
    const call = recordSesNotification.mock.calls[0]![0] as { normalizedEventType: string; providerMessageId: string | null };
    expect(call.normalizedEventType).toBe("delivery");
    expect(call.providerMessageId).toBe("SES-D-100");
    expect(recordSesDeliveryEvent).toHaveBeenCalledWith({ providerMessageId: "SES-D-100", deliveredAt: "2026-10-22T10:00:01.000Z" });
    expect(markSesNotificationSucceeded).toHaveBeenCalledWith("evt_delivery_1");
    expect(markSesNotificationFailed).not.toHaveBeenCalled();
  });

  it("writes a suppression and marks succeeded on a permanent Bounce", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    setDefaultLedgerBehaviour("evt_bounce_1");
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
    expect(markSesNotificationSucceeded).toHaveBeenCalledWith("evt_bounce_1");
    expect(markSesNotificationFailed).not.toHaveBeenCalled();
  });

  it("writes a complaint suppression and marks succeeded", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    setDefaultLedgerBehaviour("evt_complaint_1");
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
    expect(markSesNotificationSucceeded).toHaveBeenCalledWith("evt_complaint_1");
  });

  it("transient bounces do NOT suppress but DO mark succeeded (no_op recorded)", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    setDefaultLedgerBehaviour("evt_transient_1");
    const body = notification("SNS-T-100", {
      eventType: "Bounce",
      mail: { messageId: "SES-T-100" },
      bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "t@example.test" }] },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(recordSesNotification).toHaveBeenCalledTimes(1);
    expect(recordSesSuppression).not.toHaveBeenCalled();
    expect(markSesNotificationSucceeded).toHaveBeenCalledWith("evt_transient_1");
  });

  it("skips the side effect and the succeeded-marker when the event is a prior-success duplicate", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    recordSesNotification.mockResolvedValue({
      eventId: "evt_dup",
      inserted: false,
      previouslySucceeded: true,
      processingAttempts: 1,
    });
    const body = notification("SNS-DUP-001", {
      eventType: "Bounce",
      mail: { messageId: "SES-D" },
      bounce: { bounceType: "Permanent", feedbackId: "FBID", bouncedRecipients: [{ emailAddress: "d@example.test" }] },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(recordSesSuppression).not.toHaveBeenCalled();
    expect(markSesNotificationSucceeded).not.toHaveBeenCalled();
    expect(markSesNotificationFailed).not.toHaveBeenCalled();
    const payload = (await response.json()) as { outcome: string };
    expect(payload.outcome).toBe("duplicate");
  });
});

describe("POST /api/webhooks/ses — reliable side effects (A)", () => {
  it("marks the event failed and returns 500 when the suppression write throws", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    setDefaultLedgerBehaviour("evt_fail_1");
    recordSesSuppression.mockRejectedValueOnce(new Error("db down"));
    const body = notification("SNS-FAIL-1", {
      eventType: "Bounce",
      mail: { messageId: "SES-FAIL-1" },
      bounce: { bounceType: "Permanent", feedbackId: "FBID", bouncedRecipients: [{ emailAddress: "x@example.test" }] },
    });
    const response = await POST(makeRequest(body, provider));
    // 500 so SNS retries. The previous phase would have swallowed and returned 200.
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("suppression_write_failed");
    expect(markSesNotificationSucceeded).not.toHaveBeenCalled();
    expect(markSesNotificationFailed).toHaveBeenCalledWith({
      eventId: "evt_fail_1",
      errorCode: "suppression_write_failed",
    });
  });

  it("marks the event failed and returns 500 when the delivery write throws", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    setDefaultLedgerBehaviour("evt_fail_2");
    recordSesDeliveryEvent.mockRejectedValueOnce(new Error("db down"));
    const body = notification("SNS-FAIL-2", {
      eventType: "Delivery",
      mail: { messageId: "SES-DEL" },
      delivery: { timestamp: "2026-10-22T10:00:01.000Z", recipients: ["ok@example.test"] },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("delivery_write_failed");
    expect(markSesNotificationFailed).toHaveBeenCalledWith({
      eventId: "evt_fail_2",
      errorCode: "delivery_write_failed",
    });
  });

  it("retries the side effect on a redelivery whose ledger row is still pending", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    // Redelivery: inserted=false, previouslySucceeded=false, attempts=1 (from the failed first run).
    recordSesNotification.mockResolvedValue({
      eventId: "evt_retry_1",
      inserted: false,
      previouslySucceeded: false,
      processingAttempts: 1,
    });
    recordSesSuppression.mockResolvedValueOnce(undefined);
    markSesNotificationSucceeded.mockResolvedValue(1);
    const body = notification("SNS-RETRY-1", {
      eventType: "Bounce",
      mail: { messageId: "SES-RETRY-1" },
      bounce: { bounceType: "Permanent", feedbackId: "FBID", bouncedRecipients: [{ emailAddress: "r@example.test" }] },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(200);
    expect(recordSesSuppression).toHaveBeenCalledTimes(1);
    expect(markSesNotificationSucceeded).toHaveBeenCalledWith("evt_retry_1");
  });

  it("returns 500 ledger_write_failed when the ledger insert itself throws", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    recordSesNotification.mockRejectedValueOnce(new Error("db down"));
    const body = notification("SNS-INS-FAIL", {
      eventType: "Delivery",
      mail: { messageId: "SES-INS-FAIL" },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("ledger_write_failed");
    // Response body never carries internal error text.
    expect(JSON.stringify(payload)).not.toContain("db down");
  });

  it("one per-address failure in a multi-recipient batch fails the whole event (idempotent retry on next delivery)", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    setDefaultLedgerBehaviour("evt_batch_fail");
    recordSesSuppression
      .mockResolvedValueOnce(undefined) // first address lands
      .mockRejectedValueOnce(new Error("second-address-fails")); // second blows up
    const body = notification("SNS-B-MULTI", {
      eventType: "Bounce",
      mail: { messageId: "SES-MULTI" },
      bounce: {
        bounceType: "Permanent",
        feedbackId: "FBID-M",
        bouncedRecipients: [
          { emailAddress: "first@example.test" },
          { emailAddress: "second@example.test" },
        ],
      },
    });
    const response = await POST(makeRequest(body, provider));
    expect(response.status).toBe(500);
    // Both calls were attempted; the second raising did not stop the ledger from being marked failed.
    expect(recordSesSuppression).toHaveBeenCalledTimes(2);
    expect(markSesNotificationFailed).toHaveBeenCalledWith({
      eventId: "evt_batch_fail",
      errorCode: "suppression_write_failed",
    });
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
    expect(recordSesNotification).not.toHaveBeenCalled();
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

describe("POST /api/webhooks/ses — no sensitive data in responses", () => {
  it("neither echoes recipient addresses nor raw payloads", async () => {
    const { POST, setAdapter } = await reloadRoute();
    const provider = makeFake();
    setAdapter(provider);
    setDefaultLedgerBehaviour("evt_leak_test");
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
