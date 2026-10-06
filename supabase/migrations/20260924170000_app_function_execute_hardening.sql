-- ─────────────────────────────────────────────────────────────────────────────
-- 20260924170000 — M8.2: close the PUBLIC EXECUTE hole for good
--
-- ── WHAT ACTUALLY HAPPENED, CORRECTED ───────────────────────────────────────
--
-- The M8.1 report said the schema-wide revoke in `20260917121100_grants.sql`
-- "was not a standing rule". That was imprecise. There IS a standing rule —
--
--     alter default privileges in schema app revoke execute on functions from public;
--
-- — and it is the right mechanism. But `alter default privileges` is recorded
-- **per grantor role**: it applies to objects created by the role that ran it.
-- The repository already knew this; `20260919120100`'s own comment says "`alter
-- default privileges` recorded by one role does not necessarily cover...".
--
-- Empirically, the six trigger functions created by M8.1's migrations arrived
-- PUBLIC-executable anyway, and `02_grant_matrix.sql` caught them by asserting
-- the anon-executable set exactly — anon inherits PUBLIC, so a PUBLIC grant is
-- an anon grant.
--
-- ── WHY THIS MATTERS OUT OF PROPORTION TO THE SYMPTOM ───────────────────────
--
-- Those six were trigger functions; calling one directly fails for want of a
-- trigger context. The class is what matters. Three SECURITY DEFINER functions
-- driving the payment state machine, executable by anybody holding the
-- publishable key that ships in every page's JavaScript, is how the previous
-- system exposed its payment ledger. Phase 4 adds many `app.*` functions, and
-- the ones coming next post journals.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
--
-- Two statements, neither of which changes any current behaviour:
--
--   1. A retroactive revoke across the whole schema, from PUBLIC only. Verified
--      before writing this: zero `app.*` functions are currently PUBLIC-
--      executable, so this is a no-op today and a safety net for anything the
--      default privileges missed.
--   2. The default privileges re-asserted, so the rule is stated again by the
--      role running this migration.
--
-- Explicit grants to `anon` and `authenticated` are a different privilege and are
-- untouched. The eight anon-callable public-collection functions and the ~70
-- authenticated-callable write functions keep working, which `02_grant_matrix.sql`
-- and the whole pgTAP suite prove by still passing.
--
-- The durable half of this fix is not SQL: it is the sixth source-tree invariant
-- added in the same milestone, which fails the build when a migration creates an
-- `app.*` function without stating who may execute it.
-- ─────────────────────────────────────────────────────────────────────────────

-- PUBLIC only. Deliberately NOT `from public, anon, authenticated` — that would
-- strip the explicit grants the application depends on.
revoke execute on all functions in schema app     from public;
revoke execute on all functions in schema public  from public;
revoke execute on all functions in schema private from public;

-- Re-assert the rule for functions created hereafter by this grantor.
alter default privileges in schema app     revoke execute on functions from public;
alter default privileges in schema public  revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;
