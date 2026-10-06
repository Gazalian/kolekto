# Legacy production — structural, storage, Edge Function and encryption capture

**Source:** `busfgcmbndleljklrcbd`, read-only, 2026-09-27. Nothing modified.
**Scope:** Phases 7–10 of the preservation brief.

> **This document is a summary, not the authoritative capture.** Full column
> definitions, constraint expressions, index definitions, function bodies and view
> definitions come from `pg_dump --schema-only`, which is **gated on B1/B2** in
> [production-backup-plan.md](production-backup-plan.md). Reconstructing a schema from
> prose is lossy, and pretending otherwise would be the failure this whole exercise
> exists to avoid. **D5 depends on D1.**

---

## 1. Structural inventory (Phase 7)

| Object class | Count | Captured here | Needs the dump |
|---|---|---|---|
| Schemas | 9 non-system | yes | — |
| Tables (`public`) | 53 | names, rows, RLS, policy counts | column definitions, defaults, generated columns |
| Views | 8 | names, security mode, grants | **definitions** |
| Functions | 95 | names, signatures, security, grants, write-detection | **bodies** |
| Triggers | 9 | names, tables | **definitions** |
| Enums | 2 | **full value lists — below** | — |
| Domains | 0 | confirmed none | — |
| Sequences | 2 | **names and current values — below** | — |
| Foreign keys | — | **all CASCADE/SET NULL actions — below** | full list incl. NO ACTION |
| Indexes | — | counts only | **definitions** |
| Check constraints | — | not captured | **expressions** |
| RLS policies | 25 tables policed | counts per table | **policy expressions** |
| Grants | — | fully captured (prior session) | — |
| Cron jobs | 2 | **schedules and commands — one carries a secret** | — |
| Extensions | 10 | count | names and versions |

### Enums — captured in full

Only two, both from the campaign subsystem. Neither is used by the core collection or
payment model, which is itself notable: **legacy encodes every status as `varchar`, not
as an enum.** That is why four status vocabularies drifted between environments.

**`campaign_status`** — `draft | pending_verification | active | paused | completed |
rejected | pending | closed`

**`fundraising_category`** — `Alumni | Charity | Community | Disaster | Education |
Legal | Medical | Politics | Sports | Others | Healthcare | Humanitarian Relief |
Community Development | Environment | Arts & Culture | Religion | Memorial | Personal
Emergency | Other`

Note the sprawl inside `fundraising_category`: both **`Others`** and **`Other`**, and
both **`Community`** and **`Community Development`**. Enum values cannot be removed
without a migration, so these are permanent. Any mapping to the new
`collection_category` must decide what `Others` versus `Other` means, and must not
silently merge them.

### Sequences — captured in full

| Sequence | `last_value` |
|---|---|
| `campuses_campus_id_seq` | **2** |
| `students_student_id_seq` | **2** |

**`campuses` holds 46 rows but its sequence is at 2.** So `campus_id` values were
inserted explicitly rather than drawn from the sequence. **The migration must preserve
the explicit ids and must not reseed from the sequence**, or 44 campuses would collide
or be renumbered. Same caution for `students`.

### Foreign key actions — the data-loss finding

Captured in full for every non-`NO ACTION` action. The financial ones matter:

| Constraint | On delete |
|---|---|
| `contributions_collection_id_fkey` | **CASCADE** |
| `wallets_collection_id_fkey` | **CASCADE** |
| `withdrawals_collection_id_fkey` | **CASCADE** |
| `withdrawals_wallet_id_fkey` | **CASCADE** |
| `contribution_code_counters_collection_id_fkey` | **CASCADE** |
| `profiles_id_fkey` | **CASCADE** from `auth.users` |
| `user_payout_accounts_user_id_fkey` | **CASCADE** |
| `user_identity_user_id_fkey` | **CASCADE** |
| `kyc_documents_user_id_fkey`, `kyc_verification_history_*`, `fk_kyc_verifications_profile` | **CASCADE** |
| `payments_collection_id_fkey`, `payments_contributor_id_fkey` | SET NULL |

**Deleting one collection cascade-deletes its contributions, wallet, withdrawals and
code counter. Deleting one auth user cascade-deletes their profile, payout accounts,
identity record and KYC history.**

Analysed in
[live-production-delta-strategy.md](live-production-delta-strategy.md) §6. Nothing was
changed; the new architecture uses `ON DELETE RESTRICT` for the equivalent links.

### A provenance detail worth keeping

Two constraints are named `payments_collection_id_fkey` and
`payments_contributor_id_fkey`, but **there is no `payments` table.** They sit on
`deposits`. Likewise `user_payout_accounts_user_id_fkey` sits on `payout_accounts`.

So `deposits` was formerly `payments`, and `payout_accounts` was formerly
`user_payout_accounts`. Constraint names survived the renames. That matters for reading
legacy code and old documentation, where the older names will appear.

### Cron jobs

| Job | Schedule | Command | Active |
|---|---|---|---|
| 5 | `*/5 * * * *` | `net.http_post` → `scheduled-payment-recovery` Edge Function | **yes** |
| 6 | `0 4 * * *` | `SELECT public.settlement_recompute_wallets('cron')` | **yes** |

**Job 5's command contains a shared secret in plaintext** (`X-Cron-Secret`). It is
therefore both a structural artefact that must be preserved and a **secret-bearing**
one. Captured in the dump only if `--schema cron` is passed, and the resulting file must
be handled as a secret.

Job 6 confirms the nightly wallet recompute; `max(wallets.updated_at)` of
`2026-09-26 04:00:00` is its fingerprint.

---

## 2. Storage (Phase 8)

**6 buckets, 68 objects, 24,424,830 bytes (~24.4 MB).** 7 RLS policies on
`storage.objects`.

| Bucket | Public | Objects | Bytes | Size limit | MIME restriction | Earliest → latest | Business meaning |
|---|---|---|---|---|---|---|---|
| `kyc-documents` | **private** | **53** | 19,730,501 | none | none | 2025-10-17 → 2026-09-11 | **identity documents** |
| `avatars` | **public** | 13 | 4,033,319 | none | none | 2026-01-01 → 2026-08-15 | user avatars |
| `email-attachments` | public | 1 | 12,181 | 15 MB | none | 2026-08-06 | campaign attachment |
| `campaign_assets` | public | 1 | 648,829 | 10 MB | images only | 2026-08-28 | campaign image |
| `campaign-documents` | private | 0 | 0 | none | none | — | empty |
| `campaign-images` | public | 0 | 0 | 10 MB | images only | — | empty |

### Observations

**`kyc-documents` is the whole sensitivity question.** 53 private objects, 19.7 MB,
matching `kyc_files` (53 rows) exactly — so the table and the bucket are in step. These
are identity documents and sit behind the same legal ruling as `user_identity` (L-1/L-2).

**There is no bucket for collection flyers or banners.** `collections.banner_url`,
`ticket_template_url` and `story_images` all exist, and 275 collections are populated,
but no bucket holds them. So those assets are **hosted outside this Supabase project** —
an external CDN or image host. **This is an open question (`Q-ST1`): if those URLs point
to a third-party service, that service is also a legacy dependency requiring
preservation, and it is not in any inventory.** Not resolvable from the database.

**`avatars` is public** and holds 13 user avatars. Public-by-design, low risk.

**Two buckets are empty** but configured, so they are part of the structural record.

### Migration approach

The volume is trivial; the sensitivity is not.

| Bucket | Approach |
|---|---|
| `avatars` | Copy to the new project. Low sensitivity, referenced by `profiles.avatar_url` |
| `kyc-documents` | **Blocked on L-1/L-2.** Do not download or copy until counsel rules on retention |
| `email-attachments`, `campaign_assets` | Copy or preserve as overflow with the email/campaign subsystems |
| Two empty buckets | Record configuration; nothing to move |

**Object paths were not extracted**, deliberately: a KYC object path may embed a user
identifier or a document type. Counts, sizes and date ranges are sufficient for
planning, and the paths come with the object backup once approved.

**No object was downloaded, modified or deleted.**

---

## 3. Edge Functions (Phase 9)

**13 functions, all `ACTIVE`.** All 13 have **git-tracked source** in
`kolekto-fe-old/supabase/functions/` (24 tracked files including `_shared`).

| Slug | Ver | `verify_jwt` | Local source | Purpose |
|---|---|---|---|---|
| `verify-paystack-payment` | **39** | false | yes, 55,856 B | **payment verification — the critical one** |
| `initiate-paystack-payment` | 16 | false | yes, 74,858 B | **payment initiation** |
| `scheduled-payment-recovery` | 10 | false | yes, 18,867 B | **called by cron job 5 every 5 min** |
| `create-collection` | 9 | **false** | yes, 12,796 B | collection creation |
| `update-collection` | 10 | **false** | yes, 8,015 B | collection update |
| `update-collection-status` | 7 | **false** | yes, 6,105 B | status change |
| `delete-collection` | 7 | **false** | yes, 5,982 B | **collection deletion** |
| `rapid-service` | 8 | false | yes, 2,742 B | unclear from name |
| `change-password` | 6 | true | yes, 9,967 B | auth |
| `profile-update` | 7 | true | yes, 4,606 B | profile |
| `get-all-fundraising-campaigns` | 7 | true | yes, 11,609 B | read |
| `get-fundraising-campaign-by-id` | 7 | true | yes, 6,675 B | read |
| `zepto-debug` | 4 | true | yes, 434 B | **a debug function in production** |

### Three findings

**`verify_jwt: false` on eight functions, including `delete-collection`.** For
`initiate-paystack-payment`, `verify-paystack-payment` and `scheduled-payment-recovery`
that is expected — contributors are anonymous, the callback is external, and cron
authenticates with the shared secret. For **`create-collection`, `update-collection`,
`update-collection-status` and `delete-collection` it is not obviously right.** They may
perform their own authorization internally — I did not read 33 KB of source to find out,
and I will not assert either way. **`Q-EF1`: verify that these four authenticate the
caller in code, since the gateway does not.**

**Local source may be stale.** Deployed versions are high, and the repository contains
`verify-paystack-payment.pre-download-2026-08-06` and `.stale-backup-2026-08-06` — direct
evidence that local diverged from deployed once and had to be re-downloaded. The
legacy estate's own incident record describes a merged fix that was not live three weeks
later. **A download-and-diff of all 13 is required to close D7 on evidence.** Commands
are in [production-backup-plan.md](production-backup-plan.md) §8.

**`zepto-debug` is deployed and active in production.** 434 bytes, `verify_jwt: true`.
Probably harmless, but a debug endpoint in a live financial system is worth a look.

### Dependencies

Each of the payment functions depends on `PAYSTACK_SECRET_KEY` as an Edge Function
secret, and `scheduled-payment-recovery` on the cron shared secret. **Edge Function
secrets are not in the database and are not captured by any dump** — they live in
project configuration and must be inventoried manually before access ends. Their
*values* are not needed for the new system, which gets fresh credentials; their
*names* are, so nothing is missed when the new functions are written.

---

## 4. Payout account encryption (Phase 10)

**Resolved. E-K1 is NOT blocked.**

| Question | Answer |
|---|---|
| Mechanism | **AES-256-CBC**, Node `crypto.createCipheriv` |
| Key derivation | **SHA-256 of a passphrase** (`createHash('sha256')`), giving the 32-byte AES key |
| Key reference | **`ACCOUNT_ENCRYPTION_KEY`** |
| Rotation slot | `ACCOUNT_ENCRYPTION_KEY_PREVIOUS` — **absent from `.env`**, so no rotation has occurred |
| Where the key is | `kolekto-be-old/.env` — **present and non-empty** (verified by presence check; value never read) |
| Supabase Vault | **empty — 0 secrets.** The key is not there |
| Database functions | **none** encrypt or decrypt these columns. All crypto is in application code |
| `pgcrypto` | installed, but **not used** for these columns |
| Affected records | **26 / 26** `payout_accounts` have ciphertext; **12 / 12** `user_identity` rows have both `nin_cipher` and `bvn_cipher` |

Four legacy investigation documents exist on this and are worth reading before any
decision: `ACCOUNT_ENCRYPTION_INVESTIGATION.md`,
`ENCRYPTION_BANK_WITHDRAWAL_INVESTIGATION.md`,
`PAYOUT_ENCRYPTION_DUPLICATE_AND_LOCAL_COLLECTION_FIX.md`,
`WITHDRAWAL_ENCRYPTION_INVESTIGATION.md` — all in `kolekto-be-old/docs/`.

### Can migration preserve ciphertext without decrypting?

**Yes.** `bytea` moves verbatim. The new system can hold the ciphertext, and
`account_last4`, `bank_code`, `bank_name` and `account_name` remain readable without any
key — so an account is identifiable to a human regardless.

### Does the new system need plaintext?

**No, and it should not have it.** The legacy withdrawals already happened; re-paying a
historical destination is not a supported operation. The new system will collect fresh
withdrawal accounts under its own controls. **Recommendation: preserve ciphertext plus
the readable metadata; never decrypt into the new database.**

### The real risk, and it is not the algorithm

> **The key exists in exactly one place: a git-ignored `.env` file on one machine.**

If that machine is lost, 26 bank-account ciphertexts and 12 NIN/BVN records become
**permanently undecryptable.** Nothing else holds the key — not Vault, not the database,
not any committed file.

**Action D8, and it is not optional:** copy `ACCOUNT_ENCRYPTION_KEY` into a proper
secret store (password manager or managed secret service) **before legacy access ends**,
recorded as archival material for historical decryption. This is a preservation action,
not a rotation.

### A minor secondary finding

`kolekto-be-old/.env.example` is **git-tracked** and contains a non-empty,
non-placeholder-looking 24-character value for `ACCOUNT_ENCRYPTION_KEY`.

**Checked: it differs from the value in `.env`.** So it is a sample or development
passphrase, not the production key. **Severity: LOW** — poor hygiene rather than
exposure, and worth replacing with an obvious placeholder so nobody mistakes it for a
real credential. Neither value was printed or recorded anywhere.

---

## 5. Secrets register — types and locations only

No value appears in this document or any artefact produced by this work.

| # | Type | Location | Severity | Action |
|---|---|---|---|---|
| 1 | Cron shared secret | `cron.job` command, jobid 5, legacy production | **HIGH** | Rotate. Readable by anyone who can select `cron.job`; authenticates a payment-recovery endpoint |
| 2 | Paystack **live** secret key | `kolekto-be-old/.env`, `.env.bak.pre-email-fix`, and 2 diffs in that repo's git history (commit `1f82604` added `prod.env`) | **HIGH** | Rotate, scheduled with a deploy |
| 3 | **`ACCOUNT_ENCRYPTION_KEY`** | `kolekto-be-old/.env` only | **HIGH — availability, not exposure** | **Archive to a secret store. Do NOT rotate** — rotating without re-encrypting makes 38 records undecryptable |
| 4 | Sample encryption passphrase | `kolekto-be-old/.env.example` (git-tracked) | LOW | Replace with an obvious placeholder |
| 5 | Edge Function secrets (`PAYSTACK_SECRET_KEY` and others) | Supabase project configuration, not the database | MEDIUM | Inventory names before access ends; values not needed |

**Item 3 is the one that is easy to get backwards.** The usual instinct on finding a key
in a `.env` is to rotate it. Here, rotating it **without re-encrypting the 38 affected
rows first** would destroy the ability to read them for ever. Archive first; rotate only
as part of a planned re-encryption, or never.
