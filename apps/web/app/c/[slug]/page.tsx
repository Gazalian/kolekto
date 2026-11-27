import {
  getCommunityOverview,
  listCommunityCollectionFigures,
  listCommunityRecentActivity,
  type Community,
  type CommunityActivityItem,
  type CommunityCollectionFigures,
  type CommunityOverview,
} from "@kolekto/db";
import { Badge, ErrorState } from "@kolekto/ui";
import { Plus, UserPlus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCallerContext } from "../../../lib/caller.ts";
import { communityTypeLabel, formatShortDate } from "../../../lib/community-display.ts";
import { getCommunityAccess, hasPermission } from "../../../lib/permissions.ts";
import { createClient } from "../../../lib/supabase/server.ts";
import { CollectionsPanel, MoneyPanel, RecentActivity, StatGrid, VerificationCard } from "./overview-parts.tsx";

export const metadata = { title: "Overview" };

/**
 * The community overview: a snapshot, not a report.
 *
 * Every figure comes from three database reads (20261122120000) that check
 * permission themselves — community.view_dashboard for the page, then
 * transaction.view / balance.view per collection for money. The community
 * totals are the sum of separate collection balances; money is never pooled
 * and nothing here can move it. Detailed money stays on each collection page.
 */
export default async function CommunityOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  // RLS hides a community from a caller with no role in it, which is
  // indistinguishable from "it does not exist" (SEC-18). `maybeSingle` +
  // `notFound` keeps a vanished session from crashing the render.
  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();
  const c = community as Community;

  const access = await getCommunityAccess(c.id);
  const caller = await requireCallerContext();

  let overview: CommunityOverview | null = null;
  let figures: CommunityCollectionFigures[] = [];
  let activity: CommunityActivityItem[] = [];
  let failed = false;
  try {
    [overview, figures, activity] = await Promise.all([
      getCommunityOverview(caller, c.id),
      listCommunityCollectionFigures(caller, c.id),
      listCommunityRecentActivity(caller, c.id, 5),
    ]);
  } catch {
    failed = true;
  }

  const name = c.is_personal ? "My Workspace" : c.name;
  const canCreate = hasPermission(access, "collection.draft");
  const canInvite = hasPermission(access, "invite.create");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-[var(--color-text)]">{name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-text-muted)]">
            {!c.is_personal && <span>{communityTypeLabel(c.type)}</span>}
            {!c.is_personal && <span aria-hidden="true">·</span>}
            <span>Since {formatShortDate(c.created_at)}</span>
            {c.status !== "active" && <Badge tone="warning">{c.status}</Badge>}
          </p>
          {c.description && (
            <p className="mt-2 line-clamp-2 max-w-2xl text-sm text-[var(--color-text-muted)]">{c.description}</p>
          )}
        </div>
        {(canCreate || canInvite) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {canInvite && !c.is_personal && (
              <Link
                href={`/c/${slug}/members`}
                className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg)]"
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                Invite members
              </Link>
            )}
            {canCreate && (
              <Link
                href={`/c/${slug}/collections/new`}
                className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-3 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-strong)]"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                New collection
              </Link>
            )}
          </div>
        )}
      </header>

      {!c.is_personal && (
        <VerificationCard
          slug={slug}
          status={c.verification_status}
          verifiedAt={c.verified_at}
          canSubmit={hasPermission(access, "community.submit_verification")}
        />
      )}

      {failed || overview === null ? (
        <ErrorState description="This community's figures could not be loaded. Refresh the page to try again." />
      ) : (
        <>
          <StatGrid
            slug={slug}
            overview={overview}
            isPersonal={c.is_personal}
            canSeeMembers={hasPermission(access, "member.view_contact")}
          />
          <MoneyPanel overview={overview} />
          <div className="grid gap-6 xl:grid-cols-5">
            <div className="xl:col-span-3">
              <CollectionsPanel slug={slug} figures={figures} canCreate={canCreate} />
            </div>
            <div className="xl:col-span-2">
              <RecentActivity slug={slug} items={activity} canViewAll={hasPermission(access, "audit.view")} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
