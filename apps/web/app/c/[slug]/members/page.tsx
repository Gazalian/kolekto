import type { Community, InviteLink, Member } from "@kolekto/db";
import { getCommunityAccess, hasPermission } from "../../../../lib/permissions.ts";
import { createClient } from "../../../../lib/supabase/server.ts";
import { MembersClient } from "./MembersClient.tsx";

export const metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).single();
  const c = community as Community;

  const access = await getCommunityAccess(c.id);

  const [{ data: members }, { data: inviteLinks }, { data: groups }] = await Promise.all([
    supabase.from("members").select("*").eq("community_id", c.id).order("created_at", { ascending: false }),
    hasPermission(access, "invite.create")
      ? supabase.from("invite_links").select("*").eq("community_id", c.id).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as InviteLink[] }),
    supabase.from("member_groups").select("*").eq("community_id", c.id).order("sort_order"),
  ]);

  return (
    <MembersClient
      slug={slug}
      communityId={c.id}
      members={(members ?? []) as Member[]}
      inviteLinks={(inviteLinks ?? []) as InviteLink[]}
      groups={groups ?? []}
      canCreate={hasPermission(access, "member.create")}
      canEdit={hasPermission(access, "member.edit")}
      canArchive={hasPermission(access, "member.archive")}
      canInvite={hasPermission(access, "invite.create")}
      canApprove={hasPermission(access, "invite.approve")}
      communitySlugForLink={c.slug}
    />
  );
}
