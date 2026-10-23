# SES/SNS webhook — operator setup runbook

Receiving half only. This runbook describes the AWS-side resources and
Kolekto configuration an operator must prepare for inbound SES delivery
feedback. **No step here is performed automatically; nothing in this PR
touches AWS.**

Sending (SES → recipient mailboxes) is a separate milestone (P9-4) and is
gated on the P9 production-readiness checks (D-PROVIDER, D-DOMAIN,
D-LEGAL, D-CONSENT, D-WORKER) plus a reviewed Q-CONFIRM. **Setting up the
receiving path does NOT enable sending.** The sender pause switch remains
off until P9-4 and the P9 gate is cleared.

## 1. What you are setting up

The Kolekto application exposes `POST /api/webhooks/ses` to receive SNS
Notification envelopes from a single SNS topic that is subscribed to one
or more SES event-destination streams. The route:

- authenticates the SNS signature over the raw envelope bytes, with a
  strict `sns.<region>.amazonaws.com` hostname allowlist for the signing
  certificate URL;
- validates the envelope's `TopicArn` against the configured expected
  ARN;
- stores a dedupe-safe row in `public.email_delivery_events` BEFORE any
  side effect;
- for `Bounce` (Permanent) and `Complaint` events, writes a permanent
  recipient suppression (`source = 'ses_event'`) that the sender's
  pre-send check (`app.is_address_suppressed`, P9-1) consults;
- for `Delivery` events, transitions the matching
  `notification_deliveries` row from `sent` to `delivered`;
- for `SubscriptionConfirmation` envelopes, visits the authenticated
  `SubscribeURL` so the subscription takes effect.

## 2. AWS resources to create (operator)

Each step is operator-performed in the account that owns the production
sending identity. **Nothing in this PR performs any of these steps.**

1. **Verify your sending identity in SES** (domain or email identity).
   This is a sending-side prerequisite — not completed in this phase.
2. **Create an SNS topic** that will fan out SES feedback. Suggested
   name: `kolekto-ses-feedback`. Enable topic policy entries that
   permit SES event destinations in the same account to publish to it
   and that explicitly deny publishes from any other principal.
3. **Enable SignatureVersion 2** on the topic. Kolekto accepts both
   version 1 and version 2, but v2 (RSA-SHA256) is the current AWS
   recommendation.
4. **Create a subscription** from the SNS topic to the webhook route:
   - Protocol: `HTTPS`
   - Endpoint: `https://<app host>/api/webhooks/ses`
   - Enable raw message delivery: **off** (we want the SNS envelope).
   - Retry policy: default is fine; Kolekto returns 200 on duplicates
     and 400 on authentication failure, so SNS will not retry forever.
5. **SES event destinations**: configure the SES configuration set used
   by Kolekto outbound sends (P9-4) to publish `send`, `delivery`,
   `bounce`, `complaint`, `reject`, `renderingFailure` to the SNS topic.
   This step is sending-side and is **not** required for the webhook
   itself to accept confirmed events; it is listed here so the whole
   loop is documented.
6. **DNS, SPF, DKIM, DMARC**: unchanged by this phase. See the P9-4
   runbook once that milestone starts.

Nothing on this list is automated by Kolekto. The operator records each
step's completion in the P9 operator checklist.

## 3. Kolekto configuration (per deploy)

Two required server-only environment variables. Set both or neither.
Setting one without the other refuses startup.

```
EMAIL_AWS_REGION=eu-west-1
EMAIL_AWS_SNS_TOPIC_ARN=arn:aws:sns:eu-west-1:123456789012:kolekto-ses-feedback
```

One optional variable, M13.2 P9-2.1:

```
# Opt in to accepting SignatureVersion 1 (RSA-SHA1) in addition to
# SignatureVersion 2 (RSA-SHA256). Default is v2 only. Must be exactly
# "true" or "false" (or unset).
EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1=false
```

Validation (performed by `evaluateSesIngestionConfig` at startup):

- `EMAIL_AWS_REGION` matches `^[a-z0-9]+(?:-[a-z0-9]+)+$`.
- `EMAIL_AWS_SNS_TOPIC_ARN` matches
  `^arn:aws(?:-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$`.
- The ARN's region segment MUST equal `EMAIL_AWS_REGION`.
- `EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1`, when set, must be the literal
  string `"true"` or `"false"`. Any other value refuses to start — no
  silent coercion.
- Neither value may be exposed through a `NEXT_PUBLIC_*` variable. A
  `NEXT_PUBLIC_AWS_*` or `NEXT_PUBLIC_SNS_*` on the deploy refuses to
  start, same guard that already protects `EMAIL_API_KEY`.

No shared secret is used; SNS signature verification is the sole
authentication mechanism.

### SignatureVersion posture

The adapter defaults to accepting SignatureVersion 2 (RSA-SHA256) only.
AWS recommends enabling v2 on every topic ([verify-signature docs]).
When creating a new SNS topic for Kolekto, enable SignatureVersion 2
and leave `EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1` unset. If an existing
topic you cannot reconfigure still uses v1, set
`EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1=true` to expand the accepted set to
`["1", "2"]`.

[verify-signature docs]: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html

### Local development

Fake and Mailpit workflows still work without any AWS variables set.
Testing the ingestion route locally does not require AWS at all:

```
KOLEKTO_ENV=local
EMAIL_AWS_REGION=eu-west-1
EMAIL_AWS_SNS_TOPIC_ARN=arn:aws:sns:eu-west-1:000000000000:local-fake
SES_FAKE_WEBHOOK_SECRET=some-random-string-at-least-eight-chars
```

When `KOLEKTO_ENV=local` and `SES_FAKE_WEBHOOK_SECRET` is set, the route
instantiates the HMAC fake adapter instead of the real SES/SNS adapter.
`SES_FAKE_WEBHOOK_SECRET` is ignored outside local; a hosted deployment
always uses the real adapter.

## 4. Verifying the webhook is reachable

Use the following command AFTER the SNS topic has been created and the
HTTPS subscription has been requested. SNS posts a
`SubscriptionConfirmation` to the endpoint on subscription; the route
visits the authenticated `SubscribeURL` and the subscription becomes
`Confirmed`.

1. Request the subscription from the AWS console or CLI. SNS posts the
   confirmation envelope within a few seconds.
2. Watch application logs for a `subscription_confirmed` outcome. On
   failure, inspect the stable rejection code in the response the route
   returned (`missing_signature`, `bad_signature`, `untrusted_cert_url`,
   `unexpected_topic_arn`, `stale_timestamp`, …).
3. If the SubscribeURL could not be visited, re-request the subscription
   from AWS. The route is idempotent — resending a confirmation while a
   previous attempt is already Confirmed is a safe no-op.

## 5. Operational notes

- **No events are suppressed on transient bounces** by this phase. A
  transient bounce row is stored in `public.email_delivery_events` for
  operator visibility; nothing writes to the suppression list. A later
  milestone may introduce `transient_bounce_capped` behaviour.
- **No delivery-status transition on anything but Delivery.** Rejection
  and rendering_failure events are logged in the ledger but do not alter
  `notification_deliveries.status`; a sent → dead transition remains the
  worker's call.
- **Retention** of `public.email_delivery_events` is open and deferred to
  the broader `financial_events.payload` retention review. Rows are
  append-only until an operator-controlled retention migration lands.
- **No PII in logs.** The webhook route logs only stable codes and
  counts. Recipient addresses, payload text and provider error prose are
  never emitted outside the ledger.

## 6. What this runbook does NOT include

- Setting up the SES sending identity.
- Configuring SPF, DKIM or DMARC records.
- Enabling the Kolekto email sender pause switch.
- Any production deployment steps.

Each belongs to P9-4 or a later operator checklist.
