# M13.2 Phase 8 Evidence Manifest

Results and reasoning are in `docs/database/M13.2-PHASE-8-IMPLEMENTATION-AND-ACCEPTANCE-REPORT.md`. Target: the `kolekto-itest` stack only. Branch `fix/auth-nav-and-cookie-forwarding`, HEAD `ee9462b`.

| Folder or file | Contents |
|---|---|
| `phase-a/` | Baseline before any change: Git, earlier evidence checksums, stack status, state, Mailpit, worker statement timings |
| `f13/` | `net` catalog before and after, lockdown output, final catalog, role memberships, and the rollback SQL, which was prepared and not applied |
| `ledger-guard/` | Ledger reading behind the guard decision |
| `method/` | The scripts and queries behind the readings. Method, not results. `state.sql`, `independent-evidence.mjs`, `secret-scan.mjs` and `protected-hash.mjs` are unchanged copies from earlier phases |
| `lane/` | TAP output, times and exit codes, and before-and-after state and Mailpit readings per run, including the refused full lane. Also the unit suite |
| `runtime/<run tag>/` | Per-run `readings.jsonl` and `worker-logs/`, each log scanned before being stored |
| `independent-readings.txt`, `final-*`, `itest-status-after.txt`, `protected-hash-after.txt`, `git-porcelain-after.txt` | Readings taken after the runs, independent of the tests |
| `secret-scan.txt` | Key names and counts only |
| `SHA256SUMS.txt` | Checksums of every file here except this manifest and itself |

Run tags in order: `ac3f2fb2` reliability attempt 1; `1b8ec960` reliability, then `74006e5c` Phase 7 runtime, in pass 1 of `--worker-runtime`; `b1080bd7` reliability pass 2. The refused full lane left no run tag folder, because no file got past its preflight.
