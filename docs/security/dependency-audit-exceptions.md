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

### braces — GHSA-vfj7-8cjw-p6xm (CVE-2026-93687)

| | |
|---|---|
| Package | `braces@3.0.3` (transitive) |
| Advisory | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), CVE-2026-93687, published 2026-09-18 |
| Severity | High — stack-exhaustion denial of service through deeply nested brace patterns |
| Path | `eslint-config-next@16.3.5` → `@next/eslint-plugin-next@16.3.5` → `fast-glob@3.3.1` → `micromatch@4.0.8` → `braces@3.0.3` |
| Upstream fix | None. The advisory covers `<= 3.0.3`, and 3.0.3 is the latest release. The only change npm offers is `npm audit fix --force`, which downgrades `eslint-config-next` to 14.x, a breaking change that leaves the advisory in place on its own chain. |
| Exposure | Development only. `eslint-config-next` is a `devDependency` of `apps/web`, used by `npm run lint`. It is not part of the Next.js build output or any runtime, and `npm audit --omit=dev` does not report it. |
| Accepted | 2026-10-08, during M13.1 (PR #1) |
| Review by | 2026-11-08 |

**Risk.** Exploiting the advisory needs an attacker-controlled glob pattern.
Here, `braces` only expands glob patterns that come from the lint plugin
itself and from our committed lint configuration, while it searches the
repository's own files. There is no path for outside input to reach
it, and the worst outcome is a lint run that crashes.

**Containment.** The audit script checks on every run that this advisory is
still absent from the production tree. If any runtime dependency starts
pulling in `braces`, CI fails and the exception has to be reconsidered.

**Removal.** When a patched `braces` is released, or `eslint-config-next`
stops depending on an affected version, upgrade, then delete this section and
its entry in `scripts/security/audit-exceptions.json`. If you forget, the
audit fails once the advisory stops matching.
