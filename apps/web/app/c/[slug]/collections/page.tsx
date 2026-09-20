import type { Collection, Community } from "@kolekto/db";
import { notFound } from "next/navigation";
import { getCommunityAccess, hasPermission } from "../../../../lib/permissions.ts";
import { createClient } from "../../../../lib/supabase/server.ts";
import { CollectionsClient } from "./CollectionsClient.tsx";

export const metadata = { title: "Collections" };

export default async function CollectionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();
  const c = community as Community;

  const access = await getCommunityAccess(c.id);

  // collections_select_officer (RLS) already limits this to communities the
  // caller holds a role in; the filter is for the query plan, not for safety.
  const { data: collections } = await supabase
    .from("collections")
    .select("*")
    .eq("community_id", c.id)
    .order("created_at", { ascending: false });

  return (
    <CollectionsClient
      slug={slug}
      collections={(collections ?? []) as Collection[]}
      canCreate={hasPermission(access, "collection.draft")}
    />
  );
}
