import type {
  AuditLog,
  Collection,
  CollectionCycleRow,
  CollectionField,
  CollectionItem,
  CollectionRecurrence,
  CollectionTier,
  Community,
  Member,
  Obligation,
} from "@kolekto/db";
import { notFound } from "next/navigation";
import { countCollectionAudience } from "@kolekto/db";
import { requireCallerContext } from "../../../../../lib/caller.ts";
import { getCommunityAccess, hasPermission } from "../../../../../lib/permissions.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";
import { CollectionDetailClient, type ObligationRow } from "./CollectionDetailClient.tsx";

export async function generateMetadata({ params }: { params: Promise<{ collectionSlug: string }> }) {
  const { collectionSlug } = await params;
  return { title: collectionSlug.replace(/-/g, " ") };
}

export default async function CollectionDetailPage({
  params,
}: {
  params: Promise<{ slug: string; collectionSlug: string }>;
}) {
  const { slug, collectionSlug } = await params;
  const supabase = await createClient();

  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();
  const c = community as Community;

  // A collection slug is unique per community, and RLS decides whether this
  // caller sees the row at all — a collection in someone else's community
  // resolves to nothing, which is indistinguishable from not existing (SEC-18).
  const { data: collectionRow } = await supabase
    .from("collections")
    .select("*")
    .eq("community_id", c.id)
    .eq("slug", collectionSlug)
    .maybeSingle();
  if (!collectionRow) notFound();
  const collection = collectionRow as Collection;

  const access = await getCommunityAccess(c.id);

  const [
    { data: tiers },
    { data: fields },
    { data: obligations },
    { data: members },
    { data: activity },
    { data: audienceGroups },
    { data: items },
    { data: recurrence },
    { data: cycles },
  ] = await Promise.all([
      supabase.from("collection_tiers").select("*").eq("collection_id", collection.id).order("sort_order"),
      supabase.from("collection_fields").select("*").eq("collection_id", collection.id).order("sort_order"),
      supabase.from("obligations").select("*").eq("collection_id", collection.id).order("created_at"),
      supabase.from("members").select("*").eq("community_id", c.id).order("full_name"),
      supabase
        .from("audit_logs")
        .select("*")
        .eq("community_id", c.id)
        .eq("object_id", collection.id)
        .order("created_at", { ascending: false })
        .limit(50),
      // The groups this collection is for, by name. The rows reference groups
      // rather than copying members, so this is a join rather than a snapshot.
      supabase
        .from("collection_audience_groups")
        .select("group_id, member_groups(name)")
        .eq("collection_id", collection.id),
      // The type-specific configuration. Each is empty for the types that do
      // not have it, which is what makes them separate tables rather than
      // columns nobody can constrain.
      supabase.from("collection_items").select("*").eq("collection_id", collection.id).order("sort_order"),
      supabase.from("collection_recurrences").select("*").eq("collection_id", collection.id).maybeSingle(),
      supabase
        .from("collection_cycles")
        .select("*")
        .eq("collection_id", collection.id)
        .order("period_start", { ascending: false }),
    ]);

  const membersById = new Map((members ?? []).map((member) => [member.id as string, member as Member]));

  const obligationRows: ObligationRow[] = ((obligations ?? []) as Obligation[]).map((obligation) => {
    const member = membersById.get(obligation.member_id);
    return {
      obligation,
      memberName: member?.full_name ?? "Member",
      memberIdentifier: member?.member_code ?? null,
    };
  });

  // Who is already expected to pay, and therefore not offered again.
  //
  // On a recurring collection that question is about the open period, not about
  // the collection: somebody who paid October is exactly who November is for.
  // Scoping this to the whole collection would leave November's assign list
  // permanently empty.
  const openCycleKey = ((cycles ?? []) as CollectionCycleRow[]).find((cycle) => cycle.closed_at === null)?.cycle_key ?? null;
  const isRecurring = collection.schedule === "recurring";

  const assignedMemberIds = new Set(
    obligationRows
      .filter((row) => !isRecurring || row.obligation.cycle_key === openCycleKey)
      .map((row) => row.obligation.member_id),
  );

  // How many members the audience covers and how many of them have no
  // obligation yet — the number behind the "newly eligible" prompt. Counted by
  // the database so the prompt and the sync agree by construction.
  const audience =
    collection.audience_mode === "public"
      ? { eligible: 0, with_obligation: 0, awaiting: 0 }
      : await countCollectionAudience(await requireCallerContext(), collection.id);

  return (
    <CollectionDetailClient
      slug={slug}
      communitySlug={c.slug}
      collection={collection}
      tiers={(tiers ?? []) as CollectionTier[]}
      fields={(fields ?? []) as CollectionField[]}
      items={(items ?? []) as CollectionItem[]}
      recurrence={(recurrence as CollectionRecurrence | null) ?? null}
      cycles={(cycles ?? []) as CollectionCycleRow[]}
      obligations={obligationRows}
      assignableMembers={((members ?? []) as Member[])
        .filter((member) => !assignedMemberIds.has(member.id) && member.status !== "archived" && member.status !== "merged")
        .map((member) => ({ id: member.id, fullName: member.full_name, identifier: member.member_code }))}
      audienceGroups={(audienceGroups ?? []).flatMap((row) => {
        // PostgREST types an embedded one-to-one as an array; the foreign key
        // makes it at most one row.
        const embedded = (row as { member_groups: { name: string }[] | { name: string } | null }).member_groups;
        if (!embedded) return [];
        return Array.isArray(embedded) ? embedded.map((group) => group.name) : [embedded.name];
      })}
      audienceCounts={audience}
      activity={(activity ?? []) as AuditLog[]}
      permissions={{
        canEdit: hasPermission(access, "collection.draft"),
        canPublish: hasPermission(access, "collection.publish"),
        canAssign: hasPermission(access, "obligation.assign"),
        canExempt: hasPermission(access, "obligation.exempt"),
        canShare: hasPermission(access, "collection.share"),
      }}
    />
  );
}
