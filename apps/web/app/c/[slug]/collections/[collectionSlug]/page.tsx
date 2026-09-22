import type {
  AuditLog,
  Collection,
  CollectionCodeSettings,
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
import { collectionDoorTotals, countCollectionAudience } from "@kolekto/db";
import { requireCallerContext } from "../../../../../lib/caller.ts";
import { getCommunityAccess, hasPermission } from "../../../../../lib/permissions.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";
import { CollectionDetailClient, type ObligationRow } from "./CollectionDetailClient.tsx";
import type { ExportFieldChoice } from "./export-fields.ts";
import { DOOR_PAGE_SIZE, ROLL_PAGE_SIZE } from "./roll.ts";

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
  const isEvent = collection.category === "event";



  const [
    { data: tiers },
    { data: fields },
    { data: obligations },
    { data: activity },
    { data: audienceGroups },
    { data: items },
    { data: recurrence },
    { data: cycles },
    { data: attributeDefinitions },
    { data: memberGroups },
    { data: checkIns },
    { data: references },
    { data: codeSettings },
    { data: doorRoll },
    { data: doorMembers },
    { count: referenceCount },
    { count: rollAll },
    { count: rollOutstanding },
    { count: rollExempt },
  ] = await Promise.all([
      supabase.from("collection_tiers").select("*").eq("collection_id", collection.id).order("sort_order"),
      supabase.from("collection_fields").select("*").eq("collection_id", collection.id).order("sort_order"),
      // The first page only. Everything after it — another page, a filter, a
      // search — is a request the panel makes (M7.6 hardening item 1).
      supabase
        .from("obligations")
        .select("*")
        .eq("collection_id", collection.id)
        .order("created_at")
        .order("id")
        .range(0, ROLL_PAGE_SIZE - 1),
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
        .order("checked_in_at", { ascending: false })
        .range(0, 999),
      // M7.6: the reference each person on this page was issued. Shown beside
      // their name, searched at the door, and offered as an export column.
      supabase
        .from("contributor_references")
        .select("obligation_id, reference")
        .eq("collection_id", collection.id)
        .range(0, 999),
      supabase.from("collection_code_settings").select("*").eq("collection_id", collection.id).maybeSingle(),
      // The door's own first page. Separate from the roll's because a door
      // shows more at once and never shows a cancelled row.
      isEvent
        ? supabase
            .from("obligations")
            .select("*")
            .eq("collection_id", collection.id)
            .neq("status", "cancelled")
            .order("created_at")
            .order("id")
            .range(0, DOOR_PAGE_SIZE - 1)
        : Promise.resolve({ data: [] }),
      // Only the members named on the two first pages, not the community.
      supabase
        .from("members")
        .select("id, full_name, member_code")
        .eq("community_id", c.id)
        .order("full_name")
        .range(0, 999),
      supabase
        .from("contributor_references")
        .select("id", { count: "exact", head: true })
        .eq("collection_id", collection.id),
      // The chips' numbers, counted in the database rather than by counting
      // an array nobody fetched.
      supabase.from("obligations").select("id", { count: "exact", head: true }).eq("collection_id", collection.id),
      supabase
        .from("obligations")
        .select("id", { count: "exact", head: true })
        .eq("collection_id", collection.id)
        .eq("exempt", false)
        .not("status", "in", "(cancelled,paid)"),
      supabase
        .from("obligations")
        .select("id", { count: "exact", head: true })
        .eq("collection_id", collection.id)
        .eq("exempt", true),
    ]);

  // Offered as export columns under their own labels, so a file says "Matric
  // number" rather than custom_field_1.
  const customExportFields: ExportFieldChoice[] = (attributeDefinitions ?? []).map((definition) => ({
    key: `attr:${definition.key as string}`,
    label: definition.label as string,
    group: "Custom fields",
    weight: 2.4,
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

  const membersById = new Map((doorMembers ?? []).map((member) => [member.id as string, member as Member]));

  const referenceByObligation = new Map(
    (references ?? []).map((row) => [row.obligation_id as string, row.reference as string]),
  );
  const tierNameById = new Map(((tiers ?? []) as CollectionTier[]).map((tier) => [tier.id, tier.name]));

  const obligationRows: ObligationRow[] = ((obligations ?? []) as Obligation[]).map((obligation) => {
    const member = membersById.get(obligation.member_id);
    return {
      obligation,
      memberName: member?.full_name ?? "Member",
      memberIdentifier: member?.member_code ?? null,
      reference: referenceByObligation.get(obligation.id) ?? null,
      tierName: obligation.tier_id ? tierNameById.get(obligation.tier_id) ?? null : null,
    };
  });

  const doorPeople: ObligationRow[] = ((doorRoll ?? []) as Obligation[]).map((obligation) => {
    const member = membersById.get(obligation.member_id);
    return {
      obligation,
      memberName: member?.full_name ?? "Member",
      memberIdentifier: member?.member_code ?? null,
      reference: referenceByObligation.get(obligation.id) ?? null,
      tierName: obligation.tier_id ? tierNameById.get(obligation.tier_id) ?? null : null,
    };
  });

  // The period being charged for, on a recurring collection.
  const openCycleKey = ((cycles ?? []) as CollectionCycleRow[]).find((cycle) => cycle.closed_at === null)?.cycle_key ?? null;

  // How many members the audience covers and how many of them have no
  // obligation yet — the number behind the "newly eligible" prompt. Counted by
  // the database so the prompt and the sync agree by construction.
  const audience =
    collection.audience_mode === "public"
      ? { eligible: 0, with_obligation: 0, awaiting: 0 }
      : await countCollectionAudience(await requireCallerContext(), collection.id);

  // Likewise the door's three numbers: counted in the database, because "not
  // arrived" needs DISTINCT over a visit history (M7.6 hardening item 1).
  const doorTotals =
    isEvent && hasPermission(access, "attendance.check_in")
      ? await collectionDoorTotals(await requireCallerContext(), collection.id)
      : { expected: 0, inside: 0, left: 0, notArrived: 0 };

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
      roll={obligationRows}
      rollCounts={{
        all: rollAll ?? 0,
        outstanding: rollOutstanding ?? 0,
        exempt: rollExempt ?? 0,
      }}
      referenceCount={referenceCount ?? 0}
      audienceGroups={(audienceGroups ?? []).flatMap((row) => {
        // PostgREST types an embedded one-to-one as an array; the foreign key
        // makes it at most one row.
        const embedded = (row as { member_groups: { name: string }[] | { name: string } | null }).member_groups;
        if (!embedded) return [];
        return Array.isArray(embedded) ? embedded.map((group) => group.name) : [embedded.name];
      })}
      audienceCounts={audience}
      activity={(activity ?? []) as AuditLog[]}
      exportCustomFields={customExportFields}
      exportGroups={(memberGroups ?? []) as MemberGroup[]}
      codeSettings={(codeSettings as CollectionCodeSettings | null) ?? null}
      // The door ships a first page and searches the rest on the server
      // (M7.6 part P), so a five-thousand-guest event does not send five
      // thousand names to a phone at an entrance.
      checkInPeople={doorPeople.map((row) => {
        const visit = latestVisit.get(row.obligation.id);
        return {
          obligationId: row.obligation.id,
          name: row.memberName,
          identifier: row.memberIdentifier,
          reference: row.reference,
          tierName: row.tierName,
          checkedInAt: visit?.checked_in_at ?? null,
          checkedOutAt: visit?.checked_out_at ?? null,
        };
      })}
      checkInTotals={doorTotals}
      permissions={{
        canEdit: hasPermission(access, "collection.draft"),
        canPublish: hasPermission(access, "collection.publish"),
        canAssign: hasPermission(access, "obligation.assign"),
        canExempt: hasPermission(access, "obligation.exempt"),
        canShare: hasPermission(access, "collection.share"),
        canExport: hasPermission(access, "member.export"),
        canCheckIn: hasPermission(access, "attendance.check_in"),
        canConfigureCodes: hasPermission(access, "collection.configure_codes"),
      }}
    />
  );
}
