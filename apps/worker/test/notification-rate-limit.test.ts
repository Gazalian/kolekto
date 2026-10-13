import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  reserveEmailAttempt,
  getSendLimits,
  purgeStaleSendAttempts,
} from "../src/notification-rate-limit.ts";

/**
 * Same recording stand-in as notification-send-claim.test.ts: matches
 * SQL fragments and answers with canned rows. The rate-limit guarantees
 * live in the database function (migration 20261013200000, proved by
 * supabase/tests/38); what is proved here is that this module calls
 * them narrowly — ids only, never addresses — and maps answers faithfully.
 */
function fakeDb(answer: (text: string) => unknown[]) {
  const log: string[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    log.push(`${text} :: ${JSON.stringify(values)}`);
    return answer(text);
  }) as unknown as {
    (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
    json: (v: unknown) => unknown;
  };
  tx.json = (v: unknown) => ({ __json: v });
  return { sql: tx as unknown as Parameters<typeof reserveEmailAttempt>[0], log };
}

const DELIVERY = "ca300000-0000-4000-8000-000000000001";

describe("reserveEmailAttempt", () => {
  it("maps a granted reservation", async () => {
    const { sql, log } = fakeDb((text) =>
      text.includes("from app.reserve_email_attempt")
        ? [{ reservation: "granted", retry_at: null }]
        : [],
    );
    const result = await reserveEmailAttempt(sql, DELIVERY);
    assert.equal(result.reservation, "granted");
    assert.equal(result.retryAt, null);
    assert.match(log.join("\n"), /reserve_email_attempt/);
    assert.doesNotMatch(log.join("\n"), /@/);
  });

  it("maps an address_limited result", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("from app.reserve_email_attempt")
        ? [{ reservation: "address_limited", retry_at: null }]
        : [],
    );
    const result = await reserveEmailAttempt(sql, DELIVERY);
    assert.equal(result.reservation, "address_limited");
    assert.equal(result.retryAt, null);
  });

  it("maps a community_deferred result with retry_at", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("from app.reserve_email_attempt")
        ? [{ reservation: "community_deferred", retry_at: "2026-10-13T13:30:00Z" }]
        : [],
    );
    const result = await reserveEmailAttempt(sql, DELIVERY);
    assert.equal(result.reservation, "community_deferred");
    assert.equal(result.retryAt, "2026-10-13T13:30:00Z");
  });

  it("converts a Date retry_at to an ISO string", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("from app.reserve_email_attempt")
        ? [{ reservation: "community_deferred", retry_at: new Date("2026-10-13T13:30:00Z") }]
        : [],
    );
    const result = await reserveEmailAttempt(sql, DELIVERY);
    assert.equal(result.retryAt, "2026-10-13T13:30:00.000Z");
  });

  it("maps a backlog_full result", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("from app.reserve_email_attempt")
        ? [{ reservation: "backlog_full", retry_at: null }]
        : [],
    );
    const result = await reserveEmailAttempt(sql, DELIVERY);
    assert.equal(result.reservation, "backlog_full");
  });

  it("throws when the function returns no row", async () => {
    const { sql } = fakeDb(() => []);
    await assert.rejects(
      () => reserveEmailAttempt(sql, DELIVERY),
      { message: /returned no row/ },
    );
  });
});

describe("getSendLimits", () => {
  it("maps the approved configuration values", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("from app.notification_send_limits")
        ? [{
            l1_address: 3,
            l1_window_hours: 24,
            l2_community: 100,
            l2_window_hours: 1,
            l3_platform: 1000,
            l3_window_hours: 1,
            backlog_max: 500,
            max_attempts: 3,
          }]
        : [],
    );
    const limits = await getSendLimits(sql);
    assert.equal(limits.l1Address, 3);
    assert.equal(limits.l1WindowHours, 24);
    assert.equal(limits.l2Community, 100);
    assert.equal(limits.l2WindowHours, 1);
    assert.equal(limits.l3Platform, 1000);
    assert.equal(limits.l3WindowHours, 1);
    assert.equal(limits.backlogMax, 500);
    assert.equal(limits.maxAttempts, 3);
  });

  it("throws when the function returns no row", async () => {
    const { sql } = fakeDb(() => []);
    await assert.rejects(
      () => getSendLimits(sql),
      { message: /returned no row/ },
    );
  });
});

describe("purgeStaleSendAttempts", () => {
  it("returns the number of purged rows", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("app.purge_stale_send_attempts")
        ? [{ purge_stale_send_attempts: 7 }]
        : [],
    );
    assert.equal(await purgeStaleSendAttempts(sql), 7);
  });

  it("returns 0 when nothing was purged", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("app.purge_stale_send_attempts")
        ? [{ purge_stale_send_attempts: 0 }]
        : [],
    );
    assert.equal(await purgeStaleSendAttempts(sql), 0);
  });

  it("returns 0 on an empty result", async () => {
    const { sql } = fakeDb(() => []);
    assert.equal(await purgeStaleSendAttempts(sql), 0);
  });
});
