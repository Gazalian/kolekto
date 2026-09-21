"use server";

import { csvFilename, formatNaira, kobo, toCsv, type CsvColumn } from "@kolekto/domain";
import { getCommunityAccess, hasPermission } from "../../../../../lib/permissions.ts";
import { EXPORT_FIELDS, type ExportFieldChoice, type ExportFilters } from "./export-fields.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";

/**
 * Exporting the people a collection is asking (M7.5 part D).
 *
 * WHAT THIS EXPORTS, AND WHY IT IS NOT "CONTRIBUTORS". No contribution is
 * stored anywhere in this phase — ADR 0012 rejected a pending-contribution
 * table on purpose, and ADR 0006 gates the real one. So "everyone who paid"
 * has no rows behind it and cannot be exported honestly. What does exist, and
 * is what an organiser actually needs before an event, is the collection's
 * own roll: the members it asks, what each was asked for, whether an officer
 * exempted or waived any of it, and the community's own member fields.
 *
 * Columns for money received, payment status, tickets bought and check-in are
 * therefore absent rather than empty. An empty column in an export reads as
 * "nobody has paid"; an absent one reads as "this does not exist yet", which
 * is the truth.
 *
 * AUTHORIZATION. `member.export` is the existing permission for taking member
 * personal data out of the system (20260917120400), held by owner, admin and
 * treasurer and withheld from collector and viewer. It is checked here, on
 * the server, against the community that owns the collection — hiding the
 * button is not a control.
 *
 * SCOPING. Every query is filtered by the collection id, and the collection
 * is resolved from the community slug in the URL through RLS, which already
 * limits it to communities the caller holds a role in. A collection id from
 * another community resolves to nothing rather than to someone else's roll.
 */

export interface ExportResult {
  error?: string;
  /** The CSV itself. Generated on the server; the browser only saves it. */
  csv?: string;
  filename?: string;
  rowCount?: number;
}

/**
 * The custom member fields this community defined, offered as export columns
 * under their own labels (§23 — never `custom_field_1`).
 */
export async function listExportFields(
  slug: string,
): Promise<{ error?: string; fixed?: ExportFieldChoice[]; custom?: ExportFieldChoice[] }> {
  const supabase = await createClient();
  const { data: community } = await supabase.from("communities").select("id").eq("slug", slug).maybeSingle();
  if (!community) return { error: "That community could not be found" };

  const access = await getCommunityAccess(community.id as string);
  if (!hasPermission(access, "member.export")) {
    return { error: "You do not have permission to export member data" };
  }

  const { data } = await supabase
    .from("member_attribute_definitions")
    .select("key, label")
    .eq("community_id", community.id)
    .order("sort_order");

  return {
    fixed: [...EXPORT_FIELDS],
    custom: (data ?? []).map((row) => ({ key: `attr:${row.key as string}`, label: row.label as string })),
  };
}

export async function exportCollectionPeopleAction(
  slug: string,
  collectionSlug: string,
  fieldKeys: string[],
  filters: ExportFilters,
): Promise<ExportResult> {
  const supabase = await createClient();

  const { data: community } = await supabase
    .from("communities")
    .select("id, name, slug")
    .eq("slug", slug)
    .maybeSingle();
  if (!community) return { error: "That community could not be found" };

  const access = await getCommunityAccess(community.id as string);
  if (!hasPermission(access, "member.export")) {
    return { error: "You do not have permission to export member data" };
  }

  // Scoped to this community as well as this slug: a collection slug is only
  // unique within a community, and resolving it without the community id is
  // how one community's export returns another's roll.
  const { data: collection } = await supabase
    .from("collections")
    .select("id, name")
    .eq("community_id", community.id)
    .eq("slug", collectionSlug)
    .maybeSingle();
  if (!collection) return { error: "That collection could not be found" };

  const [
    { data: obligations },
    { data: members },
    { data: definitions },
    { data: values },
    { data: memberships },
    { data: checkIns },
  ] = await Promise.all([
    supabase.from("obligations").select("*").eq("collection_id", collection.id).order("created_at"),
    supabase.from("members").select("*").eq("community_id", community.id),
    supabase.from("member_attribute_definitions").select("*").eq("community_id", community.id).order("sort_order"),
    supabase.from("member_attribute_values").select("*").eq("community_id", community.id),
    supabase
      .from("member_group_memberships")
      .select("member_id, group_id, member_groups(name)")
      .eq("member_groups.community_id", community.id),
    supabase
      .from("event_check_ins")
      .select("obligation_id, checked_in_at, checked_out_at")
      .eq("collection_id", collection.id)
      .order("checked_in_at", { ascending: false }),
  ]);

  // The most recent visit per person, which is what "were they here?" means
  // at a door.
  const latestVisitByObligation = new Map<string, { checked_in_at: string; checked_out_at: string | null }>();
  for (const visit of checkIns ?? []) {
    const key = visit.obligation_id as string;
    if (!latestVisitByObligation.has(key)) {
      latestVisitByObligation.set(key, {
        checked_in_at: visit.checked_in_at as string,
        checked_out_at: (visit.checked_out_at as string | null) ?? null,
      });
    }
  }

  const memberById = new Map((members ?? []).map((member) => [member.id as string, member]));
  const groupsByMember = new Map<string, string[]>();
  const groupIdsByMember = new Map<string, string[]>();
  for (const row of memberships ?? []) {
    const memberId = row.member_id as string;
    // PostgREST returns an embedded row as an object or an array depending on
    // how it infers the relationship; both shapes mean one group here.
    const embedded = row.member_groups as unknown;
    const names = Array.isArray(embedded)
      ? (embedded as { name: string }[]).map((group) => group.name)
      : embedded
        ? [(embedded as { name: string }).name]
        : [];
    if (names.length > 0) groupsByMember.set(memberId, [...(groupsByMember.get(memberId) ?? []), ...names]);
    groupIdsByMember.set(memberId, [...(groupIdsByMember.get(memberId) ?? []), row.group_id as string]);
  }

  const valueByMemberAndDefinition = new Map<string, string>();
  for (const row of values ?? []) {
    valueByMemberAndDefinition.set(
      `${row.member_id as string}:${row.definition_id as string}`,
      (row.value_text as string | null) ?? "",
    );
  }
  const definitionIdByKey = new Map((definitions ?? []).map((row) => [row.key as string, row.id as string]));
  const labelByKey = new Map((definitions ?? []).map((row) => [row.key as string, row.label as string]));

  interface Row {
    obligation: Record<string, unknown>;
    member: Record<string, unknown> | undefined;
  }

  let rows: Row[] = (obligations ?? []).map((obligation) => ({
    obligation: obligation as Record<string, unknown>,
    member: memberById.get(obligation.member_id as string) as Record<string, unknown> | undefined,
  }));

  if (filters.status === "exempt") rows = rows.filter((row) => row.obligation.exempt === true);
  if (filters.status === "expected") rows = rows.filter((row) => row.obligation.exempt !== true);
  if (filters.groupId) {
    rows = rows.filter((row) =>
      (groupIdsByMember.get(row.obligation.member_id as string) ?? []).includes(filters.groupId!),
    );
  }

  const money = (value: unknown): string =>
    value === null || value === undefined ? "" : formatNaira(kobo(String(value)), { decimals: false });

  const columnFor = (key: string): CsvColumn<Row> | null => {
    switch (key) {
      case "full_name":
        return { header: "Full name", value: (row) => (row.member?.full_name as string) ?? "" };
      case "member_code":
        return { header: "Member ID", value: (row) => (row.member?.member_code as string) ?? "" };
      case "phone":
        return { header: "Phone number", value: (row) => (row.member?.phone_e164 as string) ?? "" };
      case "email":
        return { header: "Email", value: (row) => (row.member?.email as string) ?? "" };
      case "groups":
        return {
          header: "Groups",
          value: (row) => (groupsByMember.get(row.obligation.member_id as string) ?? []).join("; "),
        };
      case "expected_amount":
        return { header: "Expected amount", value: (row) => money(row.obligation.expected_amount_kobo) };
      case "waived_amount":
        return { header: "Waived amount", value: (row) => money(row.obligation.waived_amount_kobo) };
      case "obligation_status":
        return {
          header: "Status",
          value: (row) => (row.obligation.exempt === true ? "Exempt" : String(row.obligation.status ?? "")),
        };
      case "due_at":
        return {
          header: "Due date",
          value: (row) => (row.obligation.due_at ? String(row.obligation.due_at).slice(0, 10) : ""),
        };
      case "cycle":
        return { header: "Period", value: (row) => (row.obligation.cycle_key as string) ?? "" };
      case "checked_in":
        return {
          header: "Checked in",
          value: (row) => {
            const visit = latestVisitByObligation.get(row.obligation.id as string);
            if (!visit) return "No";
            const at = visit.checked_in_at.slice(0, 16).replace("T", " ");
            return visit.checked_out_at ? `Left ${visit.checked_out_at.slice(0, 16).replace("T", " ")}` : `Yes ${at}`;
          },
        };
      default: {
        if (!key.startsWith("attr:")) return null;
        const attributeKey = key.slice("attr:".length);
        const definitionId = definitionIdByKey.get(attributeKey);
        if (!definitionId) return null;
        return {
          header: labelByKey.get(attributeKey) ?? attributeKey,
          value: (row) => valueByMemberAndDefinition.get(`${row.obligation.member_id as string}:${definitionId}`) ?? "",
        };
      }
    }
  };

  // Unknown keys are dropped rather than trusted: the field list is a
  // client-supplied array, and a column name is not an instruction.
  const columns = fieldKeys.map(columnFor).filter((column): column is CsvColumn<Row> => column !== null);
  if (columns.length === 0) return { error: "Choose at least one column to export" };

  return {
    csv: toCsv(columns, rows),
    filename: csvFilename([community.name as string, collection.name as string], new Date()),
    rowCount: rows.length,
  };
}
