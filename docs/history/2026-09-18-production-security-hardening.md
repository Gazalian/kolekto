# Production security hardening — 2026-09-18

**Status:** Applied. **Target:** `kolekto prod` (project ref redacted — see
`docs/adr/0007-environment-isolation.md`), the live production project — not
this repository's local or staging Supabase projects, which have never been
linked to it and never will be.

This is a permanent record of a live change to a production database, kept in
this repository per the Phase 1.5 change-control procedure even though the
change itself was applied directly against the remote project (not through a
local migration file — production has its own, separate migration history of
39 entries, entirely independent of this repository's `supabase/migrations/`).

## Why

The 2026-09-17 architecture audit and the 2026-09-18 Migration Architecture
document both identified three categories of live exposure, reachable with
nothing but the public `anon` key that ships in every page's JavaScript
bundle. The Supabase security advisor, queried immediately before this change,
confirmed all three independently and surfaced two additional functions in the
same category that neither prior document had named.

## What was found (before)

| Object | Exposure |
|---|---|
| `payment_reference_backfill_snapshot_20260811` (3,324 rows) | RLS disabled entirely; `anon`/`authenticated` held SELECT/INSERT/UPDATE/DELETE/TRUNCATE |
| `duplicate_void_snapshot_20260812` (12 rows) | Same |
| 7 views (`v_payment_inbox`, `v_orphaned_successful_payments`, `v_payment_health_summary`, `v_payment_invariants`, `v_payment_mismatch_rate`, `v_payment_recovery_exhausted`, `v_collections_with_duplicate_tier_names`) | SECURITY DEFINER-style (non-invoker), none filter by caller identity, all granted full DML to `anon`/`authenticated`. Two expose contributor name/email/phone and organizer email directly. |
| `mark_payment_completed`, `mark_payment_needs_review`, `record_payment_capture` | SECURITY DEFINER, **no internal authorization check of any kind**, EXECUTE granted to `PUBLIC` (inherited by `anon` and `authenticated`). Each can mutate the payment-recovery state of any reference. |
| `get_historical_orphaned_payments_summary`, `get_overwithdrawn_collections_reconciliation` | SECURITY DEFINER, **do** carry an internal check (`is_current_user_admin() OR auth.role() = 'service_role'`), but still granted EXECUTE to `anon` and `PUBLIC` unnecessarily |

## Dependency check (why this is safe to close)

Traced against the actual application code, not assumed:

- The only confirmed caller of the three write functions is
  `verify-paystack-payment`, which builds its Supabase client from
  `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` — never the anon/publishable
  key. No contributor-facing or organizer-facing code path calls them with a
  user session. Contributors are never authenticated (the product's own
  SEC-06 pattern); organizers have no legitimate reason to mutate payment
  recovery state directly.
- The two reconciliation functions are designed to be called directly by a
  signed-in admin's own browser session — that is the entire reason their
  internal `is_current_user_admin()` check reads the caller's JWT. Revoking
  `authenticated` would have broken the admin panel's legitimate reconciliation
  dashboard; only `anon` and `PUBLIC` were revoked from those two.
- The seven views' only confirmed caller is `kolekto-be-old`'s admin-gated
  routes, using the service-role key (`utils/client.js`). `service_role`
  privileges are provisioned independently of `PUBLIC`/`anon`/`authenticated`
  grants in Supabase, so revoking the latter three does not affect it.

## The change

Applied as a single migration on the production project via the Supabase
management API, name `phase1_5_harden_snapshot_tables_views_and_anon_functions`,
version `20260918101428`. Full SQL, including the documented (not executed)
rollback block, is reproduced below exactly as applied.

```sql
begin;

-- 1. Two RLS-disabled snapshot tables
alter table public.payment_reference_backfill_snapshot_20260811 enable row level security;
alter table public.payment_reference_backfill_snapshot_20260811 force row level security;
revoke all on public.payment_reference_backfill_snapshot_20260811 from anon, authenticated, public;

alter table public.duplicate_void_snapshot_20260812 enable row level security;
alter table public.duplicate_void_snapshot_20260812 force row level security;
revoke all on public.duplicate_void_snapshot_20260812 from anon, authenticated, public;

-- 2. Seven SECURITY DEFINER-style views — reachability changed, not their
--    necessary cross-tenant read behaviour
revoke all on public.v_payment_inbox                          from anon, authenticated, public;
revoke all on public.v_orphaned_successful_payments            from anon, authenticated, public;
revoke all on public.v_payment_health_summary                  from anon, authenticated, public;
revoke all on public.v_payment_invariants                      from anon, authenticated, public;
revoke all on public.v_payment_mismatch_rate                   from anon, authenticated, public;
revoke all on public.v_payment_recovery_exhausted               from anon, authenticated, public;
revoke all on public.v_collections_with_duplicate_tier_names   from anon, authenticated, public;

-- 3a. Three functions with no internal check — close both anon AND authenticated
revoke execute on function public.mark_payment_completed(text, boolean) from anon, authenticated, public;
revoke execute on function public.mark_payment_needs_review(text, text, text, jsonb) from anon, authenticated, public;
revoke execute on function public.record_payment_capture(text, uuid, text, text, numeric, text, text, timestamptz, jsonb, text, uuid) from anon, authenticated, public;

-- 3b. Two functions WITH an internal admin-or-service-role check — keep authenticated
revoke execute on function public.get_historical_orphaned_payments_summary() from anon, public;
revoke execute on function public.get_overwithdrawn_collections_reconciliation() from anon, public;

commit;
```

**Rollback** (documented, never executed — restores the exact prior exposure;
requires explicit written approval to run):

```sql
begin;
alter table public.payment_reference_backfill_snapshot_20260811 disable row level security;
grant select, insert, update, delete, truncate, references, trigger
  on public.payment_reference_backfill_snapshot_20260811 to anon, authenticated;
alter table public.duplicate_void_snapshot_20260812 disable row level security;
grant select, insert, update, delete, truncate, references, trigger
  on public.duplicate_void_snapshot_20260812 to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger on
  public.v_payment_inbox, public.v_orphaned_successful_payments,
  public.v_payment_health_summary, public.v_payment_invariants,
  public.v_payment_mismatch_rate, public.v_payment_recovery_exhausted,
  public.v_collections_with_duplicate_tier_names to anon, authenticated;
grant execute on function public.mark_payment_completed(text, boolean),
  public.mark_payment_needs_review(text, text, text, jsonb),
  public.record_payment_capture(text, uuid, text, text, numeric, text, text,
    timestamptz, jsonb, text, uuid) to public;
grant execute on function public.get_historical_orphaned_payments_summary(),
  public.get_overwithdrawn_collections_reconciliation() to anon;
commit;
```

## Verification (after)

Re-queried independently, not assumed from the apply result:

| Object | anon | authenticated | service_role |
|---|---|---|---|
| Both snapshot tables | RLS enabled+forced, 0 grants | 0 grants | unaffected (bypasses RLS) |
| All 7 views | 0 grants | 0 grants | unaffected |
| `mark_payment_completed` | ✗ | ✗ | ✓ |
| `mark_payment_needs_review` | ✗ | ✗ | ✓ |
| `record_payment_capture` | ✗ | ✗ | ✓ |
| `get_historical_orphaned_payments_summary` | ✗ | ✓ (required) | ✓ |
| `get_overwithdrawn_collections_reconciliation` | ✗ | ✓ (required) | ✓ |
| `current_admin_user`, `is_current_user_admin` | ✗ (unchanged) | ✓ (unchanged) | ✓ |

Supabase security advisor, re-run after the change:

- `rls_disabled_in_public`: **2 → 0**
- `security_definer_view`: **7 → 0** (no longer reachable by any externally-facing role, so the linter no longer flags them)
- `anon_security_definer_function_executable`: **5 → 0**
- `authenticated_security_definer_function_executable`: **7 → 4** (only the two legitimate admin-facing functions plus the two admin-check functions themselves remain, exactly as intended)

**No unrelated object changed.** Spot-checked: `contributions`, `wallets`,
`withdrawals` grants for `anon`/`authenticated` are byte-identical to before
this migration. Row counts on both snapshot tables are unchanged
(3,324 / 12) — data was never read, written, or touched; only reachability
changed.

## Explicitly out of scope for this change

Observed by the same advisor run, deliberately not touched here because they
fall outside Part D's named categories and each carries its own risk profile
that deserves a dedicated pass:

- `function_search_path_mutable` (9 email-campaign functions, unrelated to
  migration or payment concerns)
- `extension_in_public` (`citext` installed in `public`)
- `auth_otp_long_expiry`, `auth_leaked_password_protection` — global auth
  config affecting live login behaviour for 623 real accounts; changing this
  without a dedicated review is out of proportion to a narrowly-scoped
  hardening pass
- `vulnerable_postgres_version` — a platform upgrade, not a grant/RLS fix

Flagged for a future dedicated auth-hardening pass, not silently dropped.
