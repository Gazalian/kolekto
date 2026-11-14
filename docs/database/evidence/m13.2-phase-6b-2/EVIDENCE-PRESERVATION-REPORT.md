# M13.2 Phase 7, Stage 1 — Phase 6B-2 Evidence Preservation Report

> Date 2026-11-05, copied 16:50:48 UTC. Branch `fix/auth-nav-and-cookie-forwarding`, HEAD `ee9462b` (unchanged).
> Scope: evidence preservation only. Inputs read: the Phase 6B-2 report, the Phase 7 design report, `apps/worker/test/support/itest-env-file.ts`.

## 1. Result

**Eight original files were preserved byte for byte. No secret or personal data was found, so no sanitised copy was needed.**

**The evidence is only partly complete.** The TAP output, the independent E2E database readings and the final state and budget readings were saved. The Mailpit output, the preflight "before" readings and the `pg_stat_statements` readings were never saved to a file, so they cannot be preserved (§5).

**The copies are not yet permanent.** They are untracked files, so they are not in Git history and `git clean` would remove them. They become durable only when committed, and that decision is yours.

| Requirement | Status | Where |
|---|---|---|
| 1. Complete TAP output, all seven files | **Preserved** | `lane-output.txt`, `lane-times.txt` |
| 2. Independent database E2E evidence | **Preserved** | `e2e-evidence.txt` lines 2–9, read with `e2e.sql` |
| 3. Mailpit verification evidence | **Not available.** Only the script exists | `mailpit-read.mjs`; see §5 |
| 4. Final database state and budget | **Preserved, after-run values only** | `e2e-evidence.txt` lines 10–34; see §5 |
| 5. Manifest | **Created** | `MANIFEST.md` |

## 2. Files located

The reported temporary directory is still valid, and the files were at that path:

`C:\Users\USER\AppData\Local\Temp\claude\d537c9a05cfe2b27\7963d5c2-e56e-4c8c-9cab-56257516cbff\scratchpad\`

It holds eight files, all copied. Three searches looked for other copies or for the missing outputs:

| Search | Result |
|---|---|
| Exact names `lane-output.txt`, `e2e-evidence.txt`, `lane-times.txt` across the user's whole `AppData\Local\Temp` | Only the paths above |
| Content search under `Temp\claude` for the run tag, the community id and the delivery id | Only `e2e-evidence.txt` |
| Content search under `docs/` for the run tag | The 6B-2 report, the Phase 7 report and the new copy only |

Older scratchpad files with "mailpit" in their names exist, but they predate this run and do not contain its run tag. They were not opened or copied.

## 3. Files preserved and checksums

All eight are in this folder. "Matches" compares the copy with the original, using SHA-256 computed separately for each.

| File | Bytes | SHA-256 | Matches |
|---|---:|---|---|
| `lane-output.txt` | 15115 | `debf50aa4af76aa2d0b148dcd66f053d1903adfd0443caaeeca2dd9d068cd3f0` | Yes |
| `lane-times.txt` | 65 | `24c4d13a72ba002fb8f446553f486d941dee5ecf0fed9e28ee16a2248b5f6d7a` | Yes |
| `e2e-evidence.txt` | 2077 | `6d9d6d907763e2e3d10969e70c1d8fae240be35543e65b1824a601fe803b4213` | Yes |
| `e2e.sql` | 4112 | `3301116a13043dd3d5a9fd70a814565d56b9d374b7265ac1e849312dc1219a12` | Yes |
| `state.sql` | 3238 | `239f9908a615415db9c17abd80b67a7006d1f7029346e288d7780781e57e07e9` | Yes |
| `mailpit-read.mjs` | 1792 | `00a5cdeb88b1bbd9fb5bccdaada7afd426ebe2a968575f02c89fb85eed602e7d` | Yes |
| `protected-hash.mjs` | 1122 | `14a352e6e500fb20d4128fef7168690f3757d9f9b529ee837c193d9de167b528` | Yes |
| `gate-probe.ts` | 3468 | `491b8fcce3d0704975ae944ed8a7488bf86879f43ee3556a4810f6adc9ed764d` | Yes |

The brief named only the two evidence files. The other six were included because the Phase 7 report §14 recommended them: `lane-times.txt` holds the lane's exit code, `e2e.sql` is needed to read the unlabelled evidence, and the scripts record how the readings were taken. They are labelled as method files in the manifest.

**Originals unchanged.** For all eight, size, creation time, last-write time and SHA-256 were the same before and after copying.

**Chain of custody.** The Phase 7 report, written at about 16:33 UTC, recorded hash prefixes for two files: `debf50aa4af76aa2…` and `6d9d6d907763e2e3…`. Both match. The other six were first hashed in this task, so nothing earlier confirms they are unchanged since the run. Their timestamps are consistent with the run. Filesystem timestamps are supporting evidence, not proof.

**TAP content, checked on the copy.** 7 of 7 root suites `ok`, plan `1..7`, no `not ok` line, no `# SKIP` or `# TODO` directive. Summary: tests 41, suites 9, pass 41, fail 0, cancelled 0, skipped 0, todo 0. Final line: `Integration lane passed: 41/41 test(s) in 7 file(s), none skipped.` `lane-times.txt` records exit 0.

**Line endings.** All eight files are LF only. The repository's `* text=auto eol=lf` rule therefore keeps them byte-identical through a commit and checkout, even with `core.autocrlf=true`. This comes from reading the settings; no commit was made to test it.

## 4. Security scan

Three checks ran on each original **before** copying, and scripted checks 1 and 2 ran again on the copies. No matched value was displayed by the scripted checks.

1. **Pattern scan, counts and line numbers only.** Connection URLs, credentials in URLs, password, secret, token, API key, authorization headers, JWT shape, private keys, AWS, payment-provider, Supabase and vendor tokens, production and staging project refs, environment assignments, `.env` references, stack ID, long hex and base64 strings, Nigerian and international phone numbers, public IP addresses, Windows user paths, and email addresses.
2. **Exact comparison with `.env.itest`, in memory.** A script read the file and counted its values in each evidence file, including the URL-encoded, base64 and hex forms and the password part of the database URL. It printed key names and counts only. `.env.itest` was not copied or changed: 444 bytes, last write 2026-11-04 14:56:51 UTC, before and after.
3. **Full read of all eight files**, because pattern scans miss context.

### Exact comparison

| `.env.itest` value | Occurrences in all eight files |
|---|---|
| `KOLEKTO_ITEST_DB_URL`, whole value | 0 |
| Database password | 0 |
| `KOLEKTO_ITEST_STACK_ID` | 0 |
| `KOLEKTO_ITEST_SMTP_PORT` | 0 |
| `KOLEKTO_ITEST_MAILPIT_API` | 1, in `mailpit-read.mjs` line 2. A loopback address that needs no credential and is already published in the 6B-2 report. Not a secret |

### Pattern hits, each one reviewed

| File | Line | Hit | Finding |
|---|---|---|---|
| `lane-output.txt` | 2 | Email shape on a non-test domain | **False positive.** The npm banner's package spec, `@kolekto/worker@0.0.0`. No person involved |
| `lane-output.txt` | 83, 84 | "token" | Test name ("live token"). No value |
| `e2e-evidence.txt` | 8 | Two email shapes | Synthetic: the recipient is on a `.test` domain and the Message-ID is on `.invalid` |
| `e2e-evidence.txt` | 8 | 32-digit hex string | The Message-ID. Recomputed here as the first 32 hex digits of SHA-256 of the delivery id, and it matches. Not a secret |
| `e2e.sql` | 9, 18 | "token" | Column name `send_lease_token`. The value is empty in the output, `e2e-evidence.txt` line 8 |
| `state.sql` | 12 | "token" | The same column name. The output was not saved |
| `gate-probe.ts` | 3 | "password", "stack ID" | Comment saying they are not printed |
| `gate-probe.ts` | 15 | `.env` | `process.env`, not a file |
| `gate-probe.ts` | 20 | `KOLEKTO_ITEST_` variable | The constant flag `KOLEKTO_ITEST_REQUIRED`. Not a secret |
| `gate-probe.ts` | 31 | "stack ID" | Prints only a yes or no for whether it is set |
| `mailpit-read.mjs` | 26 | `+234` | A check for the prefix. No phone number |

No hits in any file for: connection URLs, credentials in URLs, password assignments, JWTs, private keys, AWS, payment, Supabase or vendor tokens, production or staging refs, environment assignments, phone numbers, public IP addresses or Windows user paths. `lane-times.txt` and `protected-hash.mjs` had no hits at all.

### Result

**Secrets: none. Real email addresses: none. Phone numbers: none. Other personal data: none found.** No `.env` file, credential or Claude transcript was copied.

### Limits of the scan

- `.env` and `.env.local` were not opened, so their values were not compared by exact match. Only the patterns and the full read cover them.
- The names and ids are treated as synthetic because they are run-tagged, the names are placeholders ("E2E Owner", "E2E Member a28187cc"), and `e2e-evidence.txt` line 31 shows all 129 communities are `itest-*`. The UUIDs were not checked against a database, which this task forbids.
- These checks cover the eight files as listed. They are strong evidence that no sensitive data is present, not a mathematical proof.

## 5. Files not preserved, and why

**No file was withheld for safety.** The gaps below exist because the output was printed to a terminal in the 6B-2 session and never saved to a file.

| Evidence | Status | What remains | Effect |
|---|---|---|---|
| Mailpit output: before and after counters, message list, headers, text and HTML bodies, Message-ID match, `+234` check | **Unavailable** | Transcribed in the 6B-2 report §5; `mailpit-read.mjs`. `e2e-evidence.txt` line 8 independently shows the recipient and stored provider message id | The §5 Mailpit claims, and test-stated Mailpit items 9, 10 and 12, rest on the report and the passing test, not on a raw reading |
| `pg_stat_statements` readings | **Unavailable** | Transcribed in the 6B-2 report §4. `e2e-evidence.txt` line 34 shows only that the extension exists | The "Read" evidence for items 1, 13 and 14 has no raw record |
| Preflight "before" readings, including budget 63 | **Unavailable** | Transcribed in the 6B-2 report §1 and §7; `state.sql` | The 22-grant increase is supported directly by `ledger_since_start` = 22 on line 27. L4 before the run is only in the report |
| Gate probe output | **Unavailable** | Transcribed in the 6B-2 report §1; `gate-probe.ts` | Report only |
| Re-read at 16:13:57 UTC | **Unavailable** | Mentioned in the 6B-2 report §7 | The 16:12:25 reading is preserved |
| Git and protected-path baselines from the run | **Unavailable** | Transcribed in the 6B-2 report §9 | The aggregate was re-computed in this task; see §7 |

The 6B-2 session transcript may contain some of this output. It was not opened or searched, as instructed. Re-reading Mailpit or the database now would give new readings of a later state, not the original evidence, and connecting to the database is forbidden here.

## 6. Restrictions observed

- Supabase not started or stopped. No database connection. No Mailpit, SMTP or Docker call.
- No integration or unit test, worker, typecheck, build or maintenance run. No reset.
- `email_sending_enabled` and queue contents not touched.
- Source and migrations not modified. Nothing staged, committed, pushed or deployed.
- The scratch scanners stay outside the repository, in this session's scratchpad.

**`.ts` and `.mjs` under `docs/`.** Nothing should pick up the copied scripts: the root `tsconfig.json` has `files: []`, `apps/worker/tsconfig.json` includes only `src` and `test`, and the root `lint` script covers `apps/web` only. This comes from reading the configuration; typecheck and lint were not run.

## 7. Final Git status

| Item | Value |
|---|---|
| Branch / HEAD | `fix/auth-nav-and-cookie-forwarding` / `ee9462b07997afb2419bfd18d6e397f33d8cfcc2` |
| `stash@{0}` | `On m8.1-financial-foundation: pre-m13.1: unstaged M12A work`, one entry |
| `6de78db`, `55c358d` | Both `commit` |
| Index | Empty |
| Porcelain before this task | 54 lines, MD5 `f9b84f8ce3d08abbc225d12e22be9dca` |
| Porcelain after this task | 55 lines, MD5 `167b9f0164441a865349434dab26b9c6` |
| Porcelain after, without the new line | `f9b84f8ce3d08abbc225d12e22be9dca`, **identical to before** |
| Protected paths | 289 files, aggregate `10f30df6b3e6c59aba9fc1094f12279ef63b234e6f229fec157c6ac9f14738f8`, using the preserved `protected-hash.mjs`. **Same value as the `10f30df6b3e6c59a…` recorded in the 6B-2 report §9** |

The only change is one new line, `?? docs/database/evidence/`. Git shows the untracked folder as a single line, so writing this report does not change the status below.

```text
 M .gitignore
 M apps/web/AGENTS.md
 M apps/worker/package.json
 M apps/worker/src/index.ts
 M apps/worker/src/notification-processor.ts
 M apps/worker/src/notification-rules.ts
 M apps/worker/src/notification-send-message.ts
 M apps/worker/src/notification-sender-state.ts
 M apps/worker/src/notification-sender.ts
 D apps/worker/test/notification-processor.integration.test.ts
 M apps/worker/test/notification-processor.test.ts
 D apps/worker/test/notification-rate-limit.integration.test.ts
 D apps/worker/test/notification-send-claim.integration.test.ts
 D apps/worker/test/notification-sender.integration.test.ts
 D apps/worker/test/notification-suppression.integration.test.ts
 M docs/database/M13.2-LOCAL-DATABASE-RUNBOOK.md
 M package.json
?? .claude/
?? apps/worker/src/dead-letter.ts
?? apps/worker/src/notification-email-templates.ts
?? apps/worker/test/dead-letter.test.ts
?? apps/worker/test/integration/
?? apps/worker/test/itest-acceptance.test.ts
?? apps/worker/test/itest-db.test.ts
?? apps/worker/test/itest-env-file.test.ts
?? apps/worker/test/itest-environment.test.ts
?? apps/worker/test/itest-gate.test.ts
?? apps/worker/test/itest-harness.test.ts
?? apps/worker/test/itest-isolation.test.ts
?? apps/worker/test/itest-queue.test.ts
?? apps/worker/test/notification-email-templates.test.ts
?? apps/worker/test/notification-sender.test.ts
?? apps/worker/test/support/
?? docs/INVESTIGATION-AUTH-MEMBERS-REMINDERS.md
?? docs/database/CLEAN-LOCAL-DATABASE-INVESTIGATION.md
?? docs/database/M13.2-IMPLEMENTATION-APPROVAL-CHECKLIST.md
?? docs/database/M13.2-NOTIFICATION-FINAL-DIAGNOSTIC.md
?? docs/database/M13.2-P6-P7-ACCEPTANCE-REPORT.md
?? docs/database/M13.2-P8-ACCEPTANCE-REPORT.md
?? docs/database/M13.2-PHASE-1A-IMPLEMENTATION-REPORT.md
?? docs/database/M13.2-PHASE-1B-IMPLEMENTATION-REPORT.md
?? docs/database/M13.2-PHASE-1C-IMPLEMENTATION-REPORT.md
?? docs/database/M13.2-PHASE-3-IMPLEMENTATION-REPORT.md
?? docs/database/M13.2-PHASE-4-IMPLEMENTATION-REPORT.md
?? docs/database/M13.2-PHASE-5-IMPLEMENTATION-REPORT.md
?? docs/database/M13.2-PHASE-6-DESIGN-REPORT.md
?? docs/database/M13.2-PHASE-6A-IMPLEMENTATION-REPORT.md
?? docs/database/M13.2-PHASE-6B-2-IMPLEMENTATION-REPORT.md
?? docs/database/M13.2-PHASE-6B-PREFLIGHT-REPORT.md
?? docs/database/M13.2-PHASE-7-DESIGN-REPORT.md
?? docs/database/M13.2-TEST-ISOLATION-PLAN-REVIEW.md
?? docs/database/M13.2-TEST-ISOLATION-REMEDIATION-PLAN.md
?? docs/database/evidence/
?? scripts/itest/
?? supabase-itest/
```

**Stopped here. Phase 7 implementation was not started.**
