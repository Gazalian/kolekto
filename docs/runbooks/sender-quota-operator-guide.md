# Sender quota controls — operator guide

M13.2 P9-3. Covers the L4 (daily) and L5 (per-second) safety limits added in
migration `20261024200000_notification_quota_controls.sql`. The sender
itself is still disabled (no real provider is registered), so nothing in
this runbook enables sending; it describes how L4/L5 behave when the pause
switch is eventually flipped on under a real SES adapter (P9-4).

## 1. What L4 and L5 are, and are not

- **L4 — per class, daily (rolling 24 h).** Transactional default: `180`.
  Bulk default: `0`. A breach *defers* the delivery with `next_retry_at =
  oldest counted attempt + 24 h`. No provider call is made and no attempt
  is counted. Reservation outcome: `provider_daily_limited`.
- **L5 — per class, per second (rolling 1 s).** Transactional default: `1`.
  Bulk default: `0`. A breach *defers* with `next_retry_at = now() + 1 s +
  jitter(0–200 ms)`. No provider call, no attempt counted. Reservation
  outcome: `provider_rate_limited`.

Neither limit skips, drops or counts an attempt. L4 and L5 are the
provider-aware **safety ceiling** — set strictly below what the provider
itself will accept — so Kolekto never has to recover from a provider-side
throttle at steady state.

Both limits split by the new `send_class` column (`transactional` or
`bulk`). Every delivery today is `transactional`. The bulk class exists so
a later milestone can turn bulk on by raising its two numbers; its zero
defaults mean a stray bulk row would defer forever and age out at 72 h.

## 2. Where the numbers live, and how to change them

The numbers are stored in exactly one SQL function:

```sql
select * from app.notification_send_limits('transactional');
select * from app.notification_send_limits('bulk');
```

Changing a number is a **reviewed migration** — `create or replace function
app.notification_send_limits(p_class text) ...`. Never run an ad-hoc
`UPDATE` or edit a UI; neither path exists. Follow the §10.6.1 rule from
the decision record:

1. Write a new migration file under `supabase/migrations/`.
2. Keep every other number the same unless you have an explicit reason to
   change them.
3. Keep the boundary tests green
   (`supabase/tests/44_notification_quota_controls.sql`) — they read the
   function and assert the new values.
4. Apply to staging and watch the health view for a full hour before
   touching production.

A raise applies to the next reservation (deferred rows become claimable
as soon as the window permits). A lowering **never** cancels queued
deliveries; the surplus simply defers.

## 3. Hard rule — never above the provider's own numbers

A future SES adapter (P9-4) calls `SESv2 GetAccount` at startup and reads
`SendQuota.Max24HourSend` and `SendQuota.MaxSendRate`. The adapter refuses
to start when `l4_daily >= Max24HourSend` or `l5_per_second >=
MaxSendRate`. **Verify the provider's current numbers before raising
L4/L5.**

Common AWS values at the time of writing:

| State                | `Max24HourSend` | `MaxSendRate` |
|----------------------|-----------------|---------------|
| Sandbox              | 200             | 1/s           |
| First production tier (typical) | 50 000 | 14/s |

Kolekto's defaults (`180`, `1`) sit under sandbox. **Do not raise them
until the AWS production access request is granted** AND an operator has
read the current `GetAccount` output and recorded the numbers in the
change migration.

## 4. Reading quota state

Read the health view over the owner connection (no client role may read
it):

```sql
select * from private.v_notification_send_health;
```

Fields relevant to L4/L5:

- `l4_last_24h_by_class` — `jsonb` keyed by class, counts of reservations
  in the last 24 h.
- `l4_utilisation_pct_by_class` — same keys, utilisation as a percentage
  of the configured cap (`null` for a zero cap).
- `l5_last_second_by_class` — counts in the last rolling second.
- `l5_utilisation_pct_by_class` — percentage of the configured cap.
- `deferred_backlog` and `oldest_deferred_age_s` — total deferred rows and
  the age of the oldest. L4 and L5 defers contribute here.
- `last_heartbeat_at`, `last_claim_at` — the sender's heartbeat (one
  per minute) and most recent claim time.

The worker's per-minute structured log line (`msg:
"notification_send_health"`) carries the same fields. Nothing in the view
or the log line contains an address, name or provider error text.

## 5. Diagnosing a sudden deferral spike

Symptoms: `deferred_backlog` rising, `oldest_deferred_age_s` growing,
`sent_24h` flat.

| Symptom                                                      | Likely cause                                                                   | Response                                                                                                 |
|--------------------------------------------------------------|--------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| `l4_utilisation_pct_by_class.transactional` near 100         | Daily cap reached — legitimate load or sender overshooting.                    | Confirm cap is still below the provider's `Max24HourSend`. If so, consider a reviewed raise; else wait.  |
| `l5_utilisation_pct_by_class.transactional` ≥ 90             | Sender is at its per-second ceiling — healthy for a batch drain.               | Watch for a few minutes; the jittered 1 s retries drain backlog without a hot loop.                     |
| `deferred_backlog` large AND `l2_busiest_last_hour` near 100 | A single community is dominating; L2 (not L4/L5) is the binding limit.         | Same response as before P9-3 — see §10.6.1.                                                              |
| Provider feedback shows bounces/complaints spiking           | Reputation issue, not a cap one.                                               | Lower L4/L5 to slow sends while the suppression ingestion absorbs the feedback. Do **not** raise them.   |
| Pause switch flipped off                                     | `email_sending_enabled = false` by seed and by migration contract.             | Expected before P9-4. The sender claims nothing while paused.                                            |

## 6. Recovery from a backlog

**Never flip L4 to a very large value to clear a queue.** That is how
sending reputation is lost (AWS reduces `MaxSendRate` after a complaint
spike, so you would then be over the provider's own limit anyway).

Order of operations if the system is misbehaving:

1. **Pause.** `select app.set_email_sending_enabled(false);` over the
   owner connection. The sender stops claiming; the queue preserves
   itself. The 72-hour expiry still runs and ages out rows that are too
   old.
2. **Investigate.** Read the health view, the SES/SNS ingestion log, and
   the per-minute worker log. Determine what the dominant deferral code
   is (`deferred_backlog`, `l4/l5 utilisation`, `skipped_by_code`,
   `dead_by_code`).
3. **Act narrowly.** If the deferral is L5-driven and the sender is
   healthy, no change is needed — the queue will drain. If L4 is binding
   and the provider has unused daily capacity, prepare a reviewed
   migration raising L4 for `transactional` only; apply to staging; watch
   for an hour; apply to production. **Never** raise L4 above
   `Max24HourSend`.
4. **Resume.** `select app.set_email_sending_enabled(true);`.

## 7. What this runbook does NOT cover

- Switching between providers, or adding a provider. P9-4.
- Enabling the sender for the first time. P9-4; also gated on D-PROVIDER,
  D-DOMAIN, D-LEGAL, D-CONSENT, D-WORKER and the Q-CONFIRM operator check.
- SES/SNS webhook ingestion setup — see
  `docs/runbooks/ses-sns-webhook-operator-setup.md`.
- Bounce/complaint handling policy — see §10.4 and the suppression
  implementation record (`M13.2-P9-1-RECIPIENT-SUPPRESSION-IMPLEMENTATION.md`).
