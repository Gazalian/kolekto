/**
 * itest-mailpit.ts — exact-match identification of one Mailpit message (M13.2 Phase 1c).
 *
 * Pure: no HTTP. The integration file performs the Mailpit request on the
 * verified test-stack origin and hands the parsed JSON in; this module only
 * decides. (Repository guard: no file under test/support/ performs network I/O.)
 *
 * Matching contract (review §5.4, checklist §3 "Mailpit"):
 *   A message is "ours" only when ALL of these hold for a message-list entry
 *   (`GET /api/v1/messages` or `/api/v1/search`, field names as the existing P8
 *   file reads them, plus `MessageID`):
 *     1. `To` holds exactly one recipient, and its `Address` equals the expected
 *        address exactly. The expected address must be a run-scoped address
 *        (`itest+<runTag>-…`), so a shared fixture address can never be matched.
 *     2. `Subject` equals the expected subject exactly (no substring match).
 *     3. `MessageID` equals the expected Message-ID exactly, angle brackets
 *        optional. The expected value is what the Mailpit adapter derives from
 *        the delivery id: sha256(idempotencyKey) hex, first 32 characters, plus
 *        `@kolekto.invalid` (review F15) — it is also the stored
 *        provider_message_id.
 *   Content (Text / HTML of the full message) is checked separately against
 *   required fragments, after the message has been identified exactly.
 *
 * Ambiguity handling:
 *   - 0 matches → MAILPIT_NO_MATCH (the caller polls, bounded, then fails).
 *   - > 1 match → MAILPIT_AMBIGUOUS (a duplicate send is a failure, never
 *     "pick the newest").
 *   - An entry with the expected Message-ID but another recipient or subject →
 *     MAILPIT_AMBIGUOUS (the Message-ID is meant to be unique to this delivery).
 *   - A malformed list or entry → MAILPIT_RESPONSE_INVALID: an entry that cannot
 *     be read might be ours, so it is never silently ignored.
 *   - Inbox-wide counts (`total`, `messages_count`) are never read, the inbox is
 *     never cleared, and list order is never relied upon.
 *
 * [U] The `MessageID` field name and its bracket form are confirmed against the
 * running Mailpit v1.30.2 in Phase 3/5 (checklist D-5). A different field name
 * fails closed here (MAILPIT_RESPONSE_INVALID), it cannot silently match.
 */

import { createHash } from "node:crypto";

import { refuse } from "./itest-environment.ts";

/** The Mailpit adapter's Message-ID domain (packages/adapters mailpit-email-provider.ts). */
export const MESSAGE_ID_DOMAIN = "kolekto.invalid";

const MESSAGE_ID = /^[0-9a-f]{32}@kolekto\.invalid$/;
const RUN_SCOPED_ADDRESS = /^itest\+([0-9a-f]{8})-[1-9][0-9]*@[a-z][a-z0-9-]*[a-z0-9]\.example\.test$/;

export interface ExpectedMessage {
  /** A run-scoped recipient issued by RunScope.address(). */
  readonly to: string;
  readonly subject: string;
  /** expectedMessageId(deliveryId), or the step's providerMessageId. */
  readonly messageId: string;
  /** The RunScope's tag; must be the tag inside `to`. */
  readonly runTag: string;
}

export interface MailpitListEntry {
  readonly ID: string;
  readonly MessageID: string;
  readonly To: readonly { readonly Address: string }[];
  readonly Subject: string;
}

/** The Message-ID the Mailpit adapter sends for an idempotency key (the delivery id). */
export function expectedMessageId(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || idempotencyKey === "") {
    throw refuse("MAILPIT_EXPECTATION_INVALID", "The idempotency key must be a non-empty string.");
  }
  return `${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}@${MESSAGE_ID_DOMAIN}`;
}

function checkExpectation(expected: ExpectedMessage): void {
  const tag = RUN_SCOPED_ADDRESS.exec(typeof expected.to === "string" ? expected.to : "")?.[1];
  if (tag === undefined) {
    throw refuse("MAILPIT_EXPECTATION_INVALID", "The expected recipient is not a run-scoped itest address; shared fixture addresses cannot be matched.");
  }
  if (tag !== expected.runTag) {
    throw refuse("MAILPIT_EXPECTATION_INVALID", "The expected recipient does not carry this run's tag.");
  }
  if (typeof expected.subject !== "string" || expected.subject.trim() === "") {
    throw refuse("MAILPIT_EXPECTATION_INVALID", "The expected subject must be a non-empty string.");
  }
  if (typeof expected.messageId !== "string" || !MESSAGE_ID.test(expected.messageId)) {
    throw refuse("MAILPIT_EXPECTATION_INVALID", "The expected Message-ID is not <32 hex>@kolekto.invalid.");
  }
}

const stripBrackets = (id: string) => id.replace(/^<(.*)>$/, "$1");

function readEntry(raw: unknown, index: number): MailpitListEntry {
  const bad = () => refuse("MAILPIT_RESPONSE_INVALID", `Mailpit list entry ${index} is malformed; an unreadable entry might be ours, so the match is inconclusive.`);
  if (typeof raw !== "object" || raw === null) throw bad();
  const e = raw as Record<string, unknown>;
  if (typeof e["ID"] !== "string" || typeof e["MessageID"] !== "string" || typeof e["Subject"] !== "string" || !Array.isArray(e["To"])) throw bad();
  const to = e["To"].map((r: unknown) => {
    if (typeof r !== "object" || r === null || typeof (r as Record<string, unknown>)["Address"] !== "string") throw bad();
    return { Address: (r as { Address: string }).Address };
  });
  return { ID: e["ID"], MessageID: stripBrackets(e["MessageID"]), To: to, Subject: e["Subject"] };
}

/** Reads `{ messages: [...] }` strictly. Never reads `total`. */
export function readMessageList(list: unknown): MailpitListEntry[] {
  if (typeof list !== "object" || list === null || !Array.isArray((list as Record<string, unknown>)["messages"])) {
    throw refuse("MAILPIT_RESPONSE_INVALID", "The Mailpit response has no messages array.");
  }
  return ((list as { messages: unknown[] }).messages).map(readEntry);
}

const toAddress = (e: MailpitListEntry, address: string) => e.To.length === 1 && e.To[0]!.Address === address;

/** Every entry that matches the full contract. Throws on malformed input or a conflicting Message-ID. */
export function findExactMessages(list: unknown, expected: ExpectedMessage): MailpitListEntry[] {
  checkExpectation(expected);
  const entries = readMessageList(list);
  const exact: MailpitListEntry[] = [];
  for (const e of entries) {
    const sameId = e.MessageID === expected.messageId;
    const matches = sameId && toAddress(e, expected.to) && e.Subject === expected.subject;
    if (matches) exact.push(e);
    else if (sameId) {
      throw refuse("MAILPIT_AMBIGUOUS", "A message carries the expected Message-ID but a different recipient or subject.");
    }
  }
  return exact;
}

/** Exactly one exact match, or a refusal. Never "the newest message". */
export function selectExactlyOne(list: unknown, expected: ExpectedMessage): MailpitListEntry {
  const exact = findExactMessages(list, expected);
  if (exact.length === 0) {
    const sameRecipient = readMessageList(list).filter((e) => e.To.some((r) => r.Address === expected.to)).length;
    throw refuse("MAILPIT_NO_MATCH", `No message matches recipient, subject and Message-ID exactly (${sameRecipient} message(s) to the expected recipient).`);
  }
  if (exact.length > 1) {
    throw refuse("MAILPIT_AMBIGUOUS", `${exact.length} messages match exactly; a duplicate send is a failure.`);
  }
  return exact[0]!;
}

/**
 * Absence check for a run-scoped recipient (e.g. "a skipped row sends nothing").
 * Any message to that address — in To in any position — is a failure.
 */
export function assertNoMessageTo(list: unknown, to: string, runTag: string): void {
  const tag = RUN_SCOPED_ADDRESS.exec(typeof to === "string" ? to : "")?.[1];
  if (tag === undefined || tag !== runTag) {
    throw refuse("MAILPIT_EXPECTATION_INVALID", "Absence can only be asserted for a run-scoped itest address of this run.");
  }
  const found = readMessageList(list).filter((e) => e.To.some((r) => r.Address === to)).length;
  if (found > 0) throw refuse("MAILPIT_UNEXPECTED_MESSAGE", `${found} message(s) were delivered to a recipient that must receive none.`);
}

/** Checks a full message (`GET /api/v1/message/{ID}`) for required Text and HTML fragments. */
export function checkMessageContent(
  full: unknown,
  required: { readonly id: string; readonly text: readonly string[]; readonly html: readonly string[] },
): void {
  if (typeof full !== "object" || full === null) throw refuse("MAILPIT_RESPONSE_INVALID", "The Mailpit message response is not an object.");
  const m = full as Record<string, unknown>;
  if (m["ID"] !== required.id || typeof m["Text"] !== "string" || typeof m["HTML"] !== "string") {
    throw refuse("MAILPIT_RESPONSE_INVALID", "The Mailpit message response is not the identified message or lacks Text/HTML.");
  }
  if (required.text.length + required.html.length === 0) {
    throw refuse("MAILPIT_EXPECTATION_INVALID", "A content check needs at least one required fragment.");
  }
  const missing = [
    ...required.text.filter((f) => !(m["Text"] as string).includes(f)).map(() => "Text"),
    ...required.html.filter((f) => !(m["HTML"] as string).includes(f)).map(() => "HTML"),
  ];
  if (missing.length > 0) throw refuse("MAILPIT_CONTENT_MISMATCH", `${missing.length} required fragment(s) missing (${[...new Set(missing)].join(", ")}).`);
}
