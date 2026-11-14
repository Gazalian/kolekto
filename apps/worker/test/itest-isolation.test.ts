/**
 * itest-isolation.test.ts — M13.2 Phase 4: unit tests of the database-side isolation
 * helpers (test/support/itest-isolation.ts) with fake connections only. No database,
 * no SMTP, no Mailpit. The live behaviour is exercised by the integration lane.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { IntegrationGateError } from "./support/itest-environment.ts";
import type { ItestSql, ItestTx } from "./support/itest-db.ts";
import { createRunScope } from "./support/itest-fixtures.ts";
import {
  HEARTBEAT_SQL,
  inRollback,
  insertLedgerFillers,
  isRollbackHandle,
  L4_DAY_SQL,
  L5_RECENT_SQL,
  OPEN_EMAIL_ROWS_SQL,
  QUEUE_READ_SQL,
  runPreflight,
  waitForL5Headroom,
} from "./support/itest-isolation.ts";
import { QUEUE_STATE_SQL } from "./support/itest-queue.ts";

const refusedWith = (code: string) => (e: unknown) => e instanceof IntegrationGateError && e.has(code as never);

interface FakeTx {
  readonly tx: ItestTx;
  readonly queries: string[];
}

function fakeTx(rows: (text: string) => unknown[] = () => []): FakeTx {
  const queries: string[] = [];
  const fn = (async (strings: TemplateStringsArray) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push(text);
    return rows(text);
  }) as unknown as ItestTx & { array: unknown };
  (fn as unknown as { array: unknown }).array = (v: unknown[]) => ({ array: v });
  return { tx: fn, queries };
}

function fakePool(tx: ItestTx): { sql: ItestSql; state: { committed: boolean; rolledBack: boolean } } {
  const state = { committed: false, rolledBack: false };
  const sql = {
    async begin(cb: (t: unknown) => Promise<unknown>) {
      try {
        const out = await cb(tx);
        state.committed = true;
        return out;
      } catch (error) {
        state.rolledBack = true;
        throw error;
      }
    },
  } as unknown as ItestSql;
  return { sql, state };
}

describe("inRollback — always rolls back", () => {
  it("returns the callback's value, never commits, and the handle is a rollback handle only while the callback runs", async () => {
    const { tx } = fakeTx();
    const { sql, state } = fakePool(tx);
    let during = false;
    const value = await inRollback(sql, async (t) => {
      during = isRollbackHandle(t);
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(during, true);
    assert.equal(isRollbackHandle(tx), false, "the handle is released afterwards");
    assert.deepEqual(state, { committed: false, rolledBack: true });
  });

  it("rethrows the callback's own error unchanged (and still rolls back)", async () => {
    const { tx } = fakeTx();
    const { sql, state } = fakePool(tx);
    const boom = new Error("assertion failed");
    await assert.rejects(inRollback(sql, async () => { throw boom; }), (e: unknown) => e === boom);
    assert.deepEqual(state, { committed: false, rolledBack: true });
  });
});

describe("insertLedgerFillers — fillers can never commit", () => {
  const scope = createRunScope("unit");
  const deliveryId = scope.uuid();
  const communityId = scope.uuid();

  it("refuses a handle that is not a live inRollback transaction, before any query", async () => {
    const { tx, queries } = fakeTx();
    await assert.rejects(insertLedgerFillers(tx, scope, { deliveryId, communityId }, [{ addressKey: "a@b.test", secondsAgo: 1 }]), refusedWith("ROLLBACK_HANDLE_UNISSUED"));
    assert.deepEqual(queries, []);
    for (const bogus of [null, undefined, 1, "tx", {}]) {
      await assert.rejects(insertLedgerFillers(bogus as unknown as ItestTx, scope, { deliveryId, communityId }, [{ addressKey: "a@b.test", secondsAgo: 1 }]), refusedWith("ROLLBACK_HANDLE_UNISSUED"));
    }
  });

  it("refuses ids this run did not issue, and malformed or oversized filler sets", async () => {
    const other = createRunScope("unit");
    const cases: [string, { deliveryId: string; communityId: string }, unknown[]][] = [
      ["foreign delivery", { deliveryId: other.uuid(), communityId }, [{ addressKey: "a@b.test", secondsAgo: 1 }]],
      ["foreign community", { deliveryId, communityId: other.uuid() }, [{ addressKey: "a@b.test", secondsAgo: 1 }]],
      ["empty", { deliveryId, communityId }, []],
      ["too many", { deliveryId, communityId }, Array.from({ length: 201 }, () => ({ addressKey: "a@b.test", secondsAgo: 1 }))],
      ["upper-case address", { deliveryId, communityId }, [{ addressKey: "A@b.test", secondsAgo: 1 }]],
      ["fractional age", { deliveryId, communityId }, [{ addressKey: "a@b.test", secondsAgo: 1.5 }]],
      ["negative age", { deliveryId, communityId }, [{ addressKey: "a@b.test", secondsAgo: -1 }]],
      ["ancient age", { deliveryId, communityId }, [{ addressKey: "a@b.test", secondsAgo: 172_801 }]],
    ];
    for (const [label, target, fillers] of cases) {
      const { tx, queries } = fakeTx();
      const { sql } = fakePool(tx);
      await assert.rejects(inRollback(sql, (t) => insertLedgerFillers(t, scope, target, fillers as never)), refusedWith("LEDGER_FILLER_INVALID"), label);
      assert.deepEqual(queries, [], `${label}: no query`);
    }
  });

  it("inside inRollback, writes the whole set in one parameterised transactional insert", async () => {
    const { tx, queries } = fakeTx(() => [{ delivery_id: deliveryId }, { delivery_id: deliveryId }]);
    const { sql, state } = fakePool(tx);
    const n = await inRollback(sql, (t) => insertLedgerFillers(t, scope, { deliveryId, communityId }, [{ addressKey: "a@b.test", secondsAgo: 0 }, { addressKey: "c@d.test", secondsAgo: 30 }]));
    assert.equal(n, 2);
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /^insert into public\.notification_send_attempts \(delivery_id, community_id, address_key, send_class, attempted_at\) select \?::uuid, \?::uuid, f\.address_key, 'transactional'/);
    assert.match(queries[0]!, /from unnest\(\?::text\[\], \?::text\[\]\) as f\(address_key, secs\) returning delivery_id$/);
    assert.equal(state.committed, false);
  });

  it("refuses when the database wrote a different number of rows", async () => {
    const { tx } = fakeTx(() => [{ delivery_id: deliveryId }]);
    const { sql } = fakePool(tx);
    await assert.rejects(inRollback(sql, (t) => insertLedgerFillers(t, scope, { deliveryId, communityId }, [{ addressKey: "a@b.test", secondsAgo: 0 }, { addressKey: "a@b.test", secondsAgo: 1 }])), refusedWith("LEDGER_FILLER_INVALID"));
  });
});

function fakeUnsafe(answer: (text: string, call: number) => unknown): { sql: ItestSql; calls: string[] } {
  const calls: string[] = [];
  const sql = {
    async unsafe(text: string) {
      calls.push(text);
      const out = answer(text, calls.length);
      if (out instanceof Error) throw out;
      return out;
    },
  } as unknown as ItestSql;
  return { sql, calls };
}

describe("waitForL5Headroom — real pacing, bounded", () => {
  it("polls the server-side per-second count until it is zero", async () => {
    const { sql, calls } = fakeUnsafe((_t, n) => [{ recent: n < 3 ? 1 : 0 }]);
    await waitForL5Headroom(sql, 2_000);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c === L5_RECENT_SQL));
    assert.match(L5_RECENT_SQL, /^select count\(\*\)::int as recent from public\.notification_send_attempts where send_class = 'transactional' and attempted_at > now\(\) - interval '1 second'$/);
  });

  it("refuses with L5_HEADROOM_TIMEOUT when the window never empties", async () => {
    const { sql } = fakeUnsafe(() => [{ recent: 1 }]);
    await assert.rejects(waitForL5Headroom(sql, 300), refusedWith("L5_HEADROOM_TIMEOUT"));
  });

  it("refuses a non-numeric count instead of guessing", async () => {
    const { sql } = fakeUnsafe(() => [{ recent: "0" }]);
    await assert.rejects(waitForL5Headroom(sql, 300), refusedWith("PREFLIGHT_INCONCLUSIVE"));
  });
});

describe("runPreflight — checklist §7.6, read-only, fail closed", () => {
  const healthy: Record<string, unknown[]> = {
    [OPEN_EMAIL_ROWS_SQL]: [{ open_rows: 0 }],
    [HEARTBEAT_SQL]: [{ fresh: false }],
    [QUEUE_READ_SQL]: [{ read_messages: 0 }],
    [QUEUE_STATE_SQL]: [{ queued: 0, read_messages: 0 }],
    [L4_DAY_SQL]: [{ day_count: 17, day_cap: 180 }],
  };
  const run = (over: Record<string, unknown> = {}) => {
    const answers: Record<string, unknown> = { ...healthy, ...over };
    return fakeUnsafe((text) => {
      if (!(text in answers)) throw new Error(`unexpected statement ${text}`);
      return answers[text];
    });
  };

  it("passes on a quiet test stack and issues only the five constant selects", async () => {
    const { sql, calls } = run();
    assert.deepEqual(await runPreflight(sql), { dayCount: 17, dayCap: 180 });
    assert.deepEqual(calls, [OPEN_EMAIL_ROWS_SQL, HEARTBEAT_SQL, QUEUE_READ_SQL, QUEUE_STATE_SQL, L4_DAY_SQL]);
    for (const text of calls) assert.match(text, /^select /, "read-only");
  });

  const failing: [string, Record<string, unknown>, string][] = [
    ["an open email row", { [OPEN_EMAIL_ROWS_SQL]: [{ open_rows: 1 }] }, "PREFLIGHT_OPEN_DELIVERIES"],
    ["a fresh heartbeat", { [HEARTBEAT_SQL]: [{ fresh: true }] }, "PREFLIGHT_LIVE_WORKER"],
    ["a null heartbeat flag", { [HEARTBEAT_SQL]: [{ fresh: null }] }, "PREFLIGHT_LIVE_WORKER"],
    ["read queue messages", { [QUEUE_READ_SQL]: [{ read_messages: 2 }] }, "PREFLIGHT_QUEUE_CONSUMED"],
    ["an unread queued message (Phase 6A)", { [QUEUE_STATE_SQL]: [{ queued: 1, read_messages: 0 }] }, "PREFLIGHT_QUEUE_NOT_EMPTY"],
    ["a non-numeric queue length (Phase 6A)", { [QUEUE_STATE_SQL]: [{ queued: "0", read_messages: 0 }] }, "PREFLIGHT_INCONCLUSIVE"],
    ["L4 above cap − 40", { [L4_DAY_SQL]: [{ day_count: 141, day_cap: 180 }] }, "PREFLIGHT_L4_HEADROOM"],
    ["a missing sender-state row", { [HEARTBEAT_SQL]: [] }, "PREFLIGHT_INCONCLUSIVE"],
    ["two open-count rows", { [OPEN_EMAIL_ROWS_SQL]: [{ open_rows: 0 }, { open_rows: 0 }] }, "PREFLIGHT_INCONCLUSIVE"],
    ["a non-numeric L4 read", { [L4_DAY_SQL]: [{ day_count: "1", day_cap: 180 }] }, "PREFLIGHT_INCONCLUSIVE"],
    ["a failing read", { [QUEUE_READ_SQL]: Object.assign(new Error("boom postgresql://x:secret@h/db"), { code: "42P01" }) }, "PREFLIGHT_INCONCLUSIVE"],
  ];
  for (const [label, over, code] of failing) {
    it(`refuses on ${label} (${code})`, async () => {
      const { sql } = run(over);
      await assert.rejects(runPreflight(sql), (e: unknown) => {
        assert.ok(e instanceof IntegrationGateError && e.has(code as never), String(e));
        assert.ok(!String((e as Error).message).includes("secret"), "driver error text is withheld");
        return true;
      });
    });
  }

  it("allows exactly cap − 40 transactional attempts", async () => {
    const { sql } = run({ [L4_DAY_SQL]: [{ day_count: 140, day_cap: 180 }] });
    assert.deepEqual(await runPreflight(sql), { dayCount: 140, dayCap: 180 });
  });
});
