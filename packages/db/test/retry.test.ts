import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isConnectionError, retryIfNotStarted } from "../src/retry.ts";

const reset = (): Error => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

describe("isConnectionError()", () => {
  it("recognises a dead connection by code or by message", () => {
    assert.equal(isConnectionError(reset()), true);
    assert.equal(isConnectionError(Object.assign(new Error("x"), { code: "CONNECTION_CLOSED" })), true);
    assert.equal(isConnectionError(new Error("write CONNECTION_CLOSED 127.0.0.1:54322")), true);
  });

  it("does not treat a database refusal as a connection problem", () => {
    // What a write function raises when it says no: never retried.
    const refusal = Object.assign(new Error("INVALID_AMOUNT: a fixed collection needs an amount"), { code: "P0001" });
    assert.equal(isConnectionError(refusal), false);
    assert.equal(isConnectionError(null), false);
    assert.equal(isConnectionError("ECONNRESET"), false);
  });
});

describe("retryIfNotStarted()", () => {
  it("retries once when the connection died before the work started", async () => {
    let calls = 0;
    const result = await retryIfNotStarted(async (markStarted) => {
      calls += 1;
      if (calls === 1) throw reset(); // a stale pooled socket fails on BEGIN
      markStarted();
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("never repeats work that had already started — a write may have landed", async () => {
    let calls = 0;
    await assert.rejects(
      retryIfNotStarted(async (markStarted) => {
        calls += 1;
        markStarted();
        throw reset();
      }),
      /ECONNRESET/,
    );
    assert.equal(calls, 1);
  });

  it("does not retry an error that is not a connection error", async () => {
    let calls = 0;
    await assert.rejects(
      retryIfNotStarted(async () => {
        calls += 1;
        throw Object.assign(new Error("NOT_FOUND: no such collection"), { code: "P0002" });
      }),
      /NOT_FOUND/,
    );
    assert.equal(calls, 1);
  });

  it("gives up after the second attempt and reports the real error", async () => {
    let calls = 0;
    await assert.rejects(
      retryIfNotStarted(async () => {
        calls += 1;
        throw reset();
      }),
      /ECONNRESET/,
    );
    assert.equal(calls, 2);
  });
});
