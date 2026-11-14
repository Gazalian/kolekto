/**
 * notification-send-message.test.ts — the P5 placeholder message.
 *
 * Offline. Asserts the placeholder is a valid request and carries no PII: the
 * recipient address appears only as the envelope `to`, never in the subject or
 * body, and real rendering is left to P7.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertValidEmailRequest } from "@kolekto/adapters";

import { buildPlaceholderMessage, PLACEHOLDER_SUBJECT } from "../src/notification-send-message.ts";

const ADDRESS = "member@example.test";

describe("placeholder message", () => {
  it("is a valid email request", () => {
    const message = buildPlaceholderMessage(ADDRESS);
    assert.doesNotThrow(() => assertValidEmailRequest({ idempotencyKey: "00000000-0000-4000-8000-000000000001", message }));
  });

  it("puts the address only in `to`, never in the subject or body", () => {
    const message = buildPlaceholderMessage(ADDRESS);
    assert.equal(message.to, ADDRESS);
    assert.ok(!message.subject.includes(ADDRESS));
    assert.ok(!message.text.includes(ADDRESS));
    assert.ok(message.subject.trim().length > 0);
    assert.ok(message.text.trim().length > 0);
    assert.equal(message.subject, PLACEHOLDER_SUBJECT);
  });

  it("carries no HTML part (templates are P7)", () => {
    assert.equal(buildPlaceholderMessage(ADDRESS).html, undefined);
  });
});
