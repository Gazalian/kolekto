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
