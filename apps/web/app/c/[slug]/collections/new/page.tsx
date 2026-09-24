import type { Community, MemberGroup } from "@kolekto/db";
import { notFound, redirect } from "next/navigation";
import { getCommunityAccess, hasPermission } from "../../../../../lib/permissions.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";
import { NewCollectionForm } from "./NewCollectionForm.tsx";

export const metadata = { title: "New collection" };

export default async function NewCollectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();
  const c = community as Community;

  // UI-level only, as everywhere else: app.create_collection re-checks
  // collection.draft whatever this decides (ADR 0008).
  const access = await getCommunityAccess(c.id);
  if (!hasPermission(access, "collection.draft")) redirect(`/c/${slug}/collections`);

  const [{ count: memberCount }, { data: groups }] = await Promise.all([
    supabase.from("members").select("id", { count: "exact", head: true }).eq("community_id", c.id),
    supabase
      .from("member_groups")
      .select("*")
      .eq("community_id", c.id)
      .is("archived_at", null)
      .order("sort_order"),
  ]);

  return (
    <NewCollectionForm
      slug={slug}
      communityId={c.id}
      memberCount={memberCount ?? 0}
      groups={(groups ?? []) as MemberGroup[]}
      // M7.7 §9: the reference step is an owner/admin decision, so a treasurer
      // drafting a collection is shown what it is rather than a control they
      // cannot use. `app.set_collection_code_settings` re-checks it regardless
      // (ADR 0008).
      canConfigureCodes={hasPermission(access, "collection.configure_codes")}
    />
  );
}
