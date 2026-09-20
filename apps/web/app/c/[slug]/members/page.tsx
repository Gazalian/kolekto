import type {
  Community,
  CommunityMemberCodeSettings,
  InviteLink,
  Member,
  MemberAttributeDefinition,
  MemberAttributeValue,
  MemberGroup,
} from "@kolekto/db";
import { notFound } from "next/navigation";
import { getCommunityAccess, hasPermission } from "../../../../lib/permissions.ts";
import { createClient } from "../../../../lib/supabase/server.ts";
import { MembersClient, type MemberRow } from "./MembersClient.tsx";
import type { GroupRow } from "./GroupsManager.tsx";

export const metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();
  const c = community as Community;

  const access = await getCommunityAccess(c.id);

  const [
    { data: members },
    { data: definitions },
    { data: values },
    { data: groups },
    { data: groupMemberships },
    { data: codeSettings },
    { data: inviteLinks },
  ] = await Promise.all([
    supabase.from("members").select("*").eq("community_id", c.id).order("created_at", { ascending: false }),
    supabase.from("member_attribute_definitions").select("*").eq("community_id", c.id).order("sort_order"),
    supabase.from("member_attribute_values").select("*").eq("community_id", c.id),
    supabase.from("member_groups").select("*").eq("community_id", c.id).order("sort_order"),
    supabase.from("member_group_memberships").select("member_id, group_id"),
    supabase.from("community_member_code_settings").select("*").eq("community_id", c.id).maybeSingle(),
    hasPermission(access, "invite.create")
      ? supabase.from("invite_links").select("*").eq("community_id", c.id).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as InviteLink[] }),
  ]);

  // Attribute values arrive as one row per member per field. The table renders a
  // member per row, so they are folded into a map here rather than in the
  // browser — the page already knows the shape it wants to draw.
  const valuesByMember = new Map<string, Record<string, string>>();
  for (const value of (values ?? []) as MemberAttributeValue[]) {
    const existing = valuesByMember.get(value.member_id) ?? {};
    const definition = ((definitions ?? []) as MemberAttributeDefinition[]).find((d) => d.id === value.definition_id);
    if (definition) existing[definition.key] = value.value_text;
    valuesByMember.set(value.member_id, existing);
  }

  const groupsByMember = new Map<string, string[]>();
  for (const membership of (groupMemberships ?? []) as { member_id: string; group_id: string }[]) {
    groupsByMember.set(membership.member_id, [
      ...(groupsByMember.get(membership.member_id) ?? []),
      membership.group_id,
    ]);
  }

  // Groups carry their membership with them: the groups screen answers 'who is
  // in Block B' and the roster answers 'which groups is this person in', and
  // both read the same rows.
  const membersByGroup = new Map<string, string[]>();
  for (const membership of (groupMemberships ?? []) as { member_id: string; group_id: string }[]) {
    membersByGroup.set(membership.group_id, [...(membersByGroup.get(membership.group_id) ?? []), membership.member_id]);
  }

  const groupRows: GroupRow[] = ((groups ?? []) as MemberGroup[]).map((group) => ({
    group,
    memberIds: membersByGroup.get(group.id) ?? [],
  }));

  const rows: MemberRow[] = ((members ?? []) as Member[]).map((member) => ({
    member,
    attributes: valuesByMember.get(member.id) ?? {},
    groupIds: groupsByMember.get(member.id) ?? [],
  }));

  return (
    <MembersClient
      slug={slug}
      communityId={c.id}
      rows={rows}
      definitions={(definitions ?? []) as MemberAttributeDefinition[]}
      groups={((groups ?? []) as MemberGroup[]).filter((group) => group.archived_at === null)}
      groupRows={groupRows}
      codeSettings={(codeSettings ?? null) as CommunityMemberCodeSettings | null}
      inviteLinks={(inviteLinks ?? []) as InviteLink[]}
      canCreate={hasPermission(access, "member.create")}
      canEdit={hasPermission(access, "member.edit")}
      canArchive={hasPermission(access, "member.archive")}
      canInvite={hasPermission(access, "invite.create")}
      canApprove={hasPermission(access, "invite.approve")}
      canConfigure={hasPermission(access, "community.edit_profile")}
    />
  );
}
