-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921190200 — The trigger function anon could call
--
-- Postgres grants EXECUTE to PUBLIC on every new function, and PUBLIC
-- includes `anon` — the role whose key ships in the JavaScript of every
-- published collection page. `app.enforce_reference_immutability` is a
-- trigger function and should never be callable by anybody; it acquired that
-- grant by default in 20260921180000, and the grant matrix test caught it.
--
-- Calling it directly does nothing useful (a trigger function invoked outside
-- a trigger raises), which is exactly the reasoning that let three functions
-- driving a live payment state machine stay callable by anon in the previous
-- system. The point of the allowlist is that "nothing useful" is not a
-- security argument, and nobody has to make one.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function app.enforce_reference_immutability() from public;
