import { nairaToKobo } from "./money.ts";
import { resolveTierNames } from "./tier-name.ts";
import { normalisePrefix, resolveTierPrefixes } from "./prefix.ts";

/**
 * Collection transformation, per MIGRATION-DECISION-EVIDENCE.md.
 * Pure — no I/O, no database, no globals.
 */

export type LegacyCollectionType = "fixed" | "tiered" | "ticket" | "fundraising" | "open_pool" | (string & {});
export type LegacyStatus = "active" | "closed" | "deleted" | "paused" | "rejected" | (string & {});

export type NewCategory = "dues" | "contribution" | "event" | "fundraiser" | "items" | "other";
export type NewAmountModel = "fixed" | "open_amount" | "tiers" | "per_member" | "items";
export type NewStatus = "draft" | "scheduled" | "active" | "paused" | "closed" | "suspended" | "archived";
export type FeeMode = "community_absorbs" | "contributor_pays";

export interface LegacyCollection {
  readonly id: string;
  readonly user_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly slug: string;
  readonly status: LegacyStatus;
  readonly collection_type: LegacyCollectionType;
  readonly type: string;
  readonly amount: string;
  readonly target_amount: string | null;
  readonly min_contribution: string | null;
  readonly fee_bearer: string;
  readonly currency: string;
  readonly deadline: Date | null;
  readonly event_date: Date | null;
  readonly rejection_reason: string | null;
  readonly banner_url: string | null;
  readonly story: unknown;
  readonly price_tiers: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface LegacyTierEntry {
  readonly ord: number;
  readonly id: string | null;
  readonly name: string;
  readonly price: string | number;
  readonly prefix: string | null;
  readonly description: string | null;
  readonly quantity: number | null | undefined;
  readonly remaining_quantity: number | null | undefined;
  readonly sold_quantity: number | null | undefined;
}

export type CollectionOutcome =
  | { readonly kind: "excluded"; readonly reason: "rejected_campaign" }
  | { readonly kind: "imported"; readonly row: NewCollectionRow; readonly tiers: readonly NewTierRow[] };

export interface NewCollectionRow {
  readonly id: string;                // fresh UUID
  readonly source_collection_id: string;
  readonly community_id: string;      // the organiser's personal community
  readonly created_by: string;        // legacy user_id, UUIDs preserved
  readonly slug: string;
  readonly name: string;
  readonly category: NewCategory;
  readonly amount_model: NewAmountModel;
  readonly participation_mode: "open" | "managed";
  readonly audience_mode: "public" | "all_members" | "groups" | "selected_members";
  readonly status: NewStatus;
  readonly fixed_amount_kobo: bigint | null;
  readonly target_amount_kobo: bigint | null;
  readonly min_amount_kobo: bigint | null;
  readonly deadline_at: Date | null;
  readonly event_starts_at: Date | null;
  readonly fee_mode: FeeMode;
  readonly cover_url: null;                              // D10: nulled at import
  readonly archived_at: Date | null;
  readonly published_at: Date | null;
  readonly published_by: string | null;
  readonly is_imported: true;
  readonly source_system: "kolekto-v1";
  readonly source_table: "collections";
  readonly source_id: string;
  readonly legacy_fields: Record<string, unknown>;       // preserved in migration.legacy_collection.fields
}

export interface NewTierRow {
  readonly id: string;                // fresh UUID
  readonly source_tier_id: string | null;
  readonly collection_id: string;
  readonly name: string;
  readonly price_kobo: bigint;
  readonly code_prefix: string | null;
  readonly description: string | null;
  readonly quantity_limit: number | null;
  readonly sort_order: number;
  readonly legacy_fields: Record<string, unknown>;
}

// Deterministic UUID-v5-ish namespacing so re-import produces the same target ids.
// We derive from `<import_run_id>|<kind>|<legacy_id>` and stamp a v4/8/HEX bit pattern.
export function deriveTargetUuid(importRunId: string, kind: string, legacyId: string, sha256HexPrefix: string): string {
  const hex = sha256HexPrefix.slice(0, 32);
  if (hex.length !== 32 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error("deriveTargetUuid needs a lowercase hex prefix of at least 32 chars");
  }
  // Stamp version=8 (custom) and variant=10xx per RFC 4122.
  const bytes = Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;   // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;   // variant
  const h = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  // Note: `importRunId`, `kind`, `legacyId` are the caller's contract to hash into `sha256HexPrefix`.
  void importRunId; void kind; void legacyId;
}

const CAMPAIGN_UUID = "2b4fe58a-d1b2-4081-8f59-90287b96eba0"; // D3 evidence: the rejected campaign

export function classify(legacy: LegacyCollection): { amount_model: NewAmountModel; category: NewCategory } {
  // F-L3: collection_type is authoritative for category. type is retained as provenance.
  switch (legacy.collection_type) {
    case "fixed":
      return { amount_model: "fixed", category: "contribution" };
    case "tiered":
      return { amount_model: "tiers", category: "contribution" };
    case "ticket":
      return { amount_model: "tiers", category: "event" };
    case "fundraising":
      return { amount_model: "open_amount", category: "fundraiser" };
    case "open_pool":
      return { amount_model: "open_amount", category: "contribution" };
    default:
      throw new Error(`classify: unknown legacy collection_type ${JSON.stringify(legacy.collection_type)}`);
  }
}

const STATUS_MAP: Record<LegacyStatus, NewStatus | "excluded"> = {
  active: "active", closed: "closed", paused: "paused",
  deleted: "archived",
  rejected: "excluded",
};

/** Legacy fee_bearer → new fee_mode. */
export function feeMode(fee_bearer: string): FeeMode {
  if (fee_bearer === "contributor") return "contributor_pays";
  if (fee_bearer === "organizer") return "community_absorbs";
  throw new Error(`feeMode: unknown legacy fee_bearer ${JSON.stringify(fee_bearer)}`);
}

export interface TransformInput {
  readonly legacy: LegacyCollection;
  readonly tiers: readonly LegacyTierEntry[];
  readonly newCollectionId: string;
  readonly newTierIds: readonly string[];               // one per tier in order
  readonly communityId: string;
}

export function transformCollection(input: TransformInput): CollectionOutcome {
  const { legacy, tiers, newCollectionId, newTierIds, communityId } = input;

  // D3 (E-COL-2): the rejected campaign is not a live collection.
  if (legacy.id === CAMPAIGN_UUID || legacy.status === "rejected") {
    return { kind: "excluded", reason: "rejected_campaign" };
  }
  if (STATUS_MAP[legacy.status] === "excluded") {
    // any other 'rejected' surface would also be excluded — defensive
    return { kind: "excluded", reason: "rejected_campaign" };
  }

  const { amount_model, category } = classify(legacy);

  // Status and archival (D1 E-COL-1)
  let status = STATUS_MAP[legacy.status] as NewStatus;
  let archived_at: Date | null = null;
  if (legacy.status === "deleted") {
    status = "archived";
    archived_at = legacy.updated_at;
  }

  // D2 (the "Mr" collection): archive on import
  const TWO_CHAR_TITLE_ID = "40e4cc9e-72c8-4088-aaf5-ce25ebc1dbd1";
  let name = legacy.title.trim().replace(/\s+/g, " ");
  if (legacy.id === TWO_CHAR_TITLE_ID) {
    status = "archived";
    archived_at = legacy.updated_at;
    name = "Mr (archived on import)";
  }

  // Truncate title if it is longer than 80 chars (unlikely in D2 population, but supported).
  if (name.length > 80) name = name.slice(0, 80);
  if (name.length < 3) name = `${name} (archived on import)`;

  const amount = nairaToKobo(legacy.amount) ?? 0n;
  const target = nairaToKobo(legacy.target_amount);
  const min = nairaToKobo(legacy.min_contribution);

  // Amount-model coherence (per new constraints):
  //  fixed: fixed_amount_kobo = amount (may be 0 — D5 free fixed)
  //  open_amount / tiers: fixed_amount_kobo must be null
  const fixed_amount_kobo = amount_model === "fixed" ? amount : null;
  const target_amount_kobo = amount_model === "open_amount" ? target : null;
  const min_amount_kobo = amount_model === "open_amount" ? min : null;

  // published_at / published_by come together. Anything not-draft counts as published.
  const published_at: Date | null = status === "archived" ? legacy.updated_at : legacy.created_at;
  const published_by: string | null = published_at !== null ? legacy.user_id : null;

  // Tier renaming and prefix resolution (F-L4, D5, D6, D7)
  const forName = tiers.map((t) => ({
    ord: t.ord, rawName: t.name, rawPrefix: t.prefix, rawDescription: t.description,
  }));
  const nameMap = resolveTierNames(forName);
  const forPrefix = tiers.map((t) => ({ ord: t.ord, rawPrefix: t.prefix, priceKobo: nairaToKobo(t.price)! }));
  const prefixMap = resolveTierPrefixes(forPrefix);

  const newTiers: NewTierRow[] = amount_model === "tiers"
    ? tiers.map((t, i) => {
        const priceKobo = nairaToKobo(t.price);
        if (priceKobo == null || priceKobo <= 0n) {
          throw new Error(`tier price must be > 0 on ${legacy.slug} tier ord ${t.ord}`);
        }
        // D7: quantity=0 with sold=0 and no key → unlimited (null). This applies
        // per-tier: if quantity is 0 and there is no sales history, we treat it
        // as unset; otherwise the number is respected. This is *not* a universal
        // "0 means unlimited" rule.
        const quantity_limit = (() => {
          if (t.quantity == null) return null;
          if (t.quantity === 0 && (t.sold_quantity ?? 0) === 0) return null;
          return t.quantity > 0 ? t.quantity : null;
        })();
        return {
          id: newTierIds[i]!,
          source_tier_id: t.id,
          collection_id: newCollectionId,
          name: nameMap.get(t.ord)!,
          price_kobo: priceKobo,
          code_prefix: prefixMap.get(t.ord) ?? null,
          description: t.description,
          quantity_limit,
          sort_order: t.ord,
          legacy_fields: {
            id: t.id, name: t.name, prefix: t.prefix, price: t.price,
            quantity: t.quantity, remaining_quantity: t.remaining_quantity, sold_quantity: t.sold_quantity,
            description: t.description,
            _legacy_prefix_before_normalise: t.prefix,
            _legacy_prefix_after_normalise: normalisePrefix(t.prefix),
            _legacy_quantity_note: t.quantity === 0 && (t.sold_quantity ?? 0) === 0 ? "quantity=0, never sold" : undefined,
          },
        };
      })
    : [];

  const legacy_fields: Record<string, unknown> = {
    title: legacy.title, type: legacy.type, currency: legacy.currency,
    amount: legacy.amount, target_amount: legacy.target_amount, min_contribution: legacy.min_contribution,
    fee_bearer: legacy.fee_bearer, rejection_reason: legacy.rejection_reason,
    banner_url: legacy.banner_url, story: legacy.story, price_tiers: legacy.price_tiers,
    ...(legacy.status === "deleted"
      ? { _e_col_1_archival_note: "updated_at used as archival proxy; legacy schema records no deletion timestamp" }
      : {}),
    ...(fixed_amount_kobo === 0n && amount_model === "fixed"
      ? { _legacy_amount_note: "free fixed collection" }
      : {}),
    ...(amount_model === "tiers" && Array.isArray(legacy.price_tiers) && (legacy.price_tiers as unknown[]).length === 0
      ? { _a03_note: "legacy ticket collection had an empty tier list" }
      : {}),
  };

  return {
    kind: "imported",
    row: {
      id: newCollectionId,
      source_collection_id: legacy.id,
      community_id: communityId,
      created_by: legacy.user_id,
      slug: legacy.slug,
      name,
      category, amount_model,
      participation_mode: "open",
      audience_mode: "public",
      status,
      fixed_amount_kobo, target_amount_kobo, min_amount_kobo,
      deadline_at: legacy.deadline,
      event_starts_at: legacy.event_date,
      fee_mode: feeMode(legacy.fee_bearer),
      cover_url: null,
      archived_at,
      published_at, published_by,
      is_imported: true,
      source_system: "kolekto-v1",
      source_table: "collections",
      source_id: legacy.id,
      legacy_fields,
    },
    tiers: newTiers,
  };
}
