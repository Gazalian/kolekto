/**
 * community-overview.ts — typed callers for the community home, the community
 * overview report, its recent activity, verification readiness and the
 * caller's identity summary (20261122120000).
 *
 * Every call runs as the signed-in user (`withCallerContext`); the database
 * decides permission (community.view_dashboard, then transaction.view and
 * balance.view per collection). Nothing here computes money: kobo arrives as
 * decimal strings and is handed on as strings (display only). A figure the
 * caller may not see is `null`, never `"0"`.
 *
 * The community figures are a REPORT: the sum of separate collection
 * balances. No withdrawal or any other money movement is authorised against
 * them (v_collection_position, D-02).
 */

import type { TransactionSql } from "postgres";
import { type CallerContext, runWrite, withCallerContext } from "./client.ts";

function call<T>(caller: CallerContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => withCallerContext(caller, fn));
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);
const kobo = (value: string | number | bigint | null): string | null => (value === null ? null : String(value));

// ── Community home ───────────────────────────────────────────────────────────

export interface MyCommunity {
  communityId: string;
  slug: string;
  name: string;
  type: string;
  isPersonal: boolean;
  logoUrl: string | null;
  status: string;
  verificationStatus: string;
  role: string;
  title: string | null;
  roleSince: string;
  collectionCount: number | null;
  liveCollectionCount: number | null;
}

interface MyCommunityRow {
  community_id: string;
  slug: string;
  name: string;
  type: string;
  is_personal: boolean;
  logo_url: string | null;
  status: string;
  verification_status: string;
  role: string;
  title: string | null;
  role_since: Date;
  collection_count: number | null;
  live_collection_count: number | null;
}

export async function listMyCommunities(caller: CallerContext): Promise<MyCommunity[]> {
  const rows = await call(caller, (tx) => tx<MyCommunityRow[]>`select * from app.my_communities()`);
  return rows.map((r) => ({
    communityId: r.community_id,
    slug: r.slug,
    name: r.name,
    type: r.type,
    isPersonal: r.is_personal,
    logoUrl: r.logo_url,
    status: r.status,
    verificationStatus: r.verification_status,
    role: r.role,
    title: r.title,
    roleSince: r.role_since.toISOString(),
    collectionCount: r.collection_count,
    liveCollectionCount: r.live_collection_count,
  }));
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface CommunityOverview {
  membersCount: number;
  membersConfirmedCount: number;
  membersWaitingCount: number;
  officerCount: number;
  collectionCount: number;
  liveCollectionCount: number;
  draftCollectionCount: number;
  upcomingOrPausedCount: number;
  closedCollectionCount: number;
  canViewTransactions: boolean;
  collectedKobo: string | null;
  contributionCount: number | null;
  collected30dKobo: string | null;
  contribution30dCount: number | null;
  lastContributionAt: string | null;
  canViewBalances: boolean;
  balanceKobo: string | null;
  pendingKobo: string | null;
  availableKobo: string | null;
  onHoldKobo: string | null;
  withdrawingKobo: string | null;
  withdrawnKobo: string | null;
  openWithdrawalCount: number | null;
  paidWithdrawalCount: number | null;
}

interface OverviewRow {
  members_count: number;
  members_confirmed_count: number;
  members_waiting_count: number;
  officer_count: number;
  collection_count: number;
  live_collection_count: number;
  draft_collection_count: number;
  upcoming_or_paused_count: number;
  closed_collection_count: number;
  can_view_transactions: boolean;
  collected_kobo: string | null;
  contribution_count: number | null;
  collected_30d_kobo: string | null;
  contribution_30d_count: number | null;
  last_contribution_at: Date | null;
  can_view_balances: boolean;
  balance_kobo: string | null;
  pending_kobo: string | null;
  available_kobo: string | null;
  on_hold_kobo: string | null;
  withdrawing_kobo: string | null;
  withdrawn_kobo: string | null;
  open_withdrawal_count: number | null;
  paid_withdrawal_count: number | null;
}

export async function getCommunityOverview(caller: CallerContext, communityId: string): Promise<CommunityOverview> {
  const [r] = await call(caller, (tx) => tx<OverviewRow[]>`select * from app.community_overview(${communityId})`);
  if (!r) throw new Error("community_overview returned no row");
  return {
    membersCount: r.members_count,
    membersConfirmedCount: r.members_confirmed_count,
    membersWaitingCount: r.members_waiting_count,
    officerCount: r.officer_count,
    collectionCount: r.collection_count,
    liveCollectionCount: r.live_collection_count,
    draftCollectionCount: r.draft_collection_count,
    upcomingOrPausedCount: r.upcoming_or_paused_count,
    closedCollectionCount: r.closed_collection_count,
    canViewTransactions: r.can_view_transactions,
    collectedKobo: kobo(r.collected_kobo),
    contributionCount: r.contribution_count,
    collected30dKobo: kobo(r.collected_30d_kobo),
    contribution30dCount: r.contribution_30d_count,
    lastContributionAt: iso(r.last_contribution_at),
    canViewBalances: r.can_view_balances,
    balanceKobo: kobo(r.balance_kobo),
    pendingKobo: kobo(r.pending_kobo),
    availableKobo: kobo(r.available_kobo),
    onHoldKobo: kobo(r.on_hold_kobo),
    withdrawingKobo: kobo(r.withdrawing_kobo),
    withdrawnKobo: kobo(r.withdrawn_kobo),
    openWithdrawalCount: r.open_withdrawal_count,
    paidWithdrawalCount: r.paid_withdrawal_count,
  };
}

// ── Per-collection figures ───────────────────────────────────────────────────

export interface CommunityCollectionFigures {
  collectionId: string;
  slug: string;
  name: string;
  status: string;
  targetAmountKobo: string | null;
  publishedAt: string | null;
  collectedKobo: string | null;
  contributionCount: number | null;
  lastContributionAt: string | null;
  availableKobo: string | null;
  openWithdrawalCount: number | null;
}

interface FiguresRow {
  collection_id: string;
  slug: string;
  name: string;
  status: string;
  target_amount_kobo: string | null;
  published_at: Date | null;
  collected_kobo: string | null;
  contribution_count: number | null;
  last_contribution_at: Date | null;
  available_kobo: string | null;
  open_withdrawal_count: number | null;
}

export async function listCommunityCollectionFigures(
  caller: CallerContext,
  communityId: string,
): Promise<CommunityCollectionFigures[]> {
  const rows = await call(caller, (tx) =>
    tx<FiguresRow[]>`
      select collection_id, slug, name, status, target_amount_kobo, published_at, collected_kobo,
             contribution_count, last_contribution_at, available_kobo, open_withdrawal_count
      from app.community_collection_figures(${communityId})`,
  );
  return rows.map((r) => ({
    collectionId: r.collection_id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    targetAmountKobo: kobo(r.target_amount_kobo),
    publishedAt: iso(r.published_at),
    collectedKobo: kobo(r.collected_kobo),
    contributionCount: r.contribution_count,
    lastContributionAt: iso(r.last_contribution_at),
    availableKobo: kobo(r.available_kobo),
    openWithdrawalCount: r.open_withdrawal_count,
  }));
}

// ── Recent activity ──────────────────────────────────────────────────────────

export type CommunityActivityKind =
  | "contribution"
  | "collection_published"
  | "withdrawal_requested"
  | "withdrawal_paid"
  | "officer_appointed"
  | "member_joined";

export interface CommunityActivityItem {
  kind: CommunityActivityKind;
  occurredAt: string;
  collectionSlug: string | null;
  collectionName: string | null;
  actorName: string | null;
  amountKobo: string | null;
  detail: string | null;
}

interface ActivityRow {
  kind: CommunityActivityKind;
  occurred_at: Date;
  collection_slug: string | null;
  collection_name: string | null;
  actor_name: string | null;
  amount_kobo: string | null;
  detail: string | null;
}

export async function listCommunityRecentActivity(
  caller: CallerContext,
  communityId: string,
  limit = 5,
): Promise<CommunityActivityItem[]> {
  const rows = await call(caller, (tx) =>
    tx<ActivityRow[]>`select * from app.community_recent_activity(${communityId}, ${limit})`,
  );
  return rows.map((r) => ({
    kind: r.kind,
    occurredAt: r.occurred_at.toISOString(),
    collectionSlug: r.collection_slug,
    collectionName: r.collection_name,
    actorName: r.actor_name,
    amountKobo: kobo(r.amount_kobo),
    detail: r.detail,
  }));
}

// ── Verification readiness ───────────────────────────────────────────────────

export interface CommunityVerificationReadiness {
  verificationStatus: string;
  verifiedAt: string | null;
  canSubmit: boolean;
  hasDescription: boolean;
  hasLocation: boolean;
  contactVerified: boolean;
  /** Only for a caller who could submit; otherwise null. */
  ownerEmailConfirmed: boolean | null;
  ownerHasVerifiedPayout: boolean | null;
  unverifiedDailyLimitKobo: string;
  /** Only with balance.view and while unverified. */
  requestedTodayKobo: string | null;
}

interface ReadinessRow {
  verification_status: string;
  verified_at: Date | null;
  can_submit: boolean;
  has_description: boolean;
  has_location: boolean;
  contact_verified: boolean;
  owner_email_confirmed: boolean | null;
  owner_has_verified_payout: boolean | null;
  unverified_daily_limit_kobo: string;
  requested_today_kobo: string | null;
}

export async function getCommunityVerificationReadiness(
  caller: CallerContext,
  communityId: string,
): Promise<CommunityVerificationReadiness> {
  const [r] = await call(caller, (tx) =>
    tx<ReadinessRow[]>`select * from app.community_verification_readiness(${communityId})`,
  );
  if (!r) throw new Error("community_verification_readiness returned no row");
  return {
    verificationStatus: r.verification_status,
    verifiedAt: iso(r.verified_at),
    canSubmit: r.can_submit,
    hasDescription: r.has_description,
    hasLocation: r.has_location,
    contactVerified: r.contact_verified,
    ownerEmailConfirmed: r.owner_email_confirmed,
    ownerHasVerifiedPayout: r.owner_has_verified_payout,
    unverifiedDailyLimitKobo: String(r.unverified_daily_limit_kobo),
    requestedTodayKobo: kobo(r.requested_today_kobo),
  };
}

// ── The caller's identity summary ────────────────────────────────────────────

export interface MyIdentitySummary {
  identityLevel: "none" | "contact_verified" | "identity_verified";
  emailConfirmed: boolean;
  accountCreated: string;
}

interface IdentityRow {
  identity_level: MyIdentitySummary["identityLevel"];
  email_confirmed: boolean;
  account_created: Date;
}

export async function getMyIdentitySummary(caller: CallerContext): Promise<MyIdentitySummary | null> {
  const [r] = await call(caller, (tx) => tx<IdentityRow[]>`select * from app.my_identity_summary()`);
  if (!r) return null;
  return { identityLevel: r.identity_level, emailConfirmed: r.email_confirmed, accountCreated: r.account_created.toISOString() };
}
