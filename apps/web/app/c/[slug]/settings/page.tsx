import {
  getCommunityNoticeStatus,
  listDelegablePermissions,
  listOfficerPermissionGrants,
  listWithdrawalApproverCandidates,
  listWithdrawalApproverHistory,
  type Community,
  type CommunityNoticeStatus,
  type OfficerInvitation,
  type OfficerTerm,
} from "@kolekto/db";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireCallerContext } from "../../../../lib/caller.ts";
import { getCommunityAccess, hasPermission } from "../../../../lib/permissions.ts";
import { createClient } from "../../../../lib/supabase/server.ts";
import { approverPanelState, type ApproverPanelState } from "./approver-view.ts";
import { OfficerPermissionsCard, type DelegableOption, type GrantRow } from "./OfficerPermissionsCard.tsx";
import { PublicPageControl } from "./PublicPageControl.tsx";
import { SettingsClient } from "./SettingsClient.tsx";

export const metadata = { title: "Settings" };

interface OfficerTermWithUser extends OfficerTerm {
  users: { full_name: string } | null;
}

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  // See comment on the community overview page: `.single()` crashed the
  // server when the caller had no row visible (SEC-18) or the session had
  // just expired. `maybeSingle` + `notFound` returns a 404 there instead.
  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();
  const c = community as Community;

  const access = await getCommunityAccess(c.id);
  const canAttestNotice = hasPermission(access, "communication.attest_notice");
  const canSeeNotice = canAttestNotice || hasPermission(access, "collection.publish");

  const [{ data: officers }, { data: invitations }, noticeStatus] = await Promise.all([
    supabase
      .from("officer_terms")
      // officer_terms has two FKs to users (user_id, created_by): an
      // unqualified `users(...)` embed fails with PGRST201 and the list came
      // back empty. Name the officer's own relationship.
      .select("*, users!officer_terms_user_id_fkey(full_name)")
      .eq("community_id", c.id)
      .is("ended_at", null)
      .order("started_at"),
    hasPermission(access, "officer.invite")
      ? supabase.from("officer_invitations").select("*").eq("community_id", c.id).eq("status", "sent")
      : Promise.resolve({ data: [] as OfficerInvitation[] }),
    canSeeNotice
      ? requireCallerContext().then((caller) => getCommunityNoticeStatus(caller, c.id))
      : Promise.resolve<CommunityNoticeStatus | null>(null),
  ]);

  // Owner only: the second-approver section (session 39). Whether the caller
  // is an owner decides only what is SHOWN; the database refuses a non-owner.
  const currentUserId = (await supabase.auth.getUser()).data.user?.id ?? "";
  const isOwner = ((officers ?? []) as OfficerTermWithUser[]).some((o) => o.user_id === currentUserId && o.role === "owner");
  let approvers: ApproverPanelState | null = null;
  if (isOwner) {
    try {
      const caller = await requireCallerContext();
      const [history, candidates] = await Promise.all([
        listWithdrawalApproverHistory(caller, c.id),
        listWithdrawalApproverCandidates(caller, c.id),
      ]);
      approvers = approverPanelState(history, candidates);
    } catch {
      approvers = null;
    }
  }

  // Delegated permissions (Part F; M9b), shown in the Team tab only to those who
  // can act on them; every SQL function re-checks permission. Membership IDs
  // live on the Members page ("IDs & access").
  const canDelegate = hasPermission(access, "officer.delegate");
  let permissionsCard: ReactNode = null;
  if (!c.is_personal && canDelegate) {
    const caller = await requireCallerContext();
    const [delegable, grants] = await Promise.all([
      listDelegablePermissions(caller).catch((): DelegableOption[] => []),
      listOfficerPermissionGrants(caller, c.id).catch((): GrantRow[] => []),
    ]);
    const delegates = ((officers ?? []) as OfficerTermWithUser[])
      .filter((o) => o.role !== "owner")
      .map((o) => ({ termId: o.id, name: o.users?.full_name ?? "Officer", role: o.role }));
    permissionsCard = <OfficerPermissionsCard slug={slug} officers={delegates} delegable={delegable} grants={grants} />;
  }

  const publicPage =
    isOwner && !c.is_personal ? (
      <PublicPageControl
        slug={slug}
        communityId={c.id}
        published={c.public_page_published_at !== null}
        contactVisible={c.public_contact_visible}
        verified={c.verification_status === "verified"}
      />
    ) : null;

  return (
    <SettingsClient
      slug={slug}
      community={c}
      officers={(officers ?? []) as OfficerTermWithUser[]}
      invitations={(invitations ?? []) as OfficerInvitation[]}
      canEditProfile={hasPermission(access, "community.edit_profile")}
      canInviteOfficers={hasPermission(access, "officer.invite")}
      canRemoveOwner={hasPermission(access, "officer.remove_owner")}
      canAttestNotice={canAttestNotice}
      noticeStatus={noticeStatus}
      currentUserId={currentUserId}
      isOwner={isOwner}
      approvers={approvers}
      publicPage={publicPage}
      officerPermissions={permissionsCard}
    />
  );
}
