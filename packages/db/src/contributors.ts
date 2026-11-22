/**
 * contributors.ts — typed callers for the collection financial overview,
 * contributor register and acknowledgement functions in
 * 20261116130000_collection_contributor_register.sql.
 *
 * Every call runs as the signed-in officer (`withCallerContext`), so the
 * database decides permission against the collection (collector scope
 * included). Nothing here computes money: kobo arrives as decimal strings from
 * the driver and is handed on as `bigint`.
 */

import type { TransactionSql } from "postgres";
import { type CallerContext, runWrite, withCallerContext } from "./client.ts";

function call<T>(caller: CallerContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => withCallerContext(caller, fn));
}

const toKobo = (value: string | number | bigint | null): bigint | null =>
  value === null ? null : BigInt(value);

export interface CollectionFinancialOverview {
  /** Σ applied contributions, gross, before fees. */
  totalRaisedKobo: bigint;
  /** Fees the organiser bore (zero for payments where the contributor paid the fees). */
  feesDeductedKobo: bigint;
  netRaisedKobo: bigint;
  contributionCount: number;
  contributorCount: number;
  acknowledgedCount: number;
  /** Payments parked for review: money the provider reported that is in no figure yet. */
  underReviewCount: number;
  lastContributionAt: string | null;
  /** False when the caller lacks balance.view; every balance below is then null. */
  canViewBalances: boolean;
  pendingKobo: bigint | null;
  availableKobo: bigint | null;
  onHoldKobo: bigint | null;
  withdrawingKobo: bigint | null;
  withdrawnKobo: bigint | null;
}

interface OverviewRow {
  total_raised_kobo: string;
  fees_deducted_kobo: string;
  net_raised_kobo: string;
  contribution_count: number;
  contributor_count: number;
  acknowledged_count: number;
  under_review_count: number;
  last_contribution_at: Date | null;
  can_view_balances: boolean;
  pending_kobo: string | null;
  available_kobo: string | null;
  on_hold_kobo: string | null;
  withdrawing_kobo: string | null;
  withdrawn_kobo: string | null;
}

export async function getCollectionFinancialOverview(
  caller: CallerContext,
  collectionId: string,
): Promise<CollectionFinancialOverview> {
  const [row] = await call(caller, (tx) =>
    tx<OverviewRow[]>`select * from app.collection_financial_overview(${collectionId})`,
  );
  if (!row) throw new Error("collection_financial_overview returned no row");
  return {
    totalRaisedKobo: BigInt(row.total_raised_kobo),
    feesDeductedKobo: BigInt(row.fees_deducted_kobo),
    netRaisedKobo: BigInt(row.net_raised_kobo),
    contributionCount: row.contribution_count,
    contributorCount: row.contributor_count,
    acknowledgedCount: row.acknowledged_count,
    underReviewCount: row.under_review_count,
    lastContributionAt: row.last_contribution_at ? row.last_contribution_at.toISOString() : null,
    canViewBalances: row.can_view_balances,
    pendingKobo: toKobo(row.pending_kobo),
    availableKobo: toKobo(row.available_kobo),
    onHoldKobo: toKobo(row.on_hold_kobo),
    withdrawingKobo: toKobo(row.withdrawing_kobo),
    withdrawnKobo: toKobo(row.withdrawn_kobo),
  };
}

export interface ContributionLine {
  kind: "tier" | "item";
  name: string | null;
  quantity: number;
  amountKobo: bigint;
}

export interface ContributorRow {
  contributionId: string;
  capturedAt: string;
  contributionKobo: bigint;
  totalChargedKobo: bigint;
  /** The KLK payment reference. */
  reference: string;
  name: string;
  /** Paid as a saved community member (the name is then the member's profile name). */
  isMember: boolean;
  memberCode: string | null;
  /** Only when contact details were requested (and permitted). */
  email: string | null;
  phone: string | null;
  /** The organiser's questions, by field key. */
  answers: Record<string, string>;
  attendeeNames: string[];
  lines: ContributionLine[];
  cycleKey: string | null;
  /** This person's payments to the whole collection (member, else checkout email). */
  contributorPaymentCount: number;
  contributorTotalKobo: bigint;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
}

export interface ContributorPage {
  rows: ContributorRow[];
  /** Every row matching the filters, not only this page. */
  total: number;
}

export interface ContributorQuery {
  collectionId: string;
  search?: string | undefined;
  /** true = acknowledged only, false = not acknowledged only, undefined = all. */
  acknowledged?: boolean | undefined;
  includeContact?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  contributionIds?: readonly string[] | undefined;
}

interface ContributorDbRow {
  contribution_id: string;
  captured_at: Date;
  contribution_kobo: string;
  total_charged_kobo: string;
  reference: string;
  contributor_name: string;
  is_member: boolean;
  member_code: string | null;
  email: string | null;
  phone: string | null;
  answers: Record<string, unknown> | null;
  attendee_names: string[] | null;
  lines: { kind: "tier" | "item"; name: string | null; quantity: number; amount_kobo: string }[] | null;
  cycle_key: string | null;
  contributor_payment_count: number;
  contributor_total_kobo: string;
  acknowledged_at: Date | null;
  acknowledged_by_name: string | null;
  total_count: number;
}

function stringAnswers(answers: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers ?? {})) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

export async function listCollectionContributors(
  caller: CallerContext,
  query: ContributorQuery,
): Promise<ContributorPage> {
  const rows = await call(caller, (tx) =>
    tx<ContributorDbRow[]>`
      select * from app.collection_contributors(
        ${query.collectionId},
        ${query.search?.trim() ? query.search.trim() : null},
        ${query.acknowledged ?? null},
        ${query.includeContact ?? false},
        ${query.limit ?? 50},
        ${query.offset ?? 0},
        ${query.contributionIds ? [...query.contributionIds] : null}::uuid[]
      )`,
  );
  return {
    total: rows[0]?.total_count ?? 0,
    rows: rows.map((row) => ({
      contributionId: row.contribution_id,
      capturedAt: row.captured_at.toISOString(),
      contributionKobo: BigInt(row.contribution_kobo),
      totalChargedKobo: BigInt(row.total_charged_kobo),
      reference: row.reference,
      name: row.contributor_name,
      isMember: row.is_member,
      memberCode: row.member_code,
      email: row.email,
      phone: row.phone,
      answers: stringAnswers(row.answers),
      attendeeNames: row.attendee_names ?? [],
      lines: (row.lines ?? []).map((line) => ({
        kind: line.kind,
        name: line.name,
        quantity: line.quantity,
        amountKobo: BigInt(line.amount_kobo),
      })),
      cycleKey: row.cycle_key,
      contributorPaymentCount: row.contributor_payment_count,
      contributorTotalKobo: BigInt(row.contributor_total_kobo),
      acknowledgedAt: row.acknowledged_at ? row.acknowledged_at.toISOString() : null,
      acknowledgedByName: row.acknowledged_by_name,
    })),
  };
}

/**
 * Acknowledges contributions of one collection. `contributionIds: null` means
 * every unacknowledged contribution that appeared at or before `asOf`.
 * Returns how many were newly acknowledged.
 */
export async function acknowledgeContributions(
  caller: CallerContext,
  input: { collectionId: string; contributionIds: readonly string[] | null; asOf?: string | undefined },
): Promise<number> {
  const [row] = await call(caller, (tx) =>
    tx<{ count: number }[]>`
      select app.acknowledge_contributions(
        ${input.collectionId},
        ${input.contributionIds ? [...input.contributionIds] : null}::uuid[],
        ${input.asOf ?? null}::timestamptz
      ) as count`,
  );
  return row?.count ?? 0;
}
