import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync, X509Certificate } from "node:crypto";

import { SesSnsWebhookProvider } from "../src/ses-sns-webhook-provider.ts";

const REGION = "eu-west-1";
const TOPIC = `arn:aws:sns:${REGION}:123456789012:kolekto-ses-feedback`;
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-fixture.pem`;

// ── Fixture: a self-signed RSA cert and its signing key ────────────────────
// Produced once per test file run. The private key signs test envelopes; the
// cert PEM is returned by the injected fetchCertificate seam so the real
// signature-verification path runs end-to-end on real RSA arithmetic.

const SUBJECT = "CN=sns-signing-fixture";
const { privateKey, publicKey, certPem } = createTestCertificate();

function createTestCertificate(): { privateKey: ReturnType<typeof createPrivateKey>; publicKey: ReturnType<typeof createPublicKey>; certPem: string } {
  const { publicKey: pub, privateKey: priv } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // Node's X509Certificate is read-only; we use the X.509 facility from the
  // forge-less path by hand-rolling a minimal cert via the OpenSSL CLI
  // compatible self-sign through "x509 -subj". Node has no built-in cert
  // builder, so we instead ship a precomputed self-signed cert — but to keep
  // the test standalone we construct the PEM at run time with the
  // `node-forge`-style approach via `openssl` is not portable. Simplest
  // alternative: use Node's own crypto to build a certificate using a tiny
  // helper from `node:crypto`. Since Node 19+, `crypto.X509Certificate` is
  // read-only; constructing a cert requires more. We therefore use
  // `crypto.generateKeyPairSync` + a pre-baked PEM via `pki.certificate`
  // through the pure-JS implementation below.
  //
  // Pragmatic approach: `X509Certificate` from node:crypto accepts any
  // valid DER/PEM. We embed a tiny valid self-signed cert built from the
  // generated key by hand-rolling the ASN.1 — overkill for a test. So:
  // we skip certificate issuance and verify the signature directly using
  // the public KeyObject by subclassing SesSnsWebhookProvider's cert fetch
  // to return a cert built in-process using `createPublicKey(pub)` and
  // emitting a MINIMAL self-signed cert via `generateX509Pem`.
  const certPem = buildSelfSignedPem(pub, priv);
  return { privateKey: priv, publicKey: pub, certPem };
}

/**
 * Build a self-signed X.509 PEM for a given RSA keypair.
 *
 * Uses `node:crypto` primitives alone — no openssl CLI, no third-party
 * library — by assembling the ASN.1 DER structure for a minimal cert, then
 * signing it. Only the fields the real adapter reads (public key, validity)
 * are populated; the rest are placeholders a parser accepts.
 *
 * This is test-only code and lives beside its one caller.
 */
function buildSelfSignedPem(pub: ReturnType<typeof createPublicKey>, priv: ReturnType<typeof createPrivateKey>): string {
  // Encode a minimal cert's TBSCertificate. SEQUENCE of:
  //   version [0] INTEGER 2,
  //   serialNumber INTEGER 1,
  //   signature AlgorithmIdentifier (sha256WithRSAEncryption),
  //   issuer Name (one CN=fixture),
  //   validity (Sequence of two UTCTime),
  //   subject Name,
  //   subjectPublicKeyInfo,
  //   extensions (empty)
  const asn1 = buildTbsCertificate(pub);
  const sig = createSign("RSA-SHA256").update(asn1).sign(priv);
  const cert = wrapInCertSequence(asn1, sig);
  const b64 = cert.toString("base64");
  const lines: string[] = ["-----BEGIN CERTIFICATE-----"];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  lines.push("-----END CERTIFICATE-----");
  return lines.join("\n");
}

// ── ASN.1 / DER encoding helpers (minimal, test-only) ───────────────────────

function tlv(tag: number, body: Buffer): Buffer {
  const len = body.length;
  if (len < 128) return Buffer.concat([Buffer.from([tag, len]), body]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), body]);
}

function derSequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}
function derSet(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}
function derInteger(value: number): Buffer {
  // Positive small integers only, for the serial number case.
  if (value === 0) return tlv(0x02, Buffer.from([0]));
  const bytes: number[] = [];
  let n = value;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  // Prepend 0x00 if the high bit of the first byte is set.
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}
function derOid(oid: string): Buffer {
  const parts = oid.split(".").map((s) => Number.parseInt(s, 10));
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (let i = 2; i < parts.length; i += 1) {
    const v = parts[i]!;
    const bytes: number[] = [v & 0x7f];
    let r = v >> 7;
    while (r > 0) {
      bytes.unshift((r & 0x7f) | 0x80);
      r >>>= 7;
    }
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
}
function derNull(): Buffer {
  return tlv(0x05, Buffer.alloc(0));
}
function derPrintableString(s: string): Buffer {
  return tlv(0x13, Buffer.from(s, "ascii"));
}
function derUtcTime(d: Date): Buffer {
  // YYMMDDHHMMSSZ
  const pad = (n: number) => n.toString().padStart(2, "0");
  const s =
    pad(d.getUTCFullYear() % 100) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
  return tlv(0x17, Buffer.from(s, "ascii"));
}
function derBitString(bytes: Buffer): Buffer {
  // 0 unused bits + payload
  return tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));
}
function tagContext(tag: number, body: Buffer): Buffer {
  return tlv(0xa0 | tag, body);
}

function buildTbsCertificate(pub: ReturnType<typeof createPublicKey>): Buffer {
  // AlgorithmIdentifier: sha256WithRSAEncryption = 1.2.840.113549.1.1.11
  const sigAlg = derSequence(derOid("1.2.840.113549.1.1.11"), derNull());
  // Name: SEQUENCE OF SET OF SEQUENCE { OID, PrintableString }
  // commonName OID = 2.5.4.3
  const name = derSequence(derSet(derSequence(derOid("2.5.4.3"), derPrintableString("sns-fixture"))));
  const now = new Date();
  const notBefore = derUtcTime(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const notAfter = derUtcTime(new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000));
  const validity = derSequence(notBefore, notAfter);
  // SubjectPublicKeyInfo: use the DER-encoded SPKI the key already exports.
  const spki = pub.export({ format: "der", type: "spki" }) as Buffer;
  // version [0] EXPLICIT INTEGER DEFAULT v1 — supply v3 (value 2)
  const version = tagContext(0, derInteger(2));
  const serial = derInteger(1);
  return derSequence(version, serial, sigAlg, name, validity, name, spki);
}

function wrapInCertSequence(tbs: Buffer, signature: Buffer): Buffer {
  const sigAlg = derSequence(derOid("1.2.840.113549.1.1.11"), derNull());
  return derSequence(tbs, sigAlg, derBitString(signature));
}

// ── Canonicalisation helper so the test produces real SNS-canonical bodies ─

function canonical(envelope: Record<string, string>): string {
  const keys = envelope.Type === "Notification"
    ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
    : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  let out = "";
  for (const k of keys) {
    const v = envelope[k];
    if (v === undefined) {
      if (k === "Subject") continue;
    } else {
      out += k + "\n" + v + "\n";
    }
  }
  return out;
}

function signEnvelope(envelope: Record<string, string>): string {
  const canonicalString = canonical(envelope);
  return createSign("RSA-SHA256").update(canonicalString, "utf8").sign(privateKey).toString("base64");
}

function toRawBody(envelope: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function freshNotification(): Record<string, string> {
  return {
    Type: "Notification",
    MessageId: "SNS-MSG-REAL-0001",
    TopicArn: TOPIC,
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
    Signature: "placeholder-will-be-replaced",
    Message: JSON.stringify({
      eventType: "Delivery",
      mail: { messageId: "SES-R-001" },
      delivery: { timestamp: "2026-10-22T10:00:01.000Z", recipients: ["ok@example.test"] },
    }),
  };
}

function makeAdapter(overrides: Partial<ConstructorParameters<typeof SesSnsWebhookProvider>[0]> = {}): SesSnsWebhookProvider {
  return new SesSnsWebhookProvider({
    region: REGION,
    expectedTopicArn: TOPIC,
    fetchCertificate: async (url) => {
      if (url !== CERT_URL) throw new Error("test only serves one cert URL");
      return certPem;
    },
    confirmSubscription: async () => ({ outcome: "confirmed" }),
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SesSnsWebhookProvider — construction guards", () => {
  it("refuses a malformed region", () => {
    assert.throws(() => new SesSnsWebhookProvider({ region: "INVALID", expectedTopicArn: TOPIC } as never), /region/i);
  });

  it("refuses a malformed topic ARN", () => {
    assert.throws(() => new SesSnsWebhookProvider({ region: REGION, expectedTopicArn: "not-an-arn" } as never), /ARN/i);
  });

  it("refuses an ARN whose region segment disagrees with the configured region", () => {
    assert.throws(
      () => new SesSnsWebhookProvider({ region: "eu-west-1", expectedTopicArn: "arn:aws:sns:us-east-1:123456789012:x" } as never),
      /region/i,
    );
  });
});

describe("SesSnsWebhookProvider — signature verification (real RSA)", () => {
  it("authenticates a correctly signed Notification", async () => {
    const env = freshNotification();
    env.Signature = signEnvelope(env);
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "authentic");
  });

  it("rejects a wrongly signed Notification", async () => {
    const env = freshNotification();
    env.Signature = signEnvelope(env);
    env.Message = JSON.stringify({ eventType: "Delivery", mail: { messageId: "TAMPERED" } });
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "bad_signature");
  });

  it("rejects an unsupported SignatureVersion", async () => {
    const env = freshNotification();
    env.SignatureVersion = "99";
    env.Signature = signEnvelope(env);
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "unsupported_signature_version");
  });

  it("rejects a missing Signature", async () => {
    const env = freshNotification();
    delete (env as Record<string, string | undefined>).Signature;
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env as Record<string, string>) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "missing_signature");
  });

  it("rejects a cert URL from an untrusted hostname", async () => {
    const env = freshNotification();
    env.SigningCertURL = "https://evil.example.com/cert.pem";
    env.Signature = signEnvelope(env);
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "untrusted_cert_url");
  });

  it("rejects a cert URL served over http", async () => {
    const env = freshNotification();
    env.SigningCertURL = `http://sns.${REGION}.amazonaws.com/cert.pem`;
    env.Signature = signEnvelope(env);
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "untrusted_cert_url");
  });

  it("rejects a wrong topic ARN", async () => {
    const env = freshNotification();
    env.TopicArn = `arn:aws:sns:${REGION}:123456789012:somebody-else`;
    env.Signature = signEnvelope(env);
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "unexpected_topic_arn");
  });

  it("rejects an unparseable body before any cert fetch", async () => {
    let fetched = false;
    const adapter = makeAdapter({
      fetchCertificate: async () => {
        fetched = true;
        return certPem;
      },
    });
    const result = await adapter.authenticate({ rawBody: new TextEncoder().encode("not json") });
    assert.equal(result.outcome, "rejected");
    assert.equal(fetched, false);
  });

  it("rejects a certificate fetch failure as cert_fetch_failed", async () => {
    const adapter = makeAdapter({
      fetchCertificate: async () => {
        throw new Error("http_500");
      },
    });
    const env = freshNotification();
    env.Signature = signEnvelope(env);
    const result = await adapter.authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "cert_fetch_failed");
  });

  it("rejects a stale timestamp outside the allowed skew", async () => {
    const env = freshNotification();
    env.Timestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago, default max is 15 min
    env.Signature = signEnvelope(env);
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "stale_timestamp");
  });

  it("rejects a Type outside the SNS set", async () => {
    const env = freshNotification();
    env.Type = "ExampleType";
    env.Signature = signEnvelope(env);
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "unexpected_message_type");
  });

  it("rejects a missing MessageId", async () => {
    const env = freshNotification();
    delete (env as Record<string, string | undefined>).MessageId;
    (env as Record<string, string>).Signature = signEnvelope(env as Record<string, string>);
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env as Record<string, string>) });
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") assert.equal(result.rejection.reason, "missing_event_id");
  });
});

describe("SesSnsWebhookProvider — SubscriptionConfirmation path", () => {
  it("authenticates a signed SubscriptionConfirmation and surfaces the SubscribeURL", async () => {
    const env: Record<string, string> = {
      Type: "SubscriptionConfirmation",
      MessageId: "SNS-SUB-001",
      TopicArn: TOPIC,
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      SigningCertURL: CERT_URL,
      Signature: "",
      Message: "please confirm",
      Token: "token-abc",
      SubscribeURL: `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&Token=abc`,
    };
    env.Signature = signEnvelope(env);
    const result = await makeAdapter().authenticate({ rawBody: toRawBody(env) });
    assert.equal(result.outcome, "authentic");
    if (result.outcome !== "authentic") return;
    assert.equal(result.envelope.type, "SubscriptionConfirmation");
    assert.equal(result.envelope.subscribeUrl, env.SubscribeURL);
  });

  it("confirmSubscription refuses a URL that is not on the expected hostname", async () => {
    const adapter = makeAdapter();
    const r = await adapter.confirmSubscription("https://evil.example.com/confirm");
    assert.equal(r.outcome, "rejected");
    if (r.outcome === "rejected") assert.equal(r.reason, "untrusted_url");
  });
});

describe("SesSnsWebhookProvider — certificate cache", () => {
  it("fetches once per URL and reuses", async () => {
    let calls = 0;
    const adapter = makeAdapter({
      fetchCertificate: async () => {
        calls += 1;
        return certPem;
      },
    });
    for (let i = 0; i < 3; i += 1) {
      const env = freshNotification();
      env.MessageId = `SNS-MSG-${i}`;
      env.Signature = signEnvelope(env);
      const r = await adapter.authenticate({ rawBody: toRawBody(env) });
      assert.equal(r.outcome, "authentic");
    }
    assert.equal(calls, 1);
  });
});

// Export unused imports for linter happiness.
export { X509Certificate };
