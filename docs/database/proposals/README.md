# M13.2 SQL proposals

**Nothing in this folder is a migration, and nothing here has been applied anywhere.** Applying any of it
needs its own approval, per environment.

| File | Status |
|---|---|
| `M13.2-FINAL-worker-role.proposed.sql` | **Current.** Narrows the queue `UPDATE` to `vt`, `read_ct`, `headers` |
| `M13.2-FINAL-pause-switch-enforcement.proposed.sql` | **Current.** Same function as the P8 file, with the corrected test inventory |
| `M13.2-P8-worker-role.proposed.sql` | **Superseded. Do not apply.** Grants table-wide `UPDATE` on the queue |
| `M13.2-P8-pause-switch-enforcement.proposed.sql` | **Superseded. Do not apply.** Its test-impact list is wrong |

The two P8 files are kept byte for byte because the sealed Phase 8 reports pin their SHA-256 and they have
never been committed, so an edit would destroy the version those reports describe. See
`docs/database/M13.2-FINAL-CORRECTIONS-REPORT.md`.

> **2026-11-09:** the three current M13.3 files below (`M13.3-COMMUNICATION-POLICY`, `MEMBER-ANNOUNCEMENTS`, `M13.3-R3-SEND-TIME-RECHECK`) and their tests were promoted to `supabase/migrations/20261109100000…100200` and `supabase/tests/49–51` and applied to the local stack only. The rows below describe them as they were while proposals; they no longer exist in this folder. Not applied to staging or production.

## Member collection announcements (2026-11-07)

| File | Status |
|---|---|
| `MEMBER-ANNOUNCEMENTS.proposed.sql` | **Current (revised M13.3 R2). Awaiting approval.** Member-record email eligibility for collection announcements, organiser preview counts, explicit `collection.announce_update` action, trigger update. Consent gate removed; community notice attestation and member choices honoured. **Apply after** `M13.3-COMMUNICATION-POLICY.proposed.sql`. See `docs/product/MEMBER-NOTIFICATIONS-IMPLEMENTATION-REPORT.md` and `docs/product/M13.3-R2-DATABASE-POLICY-PROPOSAL-REPORT.md`. Also requires `grant execute` lines for the worker role (listed in its header); `M13.2-FINAL-worker-role.proposed.sql` is not edited because its hash is pinned. |
| `MEMBER-ANNOUNCEMENTS.proposed.test.sql` | **Current (revised M13.3 R2).** pgTAP, 35 assertions; becomes `supabase/tests/50_…`. Passed 35/35 on the isolated `kolekto-itest` stack (R2-verify). |
| `MEMBER-ANNOUNCEMENTS.M13.2-v1.superseded.sql` / `.superseded.test.sql` | **Superseded. Do not apply.** The M13.2 version (consent gate), kept byte for byte (SHA-256 `15bf5d63…4f84` / `653f18bc…ef64a`). |

## M13.3 community communication policy (2026-11-07)

| File | Status |
|---|---|
| `M13.3-COMMUNICATION-POLICY.proposed.sql` | **Current. Awaiting approval. Apply FIRST.** Policy matrix function, `communication.attest_notice` permission, append-only attestation and member-choice stores with their functions, `notification_deliveries.communication_category`, legacy comment on `members.consent_messages_at`. Worker grant: `app.community_communication_notice_attested(uuid)` (header). See `docs/product/M13.3-R2-DATABASE-POLICY-PROPOSAL-REPORT.md`. |
| `M13.3-COMMUNICATION-POLICY.proposed.test.sql` | **Current.** pgTAP, 89 assertions (87 + 2 added at R2-verify); becomes `supabase/tests/49_…`. Passed 89/89 on the isolated `kolekto-itest` stack (R2-verify, 2026-11-07). |
| `M13.3-R3-SEND-TIME-RECHECK.proposed.sql` | **Current. Awaiting approval. Apply THIRD** (after the policy and announcements files). Event→category map, `app.recheck_delivery_eligibility(uuid)`, and `app.reserve_email_attempt` re-created with the recheck first (body generated from `20261024200000`; byte-identical otherwise, enforced by `apps/worker/test/communication-policy-sql-parity.test.ts`). No new worker grant. Applied to the isolated `kolekto-itest` stack only (2026-11-09). |
| `M13.3-R3-SEND-TIME-RECHECK.proposed.test.sql` | **Current.** pgTAP, 41 assertions; becomes `supabase/tests/51_…`. Passed 41/41 on `kolekto-itest`. |
