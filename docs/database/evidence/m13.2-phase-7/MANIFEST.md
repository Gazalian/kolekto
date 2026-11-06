# M13.2 Phase 7 Evidence Manifest

Results and reasoning are in `docs/database/M13.2-PHASE-7-IMPLEMENTATION-AND-ACCEPTANCE-REPORT.md`. Target: the `kolekto-itest` stack only. Branch `fix/auth-nav-and-cookie-forwarding`, HEAD `ee9462b`.

| Folder or file | Contents |
|---|---|
| `phase-a/` | Baseline: 6B-2 checksum check, Git, protected paths, stack, Mailpit, all before any change |
| `phase-b/` | Output of `itest:worker-role` |
| `method/` | The scripts and queries behind the readings. Method, not results |
| `lane/` | TAP output, times and exit codes, and before-and-after state and Mailpit readings per run. Failed attempts are kept |
| `runtime/<run tag>/` | Per-run `readings.jsonl` and `worker-logs/`, each log scanned before being stored |
| `independent-readings.txt`, `final-*`, `ledger-snapshot-before-purge.txt`, `mailpit-sample.txt` | Readings taken after the runs, independent of the tests |
| `secret-scan.txt` | Key names and counts only |
| `SHA256SUMS.txt` | Checksums of every file here except this manifest and itself |

Run tags in order: `4c19a8d5` attempt 1, `04c98ad8` attempt 2, `9a730c3b` attempt 3, `8b24c4f8` final pass 1, `08fd5a5d` final pass 2, `86d85144` final pass 3, `4e20d0e7` full lane, `a94b745c` final pass 4.
