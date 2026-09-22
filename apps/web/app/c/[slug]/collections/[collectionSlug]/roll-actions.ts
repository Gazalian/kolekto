"use server";

import type { Obligation } from "@kolekto/db";
import { getCommunityAccess, hasPermission } from "../../../../../lib/permissions.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";
import {
  ROLL_MATCH_LIMIT,
  ROLL_PAGE_SIZE,
  type RollCounts,
  type RollFilter,
  type RollPage,
  type RollRow,
} from "./roll.ts";

/**
 * The roll, a page at a time (M7.6 hardening, item 1).
 *
 * WHY THIS EXISTS. The collection detail page used to read every obligation
 * and every member of the community in one go and hand them to the browser.
 * On a five-thousand-member association that is five thousand names sent to
 * a phone so that JavaScript can filter them — and, worse, PostgREST caps a
 * select at a thousand rows whatever the query says, so past a thousand
 * members it was not even the whole roll. The door was fixed in M7.6; this
 * is the same fix for the screen beside it.
 *
 * THE SHAPE, and why it is not uniform. Two different questions get asked of
 * a roll and they deserve different answers:
 *
 *   · "show me the roll" — paged, ordered, with a total, because an organiser
 *     scrolls a list they expect to be complete
 *   · "find Adeola" — capped at fifty matches and not paged, because an
 *     operator past fifty matches has mistyped rather than found somebody
 *
 * SECURITY. Identical to `searchAttendeesAction`, deliberately. The community
 * is resolved from the slug through RLS; the collection is resolved *within*
 * that community, because a collection slug is only unique inside one; every
 * subsequent query is filtered by the collection id. A collection from
 * another community resolves to nothing rather than to somebody else's roll
 * (SEC-18). Reading obligations additionally requires `transaction.view` for
 * that collection, which RLS enforces — a collector scoped elsewhere sees an
 * empty page rather than a forbidden one, which is the same answer as "there
 * is nothing here".
 */

/** Resolves the collection the way every other action here does, and refuses anything else. */
async function resolve(slug: string, collectionSlug: string) {
  const supabase = await createClient();

  const { data: community } = await supabase.from("communities").select("id").eq("slug", slug).maybeSingle();
  if (!community) return { error: "That community could not be found" as const };

  const { data: collection } = await supabase
    .from("collections")
    .select("id")
    .eq("community_id", community.id)
    .eq("slug", collectionSlug)
    .maybeSingle();
  if (!collection) return { error: "That collection could not be found" as const };

  return { supabase, communityId: community.id as string, collectionId: collection.id as string };
}

/**
 * `%` and `_` are ILIKE wildcards and a comma ends a PostgREST `or` argument.
 * Escaped so a search for "50%" looks for "50%" rather than for everything.
 */
function patternFor(needle: string): string {
  return `%${needle.replace(/([%_\\])/g, "\\$1").replace(/,/g, " ")}%`;
}

/** Decorates a page of obligations with the names, references and options an organiser reads. */
async function decorate(
  supabase: Awaited<ReturnType<typeof createClient>>,
  collectionId: string,
  obligations: Obligation[],
): Promise<RollRow[]> {
  if (obligations.length === 0) return [];

  const memberIds = [...new Set(obligations.map((row) => row.member_id))];
  const obligationIds = obligations.map((row) => row.id);

  const [members, references, tiers] = await Promise.all([
    supabase.from("members").select("id, full_name, member_code").in("id", memberIds),
    supabase.from("contributor_references").select("obligation_id, reference").in("obligation_id", obligationIds),
    obligations.some((row) => row.tier_id !== null)
      ? supabase.from("collection_tiers").select("id, name").eq("collection_id", collectionId)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  const memberById = new Map((members.data ?? []).map((row) => [row.id as string, row]));
  const referenceById = new Map(
    (references.data ?? []).map((row) => [row.obligation_id as string, row.reference as string]),
  );
  const tierById = new Map((tiers.data ?? []).map((row) => [row.id as string, row.name as string]));

  return obligations.map((obligation) => {
    const member = memberById.get(obligation.member_id);
    return {
      obligation,
      memberName: (member?.full_name as string) ?? "Member",
      memberIdentifier: (member?.member_code as string | null) ?? null,
      reference: referenceById.get(obligation.id) ?? null,
      tierName: obligation.tier_id ? tierById.get(obligation.tier_id) ?? null : null,
    };
  });
}

/**
 * The counts behind the Everyone / Outstanding / Exempt chips.
 *
 * Three `head: true` counts rather than counting an array nobody fetched.
 * "Outstanding" is the question this screen exists to answer, so its number
 * has to be the whole collection's, not the current page's.
 */
async function countRoll(
  supabase: Awaited<ReturnType<typeof createClient>>,
  collectionId: string,
): Promise<RollCounts> {
  const [all, outstanding, exempt] = await Promise.all([
    supabase.from("obligations").select("id", { count: "exact", head: true }).eq("collection_id", collectionId),
    supabase
      .from("obligations")
      .select("id", { count: "exact", head: true })
      .eq("collection_id", collectionId)
      .eq("exempt", false)
      .not("status", "in", "(cancelled,paid)"),
    supabase
      .from("obligations")
      .select("id", { count: "exact", head: true })
      .eq("collection_id", collectionId)
      .eq("exempt", true),
  ]);

  return {
    all: all.count ?? 0,
    outstanding: outstanding.count ?? 0,
    exempt: exempt.count ?? 0,
  };
}

export async function loadRollAction(
  slug: string,
  collectionSlug: string,
  input: { filter: RollFilter; query: string; page: number },
): Promise<RollPage> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  const { supabase, communityId, collectionId } = resolved;

  const counts = await countRoll(supabase, collectionId);
  const needle = input.query.trim();

  // ── A search: capped, not paged ─────────────────────────────────────────
  if (needle !== "") {
    const pattern = patternFor(needle);

    const [byReference, byMember] = await Promise.all([
      supabase
        .from("contributor_references")
        .select("obligation_id")
        .eq("collection_id", collectionId)
        // LIKE on an upper-cased needle rather than ILIKE, so
        // contributor_references_lookup_idx can be used. The reference format
        // constraint already restricts a reference to upper case.
        .like("reference", pattern.toUpperCase())
        .limit(ROLL_MATCH_LIMIT),
      supabase
        .from("members")
        .select("id")
        .eq("community_id", communityId)
        .or(`full_name.ilike.${pattern},member_code.ilike.${pattern}`)
        .limit(ROLL_MATCH_LIMIT * 4),
    ]);

    const memberIds = (byMember.data ?? []).map((row) => row.id as string);
    const obligationIds = (byReference.data ?? []).map((row) => row.obligation_id as string);
    if (memberIds.length === 0 && obligationIds.length === 0) {
      return { rows: [], counts, searched: true };
    }

    // Two queries rather than one `or` across a join: PostgREST cannot
    // express "this collection AND (member in … OR id in …)" without the
    // outer filter becoming optional, which is how a roll search starts
    // returning another collection's rows.
    const [fromMembers, fromReferences] = await Promise.all([
      memberIds.length === 0
        ? Promise.resolve({ data: [] as Obligation[] })
        : applyFilter(
            supabase.from("obligations").select("*").eq("collection_id", collectionId).in("member_id", memberIds),
            input.filter,
          ).limit(ROLL_MATCH_LIMIT),
      obligationIds.length === 0
        ? Promise.resolve({ data: [] as Obligation[] })
        : applyFilter(
            supabase.from("obligations").select("*").eq("collection_id", collectionId).in("id", obligationIds),
            input.filter,
          ).limit(ROLL_MATCH_LIMIT),
    ]);

    const merged = new Map<string, Obligation>();
    for (const row of [...(fromMembers.data ?? []), ...(fromReferences.data ?? [])]) {
      merged.set((row as Obligation).id, row as Obligation);
    }
    const found = [...merged.values()].slice(0, ROLL_MATCH_LIMIT);

    return { rows: await decorate(supabase, collectionId, found), counts, searched: true };
  }

  // ── A page of the roll ───────────────────────────────────────────────────
  const from = Math.max(input.page, 0) * ROLL_PAGE_SIZE;
  const { data, count } = await applyFilter(
    supabase
      .from("obligations")
      .select("*", { count: "exact" })
      .eq("collection_id", collectionId)
      .order("created_at")
      .order("id"),
    input.filter,
  ).range(from, from + ROLL_PAGE_SIZE - 1);

  return {
    rows: await decorate(supabase, collectionId, (data ?? []) as Obligation[]),
    total: count ?? 0,
    counts,
    searched: false,
  };
}

/**
 * The filter chips, applied in the database.
 *
 * Typed loosely on purpose: PostgREST's builder returns a different type
 * after every call, and naming each one here would be a type exercise that
 * describes the library rather than this collection.
 */
function applyFilter<T extends { eq: any; not: any }>(query: T, filter: RollFilter): T {
  if (filter === "outstanding") {
    return query.eq("exempt", false).not("status", "in", "(cancelled,paid)") as T;
  }
  if (filter === "exempt") {
    return query.eq("exempt", true) as T;
  }
  return query;
}

/**
 * Members who could still be put on this collection.
 *
 * Also server-side, and for the same reason: the assign dialog used to be
 * handed every member of the community so it could filter them in the
 * browser. It asks for a search term and gets at most fifty answers.
 *
 * "Already assigned" is decided per CYCLE on a recurring collection, not per
 * collection: somebody who paid October is exactly who November is for.
 */
export async function searchAssignableMembersAction(
  slug: string,
  collectionSlug: string,
  query: string,
  cycleKey: string | null,
): Promise<{ error?: string; members?: { id: string; fullName: string; identifier: string | null }[] }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  const { supabase, communityId, collectionId } = resolved;

  if (!hasPermission(await getCommunityAccess(communityId), "member.create")) {
    // Reading the member list to choose from is a member-list read. An
    // officer who cannot see members cannot be offered them here.
    return { members: [] };
  }

  const needle = query.trim();
  let candidates = supabase
    .from("members")
    .select("id, full_name, member_code")
    .eq("community_id", communityId)
    .not("status", "in", "(archived,merged)")
    .order("full_name")
    .limit(ROLL_MATCH_LIMIT * 4);

  if (needle !== "") {
    const pattern = patternFor(needle);
    candidates = candidates.or(`full_name.ilike.${pattern},member_code.ilike.${pattern}`);
  }

  const { data: members } = await candidates;
  const ids = (members ?? []).map((row) => row.id as string);
  if (ids.length === 0) return { members: [] };

  // Who among them already has an obligation for the period in question.
  let assigned = supabase.from("obligations").select("member_id").eq("collection_id", collectionId).in("member_id", ids);
  assigned = cycleKey === null ? assigned.is("cycle_key", null) : assigned.eq("cycle_key", cycleKey);
  const { data: taken } = await assigned;
  const takenIds = new Set((taken ?? []).map((row) => row.member_id as string));

  return {
    members: (members ?? [])
      .filter((row) => !takenIds.has(row.id as string))
      .slice(0, ROLL_MATCH_LIMIT)
      .map((row) => ({
        id: row.id as string,
        fullName: row.full_name as string,
        identifier: (row.member_code as string | null) ?? null,
      })),
  };
}
