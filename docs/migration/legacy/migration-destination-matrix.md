# Migration destination matrix — all 53 legacy production tables

**Rule (F-M3): zero data loss.** Every table has a destination. No row is "not
migrated" without an explicit founder approval, and none is.

**Destinations:** `1` new operational · `2` new historical/imported · `3` migration
table · `4` legacy overflow · `5` explicitly not migrated (founder-approved).

**Provenance for every imported row:** `source_table`, `source_id`, `import_run_id`,
`imported_at`, `is_imported`, plus `source_project` once **E-P1** lands.

**Delta class** is from
[live-production-delta-strategy.md](live-production-delta-strategy.md) §2.

---

## 1. Identity and access

| Table | Rows | Purpose | Dest | Strategy | Delta class | Loss risk | Blocker |
|---|---|---|---|---|---|---|---|
| `auth.users` | 623 | Authentication | **1** | Direct, **UUIDs preserved** | SAFE_BY_UPDATED_AT | **HIGH if UUIDs change — uncorrectable** | — |
| `profiles` | 622 | User profile | **1** → `public.users` | Core fields direct; extras to `legacy_profile` | SAFE_BY_UPDATED_AT | low | — |
| `profiles` (13 without phone) | 13 | — | **1** | Preserve; roll status open | — | **must not be deleted** | **F-M1** |
| `admin_users` | 2 | Staff accounts | **4** | `staff_users` unbuilt | SAFE_BY_CREATED_AT | low | — |
| `admin_events` | 71 | Staff audit | **4** | Verbatim | SAFE_BY_CREATED_AT | low | — |
| `user_identity` | 12 | **NIN/BVN ciphertext** | **undecided** | Ciphertext preservable without the key | SAFE_BY_UPDATED_AT | **HIGH — compliance** | **L-1 counsel** |

## 2. Collections

| Table | Rows | Purpose | Dest | Strategy | Delta class | Loss risk | Blocker |
|---|---|---|---|---|---|---|---|
| `collections` | 275 | Core object | **1** + **2** | One community per organizer; `amount`×100 → kobo; `collection_type` authoritative (**F-L3**) | SAFE_BY_UPDATED_AT | medium | **F-L1** |
| `collections` (12 `deleted`) | 12 | Soft-deleted | **2** | `archived` + `archived_at`; legacy has no deletion timestamp | — | medium | **E-COL-1** |
| `collections.price_tiers` | 305 entries / 79 collections | Tiers | **1** → `collection_tiers` | Rows, not jsonb; original array kept verbatim | — | **HIGH — 5 collections blocked** | **F-L4** |
| `collections.contributions_fields` | — | Custom fields | **1** → `collection_fields` | Key must match `^[a-z][a-z0-9_]{0,38}$` | — | low | — |
| `collections.slug` | 275 | URLs | **1** + `legacy_links` | Old links must resolve | — | medium | — |
| `contribution_code_counters` | 53 | Code sequence | **1** → `collection_code_sequences` | **Seed `next_number`** so reissued codes cannot collide | SAFE_BY_UPDATED_AT | medium | — |
| `collection_access_grants` | 0 | Sharing | **4** | — | SAFE_BY_CREATED_AT | low | — |
| `collection_access_invites` | 0 | Sharing | **4** | — | SAFE_BY_CREATED_AT | low | — |
| `collection_access_invite_items` | 0 | Sharing | **4** | — | **REQUIRES_FINAL_SNAPSHOT** | low | — |
| `collection_transfer_requests` | 0 | Ownership transfer | **4** | No equivalent | SAFE_BY_CREATED_AT | low | — |

## 3. Financial — nothing becomes live financial truth

**The import posts zero ledger journals and zero ledger entries (D-23).**

| Table | Rows | Purpose | Dest | Strategy | Delta class | Loss risk | Blocker |
|---|---|---|---|---|---|---|---|
| `contributions` | 5,576 | **Applied payments** | **3** `legacy_contribution` | Verbatim; status kept as the legacy word | SAFE_BY_UPDATED_AT | **HIGH — financial history** | — |
| `deposits` (attributed) | 4,884 | Provider transactions | **3** `legacy_deposit` | Verbatim | **IMMUTABLE — frozen since 2026-06-16** | **HIGH** | — |
| `deposits` (unattributed) | **1,317** | **₦28.9m, 923 success = ₦19,799,220** | **3** `unattributed_payments` | **No `collection_id` column exists — attribution impossible by construction** | IMMUTABLE | **HIGH** | — |
| `withdrawals` | 292 | Money out, ₦46,682,872.80 | **3** `legacy_withdrawal` | **To create (F-M2).** Preserve `approved`/`success` verbatim (**F-L5**) | SAFE_BY_UPDATED_AT — **re-extract all 292** | **HIGH** | **E-W1** |
| `wallets` | 245 | **Mutable cache** | **2/4** | Preserved as history. **NEVER an opening balance.** ₦3.59 drift | **REQUIRES_SPECIAL_HANDLING** — rewritten nightly | **HIGH if misused** | — |
| `wallets_backup_20260805` | 240 | Forensic snapshot | **4** | Verbatim | IMMUTABLE | medium | — |
| `pending_payment_context` | 797 | **Live payment state machine** | **4** | Verbatim. **Do NOT seed `payment_attempts`** | SAFE_BY_UPDATED_AT — **delta-critical** | **HIGH — actively growing** | — |
| `payout_accounts` | 26 | Bank destinations | **4** + later `withdrawal_accounts` | **Preserve ciphertext**, never decrypt into the new DB | SAFE_BY_UPDATED_AT | medium | **D8 key archival** |
| `transfer_recipients` | 52 | **Plaintext** bank details | **4** | **Redact to bank + last 4** | SAFE_BY_CREATED_AT | medium | **L-3** |
| `settlement_runs` | 56 | Nightly job audit | **4** | Verbatim | **REQUIRES_FINAL_SNAPSHOT** | low | — |
| `payment_recovery_log` | 30,242 | Recovery attempts | **4** | Verbatim; largest table | SAFE_BY_CREATED_AT | low | — |
| `payment_admin_actions` | 220 | Staff interventions | **4** | Real audit value | SAFE_BY_CREATED_AT | medium | — |
| `payment_reference_backfill_snapshot_20260811` | 3,324 | Forensic | **4** | Verbatim | IMMUTABLE | medium | — |
| `duplicate_void_snapshot_20260812` | 12 | Forensic | **4** | Relates to 14 `duplicate_voided` | IMMUTABLE | medium | — |

## 4. Compliance

| Table | Rows | Purpose | Dest | Delta class | Loss risk | Blocker |
|---|---|---|---|---|---|---|
| `kyc_verifications` | 21 | Verification state | **4** | SAFE_BY_UPDATED_AT | medium | **L-1** |
| `kyc_documents` | 44 | Document records | **4** | SAFE_BY_UPDATED_AT | medium | **L-1** |
| `kyc_files` | 53 | File references — **matches the 53 storage objects** | **4** | **REQUIRES_FINAL_SNAPSHOT** | medium | **L-1/L-2** |
| `kyc_verification_history` | 55 | Audit trail | **4** | **REQUIRES_FINAL_SNAPSHOT** | medium | **L-1** |
| `verification_documents` | 1 | Campaign verification | **4** | **REQUIRES_FINAL_SNAPSHOT** | low | **L-1** |

## 5. Subsystems with no new equivalent

| Table | Rows | Purpose | Dest | Delta class | Note |
|---|---|---|---|---|---|
| `campaigns` | 1 | **Parallel fundraising entity** | **4** | SAFE_BY_UPDATED_AT | **F-L2**: collection, or history only? |
| `campaign_donations` | 0 | Campaign payments | **4** | SAFE_BY_UPDATED_AT | financial shape, currently empty |
| `campaign_images` | 1 | Campaign media | **4** | SAFE_BY_CREATED_AT | — |
| `campuses` | 46 | Campus directory | **4** | **REQUIRES_FINAL_SNAPSHOT** | **non-uuid PK; sequence at 2 while 46 rows exist — preserve explicit ids** |
| `students` | 1 | Student directory | **4** | **REQUIRES_FINAL_SNAPSHOT** | non-uuid PK |
| 6 × `ambassador_*` | 2 | Referral programme | **4** | mixed | **`ambassador_profiles.pin_hash` excluded per policy** |
| `notifications` | 172 | In-app | **4** | SAFE_BY_CREATED_AT | `read_at` changes are not tracked |
| `push_subscriptions` | 13 | Web push | **4** | SAFE_BY_UPDATED_AT | **endpoint keys — redact** |
| `push_notification_events` | 173 | Push log | **4** | SAFE_BY_UPDATED_AT | — |
| 8 × `email_*` | 4,839 | Campaign engine | **4** | mixed | **`email_unsubscribes` is suppression data — compliance-relevant even at 0 rows** |
| `password_change_otps` | 6 | OTP | **4** | SAFE_BY_CREATED_AT | short-lived; preserved anyway |
| `password_reset_otps` | 0 | OTP | **4** | SAFE_BY_CREATED_AT | — |

---

## 6. Coverage check

| Destination | Tables |
|---|---|
| 1 — new operational | 7 |
| 2 — new historical/imported | 3 (overlapping with 1) |
| 3 — migration table | 4 |
| 4 — legacy overflow | 38 |
| 5 — explicitly not migrated | **0** |
| **Undecided** | **1** (`user_identity`, blocked on L-1) |

**53 of 53 tables accounted for.** One destination is undecided rather than missing, and
it is blocked on counsel, not on engineering.

## 7. Fields excluded from the copy — and why that is not data loss

Three narrow categories. In each case the **source row remains intact** in legacy
production, which is read-only and retained.

| Excluded | Reason |
|---|---|
| `ambassador_profiles.pin_hash` | A credential for an unbuilt subsystem. Copying multiplies where it can leak |
| `transfer_recipients.account_number` (plaintext) | The same data exists encrypted in `payout_accounts`. Carrying plaintext forward is a step backwards |
| `withdrawals.destination_account` (full jsonb) | Redact to bank + last 4. **L-3** |
| `push_subscriptions` endpoint keys | Push credentials with no purpose in the new system |

**This list must not grow by convenience.** It is limited to credentials and account
numbers.

## 8. Blockers

| Class | IDs | Count |
|---|---|---|
| **Founder** | F-M1, F-L1, F-L2, F-L4, F-L5, F-L6, E-COL-1 | 7 |
| **Legal** | L-1 (`user_identity`/KYC), L-2 (KYC storage), L-3 (bank details) | 3 |
| **Engineering** | E-W1, E-O1, E-P1, D8 (key archival) | 4 |
| **Resolved since the last report** | **E-K1** — key found, AES-256-CBC, `ACCOUNT_ENCRYPTION_KEY` | 1 |

**F-L3 and F-L5 are now decided** (per the founder decisions in this brief) and are
reflected above.
