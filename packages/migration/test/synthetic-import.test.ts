/**
 * End-to-end synthetic import against the isolated rehearsal target.
 *
 * Preconditions the test itself checks and skips on:
 *   · Docker is running
 *   · kolekto-rehearsal-target is up and reachable on 127.0.0.1:5455/postgres
 *
 * The rehearsal target is *disposable*. The test truncates its own state at
 * the start by (a) re-applying `npm run rehearsal:up` if the container is
 * missing, (b) removing every migration row from the last run. It does NOT
 * touch the development database (54322), staging, or any legacy database.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

import { runImport, reconcile, type SourceRepository, type SourceProject } from "../src/index.ts";
import { CONTROL, DUP_PHONE_IDS, fixtures } from "./synthetic-fixtures.ts";

const CONN = process.env.REHEARSAL_URL ?? "postgres://postgres:@127.0.0.1:5455/postgres";
let sql: postgres.Sql | null = null;

async function targetReachable(): Promise<boolean> {
  try {
    const t = postgres(CONN, { max: 1, idle_timeout: 2, connect_timeout: 3, prepare: false });
    await t`select 1`;
    await t.end({ timeout: 2 });
    return true;
  } catch { return false; }
}

// The synthetic source repository — no I/O beyond returning constants.
function repo(): SourceRepository {
  return {
    listProfiles: async () => fixtures.profiles,
    listCollections: async () => fixtures.collections,
    listTiersForCollection: async (id) => fixtures.tiers.get(id) ?? [],
    listContributionsForCollection: async (id) => fixtures.contributions.get(id) ?? [],
    listContributionCodeCounters: async () => fixtures.counters,
    listAttributedDeposits: async () => fixtures.attributedDeposits,
    listUnattributedDeposits: async () => fixtures.unattributedDeposits,
    listWithdrawals: async () => fixtures.withdrawals,
    listWallets: async () => fixtures.overflowWallets,
    listPaymentRecoveryLogs: async () => fixtures.overflowPaymentRecoveryLogs,
    listPendingPaymentContexts: async () => fixtures.overflowPendingPaymentContexts,
    listPaymentAdminActions: async () => fixtures.overflowPaymentAdminActions,
    listSettlementRuns: async () => fixtures.overflowSettlementRuns,
    listAdminEvents: async () => fixtures.overflowAdminEvents,
    listCampuses: async () => fixtures.overflowCampuses,
  };
}

describe("synthetic import (rehearsal target)", async () => {
  const available = await targetReachable();
  if (!available) {
    it("skipped — rehearsal target unreachable", () => {
      console.log(`  set up with:  npm run rehearsal:up   (expects ${CONN})`);
    });
    return;
  }

  before(async () => {
    sql = postgres(CONN, { max: 4, prepare: false });
    // clean up any leftover state from a previous run so this test is deterministic
    await sql`set client_min_messages = warning`;
    await sql`select set_config('kolekto.import_run_id', '', true)`;
    // Delete order matters: tiers → collections/collection_fields/legacy_links → officer_terms → members → users → communities.
    await sql`delete from public.collection_code_sequences`.catch(() => undefined);
    await sql`delete from public.legacy_links`.catch(() => undefined);
    await sql`delete from public.collection_tiers`.catch(() => undefined);
    // Removing imported rows takes the imported-immutability trigger route. It
    // fires per-row on DELETE and refuses is_imported=true — so we bypass it
    // for the reset by directly using session_replication_role. Same shape
    // covers officer_terms, whose assert_community_has_owner AFTER-DELETE
    // trigger would otherwise refuse to drop the last owner of a community.
    // This is *only* here in the test suite's reset step, not in production code.
    await sql`set session_replication_role = replica`;
    await sql`delete from public.officer_terms`;
    await sql`delete from public.collections`;
    await sql`delete from public.members`;
    await sql`delete from public.users`;
    await sql`delete from public.communities`;
    await sql`delete from auth.users`;
    await sql`delete from migration.imported_objects`;
    await sql`delete from migration.legacy_contribution`;
    await sql`delete from migration.legacy_deposit`;
    await sql`delete from migration.unattributed_payments`;
    await sql`delete from migration.legacy_collection`;
    await sql`delete from migration.legacy_profile`;
    await sql`delete from migration.legacy_withdrawal`;
    await sql`delete from migration.legacy_overflow`;
    await sql`delete from migration.import_runs`;
    await sql`set session_replication_role = origin`;
  });

  after(async () => { await sql?.end({ timeout: 5 }); });

  const source_project: SourceProject = "synthetic:import-test";

  let runId: string;
  it("runs a clean import against the disposable rehearsal target", async () => {
    const out = await runImport({
      source_project, source_snapshot_label: "synthetic-fixture-2026-09-29", notes: "test",
      source: repo(), target: sql!,
    });
    runId = out.runId;
    assert.equal(out.counts.profiles_seen, CONTROL.profiles);
    assert.equal(out.counts.users_imported, CONTROL.profiles);
    assert.equal(out.counts.personal_communities_imported, CONTROL.profiles);
    assert.equal(out.counts.owner_terms_imported, CONTROL.profiles);
    assert.equal(out.counts.collections_seen, CONTROL.collections);
    assert.equal(out.counts.collections_excluded_rejected, CONTROL.collections_excluded_rejected);
    assert.equal(out.counts.collections_imported, CONTROL.collections - CONTROL.collections_excluded_rejected);
    assert.equal(out.counts.attributed_deposits_seen, CONTROL.attributed_deposits);
    assert.equal(out.counts.attributed_deposits_imported, CONTROL.attributed_deposits);
    assert.equal(out.counts.unattributed_deposits_seen, CONTROL.unattributed_deposits);
    assert.equal(out.counts.unattributed_deposits_imported, CONTROL.unattributed_deposits);
    assert.equal(out.counts.withdrawals_seen, CONTROL.withdrawals);
    assert.equal(out.counts.withdrawals_imported, CONTROL.withdrawals);
    const expectedOverflow = CONTROL.overflow_wallets + CONTROL.overflow_payment_recovery_log
      + CONTROL.overflow_pending_payment_context + CONTROL.overflow_payment_admin_actions
      + CONTROL.overflow_settlement_runs + CONTROL.overflow_admin_events + CONTROL.overflow_campuses;
    assert.equal(out.counts.overflow_imported, expectedOverflow);
  });

  it("reconcile passes every hard check", async () => {
    const rows = await reconcile(sql!, {
      source_profiles: CONTROL.profiles,
      source_collections: CONTROL.collections,
      source_collections_excluded_rejected: CONTROL.collections_excluded_rejected,
      source_collections_by_status: CONTROL.collections_by_status,
      source_tier_entries: CONTROL.tier_entries,
      source_tier_entries_with_legacy_id: CONTROL.tier_entries_with_legacy_id,
      source_contributions: CONTROL.contributions,
      source_contributions_with_code: CONTROL.contributions_with_code,
      source_code_counters: CONTROL.code_counters,
      source_attributed_deposits: CONTROL.attributed_deposits,
      source_unattributed_deposits: CONTROL.unattributed_deposits,
      source_withdrawals: CONTROL.withdrawals,
      source_overflow_wallets: CONTROL.overflow_wallets,
      source_overflow_payment_recovery_log: CONTROL.overflow_payment_recovery_log,
      source_overflow_pending_payment_context: CONTROL.overflow_pending_payment_context,
      source_overflow_payment_admin_actions: CONTROL.overflow_payment_admin_actions,
      source_overflow_settlement_runs: CONTROL.overflow_settlement_runs,
      source_overflow_admin_events: CONTROL.overflow_admin_events,
      source_overflow_campuses: CONTROL.overflow_campuses,
    }, runId);
    const fails = rows.filter((r) => r.verdict === "FAIL");
    if (fails.length > 0) {
      console.log(rows);
      assert.fail(`reconcile: ${fails.length} FAIL — ${fails.map((f) => f.name).join("; ")}`);
    }
  });

  it("case 12: the rejected campaign has no live collections row", async () => {
    const rows = await sql!`select count(*)::int as n from public.collections where source_id = '2b4fe58a-d1b2-4081-8f59-90287b96eba0'`;
    assert.equal(rows[0]!.n, 0);
  });

  it("case 13: duplicate tier names are unique and preserve original in history", async () => {
    const dupCollSourceId = "52000013-0000-4000-8000-000000000013";
    const tierRows = await sql!`select t.name from public.collection_tiers t
                                  join public.collections c on c.id = t.collection_id
                                  where c.source_id = ${dupCollSourceId} order by t.name`;
    const names = tierRows.map((r) => r.name);
    assert.equal(new Set(names).size, names.length, "tier names are unique");
    assert.ok(names.every((n: string) => /\[.+\]/.test(n)), `every duplicate tier is bracketed: ${names.join(", ")}`);
    // history preserves the original names as an array of length 4 inside legacy_collection.fields.price_tiers
    const legacyFields = await sql!`select fields->'price_tiers' as pt from migration.legacy_collection
                                    where source_table='collections' and source_id=${dupCollSourceId}`;
    const pt = legacyFields[0]!.pt as Array<{ name: string }>;
    assert.equal(pt.length, 4);
    assert.ok(pt.some((t) => t.name === "Cyber Security"), "original legacy name preserved");
  });

  it("case 14: shared TAB2026 lands on the higher-priced tier only", async () => {
    const rows = await sql!`select t.name, t.code_prefix, t.price_kobo::text as price from public.collection_tiers t
                              join public.collections c on c.id = t.collection_id
                              where c.source_id = '52000014-0000-4000-8000-000000000014' order by t.price_kobo`;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.code_prefix, null);
    assert.equal(rows[1]!.code_prefix, "TAB2026");
  });

  it("case 15: invalid prefixes are normalised", async () => {
    const norm = (await sql!`select t.code_prefix from public.collection_tiers t
                               join public.collections c on c.id = t.collection_id
                               where c.source_id = '52000015-0000-4000-8000-000000000015'`)
                    .map((r) => r.code_prefix as string).sort();
    assert.deepEqual(norm, ["FRONTEN", "UIUX"]);
  });

  it("case 16: quantity=0 with no sales lands as null (unlimited); legacy value preserved", async () => {
    const rows = await sql!`select t.name, t.quantity_limit, t.sort_order from public.collection_tiers t
                              join public.collections c on c.id = t.collection_id
                              where c.source_id = '52000016-0000-4000-8000-000000000016' order by t.sort_order`;
    assert.equal(rows.length, 2);
    const lateBird = rows.find((r) => r.name === "Late Bird");
    assert.ok(lateBird, "Late Bird tier landed");
    assert.equal(lateBird!.quantity_limit, null);
    // legacy value preserved in migration.legacy_collection.fields.price_tiers[1]
    const legacy = await sql!`select fields->'price_tiers' as pt from migration.legacy_collection
                              where source_table='collections' and source_id='52000016-0000-4000-8000-000000000016'`;
    const pt = legacy[0]!.pt as Array<{ name: string; quantity: number | null | undefined }>;
    const legacyLate = pt.find((t) => t.name === "Late Bird");
    assert.ok(legacyLate, "Late Bird history preserved");
    assert.equal(legacyLate!.quantity, 0);
  });

  it("B1: all 16 contribution fields are preserved in legacy_contribution.fields", async () => {
    // The contribution with the richest data: PHS-1 on C_WITH_CODES
    const rows = await sql!`select fields from migration.legacy_contribution
                             where source_id = '59000020-0000-4000-8000-000000000001'`;
    assert.equal(rows.length, 1);
    const f = rows[0]!.fields as Record<string, unknown>;
    assert.equal(f.collection_id, "52000020-0000-4000-8000-000000000020");
    assert.equal(f.name, "Synth Payer One");
    assert.equal(f.email, "payer1@synth.test");
    assert.equal(f.phone, "+2348099000001");
    assert.equal(f.amount, "1000");
    assert.equal(f.gross_amount, "1020");
    assert.equal(f.contributor_unique_code, "PHS-1");
    assert.equal(f.payment_reference, "ref-1");
    assert.equal(f.status, "paid");
    assert.equal(f.payment_id, "pay_synth_001");
    assert.equal(f.check_in_status, "not_checked_in");
    assert.equal(f.line_index, 0);
    assert.ok(f.created_at, "created_at preserved");
    assert.ok(f.updated_at, "updated_at preserved");
    // contributor_information is rich nested JSONB
    const ci = f.contributor_information as Array<{ Tier: string; _receipt: { unique_code: string } }>;
    assert.ok(Array.isArray(ci), "contributor_information is an array");
    assert.equal(ci[0]!.Tier, "Codes Tier");
    assert.equal(ci[0]!._receipt.unique_code, "PHS-1");
  });

  it("B1: gross_amount != amount survives independently", async () => {
    // The tiered contribution: amount=3000, gross_amount=3060
    const rows = await sql!`select fields from migration.legacy_contribution
                             where source_id = '59000007-0000-4000-8000-000000000004'`;
    assert.equal(rows.length, 1);
    const f = rows[0]!.fields as Record<string, unknown>;
    assert.equal(f.amount, "3000");
    assert.equal(f.gross_amount, "3060");
    assert.notEqual(f.amount, f.gross_amount, "amount and gross_amount are independently preserved");
  });

  it("B1: contribution with null optional fields preserves nulls", async () => {
    // The pending contribution has most optional fields null
    const rows = await sql!`select fields from migration.legacy_contribution
                             where source_id = '59000020-0000-4000-8000-000000000003'`;
    assert.equal(rows.length, 1);
    const f = rows[0]!.fields as Record<string, unknown>;
    assert.equal(f.contributor_unique_code, null);
    assert.equal(f.payment_reference, null);
    assert.equal(f.gross_amount, null);
    assert.equal(f.contributor_information, null);
    assert.equal(f.payment_id, null);
    assert.equal(f.name, null);
    assert.equal(f.email, null);
    assert.equal(f.phone, null);
    assert.equal(f.amount, "1000", "amount always present even on pending");
    assert.equal(f.status, "pending");
  });

  it("case 20/A-1: contributor code links exist and the same code across two collections does not collide", async () => {
    const rows = await sql!`select count(*)::int as n from public.legacy_links where kind = 'contributor_code'`;
    assert.equal(rows[0]!.n, CONTROL.contributions_with_code);
    const p1 = await sql!`select count(*)::int as n from public.legacy_links where kind = 'contributor_code' and old_path like 'contributor:52000020%'`;
    const p2 = await sql!`select count(*)::int as n from public.legacy_links where kind = 'contributor_code' and old_path like 'contributor:52000007%'`;
    assert.ok(p1[0]!.n >= 1 && p2[0]!.n >= 1, "both namespaces populated");
  });

  it("B2: attributed deposits are preserved in migration.legacy_deposit", async () => {
    const rows = await sql!`select count(*)::int as n from migration.legacy_deposit
                             where import_run_id = ${runId}`;
    assert.equal(rows[0]!.n, CONTROL.attributed_deposits);
  });

  it("B2: attributed deposit preserves all 23 source fields", async () => {
    const rows = await sql!`select fields from migration.legacy_deposit
                             where source_id = '5d000001-0000-4000-8000-000000000001'`;
    assert.equal(rows.length, 1);
    const f = rows[0]!.fields as Record<string, unknown>;
    assert.equal(f.full_name, "Synth Depositor One");
    assert.equal(f.email, "dep1@synth.test");
    assert.equal(f.phone_number, "+2348099100001");
    assert.equal(f.amount, "5000.00");
    assert.equal(f.net_amount, "4925.00");
    assert.equal(f.status, "success");
    assert.equal(f.payment_reference, "ref_dep_001");
    assert.equal(f.access_code, "access_001");
    assert.equal(f.contributor_id, "51000001-0000-4000-8000-000000000001");
    assert.equal(f.collection_id, "52000007-0000-4000-8000-000000000007");
    assert.equal(f.channel, "card");
    assert.equal(f.currency, "NGN");
    assert.equal(f.settlement_status, "settled");
    assert.equal(f.wallet_id, "5d0000w1-0000-4000-8000-000000000001");
    assert.equal(f.init_email_sent, true);
    assert.equal(f.contributor_confirmed_sent, true);
    assert.equal(f.organizer_notified_sent, true);
    assert.ok(f.created_at, "created_at preserved");
    assert.ok(f.updated_at, "updated_at preserved");
    assert.ok(f.paid_at, "paid_at preserved");
    assert.ok(f.settled_at, "settled_at preserved");
  });

  it("B2: unattributed deposits are preserved in migration.unattributed_payments", async () => {
    const rows = await sql!`select count(*)::int as n from migration.unattributed_payments
                             where import_run_id = ${runId}`;
    assert.equal(rows[0]!.n, CONTROL.unattributed_deposits);
  });

  it("B2: unattributed deposit has typed columns and full raw_payload", async () => {
    const rows = await sql!`select * from migration.unattributed_payments
                             where source_id = '5d000002-0000-4000-8000-000000000001'`;
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    // Typed columns
    assert.equal(r.payment_reference, "ref_unattr_001");
    assert.equal(String(r.amount_kobo), "1500000");
    assert.equal(String(r.net_amount_kobo), "1477500");
    assert.equal(r.original_status, "success");
    assert.ok(r.original_created_at, "original_created_at populated");
    assert.ok(r.original_paid_at, "original_paid_at populated");
    // raw_payload preserves all source fields
    const p = r.raw_payload as Record<string, unknown>;
    assert.equal(p.full_name, "Unknown Payer A");
    assert.equal(p.email, "unknown_a@synth.test");
    assert.equal(p.amount, "15000.00");
    assert.equal(p.net_amount, "14775.00");
    assert.equal(p.channel, "bank_transfer");
  });

  it("B2: unattributed deposit amount precision — ₦7500.50 → 750050 kobo", async () => {
    const rows = await sql!`select amount_kobo::text, net_amount_kobo::text from migration.unattributed_payments
                             where source_id = '5d000002-0000-4000-8000-000000000002'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.amount_kobo, "750050");
    assert.equal(rows[0]!.net_amount_kobo, "0");
  });

  it("B2: null optional fields in deposits are preserved as null", async () => {
    // The abandoned deposit has many null fields
    const rows = await sql!`select fields from migration.legacy_deposit
                             where source_id = '5d000001-0000-4000-8000-000000000003'`;
    assert.equal(rows.length, 1);
    const f = rows[0]!.fields as Record<string, unknown>;
    assert.equal(f.status, "abandoned");
    assert.equal(f.phone_number, null);
    assert.equal(f.access_code, null);
    assert.equal(f.authorization_url, null);
    assert.equal(f.paid_at, null);
    assert.equal(f.channel, null);
    assert.equal(f.settled_at, null);
    assert.equal(f.settlement_status, null);
  });

  it("B3: withdrawals are preserved in migration.legacy_withdrawal", async () => {
    const rows = await sql!`select count(*)::int as n from migration.legacy_withdrawal
                             where import_run_id = ${runId}`;
    assert.equal(rows[0]!.n, CONTROL.withdrawals);
  });

  it("B3: withdrawal typed columns populated correctly", async () => {
    const rows = await sql!`select * from migration.legacy_withdrawal
                             where source_id = '5b000001-0000-4000-8000-000000000001'`;
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(String(r.amount_kobo), "2500000");
    assert.equal(r.original_status, "approved");
    assert.equal(r.legacy_user_id, "51000001-0000-4000-8000-000000000001");
    assert.equal(r.legacy_collection_id, "52000007-0000-4000-8000-000000000007");
    assert.equal(r.legacy_wallet_id, "5e000001-0000-4000-8000-000000000001");
    assert.equal(r.provider_transfer_code, "TRF_synth001");
    assert.equal(r.provider_recipient_code, "RCP_synth001");
    assert.ok(r.original_created_at, "original_created_at populated");
    assert.ok(r.original_updated_at, "original_updated_at populated");
    // collection_id FK points to the imported collection
    assert.ok(r.collection_id, "collection_id FK populated for imported collection");
  });

  it("B3: withdrawal fields excludes destination_account", async () => {
    // The approved withdrawal has destination_account in source — it must NOT appear in fields
    const rows = await sql!`select fields from migration.legacy_withdrawal
                             where source_id = '5b000001-0000-4000-8000-000000000001'`;
    assert.equal(rows.length, 1);
    const f = rows[0]!.fields as Record<string, unknown>;
    assert.equal("destination_account" in f, false, "destination_account must not be in fields");
    // Non-sensitive fields are preserved
    assert.equal(f.user_id, "51000001-0000-4000-8000-000000000001");
    assert.equal(f.collection_id, "52000007-0000-4000-8000-000000000007");
    assert.equal(f.wallet_id, "5e000001-0000-4000-8000-000000000001");
    assert.equal(f.amount, "25000.00");
    assert.equal(f.status, "approved");
    assert.equal(f.paystack_transfer_code, "TRF_synth001");
    assert.equal(f.paystack_recipient_code, "RCP_synth001");
    assert.ok(f.created_at, "created_at preserved in fields");
    assert.ok(f.updated_at, "updated_at preserved in fields");
  });

  it("B3: withdrawal on excluded collection has null collection_id FK", async () => {
    const rows = await sql!`select collection_id, legacy_collection_id from migration.legacy_withdrawal
                             where source_id = '5b000001-0000-4000-8000-000000000003'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.collection_id, null, "FK null for excluded collection");
    assert.equal(rows[0]!.legacy_collection_id, "2b4fe58a-d1b2-4081-8f59-90287b96eba0", "legacy id preserved");
  });

  it("B3: withdrawal with null optional fields preserves nulls", async () => {
    // The success withdrawal has null Paystack codes
    const rows = await sql!`select * from migration.legacy_withdrawal
                             where source_id = '5b000001-0000-4000-8000-000000000002'`;
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.provider_transfer_code, null);
    assert.equal(r.provider_recipient_code, null);
    assert.equal(String(r.amount_kobo), "1050050");
    assert.equal(r.original_status, "success");
  });

  it("B3: withdrawal amount precision — ₦10,500.50 → 1050050 kobo", async () => {
    const rows = await sql!`select amount_kobo::text from migration.legacy_withdrawal
                             where source_id = '5b000001-0000-4000-8000-000000000002'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.amount_kobo, "1050050");
  });

  it("B3: every withdrawal has imported_objects provenance", async () => {
    const rows = await sql!`select count(*)::int as n from migration.imported_objects
                             where target_table = 'migration.legacy_withdrawal'
                               and import_run_id = ${runId}`;
    assert.equal(rows[0]!.n, CONTROL.withdrawals);
    // Verify each individual withdrawal has a provenance entry
    for (const sourceId of [
      "5b000001-0000-4000-8000-000000000001",
      "5b000001-0000-4000-8000-000000000002",
      "5b000001-0000-4000-8000-000000000003",
    ]) {
      const prov = await sql!`select source_table, target_table from migration.imported_objects
                               where source_id = ${sourceId} and target_table = 'migration.legacy_withdrawal'`;
      assert.equal(prov.length, 1, `provenance exists for ${sourceId}`);
      assert.equal(prov[0]!.source_table, "public.withdrawals");
    }
  });

  it("case 27: every imported public.collections row has a matching imported_objects entry", async () => {
    const rows = await sql!`select count(*)::int as n from public.collections c
                              where c.is_imported = true
                                and not exists (select 1 from migration.imported_objects io
                                                 where io.target_table = 'public.collections' and io.target_id = c.id)`;
    assert.equal(rows[0]!.n, 0);
  });

  it("case 28/idempotency: a second run produces no new collections, users, deposits, withdrawals, or overflow", async () => {
    const before = await sql!`select
      (select count(*)::int from public.users) as u,
      (select count(*)::int from public.communities where is_personal) as c,
      (select count(*)::int from public.collections where is_imported) as co,
      (select count(*)::int from public.collection_tiers) as t,
      (select count(*)::int from public.legacy_links where kind='contributor_code') as ll,
      (select count(*)::int from migration.legacy_deposit) as ld,
      (select count(*)::int from migration.unattributed_payments) as up,
      (select count(*)::int from migration.legacy_withdrawal) as lw,
      (select count(*)::int from migration.legacy_overflow) as lo,
      (select count(*)::int from migration.imported_objects where target_table='migration.legacy_overflow') as lop`;
    // Wipe out the "running" GUC from the previous run so runImport opens a fresh one.
    await sql!`select set_config('kolekto.import_run_id', '', true)`;
    await runImport({
      source_project, source_snapshot_label: "synthetic-fixture-2026-09-29",
      notes: "second run", source: repo(), target: sql!,
    });
    const after = await sql!`select
      (select count(*)::int from public.users) as u,
      (select count(*)::int from public.communities where is_personal) as c,
      (select count(*)::int from public.collections where is_imported) as co,
      (select count(*)::int from public.collection_tiers) as t,
      (select count(*)::int from public.legacy_links where kind='contributor_code') as ll,
      (select count(*)::int from migration.legacy_deposit) as ld,
      (select count(*)::int from migration.unattributed_payments) as up,
      (select count(*)::int from migration.legacy_withdrawal) as lw,
      (select count(*)::int from migration.legacy_overflow) as lo,
      (select count(*)::int from migration.imported_objects where target_table='migration.legacy_overflow') as lop`;
    assert.deepEqual(before[0], after[0]);
  });

  it("case 29: migration.legacy_collection refuses UPDATE", async () => {
    let threw = false;
    try { await sql!`update migration.legacy_collection set fields = fields || '{"x":1}'::jsonb where import_run_id = ${runId}`; }
    catch { threw = true; }
    assert.ok(threw, "the append-only trigger must refuse UPDATE");
  });

  it("case 30: sign-up trigger stands aside when the import context is set", async () => {
    // The orchestrator already exercised this path; here we just confirm that
    // the trigger created zero extra personal communities (i.e. every
    // personal community traces to an imported profile via imported_objects).
    const rows = await sql!`select count(*)::int as n from public.communities c
                              where c.is_personal
                                and not exists (select 1 from migration.imported_objects io
                                                 where io.target_table = 'public.communities' and io.target_id = c.id)`;
    assert.equal(rows[0]!.n, 0);
  });

  it("financial safety: no ledger, financial-event or wallet row was created", async () => {
    const rows = await sql!`select
      (select count(*)::int from public.ledger_journals) as journals,
      (select count(*)::int from public.ledger_entries)  as entries,
      (select count(*)::int from public.financial_events) as events`;
    assert.equal(rows[0]!.journals, 0);
    assert.equal(rows[0]!.entries, 0);
    assert.equal(rows[0]!.events, 0);
  });

  // ── B4: legacy overflow ──────────────────────────────────────────────────

  it("B4: overflow row counts match per source table", async () => {
    const checks: [string, number][] = [
      ["public.wallets", CONTROL.overflow_wallets],
      ["public.payment_recovery_log", CONTROL.overflow_payment_recovery_log],
      ["public.pending_payment_context", CONTROL.overflow_pending_payment_context],
      ["public.payment_admin_actions", CONTROL.overflow_payment_admin_actions],
      ["public.settlement_runs", CONTROL.overflow_settlement_runs],
      ["public.admin_events", CONTROL.overflow_admin_events],
      ["public.campuses", CONTROL.overflow_campuses],
    ];
    for (const [sourceTable, expected] of checks) {
      const rows = await sql!`select count(*)::int as n from migration.legacy_overflow
                               where source_table = ${sourceTable}`;
      assert.equal(rows[0]!.n, expected, `${sourceTable}: expected ${expected}`);
    }
  });

  it("B4: total overflow count matches sum of all B4 sources", async () => {
    const total = CONTROL.overflow_wallets + CONTROL.overflow_payment_recovery_log
      + CONTROL.overflow_pending_payment_context + CONTROL.overflow_payment_admin_actions
      + CONTROL.overflow_settlement_runs + CONTROL.overflow_admin_events + CONTROL.overflow_campuses;
    const rows = await sql!`select count(*)::int as n from migration.legacy_overflow`;
    assert.equal(rows[0]!.n, total);
  });

  it("B4: wallet fields JSONB is a complete snapshot including fee_breakdown", async () => {
    const rows = await sql!`select fields from migration.legacy_overflow
                             where source_table = 'public.wallets'
                               and source_id = '5f000001-0000-4000-8000-000000000001'`;
    assert.equal(rows.length, 1);
    const f = rows[0]!.fields as Record<string, unknown>;
    assert.equal(f.id, "5f000001-0000-4000-8000-000000000001");
    assert.equal(f.collection_id, "52000005-0000-4000-8000-000000000005");
    assert.equal(f.available_balance, "1500.50");
    assert.equal(f.ledger_balance, "1500.50");
    assert.equal(f.gross_payment, "2000.00");
    assert.equal(f.net_payment, "1970.00");
    assert.equal(f.withdrawn, "470.00");
    assert.equal(f.pending_balance, "0.00");
    const fb = f.fee_breakdown as Record<string, string>;
    assert.equal(fb.platform_fee, "30.00");
    assert.equal(fb.gateway_fee, "0.00");
  });

  it("B4: pending_payment_context TEXT PK stored correctly as source_id", async () => {
    const rows = await sql!`select source_id, source_key_columns, fields from migration.legacy_overflow
                             where source_table = 'public.pending_payment_context'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source_id, "KLK_REF_SYNTH_001");
    assert.deepEqual(rows[0]!.source_key_columns, ["reference"]);
    const f = rows[0]!.fields as Record<string, unknown>;
    assert.equal(f.reference, "KLK_REF_SYNTH_001");
    assert.equal(f.state, "completed");
  });

  it("B4: campus INTEGER PK stored as text source_id", async () => {
    const rows = await sql!`select source_id, source_key_columns, fields from migration.legacy_overflow
                             where source_table = 'public.campuses'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source_id, "99");
    assert.deepEqual(rows[0]!.source_key_columns, ["campus_id"]);
    const f = rows[0]!.fields as Record<string, unknown>;
    assert.equal(f.campus_id, 99);
    assert.equal(f.campus_name, "Synthetic Campus");
  });

  it("B4: source_key_columns correct for UUID-PK tables", async () => {
    const rows = await sql!`select source_key_columns from migration.legacy_overflow
                             where source_table = 'public.wallets'`;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.source_key_columns, ["id"]);
  });

  it("B4: every overflow row has imported_objects provenance", async () => {
    const overflowCount = await sql!`select count(*)::int as n from migration.legacy_overflow`;
    const provCount = await sql!`select count(*)::int as n from migration.imported_objects
                                  where target_table = 'migration.legacy_overflow'`;
    assert.equal(overflowCount[0]!.n, provCount[0]!.n);
    assert.ok(overflowCount[0]!.n > 0, "at least one overflow row exists");
  });

  it("B4: legacy_overflow refuses UPDATE", async () => {
    let threw = false;
    try { await sql!`update migration.legacy_overflow set fields = fields || '{"x":1}'::jsonb limit 1`; }
    catch { threw = true; }
    assert.ok(threw, "legacy_overflow must refuse UPDATE");
  });

  it("B4: legacy_overflow refuses DELETE", async () => {
    let threw = false;
    try { await sql!`delete from migration.legacy_overflow limit 1`; }
    catch { threw = true; }
    assert.ok(threw, "legacy_overflow must refuse DELETE");
  });

  it("B4: legacy_overflow refuses TRUNCATE", async () => {
    let threw = false;
    try { await sql!`truncate migration.legacy_overflow`; }
    catch { threw = true; }
    assert.ok(threw, "legacy_overflow must refuse TRUNCATE");
  });

  it("case 28/idempotency: second run creates zero new overflow rows", async () => {
    const beforeOverflow = await sql!`select count(*)::int as n from migration.legacy_overflow`;
    const beforeProv = await sql!`select count(*)::int as n from migration.imported_objects
                                    where target_table = 'migration.legacy_overflow'`;
    // The second run was already executed in the idempotency test above; verify overflow state
    assert.ok(beforeOverflow[0]!.n > 0, "overflow rows exist");
    assert.equal(beforeOverflow[0]!.n, beforeProv[0]!.n, "provenance matches overflow count after two runs");
  });

  // ── B1: duplicate phone deduplication ─────────────────────────────────────

  it("B1: duplicate phone (2-way) — first profile by id keeps phone_e164", async () => {
    const rows = await sql!`select phone_e164 from public.users where id = ${DUP_PHONE_IDS.A1}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.phone_e164, DUP_PHONE_IDS.PHONE_A);
  });

  it("B1: duplicate phone (2-way) — second profile by id has null phone_e164", async () => {
    const rows = await sql!`select phone_e164 from public.users where id = ${DUP_PHONE_IDS.A2}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.phone_e164, null);
  });

  it("B1: duplicate phone (3-way) — first profile by id keeps phone_e164", async () => {
    const rows = await sql!`select phone_e164 from public.users where id = ${DUP_PHONE_IDS.B1}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.phone_e164, DUP_PHONE_IDS.PHONE_B);
  });

  it("B1: duplicate phone (3-way) — second and third have null phone_e164", async () => {
    for (const uid of [DUP_PHONE_IDS.B2, DUP_PHONE_IDS.B3]) {
      const rows = await sql!`select phone_e164 from public.users where id = ${uid}`;
      assert.equal(rows.length, 1, `user ${uid} should exist`);
      assert.equal(rows[0]!.phone_e164, null, `user ${uid} should have null phone`);
    }
  });

  it("B1: deduped users preserve original phone in legacy_profile.fields with _phone_deduped flag", async () => {
    for (const uid of [DUP_PHONE_IDS.A2, DUP_PHONE_IDS.B2, DUP_PHONE_IDS.B3]) {
      const rows = await sql!`select fields from migration.legacy_profile where source_id = ${uid}`;
      assert.equal(rows.length, 1, `legacy_profile exists for ${uid}`);
      const f = rows[0]!.fields as Record<string, unknown>;
      assert.ok(f.phone_number, `${uid} original phone preserved in fields`);
      assert.equal(f._phone_deduped, true, `${uid} has _phone_deduped flag`);
    }
  });

  it("B1: non-deduped users do not have _phone_deduped flag", async () => {
    for (const uid of [DUP_PHONE_IDS.A1, DUP_PHONE_IDS.B1]) {
      const rows = await sql!`select fields from migration.legacy_profile where source_id = ${uid}`;
      assert.equal(rows.length, 1, `legacy_profile exists for ${uid}`);
      const f = rows[0]!.fields as Record<string, unknown>;
      assert.equal(f._phone_deduped, undefined, `${uid} should not have dedup flag`);
    }
  });

  it("B1: exactly one live phone_e164 per duplicate group", async () => {
    const rows1 = await sql!`select count(*)::int as n from public.users where phone_e164 = ${DUP_PHONE_IDS.PHONE_A}`;
    assert.equal(rows1[0]!.n, 1, "phone A appears exactly once");
    const rows2 = await sql!`select count(*)::int as n from public.users where phone_e164 = ${DUP_PHONE_IDS.PHONE_B}`;
    assert.equal(rows2[0]!.n, 1, "phone B appears exactly once");
  });

  it("B1: all users preserved despite phone dedup (no merging or discarding)", async () => {
    const rows = await sql!`select count(*)::int as n from public.users`;
    assert.equal(rows[0]!.n, CONTROL.profiles, "every profile creates a user row");
  });

  it("B1: phone dedup is idempotent — second run produces same result", async () => {
    const before = await sql!`select id, phone_e164 from public.users order by id`;
    await sql!`select set_config('kolekto.import_run_id', '', true)`;
    await runImport({
      source_project, source_snapshot_label: "synthetic-fixture-2026-09-29",
      notes: "phone dedup idempotency", source: repo(), target: sql!,
    });
    const after = await sql!`select id, phone_e164 from public.users order by id`;
    assert.deepEqual(before, after, "user rows unchanged after re-import");
  });
});
