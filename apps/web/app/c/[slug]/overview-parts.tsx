import type { CommunityActivityItem, CommunityCollectionFigures, CommunityOverview } from "@kolekto/db";
import { Badge } from "@kolekto/ui";
import {
  ArrowDownToLine,
  ArrowRight,
  BadgeCheck,
  Banknote,
  CircleDollarSign,
  Clock,
  Hourglass,
  Megaphone,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  UserPlus,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { STATUS_LABEL, STATUS_TONE, type CollectionStatus } from "../../../lib/collection-display.ts";
import { formatShortDate, naira, roleLabel, targetProgress } from "../../../lib/community-display.ts";
import { formatDistanceToNow } from "../../../lib/format.ts";

const panel = "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]";

// ── Verification ────────────────────────────────────────────────────────────

/**
 * The community's verification, read from `communities.verification_status`
 * (never a frontend flag). Community verification is separate from any
 * officer's personal verification.
 */
export function VerificationCard({
  slug,
  status,
  verifiedAt,
  canSubmit,
}: {
  slug: string;
  status: string;
  verifiedAt: string | null;
  canSubmit: boolean;
}) {
  if (status === "verified") {
    return (
      <div className={`${panel} flex items-center gap-3 px-4 py-3`}>
        <ShieldCheck className="h-5 w-5 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
        <p className="text-sm text-[var(--color-text)]">
          <span className="font-medium">Verified community</span>
          {verifiedAt && <span className="text-[var(--color-text-muted)]"> · since {formatShortDate(verifiedAt)}</span>}
        </p>
      </div>
    );
  }

  const copy: Record<string, { title: string; body: string; tone: "neutral" | "info" | "danger" | "warning"; badge: string }> = {
    pending: {
      title: "Verification in review",
      body: "Kolekto is reviewing this community's submission. You will be notified when it is decided.",
      tone: "info",
      badge: "In review",
    },
    rejected: {
      title: "Verification not approved",
      body: "The last submission was not approved. See what is needed before you try again.",
      tone: "danger",
      badge: "Not approved",
    },
    expired: {
      title: "Verification lapsed",
      body: "The officers who verified this community have left. A current owner needs to verify it again.",
      tone: "warning",
      badge: "Lapsed",
    },
  };
  const c = copy[status] ?? {
    title: "This community is not verified",
    body: "Unverified communities can withdraw up to ₦1,000,000 a day across all their collections. Verification lifts that limit and shows contributors a verified badge.",
    tone: "neutral" as const,
    badge: "Not verified",
  };

  return (
    <div
      className={`${panel} flex flex-col gap-3 border-l-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between ${
        c.tone === "danger" ? "border-l-[var(--color-danger)]" : c.tone === "info" ? "border-l-[var(--color-info)]" : "border-l-[var(--color-accent)]"
      }`}
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
        <div>
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-text)]">
            {c.title} <Badge tone={c.tone}>{c.badge}</Badge>
          </p>
          <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">{c.body}</p>
        </div>
      </div>
      <Link
        href={`/c/${slug}/verification`}
        className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-md)] px-3 text-sm font-medium ${
          canSubmit && status !== "pending"
            ? "bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-strong)]"
            : "border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-bg)]"
        }`}
      >
        {canSubmit && status !== "pending" ? "Verify community" : "View details"}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}

// ── Statistics ──────────────────────────────────────────────────────────────

function Stat({ label, value, sub, href }: { label: string; value: ReactNode; sub?: ReactNode; href?: string }) {
  const body = (
    <>
      <p className="text-xs font-medium text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-[var(--color-text)]">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{sub}</p>}
    </>
  );
  const cls = `${panel} block px-4 py-3`;
  return href ? (
    <Link href={href} className={`${cls} transition-colors hover:border-[var(--color-border-strong)]`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function StatGrid({
  slug,
  overview: o,
  isPersonal,
  canSeeMembers,
}: {
  slug: string;
  overview: CommunityOverview;
  isPersonal: boolean;
  canSeeMembers: boolean;
}) {
  return (
    <section aria-label="Community at a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {!isPersonal && (
        <Stat
          label="Members"
          value={o.membersCount.toLocaleString("en-NG")}
          sub={`${o.membersConfirmedCount} confirmed${o.membersWaitingCount > 0 ? ` · ${o.membersWaitingCount} waiting` : ""}`}
          {...(canSeeMembers ? { href: `/c/${slug}/members` } : {})}
        />
      )}
      {!isPersonal && (
        <Stat label="Officers" value={o.officerCount} sub="Currently serving" href={`/c/${slug}/settings`} />
      )}
      <Stat
        label="Collections"
        value={o.collectionCount}
        sub={o.draftCollectionCount > 0 ? `${o.draftCollectionCount} draft${o.draftCollectionCount === 1 ? "" : "s"}` : "All time"}
        href={`/c/${slug}/collections`}
      />
      <Stat
        label="Live now"
        value={o.liveCollectionCount}
        sub={o.upcomingOrPausedCount > 0 ? `${o.upcomingOrPausedCount} scheduled or paused` : "Taking payments"}
        href={`/c/${slug}/collections?filter=active`}
      />
    </section>
  );
}

// ── Money ───────────────────────────────────────────────────────────────────

function MoneyFigure({
  icon,
  label,
  value,
  note,
  emphasis,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  note?: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
        {icon}
        {label}
      </p>
      <p
        className={`tabular-nums tracking-tight ${emphasis ? "text-2xl font-semibold text-[var(--color-primary)]" : "text-xl font-semibold text-[var(--color-text)]"}`}
      >
        {value}
      </p>
      {note && <p className="text-xs text-[var(--color-text-muted)]">{note}</p>}
    </div>
  );
}

/**
 * Collection activity and the sum of collection balances. Collected is gross
 * (before fees); balances are net and come from the ledger. They are not
 * slices of one total, and they are not a community wallet.
 */
export function MoneyPanel({ overview: o }: { overview: CommunityOverview }) {
  if (!o.canViewTransactions && !o.canViewBalances) return null;
  const iconCls = "h-3.5 w-3.5";
  return (
    <section aria-labelledby="money-heading" className={panel}>
      <div className="flex flex-col gap-1 border-b border-[var(--color-border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <h2 id="money-heading" className="text-sm font-semibold text-[var(--color-text)]">
          Money across collections
        </h2>
        <p className="text-xs text-[var(--color-text-muted)]">Each collection keeps its own balance</p>
      </div>

      {o.canViewTransactions && (
        <div className="border-b border-[var(--color-border)]">
          <MoneyFigure
            icon={<CircleDollarSign className={iconCls} aria-hidden="true" />}
            label="Total collected"
            value={naira(o.collectedKobo)}
            emphasis
            note={
              o.contributionCount === 0
                ? "No successful payments yet"
                : `${o.contributionCount} successful payment${o.contributionCount === 1 ? "" : "s"} · ${naira(o.collected30dKobo)} in the last 30 days${
                    o.lastContributionAt ? ` · last ${formatDistanceToNow(o.lastContributionAt)}` : ""
                  }`
            }
          />
        </div>
      )}

      {o.canViewBalances && (
        <>
          <div className="grid grid-cols-1 divide-y divide-[var(--color-border)] md:grid-cols-2 md:divide-y-0 xl:grid-cols-4 xl:divide-x">
            <MoneyFigure
              icon={<Wallet className={iconCls} aria-hidden="true" />}
              label="Available to withdraw"
              value={naira(o.availableKobo)}
              note="Settled money, withdrawn per collection"
            />
            <MoneyFigure
              icon={<Hourglass className={iconCls} aria-hidden="true" />}
              label="Settling"
              value={naira(o.pendingKobo)}
              note="Paid, available after T+1"
            />
            <MoneyFigure
              icon={<Clock className={iconCls} aria-hidden="true" />}
              label="Pending withdrawals"
              value={naira(o.withdrawingKobo)}
              note={`${o.openWithdrawalCount ?? 0} in progress`}
            />
            <MoneyFigure
              icon={<ArrowDownToLine className={iconCls} aria-hidden="true" />}
              label="Withdrawn"
              value={naira(o.withdrawnKobo)}
              note={`${o.paidWithdrawalCount ?? 0} completed payout${o.paidWithdrawalCount === 1 ? "" : "s"}`}
            />
          </div>
          <div className="flex flex-col gap-1 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-xs text-[var(--color-text-muted)] lg:flex-row lg:items-center lg:justify-between">
            <p>
              <span className="font-medium text-[var(--color-text)]">{naira(o.balanceKobo)}</span> held across collections
              {o.onHoldKobo !== null && o.onHoldKobo !== "0" && <> · {naira(o.onHoldKobo)} on hold</>}
            </p>
            <p>Totals add up separate collections. Withdraw from a collection&apos;s own page.</p>
          </div>
        </>
      )}
    </section>
  );
}

// ── Collections ─────────────────────────────────────────────────────────────

export function CollectionsPanel({
  slug,
  figures,
  canCreate,
}: {
  slug: string;
  figures: CommunityCollectionFigures[];
  canCreate: boolean;
}) {
  // Live and recently paid first (the database orders by latest payment).
  const shown = figures.filter((f) => f.status === "active" || f.status === "paused" || f.status === "scheduled").slice(0, 5);
  return (
    <section aria-labelledby="collections-heading" className={`${panel} flex h-full flex-col`}>
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h2 id="collections-heading" className="text-sm font-semibold text-[var(--color-text)]">
          Open collections
        </h2>
        <Link href={`/c/${slug}/collections`} className="text-xs font-medium text-[var(--color-primary)] hover:underline">
          All collections
        </Link>
      </div>
      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <p className="text-sm font-medium text-[var(--color-text)]">No open collections</p>
          <p className="max-w-xs text-xs text-[var(--color-text-muted)]">
            {canCreate ? "Start one to begin collecting money." : "Collections this community opens will appear here."}
          </p>
          {canCreate && (
            <Link
              href={`/c/${slug}/collections/new`}
              className="mt-1 text-sm font-medium text-[var(--color-primary)] hover:underline"
            >
              New collection
            </Link>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {shown.map((f) => {
            const progress = targetProgress(f.collectedKobo, f.targetAmountKobo);
            return (
              <li key={f.collectionId}>
                <Link
                  href={`/c/${slug}/collections/${f.slug}`}
                  className="flex flex-col gap-2 px-4 py-3 hover:bg-[var(--color-bg)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium text-[var(--color-text)]">{f.name}</p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {f.openWithdrawalCount !== null && f.openWithdrawalCount > 0 && (
                        <Badge tone="warning">Withdrawal pending</Badge>
                      )}
                      <Badge tone={STATUS_TONE[f.status as CollectionStatus] ?? "neutral"}>
                        {STATUS_LABEL[f.status as CollectionStatus] ?? f.status}
                      </Badge>
                    </div>
                  </div>
                  {f.collectedKobo !== null && (
                    <div className="flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
                      <span>
                        <span className="font-medium tabular-nums text-[var(--color-text)]">{naira(f.collectedKobo)}</span>
                        {f.targetAmountKobo !== null && f.targetAmountKobo !== "0" && <> of {naira(f.targetAmountKobo)}</>}
                        {" · "}
                        {f.contributionCount} payment{f.contributionCount === 1 ? "" : "s"}
                      </span>
                      {progress && <span className="tabular-nums">{progress.percent}%</span>}
                    </div>
                  )}
                  {progress && (
                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg)]"
                      role="progressbar"
                      aria-valuenow={progress.bar}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${f.name}: ${progress.percent}% of target`}
                    >
                      <div
                        className={`h-full rounded-full ${progress.percent >= 100 ? "bg-[var(--color-success)]" : "bg-[var(--color-primary)]"}`}
                        style={{ width: `${progress.bar}%` }}
                      />
                    </div>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Recent activity ─────────────────────────────────────────────────────────

function describe(item: CommunityActivityItem): { icon: ReactNode; text: ReactNode } {
  const icon = "h-4 w-4";
  const col = item.collectionName ? <span className="font-medium text-[var(--color-text)]">{item.collectionName}</span> : null;
  const who = item.actorName ? <span className="font-medium text-[var(--color-text)]">{item.actorName}</span> : "Someone";
  switch (item.kind) {
    case "contribution":
      return {
        icon: <Banknote className={`${icon} text-[var(--color-success)]`} aria-hidden="true" />,
        text: (
          <>
            {who} paid {naira(item.amountKobo)} to {col}
          </>
        ),
      };
    case "collection_published":
      return {
        icon: <Megaphone className={`${icon} text-[var(--color-info)]`} aria-hidden="true" />,
        text: <>{col} was published</>,
      };
    case "withdrawal_requested":
      return {
        icon: <Clock className={`${icon} text-[var(--color-warning)]`} aria-hidden="true" />,
        text: (
          <>
            {who} requested a {naira(item.amountKobo)} withdrawal from {col}
          </>
        ),
      };
    case "withdrawal_paid":
      return {
        icon: <BadgeCheck className={`${icon} text-[var(--color-success)]`} aria-hidden="true" />,
        text: (
          <>
            {naira(item.amountKobo)} from {col} was paid out
          </>
        ),
      };
    case "officer_appointed":
      return {
        icon: <UserCheck className={`${icon} text-[var(--color-info)]`} aria-hidden="true" />,
        text: (
          <>
            {who} joined as {item.detail ? roleLabel(item.detail).toLowerCase() : "an officer"}
          </>
        ),
      };
    case "member_joined":
      return {
        icon: <UserPlus className={`${icon} text-[var(--color-text-muted)]`} aria-hidden="true" />,
        text: item.detail === "pending_approval" ? <>{who} asked to join</> : <>{who} joined through an invite link</>,
      };
  }
}

export function RecentActivity({
  slug,
  items,
  canViewAll,
}: {
  slug: string;
  items: CommunityActivityItem[];
  canViewAll: boolean;
}) {
  return (
    <section aria-labelledby="activity-heading" className={`${panel} flex h-full flex-col`}>
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h2 id="activity-heading" className="text-sm font-semibold text-[var(--color-text)]">
          Recent activity
        </h2>
        {canViewAll && (
          <Link href={`/c/${slug}/activity`} className="text-xs font-medium text-[var(--color-primary)] hover:underline">
            View all
          </Link>
        )}
      </div>
      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 py-10 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">Nothing has happened here yet.</p>
        </div>
      ) : (
        <ol className="divide-y divide-[var(--color-border)]">
          {items.map((item, index) => {
            const { icon, text } = describe(item);
            return (
              <li key={`${item.kind}-${item.occurredAt}-${index}`} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg)]">
                  {icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[var(--color-text-muted)]">{text}</p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">
                    <time dateTime={item.occurredAt}>{formatDistanceToNow(item.occurredAt)}</time>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
