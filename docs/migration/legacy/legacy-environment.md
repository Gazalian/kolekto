# Legacy environment — migration access

**The full environment and switching documentation lives at
[docs/environments/legacy-supabase.md](../../environments/legacy-supabase.md)**, per
Phase 17. This file is the migration-facing summary and records how *this* baseline
was taken.

---

## 1. The projects

| Ref | Name | Region | Postgres | Classification | Access |
|---|---|---|---|---|---|
| `busfgcmbndleljklrcbd` | kolekto prod | eu-central-1 | 15.8.1.094 | **legacy / LIVE** | **read-only** |
| `lpeeckqsltxohppheucz` | Kolekto test | eu-north-1 | 17.4.1.064 | legacy / test | **read-only** |
| *(not created)* | new staging | — | — | future | — |
| *(not created)* | new production | — | — | future | — |

All in organization `Kolekto Org` (`wzkhbvbimazkabmdbawa`). The new projects go in a
**new** account/organization.

**Legacy test runs a newer Postgres than legacy production** (17 vs 15). Test is
therefore not a reliable rehearsal surface for version-sensitive behaviour, and it is
one reason Phase 12's comparison cannot be skipped.

---

## 2. How this baseline was taken

**Nothing was linked.** `supabase/.temp/project-ref` did not exist before this work
and does not exist after it. The application runtime could not reach either legacy
project at any point.

Access was account-level, read-only, with **the project ref named explicitly on every
single query**. That is deliberately safer than `supabase link`: a link leaves an
ambient target that a later `db push` or `db reset` would inherit silently, whereas
an explicit ref per statement cannot be inherited by anything.

Every statement issued was a `SELECT` against system catalogs or aggregates. No DDL,
no DML, no function execution that writes, no migration, no policy or grant change, no
auth configuration change.

**Recommended practice for future discovery: do not link. Name the ref per query.**

---

## 3. Confirming where you are, before anything

```bash
cat supabase/.temp/project-ref 2>/dev/null || echo "NOT LINKED (local only)"
grep NEXT_PUBLIC_SUPABASE_URL .env.local apps/web/.env.local
```

`127.0.0.1:54321` and "NOT LINKED" is the safe resting state, and is the current
state.

---

## 4. Absolute prohibitions on both legacy projects

Never: `db push`, `db reset`, `migration up`, any INSERT/UPDATE/DELETE/ALTER/DROP/
TRUNCATE, any RLS or grant change, any auth configuration change, and never pointing
the application runtime at either one.

**The new Kolekto schema must not be deployed into either legacy project.** The 79
migrations assume an empty database and several create tables whose names the legacy
schema already uses (`collections`, `profiles`) with different shapes.

---

## 5. Gap worth closing

**`E-ENV-1`:** `KOLEKTO_PRODUCTION_PROJECT_REF` in `.env.example` refers to the *new*
production project, which does not exist. Nothing in the repository names the two
legacy refs as forbidden, so an accidental legacy connection would succeed quietly
rather than fail loudly. A guard listing both legacy refs as never-connect would fix
that. **Not implemented** — it is a code change and this task is discovery.

---

## 6. Secrets

No key, token, JWT secret, password or Paystack credential appears in this file or any
artifact in this baseline. Two secrets require rotation, recorded by type and location
only in
[legacy-production-baseline.md](legacy-production-baseline.md) §6 S6. Neither was
rotated, printed or copied.
