"use server";

import { checkInObligation, checkOutObligation, DatabaseError } from "@kolekto/db";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../../lib/caller.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";

/**
 * The door (M7.5 part E).
 *
 * Both actions pass an obligation id and nothing else. Everything that
 * decides anything — which community it belongs to, whether the caller may
 * work that door, whether the person is already inside — is decided by the
 * database function, from the row. An obligation id from another community
 * fails the permission check inside it rather than being filtered here
 * (SEC-18: a client-supplied id never implies eligibility).
 */

export interface CheckInResult {
  error?: string;
  ok?: boolean;
}

export async function checkInAction(slug: string, collectionSlug: string, obligationId: string): Promise<CheckInResult> {
  const caller = await requireCallerContext();
  try {
    await checkInObligation(caller, obligationId);
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "That person could not be checked in" };
  }
  revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
  return { ok: true };
}

export async function checkOutAction(
  slug: string,
  collectionSlug: string,
  obligationId: string,
): Promise<CheckInResult> {
  const caller = await requireCallerContext();
  try {
    await checkOutObligation(caller, obligationId);
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "That person could not be checked out" };
  }
  revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
  return { ok: true };
}

/**
 * Finding somebody at the door (M7.6 part P).
 *
 * Searched in the database, not in the browser. A 5,000-guest event must not
 * send 5,000 names to a phone on a car-park Wi-Fi so that JavaScript can
 * filter them: the page ships a first page, and every keystroke after that
 * asks the server.
 *
 * Four things are searched, because four things get said at a door: the
 * name on the list, the member ID, the contributor reference somebody reads
 * off their phone, and the option they bought. Results are capped — an
 * operator scrolling past fifty matches has mistyped, not found their guest.
 *
 * SCOPING. The collection is resolved from the community slug through RLS,
 * and every row is filtered by its id. A collection slug is only unique
 * within a community, so it is never resolved without the community.
 */

export interface AttendeeMatch {
  obligationId: string;
  name: string;
  identifier: string | null;
  reference: string | null;
  tierName: string | null;
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

const MATCH_LIMIT = 50;

export async function searchAttendeesAction(
  slug: string,
  collectionSlug: string,
  query: string,
): Promise<{ error?: string; matches?: AttendeeMatch[] }> {
  const needle = query.trim();
  if (needle === "") return { matches: [] };

  const supabase = await createClient();

  const { data: community } = await supabase.from("communities").select("id").eq("slug", slug).maybeSingle();
  if (!community) return { error: "That community could not be found" };

  const { data: collection } = await supabase
    .from("collections")
    .select("id")
    .eq("community_id", community.id)
    .eq("slug", collectionSlug)
    .maybeSingle();
  if (!collection) return { error: "That collection could not be found" };

  // `%` and `_` are wildcards in ILIKE, and a comma ends a PostgREST `or`
  // argument. Escaped so a search for "50%" looks for "50%".
  const pattern = `%${needle.replace(/([%_\\])/g, "\\$1").replace(/,/g, " ")}%`;

  const [byReference, byMember] = await Promise.all([
    supabase
      .from("contributor_references")
      .select("obligation_id")
      .eq("collection_id", collection.id)
      .ilike("reference", pattern)
      .limit(MATCH_LIMIT),
    supabase
      .from("members")
      .select("id")
      .eq("community_id", community.id)
      .or(`full_name.ilike.${pattern},member_code.ilike.${pattern}`)
      .limit(MATCH_LIMIT * 4),
  ]);

  const memberIds = (byMember.data ?? []).map((row) => row.id as string);
  const obligationIds = (byReference.data ?? []).map((row) => row.obligation_id as string);

  if (memberIds.length === 0 && obligationIds.length === 0) return { matches: [] };

  // Two queries rather than one `or` across a join: PostgREST cannot express
  // "this collection AND (member in … OR id in …)" without the outer filter
  // becoming optional, which is how a door search starts returning another
  // collection's guests.
  const [fromMembers, fromReferences] = await Promise.all([
    memberIds.length === 0
      ? Promise.resolve({ data: [] })
      : supabase
          .from("obligations")
          .select("id, member_id, tier_id")
          .eq("collection_id", collection.id)
          .in("member_id", memberIds)
          .limit(MATCH_LIMIT),
    obligationIds.length === 0
      ? Promise.resolve({ data: [] })
      : supabase
          .from("obligations")
          .select("id, member_id, tier_id")
          .eq("collection_id", collection.id)
          .in("id", obligationIds)
          .limit(MATCH_LIMIT),
  ]);

  const obligations = new Map<string, { id: string; member_id: string; tier_id: string | null }>();
  for (const row of [...(fromMembers.data ?? []), ...(fromReferences.data ?? [])]) {
    obligations.set(row.id as string, row as { id: string; member_id: string; tier_id: string | null });
  }
  const found = [...obligations.values()].slice(0, MATCH_LIMIT);
  if (found.length === 0) return { matches: [] };

  const [members, references, visits, tiers] = await Promise.all([
    supabase
      .from("members")
      .select("id, full_name, member_code")
      .in("id", [...new Set(found.map((row) => row.member_id))]),
    supabase
      .from("contributor_references")
      .select("obligation_id, reference")
      .in("obligation_id", found.map((row) => row.id)),
    supabase
      .from("event_check_ins")
      .select("obligation_id, checked_in_at, checked_out_at")
      .in("obligation_id", found.map((row) => row.id))
      .order("checked_in_at", { ascending: false }),
    supabase.from("collection_tiers").select("id, name").eq("collection_id", collection.id),
  ]);

  const memberById = new Map((members.data ?? []).map((row) => [row.id as string, row]));
  const referenceById = new Map((references.data ?? []).map((row) => [row.obligation_id as string, row.reference as string]));
  const tierById = new Map((tiers.data ?? []).map((row) => [row.id as string, row.name as string]));

  const latest = new Map<string, { in: string; out: string | null }>();
  for (const visit of visits.data ?? []) {
    const key = visit.obligation_id as string;
    if (!latest.has(key)) {
      latest.set(key, { in: visit.checked_in_at as string, out: (visit.checked_out_at as string | null) ?? null });
    }
  }

  return {
    matches: found.map((row) => {
      const member = memberById.get(row.member_id);
      const visit = latest.get(row.id);
      return {
        obligationId: row.id,
        name: (member?.full_name as string) ?? "Member",
        identifier: (member?.member_code as string | null) ?? null,
        reference: referenceById.get(row.id) ?? null,
        tierName: row.tier_id ? tierById.get(row.tier_id) ?? null : null,
        checkedInAt: visit?.in ?? null,
        checkedOutAt: visit?.out ?? null,
      };
    }),
  };
}
