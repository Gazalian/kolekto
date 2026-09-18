import type { Community, OfficerInvitation, OfficerTerm } from "@kolekto/db";
import { getCommunityAccess, hasPermission } from "../../../../lib/permissions.ts";
import { createClient } from "../../../../lib/supabase/server.ts";
import { SettingsClient } from "./SettingsClient.tsx";

export const metadata = { title: "Settings" };

interface OfficerTermWithUser extends OfficerTerm {
  users: { full_name: string } | null;
}

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).single();
  const c = community as Community;

  const access = await getCommunityAccess(c.id);

  const [{ data: officers }, { data: invitations }] = await Promise.all([
    supabase
      .from("officer_terms")
      .select("*, users(full_name)")
      .eq("community_id", c.id)
      .is("ended_at", null)
      .order("started_at"),
    hasPermission(access, "officer.invite")
      ? supabase.from("officer_invitations").select("*").eq("community_id", c.id).eq("status", "sent")
      : Promise.resolve({ data: [] as OfficerInvitation[] }),
  ]);

  return (
    <SettingsClient
      slug={slug}
      community={c}
      officers={(officers ?? []) as OfficerTermWithUser[]}
      invitations={(invitations ?? []) as OfficerInvitation[]}
      canEditProfile={hasPermission(access, "community.edit_profile")}
      canInviteOfficers={hasPermission(access, "officer.invite")}
      canRemoveOwner={hasPermission(access, "officer.remove_owner")}
      currentUserId={(await supabase.auth.getUser()).data.user?.id ?? ""}
    />
  );
}
