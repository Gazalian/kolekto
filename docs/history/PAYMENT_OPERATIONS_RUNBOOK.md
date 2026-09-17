# Payment Operations Runbook

**Audience:** support and operations. No SQL knowledge required for anything in
§1–§5. Engineering escalation criteria are in §6.

**One sentence:** every payment Paystack captures is recorded in the ledger
before any business rule runs, so a payment can be *stuck* but never *lost* —
your job is to move stuck payments to `completed`, never to find missing ones.

---

## 1. Inbox states — what each one means

| State | Meaning | Money captured? | Your action |
|---|---|---|---|
| `initialized` | Checkout started; contributor hasn't paid yet | No | None — normal |
| `pending_capture` | Sent to Paystack, outcome not yet known (<5 min) | Not yet | None — wait |
| `captured` | **Paystack has the money**; processing not finished | **YES** | Watch. Should self-clear within minutes |
| `processing` | Contribution creation in flight | **YES** | None unless >1h |
| `completed` | Contribution + wallet recorded on the first pass | **YES** | None — done |
| `reconciled` | Same as completed, but required a retry/recovery | **YES** | None — done |
| `needs_review` | **Captured, but a business rule refused it** | **YES** | **Act — see §3** |
| `reconciling` | A replay is currently running | **YES** | Wait, then re-check |
| `failed` | Paystack confirms no money ever existed (abandoned checkout) | **No** | None — normal, most common |

`failed` is by far the most common non-success state and is **not** a problem:
it means the contributor started a checkout and never paid.

## 2. Priorities

| Priority | Meaning | Response |
|---|---|---|
| **P1** | Money captured, no contribution recorded | Same day |
| **P2** | Processing/reconciling stuck over an hour | Same day |
| `ok` | Nothing to do | — |

**P1 should normally be zero.** Any P1 row is a real contributor who paid and
cannot see their payment.

## 3. Recovering a payment (no SQL, ever)

1. Open **Admin → Payment Monitoring**.
2. Search the Paystack reference (or the contributor's email).
3. Read **Failure reason**. Common ones:
   - `amount_mismatch` — charged amount ≠ expected tier price
   - `tier_sold_out` / `collection_full` — capacity ran out between checkout and verification
   - `invalid_selected_tier` — the tier was edited or removed after checkout
   - `collection_not_found` — the collection was deleted after payment
   - `missing_collection_id` — checkout metadata was lost; needs an override
4. Click **Retry**. This replays the *normal* payment pipeline — contribution,
   contributor code, wallet, receipt, notification. It is safe to click more
   than once: a payment can only ever produce one contribution.
5. Re-check the state. It should become `completed` or `reconciled`.

**If Retry doesn't clear it:** the underlying business condition is still true
(the tier is still sold out, the collection is still deleted). Fix the cause —
reopen capacity, restore the collection — then Retry again.

**`missing_collection_id`:** use **Reconcile** and supply the correct
collection id. Confirm it out-of-band first (ask the organizer), because this
bypasses the normal metadata trail and is logged loudly.

## 4. How retries work automatically

- A sweep runs **every 5 minutes** and retries anything captured but not
  completed.
- Retries back off exponentially: 5 min → 10 → 20 → … capped at **6 hours**.
- **Captured payments are retried forever.** They are never abandoned.
- Only never-captured references (abandoned checkouts) stop being retried.

So a captured payment left alone will keep trying on its own. Manual Retry is
for when you want it fixed *now*, or when the cause needs a human.

## 5. Checklists

### Daily (2 minutes)
1. Payment Monitoring → filter **Needs Review**. Should be empty.
2. Any P1 older than 15 minutes → work it per §3.
3. Spot-check that today's payment count looks normal for the day of week.

### Weekly (10 minutes)
1. Run the invariant check (or ask engineering to):
   `SELECT * FROM v_payment_invariants ORDER BY violations DESC;`
   Every **P1 invariant must read 0**.
2. Review `payments_stuck_needs_review` — anything sitting over 24h needs a
   decision (refund, manual credit, or fix the cause).
3. Confirm the 5-minute sweep is alive: `stale_retry_queue` should be 0.
4. Confirm `wallet_drift` hasn't grown.

### Emergency — "a contributor says they paid and it's not showing"
1. Get the Paystack reference (on their receipt/bank narration).
2. Search it in Payment Monitoring.
   - **Found, `completed`/`reconciled`** → it worked; check the collection view.
   - **Found, `needs_review`** → §3.
   - **Found, `failed`** → Paystack says the payment never completed. Ask them
     to confirm the debit; if they were genuinely debited, escalate — this is
     the one case that contradicts Paystack.
   - **Not found at all** → escalate immediately (§6). This should be
     impossible; it means a payment bypassed the ledger.
3. Never edit the database directly. Always use Retry/Reconcile.

## 5b. The retry sweep — how it is invoked, and its one failure mode

**Verified in production 2026-08-07 — do not assume otherwise.**

The 5-minute sweep is **an HTTP call over the public internet**, not an
in-database job:

```
pg_cron job 5  (*/5 * * * *)
  └─ net.http_post( https://<project>.supabase.co/functions/v1/scheduled-payment-recovery )
       headers: Content-Type, X-Cron-Secret
```

Because `verify_jwt = false`, the endpoint is reachable by anyone who knows
the URL. `CRON_SECRET` is what protects it. The caller supplies it **inside
the pg_cron job's own command**, as the `X-Cron-Secret` header.

### ⚠️ The failure mode that has already bitten us

If `CRON_SECRET` is set on the function but the cron job does **not** send the
matching header, every sweep returns **401 and does nothing** — and this is
*silent*, because a sweep with zero candidates writes no log rows either way.
It happened on 2026-08-07 between 09:16 and 09:55 UTC: seven consecutive
failed runs, visible only in `net._http_response`.

### Checking the sweep is alive (do this weekly)

```sql
SELECT status_code, left(content,60) AS body, created
FROM net._http_response ORDER BY created DESC LIMIT 6;
```
Expect `200 {"candidates":0,...}` every 5 minutes. **Any 401 means the sweep
is down.**

### Rotating CRON_SECRET safely (order matters)

1. Update the pg_cron job command **first** with the new value:
   ```sql
   SELECT cron.alter_job(job_id := 5, command := $cmd$
     select net.http_post(
       url:='https://<project>.supabase.co/functions/v1/scheduled-payment-recovery',
       headers:=jsonb_build_object('Content-Type','application/json',
                                   'X-Cron-Secret','<NEW>'),
       body:='{}'::jsonb, timeout_milliseconds:=20000);
   $cmd$);
   ```
2. Then set the function secret: `supabase secrets set CRON_SECRET=<NEW> --project-ref <ref>`
3. Verify all three cases:
   - no header → **401**
   - wrong header → **401**
   - correct header → **200**
4. Confirm the next real cron tick returns 200 in `net._http_response`.

Never set the secret without updating the cron job in the same change.

---

## 6. When to escalate to engineering

Escalate if any of these are true:

- A P1 invariant is non-zero (`orphaned_capture`,
  `captured_without_contribution`, `contribution_without_ledger`,
  `duplicate_reference`).
- A reference genuinely does not appear in the inbox at all.
- Retry fails repeatedly with the same error and the underlying cause is
  already fixed.
- `captured_without_collection` is non-zero and the organizer cannot be
  identified.
- Two contributions appear for one reference (should be structurally
  impossible — there is a database constraint preventing it).
- `stale_retry_queue` is non-zero (the 5-minute sweep may be down).

**Do not escalate for:** `failed` payments, abandoned checkouts, or a
`needs_review` whose cause is a business condition you can fix yourself.

---

## Appendix — engineering-only commands

```bash
npm test                        # backend + payment parity (292 tests)
npm run test:payment-parity     # init/verify pricing parity
npm run verify:edge-parity      # git vs production byte-diff, 6 functions
psql "$SUPABASE_DB_URL" -f database/payment_capture_guarantee_tests.sql
psql "$SUPABASE_DB_URL" -f database/payment_fault_injection_tests.sql
```

```sql
-- Is any customer money invisible right now?  (must be 0)
SELECT count(*) FROM v_payment_inbox WHERE priority='P1';

-- All invariants
SELECT * FROM v_payment_invariants ORDER BY (severity='P1') DESC, violations DESC;

-- Everything needing attention
SELECT reference, inbox_state, priority, captured_amount, failure_reason,
       retry_count, next_retry_at, contributor_email
FROM v_payment_inbox
WHERE inbox_state NOT IN ('completed','failed')
ORDER BY created_at DESC;
```
