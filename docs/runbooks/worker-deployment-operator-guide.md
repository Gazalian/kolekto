# Worker deployment — operator guide

M13.2 P9-5 (D-WORKER). Covers the `apps/worker` process: how to run it,
what to feed it, how to tell it is alive, which alerts to wire, and the
rollout order with the pause switch. Companion to:

- `docs/runbooks/ses-sender-operator-setup.md` — the sending-side AWS
  setup (SES account, Configuration Set, IAM, `GetAccount` checklist).
- `docs/runbooks/ses-sns-webhook-operator-setup.md` — the receiving
  side (SNS subscription, delivery-event webhook).
- `docs/runbooks/sender-quota-operator-guide.md` — the L4 / L5 numbers
  and how to change them.

**Nothing in this runbook flips the pause switch.** Sending stays off
until a reviewed, dated operator action calls
`app.set_email_sending_enabled(true)` on the target environment, and
only after every §7 (Q-CONFIRM) line in the SES-sender runbook is
checked in writing.

## 1. What this runbook sets up

- A **long-running** Node 22 process (the one in `apps/worker`) that
  consumes the pgmq `notification_events` queue over a direct Postgres
  connection and runs the email sender tick.
- Signal handling, graceful shutdown and restart policy that match the
  lease / heartbeat model in migration
  `20261019140000_notification_sender_controls.sql` and the
  ambiguous-recovery routing in migration
  `20261025100000_notification_lease_recovery_variants.sql`.
- Log collection for the per-minute `notification_send_health` JSON line
  and the alerts in §4.

> **Proposed defaults, not yet approved policy.** Every numeric value in
> §3 — the drain budget (90 s), the restart backoff and crash-loop
> threshold (3 fatal exits in 5 min), the single-instance invariant, the
> memory and CPU ceilings (256 / 512 MiB; 0.1 / 0.5 vCPU), the 30-day
> log retention — and the `Severity (proposed)` column in the §4 alert
> table are **proposed defaults** from the P9-5 design document. They
> become operator policy only after `M13.2-P9-5-WORKER-DEPLOYMENT-DESIGN.md`
> §6 "Decisions requiring approval" is reviewed and approved. Until then
> this runbook is a proposal to pattern-match against, not a settled
> contract.

## 2. Platform choice (operator decides)

**This runbook does not pick a platform.** The design doc
`docs/product/M13.2-P9-5-WORKER-DEPLOYMENT-DESIGN.md` keeps the choice
operator-side. What matters is that the chosen platform satisfies §3
(contract). Common options and the trade-offs:

- **Managed container platform** (Fly machines, AWS App Runner, GCP
  Cloud Run worker service, Railway).
  Pro: SIGTERM + restart policy out of the box; log collection is
  usually free; one-replica is a dropdown. Scale-to-zero should be
  **off** for a worker that owns a heartbeat.
  Con: cold-start on restart adds latency a VM does not have; some
  platforms force an HTTP health probe (see §3.4 and the design doc
  §3.6).
- **Kubernetes `Deployment`** with `replicas: 1`,
  `terminationGracePeriodSeconds: 90` and `strategy: Recreate`.
  Pro: full control; standard patterns for probes and secrets.
  Con: cluster operation overhead; a `RollingUpdate` would briefly run
  two instances, which violates §3.1 of the design doc — use `Recreate`
  instead.
- **Long-running VM process managed by systemd** (`Restart=on-failure`,
  `RestartSec=2`, `KillSignal=SIGTERM`, `TimeoutStopSec=90`).
  Pro: simple and predictable; no cold-start; the operator already
  owns the host.
  Con: operator owns patching the host; log collection is a separate
  wiring job.
- **Managed worker service** (Fly machines in "worker" mode, Railway
  worker service).
  Pro: least to configure.
  Con: not every platform guarantees single-replica; confirm in writing.

**Do NOT run the worker on Supabase Edge Functions** (ADR 0005), as a
short cron, or as a serverless function that scales out. The lease and
heartbeat model assume one owner.

## 3. Deployment contract

The deployment artefact (whichever platform the operator chooses) must
satisfy every row below. The follow-up platform slice adds the artefact
itself; this runbook is what a reviewer checks it against.

### 3.1 Build and entrypoint

- Build: `npm install && npm run build --workspace apps/worker` (produces
  `apps/worker/dist/index.js` via esbuild, Node 22 target).
- Run: `node apps/worker/dist/index.js`.
- Do **not** run `node src/index.ts` or `npm run start` wrapping a dev
  build in production. The bundled output is what has been tested.
- Node runtime: ≥ 22.6.0 (from the root `package.json` `engines` field).

### 3.2 Instance count

- Exactly **one** replica per environment (`staging`: 1; `production`:
  1). This is a platform setting, not a convention — the platform
  configuration must enforce `maxReplicas = 1` where that control exists.
- A deliberate hand-off during a deploy is OK (see §5), as a brief
  overlap under operator supervision. Horizontal scale is not.

### 3.3 Signals and drain

- Stop signal: **`SIGTERM`**. The worker's own `SIGINT` and `SIGTERM`
  handlers (`apps/worker/src/index.ts:101-102`) flip `running = false`
  so the current loop iteration completes.
- Drain budget before `SIGKILL`: **≥ 90 s**. Covers one
  `EMAIL_SES_SEND_TIMEOUT_MS` (default 10 s, max 60 s) + one pgmq
  `VISIBILITY_TIMEOUT_S` (30 s) + a few hundred ms of settle.
- If the hard kill fires, the `sending` row's lease (5 min) expires on
  the next worker's maintenance tick and lands as `dead/outcome_unknown`
  per migration `20261025100000`. **Nothing is lost; at worst one row
  needs operator review.** No "drain forever" mode.

### 3.4 Health probing

- The worker emits one JSON `notification_send_health` log line per
  minute to `stdout`. A **liveness via log** rule is: no health line
  from this process for 2 minutes → the process is wedged or dead →
  restart.
- The worker **does not** expose an HTTP `/healthz` today. If the
  chosen platform requires one, add it in a small follow-up PR as
  described in design-doc §3.6 (new optional env var
  `WORKER_HEALTH_PORT`; when unset the HTTP surface is not opened).
- An HTTP probe, when added:
  - `GET /healthz` → `200 OK` iff the Postgres pool reports open AND the
    last tick completed within 2 × `SENDER_MAINTENANCE_MS` (= 2 min).
  - `GET /readyz` → `200 OK` iff `/healthz` passes AND either
    `EMAIL_PROVIDER` is unset (event-stage-only mode) or the pause-switch
    read succeeded on the last tick.
  - Both endpoints behind a private reverse proxy; no auth; no request
    body accepted.

### 3.5 Restart policy

- Normal exit code 0 → do not restart automatically (intentional
  shutdown).
- Fatal exit code 1 → restart with exponential backoff from ~2 s to
  ~5 min.
- Three fatal exits in five minutes → crash loop; page on-call; keep
  the worker stopped until an operator intervenes.

### 3.6 Log collection

- `stdout`: structured JSON (one `notification_send_health` line per
  minute; a few other info-level lines).
- `stderr`: plain text (startup errors, provider errors by code, loop
  errors).
- Neither stream carries recipient addresses, member names, email
  bodies, or raw provider error messages, by construction (see
  `apps/worker/src/notification-sender-state.ts :: SendHealth` and
  `apps/worker/src/notification-sender.ts :: healthLogLine`).
- Shipping target: the operator's existing log collector.
- **Baseline retention: 30 days.** A shorter window makes trend charts
  useless; a longer window invites a privacy review (delivery-ids +
  correlating SES events can identify a recipient after the fact).

### 3.7 Resource ceilings

Observed on the current codebase at the configured
`SENDER_BATCH = 20` per tick and `POLL_INTERVAL_MS = 2 s` idle:

- Memory: a healthy worker steady-state is well under 256 MiB; the
  recommended request is **256 MiB** with a cap of **512 MiB**. A
  memory climb above steady-state is a bug the operator should capture
  a heap snapshot of before restart.
- CPU: steady-state is a small fraction of one core; request **0.1
  vCPU**, cap **0.5 vCPU**.
- Pool connections: one `postgres` connection pool. The worker opens
  no file descriptors beyond this and `stdout`/`stderr`.

### 3.8 Secrets

The worker reads these at startup from the environment. Each MUST come
from the operator secret store, injected at process start, **never
committed**.

| Variable | Required when | What |
|---|---|---|
| `SUPABASE_DB_URL` | always | Direct Postgres connection. Server-only. |
| `EMAIL_AWS_SECRET_ACCESS_KEY` | `EMAIL_PROVIDER=ses` | IAM secret for `ses:SendEmail`/`ses:GetAccount`. Wrapped as `EmailSecret` — logs print `[redacted]`. |
| `EMAIL_AWS_SESSION_TOKEN` | optional, STS/assumed-role | Same redaction. |

The worker does **not** read `SUPABASE_SERVICE_ROLE_KEY`,
`KOLEKTO_SESSION_SECRET`, `PAYSTACK_*`, `WHATSAPP_*`, `SMS_*`,
`EMAIL_AWS_SNS_TOPIC_ARN`, `EMAIL_AWS_SNS_ALLOW_SIGNATURE_V1`,
`SENTRY_DSN`, or `EMAIL_API_KEY`. Those belong to `apps/web`.

### 3.9 Non-secret environment surface

Required in every worker deployment:

```
KOLEKTO_ENV=<local|staging|production>
NEXT_PUBLIC_SUPABASE_URL=<https://<ref>.supabase.co>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
SUPABASE_DB_URL=<from secret store>
```

Required when `KOLEKTO_ENV=staging`:

```
KOLEKTO_EXPECTED_PROJECT_REF=<must equal the ref parsed from the URL>
```

Optional defence (recommended in staging + production):

```
KOLEKTO_PRODUCTION_PROJECT_REF=<the production project ref>
LOG_LEVEL=info
```

Email sending (set only on the environments where you want the sender
loaded; the worker runs the event stage even when these are unset):

```
EMAIL_PROVIDER=<fake|mailpit|ses>
EMAIL_FROM=<single plain address>
APP_BASE_URL=<the environment's https origin>
```

SES-only, when `EMAIL_PROVIDER=ses` (see the SES-sender runbook §3):

```
EMAIL_AWS_REGION=<e.g. eu-west-1>
EMAIL_AWS_ACCESS_KEY_ID=<from secret store>
EMAIL_AWS_SECRET_ACCESS_KEY=<from secret store>
EMAIL_AWS_SESSION_TOKEN=<optional, STS/assumed-role>
EMAIL_AWS_CONFIGURATION_SET=<the Configuration Set name>
EMAIL_SES_SEND_TIMEOUT_MS=<optional, 1000–60000, default 10000>
```

Explicit **don't**: never set `KOLEKTO_WORKER_INTEGRATION=1` in
staging or production — that flag enables opt-in local integration
tests only.

## 4. Alerts to wire

Thresholds consolidated from decision record §10.6.1 (A1–A4) and
§10.6.4 / P9-4 §3.8 (A5). Severity ("Page" vs "Ticket") and routing
target are operator decisions; the design asks only that A1–A4 reach a
human within 15 min and A5 within 1 h.

| # | Metric | Source | Threshold | For | Severity (proposed) | Why |
|---|---|---|---|---|---|---|
| **A1** | `l3_utilisation_pct` | per-minute `notification_send_health` log line (JSON) or `app.notification_send_health()` row | ≥ 80 | 10 minutes sustained | Page | Platform-wide L3 saturation squeezes every community. Sustained saturation is a provider / deliverability signal. |
| **A2** | `oldest_deferred_age_s` | same | > 7 200 (= 2 h) | sustained | Page | Old deferrals mean the sender cannot drain the backlog. 2 h is 10× the per-attempt backoff. |
| **A3** | 24-hour dead-rate (approximation of §10.6.1's 1-hour wording — see note below) | `dead_24h / (sent_24h + dead_24h)` from the same log line; treat a zero denominator as "no attempts, no alert" rather than divide-by-zero | > 10 % | rolling 24 h | Page | Rising dead-rate is a reputation signal, often preceded by complaints via the P9-2 ingestion. |
| **A4** | `now() − last_heartbeat_at` AND `pending_due > 0` | `app.notification_send_health()` row | heartbeat > 5 min while backlog is non-zero | — | Page | A silent worker holding a backlog means mail is not going out. |
| **A5** | `resolved_ambiguous_this_tick` | per-minute health log line | > 0 | 3 consecutive minutes | Ticket | Sporadic non-zero is normal (restarts, transient AWS outages). Sustained non-zero means the worker is crashing mid-flight repeatedly — a deployment issue. |

**A3 — scope note (keep visible to on-call).** §10.6.1 of the decision
record phrases this threshold as "dead exceeding 10 % of attempts in
**an hour**". The health log line exposes only 24-hour counts
(`sent_24h`, `dead_24h`, `skipped_24h`); the per-minute line itself
cannot produce a true rolling 1-hour attempt count. A3 above is
therefore the honest 24-hour approximation, and it **does not** satisfy
the decision record's 1-hour wording — the two differ in how quickly a
short dead-rate burst becomes visible. A faithful 1-hour alert needs
either (a) a time-series store deriving the 1-hour rate from the
per-minute line, or (b) an added 1-hour counter in
`app.notification_send_health()`; both are out of scope for P9-5.
`skipped_24h` is deliberately **excluded** from the denominator because
a `skipped` row (address_suppressed, address_limited,
community_backlog_full, community_deferred, provider_daily_limited,
provider_rate_limited) made no provider attempt and is not an "attempt"
in §10.6.1's sense.

**Dashboard pins** (not alerts): `email_sending_enabled`, `pending_total`,
`pending_due`, `sent_24h`, `dead_24h`, `skipped_24h`, `dead_by_code`,
`skipped_by_code`, `l4_last_24h_by_class.transactional`,
`l5_last_second_by_class.transactional`. These let an operator read the
pause-switch state and the day's shape at a glance.

**Response notes:**

- A1 / A2 — do **not** raise L4 or L5 as a workaround. See the
  sender-quota runbook §4. Investigate deliverability first.
- A3 — check SES's own event stream (via `email_delivery_events` and
  `email_suppressions`) for a complaint spike. Lower sending or pause
  before touching domain reputation.
- A4 — the §5 rollout order applies in reverse: stop the stuck worker,
  investigate, start a replacement.
- A5 — pull the worker's recent `stderr` lines; look for provider error
  codes and crash-origin lines. A sustained A5 is a bug to fix, not a
  threshold to raise.

## 5. Staging / production rollout order (worker restart)

> **Precondition — this sequence is not authorisation to send email.**
> It applies only in an environment where sending has already been
> authorised: the §6 pre-first-start checklist is signed off, the
> SES-sender runbook §7 (Q-CONFIRM) checklist is complete, dated and
> signed, and every P9-4 §3.9 operator release gate is met in writing
> (D-PROVIDER, D-DOMAIN, D-LEGAL, D-CONSENT, D-WORKER, Q-CONFIRM, AWS
> production access, IAM, monitoring routing). Running step 5 below in
> an environment that has not passed those gates is a policy violation,
> not a procedure. Nothing in this runbook flips the pause switch on
> its own.

When replacing the worker in a live, **already-authorised** environment
(deploy, container image change, env update):

1. **Pause.** `select app.set_email_sending_enabled(false);` from the
   owner connection. The next tick (≤ 2 s) stops claiming. Deliveries
   wait and age out at 72 h.
2. **Stop the old worker.** Platform-specific — the stop signal must be
   `SIGTERM`, the drain budget must be ≥ 90 s. The hard-kill upper
   bound is the recovery for anything that overruns.
3. **Deploy the new worker.** Wait for the first
   `notification_send_health` log line (one per minute).
4. **Confirm it is alive.** The log line must show
   `email_sending_enabled: false` (pause still on from step 1) and a
   fresh `last_heartbeat_at` within the last minute.
5. **Resume.** `select app.set_email_sending_enabled(true);` from the
   owner connection. Only reached when the preconditions in the preamble
   above are already satisfied; this step is not itself authorisation.
6. **Confirm it is sending.** The next log line should show
   `last_claim_at` moving forward (if there is backlog) or at least a
   fresh heartbeat (if the queue is empty). `l5_last_second_by_class.transactional`
   and `l4_last_24h_by_class.transactional` tick as sends happen.

If step 5 reveals a problem, go straight back to step 1 — the pause
switch is the emergency control, not a limit edit (see decision record
§10.6.1).

## 6. Pre-first-start checklist (every environment)

Before starting the worker in a new environment for the first time:

- [ ] `KOLEKTO_ENV` set to the target.
- [ ] `NEXT_PUBLIC_SUPABASE_URL` matches the project.
- [ ] `SUPABASE_DB_URL` reaches the project's Postgres and the role has
      the `app.*` grants the worker uses (`app.email_sending_enabled`,
      `app.record_sender_heartbeat`,
      `app.expire_stale_notification_deliveries`,
      `app.notification_send_health`,
      `app.recover_expired_notification_lease`,
      `app.resolve_lease_ambiguous`, `app.reserve_email_attempt`,
      `app.notification_send_limits`).
- [ ] Platform configuration says one replica.
- [ ] Platform stop signal is SIGTERM; drain budget ≥ 90 s.
- [ ] Platform restart policy matches §3.5.
- [ ] Log collector receives both stdout and stderr; retention ≥ 30
      days.
- [ ] Alerts A1–A5 are wired and tested in a non-production environment
      (fire a synthetic value to each).
- [ ] `app.email_sending_enabled()` returns `false`.
- [ ] First `notification_send_health` log line appears within 2 min of
      process start and shows `email_sending_enabled: false`,
      `pending_total: 0`, `last_heartbeat_at` within 1 min.

Only then run the SES-sender runbook's §7 Q-CONFIRM checklist and —
after every line is checked in writing, dated and signed — flip the
pause switch on.

## 7. Rollback

- **Immediate stop of sending.** `app.set_email_sending_enabled(false)`
  from the owner connection. One tick to effect. Queued rows preserve
  themselves; the 72-hour expiry still runs.
- **Immediate stop of the process.** Send `SIGTERM` to the worker.
  Hard kill after the drain budget if required; the ambiguous-recovery
  path turns in-flight sends into `dead/outcome_unknown` on the next
  worker's maintenance tick.
- **Reverting a bad L4 / L5 change.** See the sender-quota runbook §5.
  Apply the reverting migration to staging first; apply to production;
  restart the worker so `GetAccount` reconciliation picks up the new
  numbers (see SES-sender runbook §5).
- **Reverting a worker code change.** Standard rollback for the chosen
  platform. Follow §5 in reverse order.

## 8. What this runbook does NOT cover

- The AWS SES setup (sending identity, Configuration Set, IAM, domain
  verification, production access) — see
  `docs/runbooks/ses-sender-operator-setup.md`.
- The SNS webhook ingestion — see
  `docs/runbooks/ses-sns-webhook-operator-setup.md`.
- The L4 / L5 numbers themselves — see
  `docs/runbooks/sender-quota-operator-guide.md`.
- Bounce / complaint handling policy — see decision record §10.4 and
  §10.6.4.
- The deployment-artefact itself (Dockerfile, systemd unit, container
  manifest) — follow-up slice after the operator picks a platform.
