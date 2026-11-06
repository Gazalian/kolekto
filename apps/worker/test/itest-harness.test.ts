/**
 * itest-harness.test.ts — M13.2 Phase 1c: the pure integration-harness helpers.
 *
 * Run-unique fixtures, the quarantine SQL builder, the Mailpit exact-match
 * helper and the bounded-poll / suite-mutex logic. Everything is driven with
 * injected inputs: a deterministic UUID source, hand-built Mailpit JSON and a
 * fake clock. No database, SMTP, Mailpit or HTTP request.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";

import { isValidEmailAddress } from "@kolekto/adapters";

import { findAcceptanceViolations } from "./support/itest-acceptance.ts";
import { IntegrationGateError, type GateViolationCode } from "./support/itest-environment.ts";
import {
  COMMUNITY_SLUG_FORMAT,
  createRunScope,
  RESERVED_FIXTURE_ADDRESSES,
  RESERVED_FIXTURE_IDS,
  type RunScope,
} from "./support/itest-fixtures.ts";
import { findForbiddenSwitchWrites } from "./support/itest-gate.ts";
import {
  assertNoMessageTo,
  checkMessageContent,
  expectedMessageId,
  findExactMessages,
  selectExactlyOne,
  type ExpectedMessage,
} from "./support/itest-mailpit.ts";
import {
  acquireSuiteMutex,
  checkMutexHeld,
  ITEST_MUTEX_KEY,
  MUTEX_HELD_SQL,
  MUTEX_HOLDER_SQL,
  MUTEX_TRY_LOCK_SQL,
  MUTEX_UNLOCK_SQL,
  pollBounded,
  PollTimeout,
  realClock,
  type PollClock,
} from "./support/itest-mutex.ts";
import { buildQuarantineStatement, buildScopeResidueCheck, MAX_QUARANTINE_SCOPE, QUARANTINE_ERROR_CODE } from "./support/itest-quarantine.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function refusedWith(code: GateViolationCode) {
  return (e: unknown) => e instanceof IntegrationGateError && e.has(code);
}

/** Deterministic, well-formed v4 UUIDs: sha256(seed:i) shaped as a random UUID. */
function uuidSequence(seed: string): () => string {
  let i = 0;
  return () => {
    const h = createHash("sha256").update(`${seed}:${i++}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}

/** A UUID source that replays a fixed list, then fails loudly. */
function uuidList(values: readonly string[]): () => string {
  let i = 0;
  return () => {
    const v = values[i++];
    if (v === undefined) throw new Error("uuid list exhausted");
    return v;
  };
}

// ── Run-unique fixtures ───────────────────────────────────────────────────────

describe("run-unique fixtures — ids and tags", () => {
  it("issues fresh v4 ids and run-tagged slugs, addresses, event keys and application name", () => {
    const scope = createRunScope("sender-mailpit", { randomUUID: uuidSequence("a") });
    assert.match(scope.runTag, /^[0-9a-f]{8}$/);
    const ids = [scope.uuid(), scope.uuid(), scope.uuid()];
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(new Set(ids).size, 3);
    assert.equal(scope.slug(), `itest-${scope.runTag}-1`);
    assert.equal(scope.address(), `itest+${scope.runTag}-2@sender-mailpit.example.test`);
    assert.equal(scope.eventKey(), `itest-${scope.runTag}-sender-mailpit-3`);
    assert.equal(scope.applicationName, `kolekto-itest-${scope.runTag}`);
  });

  it("is deterministic under an injected UUID source (reproducible tests), and random by default", () => {
    const a = createRunScope("x-file", { randomUUID: uuidSequence("same") });
    const b = createRunScope("x-file", { randomUUID: uuidSequence("same") });
    assert.deepEqual([a.runTag, a.uuid(), a.slug(), a.address()], [b.runTag, b.uuid(), b.slug(), b.address()]);

    const real = createRunScope("x-file");
    assert.match(real.uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  it("two runs share no id, slug, address, event key or tag (cross-run contamination)", () => {
    const runs = [createRunScope("sender-mailpit"), createRunScope("sender-mailpit")];
    const issued = runs.map((s) => [s.uuid(), s.uuid(), s.slug(), s.address(), s.eventKey(), s.applicationName]);
    assert.notEqual(runs[0]!.runTag, runs[1]!.runTag);
    const all = issued.flat();
    assert.equal(new Set(all).size, all.length, "every value is unique across both runs");
    // Repeated runs of the SAME file no longer produce the same Message-ID either: it derives from the delivery id.
    assert.notEqual(expectedMessageId(issued[0]![0]!), expectedMessageId(issued[1]![0]!));
  });

  it("ownership is exact: a scope owns only what it issued, never another run's values or the P8 residue", () => {
    const mine = createRunScope("sender-mailpit", { randomUUID: uuidSequence("mine") });
    const theirs = createRunScope("sender-mailpit", { randomUUID: uuidSequence("theirs") });
    const id = mine.uuid();
    const address = mine.address();
    const otherId = theirs.uuid();
    const otherAddress = theirs.address();
    assert.ok(mine.owns(id) && mine.owns(address));
    assert.ok(!mine.owns(otherId) && !mine.owns(otherAddress));
    assert.ok(!theirs.owns(id));
    for (const residue of [...RESERVED_FIXTURE_IDS, "p8-itest", ...RESERVED_FIXTURE_ADDRESSES]) {
      assert.equal(mine.owns(residue), false, residue);
    }
    assert.ok(mine.isTagged(address) && mine.isTagged(mine.applicationName));
    assert.ok(!mine.isTagged(otherAddress), "another run's tag is not ours");
  });

  it("refuses a repeated id instead of silently reusing it", () => {
    const repeat = "0f8e2a4c-1b3d-4e5f-9a7b-6c5d4e3f2a1b";
    const scope = createRunScope("x-file", { randomUUID: uuidList(["1a2b3c4d-1111-4222-8333-444455556666", repeat, repeat]) });
    scope.uuid();
    assert.throws(() => scope.uuid(), refusedWith("FIXTURE_ID_COLLISION"));
  });

  it("refuses the P8 residue ids and the fixed-id shape of the old integration fixtures", () => {
    const fixed = [
      ...RESERVED_FIXTURE_IDS,
      "e8300000-0000-4000-8000-000000000001", // P8 delivery family
      "e8400000-0000-4000-8000-000000000001", // P8 event family
      "f9100000-0000-4000-8000-00000000000a", // sender file community
      "d9100000-0000-4000-8000-00000000000a", // send-claim file community
    ];
    for (const value of fixed) {
      assert.throws(() => createRunScope("x-file", { randomUUID: () => value }), refusedWith("FIXTURE_ID_RESERVED"), value);
      const scope = createRunScope("x-file", { randomUUID: uuidList(["1a2b3c4d-1111-4222-8333-444455556666", value]) });
      assert.throws(() => scope.uuid(), refusedWith("FIXTURE_ID_RESERVED"), value);
    }
  });

  it("refuses a UUID source that returns anything but a lowercase v4 UUID", () => {
    for (const bad of ["", "not-a-uuid", "1A2B3C4D-1111-4222-8333-444455556666", "1a2b3c4d-1111-1222-8333-444455556666", "1a2b3c4d-1111-4222-c333-444455556666", 42, null, undefined]) {
      assert.throws(() => createRunScope("x-file", { randomUUID: () => bad as string }), refusedWith("FIXTURE_INPUT_INVALID"), String(bad));
    }
  });

  it("refuses file labels that are not a short lowercase name", () => {
    for (const label of ["", "a", "Sender", "sender_mailpit", "-x", "x-", "x".repeat(25), "../etc", "a b", "x.example"]) {
      assert.throws(() => createRunScope(label, { randomUUID: uuidSequence("l") }), refusedWith("FIXTURE_INPUT_INVALID"), label);
    }
  });

  it("generated slugs satisfy the community slug constraint; addresses pass the real email validator", () => {
    const migration = readFileSync(path.join(REPO_ROOT, "supabase", "migrations", "20260917120300_communities.sql"), "utf8");
    assert.ok(migration.includes(`slug ~ '${COMMUNITY_SLUG_FORMAT.source}'`), "COMMUNITY_SLUG_FORMAT matches the migration's constraint text");
    const scope = createRunScope("abcdefghijklmnopqrstuvwx", { randomUUID: uuidSequence("long") });
    for (let i = 0; i < 50; i++) {
      assert.match(scope.slug(), COMMUNITY_SLUG_FORMAT);
      const address = scope.address();
      assert.ok(isValidEmailAddress(address), address);
    }
    for (const shared of RESERVED_FIXTURE_ADDRESSES) assert.ok(!scope.isTagged(shared));
  });
});

// ── Quarantine SQL builder ────────────────────────────────────────────────────

describe("quarantine SQL builder — parameterised, scoped, never a delete", () => {
  const scopeWith = (n: number): { scope: RunScope; ids: string[] } => {
    const scope = createRunScope("quarantine", { randomUUID: uuidSequence(`q${n}`) });
    return { scope, ids: Array.from({ length: n }, () => scope.uuid()) };
  };

  it("builds one UPDATE to dead/itest_quarantined for the run's own email rows, ids as parameters only", () => {
    const { scope, ids } = scopeWith(2);
    const stmt = buildQuarantineStatement(scope, ids);
    assert.equal(
      stmt.text,
      "update public.notification_deliveries set status = 'dead', error_code = 'itest_quarantined', send_lease_token = null, send_lease_expires_at = null " +
        "where channel = 'email' and status in ('pending', 'sending') and community_id in ($1::uuid, $2::uuid) returning id",
    );
    assert.deepEqual(stmt.values, ids);
    for (const id of ids) assert.ok(!stmt.text.includes(id), "no id is interpolated into the SQL text");
    assert.match(QUARANTINE_ERROR_CODE, /^[a-z][a-z0-9_]{2,63}$/, "satisfies the deliveries error_code constraint");
    assert.ok(Object.isFrozen(stmt) && Object.isFrozen(stmt.values));
  });

  it("the SQL text depends only on the number of ids, never on their values", () => {
    const a = scopeWith(3);
    const b = scopeWith(3);
    assert.equal(buildQuarantineStatement(a.scope, a.ids).text, buildQuarantineStatement(b.scope, b.ids).text);
    const { scope, ids } = scopeWith(MAX_QUARANTINE_SCOPE);
    assert.match(buildQuarantineStatement(scope, ids).text, /\$50::uuid\)/);
  });

  it("is not a cleanup bypass: no delete, trigger, configuration, ledger, event or switch access", () => {
    const { scope, ids } = scopeWith(1);
    for (const stmt of [buildQuarantineStatement(scope, ids), buildScopeResidueCheck(scope, ids)]) {
      assert.deepEqual(findAcceptanceViolations(stmt.text), []);
      assert.deepEqual(findForbiddenSwitchWrites(stmt.text), []);
      assert.doesNotMatch(stmt.text, /\b(?:delete|truncate|insert|alter|drop|grant|set_config|notification_send_attempts|notification_events|notification_sender_state)\b|;/i);
    }
    const check = buildScopeResidueCheck(scope, ids);
    assert.match(check.text, /^select count\(\*\)::int as open_rows from public\.notification_deliveries where /);
    assert.doesNotMatch(check.text, /\bupdate\b/i, "the postflight check is read-only");
  });

  it("refuses SQL-injection attempts and malformed ids without building anything", () => {
    const { scope } = scopeWith(1);
    const injections = [
      "x'); " + "delete" + " from public.notification_events; --",
      "00000000-0000-4000-8000-000000000000' or '1'='1",
      "1 or 1=1",
      "e8100000-0000-4000-8000-00000000000a::uuid) or (true",
      "$1",
      "",
      "1A2B3C4D-1111-4222-8333-444455556666",
      " 1a2b3c4d-1111-4222-8333-444455556666",
    ];
    for (const id of injections) {
      assert.throws(() => buildQuarantineStatement(scope, [id]), refusedWith("QUARANTINE_INPUT_INVALID"), id);
    }
    for (const bad of [[], "not-an-array", null, [42], [null]]) {
      assert.throws(() => buildQuarantineStatement(scope, bad as unknown as string[]), refusedWith("QUARANTINE_INPUT_INVALID"), JSON.stringify(bad));
    }
  });

  it("targets only records created by the current run: foreign, residue, duplicate and oversized scopes are refused", () => {
    const mine = scopeWith(2);
    const theirs = scopeWith(1);
    assert.throws(() => buildQuarantineStatement(mine.scope, [theirs.ids[0]!]), refusedWith("QUARANTINE_INPUT_INVALID"), "another run's community");
    assert.throws(() => buildQuarantineStatement(mine.scope, ["e8100000-0000-4000-8000-00000000000a"]), refusedWith("QUARANTINE_INPUT_INVALID"), "P8 residue");
    assert.throws(() => buildQuarantineStatement(mine.scope, [mine.ids[0]!, mine.ids[0]!]), refusedWith("QUARANTINE_INPUT_INVALID"), "duplicate");
    const big = scopeWith(MAX_QUARANTINE_SCOPE + 1);
    assert.throws(() => buildQuarantineStatement(big.scope, big.ids), refusedWith("QUARANTINE_INPUT_INVALID"), "too many");
    assert.throws(() => buildScopeResidueCheck(mine.scope, [theirs.ids[0]!]), refusedWith("QUARANTINE_INPUT_INVALID"));
    const slug = mine.scope.slug();
    assert.throws(() => buildQuarantineStatement(mine.scope, [slug]), refusedWith("QUARANTINE_INPUT_INVALID"), "an owned non-UUID value");
  });
});

// ── Mailpit exact-match helper ────────────────────────────────────────────────

describe("Mailpit exact-match helper — injected JSON only", () => {
  const scope = createRunScope("sender-mailpit", { randomUUID: uuidSequence("mail") });
  const deliveryId = scope.uuid();
  const to = scope.address();
  const subject = "You were added to P8 Integration Test";
  const messageId = expectedMessageId(deliveryId);
  const expected: ExpectedMessage = { to, subject, messageId, runTag: scope.runTag };

  const entry = (over: Partial<{ ID: string; MessageID: string; To: { Address: string }[]; Subject: string }> = {}) => ({
    ID: "mp-1",
    MessageID: messageId,
    From: { Address: "noreply@kolekto.test" },
    To: [{ Address: to }],
    Subject: subject,
    ...over,
  });
  const otherRun = createRunScope("sender-mailpit", { randomUUID: uuidSequence("other") });
  const noise = [
    entry({ ID: "n1", MessageID: expectedMessageId(otherRun.uuid()), To: [{ Address: otherRun.address() }] }),
    entry({ ID: "n2", MessageID: expectedMessageId("dev-delivery"), To: [{ Address: "officer-recipient@kolekto.test" }] }),
  ];

  it("derives the adapter's Message-ID (sha256 of the delivery id, 32 hex, @kolekto.invalid)", () => {
    assert.equal(expectedMessageId("abc"), "ba7816bf8f01cfea414140de5dae2223@kolekto.invalid");
    const adapter = readFileSync(path.join(REPO_ROOT, "packages", "adapters", "src", "mailpit-email-provider.ts"), "utf8");
    assert.match(adapter, /createHash\("sha256"\)\.update\(idempotencyKey\)\.digest\("hex"\)\.slice\(0, 32\)/, "adapter derivation unchanged");
    assert.match(adapter, /const MESSAGE_ID_DOMAIN = "kolekto\.invalid";/);
    const sender = readFileSync(path.join(REPO_ROOT, "apps", "worker", "src", "notification-sender.ts"), "utf8");
    assert.match(sender, /idempotencyKey: deliveryId,/, "the sender uses the delivery id as the idempotency key");
  });

  it("selects exactly our message among other runs' and developer messages, in any order, ignoring inbox totals", () => {
    const list = { total: 0, messages_count: 99, messages: [noise[0], entry(), noise[1]] };
    assert.equal(selectExactlyOne(list, expected).ID, "mp-1");
    assert.equal(selectExactlyOne({ messages: [entry(), ...noise].reverse() }, expected).ID, "mp-1");
    assert.equal(selectExactlyOne({ messages: [entry({ MessageID: `<${messageId}>` })] }, expected).ID, "mp-1", "angle brackets are optional");
  });

  it("wrong recipient, subject or run identifier is not a match (no substring matching)", () => {
    const cases: readonly [string, ReturnType<typeof entry>][] = [
      ["recipient with a longer counter", entry({ MessageID: expectedMessageId("x1"), To: [{ Address: to.replace(/-(\d+)@/, (_m, d: string) => `-${d}0@`) }] })],
      ["another run's recipient", entry({ MessageID: expectedMessageId("x2"), To: [{ Address: otherRun.address() }] })],
      ["subject with a suffix", entry({ MessageID: expectedMessageId("x3"), Subject: `${subject} (2)` })],
      ["subject prefix only", entry({ MessageID: expectedMessageId("x4"), Subject: subject.slice(0, 10) })],
      ["another Message-ID", entry({ MessageID: expectedMessageId("another-delivery") })],
    ];
    for (const [label, e] of cases) {
      assert.deepEqual(findExactMessages({ messages: [e] }, expected), [], label);
      assert.throws(() => selectExactlyOne({ messages: [e] }, expected), refusedWith("MAILPIT_NO_MATCH"), label);
    }
  });

  it("the expected Message-ID on a different recipient or subject, or on a multi-recipient message, is ambiguous", () => {
    for (const e of [
      entry({ To: [{ Address: otherRun.address() }] }),
      entry({ Subject: "Other" }),
      entry({ Subject: `${subject} (2)` }), // contains the expected subject: still not a match
      entry({ Subject: subject.slice(0, -1) }),
      entry({ To: [{ Address: to.replace(/-(\d+)@/, (_m, d: string) => `-${d}0@`) }] }), // contains the expected recipient's prefix
      entry({ To: [{ Address: to }, { Address: "x@y.example.test" }] }),
    ]) {
      assert.throws(() => findExactMessages({ messages: [e] }, expected), refusedWith("MAILPIT_AMBIGUOUS"));
    }
  });

  it("two exact matches are a duplicate send, never 'pick the newest'", () => {
    assert.throws(() => selectExactlyOne({ messages: [entry({ ID: "a" }), entry({ ID: "b" })] }, expected), refusedWith("MAILPIT_AMBIGUOUS"));
  });

  it("no match is reported, with only a count in the message", () => {
    const error = (() => {
      try {
        selectExactlyOne({ messages: noise }, expected);
      } catch (e) {
        return e;
      }
      return null;
    })();
    assert.ok(error instanceof IntegrationGateError && error.has("MAILPIT_NO_MATCH"));
    assert.ok(!error.message.includes(to) && !error.message.includes(subject));
  });

  it("a malformed response is inconclusive, never silently skipped", () => {
    const bad: unknown[] = [
      null, {}, { messages: "x" }, { messages: [null] },
      { messages: [{ ...entry(), MessageID: undefined }] },
      { messages: [{ ...entry(), To: "x" }] },
      { messages: [{ ...entry(), To: [{ Name: "no address" }] }] },
      { messages: [{ ...entry(), Subject: 1 }] },
      { messages: [entry(), { ID: "partial" }] },
    ];
    for (const list of bad) {
      assert.throws(() => findExactMessages(list, expected), refusedWith("MAILPIT_RESPONSE_INVALID"), JSON.stringify(list));
    }
  });

  it("refuses expectations that are not run-scoped or well-formed", () => {
    const cases: readonly Partial<ExpectedMessage>[] = [
      { to: "officer-recipient@kolekto.test" },
      { to: "synthetic-recipient@kolekto.test" },
      { runTag: otherRun.runTag },
      { to: to.toUpperCase() },
      { subject: "  " },
      { messageId: messageId.replace("@kolekto.invalid", "@example.com") },
      { messageId: "abc" },
    ];
    for (const over of cases) {
      assert.throws(() => findExactMessages({ messages: [entry()] }, { ...expected, ...over }), refusedWith("MAILPIT_EXPECTATION_INVALID"), JSON.stringify(over));
    }
  });

  it("absence by run-scoped recipient: passes on other mail, fails on any message to that recipient", () => {
    assertNoMessageTo({ messages: noise }, to, scope.runTag);
    assert.throws(() => assertNoMessageTo({ messages: [...noise, entry({ To: [{ Address: "a@b.example.test" }, { Address: to }] })] }, to, scope.runTag), refusedWith("MAILPIT_UNEXPECTED_MESSAGE"));
    assert.throws(() => assertNoMessageTo({ messages: [] }, "officer-recipient@kolekto.test", scope.runTag), refusedWith("MAILPIT_EXPECTATION_INVALID"));
    assert.throws(() => assertNoMessageTo({ messages: [] }, to, otherRun.runTag), refusedWith("MAILPIT_EXPECTATION_INVALID"));
  });

  it("checks required Text and HTML fragments of the identified message only", () => {
    const full = { ID: "mp-1", Text: "Member code P8/001 in P8 Integration Test", HTML: "<p>P8/001</p>" };
    checkMessageContent(full, { id: "mp-1", text: ["P8/001", "P8 Integration Test"], html: ["P8/001"] });
    assert.throws(() => checkMessageContent(full, { id: "mp-1", text: ["P8/002"], html: [] }), refusedWith("MAILPIT_CONTENT_MISMATCH"));
    assert.throws(() => checkMessageContent(full, { id: "mp-2", text: ["P8/001"], html: [] }), refusedWith("MAILPIT_RESPONSE_INVALID"));
    assert.throws(() => checkMessageContent({ ID: "mp-1", Text: "x" }, { id: "mp-1", text: ["x"], html: [] }), refusedWith("MAILPIT_RESPONSE_INVALID"));
    assert.throws(() => checkMessageContent(full, { id: "mp-1", text: [], html: [] }), refusedWith("MAILPIT_EXPECTATION_INVALID"));
  });
});

// ── Bounded polling and the suite mutex ───────────────────────────────────────

function fakeClock(opts: { advance?: boolean; times?: number[] } = {}): PollClock & { readonly sleeps: number[]; t: number } {
  const sleeps: number[] = [];
  const clock = {
    t: 0,
    sleeps,
    now: () => (opts.times ? (opts.times.shift() ?? clock.t) : clock.t),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      if (opts.advance !== false) clock.t += ms;
    },
  };
  return clock;
}

function lockSequence(results: readonly unknown[]) {
  let calls = 0;
  return {
    tryLock: async () => results[Math.min(calls++, results.length - 1)],
    calls: () => calls,
  };
}

describe("suite mutex — bounded pg_try_advisory_lock poll (fake clock)", () => {
  it("acquires on the first attempt without sleeping", async () => {
    const clock = fakeClock();
    const lock = lockSequence([true]);
    const result = await acquireSuiteMutex({ tryLock: lock.tryLock, timeoutMs: 1000, intervalMs: 100, clock });
    assert.deepEqual([result.value, result.attempts, result.waitedMs], [true, 1, 0]);
    assert.deepEqual(clock.sleeps, []);
  });

  it("acquires after the holder releases, sleeping exactly the interval between attempts", async () => {
    const clock = fakeClock();
    const lock = lockSequence([false, false, true]);
    const result = await acquireSuiteMutex({ tryLock: lock.tryLock, timeoutMs: 1000, intervalMs: 100, clock });
    assert.deepEqual([result.attempts, result.waitedMs, lock.calls()], [3, 200, 3]);
    assert.deepEqual(clock.sleeps, [100, 100]);
  });

  it("times out with a clear refusal naming the holder, never sleeping past the deadline", async () => {
    const clock = fakeClock();
    const lock = lockSequence([false]);
    await assert.rejects(
      acquireSuiteMutex({ tryLock: lock.tryLock, describeHolder: async () => "kolekto-itest-ab12cd34", timeoutMs: 100, intervalMs: 30, clock }),
      (e: unknown) => refusedWith("MUTEX_TIMEOUT")(e) && /within 100 ms \(5 attempt\(s\)\)/.test((e as Error).message) && /kolekto-itest-ab12cd34/.test((e as Error).message),
    );
    assert.deepEqual(clock.sleeps, [30, 30, 30, 10], "the last sleep is only the time remaining");
    assert.equal(lock.calls(), 5);
  });

  it("withholds an unsafe holder name and survives a failing holder lookup", async () => {
    for (const describeHolder of [async () => "psql; password=hunter2hunter2", async () => 42, async () => { throw new Error("boom"); }]) {
      await assert.rejects(
        acquireSuiteMutex({ tryLock: async () => false, describeHolder, timeoutMs: 50, intervalMs: 10, clock: fakeClock() }),
        (e: unknown) => refusedWith("MUTEX_TIMEOUT")(e) && /application_name unknown/.test((e as Error).message) && !/hunter2/.test((e as Error).message),
      );
    }
  });

  it("an unexpected error stops at once: not retried, not swallowed, details withheld", async () => {
    let calls = 0;
    const secret = "postgresql://kolekto_itest:Sup3rS3cretPassw0rd@127.0.0.1:55422/postgres";
    const error = await acquireSuiteMutex({
      tryLock: async () => { calls++; throw Object.assign(new Error(`connection failed ${secret}`), { code: "57P01" }); },
      timeoutMs: 1000,
      intervalMs: 100,
      clock: fakeClock(),
    }).then(() => null, (e: unknown) => e);
    assert.ok(refusedWith("MUTEX_FAILED")(error));
    assert.equal(calls, 1);
    const err = error as IntegrationGateError;
    assert.match(err.message, /code 57P01/);
    for (const rendering of [err.message, String(err), inspect(err), JSON.stringify(err), err.stack ?? ""]) {
      assert.ok(!rendering.includes("Sup3rS3cret"), "no secret in any rendering");
    }
    assert.equal(err.cause, undefined);
  });

  it("a non-boolean lock result is inconclusive, not 'not yet'", async () => {
    for (const value of ["t", 1, null, undefined, { locked: true }]) {
      const lock = lockSequence([value]);
      await assert.rejects(acquireSuiteMutex({ tryLock: lock.tryLock, timeoutMs: 1000, intervalMs: 100, clock: fakeClock() }), refusedWith("MUTEX_INCONCLUSIVE"), JSON.stringify(value));
      assert.equal(lock.calls(), 1);
    }
  });

  it("terminates even if the clock never advances (hard attempt cap)", async () => {
    const clock = fakeClock({ advance: false });
    const lock = lockSequence([false]);
    await assert.rejects(acquireSuiteMutex({ tryLock: lock.tryLock, timeoutMs: 100, intervalMs: 25, clock }), refusedWith("MUTEX_TIMEOUT"));
    assert.equal(lock.calls(), Math.floor(100 / 25) + 2);
  });

  it("a clock that runs backwards or is not finite is a refusal", async () => {
    for (const times of [[1000, 900], [Number.NaN], [0, Number.POSITIVE_INFINITY]]) {
      await assert.rejects(acquireSuiteMutex({ tryLock: async () => false, timeoutMs: 1000, intervalMs: 100, clock: fakeClock({ times: [...times] }) }), refusedWith("POLL_INCONCLUSIVE"), JSON.stringify(times));
    }
  });

  it("refuses unbounded or arbitrary-long options before trying the lock", async () => {
    const bad: readonly [number, number][] = [[0, 10], [120_001, 100], [1000, 5], [1000, 10_001], [50, 100], [1.5, 10], [1000, Number.NaN], [Number.POSITIVE_INFINITY, 100]];
    for (const [timeoutMs, intervalMs] of bad) {
      const lock = lockSequence([true]);
      await assert.rejects(acquireSuiteMutex({ tryLock: lock.tryLock, timeoutMs, intervalMs, clock: fakeClock() }), refusedWith("POLL_OPTIONS_INVALID"), `${timeoutMs}/${intervalMs}`);
      assert.equal(lock.calls(), 0);
    }
    await assert.rejects(pollBounded({ label: "x", timeoutMs: 100, intervalMs: 10, clock: {} as PollClock }, async () => ({ done: true, value: 1 })), refusedWith("POLL_OPTIONS_INVALID"));
    await assert.rejects(pollBounded({ label: "bad\nlabel", timeoutMs: 100, intervalMs: 10, clock: fakeClock() }, async () => ({ done: true, value: 1 })), refusedWith("POLL_OPTIONS_INVALID"));
  });

  it("pollBounded: generic success, PollTimeout for callers, and an unexpected attempt shape is inconclusive", async () => {
    let n = 0;
    const ok = await pollBounded({ label: "Mailpit poll", timeoutMs: 1000, intervalMs: 100, clock: fakeClock() }, async () => (++n === 2 ? { done: true, value: "found" } : { done: false }));
    assert.deepEqual([ok.value, ok.attempts], ["found", 2]);
    await assert.rejects(pollBounded({ label: "Mailpit poll", timeoutMs: 100, intervalMs: 50, clock: fakeClock() }, async () => ({ done: false })), (e: unknown) => e instanceof PollTimeout && e.attempts === 3 && e.waitedMs === 100);
    await assert.rejects(pollBounded({ label: "Mailpit poll", timeoutMs: 100, intervalMs: 50, clock: fakeClock() }, async () => "yes" as never), refusedWith("POLL_INCONCLUSIVE"));
  });

  it("works with the real clock under a short bound (no database involved)", async () => {
    const started = Date.now();
    await assert.rejects(acquireSuiteMutex({ tryLock: async () => false, timeoutMs: 60, intervalMs: 20, clock: realClock }), refusedWith("MUTEX_TIMEOUT"));
    assert.ok(Date.now() - started < 5_000, "bounded");
  });

  it("loss detection: exactly one held lock in this session, anything else stops the file", () => {
    checkMutexHeld(1);
    assert.throws(() => checkMutexHeld(0), refusedWith("MUTEX_LOST"));
    for (const v of [2, "1", null, undefined, -1]) assert.throws(() => checkMutexHeld(v), refusedWith("MUTEX_INCONCLUSIVE"), String(v));
  });

  it("the mutex statements are constant, non-blocking and use key (918273, 1), clear of the migrations' keys 1-5", () => {
    assert.deepEqual(ITEST_MUTEX_KEY, { classId: 918273, objId: 1 });
    assert.match(MUTEX_TRY_LOCK_SQL, /^select pg_try_advisory_lock\(918273, 1\) as locked$/);
    assert.match(MUTEX_UNLOCK_SQL, /^select pg_advisory_unlock\(918273, 1\) as unlocked$/);
    for (const sql of [MUTEX_TRY_LOCK_SQL, MUTEX_UNLOCK_SQL, MUTEX_HOLDER_SQL, MUTEX_HELD_SQL]) {
      assert.doesNotMatch(sql, /pg_advisory_lock\(|pg_advisory_xact_lock|;|\b(?:insert|update|delete|alter|set_config)\b/i, sql);
      assert.deepEqual(findAcceptanceViolations(sql), []);
    }
    assert.match(MUTEX_HOLDER_SQL, /classid = 918273 and l\.objid = 1 and l\.objsubid = 2/);
    assert.match(MUTEX_HELD_SQL, /pid = pg_backend_pid\(\)/);
    const migrations = readFileSync(path.join(REPO_ROOT, "supabase", "migrations", "20261024200000_notification_quota_controls.sql"), "utf8");
    assert.ok(!migrations.includes("918273"), "the key is not used by the reserve function");
  });
});
