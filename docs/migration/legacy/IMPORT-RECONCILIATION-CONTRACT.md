# Import Reconciliation Contract

This document specifies the deterministic, machine-testable reconciliation
checks that every import run must satisfy. Implementation: `packages/migration/src/reconcile.ts`.

## Notation

- `source.*` — counts from the legacy source (fixture or D2 restore)
- `target.*` — counts queried from the rehearsal target after the run
- `=` — must be exactly equal
- `≥` — target must be greater than or equal to source

## Identity

| Check | Rule |
|---|---|
| `target.users = source.profiles` | Every legacy profile produces one `public.users` row |
| `target.personal_communities = source.profiles` | Every user gets one personal community |
| `target.owner_terms(migration) = source.profiles` | Every personal community gets an owner term with `start_reason='migration'` |
| `target.auth_users = source.profiles` | Every legacy profile produces one `auth.users` row |

## Collections

| Check | Rule |
|---|---|
| `target.collections(is_imported) = source.collections − source.excluded_rejected` | All non-rejected collections land |
| `target.collections(status=archived) ≥ source.collections(status=deleted)` | Deleted collections become archived (plus possible Mr-style archival) |
| `target.collections(source_id = rejected_uuid) = 0` | The rejected campaign has zero live collection rows |

## Provenance

| Check | Rule |
|---|---|
| `target.collections(is_imported AND (source_id IS NULL OR import_run_id IS NULL)) = 0` | Every imported collection has provenance columns filled |
| `target.imported_objects(collection_tiers) ≥ source.tier_entries` | Every tier has an imported_objects provenance row |

## Tiers

| Check | Rule |
|---|---|
| Within each collection: tier names are unique | Enforced by `resolveTierNames` + DB unique index |
| Shared prefix → highest-priced tier only | Enforced by `resolveTierPrefixes` |
| quantity=0 with sold=0 → `quantity_limit IS NULL` | Per-tier rule, not universal |
| Original tier data preserved in `legacy_collection.fields.price_tiers` | JSONB snapshot includes original names and quantities |

## Contributor codes

| Check | Rule |
|---|---|
| `target.legacy_links(contributor_code) ≥ source.contributions_with_code` | Every contribution with a code gets a legacy_link |
| Namespaced as `contributor:<collection_id>:<code>` | Codes reused across collections do not collide |

## Statuses

| Legacy status | Target status |
|---|---|
| active | active |
| closed | closed |
| paused | paused |
| deleted | archived (`archived_at = updated_at`) |
| rejected | excluded (no `public.collections` row) |

## Historical records

| Table | Content | Mutability |
|---|---|---|
| `migration.legacy_profile` | Original profile JSONB snapshot | Append-only (INSERT only, no UPDATE/DELETE) |
| `migration.legacy_collection` | Original collection JSONB snapshot | Append-only (trigger refuses UPDATE) |
| `migration.legacy_contribution` | Original contribution JSONB snapshot | Append-only |
| `migration.imported_objects` | Source → target provenance links | Append-only |
| `migration.import_runs` | Run metadata | Append-only after completion |

## Zero live financial movement

| Check | Rule |
|---|---|
| `target.ledger_journals = 0` | No ledger journals created |
| `target.ledger_entries = 0` | No ledger entries created |
| `target.financial_events = 0` | No financial events created |
| No wallet rows | No wallet balances or opening balances |
| No Paystack calls | Verified by code path (no Paystack import in orchestrator) |

## Immutability

| Check | Rule |
|---|---|
| `UPDATE migration.legacy_collection` raises | Trigger-enforced |
| `DELETE migration.*` denied for kolekto_importer | Grant-enforced |
| `TRUNCATE migration.*` denied for kolekto_importer | Grant-enforced |
| Completed import_runs are frozen | Policy refuses INSERT against completed runs |

## Idempotency

| Check | Rule |
|---|---|
| Second run with same source → zero new rows | All entity counts identical before and after |
| `import_runs` count increases by 1 | A new run row is created, but no duplicate data |
