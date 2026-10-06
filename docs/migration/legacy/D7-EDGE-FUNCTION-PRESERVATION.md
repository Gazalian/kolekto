# D7 — legacy production Edge Function preservation

**Date:** 2026-09-27 · **Gate:** D7 · **Scope:** read-only comparison only

**Nothing was deployed, updated, or deleted.** Every command used was a read: `supabase
functions list` (metadata) and `supabase functions download --use-api` (unbundles the
already-deployed source server-side; issues no deploy). Function versions were re-listed
at the end of this exercise and are identical to the start — see §I.

## A. Executive summary

**All 13 expected functions are deployed, and the inventory matches the preservation
plan's list exactly — no differences.**

**The three financially critical functions are unregressed.** `initiate-paystack-payment`
and `verify-paystack-payment` are **byte-identical** to git `main`, and `verify-paystack-payment`
still carries the id-first `matchTier` fix from the 2026-08-06 tier-collision incident,
confirmed present and unchanged across five subsequent deploys (v35 → v40). No new
divergence exists in any payment-movement, verification, or recovery function.

**Two non-financial functions have drifted, in ways worth recording exactly because they
show git is not a trustworthy record of what legacy production actually runs:**

- `update-collection-status` is deployed **without** a KYC gate that git has held since
  2026-08-05. The deployed function is **older** than git here — a real gap, but in
  publish-eligibility, not in money movement.
- `zepto-debug` is deployed as generic, unrelated Supabase quickstart boilerplate, while
  git documents it as a decommissioned, inert `410` stub. **The two have never matched** —
  the decommission commit post-dates the last real deploy by five weeks and was, on this
  evidence, never shipped.

Downloaded comparison material lives entirely outside the application source tree, at
`Kolekto-Preservation/2026-09-27-edge-functions-busfgcmbndleljklrcbd/`. No secret value
appears anywhere in this report or in that directory's content as inspected.

**Final classification: PASS WITH EXCEPTIONS.** See §J.

## B. Deployed function inventory

Retrieved via `supabase functions list --project-ref busfgcmbndleljklrcbd -o json` — a
read-only metadata call.

| Slug | Version | `verify_jwt` | Created (UTC) | Last updated (UTC) |
|---|---|---|---|---|
| `rapid-service` | 9 | false | 2025-10-21T02:08:43.793Z | 2026-08-07T08:07:36.111Z |
| `create-collection` | 10 | false | 2026-06-16T21:28:27.289Z | 2026-08-07T08:07:40.014Z |
| `update-collection` | 11 | false | 2026-06-16T21:28:34.107Z | 2026-08-05T21:52:13.030Z |
| `update-collection-status` | 8 | false | 2026-06-16T21:28:42.485Z | 2026-08-05T21:52:35.498Z |
| `initiate-paystack-payment` | 17 | false | 2026-06-16T21:28:49.856Z | 2026-08-06T13:47:54.388Z |
| `verify-paystack-payment` | 40 | false | 2026-06-16T21:28:58.213Z | 2026-08-07T08:07:32.341Z |
| `get-all-fundraising-campaigns` | 8 | true | 2026-06-16T21:29:03.346Z | 2026-08-05T21:55:09.376Z |
| `get-fundraising-campaign-by-id` | 8 | true | 2026-06-16T21:29:09.986Z | 2026-08-05T21:55:37.991Z |
| `profile-update` | 8 | true | 2026-06-16T21:29:15.950Z | 2026-07-03T17:46:02.236Z |
| `change-password` | 7 | true | 2026-06-16T21:29:23.698Z | 2026-06-16T21:29:23.698Z |
| `zepto-debug` | 5 | true | 2026-06-27T23:16:22.426Z | 2026-06-27T23:16:22.426Z |
| `delete-collection` | 8 | false | 2026-06-29T12:41:37.920Z | 2026-08-05T21:53:19.929Z |
| `scheduled-payment-recovery` | 11 | false | 2026-06-30T17:37:32.316Z | 2026-08-07T09:59:19.746Z |

**13 functions, all `status: ACTIVE`.**

### Comparison against the preservation plan's expected list

The plan listed 13 slugs. **The deployed inventory matches it exactly — 13 of 13, no
additions, no omissions, no name differences.** No correction to the plan is needed.

## C. Git source inventory

Legacy Git repository: `kolekto-fe-old`, checked out at `HEAD` = `31b790c` on branch
`ghazali/fix-with-claude`, which is even with `origin/main` for every path under
`supabase/functions/` (`git diff --stat origin/main HEAD -- supabase/functions` → empty).
This checkout is authoritative for the comparison.

| Slug | Git path | Last commit | Commit date | Message |
|---|---|---|---|---|
| `rapid-service` | `supabase/functions/rapid-service/` | `edfe80d` | 2026-08-07 09:50:44 +01:00 | *(short message)* |
| `create-collection` | `supabase/functions/create-collection/` | `84bce4b` | 2026-08-05 10:01:15 +01:00 | the email fix and updates |
| `update-collection` | `supabase/functions/update-collection/` | `84bce4b` | 2026-08-05 10:01:15 +01:00 | the email fix and updates |
| `update-collection-status` | `supabase/functions/update-collection-status/` | `84bce4b` | 2026-08-05 10:01:15 +01:00 | the email fix and updates |
| `initiate-paystack-payment` | `supabase/functions/initiate-paystack-payment/` | `0ca5d12` | 2026-08-06 15:07:55 +01:00 | fix(payment): restore tier matching and prevent amount drift |
| `verify-paystack-payment` | `supabase/functions/verify-paystack-payment/` | `edfe80d` | 2026-08-07 09:50:44 +01:00 | *(short message)* |
| `get-all-fundraising-campaigns` | `supabase/functions/get-all-fundraising-campaigns/` | `84bce4b` | 2026-08-05 10:01:15 +01:00 | the email fix and updates |
| `get-fundraising-campaign-by-id` | `supabase/functions/get-fundraising-campaign-by-id/` | `84bce4b` | 2026-08-05 10:01:15 +01:00 | the email fix and updates |
| `profile-update` | `supabase/functions/profile-update/` | `270286a` | 2026-07-10 11:39:53 +01:00 | fix: kyc-error |
| `change-password` | `supabase/functions/change-password/` | `84bce4b` | 2026-08-05 10:01:15 +01:00 | the email fix and updates |
| `zepto-debug` | `supabase/functions/zepto-debug/` | `84bce4b` | 2026-08-05 10:01:15 +01:00 | the email fix and updates |
| `delete-collection` | `supabase/functions/delete-collection/` | `84bce4b` | 2026-08-05 10:01:15 +01:00 | the email fix and updates |
| `scheduled-payment-recovery` | `supabase/functions/scheduled-payment-recovery/` | `31b790c` | 2026-08-07 15:10:44 +01:00 | kyc issue |

Two other paths exist under `supabase/functions/` that are **not deployed functions**:
`_shared/featureAccess.ts` (shared helper, imported by other functions, not itself a slug)
and two dated forensic snapshots — `verify-paystack-payment.pre-download-2026-08-06/` and
`verify-paystack-payment.stale-backup-2026-08-06/` — captured during the original
tier-collision incident investigation (see §F.3). Both are preserved evidence, not
candidates for deployment.

## D. Function-by-function comparison

Deployed source was obtained with `supabase functions download <slug> --project-ref
busfgcmbndleljklrcbd --use-api --workdir <preservation-dir>` for every one of the 13
slugs, then diffed file-by-file against the Git path above with `diff -u
--strip-trailing-cr` (git's line endings are CRLF; the CLI's unbundled download is LF —
this is stripped before any comparison, so it never registers as a difference).

| Function | Deployed version | Git source | Git commit | Status | Financial relevance | Difference summary |
|---|---|---|---|---|---|---|
| `rapid-service` | 9 | matches | `edfe80d` | **MATCH** | Settlement (dormant fallback) | Byte-identical |
| `create-collection` | 10 | matches | `84bce4b` | **MATCH** | Wallet creation | Byte-identical |
| `update-collection` | 11 | matches | `84bce4b` | **MATCH** | Low | Byte-identical |
| `update-collection-status` | 8 | matches | `84bce4b` | **DIFFERENT** (deployed older) | Low — indirect (publish gate) | Deployed is missing a KYC-gate block present in git — see §E.1 |
| `initiate-paystack-payment` | 17 | matches | `0ca5d12` | **MATCH** | **HIGH — payment initialization** | `index.ts` byte-identical; git also holds a Node test file (`index.audit.test.ts`) that is correctly not part of the deployed bundle |
| `verify-paystack-payment` | 40 | matches | `edfe80d` | **MATCH** | **HIGH — payment verification** | All 3 files byte-identical; tier-collision fix confirmed present — see §F.4 |
| `get-all-fundraising-campaigns` | 8 | matches | `84bce4b` | **MATCH** | Low — display only | Byte-identical |
| `get-fundraising-campaign-by-id` | 8 | matches | `84bce4b` | **MATCH** | Low — display only | Byte-identical |
| `profile-update` | 8 | matches | `270286a` | **MATCH** | None | Byte-identical (CRLF-only apparent diff) |
| `change-password` | 7 | matches | `84bce4b` | **MATCH** | None | Byte-identical (CRLF-only apparent diff) |
| `zepto-debug` | 5 | matches | `84bce4b` | **DIFFERENT** | None (inert either way) | Deployed runs unrelated boilerplate; git holds a decommission stub that was never shipped — see §E.2 |
| `delete-collection` | 8 | matches | `84bce4b` | **MATCH** | Medium — cascading delete | Byte-identical |
| `scheduled-payment-recovery` | 11 | matches | `31b790c` | **MATCH** | **HIGH — payment recovery** | Byte-identical (CRLF-only apparent diff) |

**11 of 13 MATCH. 2 of 13 DIFFERENT. 0 MISSING_LOCALLY, 0 MISSING_DEPLOYED,
0 UNABLE_TO_COMPARE, 0 DEPLOYED_NEWER, 0 GIT_NEWER** as a clean single-word verdict — both
differences are mixed (see below), which is why they are classified DIFFERENT rather than
one of the directional labels.

**A methodological note on `raw diff -rq` before line-ending normalization:** a first pass
without `--strip-trailing-cr` reported 5 of 13 as differing (`update-collection-status`,
`initiate-paystack-payment`, `profile-update`, `change-password`, `scheduled-payment-recovery`).
Re-running with line endings normalized collapsed 3 of those (`profile-update`,
`change-password`, `scheduled-payment-recovery`) to byte-for-byte matches and left
`initiate-paystack-payment`'s only difference as the test file's presence in git and
absence from the deployed bundle — expected, not a real divergence. **Comparing actual
source, not raw diff output, is why 11 read as MATCH rather than 8.**

## E. Sanitized diffs for every mismatch

Two functions differ after line-ending normalization. Both diffs below were scanned for
API keys, secret keys, JWTs, passwords, connection strings and env values before inclusion
— none found. Environment variable **names** are unaffected by this rule and appear where
relevant.

### E.1 `update-collection-status` — deployed is missing a KYC gate that git has

```diff
--- git (kolekto-fe-old, commit 84bce4b)
+++ deployed (legacy production, v8)
@@ -1,10 +1,5 @@
 import "jsr:@supabase/functions-js/edge-runtime.d.ts";
 import { createClient } from "jsr:@supabase/supabase-js@2";
-import {
-  canPublishCollection,
-  kycRequiredBody,
-  loadAccessContext,
-} from "../_shared/featureAccess.ts";
@@ -72,7 +67,7 @@
     const { data: existing, error: fetchError } = await supabase
       .from("collections")
-      .select("id, user_id, status")
+      .select("id, user_id")
       .eq("id", id)
       .single();
@@ -84,38 +79,6 @@
       return json({ error: "Unauthorized: you do not own this collection" }, 403);
     }
-    // KYC gate — publish. This function previously had NO KYC check at all,
-    // which made it a bypass for the creation cap: an unverified user could
-    // soft-delete a collection (dropping their counted total to 0), create a
-    // fresh one, then flip the deleted row back to "active" and end up
-    // holding two live collections. canPublishCollection() closes that ...
-    const accessContext = await loadAccessContext(supabase, userId);
-    const mayPublish = canPublishCollection({
-      ...accessContext,
-      currentStatus: existing.status,
-      targetStatus: status,
-    });
-    if (!mayPublish) {
-      log("collection.status.rejected", { ... reason: "kyc_required" });
-      return json(kycRequiredBody("publish_collection"), 403);
-    }
     const { data: collection, error } = await supabase
       .from("collections")
       .update({ status, updated_at: new Date().toISOString() })
```

**Reading the timestamps:** git commit `84bce4b` lands at 2026-08-05 09:01:15 UTC; the
deployed function's `updated_at` is 2026-08-05T21:52:35.498Z — nearly 13 hours **later**.
If the 21:52 deploy had sourced the then-current git tree, it should carry this block. It
does not. **The most defensible reading is that whatever was deployed at 21:52 did not
come from this commit's checkout** — consistent with the pattern already documented
elsewhere in this codebase of deploys sourced from a stale local copy rather than a fresh
`git` checkout (see the "agent-reconstructed tool payloads" caveat in
`kolekto-fe-old/docs/incident_2026-08-06_verify-tier-collision-payment-loss.md` §8.2, about
a *different* function). This report does not have deploy logs to confirm the mechanism —
only that the result, as it stands today, lacks the gate.

### E.2 `zepto-debug` — deployed is unrelated boilerplate; git's stub was never shipped

```diff
--- git (kolekto-fe-old, commit 84bce4b) — documented as decommissioned
+++ deployed (legacy production, v5)
@@ -1,9 +1,26 @@
-import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
-// Decommissioned diagnostic/preview function (ZeptoMail incident + receipt
-// redesign, 2026-06-27). Safe to delete from the dashboard. Intentionally inert.
-serve(() =>
-  new Response(
-    JSON.stringify({ status: "gone", note: "zepto-debug decommissioned; safe to delete" }),
-    { status: 410, headers: { "Content-Type": "application/json" } },
-  )
-);
+import "jsr:@supabase/functions-js/edge-runtime.d.ts";
+import { withSupabase } from "jsr:@supabase/server@^1";
+interface ReqPayload { name: string; }
+export default {
+  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, ctx) => {
+    const { name }: ReqPayload = await req.json();
+    // [comment retained from the deployed source, illustrative role label only,
+    //  not a captured credential]: using the secret-role auth mode bypasses RLS
+    if (ctx.authMode === "secret") {
+      return Response.json({ message: `Hello ${name} admin!` });
+    }
+    return Response.json({ message: `Hello ${name}!` });
+  }),
+};
```

**Chronology is the finding here.** The deployed function's `created_at` and `updated_at`
are both `2026-06-27T23:16:22.426Z` — it has not been touched since that single deploy. Git's
"decommissioned, safe to delete" comment was committed in `84bce4b` on **2026-08-05**, five
and a half weeks later. **Git is not describing a decommission that happened — it is
describing one that was written down and never deployed.** What has actually been live
since 2026-06-27 is generic Supabase quickstart scaffold code, not the incident-driven
`410` stub. The function does nothing dangerous as deployed — it echoes a greeting and
branches on which Supabase auth mode called it — but the two records (git, and production)
have never agreed about what this function is.

## F. Financial-function analysis

### F.1 `initiate-paystack-payment` — MATCH

1. **What changed:** nothing. `index.ts` is byte-for-byte identical to git (`sha256
   860dc086c5d8…`, both sides).
2. **Newer/older:** neither — identical.
3. **Affects money movement:** no change, so no effect.
4. **Affects payment verification:** no change.
5. **Affects attribution:** no change.
6. **Affects reconciliation:** no change.
7. **Influence on new architecture:** none from this comparison. The existing
   `docs/adr/0015-subaccount-custody-and-collection-level-ownership.md` decision already
   supersedes this function's design; this confirms the *legacy* behaviour being superseded
   is faithfully preserved, which is what a migration baseline needs.

### F.2 `verify-paystack-payment` — MATCH, and the historical fix is confirmed intact

1. **What changed:** nothing since v35 (2026-08-07). All three files (`index.ts`,
   `_shared1.ts`, `_shared2.ts`) are byte-identical to git across five further deploys
   (v35 → v40).
2. **Newer/older:** neither.
3. **Affects money movement:** no change. The function still refuses to insert a
   contribution on an amount mismatch (`HTTP 400`, no row written) — the same fail-closed
   behaviour that stopped the 2026-08-06 incident from becoming a silent overcharge, and
   the same behaviour that caused the *drop* until the fix shipped.
4. **Affects payment verification:** no change; see §H below — the id-first `matchTier`
   fix is present and unregressed.
5. **Affects attribution:** no change. Tier attribution — which price tier a payment is
   recorded against — is exactly what `matchTier` resolves, and it resolves correctly.
6. **Affects reconciliation:** no change.
7. **Influence on new architecture:** the incident this fix addressed is a durable design
   lesson independent of this specific code: **a tier selector must be resolved by a
   stable identifier first, with display name only as a fallback for records that never
   had one**, and **initiation and verification must resolve the same tier by the same
   rule** or their totals will disagree by construction. The new system should carry this
   as an explicit invariant (ideally enforced by a shared resolver used by both paths, or
   by a database constraint), not as tribal knowledge.

### F.3 `scheduled-payment-recovery` — MATCH

1. **What changed:** nothing; byte-identical after line-ending normalization.
2. **Newer/older:** neither.
3–6. No change, so no effect on money movement, verification, attribution or
   reconciliation.
7. **Influence on new architecture:** unchanged from prior findings — this function is the
   only mechanism that retries a `pending_payment_context` row, and its retry cap
   (`attempt_cap_exceeded`) is a hard stop with no further path back to money without
   manual reconciliation (as documented in the incident's own recovery record, §8.3–8.5,
   where recovery ran through `verify-paystack-payment` itself, never hand-written SQL).
   The new system's settlement design already treats reconciliation as idempotent and
   append-only; this is consistent with that and needs no new action.

### F.4 Other financially relevant functions found

Beyond the three named, three more functions touch money-adjacent state. **All three
MATCH — no drift in any of them:**

| Function | Financial surface | Finding |
|---|---|---|
| `rapid-service` | **Settlement.** A manual/rollback trigger for `process_deposit_settlements()`. Its own header comment records that it is **not** the live settlement path — that is the `settlement-recompute-wallets` pg_cron job calling `settlement_recompute_wallets('cron')` directly in SQL — and that this function exists only as a dormant fallback. | MATCH. Confirms the settlement design already understood: the SQL function, not this Edge Function, is the source of truth. |
| `create-collection` | **Wallet creation.** Upserts a `wallets` row for every new collection — the mechanism behind collection-level financial ownership (one wallet per collection, never a shared community wallet). | MATCH. Confirms the legacy system already enforced one-wallet-per-collection at creation time, consistent with `docs/adr/0015`. |
| `get-all-fundraising-campaigns` | **Display only.** Reads `wallets.net_payment` to show a running total on a public listing endpoint; writes nothing. | MATCH. No financial-logic exposure. |

No function was found touching withdrawal initiation, fee calculation, or a distinct
reconciliation code path beyond what `scheduled-payment-recovery` already covers — those
concerns live in the SQL functions (`process_deposit_settlements`,
`settlement_recompute_wallets`) captured in the D1 schema dump, not in an Edge Function.

## G. Environment variable names referenced (names only — no values anywhere)

Collected via `Deno.env.get("NAME")` across all 13 downloaded sources:

`BACKEND_NOTIFY_SECRET` · `BACKEND_URL` · `CRON_SECRET` · `ENVIRONMENT` · `FRONTEND_URL` ·
`PAYSTACK_SECRET_KEY` · `PUBLIC_CALLBACK_URL` · `RESEND_API_KEY` · `SERVICE_ROLE_KEY` ·
`SITE_URL` · `SUPABASE_ANON_KEY` · `SUPABASE_SERVICE_ROLE_KEY` · `SUPABASE_URL` ·
`ZEPTOMAIL_API_TOKEN`

No value for any of these was read, logged, or printed at any point in this exercise.

## H. Historical check — `verify-paystack-payment` tier-collision regression

Per `kolekto-fe-old/docs/incident_2026-08-06_verify-tier-collision-payment-loss.md`: a
2026-08-06 regression made `matchTier()` resolve `id OR name in one array-order pass`, so a
collection with several tiers sharing a display name collapsed every match to the
array-earliest tier of that name. Five payments (later six) were captured by Paystack and
never recorded — total ₦520,200 across 6 references, fully recovered 2026-08-07 by
redeploying the id-first fix as v35, using the existing idempotent `claim_payment_contributions`
path (no hand-written inserts).

**This exercise independently re-confirms the fix is present in what is deployed today,
five versions later:**

| Check | Result |
|---|---|
| Currently deployed version | v40 (was v35 at the fix; four further deploys since) |
| `_shared1.ts` deployed sha256 | `5fdb5d85c8701d8846bd9e42a7e8242144edcfb520ba1fbf0a1ddd649ff00912` |
| Matches incident doc's recorded post-fix hash (`5fdb5d85c8701d88…`) | **yes** |
| Id-first `matchTier` present in deployed source | **yes** — resolves `tierId` across all tiers first, falls back to `tierName` only if no id match |
| Legacy single-pass `id OR name` pattern present | **no — 0 occurrences** |
| **Deployed vs git**, tier matching / amount verification / transaction verification / payment status / amount-mismatch handling | **identical — all three files byte-for-byte** |

**No regression exists.** The fix has held across five deploys and is what production
runs today, byte-for-byte identical to git `main`.

No fix was attempted, applied, or suggested as part of this task — none was needed, and
none would have been in scope. This is preservation and evidence-gathering only, as
instructed.

## I. Migration implications

1. **The 2026-08-06 root cause is a durable design invariant, not a patched bug.** Any tier
   or price-option resolver in the new system must resolve by stable id first, with name as
   fallback only, and initiation/verification must share one resolution rule. Recommend
   this become an explicit invariant or shared utility, not a convention.
2. **Legacy production and legacy git are not reliably in sync**, independent of anything
   financial — `update-collection-status` and `zepto-debug` both prove it, in opposite
   directions (one missing code git has, one running code git has no record of at all).
   **Do not treat this legacy git repository as ground truth for what legacy production
   currently does.** The D1 database dump and this D7 Edge Function download are the two
   things actually verified against the live system; git is a secondary source here.
3. **`update-collection-status`'s missing KYC gate is a legacy-production integrity gap**,
   not a migration blocker — the new system is being built with its own authorization model
   and does not inherit this code. It is recorded because a founder or engineer reading
   legacy git today would wrongly believe production already has this protection.
4. **Do not copy any of these functions wholesale into the new system** — none of the
   three financially critical functions should be, and this report makes no such
   recommendation, per your instruction. Their value here is as a verified record of
   legacy behaviour and as the source of the tier-resolution invariant above.

## J. Preservation recommendation and final classification

**Preserve, as already done:** the downloaded deployed source now sits at
`Kolekto-Preservation/2026-09-27-edge-functions-busfgcmbndleljklrcbd/`, outside every
application repository, alongside the D1 database backup. Recommend it be included in the
same eventual encryption/second-copy step already pending for the D1 artefact (see the
open item from the secure-preservation inspection) — it is far smaller (source code only)
but belongs under the same custody, since `rapid-service`'s history shows this codebase has
previously lost track of what is actually deployed.

No further Edge Function action is needed for D7. The two documented differences
(`update-collection-status`, `zepto-debug`) require no remediation as part of this task —
they are recorded as findings, not defects to fix here.

# PASS WITH EXCEPTIONS

- **Inventory: exact match, 13 of 13.**
- **Financially critical functions: 3 of 3 MATCH**, including the tier-collision fix
  confirmed unregressed across 5 versions.
- **Referential financial surfaces beyond the named 3 (settlement, wallet creation,
  display): 3 of 3 MATCH.**
- **Exceptions: 2 of 13 non-financial functions differ** — one deployed-older
  (`update-collection-status`, missing a KYC gate git has), one categorically unrelated
  (`zepto-debug`, running boilerplate git has no record of). Neither touches money
  movement, verification, attribution, or reconciliation.
- **Zero secrets exposed. Zero writes to production. Zero deploys.**

---

## Validation

- **No production writes occurred.** Every command issued was `supabase functions list`
  or `supabase functions download --use-api` — both read-only per the CLI's own
  documentation; neither takes a `deploy`, `update`, or `delete` action.
- **No Edge Function deployment occurred.** Function versions were re-listed at the end of
  this exercise: `rapid-service` v9, `create-collection` v10, `update-collection` v11,
  `update-collection-status` v8, `initiate-paystack-payment` v17,
  `verify-paystack-payment` v40, `get-all-fundraising-campaigns` v8,
  `get-fundraising-campaign-by-id` v8, `profile-update` v8, `change-password` v7,
  `zepto-debug` v5, `delete-collection` v8, `scheduled-payment-recovery` v11 — **identical
  to §B, taken before any download began.**
- **No secrets entered this report.** Every diff and excerpt was scanned for
  `sk_live_`/`sk_test_` literals, JWT-shaped strings, PEM headers, and inline credential
  assignments before inclusion; none were found. Only environment variable **names** are
  listed (§G), never values.
- **The new application source was not modified.** All downloaded material was written to
  `Kolekto-Preservation/2026-09-27-edge-functions-busfgcmbndleljklrcbd/`, and the legacy
  Git working tree (`kolekto-fe-old`) was only read, never written.
- **No typecheck/lint was run.** This task produced one Markdown report and no code
  change, so no build tooling applies.

### Files created

| File | Change |
|---|---|
| `docs/migration/legacy/D7-EDGE-FUNCTION-PRESERVATION.md` | **new** — this report |
| `Kolekto-Preservation/2026-09-27-edge-functions-busfgcmbndleljklrcbd/supabase/functions/**` | **new**, outside the repository — 13 downloaded function sources + `_shared/featureAccess.ts`, plus CLI-managed `supabase/.temp/linked-project.json` (contains only the project ref, name and org id — no secret) |

### Git status

Only the new report file is untracked in the `kolekto` repository; nothing else changed:

```
?? docs/migration/legacy/D7-EDGE-FUNCTION-PRESERVATION.md
```

The `kolekto-fe-old` repository (source of the git comparison) shows no changes — it was
read only, never written.

**Not committed, per instruction. Not proceeding to D6 storage, per instruction. Stopping
here.**
