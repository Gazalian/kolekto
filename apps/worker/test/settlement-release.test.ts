import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SETTLEMENT_RELEASE_BATCH,
  releaseDueSettlements,
  settlementReleaseAllowed,
  settlementReleaseLogLine,
} from "../src/settlement-release.ts";

type Recorded = { text: string; values: unknown[] };

function fakeSql(answer: (text: string) => unknown[]) {
  const log: Recorded[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    log.push({ text, values });
    return answer(text);
  }) as unknown as Parameters<typeof settlementReleaseAllowed>[0];
  return { sql, log };
}

describe("settlementReleaseAllowed", () => {
  it("runs only where the function exists and this role may execute it", async () => {
    assert.deepEqual(await settlementReleaseAllowed(fakeSql(() => [{ ok: true }]).sql), { enabled: true });
    assert.deepEqual(await settlementReleaseAllowed(fakeSql(() => [{ ok: false }]).sql), {
      enabled: false,
      reason: "release_due_settlements_missing_or_not_executable",
    });
    assert.deepEqual(await settlementReleaseAllowed(fakeSql(() => []).sql), {
      enabled: false,
      reason: "release_due_settlements_missing_or_not_executable",
    });
  });

  it("probes by exact signature with has_function_privilege (a missing function is not an error)", async () => {
    const { sql, log } = fakeSql(() => [{ ok: true }]);
    await settlementReleaseAllowed(sql);
    assert.match(log[0]!.text, /has_function_privilege\(to_regprocedure\('app\.release_due_settlements\(integer\)'\)/);
  });
});

describe("releaseDueSettlements", () => {
  it("calls the database function with the batch limit and reads kobo as text", async () => {
    const { sql, log } = fakeSql(() => [{ released: 2, released_kobo: "980000", awaiting_provider: 1, awaiting_provider_kobo: "490000" }]);
    const row = await releaseDueSettlements(sql);
    assert.deepEqual(row, { released: 2, released_kobo: "980000", awaiting_provider: 1, awaiting_provider_kobo: "490000" });
    assert.match(log[0]!.text, /from app\.release_due_settlements\(\?::integer\)/);
    assert.deepEqual(log[0]!.values, [SETTLEMENT_RELEASE_BATCH]);
    assert.match(log[0]!.text, /released_kobo::text/);
  });

  it("an empty answer is nothing released", async () => {
    const row = await releaseDueSettlements(fakeSql(() => []).sql, 10);
    assert.deepEqual(row, { released: 0, released_kobo: "0", awaiting_provider: 0, awaiting_provider_kobo: "0" });
  });
});

describe("settlementReleaseLogLine", () => {
  it("logs counts and kobo totals only", () => {
    assert.deepEqual(
      settlementReleaseLogLine({ released: 3, released_kobo: "1470000", awaiting_provider: 0, awaiting_provider_kobo: "0" }),
      { msg: "settlement_release", released: 3, released_kobo: "1470000", awaiting_provider: 0, awaiting_provider_kobo: "0" },
    );
  });

  it("says nothing when nothing happened", () => {
    assert.equal(settlementReleaseLogLine({ released: 0, released_kobo: "0", awaiting_provider: 0, awaiting_provider_kobo: "0" }), null);
  });

  it("still reports payments that are due but waiting on the provider", () => {
    const line = settlementReleaseLogLine({ released: 0, released_kobo: "0", awaiting_provider: 4, awaiting_provider_kobo: "1960000" });
    assert.equal(line?.awaiting_provider, 4);
  });

  it("never passes a malformed amount through", () => {
    const line = settlementReleaseLogLine({ released: 1, released_kobo: "1e9", awaiting_provider: 0, awaiting_provider_kobo: "-5" });
    assert.equal(line?.released_kobo, "0");
    assert.equal(line?.awaiting_provider_kobo, "0");
  });
});
