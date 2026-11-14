# M13.2 Phase 6B-2 Evidence Manifest

Run described by this evidence: the second, passing Phase 6B-2 attempt on the `kolekto-itest` stack, 2026-11-05, run tag `a28187cc`, branch `fix/auth-nav-and-cookie-forwarding`, HEAD `ee9462b`. Results are in `docs/database/M13.2-PHASE-6B-2-IMPLEMENTATION-REPORT.md`. How these copies were made and checked is in `EVIDENCE-PRESERVATION-REPORT.md`, in this folder.

**Origin of every file below:**
`C:\Users\USER\AppData\Local\Temp\claude\d537c9a05cfe2b27\7963d5c2-e56e-4c8c-9cab-56257516cbff\scratchpad\`

**Copied:** 2026-11-05 16:50:48 UTC, byte for byte, with no redaction or rewriting.

All times are UTC on 2026-11-05 and come from the original files' filesystem timestamps. For a file that a command wrote to over time, the two times bracket the collection. All files are UTF-8 with LF line endings.

## Evidence files

These are outputs of the run.

| File | What it is | Collection started | Collection ended | Bytes | Lines |
|---|---|---|---|---:|---:|
| `lane-output.txt` | Complete TAP output of `npm run test:integration -- --with-smtp`: all 7 integration files, 41 tests | 16:10:58.051 | 16:11:49.446 | 15115 | 304 |
| `lane-times.txt` | Lane start time, end time and exit code | 16:10:57.767 | 16:11:49.570 | 65 | 3 |
| `e2e-evidence.txt` | Read-only database readings taken after the lane, independent of the test: E2E trace (lines 2–9) and final state and budget (lines 10–34). Internal clock line: 16:12:25 | 16:12:24.052 | 16:12:25.102 | 2077 | 34 |

## Method files

These are the scripts behind the readings. They are not results. Their times are when each script was written.

| File | What it is | Written | Bytes | Lines |
|---|---|---:|---:|---:|
| `e2e.sql` | The query that produced `e2e-evidence.txt`. Needed to read that file, whose columns are unlabelled | 16:12:16.505 | 4112 | 34 |
| `state.sql` | The preflight state query. **Its output was not saved** | 16:09:55.390 | 3238 | 30 |
| `mailpit-read.mjs` | The Mailpit API read script. **Its output was not saved** | 16:12:53.757 | 1792 | 26 |
| `protected-hash.mjs` | The protected-path aggregate hash script | 16:09:59.927 | 1122 | 21 |
| `gate-probe.ts` | The preflight gate probe script. It holds no secret values; when run, it loads `.env.itest` itself. **Its output was not saved.** Kept as a record; there is no need to run it | 16:10:33.246 | 3468 | 55 |

## SHA-256 checksums

```text
debf50aa4af76aa2d0b148dcd66f053d1903adfd0443caaeeca2dd9d068cd3f0  lane-output.txt
24c4d13a72ba002fb8f446553f486d941dee5ecf0fed9e28ee16a2248b5f6d7a  lane-times.txt
6d9d6d907763e2e3d10969e70c1d8fae240be35543e65b1824a601fe803b4213  e2e-evidence.txt
3301116a13043dd3d5a9fd70a814565d56b9d374b7265ac1e849312dc1219a12  e2e.sql
239f9908a615415db9c17abd80b67a7006d1f7029346e288d7780781e57e07e9  state.sql
00a5cdeb88b1bbd9fb5bccdaada7afd426ebe2a968575f02c89fb85eed602e7d  mailpit-read.mjs
14a352e6e500fb20d4128fef7168690f3757d9f9b529ee837c193d9de167b528  protected-hash.mjs
491b8fcce3d0704975ae944ed8a7488bf86879f43ee3556a4810f6adc9ed764d  gate-probe.ts
```

To re-check from this folder with Git Bash or any shell that has `sha256sum`, save the block above to a file and run `sha256sum -c <file>`.

This manifest and `EVIDENCE-PRESERVATION-REPORT.md` were written during preservation. They are not evidence from the run and are not checksummed here.
