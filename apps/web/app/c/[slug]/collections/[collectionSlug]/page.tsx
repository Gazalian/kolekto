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
  MemberGroup,
  Obligation,
} from "@kolekto/db";
import { notFound } from "next/navigation";
import { countCollectionAudience } from "@kolekto/db";
import { requireCallerContext } from "../../../../../lib/caller.ts";
import { getCommunityAccess, hasPermission } from "../../../../../lib/permissions.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";
import { CollectionDetailClient, type ObligationRow } from "./CollectionDetailClient.tsx";
import { EXPORT_FIELDS } from "./export-fields.ts";

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
    { data: attributeDefinitions },
    { data: memberGroups },
    { data: checkIns },
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
      // Offered as export columns under their own labels, so a CSV says
      // "Matric number" rather than custom_field_1 (M7.5 part D).
      supabase.from("member_attribute_definitions").select("key, label").eq("community_id", c.id).order("sort_order"),
      supabase.from("member_groups").select("*").eq("community_id", c.id).is("archived_at", null).order("sort_order"),
      // The door's own record (M7.5 part E). Newest first, so the first row
      // per obligation is the visit that matters.
      supabase
        .from("event_check_ins")
        .select("obligation_id, checked_in_at, checked_out_at")
        .eq("collection_id", collection.id)
        .order("checked_in_at", { ascending: false }),
    ]);

  const customExportFields = (attributeDefinitions ?? []).map((definition) => ({
    key: `attr:${definition.key as string}`,
    label: definition.label as string,
  }));

  // The latest visit per person — what "were they here?" means at a door.
  const latestVisit = new Map<string, { checked_in_at: string; checked_out_at: string | null }>();
  for (const visit of checkIns ?? []) {
    const key = visit.obligation_id as string;
    if (!latestVisit.has(key)) {
      latestVisit.set(key, {
        checked_in_at: visit.checked_in_at as string,
        checked_out_at: (visit.checked_out_at as string | null) ?? null,
      });
    }
  }

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
      exportFields={{ fixed: [...EXPORT_FIELDS], custom: customExportFields }}
      exportGroups={(memberGroups ?? []) as MemberGroup[]}
      checkInPeople={obligationRows.map((row) => {
        const visit = latestVisit.get(row.obligation.id);
        return {
          obligationId: row.obligation.id,
          name: row.memberName,
          identifier: row.memberIdentifier,
          checkedInAt: visit?.checked_in_at ?? null,
          checkedOutAt: visit?.checked_out_at ?? null,
        };
      })}
      permissions={{
        canEdit: hasPermission(access, "collection.draft"),
        canPublish: hasPermission(access, "collection.publish"),
        canAssign: hasPermission(access, "obligation.assign"),
        canExempt: hasPermission(access, "obligation.exempt"),
        canShare: hasPermission(access, "collection.share"),
        canExport: hasPermission(access, "member.export"),
        canCheckIn: hasPermission(access, "attendance.check_in"),
      }}
    />
  );
}
