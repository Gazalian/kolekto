# SES sender — operator setup runbook

M13.2 P9-4. The *sending* half of SES. Companion to
`docs/runbooks/ses-sns-webhook-operator-setup.md`, which covers the
receiving half.

**Nothing in this PR runs any step below.** Every action is operator-performed. The sender
pause switch stays `false` until §10 is complete, in writing, and a reviewed call to
`app.set_email_sending_enabled(true)` is made against the target environment.

## 1. What this runbook sets up

- AWS SES v2 as the production sending provider for Kolekto's transactional email
  (`EMAIL_PROVIDER=ses`).
- The IAM identity the worker uses (`ses:SendEmail`, `ses:GetAccount` only).
- The Configuration Set that routes bounces, complaints and deliveries to the SNS topic the
  P9-2 webhook already consumes.
- The operational preconditions the adapter's `GetAccount` startup check enforces (sandbox
  vs production, `Max24HourSend`, `MaxSendRate`).

Sending is still gated on §10 release gates after this runbook is complete.

## 2. One-time AWS setup (operator)

1. **Choose the region.** Must match the P9-2 ingestion region.
   `EMAIL_AWS_REGION` is shared between sending and ingestion.
2. **Verify the sending domain in SES.**
   - Create the domain identity.
   - Add the DKIM, SPF and (if applicable) DMARC DNS records to the sending domain.
   - Wait for all three to report "verified" and "DKIM enabled".
3. **Request production access.**
   - SES Console → Account dashboard → Request production access.
   - State the use case (transactional email: officer notifications, member confirmations).
   - Rate-limit expectations: start at SES's granted `Max24HourSend` / `MaxSendRate`;
     Kolekto's own L4/L5 defaults sit below SES's sandbox numbers already, so a successful
     production grant does not need any migration change.
   - **Do not flip the pause switch until this is granted.** The adapter refuses to start
     against a sandbox account in `KOLEKTO_ENV=production`.
4. **Create the Configuration Set.** Name it something stable, e.g. `kolekto-transactional`.
   - Add an **Event Destination** publishing `Bounce`, `Complaint`, `Delivery` and
     `Rendering Failure` events to the SNS topic the P9-2 webhook already consumes
     (`EMAIL_AWS_SNS_TOPIC_ARN`).
   - No other event types are consumed by Kolekto's ingestion; sending them wastes money
     and clutters the ledger.
5. **Create the IAM identity.** Programmatic access (access key id + secret). Policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "SesSend",
         "Effect": "Allow",
         "Action": ["ses:SendEmail", "ses:GetAccount"],
         "Resource": "*"
       }
     ]
   }
   ```

   Scope `ses:SendEmail` to the sending identity's ARN if your organisation requires it;
   `ses:GetAccount` is account-wide and takes `"Resource": "*"`.

6. **Store the credentials in the operator secret store.** Never commit them. The worker
   reads them from `EMAIL_AWS_ACCESS_KEY_ID` and `EMAIL_AWS_SECRET_ACCESS_KEY` at run time.
   The `.env.example` lines are empty on purpose.

## 3. Worker configuration

Set the following env vars in the worker's deployment, from the operator secret store:

```
EMAIL_PROVIDER=ses
EMAIL_FROM=<verified sending address>
APP_BASE_URL=<the environment's https origin>

EMAIL_AWS_REGION=<region, e.g. eu-west-1>
EMAIL_AWS_ACCESS_KEY_ID=<from secret store>
EMAIL_AWS_SECRET_ACCESS_KEY=<from secret store>
EMAIL_AWS_SESSION_TOKEN=<only if using STS/assumed-role creds>
EMAIL_AWS_CONFIGURATION_SET=<the Configuration Set name>
EMAIL_SES_SEND_TIMEOUT_MS=<optional, 1000–60000, default 10000>
```

Leave `EMAIL_API_KEY` and `EMAIL_SMTP_*` unset — the startup guard refuses them next to
`EMAIL_PROVIDER=ses`.

## 4. What the adapter does on startup

- Calls `SESv2 GetAccount` once. Logs
  `provider=ses, idempotency=none, region=…, configuration_set=…, ses_max_24_hour_send=…,
  ses_max_send_rate=…, ses_production_access_enabled=…, local_l4_daily=…, local_l5_per_second=…`.
  No credentials ever appear in the log.
- Refuses to start if any of:
  - `SendingEnabled=false` on the SES account.
  - `ProductionAccessEnabled=false` and the process is in production (`KOLEKTO_ENV=production`).
  - `local_l4_daily >= Max24HourSend` or `local_l5_per_second >= MaxSendRate` (local safety
    ceilings must sit strictly below SES's own numbers).
- Does not re-read `GetAccount` at send time. If SES later lowers `MaxSendRate` due to a
  complaint spike, the operator restarts the worker *after* lowering L4/L5 by a reviewed
  migration — the restart surfaces the mismatch at `GetAccount` reconciliation.

If the adapter refuses, the sender halts: maintenance (lease recovery, 72-hour expiry,
ledger purge, heartbeat) continues; no provider calls are made.

## 5. Changing L4/L5 safely

L4 and L5 live in exactly one place: `app.notification_send_limits(p_class text)`. Change
them with a reviewed migration (§10.6.1). Rules:

- **Never raise L4 or L5 above the provider's own `Max24HourSend` / `MaxSendRate`.** The
  adapter refuses to start when this invariant is violated; a bad migration surfaces at
  the next worker restart, not silently in production.
- Apply to staging first; watch `private.v_notification_send_health` for an hour; apply to
  production.
- A raise applies to the next reservation. A lowering applies to the next reservation too
  and never cancels queued deliveries — the surplus simply defers.

## 6. Ambiguous outcomes — what to expect

SES has no caller-supplied idempotency token. Any ambiguous outcome against the SES adapter
lands as `dead/outcome_unknown` and surfaces in the health view's `dead_by_code`:

- `provider_timeout` with `ambiguous=true` (SES timed out after the request body was sent).
- 5xx with `ambiguous=true` (SES reached, response path dropped).
- `ECONNRESET` / `EPIPE` with `ambiguous=true` (stream dropped after request started).
- A worker killed while holding a lease (`sending` row with an expired lease, no outcome
  recorded) — `app.resolve_lease_ambiguous` makes it dead.

**None of these are retried.** The alternative — a retry against a non-idempotent
provider — risks a second copy. An operator decides whether to re-queue a specific
`outcome_unknown` row by hand, after checking SES's own event stream for a Delivery event
on the stored `provider_message_id` (if one is present) or on the delivery_id tag.

Suggested alert threshold: `resolved_ambiguous_this_tick > 0` for three consecutive minutes.
A sporadic value is normal (worker restarts, transient AWS outages); a sustained value
means the worker is crashing mid-flight repeatedly, which is a deployment issue.

## 7. Pre-first-send checklist (Q-CONFIRM)

Operator checks, dated and signed, for each environment (staging first, then production):

- [ ] `EMAIL_PROVIDER=ses` and the five required `EMAIL_AWS_*` vars set in deployment.
- [ ] Worker started; the startup log line names provider=ses, idempotency=none,
      sensible `ses_max_*` numbers, local L4/L5 strictly below them.
- [ ] `select app.email_sending_enabled();` returns `false`.
- [ ] `select app.set_email_sending_enabled(true);` executed on the target environment by
      the operator, over the owner connection.
- [ ] A test transactional email (e.g. an officer notification to a verified address)
      arrives in the recipient's inbox.
- [ ] A `Delivery` SNS event lands in `email_delivery_events` within ~10 seconds, and the
      matching `notification_deliveries` row transitions `sent → delivered`.
- [ ] A test send to a provider-provided simulator address for a `Complaint` lands a
      permanent row in `email_suppressions` with `source = 'ses_event'`.
- [ ] A test send to the SES simulator "bounce" address lands a `Bounce` → suppression.
- [ ] Health view fields all populated: `l4_last_24h_by_class.transactional >= 1`,
      `sent_24h >= 1`, `dead_by_code.outcome_unknown` absent.

Only after all checks pass may the switch stay on in the environment.

## 8. Rollback

If a problem is detected in production:

1. `select app.set_email_sending_enabled(false);` over the owner connection. The sender
   stops claiming within one tick (≤ 2 s). Queued rows preserve themselves; the 72-hour
   expiry still runs so nothing accumulates past three days.
2. Investigate via the health view and the worker log line.
3. If the issue is a bad L4/L5 migration, prepare a reverting migration; apply to staging;
   apply to production; restart the worker (the adapter re-runs its `GetAccount`
   reconciliation).

Never raise L4/L5 as a workaround for a reputation issue (bounces/complaints spiking) —
that is how domain reputation is lost. Lower L4/L5 to slow sends while the suppression
ingestion absorbs the feedback.

## 9. What this runbook does NOT cover

- The SES/SNS webhook ingestion — see `docs/runbooks/ses-sns-webhook-operator-setup.md`.
- The L4/L5 numbers themselves — see `docs/runbooks/sender-quota-operator-guide.md` and
  §10.6.3 of the decision record.
- Bounce/complaint handling policy — §10.4 and §10.6.4 of the decision record.
