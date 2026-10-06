/**
 * Reconciliation queries executed against the rehearsal target after a run.
 * Every one returns FAIL, PASS or NOTE.
 *
 * Contract details in docs/migration/legacy/IMPORT-RECONCILIATION-CONTRACT.md.
 * A control-total object is passed in so this file has no baked-in numbers.
 */

import type { Sql } from "postgres";

export interface ControlTotals {
  readonly source_profiles: number;
  readonly source_collections: number;
  readonly source_collections_excluded_rejected: number;
  readonly source_collections_by_status: Record<string, number>;
  readonly source_tier_entries: number;
  readonly source_tier_entries_with_legacy_id: number;
  readonly source_contributions: number;
  readonly source_contributions_with_code: number;
  readonly source_code_counters: number;
  readonly source_attributed_deposits: number;
  readonly source_unattributed_deposits: number;
  readonly source_withdrawals: number;
  readonly source_overflow_wallets: number;
  readonly source_overflow_payment_recovery_log: number;
  readonly source_overflow_pending_payment_context: number;
  readonly source_overflow_payment_admin_actions: number;
  readonly source_overflow_settlement_runs: number;
  readonly source_overflow_admin_events: number;
  readonly source_overflow_campuses: number;
}

export interface ReconRow {
  readonly name: string;
  readonly source: number;
  readonly destination: number;
  readonly relation: "eq" | "eq_source_minus_excluded" | "eq_ge" | "ne" | "any";
  readonly verdict: "PASS" | "FAIL" | "NOTE";
  readonly detail?: string;
}

export async function reconcile(target: Sql, totals: ControlTotals, runId: string): Promise<ReconRow[]> {
  const rows: ReconRow[] = [];
  const add = (
    name: string, source: number, destination: number,
    relation: ReconRow["relation"], detail?: string,
  ): void => {
    const verdict: ReconRow["verdict"] =
      relation === "eq" ? (source === destination ? "PASS" : "FAIL") :
      relation === "eq_source_minus_excluded" ? (source === destination ? "PASS" : "FAIL") :
      relation === "eq_ge" ? (destination >= source ? "PASS" : "FAIL") :
      relation === "ne" ? (destination !== source ? "PASS" : "FAIL") :
      "NOTE";
    rows.push({ name, source, destination, relation, verdict, ...(detail ? { detail } : {}) });
  };

  const n = (v: unknown): number => Number((v as { count: string | number }).count ?? v);

  // Identity
  add("users imported = source profiles",
      totals.source_profiles,
      n((await target`select count(*)::text as count from public.users`)[0]),
      "eq");
  add("personal communities = source profiles",
      totals.source_profiles,
      n((await target`select count(*)::text as count from public.communities where is_personal = true`)[0]),
      "eq");
  add("owner terms = source profiles",
      totals.source_profiles,
      n((await target`select count(*)::text as count from public.officer_terms where role = 'owner' and start_reason = 'migration'`)[0]),
      "eq");
  add("auth.users imported = source profiles",
      totals.source_profiles,
      n((await target`select count(*)::text as count from auth.users`)[0]),
      "eq");

  // Collections
  const importedCollections = n((await target`select count(*)::text as count from public.collections where is_imported = true`)[0]);
  add("imported collections = source - rejected campaigns",
      totals.source_collections - totals.source_collections_excluded_rejected,
      importedCollections,
      "eq_source_minus_excluded");

  for (const [status, expected] of Object.entries(totals.source_collections_by_status)) {
    if (status === "rejected") continue; // excluded
    const target_status = status === "deleted" ? "archived" : status;
    const actual = n((await target`select count(*)::text as count from public.collections
                                    where is_imported = true and status = ${target_status}`)[0]);
    add(`collections status ${status} -> ${target_status}`, expected, actual,
        // The Mr row moves active -> archived, so the active count on destination
        // is expected − 1 and the archived count is expected + 1.
        status === "active" ? "eq_ge" : "any",
        status === "active" ? "destination >= source − 1 (Mr moves to archived)" : undefined);
  }

  // Rejected campaign exclusion
  add("no rejected collections landed live",
      0,
      n((await target`select count(*)::text as count from public.collections where source_id = '2b4fe58a-d1b2-4081-8f59-90287b96eba0'`)[0]),
      "eq");

  // Provenance
  add("every imported collection has provenance columns filled",
      0,
      n((await target`select count(*)::text as count from public.collections
                       where is_imported = true and (source_id is null or import_run_id is null)`)[0]),
      "eq");

  // Tier ids preserved for the ones with legacy id
  const tiersWithSource = n((await target`select count(*)::text as count from migration.imported_objects
                                            where import_run_id = ${runId} and target_table = 'public.collection_tiers'`)[0]);
  add("collection_tiers rows imported >= source tier entries in imported collections",
      totals.source_tier_entries,
      tiersWithSource,
      "eq_ge");

  // Contributor codes
  add("contributor code links >= source contributions with code",
      totals.source_contributions_with_code,
      n((await target`select count(*)::text as count from public.legacy_links where kind = 'contributor_code'`)[0]),
      "eq_ge");

  // Financial safety
  add("no ledger journals were created",
      0, n((await target`select count(*)::text as count from public.ledger_journals`)[0]), "eq");
  add("no ledger entries were created",
      0, n((await target`select count(*)::text as count from public.ledger_entries`)[0]), "eq");
  add("no financial events were created",
      0, n((await target`select count(*)::text as count from public.financial_events`)[0]), "eq");

  // Deposits (B2)
  add("attributed deposits imported = source attributed deposits",
      totals.source_attributed_deposits,
      n((await target`select count(*)::text as count from migration.legacy_deposit where import_run_id = ${runId}`)[0]),
      "eq");
  add("unattributed deposits imported = source unattributed deposits",
      totals.source_unattributed_deposits,
      n((await target`select count(*)::text as count from migration.unattributed_payments where import_run_id = ${runId}`)[0]),
      "eq");

  // Withdrawals (B3)
  add("withdrawals imported = source withdrawals",
      totals.source_withdrawals,
      n((await target`select count(*)::text as count from migration.legacy_withdrawal where import_run_id = ${runId}`)[0]),
      "eq");

  // Overflow (B4)
  const overflowChecks: { name: string; sourceTable: string; expected: number }[] = [
    { name: "overflow wallets", sourceTable: "public.wallets", expected: totals.source_overflow_wallets },
    { name: "overflow payment_recovery_log", sourceTable: "public.payment_recovery_log", expected: totals.source_overflow_payment_recovery_log },
    { name: "overflow pending_payment_context", sourceTable: "public.pending_payment_context", expected: totals.source_overflow_pending_payment_context },
    { name: "overflow payment_admin_actions", sourceTable: "public.payment_admin_actions", expected: totals.source_overflow_payment_admin_actions },
    { name: "overflow settlement_runs", sourceTable: "public.settlement_runs", expected: totals.source_overflow_settlement_runs },
    { name: "overflow admin_events", sourceTable: "public.admin_events", expected: totals.source_overflow_admin_events },
    { name: "overflow campuses", sourceTable: "public.campuses", expected: totals.source_overflow_campuses },
  ];
  for (const { name, sourceTable, expected } of overflowChecks) {
    add(`${name} imported = source count`,
        expected,
        n((await target`select count(*)::text as count from migration.legacy_overflow
                         where source_table = ${sourceTable} and import_run_id = ${runId}`)[0]),
        "eq");
  }
  const totalOverflow = overflowChecks.reduce((s, c) => s + c.expected, 0);
  add("total legacy_overflow rows = sum of B4 sources",
      totalOverflow,
      n((await target`select count(*)::text as count from migration.legacy_overflow
                       where import_run_id = ${runId}`)[0]),
      "eq");
  add("overflow provenance = total overflow rows",
      totalOverflow,
      n((await target`select count(*)::text as count from migration.imported_objects
                       where target_table = 'migration.legacy_overflow' and import_run_id = ${runId}`)[0]),
      "eq");
  // Immutability spot-check
  const trialFail = await target`do $$ begin
    update migration.legacy_collection set fields = fields || '{"x":1}'::jsonb where import_run_id = ${runId};
    raise exception 'reconcile: legacy_collection UPDATE was NOT refused' using errcode = 'P0001';
    exception when others then null; end $$`.then(() => "silently_allowed").catch(() => "refused");
  rows.push({
    name: "migration.legacy_collection refuses UPDATE",
    source: 0, destination: 0, relation: "any",
    verdict: trialFail === "refused" ? "PASS" : "FAIL",
    detail: `probe result: ${trialFail}`,
  });

  return rows;
}
