/**
 * itest-fixtures.ts — run-unique fixture identifiers and tags (M13.2 Phase 1c).
 *
 * Pure: no I/O, no database. Implements review §5.3 / checklist §3 "Isolation of
 * effects": every entity id is a fresh random UUID (never a fixed prefix plus a
 * counter), and a short run tag appears only in human-visible strings — slugs,
 * event keys, recipient addresses and the connection application_name — so
 * residue and connections are attributable to the run that created them.
 *
 *   const scope = createRunScope("sender-mailpit");
 *   const community = scope.uuid();               // random v4, never repeated
 *   const slug = scope.slug();                    // itest-<tag>-1
 *   const to = scope.address();                   // itest+<tag>-2@sender-mailpit.example.test
 *   const key = scope.eventKey();                 // itest-<tag>-sender-mailpit-3
 *   scope.owns(community)                         // true only for values this scope issued
 *
 * Isolation guarantees:
 *   - Two runs never share an id: ids come from the injected UUID source (the
 *     real one is crypto.randomUUID), are validated as lowercase v4 UUIDs, and a
 *     repeat within a scope is a refusal, not a silent reuse.
 *   - The shared residue of the old P8 file (community `p8-itest`, its owner,
 *     its owner term, `officer-recipient@kolekto.test`, review §4.4 / Q-D) and
 *     the fixed-id shape every pre-M13.2 integration file uses
 *     (`xxxx0000-0000-4000-8000-…`) can never be issued.
 *   - Ownership is exact: `owns()` accepts only values this scope issued. The
 *     quarantine builder (itest-quarantine.ts) uses it so a cleanup statement can
 *     only name rows the current run created.
 *
 * Nothing here deletes or cleans anything. Existing fixtures are left in place.
 */

import { randomUUID } from "node:crypto";

import { refuse } from "./itest-environment.ts";

/** Same format the environment gate requires of the stack ID: lowercase random UUID. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The fixed-id shape of the pre-M13.2 integration fixtures (`e8100000-0000-4000-8000-00000000000a`, …). */
const FIXED_FIXTURE_SHAPE = /^[0-9a-f]{4}0000-0000-4000-8000-[0-9a-f]{12}$/;

/** P8 residue on the developer database (review §4.4, Q-D). Never reused, never deleted by test code. */
export const RESERVED_FIXTURE_IDS: ReadonlySet<string> = new Set([
  "e8000000-0000-4000-8000-000000000001", // P8 owner (auth.users / public.users)
  "e8100000-0000-4000-8000-00000000000a", // P8 community, slug p8-itest
  "e8200000-0000-4000-8000-000000000001", // P8 owner term
]);
export const RESERVED_FIXTURE_SLUGS: ReadonlySet<string> = new Set(["p8-itest"]);
export const RESERVED_FIXTURE_ADDRESSES: ReadonlySet<string> = new Set([
  "officer-recipient@kolekto.test",
  "synthetic-recipient@kolekto.test",
]);

/** `public.communities.slug` format (20260917120300_communities.sql `communities_slug_format`). */
export const COMMUNITY_SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

/** A short lowercase label naming the integration file, e.g. "sender-mailpit". Used as the address subdomain. */
const FILE_LABEL = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;
const RUN_TAG = /^[0-9a-f]{8}$/;

/** Address limits the email validator enforces (packages/adapters email-provider.ts). */
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;

export interface RunScopeDeps {
  /** Source of v4 UUIDs. Real runs use crypto.randomUUID; unit tests inject a deterministic sequence. */
  readonly randomUUID: () => string;
}

export interface RunScope {
  /** 8 lowercase hex characters, random per scope. Appears only in human-visible strings. */
  readonly runTag: string;
  readonly fileLabel: string;
  /** `kolekto-itest-<tag>`: set as the connection application_name so connections are attributable. */
  readonly applicationName: string;
  /** A fresh random entity id (community, user, term, event, delivery, audit id). */
  uuid(): string;
  /** `itest-<tag>-<n>`; satisfies the community slug constraint. */
  slug(): string;
  /** `itest+<tag>-<n>@<file>.example.test`; unique per call, per run. */
  address(): string;
  /** `itest-<tag>-<file>-<n>`; notification_events.event_key is globally unique. */
  eventKey(): string;
  /** True only for a value this scope issued (exact match). */
  owns(value: string): boolean;
  /** True when a string carries this run's tag in the issued form (residue attribution). */
  isTagged(value: string): boolean;
}

function checkUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw refuse("FIXTURE_INPUT_INVALID", "The UUID source returned a value that is not a lowercase random (version 4) UUID.");
  }
  if (RESERVED_FIXTURE_IDS.has(value) || FIXED_FIXTURE_SHAPE.test(value)) {
    throw refuse("FIXTURE_ID_RESERVED", "The UUID source returned a fixed or reserved fixture id (P8 residue shape). Integration fixtures must use random ids.");
  }
  return value;
}

export function createRunScope(fileLabel: string, deps: RunScopeDeps = { randomUUID }): RunScope {
  if (typeof fileLabel !== "string" || !FILE_LABEL.test(fileLabel)) {
    throw refuse("FIXTURE_INPUT_INVALID", "The file label must be 2-24 lowercase letters, digits or hyphens, starting with a letter.");
  }
  const runTag = checkUuid(deps.randomUUID()).replaceAll("-", "").slice(0, 8);
  if (!RUN_TAG.test(runTag)) {
    throw refuse("FIXTURE_INPUT_INVALID", "Could not derive an 8-hex run tag.");
  }

  const issued = new Set<string>();
  let counter = 0;

  const issue = (value: string): string => {
    if (issued.has(value)) {
      throw refuse("FIXTURE_ID_COLLISION", "The UUID source repeated a value within one run. Fixture ids are never reused.");
    }
    issued.add(value);
    return value;
  };
  const next = () => ++counter;

  const slugPrefix = `itest-${runTag}-`;
  const addressPrefix = `itest+${runTag}-`;
  const addressDomain = `@${fileLabel}.example.test`;

  return Object.freeze({
    runTag,
    fileLabel,
    applicationName: `kolekto-itest-${runTag}`,
    uuid: () => issue(checkUuid(deps.randomUUID())),
    slug() {
      const slug = `${slugPrefix}${next()}`;
      if (!COMMUNITY_SLUG_FORMAT.test(slug) || RESERVED_FIXTURE_SLUGS.has(slug)) {
        throw refuse("FIXTURE_INPUT_INVALID", "A generated slug does not satisfy the community slug format.");
      }
      return issue(slug);
    },
    address() {
      const local = `${addressPrefix}${next()}`;
      const address = `${local}${addressDomain}`;
      if (local.length > MAX_LOCAL_PART_LENGTH || address.length > MAX_ADDRESS_LENGTH || RESERVED_FIXTURE_ADDRESSES.has(address)) {
        throw refuse("FIXTURE_INPUT_INVALID", "A generated address exceeds the email length limits.");
      }
      return issue(address);
    },
    eventKey: () => issue(`${slugPrefix}${fileLabel}-${next()}`),
    owns: (value: string) => issued.has(value),
    isTagged: (value: string) => typeof value === "string" && (value.startsWith(slugPrefix) || value.startsWith(addressPrefix) || value === `kolekto-itest-${runTag}`),
  });
}
