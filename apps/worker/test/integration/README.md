# Worker integration lane (`npm run test:integration`)

Files here run only through `test/support/run-integration.ts`, never through
`npm test` (whose glob does not reach this directory).

Contract for every `*.test.ts` file in this directory (enforced by the runner
and by `test/itest-gate.test.ts`):

1. Be listed in `INTEGRATION_MANIFEST` (`test/support/itest-lane.ts`). The lane
   refuses a run with a listed file missing or an unlisted file present.
2. Create the gate with `createIntegrationGate(liveGateDeps())` (imports from
   `../support/itest-gate.ts` and `../support/itest-db.ts`), call
   `gate.verify()` in `before` and `gate.postflight()` in `after`.
3. Open every database connection with
   `connectVerified(gate.verified(), { max })`. No direct driver call, no value
   import of `postgres`/`pg`, no `process.env`, no developer variable or port.
   SMTP and Mailpit endpoints come from `gate.verified()` too.
4. Never write the pause switch (`public.notification_sender_state`) in any
   form, including inside a rolled-back transaction.
5. Never skip. A run with zero tests, or any skipped or todo test, fails.

The lane reads its configuration only from `<repository root>/.env.itest`
(written by the Phase 3 bootstrap, git-ignored; see
`test/support/itest-env-file.ts`). It refuses — before listing or starting any
file — when that file is missing or malformed, or when any `KOLEKTO_ITEST_*`
variable is already set in the shell. There is no fallback to `.env.local`,
`SUPABASE_DB_URL` or any developer endpoint. It passes the test process an
allow-listed environment and targets only the dedicated `kolekto-itest`
stack. See `docs/database/M13.2-PHASE-1A-IMPLEMENTATION-REPORT.md`,
`docs/database/M13.2-PHASE-1B-IMPLEMENTATION-REPORT.md` and
`docs/database/M13.2-PHASE-1C-IMPLEMENTATION-REPORT.md`.

The six files were moved here in Phase 1b and converted in Phase 4. Each file
also (Phase 4, `test/support/itest-isolation.ts`):

6. Creates `createFileHarness(() => gate.verified(), "<label>")` and calls
   `harness.start()` after `gate.verify()` in `before` (suite mutex + preflight),
   `harness.checkpoint()` in `beforeEach`, `harness.quarantineOwn()` in
   `afterEach` and `harness.finish()` before `gate.postflight()` in `after`.
7. Uses only run-unique ids, slugs, event keys and addresses (the harness's
   `scope`). Nothing is deleted; open rows are quarantined, never removed.
8. Writes ledger rows only through `insertLedgerFillers` inside `inRollback`
   (refused on any other handle), and waits for `waitForL5Headroom` before a
   reservation that must be granted. No trigger toggle, no ledger/event delete,
   no Mailpit delete-all, no inbox total (`test/itest-acceptance.test.ts`).
9. (Phase 6A) Never writes to or consumes the pgmq queue directly. The harness
   refuses to start a file or a test unless `notification_events` holds no
   message (queued or read), and `finish()` asserts it is still empty. A test
   that commits a domain action acknowledges only its own message with
   `archiveOwnQueueMessage(sql, harness.testOwner, message)`
   (`test/support/itest-queue.ts`: archive, never delete; the message must have
   been read for the current test's own community and is re-checked in the
   database), and calls `harness.recoverOwnQueue()` in `afterEach`.

SMTP: the lane has no default mode. `npm run test:integration -- --without-smtp`
lists and checks all six files but starts only the five that open no SMTP
connection, and its summary says the run is partial and names the withheld file.
`-- --with-smtp` starts all six, including
`notification-sender-mailpit.integration.test.ts` (sends to the test stack's
Mailpit; needs its own approval). A file outside `SMTP_INTEGRATION_FILES`
(`test/support/itest-lane.ts`) that uses the SMTP adapter or the SMTP/Mailpit
endpoints is refused.

Phase 6A added a seventh file, `notification-e2e-mailpit.integration.test.ts`
(member.create from the domain RPC through the audit trigger, queue, processor
and sender to Mailpit). It is an SMTP file too: `--without-smtp` withholds both
SMTP files and starts five; `--with-smtp` starts all seven. Its first run needs
its own approval (Phase 6B).

Phase 7 added an eighth file, `notification-worker-runtime.integration.test.ts`.
It runs the real built worker as a child process, connected as the test-only
least-privilege role `kolekto_itest_worker` (`npm run itest:worker-role` creates
it; `itest:reset` removes it, and the file then refuses until it is recreated).
`--worker-runtime` starts it alone and labels the run partial; `--with-smtp`
starts all eight, this one last; `--without-smtp` withholds it. It takes about
ten minutes of real time, because the 30 s visibility timeout is a constant.

It adds three narrow exceptions, each one file, each enforced by a guard:
`support/itest-switch.ts` (the only pause-switch write: lane grant, fresh identity
probe, disable in `finally`, independent read-back), `support/itest-queue-seed.ts`
(one owned `pgmq.send`, for shapes the trigger cannot produce), and
`support/itest-smtp-fault-proxy.ts` (`node:net`, upstream host fixed to 127.0.0.1).
Maintenance purges ledger rows older than 48 h, so the file refuses to start a
worker while any such row exists (`LEDGER_PURGE_ELIGIBLE`).

Phase 8 added a ninth file, `notification-worker-reliability.integration.test.ts`:
findings F-13, F-14 and F-15 against the real worker. It takes about 13 minutes
and costs 2 grants. `--worker-reliability` starts it alone; `--worker-runtime`
starts it and the Phase 7 file; `--with-smtp` starts all nine. Both worker files
refuse to start until `npm run itest:net-lockdown` has removed pg_net's broad
grants on the test stack, and `itest:reset` brings those grants back.

It adds one more narrow exception: `support/itest-queue-release.ts`, the operator's
release of a parked message (one owned `pgmq.set_vt`, visibility now). Acknowledgement
and archive failures are real: `withWorkerPrivilegeRevoked` takes one privilege
from the worker role for the length of a test and restores it. A process that dies
in between leaves it removed, and both files then refuse until
`npm run itest:worker-role` restores it.
