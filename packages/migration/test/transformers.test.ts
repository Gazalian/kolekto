import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  nairaToKobo,
  normalisePrefix,
  resolveTierPrefixes,
  resolveTierNames,
  transformCollection,
  transformUser,
  buildContributorCodeLink,
  resolveCodeSequences,
  type LegacyCollection,
  type LegacyTierEntry,
  type LegacyProfile,
} from "../src/transformers/index.ts";

// ── money ────────────────────────────────────────────────────────────────────
describe("nairaToKobo", () => {
  it("is exact for the two-decimal-place values D2 uses", () => {
    assert.equal(nairaToKobo("46069689.35"), 4_606_968_935n);
    assert.equal(nairaToKobo("60423653.63"), 6_042_365_363n);
    assert.equal(nairaToKobo("11403.83"), 1_140_383n);
    assert.equal(nairaToKobo("0"), 0n);
    assert.equal(nairaToKobo("0.00"), 0n);
    assert.equal(nairaToKobo("1"), 100n);
  });
  it("handles null and empty as null", () => {
    assert.equal(nairaToKobo(null), null);
    assert.equal(nairaToKobo(undefined), null);
    assert.equal(nairaToKobo(""), null);
    assert.equal(nairaToKobo("   "), null);
  });
  it("refuses negative and > 2 decimal values", () => {
    assert.throws(() => nairaToKobo("-1"));
    assert.throws(() => nairaToKobo("1.234"));
    assert.throws(() => nairaToKobo("abc"));
  });
});

// ── prefixes ────────────────────────────────────────────────────────────────
describe("normalisePrefix", () => {
  it("matches every D5 case from the evidence pack", () => {
    assert.equal(normalisePrefix("FRONT-EN"), "FRONTEN");
    assert.equal(normalisePrefix("UI/UX"), "UIUX");
    assert.equal(normalisePrefix("ok"), "OK");
    assert.equal(normalisePrefix("verylongprefixhere"), "VERYLONG");
    assert.equal(normalisePrefix(""), null);
    assert.equal(normalisePrefix(null), null);
    assert.equal(normalisePrefix("   "), null);
  });
});

describe("resolveTierPrefixes (D6 shared prefixes)", () => {
  it("gives the shared prefix to the highest-priced tier", () => {
    // dinner-tickets: Table for 5 @ 30k vs Table for 10 @ 50k, both TAB2026
    const out = resolveTierPrefixes([
      { ord: 1, rawPrefix: "REG2026", priceKobo: 1_000_000n },
      { ord: 2, rawPrefix: "TAB2026", priceKobo: 3_000_000n },  // Table for 5
      { ord: 3, rawPrefix: "TAB2026", priceKobo: 5_000_000n },  // Table for 10 (winner)
    ]);
    assert.equal(out.get(1), "REG2026");
    assert.equal(out.get(2), null);
    assert.equal(out.get(3), "TAB2026");
  });
  it("breaks price ties by highest ord", () => {
    const out = resolveTierPrefixes([
      { ord: 1, rawPrefix: "QU", priceKobo: 100n },
      { ord: 2, rawPrefix: "QU", priceKobo: 100n },
    ]);
    assert.equal(out.get(1), null);
    assert.equal(out.get(2), "QU");
  });
  it("normalises before grouping", () => {
    const out = resolveTierPrefixes([
      { ord: 1, rawPrefix: "front-en", priceKobo: 100n },
      { ord: 2, rawPrefix: "FRONTEN", priceKobo: 200n },
    ]);
    // both normalise to FRONTEN — highest price wins
    assert.equal(out.get(1), null);
    assert.equal(out.get(2), "FRONTEN");
  });
  it("carries a solo prefix through unchanged", () => {
    const out = resolveTierPrefixes([{ ord: 1, rawPrefix: "EKCE", priceKobo: 300000n }]);
    assert.equal(out.get(1), "EKCE");
  });
});

// ── tier names ──────────────────────────────────────────────────────────────
describe("resolveTierNames (F-L4 rename)", () => {
  it("appends the prefix in brackets when names duplicate", () => {
    // farstech-balance · Cyber Security has two variants
    const out = resolveTierNames([
      { ord: 4, rawName: "Cyber Security (Physical Classes)", rawPrefix: "BPCYB", rawDescription: "part payment" },
      { ord: 8, rawName: "Cyber Security (Physical Classes)", rawPrefix: "BHCYB", rawDescription: "half payment" },
    ]);
    assert.equal(out.get(4), "Cyber Security (Physical Classes) [BPCYB]");
    assert.equal(out.get(8), "Cyber Security (Physical Classes) [BHCYB]");
  });
  it("leaves a non-duplicate name alone", () => {
    const out = resolveTierNames([
      { ord: 1, rawName: "Early Bird", rawPrefix: "EKCE", rawDescription: null },
    ]);
    assert.equal(out.get(1), "Early Bird");
  });
  it("falls back to description words when prefix is empty", () => {
    const out = resolveTierNames([
      { ord: 1, rawName: "Same Name", rawPrefix: null, rawDescription: "This one is the deluxe option that includes everything" },
      { ord: 2, rawName: "Same Name", rawPrefix: null, rawDescription: "Basic tier with the minimum offering only" },
    ]);
    assert.equal(out.get(1), "Same Name [This one is the deluxe option]");
    assert.equal(out.get(2), "Same Name [Basic tier with the minimum offering]");
  });
  it("falls back to #ord when nothing else is available", () => {
    const out = resolveTierNames([
      { ord: 1, rawName: "X", rawPrefix: "", rawDescription: "" },
      { ord: 2, rawName: "X", rawPrefix: "", rawDescription: "" },
    ]);
    assert.equal(out.get(1), "X [#1]");
    assert.equal(out.get(2), "X [#2]");
  });
  it("is deterministic and idempotent across runs", () => {
    const input = [
      { ord: 1, rawName: "A", rawPrefix: "P1", rawDescription: null },
      { ord: 2, rawName: "A", rawPrefix: "P2", rawDescription: null },
    ];
    const a = resolveTierNames(input);
    const b = resolveTierNames(input);
    assert.deepEqual([...a.entries()], [...b.entries()]);
  });
});

// ── user ────────────────────────────────────────────────────────────────────
describe("transformUser (F-M1, F-L1, D10)", () => {
  const base: LegacyProfile = {
    id: "5a000000-0000-4000-8000-000000000001",
    full_name: "Ada Case",
    email: "ada@example.test",
    phone_number: "+2348010000000",
    avatar_url: "https://busfgcmbndleljklrcbd.supabase.co/x.png",
    first_name: null, last_name: null,
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: new Date("2026-01-01"), updated_at: new Date("2026-01-02"),
  };
  it("preserves the uuid and nulls avatar_url", () => {
    const out = transformUser({ profile: base, newCommunityId: "5b000000-0000-4000-8000-000000000001" });
    assert.equal(out.user.id, base.id);
    assert.equal(out.user.avatar_url, null);
    assert.equal(out.user.full_name, "Ada Case");
    assert.equal(out.term.start_reason, "migration");
    assert.equal(out.community.is_personal, true);
    assert.ok(out.community.name.includes("Ada Case"));
  });
  it("keeps a user with no phone (F-M1) — no invented number", () => {
    const p: LegacyProfile = { ...base, phone_number: null };
    const out = transformUser({ profile: p, newCommunityId: "5b000000-0000-4000-8000-000000000002" });
    assert.equal(out.user.phone_e164, null);
  });
  it("falls back to the email local-part when name is missing", () => {
    const p: LegacyProfile = { ...base, full_name: null, first_name: null, last_name: null, email: "no.name@ex.test" };
    const out = transformUser({ profile: p, newCommunityId: "5b000000-0000-4000-8000-000000000003" });
    assert.equal(out.user.full_name, "no.name");
  });
  it("prefers first + last over full_name", () => {
    const p: LegacyProfile = { ...base, first_name: "Ngozi", last_name: "Obi", full_name: "Wrong Name" };
    const out = transformUser({ profile: p, newCommunityId: "5b000000-0000-4000-8000-000000000004" });
    assert.equal(out.user.full_name, "Ngozi Obi");
  });
  it("truncates the community name to 80 chars", () => {
    const p: LegacyProfile = { ...base, full_name: "X".repeat(200) };
    const out = transformUser({ profile: p, newCommunityId: "5b000000-0000-4000-8000-000000000005" });
    assert.ok(out.community.name.length <= 80);
  });
});

// ── collection ──────────────────────────────────────────────────────────────
const mkCollection = (over: Partial<LegacyCollection>): LegacyCollection => ({
  id: "c0000000-0000-4000-8000-000000000001",
  user_id: "5a000000-0000-4000-8000-000000000001",
  title: "Test Collection",
  description: "some description",
  slug: "test-collection-c0000000",
  status: "active",
  collection_type: "fixed",
  type: "fixed",
  amount: "5000.00",
  target_amount: null, min_contribution: null,
  fee_bearer: "contributor",
  currency: "NGN",
  deadline: null, event_date: null, rejection_reason: null,
  banner_url: null, story: null, price_tiers: null,
  created_at: new Date("2026-01-01"), updated_at: new Date("2026-01-02"),
  ...over,
});

const args = (legacy: LegacyCollection, tiers: readonly LegacyTierEntry[] = []) => ({
  legacy, tiers,
  newCollectionId: "d0000000-0000-4000-8000-000000000001",
  newTierIds: tiers.map((_, i) => `d1000000-0000-4000-8000-00000000000${i + 1}`),
  communityId: "5b000000-0000-4000-8000-000000000001",
});

describe("transformCollection", () => {
  it("imports a fixed collection with amount in kobo", () => {
    const out = transformCollection(args(mkCollection({})));
    assert.equal(out.kind, "imported");
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.row.amount_model, "fixed");
    assert.equal(out.row.category, "contribution");
    assert.equal(out.row.fixed_amount_kobo, 500000n);
    assert.equal(out.row.target_amount_kobo, null);
    assert.equal(out.row.min_amount_kobo, null);
    assert.equal(out.row.fee_mode, "contributor_pays");
    assert.equal(out.row.audience_mode, "public");
    assert.equal(out.row.participation_mode, "open");
    assert.equal(out.row.cover_url, null);
    assert.equal(out.row.is_imported, true);
  });
  it("D5: a fixed collection with amount 0 is imported as free", () => {
    const out = transformCollection(args(mkCollection({ amount: "0" })));
    assert.equal(out.kind, "imported");
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.row.fixed_amount_kobo, 0n);
    assert.equal(out.row.legacy_fields._legacy_amount_note, "free fixed collection");
  });
  it("D1 (E-COL-1): deleted → archived with archived_at = updated_at", () => {
    const legacy = mkCollection({ status: "deleted", updated_at: new Date("2026-06-29T15:50:04Z") });
    const out = transformCollection(args(legacy));
    assert.equal(out.kind, "imported");
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.row.status, "archived");
    assert.deepEqual(out.row.archived_at, legacy.updated_at);
    assert.equal(
      out.row.legacy_fields._e_col_1_archival_note,
      "updated_at used as archival proxy; legacy schema records no deletion timestamp",
    );
  });
  it("D2 (Mr): the two-char title is archived on import", () => {
    const legacy = mkCollection({ id: "40e4cc9e-72c8-4088-aaf5-ce25ebc1dbd1", title: "Mr", status: "active" });
    const out = transformCollection(args(legacy));
    assert.equal(out.kind, "imported");
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.row.status, "archived");
    assert.equal(out.row.name, "Mr (archived on import)");
    assert.equal(out.row.legacy_fields.title, "Mr");
  });
  it("E-COL-2: the rejected campaign is excluded, not imported", () => {
    const out = transformCollection(args(mkCollection({
      id: "2b4fe58a-d1b2-4081-8f59-90287b96eba0", status: "rejected", collection_type: "fundraising",
    })));
    assert.equal(out.kind, "excluded");
    if (out.kind !== "excluded") throw new Error();
    assert.equal(out.reason, "rejected_campaign");
  });
  it("classifies each F-L3 kind (fundraising, open_pool, tiered, ticket, flat)", () => {
    const cases: [LegacyCollection["collection_type"], "fixed" | "open_amount" | "tiers"][] = [
      ["fixed", "fixed"],
      ["tiered", "tiers"],
      ["ticket", "tiers"],
      ["fundraising", "open_amount"],
      ["open_pool", "open_amount"],
    ];
    for (const [ct, am] of cases) {
      const out = transformCollection(args(mkCollection({ collection_type: ct, type: ct })));
      assert.equal(out.kind, "imported");
      if (out.kind !== "imported") throw new Error();
      assert.equal(out.row.amount_model, am);
    }
  });
  it("F-L4: duplicate tier names get [prefix] suffixes and unique names", () => {
    const legacy = mkCollection({
      collection_type: "tiered", type: "tiered",
      price_tiers: [
        { name: "Cyber Security", price: 30000, prefix: "HCYB", description: "Part" },
        { name: "Cyber Security", price: 50000, prefix: "FCYB", description: "Full" },
      ],
    });
    const tiers: LegacyTierEntry[] = [
      { ord: 1, id: "1", name: "Cyber Security", price: "30000", prefix: "HCYB", description: "Part", quantity: null, remaining_quantity: null, sold_quantity: 0 },
      { ord: 2, id: "2", name: "Cyber Security", price: "50000", prefix: "FCYB", description: "Full", quantity: null, remaining_quantity: null, sold_quantity: 0 },
    ];
    const out = transformCollection(args(legacy, tiers));
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.tiers[0]!.name, "Cyber Security [HCYB]");
    assert.equal(out.tiers[1]!.name, "Cyber Security [FCYB]");
    assert.equal(out.tiers[0]!.price_kobo, 3_000_000n);
    assert.equal(out.tiers[1]!.price_kobo, 5_000_000n);
  });
  it("D6: shared TAB2026 keeps the prefix on the higher-priced tier", () => {
    const legacy = mkCollection({ collection_type: "ticket", type: "ticket" });
    const tiers: LegacyTierEntry[] = [
      { ord: 1, id: "1", name: "Table for 5", price: "30000", prefix: "TAB2026", description: "5 seats", quantity: null, remaining_quantity: null, sold_quantity: 0 },
      { ord: 2, id: "2", name: "Table for 10", price: "50000", prefix: "TAB2026", description: "10 seats", quantity: null, remaining_quantity: null, sold_quantity: 0 },
    ];
    const out = transformCollection(args(legacy, tiers));
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.tiers[0]!.code_prefix, null);
    assert.equal(out.tiers[1]!.code_prefix, "TAB2026");
  });
  it("D7: quantity 0 with sold 0 becomes unlimited on that tier", () => {
    const legacy = mkCollection({ collection_type: "ticket", type: "ticket" });
    const tiers: LegacyTierEntry[] = [
      { ord: 1, id: "1", name: "Early Bird", price: "3000", prefix: "EKCE", description: null, quantity: undefined, remaining_quantity: undefined, sold_quantity: 1 },
      { ord: 2, id: "2", name: "Late Bird", price: "5000", prefix: "LKCE", description: null, quantity: 0, remaining_quantity: 0, sold_quantity: 0 },
    ];
    const out = transformCollection(args(legacy, tiers));
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.tiers[0]!.quantity_limit, null);
    assert.equal(out.tiers[1]!.quantity_limit, null);
    assert.equal(out.tiers[1]!.legacy_fields._legacy_quantity_note, "quantity=0, never sold");
  });
  it("D6 ticket collection with an empty tier list still imports as tiers with zero rows", () => {
    const out = transformCollection(args(mkCollection({
      collection_type: "ticket", type: "ticket", price_tiers: [],
    })));
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.row.amount_model, "tiers");
    assert.equal(out.tiers.length, 0);
    assert.equal(out.row.legacy_fields._a03_note, "legacy ticket collection had an empty tier list");
  });
  it("fee_bearer 'organizer' becomes 'community_absorbs'", () => {
    const out = transformCollection(args(mkCollection({ fee_bearer: "organizer" })));
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.row.fee_mode, "community_absorbs");
  });
  it("A-4: cover_url is null and banner_url is in legacy_fields", () => {
    const out = transformCollection(args(mkCollection({ banner_url: "https://busfg…" })));
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.row.cover_url, null);
    assert.equal(out.row.legacy_fields.banner_url, "https://busfg…");
  });
  it("target_amount only lands for open_amount collections", () => {
    const out = transformCollection(args(mkCollection({
      collection_type: "fundraising", type: "fundraising", amount: "0", target_amount: "1000000.00",
    })));
    if (out.kind !== "imported") throw new Error();
    assert.equal(out.row.amount_model, "open_amount");
    assert.equal(out.row.fixed_amount_kobo, null);
    assert.equal(out.row.target_amount_kobo, 100_000_000n);
  });
});

// ── contributor code ────────────────────────────────────────────────────────
describe("buildContributorCodeLink (A-1)", () => {
  it("namespaces the old_path so codes reused across collections do not collide", () => {
    const a = buildContributorCodeLink({
      source_contribution_id: "s1",
      legacy_contribution_row_id: "r1",
      legacy_collection_id: "c1",
      new_collection_id: "n1",
      contributor_unique_code: "PHS-1",
    });
    const b = buildContributorCodeLink({
      source_contribution_id: "s2",
      legacy_contribution_row_id: "r2",
      legacy_collection_id: "c2",
      new_collection_id: "n2",
      contributor_unique_code: "PHS-1",
    });
    assert.notEqual(a!.old_path, b!.old_path);
    assert.equal(a!.kind, "contributor_code");
    assert.equal(a!.old_path, "contributor:c1:PHS-1");
    assert.equal(a!.new_path, "r1");
  });
  it("returns null for empty codes", () => {
    assert.equal(buildContributorCodeLink({
      source_contribution_id: "s", legacy_contribution_row_id: "r",
      legacy_collection_id: "c", new_collection_id: "n", contributor_unique_code: "",
    }), null);
  });
});

// ── code sequences ──────────────────────────────────────────────────────────
describe("resolveCodeSequences", () => {
  it("resolves a counter to the tier whose (collection, normalised prefix) matches", () => {
    const res = resolveCodeSequences(
      [{ collection_id: "L1", prefix: "front-en", next_number: 12 }],
      [{ new_collection_id: "N1", new_tier_id: "T1", normalised_prefix: "FRONTEN" }],
      new Map([["L1", "N1"]]),
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0]!.next_number, 12n);
    assert.equal(res.rows[0]!.tier_id, "T1");
    assert.equal(res.orphaned.length, 0);
  });
  it("orphans a counter whose prefix has no destination tier", () => {
    const res = resolveCodeSequences(
      [{ collection_id: "L1", prefix: "GONE", next_number: 5 }],
      [{ new_collection_id: "N1", new_tier_id: "T1", normalised_prefix: "OTHER" }],
      new Map([["L1", "N1"]]),
    );
    assert.equal(res.rows.length, 0);
    assert.equal(res.orphaned.length, 1);
  });
  it("orphans a counter whose collection was excluded", () => {
    const res = resolveCodeSequences(
      [{ collection_id: "L1", prefix: "P", next_number: 1 }],
      [], new Map(),
    );
    assert.equal(res.orphaned.length, 1);
  });
});

// ── idempotency shape ───────────────────────────────────────────────────────
describe("transformer idempotency", () => {
  it("transformCollection is a pure function — same input, same output", () => {
    const legacy = mkCollection({ status: "deleted" });
    const a = transformCollection(args(legacy));
    const b = transformCollection(args(legacy));
    assert.deepEqual(JSON.stringify(a, (_k, v) => typeof v === "bigint" ? v.toString() : v),
                     JSON.stringify(b, (_k, v) => typeof v === "bigint" ? v.toString() : v));
  });
});
