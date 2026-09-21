-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921170200 — A collector's check-in permission is scoped, like the rest
--
-- ROLE-06 / SEC-10, enforced by 04_authorization.sql: every permission a
-- collector holds is scoped to the collections they were given, never to the
-- whole community. 20260921170000 inserted `attendance.check_in` for the
-- collector with the column's default of `scoped = false`, which is exactly
-- the shape that test exists to catch — door staff for one event would have
-- been door staff for every event the community ever runs.
-- ─────────────────────────────────────────────────────────────────────────────

update public.role_permissions
set scoped = true
where role = 'collector' and permission = 'attendance.check_in';
