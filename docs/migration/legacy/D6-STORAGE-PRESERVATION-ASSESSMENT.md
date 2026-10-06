# D6 — legacy production Storage preservation assessment

**Date:** 2026-09-27 · **Gate:** D6 · **Scope:** read-only assessment only

**No new connection to legacy production was made for this assessment.** Every bucket and
object figure below was derived by parsing `legacy-prod-storage-metadata.sql` and
`legacy-prod-public-data.sql` — the already-verified D1 backup files, re-checked against
`SHA256SUMS` (5/5 OK) both before and after this exercise. **Zero objects were downloaded,
moved, deleted, or modified. Zero buckets were created or reconfigured. Zero RLS changes.
Zero production writes of any kind.**

No object filename, personal name, or KYC document name appears anywhere in this report.
Where a filename's shape mattered, it was inspected and redacted before being reasoned
about — never printed.

## A. Executive summary

**The baseline holds exactly: 6 buckets, 68 objects, 24,424,830 bytes.** The four expected
populated buckets (`kyc-documents`, `avatars`, `campaign_assets`, `email-attachments`) are
populated; the two expected empty buckets (`campaign-images`, `campaign-documents`) are
empty. No correction to the baseline is needed.

**Every object that should be referenced, is.** Cross-referencing storage object identity
against the legacy database (by cryptographic hash, never by printing a path) found: all
53 `kyc-documents` objects resolve 1:1 through `kyc_files.file_path`; all but one `avatars`
object resolve through `profiles.avatar_url`; the one `campaign_assets` object resolves
through `collections.banner_url`; the one `email-attachments` object resolves through
`email_campaign_attachments.file_url`. **One avatar object is unreferenced. Zero broken
references. Zero objects tied to a deleted collection.**

**A separate, real finding: several legacy image fields store base64 data directly in the
database rather than in Storage** — `campaigns.main_image_url`, `campaign_images.image_url`,
`verification_documents.document_url`, and 3 of `collections`' 4 populated `banner_url`
values. These are already captured, byte-for-byte, inside the verified D1 backup
(`legacy-prod-public-data.sql`) — they are not at risk — but they will not be found by any
migration step that only looks at Storage.

**The KYC documents are the entire reason this gate cannot be closed today.** 53 objects,
18.82 MiB, high sensitivity, private bucket, readable today only by an admin role under
RLS. The new architecture has no KYC/identity-document destination of any kind yet, and
whether these documents may be retained, migrated, or must be destroyed is a legal question
this report does not answer — it was already flagged as blocked on counsel (**L-1**, **L-2**)
before this assessment, and remains so.

**Final classification: BLOCKED ON DECISION** — for the KYC subset specifically. The
non-KYC subset (15 objects, avatars/campaign-asset/email-attachment, ~4.7 MB) has no legal
blocker and needs only a founder go-ahead (**B5**) to proceed to preservation. See §J.

## B. Bucket inventory

| Bucket | Public? | Objects | Size (bytes) | Size (MiB / MB) | File size limit | Allowed MIME types |
|---|---|---|---|---|---|---|
| `avatars` | **true** | 13 | 4,033,319 | 3.85 / 4.03 | none | any |
| `kyc-documents` | **false** | 53 | 19,730,501 | 18.82 / 19.73 | none | any |
| `campaign_assets` | **true** | 1 | 648,829 | 0.62 / 0.65 | 10 MB | jpeg, png, webp, gif |
| `campaign-images` | **true** | **0** | 0 | — | 10 MB | jpeg, png, webp, gif |
| `campaign-documents` | **false** | **0** | 0 | — | none | any |
| `email-attachments` | **true** | 1 | 12,181 | 0.01 / 0.01 | 15 MB | any |
| **Total** | | **68** | **24,424,830** | **23.29 MiB / 24.42 MB** | | |

### Verified against the expected baseline

| Expected | Verified |
|---|---|
| 6 buckets | **6 — exact** |
| 68 objects | **68 — exact** |
| ~24.4 MB | **24,424,830 bytes.** The "~24.4 MB" figure used decimal megabytes (1,000,000 B); the same total is 23.29 MiB in binary units. **Both describe the same 24,424,830 bytes — not a discrepancy**, but stated in full here since the two conventions read as different numbers if not labelled. |
| Populated: `kyc-documents`, `avatars`, `email-attachments`, `campaign_assets` | **All four confirmed populated** — 53, 13, 1, 1 objects respectively |
| Empty: `campaign-documents`, `campaign-images` | **Both confirmed empty — 0 objects each** |

**Nothing in the expected baseline required correction.**

## C. Object classification

Per-bucket MIME-type breakdown, derived from `storage.objects.metadata->>'mimetype'` —
never from the object name.

| Category | Bucket | Count | Size | Public/Private | New-system destination? | Historical preservation? | Product migration? | Privacy/legal review? |
|---|---|---|---|---|---|---|---|---|
| **A. KYC / identity documents** | `kyc-documents` | 53 | 19,730,501 B (18.82 MiB) | **Private** | **No** — no KYC/identity-document table or bucket exists in the new schema | **Yes** — compliance record | **Not required** for the product to function; **relevant only** if the founder wants to carry forward already-verified organizers without re-KYC | **Yes — required, unresolved (L-1, L-2)** |
| **B. User avatars** | `avatars` | 13 | 4,033,319 B (3.85 MiB) | Public | **Yes** — `public.users.avatar_url` column already added (2026-09-18, M5), intentionally left unpopulated pending a real migration run | Optional — cosmetic | Optional — new users will upload fresh avatars regardless | No |
| **C. Campaign/collection assets** | `campaign_assets` | 1 | 648,829 B (0.62 MiB) | Public | **Partial** — a `collection-covers` bucket exists in the new schema (2026-09-20) for the equivalent purpose (collection flyers), but under a different name; needs a mapping decision, not a legal one | Optional — cosmetic | Optional | No |
| **D. Email attachments** | `email-attachments` | 1 | 12,181 B | Public | **No** — the email-campaign subsystem is classified legacy overflow (destination 4) in the existing migration matrix, not part of new-product scope | Low — one object, low value | Not required | No |
| **E. Other (empty buckets)** | `campaign-images`, `campaign-documents` | 0 | 0 | Public / Private | n/a — nothing to migrate | n/a | n/a | No |

**68 objects classified, 68 accounted for.** No object falls outside these four categories
plus the two empty buckets.

## D. KYC assessment

**Count:** 53 objects. **Total size:** 19,730,501 bytes (18.82 MiB). **Bucket:**
`kyc-documents`. **Current access classification:** bucket `public = false`; the *only*
`storage.objects` RLS policy naming this bucket is a `SELECT` policy restricted to
`authenticated` users where `public.is_current_user_admin()` — **there is no INSERT,
UPDATE, or DELETE policy for this bucket at all**, meaning no client role, admin or
otherwise, can write or remove a KYC object through the API; only a service-role-authenticated
path (which bypasses RLS) can. Objects are readable by an admin, writable by nobody through
the client API.

**Mimetype breakdown (metadata only, no filenames):** `image/jpeg` 37, `application/pdf` 8,
`image/png` 6, `image/webp` 1, `image/heic` 1.

**Metadata needed for migration planning:**
- Every object name begins with a UUID-shaped directory prefix (the standard
  `<owner-id>/<file>` Supabase Storage pattern) — confirmed by shape inspection, not by
  reading the name.
- `storage.objects.owner` is populated for only **2 distinct values** across all 53
  objects — this column does **not** reliably identify which person a document belongs
  to; these documents were uploaded through a shared upload path (consistent with a
  server-side/service-role upload flow), not per-user client sessions. **Do not use
  `storage.objects.owner` for KYC attribution.**
- The reliable attribution path is `kyc_files.file_path` → `kyc_files.document_id` →
  `kyc_documents.user_id`. This is exactly what §E's cross-check used, and it resolved
  all 53 objects.
- **44 `kyc_documents` rows, 21 `kyc_verifications` rows, spanning 21 distinct users.**
  Document type split: `identity` 31, `address` 13. Verification outcome split:
  `verified` 9, `rejected` 12. (44 documents ≠ 53 files because a document — e.g. one ID
  card — commonly has more than one physical file, front and back.)

**New architecture's KYC/document destination: does not exist.** No table or bucket for
identity verification appears anywhere in the current `kolekto` schema or migrations. This
was already known — `migration-destination-matrix.md` records `user_identity` as
**undecided, blocked on L-1 counsel**, and this assessment finds the same gap on the
Storage side: there is currently nowhere in the new product these 53 objects could even be
written to.

### Required determination — not made here, per instruction

| Question | Answer |
|---|---|
| Required for historical preservation? | **Likely yes** — these are the underlying evidence for KYC decisions already recorded (`verified`/`rejected`) in the legacy database, and destroying them would remove the ability to ever re-examine a disputed verification. |
| Required for migration? | **Not for the product to function.** Only relevant if the founder chooses to carry forward already-verified organizer status without requiring re-verification in the new system — a product decision, not a technical one. |
| Optional? | **No** — given the two answers above, this category is not safely optional; it is either preserved-with-restriction or destroyed-by-decision, not simply skippable. |
| Subject to a retention/legal decision? | **Yes — this is the determining question, and it is exactly L-1/L-2 as already recorded.** No legal or retention decision has been made. **This report does not make it.** |

## E. Database-reference cross-check

Method: every object's name was hashed (SHA-256); every candidate database column was
normalized (URL-decoded, Supabase Storage URL prefix stripped, or used as a bare path where
the column already stores one) and its hash compared against the object-name hash set for
the expected bucket. **No raw value from either side was printed at any point** — only
counts and yes/no membership results.

| Source column | Rows | Non-null | Resolves to a real object | Result |
|---|---|---|---|---|
| `kyc_files.file_path` → `kyc-documents` | 53 | 53 | **53** | 0 unreferenced, 0 broken |
| `profiles.avatar_url` → `avatars` | 622 | 12 | **12** | **1 avatars object has no referencing row (orphan)** |
| `collections.banner_url` → `campaign_assets` | 275 | 4 (3 are inline base64, not Storage) | **1** | The single `campaign_assets` object is referenced by exactly one **active** collection |
| `email_campaign_attachments.file_url` → `email-attachments` | 1 | 1 | **1** | Exact match |
| `campaigns.main_image_url` | 1 | 1 (inline base64) | n/a | Not a Storage reference |
| `campaign_images.image_url` | 1 | 1 (inline base64) | n/a | Not a Storage reference |
| `verification_documents.document_url` | 1 | 1 (inline base64) | n/a | Not a Storage reference |
| `collections.ticket_template_url` | 275 | 0 | n/a | Column unused |
| `collections.story_images` | 275 | 224 | n/a | **All 224 non-null values are empty arrays (`[]`), not image lists** — no real references, despite being "non-null" |

### Direct answers to the brief's five questions

- **Referenced objects: 67 of 68** (53 KYC + 12 avatars + 1 campaign asset + 1 email
  attachment).
- **Unreferenced objects: 1** — one `avatars` object with no current `profiles.avatar_url`
  pointing at it. Not KYC, not financially relevant.
- **Missing references (a DB value that should resolve but doesn't): 0.** Every non-inline,
  non-empty Storage-shaped reference found resolved to a real object.
- **Objects referenced by deleted collections: 0.** The only real (non-inline)
  `collections.banner_url` reference belongs to a collection with `status = 'active'`; none
  of the four populated `banner_url` rows belong to a `deleted` collection.
- **Objects associated with KYC records: all 53**, associated as described in §D
  (`kyc_files` → `kyc_documents.user_id`, 21 distinct users, never by `storage.objects.owner`).

### A finding beyond the brief's five questions, worth recording

**Not every "image" in this database lives in Storage.** `campaigns.main_image_url`,
`campaign_images.image_url`, and `verification_documents.document_url` each store a
base64-encoded `data:` URI directly in a text column — one is 1.7 MB of text, another
327 KB — and 3 of `collections`' 4 populated `banner_url` values do the same. **These are
already safely captured**, byte-for-byte, in the verified `legacy-prod-public-data.sql`
(the same file whose checksum was re-confirmed at the top of this report), so there is no
data-loss risk. The risk is a *planning* one: **a migration or audit step that inventories
"what needs to move" by listing Storage buckets alone will miss these entirely**, because
they were never Storage objects. Any future Storage-based migration tooling should be told
this explicitly, or it will silently under-count.

## F. Migration decision matrix

| Category | Count | Size | Sensitivity | Historical preservation | New-system migration | Decision needed |
|---|---|---|---|---|---|---|
| KYC / identity documents (`kyc-documents`) | 53 | 19.73 MB | **HIGH** | **PRESERVE** (pending scope decision) | **DEFER** | **LEGAL/FOUNDER DECISION** — L-1, L-2 |
| User avatars (`avatars`) | 13 | 4.03 MB | Low | **PRESERVE ONLY** | **DEFER** — destination column exists but is intentionally unpopulated until a real migration run | None — the technical path is already decided; only sequencing is open |
| Campaign/collection assets (`campaign_assets`) | 1 | 0.65 MB | Low | **PRESERVE ONLY** | **DEFER** — needs a bucket-name mapping decision (`campaign_assets` → `collection-covers`), not a legal one | Minor — founder/engineering naming decision, non-blocking |
| Email attachment (`email-attachments`) | 1 | 0.01 MB | Low | **PRESERVE ONLY** | **DEFER** — legacy overflow, out of new-product scope per the existing destination matrix | None |
| Empty buckets (`campaign-images`, `campaign-documents`) | 0 | 0 | n/a | n/a | n/a | None |
| Database-embedded images (not in Storage) | 6 rows across 3 tables | ~2.7 MB (inline) | Low | **Already preserved** — inside the D1 backup | **DEFER** | None — flagged for migration-tooling awareness only, per §E |

**No category is recommended for immediate `MIGRATE`.** The technically ready categories
(B, C, D) are `PRESERVE ONLY` / `DEFER` because nothing in this brief asked for an actual
migration decision today, and none of them has a live product dependency forcing one. Only
category A carries a `LEGAL/FOUNDER DECISION` that blocks even preservation of the objects
themselves in their current, unencrypted-in-place form.

## G. Security/privacy considerations

- **KYC objects are private and admin-read-only by RLS, with no client-writable path** —
  confirmed by direct policy inspection (§D). This is the correct posture and this
  assessment recommends no change to it.
- **`storage.objects.owner` must not be used to attribute KYC documents to individuals** —
  it reflects the upload mechanism (shared service-role path), not the document subject.
  Any future tooling that walks this column for KYC purposes will misattribute.
- **No object name, personal name, or KYC filename was printed anywhere in this
  investigation.** Every filename-shape observation (UUID-prefix pattern, extension,
  length) was obtained via classifiers that never surface the literal string, and every
  cross-reference used SHA-256 comparison rather than printed values.
- **The database-embedded base64 images (§E) carry the same sensitivity as any other image
  in this system** — one is a *campaign* verification image, not identity documentation,
  but should still be handled under the same "preserve, don't casually re-expose" posture
  as the rest of this estate, since it currently sits in plain text inside a SQL dump.
- **This report contains no secret.** No API key, JWT, connection string, or credential
  was read or referenced by this assessment — it never needed to connect to anything; it
  read only already-backed-up SQL text.

## H. Required founder/legal decisions

| ID | Decision | Blocks |
|---|---|---|
| **L-1** | Whether the 53 KYC/identity documents (and the underlying `user_identity` NIN/BVN ciphertext) may be retained, for how long, and under what access restriction | Preservation of category A beyond the current unencrypted backup; any migration of KYC status |
| **L-2** | Whether KYC Storage objects require a distinct backup/encryption mechanism given their content (identity documents, not just metadata) | Encrypting/copying category A as part of the secure-preservation step already pending for the D1 backup |
| **B5** *(founder, not legal)* | Approval to preserve the **non-KYC** Storage objects (avatars, campaign asset, email attachment — 15 objects, 4.69 MB) the same way the D1 database backup was preserved | Preservation of categories B, C, D |
| *(new, founder/engineering, non-blocking)* | Whether `campaign_assets`/`campaign-images` map onto the new `collection-covers` bucket, or are treated as legacy-overflow-only like the email attachment | Nothing today; only relevant if/when collection asset migration is scoped |

**This report makes none of these decisions.** It provides the facts (counts, sizes,
access classification, reference integrity) each decision needs.

## I. Exact next actions

1. **Nothing storage-related should happen until L-1 and L-2 are answered.** No download,
   no copy, no encryption of the KYC objects specifically.
2. **The non-KYC 15 objects (4.69 MB) could be preserved today** the same way the D1
   database backup was — as a read-only, checksummed copy outside every repository — **once
   B5 is explicitly granted.** This assessment does not grant it.
3. **When B5 is granted:** download avatars, `campaign_assets`, and the one email attachment
   (read-only `storage.download`/CLI equivalent), checksum, and place alongside the existing
   `Kolekto-Preservation/2026-09-27-busfgcmbndleljklrcbd/` artefact — not inside it, since
   it is a distinct backup with distinct sensitivity.
4. **Flag the database-embedded base64 images (§E)** to whoever eventually writes migration
   tooling, so a Storage-only inventory step doesn't silently miss them — they are already
   safe, but easy to overlook.
5. **The one orphaned avatar object** needs no action; it is not evidence of anything
   broken, only of a profile whose avatar reference changed or was cleared after upload.

## J. Final classification

# BLOCKED ON DECISION

**For the KYC subset (53 objects, 18.82 MiB): blocked**, on L-1 and L-2, exactly as already
recorded before this assessment. This assessment adds no new blocker — it confirms the
existing one is still the binding constraint, and adds the access-policy and attribution
detail (§D) that whoever makes L-1/L-2 will need.

**For the non-KYC subset (15 objects, 4.69 MB): not blocked on anything legal.** It is
ready for the same preservation step already pending for D1, contingent only on B5 — a
founder go-ahead, not a legal review.

The gate is reported as a whole as **BLOCKED ON DECISION** because the majority of the
data by sensitivity (and the reason this gate exists at all) is the KYC subset, and no
partial "mostly ready" status would be honest about that.

---

## Safety validation

- **Zero objects downloaded.** No `storage.download`, no signed-URL fetch, no object body
  was ever requested. Every figure in this report came from `storage.objects` **metadata**
  (name, bucket, size, mimetype) already present in the D1 backup.
- **Zero objects modified, moved, or deleted.** No `storage.objects` write of any kind was
  issued.
- **Zero bucket configuration changes.** No `storage.buckets` insert/update, no RLS policy
  change — the policies quoted in §D were read from the existing schema dump, not created.
- **Zero production writes.** No connection to legacy production was opened for this task
  at all; every command operated on local files.
- **No personal data in this report.** No object filename, no KYC document name, no
  contributor or organizer name appears anywhere above. Where filename structure mattered,
  only shape (length, extension, UUID-prefix pattern) was reported.
- **No secrets in this report.** Nothing in this task read or referenced a credential.

Re-verified after the assessment, confirming the backup files themselves are unchanged:

```
legacy-prod-auth.sql: OK
legacy-prod-cron.sql: OK
legacy-prod-public-data.sql: OK
legacy-prod-schema.sql: OK
legacy-prod-storage-metadata.sql: OK
```

### Git status

```
?? docs/migration/legacy/D6-STORAGE-PRESERVATION-ASSESSMENT.md
```

Only this new report is untracked. Nothing else in the repository changed.

**Not committed, per instruction. Stopping here.**
