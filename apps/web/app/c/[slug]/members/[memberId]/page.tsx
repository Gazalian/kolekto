import {
  communityMembershipIdSummary,
  getMembershipIdSettings,
  type AuditLog,
  type Community,
  type Member,
  type MemberAttributeDefinition,
  type MemberAttributeValue,
  type MemberGroup,
} from "@kolekto/db";
import { notFound } from "next/navigation";
import { requireCallerContext } from "../../../../../lib/caller.ts";
import { displayMembershipId } from "../../../../../lib/membership-id-server.ts";
import { getCommunityAccess, hasPermission } from "../../../../../lib/permissions.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";
import { MemberDetailClient } from "./MemberDetailClient.tsx";

export const metadata = { title: "Member" };

export default async function MemberDetailPage({
  params,
}: {
  params: Promise<{ slug: string; memberId: string }>;
}) {
  const { slug, memberId } = await params;
  const supabase = await createClient();

  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();
  const c = community as Community;

  // RLS decides whether this caller sees the member at all; a member id from
  // another community resolves to nothing, which is indistinguishable from not
  // existing (SEC-18).
  const { data: memberRow } = await supabase
    .from("members")
    .select("*")
    .eq("community_id", c.id)
    .eq("id", memberId)
    .maybeSingle();
  if (!memberRow) notFound();
  const member = memberRow as Member;

  const access = await getCommunityAccess(c.id);

  const [{ data: definitions }, { data: values }, { data: groups }, { data: memberships }, { data: activity }] =
    await Promise.all([
      supabase.from("member_attribute_definitions").select("*").eq("community_id", c.id).order("sort_order"),
      supabase.from("member_attribute_values").select("*").eq("member_id", member.id),
      supabase.from("member_groups").select("*").eq("community_id", c.id).order("sort_order"),
      supabase.from("member_group_memberships").select("group_id").eq("member_id", member.id),
      supabase
        .from("audit_logs")
        .select("*")
        .eq("community_id", c.id)
        .eq("object_id", member.id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

  // Membership ID (Part F; M9b2a). Owner decision D5: the FULL ID only for the
  // owner and officers holding membership.issue_ids (re-checked in SQL by
  // app.get_member_membership_id). Officers who can see contact details but
  // not manage IDs see the masked form (app.community_membership_id_summary).
  const canViewContact = hasPermission(access, "member.view_contact");
  const canManageIds = hasPermission(access, "membership.issue_ids");
  const caller = await requireCallerContext();
  const maskedOnly = async () => {
    const summary = await communityMembershipIdSummary(caller, c.id).catch(() => null);
    const row = summary?.get(member.id);
    return row ? { fullId: null, masked: row.masked, issuedAt: row.issuedAt } : null;
  };
  const [membershipId, idSettings] = await Promise.all([
    canManageIds ? displayMembershipId(caller, member.id) : canViewContact ? maskedOnly() : Promise.resolve(null),
    getMembershipIdSettings(caller, c.id).catch(() => null),
  ]);

  const valuesByDefinition = new Map(
    ((values ?? []) as MemberAttributeValue[]).map((value) => [value.definition_id, value.value_text]),
  );

  return (
    <MemberDetailClient
      slug={slug}
      member={member}
      definitions={((definitions ?? []) as MemberAttributeDefinition[]).map((definition) => ({
        definition,
        value: valuesByDefinition.get(definition.id) ?? null,
      }))}
      groups={(groups ?? []) as MemberGroup[]}
      groupIds={((memberships ?? []) as { group_id: string }[]).map((row) => row.group_id)}
      activity={(activity ?? []) as AuditLog[]}
      canEdit={hasPermission(access, "member.edit")}
      canArchive={hasPermission(access, "member.archive")}
      canManageGroups={hasPermission(access, "group.manage")}
      membership={
        canViewContact || hasPermission(access, "membership.issue_ids") || hasPermission(access, "member.suspend")
          ? {
              membershipId,
              idsEnabled: idSettings?.enabled === true,
              canIssue: hasPermission(access, "membership.issue_ids"),
              canSuspend: hasPermission(access, "member.suspend"),
            }
          : null
      }
    />
  );
}
