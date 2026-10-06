# Importer Implementation Report

## Architecture

The importer reads a legacy source (D2 production restore or synthetic
fixtures) and writes into an isolated rehearsal target under a single
`migration.import_runs` row. It does not modify the source.

### Packages

- `packages/migration/src/orchestrator.ts` — entry point (`runImport`)
- `packages/migration/src/reconcile.ts` — post-import reconciliation
- `packages/migration/src/transformers/` — pure transformation functions

### Importer role

`kolekto_importer` is a Postgres role with:

- NOLOGIN — accessed only via `SET LOCAL ROLE` from the orchestrating connection
- NOBYPASSRLS — every insert goes through RLS policies
- INSERT + SELECT on nine migration-schema tables and nine public destination tables
- SELECT on `community_slug_history` (for slug uniqueness)
- EXECUTE on six functions: `uuid_generate_v7`, `is_running_import_context`,
  `generate_unique_collection_slug`, `generate_unique_community_slug`, `slugify`,
  `all_amounts_positive`
- No UPDATE, DELETE, or TRUNCATE on any table
- No access to `ledger_*`, `financial_events`, or payment tables

### Transaction model

Each entity group (user, collection, contribution batch) runs in its own
`sql.begin()` block because:

1. `set_config('kolekto.import_run_id', ..., true)` is transaction-scoped
2. `SET LOCAL ROLE kolekto_importer` is transaction-scoped

The orchestrating connection (`postgres` / container owner) inserts into
`auth.users` first, then switches to `kolekto_importer` for public and
migration schema writes within the same transaction.

### Entity ordering

```
auth.users
  → public.users
  → migration.legacy_profile
  → public.communities (personal)
  → public.officer_terms (owner, start_reason='migration')
  → migration.imported_objects (provenance)

collections + tiers
  → migration.legacy_collection (always, even excluded campaigns)
  → public.collections (if not excluded)
  → public.collection_tiers
  → migration.imported_objects

contributions
  → migration.legacy_contribution
  → public.legacy_links (contributor code links)

attributed deposits (contributor_id IS NOT NULL)
  → migration.legacy_deposit (fields jsonb snapshot)

unattributed deposits (contributor_id IS NULL)
  → migration.unattributed_payments (typed columns + raw_payload jsonb)

withdrawals
  → migration.legacy_withdrawal (typed columns + fields jsonb, no bank details)

code sequences
  → public.collection_code_sequences
```

## Transformers

All transformers are pure functions (no I/O, no database, no globals).

| Transformer | Covers |
|---|---|
| `transformUser` | Profile → user + personal community + owner term |
| `transformCollection` | Collection + tiers with full decision logic |
| `classify` | Legacy collection_type → new (amount_model, category) |
| `feeMode` | Legacy fee_bearer → new fee_mode |
| `nairaToKobo` | Exact two-decimal Naira → integer kobo |
| `resolveTierNames` | Duplicate names → `Name [PREFIX]` deterministic rename |
| `resolveTierPrefixes` | Shared prefixes → highest-priced tier wins |
| `normalisePrefix` | Strip non-alphanumeric, uppercase, truncate to 7 |
| `buildContributorCodeLink` | Namespaced `contributor:<coll_id>:<code>` links |
| `resolveCodeSequences` | Legacy code counters → new code_sequences seed rows |

## Idempotency

- All inserts use `ON CONFLICT (id) DO NOTHING` or equivalent unique index
- Target UUIDs are derived deterministically from `(source_project, kind, legacy_id)` via SHA-256
- Re-running the importer with the same source produces zero new rows

## Contribution preservation

`legacy_contribution.fields` stores the complete 16-column legacy source
snapshot for every contribution:

`collection_id`, `name`, `email`, `phone`, `amount`, `gross_amount`,
`contributor_information`, `contributor_unique_code`, `payment_reference`,
`status`, `created_at`, `updated_at`, `payment_id`, `check_in_status`,
`line_index`, plus `source_id` in the row's own column.

`contributor_information` is preserved as-is (rich JSONB with receipt data,
tier selections, fee breakdowns). `gross_amount` and `amount` are preserved
independently — they differ for every contribution in D2 production.

The `SourceRepository.listContributionsForCollection` method returns the full
`LegacyContribution` type covering all 16 columns.

## Provenance

- `migration.imported_objects` links every target row to its legacy source
- `migration.legacy_profile`, `legacy_collection`, `legacy_contribution` preserve
  original field snapshots as JSONB
- Collections carry inline provenance: `is_imported`, `source_system`, `source_table`,
  `source_id`, `imported_at`, `import_run_id`

## Migration decisions implemented

| Decision | Implementation |
|---|---|
| Deleted collections → archived | `status='archived'`, `archived_at=updated_at` |
| "Mr" collection → archived | Renamed to "Mr (archived on import)" |
| Rejected campaign excluded | No `public.collections` row; `legacy_collection` preserved |
| Public/open → `participation_mode=open, audience_mode=public` | All imported collections |
| Duplicate tier names → `Name [PREFIX]` | Deterministic bracket rename |
| Shared prefixes → highest price wins | Lower-priced tiers lose prefix |
| Invalid prefix → normalised | Strip, uppercase, truncate to 7 |
| Quantity=0 with sold=0 → null (unlimited) | Per-tier, not universal |
| Zero-price fixed → free | `fixed_amount_kobo=0` |
| Ticket with no tiers → zero tiers | No invented ticket types |
| Images → null | `cover_image_url=null`, originals in legacy_fields |
| Contributor codes → namespaced legacy_links | `contributor:<coll_id>:<code>` |
| Tier IDs: usable → preserved, missing → generated UUID | Via provenance |
| Duplicate phones → first by id keeps phone_e164 | See below |

### Phone deduplication rule

The legacy D2 data contains 27 groups of profiles sharing the same phone
number (66 profiles total, largest group of 8). The new schema enforces
`users_phone_key`: a partial unique index on `(phone_e164) WHERE phone_e164
IS NOT NULL`.

**Rule:** Profiles are sorted by `id` (lexicographic UUID comparison) before
processing. Within each group sharing the same phone number, the first profile
by this ordering retains `phone_e164` on its `public.users` row. All
subsequent profiles in the group have `phone_e164` set to `NULL`.

**Provenance:** The original `phone_number` value is always preserved in
`migration.legacy_profile.fields` for every profile (deduped or not). Profiles
whose phone was nulled carry an additional `_phone_deduped: true` field in
the JSONB, making them auditable without schema changes.

**Properties:** Deterministic (same sort, same winner), idempotent (re-import
produces the same result via `ON CONFLICT (id) DO NOTHING`), zero data loss
(original phone preserved in migration history).

## Security controls

- `kolekto_importer` cannot read or write `ledger_*`, `financial_events`, wallets
- RLS policies require `is_running_import_context()` for every INSERT
- Completed import runs are frozen — no inserts allowed against them
- Migration history tables refuse UPDATE/DELETE/TRUNCATE (trigger + grant)
- No Paystack calls, no external I/O
- auth.users inserts run as container owner, not the importer role

## Blocker status

| Blocker | Status |
|---|---|
| B1 — Contributions | PASS — all 16 D2 columns preserved in legacy_contribution.fields |
| B2 — Deposits | PASS — 4,884 attributed → legacy_deposit, 1,317 unattributed → unattributed_payments |
| B3 — Withdrawals | PASS — 292 rows, ₦46.7M → legacy_withdrawal; destination_account excluded per security constraint |
| B4 — Overflow/wallets | IMPLEMENTED — 7 tables (31,678 rows) → legacy_overflow; 28 tables excluded (sensitive/ephemeral); synthetic 77/77 PASS; D2 rehearsal pending. See B4-DISCOVERY-AND-DESIGN-REPORT.md |

The importer is NOT production-ready until B4 implementation is complete.

## Known limitations

- Storage/image migration is deferred — all image fields are null
- auth.users insert runs as container owner — a Supabase platform limitation,
  not a security gap (the import context trigger validates the GUC)
- 27 duplicate phone groups (66 profiles) in legacy data — handled by the phone
  deduplication rule above; no phone values are lost (preserved in legacy_profile)
