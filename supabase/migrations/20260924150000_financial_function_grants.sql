-- ─────────────────────────────────────────────────────────────────────────────
-- 20260924150000 — M8.1: withdraw the default EXECUTE on the financial guards
--
-- Postgres grants EXECUTE to PUBLIC on every new function. `20260917121100`
-- revoked it across the `app` schema, but that revoke applied to the functions
-- that existed then — it is not a standing rule, so every function created
-- afterwards arrives PUBLIC-executable again.
--
-- This was caught by `02_grant_matrix.sql`, which asserts the anon-executable
-- set exactly, and it caught the six trigger functions M8.1 added. That test
-- exists because the same default is how `record_payment_capture` became an
-- anonymous write path into a live fintech's payment ledger: three SECURITY
-- DEFINER functions driving the payment state machine, executable by anybody
-- holding the publishable key that ships in every page's JavaScript.
--
-- These six are trigger functions, so calling one directly would fail for want
-- of a trigger context rather than do damage. The revoke is not about this
-- particular exposure — it is about the rule holding without exception, because
-- an allowlist with six unexplained entries is an allowlist nobody reads.
-- ─────────────────────────────────────────────────────────────────────────────

-- Fee schedules (20260924100000)
revoke execute on function app.block_fee_schedule_mutation()     from public, anon, authenticated;

-- The ledger (20260924110000)
revoke execute on function app.assert_journal_balances()         from public, anon, authenticated;
revoke execute on function app.assert_journal_has_entries()      from public, anon, authenticated;
revoke execute on function app.block_ledger_mutation()           from public, anon, authenticated;

-- The chart of accounts (20260924130000)
revoke execute on function app.assert_ledger_account_scope()     from public, anon, authenticated;

-- Provider events and operation claims (20260924120000)
revoke execute on function app.block_financial_event_mutation()  from public, anon, authenticated;

-- A trigger function does not need an EXECUTE grant to fire: the trigger runs
-- with the privileges of the statement's context, not the caller's rights on the
-- function. So revoking this costs nothing and the guards keep working — which
-- 20_ledger.sql and 21_financial_idempotency.sql both prove by still passing.
