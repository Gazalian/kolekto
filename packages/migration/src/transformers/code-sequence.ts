/**
 * Legacy contribution_code_counters → public.collection_code_sequences.
 *
 * Purpose: a newly-issued code must never collide with a historical one.
 * We seed `next_number` from legacy.
 *
 * Note on the new schema: `collection_code_sequences` is keyed by
 * `(collection_id, tier_id)`. Legacy counters were keyed by
 * `(collection_id, prefix)`, and legacy prefixes may not match new tier ids
 * — some tiers had no id at all. For each legacy counter we resolve the
 * target `tier_id` by looking up the tier that KEEPS the corresponding
 * normalised prefix (i.e. the surviving tier after prefix disambiguation).
 * If no tier holds the prefix in the new schema, the counter has no
 * destination and is preserved in `legacy_collection.fields`.
 */

import { normalisePrefix } from "./prefix.ts";

export interface LegacyCodeCounter {
  readonly collection_id: string;
  readonly prefix: string;
  readonly next_number: number;
}

export interface NewTierPrefixLookup {
  readonly new_collection_id: string;
  readonly new_tier_id: string;
  readonly normalised_prefix: string;
}

export interface NewCodeSequenceRow {
  readonly collection_id: string;
  readonly tier_id: string;
  readonly next_number: bigint;
}

export interface CodeSequenceResolution {
  readonly rows: readonly NewCodeSequenceRow[];
  readonly orphaned: readonly LegacyCodeCounter[];
}

export function resolveCodeSequences(
  legacyCounters: readonly LegacyCodeCounter[],
  tierLookup: readonly NewTierPrefixLookup[],
  collectionMap: ReadonlyMap<string, string>,   // legacy id → new id
): CodeSequenceResolution {
  const byKey = new Map<string, NewTierPrefixLookup>();
  for (const l of tierLookup) byKey.set(`${l.new_collection_id}|${l.normalised_prefix}`, l);
  const rows: NewCodeSequenceRow[] = [];
  const orphaned: LegacyCodeCounter[] = [];
  for (const c of legacyCounters) {
    const newCollectionId = collectionMap.get(c.collection_id);
    if (!newCollectionId) { orphaned.push(c); continue; }
    const key = `${newCollectionId}|${normalisePrefix(c.prefix) ?? ""}`;
    const hit = byKey.get(key);
    if (!hit) { orphaned.push(c); continue; }
    rows.push({
      collection_id: newCollectionId,
      tier_id: hit.new_tier_id,
      next_number: BigInt(Math.max(0, Math.floor(c.next_number))),
    });
  }
  return { rows, orphaned };
}
