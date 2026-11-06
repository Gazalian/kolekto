/**
 * itest-queue.test.ts — M13.2 Phase 6A: unit tests of the notification-queue isolation
 * helpers (test/support/itest-queue.ts) and their harness wiring
 * (test/support/itest-isolation.ts createFileHarness) with fake connections only.
 * No database, no SMTP, no Mailpit.
 *
 * The fake keeps a tiny in-memory queue so ownership, re-checks and archive effects can
 * be observed. Queue-function tokens are assembled at runtime because the acceptance
 * guard scans this file.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { IntegrationGateError } from "./support/itest-environment.ts";
import type { ItestSql } from "./support/itest-db.ts";
import { createRunScope } from "./support/itest-fixtures.ts";
import { createFileHarness, HEARTBEAT_SQL, L4_DAY_SQL, OPEN_EMAIL_ROWS_SQL, QUEUE_READ_SQL } from "./support/itest-isolation.ts";
import { MUTEX_HELD_SQL, MUTEX_TRY_LOCK_SQL, MUTEX_UNLOCK_SQL } from "./support/itest-mutex.ts";
import {
  ARCHIVED_QUEUE_MESSAGE_SQL,
  archiveOwnQueueMessage,
  assertOwnedQueueMessage,
  assertQueueEmpty,
  findOwnQueueMessages,
  LOCK_OWN_QUEUE_MESSAGE_SQL,
  MAX_QUEUE_OWNER_SCOPE,
  ownQueueMessagesSql,
  QUEUE_STATE_SQL,
  readArchivedQueueMessage,
  readQueueState,
  recoverOwnQueueMessages,
  waitForOwnQueueMessage,
  type OwnedQueueMessage,
  type QueueOwner,
} from "./support/itest-queue.ts";

const refusedWith = (code: string) => (e: unknown) => e instanceof IntegrationGateError && e.has(code as never);

const Q = "pg" + "mq";
const ARCHIVE_TEXT = `select ${Q}.archive('notification_events', $1::bigint) as archived`;
const OWN_PREFIX = `select msg_id::text as msg_id, read_ct, message from ${Q}.q_notification_events where message ->> 'community_id' in (`;

// ── A fake connection over an in-memory queue ─────────────────────────────────

interface FakeRow {
  msg_id: string;
  read_ct: number;
  message: Record<string, unknown>;
  archived: boolean;
}

interface Call {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

interface FakeDb {
  readonly sql: ItestSql;
  readonly rows: FakeRow[];
  readonly calls: Call[];
  readonly tx: { committed: number; rolledBack: number };
  /** Optional per-statement override; return undefined to use the default behaviour. */
  override?: ((text: string, params: readonly unknown[]) => unknown) | undefined;
  extra?: ((text: string) => unknown) | undefined;
}

function fakeDb(initial: readonly { communityId: string; readCount?: number; extra?: Record<string, unknown> }[] = []): FakeDb {
  let nextId = 1;
  const rows: FakeRow[] = initial.map((m) => ({
    msg_id: String(nextId++),
    read_ct: m.readCount ?? 0,
    message: { community_id: m.communityId, action: "member.create", ...(m.extra ?? {}) },
    archived: false,
  }));
  const calls: Call[] = [];
  const tx = { committed: 0, rolledBack: 0 };
  const db: FakeDb = { sql: undefined as unknown as ItestSql, rows, calls, tx };

  const answer = (text: string, params: readonly unknown[], inTx: boolean): unknown => {
    calls.push({ text, params, inTx });
    const over = db.override?.(text, params);
    if (over !== undefined) {
      if (over instanceof Error) throw over;
      return over;
    }
    const live = rows.filter((r) => !r.archived);
    if (text === QUEUE_STATE_SQL) return [{ queued: live.length, read_messages: live.filter((r) => r.read_ct > 0).length }];
    if (text.startsWith(OWN_PREFIX)) {
      return live.filter((r) => params.includes(r.message["community_id"])).map(({ msg_id, read_ct, message }) => ({ msg_id, read_ct, message }));
    }
    if (text === LOCK_OWN_QUEUE_MESSAGE_SQL) {
      return live.filter((r) => r.msg_id === params[0] && r.message["community_id"] === params[1]).map((r) => ({ msg_id: r.msg_id }));
    }
    if (text === ARCHIVE_TEXT) {
      const row = live.find((r) => r.msg_id === params[0]);
      if (row) row.archived = true;
      return [{ archived: row !== undefined }];
    }
    if (text === ARCHIVED_QUEUE_MESSAGE_SQL) {
      return rows.filter((r) => r.archived && r.msg_id === params[0]).map(({ msg_id, message }) => ({ msg_id, message }));
    }
    const extra = db.extra?.(text);
    if (extra !== undefined) return extra;
    throw new Error(`unexpected statement: ${text}`);
  };

  const sql = {
    async unsafe(text: string, params: readonly unknown[] = []) {
      return answer(text, params, false);
    },
    async begin(cb: (t: unknown) => Promise<unknown>) {
      const snapshot = rows.map((r) => r.archived);
      const t = { unsafe: async (text: string, params: readonly unknown[] = []) => answer(text, params, true) };
      try {
        const out = await cb(t);
        tx.committed++;
        return out;
      } catch (error) {
        rows.forEach((r, i) => (r.archived = snapshot[i]!));
        tx.rolledBack++;
        throw error;
      }
    },
  };
  (db as { sql: ItestSql }).sql = sql as unknown as ItestSql;
  return db;
}

/** An owner over a mutable set of community ids. */
function ownerOf(...ids: string[]): QueueOwner & { readonly ids: Set<string> } {
  const set = new Set(ids);
  return { ids: set, owns: (id: string) => set.has(id) };
}

const writes = (calls: readonly Call[]) => calls.filter((c) => !/^select /.test(c.text) || c.text.includes(".archive("));

// ── assertQueueEmpty / readQueueState ─────────────────────────────────────────

describe("assertQueueEmpty — the queue holds no message at all (read-only)", () => {
  const scope = createRunScope("unit");

  it("passes on an empty queue with one constant read-only select", async () => {
    const db = fakeDb();
    for (const stage of ["preflight", "checkpoint", "finish"] as const) {
      assert.deepEqual(await assertQueueEmpty(db.sql, stage), { queued: 0, readMessages: 0 });
    }
    assert.ok(db.calls.every((c) => c.text === QUEUE_STATE_SQL));
    assert.match(QUEUE_STATE_SQL, /^select count\(\*\)::int as queued, \(count\(\*\) filter \(where read_ct > 0\)\)::int as read_messages from pgmq\.q_notification_events$/);
  });

  it("refuses an unread queued message with a stage-specific code", async () => {
    for (const [stage, code] of [["preflight", "PREFLIGHT_QUEUE_NOT_EMPTY"], ["checkpoint", "ISOLATION_FOREIGN_QUEUE"], ["finish", "QUEUE_RESIDUE"]] as const) {
      const db = fakeDb([{ communityId: scope.uuid() }]);
      await assert.rejects(assertQueueEmpty(db.sql, stage), refusedWith(code), stage);
    }
  });

  it("refuses a read message with both codes (queued and consumed)", async () => {
    const db = fakeDb([{ communityId: scope.uuid(), readCount: 1 }]);
    await assert.rejects(assertQueueEmpty(db.sql, "checkpoint"), (e: unknown) => e instanceof IntegrationGateError && e.has("ISOLATION_FOREIGN_QUEUE") && e.has("PREFLIGHT_QUEUE_CONSUMED"));
  });

  it("refuses malformed or failing counts instead of guessing, and withholds driver text", async () => {
    for (const bad of [[], [{ queued: "0", read_messages: 0 }], [{ queued: 0 }], [{ queued: 0, read_messages: 0 }, { queued: 0, read_messages: 0 }]]) {
      const db = fakeDb();
      db.override = () => bad;
      await assert.rejects(readQueueState(db.sql), refusedWith("PREFLIGHT_INCONCLUSIVE"), JSON.stringify(bad));
    }
    const db = fakeDb();
    db.override = () => Object.assign(new Error("boom postgresql://x:secret@h/db"), { code: "42501" });
    await assert.rejects(assertQueueEmpty(db.sql, "finish"), (e: unknown) => {
      assert.ok(e instanceof IntegrationGateError && e.has("PREFLIGHT_INCONCLUSIVE"));
      assert.ok(!(e as Error).message.includes("secret"));
      return true;
    });
  });
});

// ── findOwnQueueMessages / waitForOwnQueueMessage ─────────────────────────────

describe("findOwnQueueMessages — reads only the owner's communities", () => {
  const scope = createRunScope("unit");

  it("returns only messages of the named owned communities, as frozen handles", async () => {
    const mine = scope.uuid();
    const theirs = scope.uuid();
    const db = fakeDb([{ communityId: theirs }, { communityId: mine }, { communityId: mine, readCount: 2 }]);
    const found = await findOwnQueueMessages(db.sql, ownerOf(mine), [mine]);
    assert.deepEqual(found.map((m) => [m.msgId, m.communityId, m.readCount]), [["2", mine, 0], ["3", mine, 2]]);
    assert.ok(Object.isFrozen(found[0]) && Object.isFrozen(found[0]!.message));
    assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0]!.text, ownQueueMessagesSql(1));
    assert.deepEqual(db.calls[0]!.params, [mine]);
  });

  it("builds one placeholder per community and never interpolates ids", () => {
    assert.equal(ownQueueMessagesSql(3), `${OWN_PREFIX}$1, $2, $3) order by msg_id`);
    for (const n of [0, -1, 1.5, MAX_QUEUE_OWNER_SCOPE + 1]) assert.throws(() => ownQueueMessagesSql(n), refusedWith("QUEUE_OWNER_INVALID"), String(n));
  });

  it("refuses, before any query, a community the owner does not own, a malformed id, a duplicate or too many", async () => {
    const mine = scope.uuid();
    const owner = ownerOf(mine);
    const cases: [string, unknown[], string][] = [
      ["foreign community", [scope.uuid()], "QUEUE_MESSAGE_NOT_OWNED"],
      ["mixed list", [mine, scope.uuid()], "QUEUE_MESSAGE_NOT_OWNED"],
      ["not a uuid", ["x"], "QUEUE_MESSAGE_NOT_OWNED"],
      ["upper-case uuid", [mine.toUpperCase()], "QUEUE_MESSAGE_NOT_OWNED"],
      ["duplicate", [mine, mine], "QUEUE_OWNER_INVALID"],
      ["too many", Array.from({ length: MAX_QUEUE_OWNER_SCOPE + 1 }, () => mine), "QUEUE_OWNER_INVALID"],
    ];
    for (const [label, ids, code] of cases) {
      const db = fakeDb([{ communityId: mine }]);
      await assert.rejects(findOwnQueueMessages(db.sql, owner, ids as string[]), refusedWith(code), label);
      assert.deepEqual(db.calls, [], `${label}: no query`);
    }
    for (const bogus of [null, {}, { owns: true }]) {
      await assert.rejects(findOwnQueueMessages(fakeDb().sql, bogus as never, [mine]), refusedWith("QUEUE_OWNER_INVALID"));
    }
  });

  it("an empty list issues no query", async () => {
    const db = fakeDb();
    assert.deepEqual(await findOwnQueueMessages(db.sql, ownerOf(), []), []);
    assert.deepEqual(db.calls, []);
  });

  it("refuses a row the database returned for another community, and malformed rows", async () => {
    const mine = scope.uuid();
    const db = fakeDb();
    db.override = () => [{ msg_id: "7", read_ct: 0, message: { community_id: scope.uuid() } }];
    await assert.rejects(findOwnQueueMessages(db.sql, ownerOf(mine), [mine]), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
    for (const bad of [{ msg_id: 7, read_ct: 0, message: { community_id: mine } }, { msg_id: "0", read_ct: 0, message: { community_id: mine } }, { msg_id: "7", read_ct: 0, message: null }, { msg_id: "7", read_ct: "0", message: { community_id: mine } }]) {
      db.override = () => [bad];
      await assert.rejects(findOwnQueueMessages(db.sql, ownerOf(mine), [mine]), refusedWith("PREFLIGHT_INCONCLUSIVE"), JSON.stringify(bad));
    }
  });
});

describe("waitForOwnQueueMessage — bounded poll, exactly one", () => {
  const scope = createRunScope("unit");

  it("polls until the community's single message appears", async () => {
    const mine = scope.uuid();
    const db = fakeDb();
    let reads = 0;
    db.override = (text) => {
      if (!text.startsWith(OWN_PREFIX)) return undefined;
      reads++;
      return reads < 3 ? [] : [{ msg_id: "42", read_ct: 0, message: { community_id: mine, action: "member.create" } }];
    };
    const m = await waitForOwnQueueMessage(db.sql, ownerOf(mine), mine, { timeoutMs: 2_000, intervalMs: 10 });
    assert.equal(m.msgId, "42");
    assert.equal(reads, 3);
  });

  it("refuses with QUEUE_MESSAGE_TIMEOUT when nothing arrives, and QUEUE_MESSAGE_AMBIGUOUS on two messages", async () => {
    const mine = scope.uuid();
    await assert.rejects(waitForOwnQueueMessage(fakeDb().sql, ownerOf(mine), mine, { timeoutMs: 100, intervalMs: 10 }), refusedWith("QUEUE_MESSAGE_TIMEOUT"));
    const two = fakeDb([{ communityId: mine }, { communityId: mine }]);
    await assert.rejects(waitForOwnQueueMessage(two.sql, ownerOf(mine), mine, { timeoutMs: 500, intervalMs: 10 }), refusedWith("QUEUE_MESSAGE_AMBIGUOUS"));
  });

  it("refuses a community the owner does not own before polling", async () => {
    const db = fakeDb();
    await assert.rejects(waitForOwnQueueMessage(db.sql, ownerOf(), scope.uuid(), { timeoutMs: 100, intervalMs: 10 }), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
    assert.deepEqual(db.calls, []);
  });
});

// ── archiveOwnQueueMessage ────────────────────────────────────────────────────

describe("archiveOwnQueueMessage — one owned message, archived (never deleted), re-checked in the database", () => {
  const scope = createRunScope("unit");

  async function setup() {
    const mine = scope.uuid();
    const theirs = scope.uuid();
    const db = fakeDb([{ communityId: theirs }, { communityId: mine }, { communityId: theirs }]);
    const owner = ownerOf(mine);
    const [message] = await findOwnQueueMessages(db.sql, owner, [mine]);
    db.calls.length = 0;
    return { db, owner, message: message!, mine, theirs };
  }

  it("locks and archives exactly that msg_id in one committed transaction; nothing else changes", async () => {
    const { db, owner, message, mine } = await setup();
    await archiveOwnQueueMessage(db.sql, owner, message);
    assert.deepEqual(db.calls.map((c) => [c.text, c.params, c.inTx]), [
      [LOCK_OWN_QUEUE_MESSAGE_SQL, ["2", mine], true],
      [ARCHIVE_TEXT, ["2"], true],
    ]);
    assert.deepEqual(db.rows.map((r) => r.archived), [false, true, false], "only the owned message moved to the archive");
    assert.deepEqual(db.tx, { committed: 1, rolledBack: 0 });
    assert.match(LOCK_OWN_QUEUE_MESSAGE_SQL, /where msg_id = \$1::bigint and message ->> 'community_id' = \$2 for update$/);
    assert.ok(!db.calls.some((c) => /\bdelete\b|purge|\.pop\(|\.read\(/i.test(c.text)), "no delete, purge, pop or read");
    assert.deepEqual(await readArchivedQueueMessage(db.sql, owner, message), message.message);
  });

  it("refuses a hand-built message, before any query", async () => {
    const { db, owner, mine } = await setup();
    const forged: OwnedQueueMessage = { msgId: "1", communityId: mine, readCount: 0, message: {} };
    await assert.rejects(archiveOwnQueueMessage(db.sql, owner, forged), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
    await assert.rejects(archiveOwnQueueMessage(db.sql, owner, { ...(await findOwnQueueMessages(db.sql, owner, [mine]))[0]! }), refusedWith("QUEUE_MESSAGE_NOT_OWNED"), "a copy of a handle is not the handle");
    assert.equal(writes(db.calls).length, 0);
    assert.deepEqual(db.tx, { committed: 0, rolledBack: 0 });
  });

  it("refuses a message read for another owner (another test or file), before any query", async () => {
    const { db, message, mine } = await setup();
    const otherOwner = ownerOf(mine); // owns the same id, but is a different owner object
    await assert.rejects(archiveOwnQueueMessage(db.sql, otherOwner, message), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
    assert.deepEqual(db.calls, []);
  });

  it("refuses when the owner no longer owns the community (the next test started), before any query", async () => {
    const { db, owner, message, mine } = await setup();
    owner.ids.delete(mine);
    await assert.rejects(archiveOwnQueueMessage(db.sql, owner, message), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
    assert.throws(() => assertOwnedQueueMessage(owner, message), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
    assert.deepEqual(db.calls, []);
  });

  it("refuses and rolls back when the database row is gone or carries another community; nothing is archived", async () => {
    const { db, owner, message } = await setup();
    db.rows[1]!.message["community_id"] = scope.uuid(); // the row no longer matches the handle
    await assert.rejects(archiveOwnQueueMessage(db.sql, owner, message), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
    assert.deepEqual(db.calls.map((c) => c.text), [LOCK_OWN_QUEUE_MESSAGE_SQL], "no archive statement was issued");
    assert.deepEqual(db.tx, { committed: 0, rolledBack: 1 });
    assert.deepEqual(db.rows.map((r) => r.archived), [false, false, false]);

    const again = await setup();
    await archiveOwnQueueMessage(again.db.sql, again.owner, again.message);
    await assert.rejects(archiveOwnQueueMessage(again.db.sql, again.owner, again.message), refusedWith("QUEUE_MESSAGE_NOT_OWNED"), "already archived");
  });

  it("refuses (and rolls back) when the archive does not report exactly one archived row", async () => {
    for (const bad of [[{ archived: false }], [], [{ archived: true }, { archived: true }], [{ archived: "t" }]]) {
      const { db, owner, message } = await setup();
      db.override = (text) => (text === ARCHIVE_TEXT ? bad : undefined);
      await assert.rejects(archiveOwnQueueMessage(db.sql, owner, message), refusedWith("QUEUE_ARCHIVE_FAILED"), JSON.stringify(bad));
      assert.deepEqual(db.tx, { committed: 0, rolledBack: 1 });
    }
  });

  it("readArchivedQueueMessage returns null before the archive and refuses a forged handle", async () => {
    const { db, owner, message, mine } = await setup();
    assert.equal(await readArchivedQueueMessage(db.sql, owner, message), null);
    await assert.rejects(readArchivedQueueMessage(db.sql, owner, { msgId: "2", communityId: mine, readCount: 0, message: {} }), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
  });
});

describe("recoverOwnQueueMessages — afterEach recovery archives only the owner's leftovers", () => {
  const scope = createRunScope("unit");

  it("archives every leftover of the named owned communities and nothing else", async () => {
    const a = scope.uuid();
    const b = scope.uuid();
    const foreign = scope.uuid();
    const db = fakeDb([{ communityId: a }, { communityId: foreign }, { communityId: b }, { communityId: a }]);
    assert.equal(await recoverOwnQueueMessages(db.sql, ownerOf(a, b), [a, b]), 3);
    assert.deepEqual(db.rows.map((r) => r.archived), [true, false, true, true]);
    assert.equal(db.calls.filter((c) => c.text === ARCHIVE_TEXT).length, 3);
    assert.deepEqual(db.tx, { committed: 3, rolledBack: 0 });
  });

  it("refuses communities it does not own and archives nothing", async () => {
    const a = scope.uuid();
    const foreign = scope.uuid();
    const db = fakeDb([{ communityId: foreign }]);
    await assert.rejects(recoverOwnQueueMessages(db.sql, ownerOf(a), [a, foreign]), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
    assert.deepEqual(db.calls, []);
    assert.equal(await recoverOwnQueueMessages(db.sql, ownerOf(a), [a]), 0, "nothing queued for the owned community");
  });
});

// ── Harness wiring (createFileHarness with an injected fake connection) ───────

function harnessDb(initial: readonly { communityId: string }[] = []) {
  const db = fakeDb(initial);
  const state = { unlocked: 0, released: 0, ended: 0, openRows: 0 };
  db.extra = (text) => {
    if (text === MUTEX_TRY_LOCK_SQL) return [{ locked: true }];
    if (text === MUTEX_HELD_SQL) return [{ held: 1 }];
    if (text === MUTEX_UNLOCK_SQL) {
      state.unlocked++;
      return [{ unlocked: true }];
    }
    if (text === OPEN_EMAIL_ROWS_SQL || text.startsWith("select count(*)::int as open_rows from public.notification_deliveries")) return [{ open_rows: state.openRows }];
    if (text === HEARTBEAT_SQL) return [{ fresh: false }];
    if (text === QUEUE_READ_SQL) return [{ read_messages: 0 }];
    if (text === L4_DAY_SQL) return [{ day_count: 131, day_cap: 180 }];
    if (text.startsWith("update public.notification_deliveries")) return [];
    return undefined;
  };
  const sqlWithPool = Object.assign(db.sql, {
    async reserve() {
      return Object.assign(Object.create(db.sql) as object, { release: () => { state.released++; } });
    },
    async end() {
      state.ended++;
    },
  });
  const connect = () => sqlWithPool as unknown as ItestSql;
  return { db, state, connect };
}

describe("createFileHarness — queue isolation wiring (Phase 6A)", () => {
  const env = () => ({}) as never;

  it("start() refuses when the queue holds a message (PREFLIGHT_QUEUE_NOT_EMPTY)", async () => {
    const other = createRunScope("unit");
    const { connect } = harnessDb([{ communityId: other.uuid() }]);
    const h = createFileHarness(env, "unit", { connect });
    await assert.rejects(h.start(), refusedWith("PREFLIGHT_QUEUE_NOT_EMPTY"));
  });

  it("checkpoint() refuses a queued message (ISOLATION_FOREIGN_QUEUE) and finish() reports one (QUEUE_RESIDUE), still releasing the mutex", async () => {
    const { db, state, connect } = harnessDb();
    const h = createFileHarness(env, "unit", { connect });
    await h.start();
    await h.checkpoint();
    db.rows.push({ msg_id: "9", read_ct: 0, message: { community_id: createRunScope("unit").uuid() }, archived: false });
    await assert.rejects(h.checkpoint(), refusedWith("ISOLATION_FOREIGN_QUEUE"));
    await assert.rejects(h.finish(), refusedWith("QUEUE_RESIDUE"));
    assert.equal(state.unlocked, 1, "the mutex was released anyway");
    assert.equal(db.rows[0]!.archived, false, "finish never archives a foreign message");
  });

  it("testOwner owns only the communities tracked since the last checkpoint", async () => {
    const { connect } = harnessDb();
    const h = createFileHarness(env, "unit", { connect });
    await h.start();
    await h.checkpoint();
    const first = h.scope.uuid();
    h.track(first);
    assert.equal(h.testOwner.owns(first), true);
    await h.checkpoint();
    assert.equal(h.testOwner.owns(first), false, "the previous test's community is no longer owned");
    const second = h.scope.uuid();
    h.track(second);
    assert.equal(h.testOwner.owns(second), true);
    assert.equal(h.testOwner.owns(h.scope.uuid()), false, "issued but untracked");
    assert.equal(h.testOwner.owns(createRunScope("unit").uuid()), false, "another run's id");
    await h.finish();
  });

  it("a handle read in one test cannot be archived after the next checkpoint", async () => {
    const { db, connect } = harnessDb();
    const h = createFileHarness(env, "unit", { connect });
    await h.start();
    await h.checkpoint();
    const community = h.scope.uuid();
    h.track(community);
    db.rows.push({ msg_id: "5", read_ct: 0, message: { community_id: community }, archived: false });
    const [message] = await findOwnQueueMessages(db.sql, h.testOwner, [community]);
    await h.recoverOwnQueue(); // afterEach archives it
    assert.equal(db.rows[0]!.archived, true);
    await h.checkpoint();
    await assert.rejects(archiveOwnQueueMessage(db.sql, h.testOwner, message!), refusedWith("QUEUE_MESSAGE_NOT_OWNED"));
    await h.finish();
  });

  it("recoverOwnQueue() archives only the current test's leftovers; earlier tests' and foreign messages stay", async () => {
    const { db, connect } = harnessDb();
    const h = createFileHarness(env, "unit", { connect });
    await h.start();
    await h.checkpoint();
    const earlier = h.scope.uuid();
    h.track(earlier);
    await h.checkpoint();
    const current = h.scope.uuid();
    h.track(current);
    const foreign = createRunScope("unit").uuid();
    db.rows.push(
      { msg_id: "1", read_ct: 0, message: { community_id: earlier }, archived: false },
      { msg_id: "2", read_ct: 0, message: { community_id: current }, archived: false },
      { msg_id: "3", read_ct: 0, message: { community_id: foreign }, archived: false },
    );
    await h.recoverOwnQueue();
    assert.deepEqual(db.rows.map((r) => r.archived), [false, true, false]);
    const reads = db.calls.filter((c) => c.text.startsWith(OWN_PREFIX));
    assert.deepEqual(reads.at(-1)!.params, [current], "the recovery read names only the current test's community");
    await assert.rejects(h.finish(), refusedWith("QUEUE_RESIDUE"), "the other messages are reported, not touched");
  });

  it("recoverOwnQueue() records a failure instead of throwing, and the next checkpoint reports it", async () => {
    const { db, connect } = harnessDb();
    const h = createFileHarness(env, "unit", { connect });
    await h.start();
    await h.checkpoint();
    const community = h.scope.uuid();
    h.track(community);
    db.rows.push({ msg_id: "4", read_ct: 0, message: { community_id: community }, archived: false });
    db.override = (text) => (text === ARCHIVE_TEXT ? [{ archived: false }] : undefined);
    await h.recoverOwnQueue();
    await assert.rejects(h.checkpoint(), refusedWith("QUEUE_RECOVERY_FAILED"));
    db.override = undefined;
    await assert.rejects(h.finish(), refusedWith("QUEUE_RECOVERY_FAILED"));
  });

  it("a clean file passes start, checkpoint, recovery and finish without any queue write", async () => {
    const { db, state, connect } = harnessDb();
    const h = createFileHarness(env, "unit", { connect });
    await h.start();
    await h.checkpoint();
    h.track(h.scope.uuid());
    await h.recoverOwnQueue();
    await h.quarantineOwn();
    await h.finish();
    assert.equal(state.unlocked, 1);
    assert.equal(db.calls.filter((c) => c.text === ARCHIVE_TEXT).length, 0);
    assert.ok(db.calls.some((c) => c.text === QUEUE_STATE_SQL), "the queue was checked");
  });
});
