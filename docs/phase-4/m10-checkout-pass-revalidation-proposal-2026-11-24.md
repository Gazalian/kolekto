# M10 — Checkout membership-pass revalidation (proposal, for owner review)

Status: **PROPOSED — not approved for implementation. No migration written or applied; no checkout code changed.**
Date: 2026-11-24 (session 59). Scope approved for: investigation and planning only.
Relates to: `docs/phase-4/non-member-contributions-payment-path-design-2026-11-22.md` §3.3 (the original M10 sketch).

---

## 0. Scope, and how this differs from the 2026-11-22 sketch

The 2026-11-22 design bundled M10 with guest payments (`allow_non_members`), a `member_verification` collection column
(M9c), `payer_basis` / `member_status_at_payment` contribution columns and `complete_payment_capture` changes. None of
that is proposed here:

| In this M10 | Deferred (separate approval) |
|---|---|
| `p_access_token` on `app.create_payment_attempt`; SQL resolves the pass itself and requires it to name the same member as the contributor session | Guest payments (owner: not now) |
| Web: keep the pass cookie until checkout; send the token; map new codes to one generic message | `payer_basis` / `member_status_at_payment` columns |
| Tests for the above | Any `complete_payment_capture` change (capture-time member re-check, limits) |

Reason: A2.5 already removed the anonymous name/phone lookup (D4), so **every managed collection now identifies by
membership ID**. There is no `lookup` path left to keep, so the `member_verification` switch is not needed to make
checkout require a pass.

## 1. What the code does today (read from the files, 2026-11-24)

| Step | Code | Behaviour |
|---|---|---|
| Enter ID | `validateMembershipIdAction` → `startMembershipPass` → `app.validate_membership_id` | On success SQL inserts a `membership_access_grants` row (SHA-256 of a 32-byte random token, `expires_at` = +30 min, hard-capped by the `membership_access_grants_window` check) and returns the raw token once. Server stores it in the signed httpOnly cookie `kolekto_member_pass` (30 min, collection-bound). |
| Confirm | `confirmMembershipPassAction` → `completeMembershipPass` → `app.confirm_membership_pass` | Re-resolves the grant live, writes a masked audit row, returns the member id. Server then sets `kolekto_contributor` (signed, 1 h, `{collectionId, memberId}`) and **clears the pass cookie** (`membership-pass-helpers.ts:79`). |
| Checkout | `submitContributionAction` (`actions.ts:328`) → `startCheckout` (`packages/payments/src/orchestrator.ts:127`) → `createPaymentAttempt` (`packages/db/src/payments.ts:83`) → `app.create_payment_attempt` (`20261111100100_payment_functions.sql:259`) | Member id comes **only** from `readContributorSession` (server-signed cookie, never a browser field), is re-checked with `getCollectionMemberContext`, then `create_payment_attempt` re-checks it with `app.get_collection_member_context`. **No pass is involved**: after confirmation, a valid session cookie alone is enough for up to 1 h. |

Gap M10 closes: the session cookie is a bearer credential with a 1-hour life that outlives the 30-minute pass and is
not re-checked against the membership ID system at the moment money is committed. A revoked/rotated membership ID or a
revoked grant does not stop checkout today (a suspended/archived member does, via `get_collection_member_context`).

## 2. Proposed SQL — exact

New migration `supabase/migrations/20261124100000_m10_checkout_pass_revalidation.sql` (timestamp to be re-picked at
implementation so it sorts after every applied migration; see §10 on the A-1 finalize file).

```sql
-- Signature change: drop the 22-argument function and create the 23-argument one in the same transaction.
-- `create or replace` with a new argument list would leave the old overload callable.
drop function app.create_payment_attempt(
  uuid, text, text, text, uuid, text, text, text, jsonb, text[], jsonb, bigint,
  bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, public.fee_mode, text
);

create function app.create_payment_attempt(
  p_collection_id               uuid,
  p_checkout_key                text,
  p_reference                   text,
  p_provider                    text,
  p_member_id                   uuid,
  p_contributor_name            text,
  p_contributor_email           text,
  p_contributor_phone           text,
  p_answers                     jsonb,
  p_attendee_names              text[],
  p_lines                       jsonb,
  p_open_amount_kobo            bigint,
  p_contribution_kobo           bigint,
  p_platform_fee_kobo           bigint,
  p_gateway_fee_kobo            bigint,
  p_vat_kobo                    bigint,
  p_total_fees_kobo             bigint,
  p_total_payable_kobo          bigint,
  p_net_kobo                    bigint,
  p_provider_cost_estimate_kobo bigint,
  p_fee_bearer                  public.fee_mode,
  p_fee_schedule_version        text,
  p_access_token                text default null      -- M10: the raw membership-pass token, server cookie only
)
returns table (...same...)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  -- ...every existing variable, unchanged...
  v_member_id    uuid;   -- M10: the member as resolved HERE; the only member id written below
begin
  -- ...unchanged down to "Who is paying"...

  if v_collection.audience_mode <> 'public' then
    if p_member_id is null then
      raise exception 'MEMBER_REQUIRED: this collection asks named members' using errcode = 'P0001';
    end if;

    -- M10: serialise with revocation. A concurrent revoke/rotate/suspend updates this row; under READ COMMITTED
    -- the lock waits, re-reads the new version, and the revoked_at filter then excludes it.
    perform 1 from public.membership_access_grants g
     where p_access_token ~ '^[0-9a-f]{64}$'
       and g.token_hash = extensions.digest(p_access_token, 'sha256')
       and g.collection_id = p_collection_id
       and g.revoked_at is null
       for share;

    -- M10: resolve the pass independently. Re-checks expiry, grant revocation, membership ID still live,
    -- member in good standing, member in the audience, collection and community active.
    v_member_id := app.resolve_membership_access_grant(p_collection_id, p_access_token);
    if v_member_id is null then
      raise exception 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection' using errcode = 'P0001';
    end if;
    if v_member_id is distinct from p_member_id then
      raise exception 'MEMBER_PROOF_MISMATCH: the membership pass and the contributor session differ'
        using errcode = 'P0001';                       -- no ids in the message
    end if;

    select * into v_member from app.get_collection_member_context(p_collection_id, v_member_id) limit 1;
    if v_member.member_id is null then
      raise exception 'MEMBER_NOT_ELIGIBLE: member cannot contribute to this collection' using errcode = 'P0001';
    end if;
    if v_member.obligation_id is not null then
      select * into v_obligation from public.obligations where id = v_member.obligation_id;
    end if;
  elsif p_member_id is not null or p_access_token is not null then
    raise exception 'MEMBER_NOT_EXPECTED: an open collection does not identify members' using errcode = 'P0001';
  end if;

  -- ...amount, lines, fees: unchanged...

  -- Three existing uses of p_member_id become v_member_id (null on open collections):
  --   insert into public.contribution_intents (..., member_id, ...) values (..., v_member_id, ...)
  --   idempotency check: or v_attempt.member_id is distinct from v_member_id
  --   insert into public.payment_attempts (..., member_id, ...) values (..., v_member_id, ...)
end;
$$;

-- Functions are EXECUTE-able by PUBLIC on creation; the new signature must be locked down again.
revoke execute on function app.create_payment_attempt(
  uuid, text, text, text, uuid, text, text, text, jsonb, text[], jsonb, bigint,
  bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, public.fee_mode, text, text
) from public, anon, authenticated;

comment on function app.create_payment_attempt(/* 23-arg signature */) is
  '...existing comment... M10: on a managed collection the member is re-resolved from the membership pass
   (p_access_token) and must equal p_member_id (the contributor session); the resolved id is the only one written.';

-- Table comment that is now out of date:
comment on table public.membership_access_grants is
  'F6.2: a 30-minute pass for one member on one collection, made by a successful membership ID check. The raw token
   is returned once and never stored (SHA-256 only). Consumed by app.confirm_membership_pass and, since M10, required
   by app.create_payment_attempt on managed collections.';
```

The MEMBER_NOT_ELIGIBLE message also drops the ids it carries today. The web never shows database messages, but the
message reaches server logs. Nothing else in the body changes; the full body is copied from `20261111100100` with
only the lines above edited, and a `diff` of old vs new body is part of review.

## 3. How the pass is resolved independently

`create_payment_attempt` calls `app.resolve_membership_access_grant(collection, token)` itself, inside the same
transaction that share-locks the collection and writes the attempt. It does not trust the confirm step, the session
cookie, `getCollectionMemberContext` in the action, or any value from the browser. The token is matched by SHA-256
against `membership_access_grants.token_hash`; the raw token is never stored or logged.

## 4. Same member, same collection

- **Collection:** the grant row is bound to `collection_id` and the resolver filters `g.collection_id = p_collection_id`.
  A pass from collection A resolves to null on collection B → `MEMBER_PROOF_EXPIRED`. The web layer also binds both
  cookies to the collection id (`readMembershipPass(collectionId)`, `readContributorSession(collectionId)`).
- **Member:** resolver result must equal `p_member_id` (from the session cookie). Different → `MEMBER_PROOF_MISMATCH`.
- **What is written:** `v_member_id` (the pass's member) is written to the intent and attempt. `p_member_id` is used
  only for the equality check, so even a forged session member cannot become the attributed member.

## 5. Rejections

| Pass state | Caught by | Code |
|---|---|---|
| Missing / malformed token | regex in resolver | `MEMBER_PROOF_EXPIRED` |
| Unknown token | hash lookup | `MEMBER_PROOF_EXPIRED` |
| Expired (> 30 min) | `g.expires_at > now()` | `MEMBER_PROOF_EXPIRED` |
| Grant revoked (rotate / revoke / suspend revoke grants) | `g.revoked_at is null` + `for share` lock | `MEMBER_PROOF_EXPIRED` |
| Membership ID revoked | `mi.revoked_at is null` | `MEMBER_PROOF_EXPIRED` |
| Member suspended / archived / merged | `app.member_in_good_standing(m.status)` | `MEMBER_PROOF_EXPIRED` |
| Member no longer in the audience | `resolve_collection_audience` | `MEMBER_PROOF_EXPIRED` |
| Other collection's pass | `g.collection_id = p_collection_id` | `MEMBER_PROOF_EXPIRED` |
| Valid pass, different session member | equality check | `MEMBER_PROOF_MISMATCH` |
| Token on an open collection | `elsif` branch | `MEMBER_NOT_EXPECTED` |

Web mapping: `MEMBER_PROOF_EXPIRED` and `MEMBER_PROOF_MISMATCH` both show one generic message ("Your identification has
expired. Enter your membership ID again."), clear **both** cookies, and send the form back to Screen 1. Mismatch is also
logged server-side as `{msg:"checkout_member_proof_mismatch", collectionId}` (no member ids, no token), because it
should never happen in normal use.

## 6. Public collections and other flows

- `audience_mode = 'public'`: the managed branch is skipped. `p_access_token` defaults to null and the web never sends
  one (no pass can exist: `validate_membership_id` refuses public collections). Behaviour identical to today, except a
  stray token is now refused like a stray member id already is.
- Seeded/officer flows that do not go through `create_payment_attempt` (manual records, imports) are untouched.
- `confirmPayment`, callback, webhook, `complete_payment_capture`, sweep, settlement, withdrawals, transfers, ledger,
  reconciliation: **not modified.** They read `payment_attempts.member_id`, which is now the pass-resolved id.

## 7. Append-only and ledger invariants

The migration creates no table, column, trigger or index, and updates or deletes no row. `contributions`,
`ledger_entries` and the other append-only tables are written only by capture, which is unchanged. An attempt
created before M10 keeps its member id and captures exactly as before (capture does not look at passes). Grants are
**not** consumed or revoked by checkout (a retry with the same checkout key, or `provider_unavailable` → "press Pay
again", must still resolve), so checkout writes nothing new to `membership_access_grants`.
`03_money_invariants.sql` must pass unchanged.

## 8. Files and functions to change

| File | Change |
|---|---|
| `supabase/migrations/20261124100000_m10_checkout_pass_revalidation.sql` (new) | §2 |
| `packages/db/src/payments.ts` | `CreatePaymentAttemptInput.accessToken: string \| null`; pass `${input.accessToken}` as the 23rd argument |
| `packages/payments/src/orchestrator.ts` | `StartCheckoutInput.accessToken: string \| null`; forward to `createPaymentAttempt`. No other change. |
| `apps/web/lib/membership-pass-helpers.ts` | `completeMembershipPass`: **stop clearing** the pass cookie on confirm (it lives until checkout or its 30 min) |
| `apps/web/app/[communitySlug]/[collectionSlug]/actions.ts` | `submitContributionAction`: on managed collections read `readMembershipPass(collectionId)`; if missing, clear the session and return the generic message with `reidentify: true`; pass `accessToken` to `startCheckout`. Add `MEMBER_PROOF_EXPIRED` / `MEMBER_PROOF_MISMATCH` to `CHECKOUT_ERROR_MESSAGES` (same text). Also correct the stale `MEMBER_REQUIRED` text ("Find yourself on the list…") to the membership-ID wording. |
| `ContributeForm.tsx` / `FindYourself.tsx` | On `reidentify: true`, return to Screen 1 (input empty). |
| Worker test fixtures: `apps/worker/test/integration/payments-orchestrator.integration.test.ts`, `apps/worker/test/sandbox/paystack-sandbox.ts` | Mint a grant for managed flows and pass `accessToken` (sandbox is never run in this phase) |

Not changed: `contributor-session.ts`, `membership-pass.ts`, `confirm_membership_pass`, `resolve_membership_access_grant`,
capture, settlement, withdrawals, transfers, ledger and reconciliation.

**Browser-supplied fields cannot override attribution:** `submitContributionAction`'s input has no member or token
field, and the action never reads one. A server action receives any JSON, so an extra `memberId` / `accessToken` key
is simply ignored. The token comes only from the signed httpOnly pass cookie, and the member only from the signed
session cookie. SQL then writes only the member the token resolves to. A unit test covers this (§9).

## 9. Tests

**Database (new `supabase/tests/78_checkout_pass_revalidation.sql`, itest):**
1. Managed collection, valid pass + matching `p_member_id` → attempt created; `payment_attempts.member_id` and
   `contribution_intents.member_id` = pass member.
2. Null token → `MEMBER_PROOF_EXPIRED`. Malformed token → same.
3. Expired grant (insert with `expires_at` in the past within the window constraint) → `MEMBER_PROOF_EXPIRED`.
4. `revoke_membership_id`, `rotate_membership_id`, `suspend_member` after the pass was issued → `MEMBER_PROOF_EXPIRED` each.
5. Member archived; member removed from the group audience → `MEMBER_PROOF_EXPIRED`.
6. Pass for collection A used on collection B (same member) → `MEMBER_PROOF_EXPIRED`.
7. Pass for member X, `p_member_id` = member Y (both eligible) → `MEMBER_PROOF_MISMATCH`; no intent or attempt row written.
8. Open collection: null/null → unchanged; token set → `MEMBER_NOT_EXPECTED`.
9. Idempotency: same checkout key + same pass → `reused = true`, same attempt; same key with a different member's
   pass → `MEMBER_PROOF_MISMATCH` (or `CHECKOUT_KEY_REUSED`), never a second attempt.
10. Old 22-argument signature no longer exists; new signature not executable by `anon` / `authenticated`;
    `assert_payment_operator_session` still refuses a client role.

**Existing pgTAP files that pass a member and must get a grant (fixture change only, no assertion changes):**
`52_payments.sql`, `53_obligation_on_capture.sql`, `56_contributor_register.sql`, `60_payment_reminders.sql`,
`61_collection_expected_summary.sql`. Each wraps the call in one `pg_temp` helper, so one shared helper
(`pg_temp.pass_for(collection, member) returns text`: settings row → `app.insert_membership_id` → grant row with a known
token) is added to each helper. Files passing `null` (54, 55, 57, 58, 59, 62, 63, 65, 73) need no change, because
the new argument defaults to null. Any **assertion** change in 03 or 40–77 is a stop-and-report.

**Unit (Vitest):**
- `membership-pass-helpers.test.ts`: confirm no longer clears the pass cookie.
- `membership-pass-actions.test.ts`: submit on a managed collection with no pass → generic message, both cookies
  cleared, `startCheckout` not called; with a pass → `startCheckout` receives the token from the cookie; an input
  carrying extra `memberId`/`accessToken` keys → `startCheckout` receives the cookie values, not the input's;
  `MEMBER_PROOF_*` codes → generic message + `reidentify`.
- `packages/payments`: `startCheckout` forwards `accessToken` unchanged.

**Integration / e2e (itest, fake provider):**
- Worker `payments-orchestrator.integration.test.ts` with minted grants.
- `payments.spec.ts` (9 flows): unchanged journeys; still assert `contribution.member_id = seeded member`.
- `contributor.spec.ts` forge test extended: clear only the pass cookie after confirming → Pay refused with the generic
  message; clear only the session cookie → refused; both present → works.
- New browser check: revoke the member's ID in a second (officer) context between confirm and Pay → refused.

## 10. Compatibility

- **Callers of `create_payment_attempt`:** exactly one production caller (`packages/db/src/payments.ts`). TypeScript
  will flag every `createPaymentAttempt`/`startCheckout` call site once `accessToken` is a required field (web action,
  worker integration test, sandbox, the web unit test stub).
- **Positional SQL callers** (pgTAP) keep compiling because the new argument has a default. Managed-collection calls
  fail with `MEMBER_PROOF_EXPIRED` until their helper mints a grant (§9).
- **In-flight attempts at deploy:** attempts already created are unaffected (capture does not read passes). A
  contributor mid-form at deploy time has no pass cookie (the old confirm cleared it) → one re-identification.
- **Time limit tightening:** managed checkout must start within 30 minutes of entering the ID (grant window, a table
  check constraint, not changed). Previously the 1-hour session was enough. A slow contributor re-enters the ID.
- **Migration ordering:** `supabase/pending-migrations/20261123120100_membership_id_plaintext_finalize.sql` (A-1
  finalize, not applied, not to be applied) sorts **before** M10. If it is later moved into `migrations/`, the CLI
  will see it as older than the last applied version. M10 does not depend on it, and it does not depend on M10. The
  owner should know this before approving either one.
- **Environments:** itest only until separately approved for dev, then staging, then production.

## 11. Rollback

The migration is additive in effect, but it drops and creates a function, so rollback is a migration too.
`supabase/migrations/…_m10_checkout_pass_revalidation.rollback.sql`, kept with it and not auto-applied, does this:

```sql
drop function app.create_payment_attempt(/* 23-arg */);
-- recreate the 22-arg function verbatim from 20261111100100_payment_functions.sql lines 259–652,
-- then its revoke + comment exactly as there
comment on table public.membership_access_grants is '<previous comment>';
```

The web/package changes are reverted with git. With the old function back, the new code would fail (TypeScript
passes 23 arguments), so roll back the code and the function together. No data is lost either way: no row is
written, changed or removed by the migration. Attempts created under M10 keep their (pass-resolved) member ids,
which are valid under the old function too.

## 12. Residual risks (stated, not solved by M10)

- **Capture does not re-check the member.** A member suspended after the attempt is created but before Paystack
  captures still gets the contribution applied, as today. The 2026-11-22 design §3.4 (`needs_review`) covers this and
  is a separate, capture-logic change.
- **Cookies are signed, not encrypted.** The pass cookie carries the raw token. The token is useless without the same
  collection and is only valid for 30 minutes, but the cookie must stay httpOnly. Encryption is a separate hardening.
- **A pass is reusable for 30 minutes on the same browser.** It is not single-use, so idempotent retries keep working.
  Making it single-use would need a "consumed by attempt" link and is not proposed.

## 13. Decisions needed from the owner

1. Approve narrowing M10 to pass revalidation only (no guests, no new columns, no capture change). Recommended.
2. Accept the 30-minute end-to-end window for managed checkout (vs. extending the grant window — a table constraint change). Recommended: accept.
3. Approve the `for share` lock on the grant row (closes the revoke-during-checkout race). Recommended.
4. Approve implementation on itest only, with the test plan in §9 as the acceptance condition.
