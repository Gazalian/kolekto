# Dependency audit exceptions

CI's dependency audit (`node scripts/security/audit.mjs`, SEC-30) fails on any
high or critical advisory in the full dependency tree, dev dependencies
included. An advisory may be accepted only when no upstream fix exists, and
only with a record here and a matching entry in
`scripts/security/audit-exceptions.json`.

The audit fails again on its own when an exception passes its review date,
stops matching any advisory (the fix has landed — remove the exception and
upgrade), or, for a dev-only exception, appears in the production tree.

Accepting an advisory is not a fix. Never use `npm audit fix --force`,
`--omit=dev` or a lower `--audit-level` instead of a record here.

## Active exceptions

None.

## History

### braces — GHSA-vfj7-8cjw-p6xm (CVE-2026-93687) — removed

Accepted 2026-10-08 during M13.1 (PR #1) because no patched release of
`braces` existed. The advisory stopped matching any entry in npm's audit
database on 2026-10-23 (the GitHub Advisory Database updated or withdrew
the advisory), at which point `scripts/security/audit.mjs` correctly
reported that the exception was stale. The entry was removed in P9-3 (PR
#20) with no code or dependency change — the exception simply no longer
applies. If the advisory is reinstated or a related one is published,
reopen a new section rather than resurrect this one.
