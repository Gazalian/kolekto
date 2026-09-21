"use server";

import {
  formatNaira,
  kobo,
  reportFilename,
  toCsv,
  type CsvColumn,
  type ReportColumn,
} from "@kolekto/domain";
import { recordCollectionExport } from "@kolekto/db";
import { requireCallerContext } from "../../../../../lib/caller.ts";
import { getCommunityAccess, hasPermission } from "../../../../../lib/permissions.ts";
import { formatReportDate, formatReportDateTime, renderReportPdf } from "../../../../../lib/pdf/report.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";
import {
  EXPORT_FIELDS,
  EXPORT_SUBJECTS,
  type ExportFieldChoice,
  type ExportFilters,
  type ExportRequest,
  type ExportSubjectKey,
} from "./export-fields.ts";

/**
 * Exporting a collection (M7.6 parts D–G, W, Y, Z, AC).
 *
 * AUTHORIZATION. `member.export` — the existing permission for taking member
 * personal data out of the system (20260917120400), held by owner, admin and
 * treasurer and withheld from collector and viewer. Checked here, on the
 * server, against the community that owns the collection. Hiding the tab is
 * not a control.
 *
 * SCOPING (part Y). Every query is filtered by the collection id, and the
 * collection is resolved from the community slug in the URL through RLS,
 * which already limits it to communities the caller holds a role in. A
 * collection id from another community resolves to nothing rather than to
 * someone else's roll, and a collection slug is only unique WITHIN a
 * community, so it is never resolved without the community id.
 *
 * SIZE (part AC). PostgREST returns at most a thousand rows per request
 * whatever the query says, so a two-thousand-member roll exported through a
 * single `.select()` would silently be half a roll — the worst possible
 * failure for a document somebody uses as a register. Everything here is
 * fetched in pages until it is exhausted, and a hard ceiling refuses rather
 * than truncates.
 *
 * WHAT IS NOT HERE. No money received, no payment status, no purchases, no
 * orders. Nothing records any of those in this phase (ADR 0006/0012), and a
 * column of blanks in a spreadsheet reads as "nobody paid".
 */

/** Refused rather than truncated. A register that is quietly missing people is worse than one that would not generate. */
const MAX_ROWS = 20_000;
const PAGE = 1000;

export interface ExportResult {
  error?: string;
  /** The CSV itself, when the format is csv. Generated on the server; the browser only saves it. */
  csv?: string;
  /** The PDF, base64 — a server action returns JSON, and bytes do not survive it. */
  pdfBase64?: string;
  filename?: string;
  rowCount?: number;
}

/** Pages through a filtered query until it stops returning rows. */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; tooMany: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data } = await build(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) return { rows, tooMany: false };
  }
  return { rows, tooMany: rows.length >= MAX_ROWS };
}

interface Row {
  obligation: Record<string, unknown>;
  member: Record<string, unknown> | undefined;
}

export async function exportCollectionAction(
  slug: string,
  collectionSlug: string,
  request: ExportRequest,
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

  const { data: collection } = await supabase
    .from("collections")
    .select("id, name, category, amount_model, schedule")
    .eq("community_id", community.id)
    .eq("slug", collectionSlug)
    .maybeSingle();
  if (!collection) return { error: "That collection could not be found" };

  const subject = EXPORT_SUBJECTS.find((option) => option.key === request.subject);
  if (!subject) return { error: "Choose what to export" };
  const isEvent = collection.category === "event";
  if (subject.needs === "event" && !isEvent) {
    return { error: "That report is only available on a collection with an event" };
  }

  const filters = request.filters;

  // ── The roll, filtered in the database ───────────────────────────────────
  // Filtering here rather than in memory is what keeps a large collection
  // from being fetched in full to produce a hundred rows (part AC).
  const { rows: obligations, tooMany } = await fetchAll<Record<string, unknown>>((from, to) => {
    let query = supabase
      .from("obligations")
      .select("id, member_id, tier_id, cycle_key, expected_amount_kobo, waived_amount_kobo, status, exempt, due_at, created_at")
      .eq("collection_id", collection.id)
      .order("created_at")
      .range(from, to);

    // The subject decides first, and the server applies it whatever the
    // browser sent.
    if (request.subject === "outstanding") {
      query = query.eq("exempt", false).neq("status", "cancelled");
    } else if (filters.status === "expected") {
      query = query.eq("exempt", false).neq("status", "cancelled");
    } else if (filters.status === "exempt") {
      query = query.eq("exempt", true);
    } else if (filters.status === "cancelled") {
      query = query.eq("status", "cancelled");
    }

    if (filters.tierId) query = query.eq("tier_id", filters.tierId);
    if (filters.cycleKey) query = query.eq("cycle_key", filters.cycleKey);
    // A date is a day, and a day ends at midnight — `lte` on the bare date
    // would drop everybody added during the last day of the range.
    if (filters.assignedFrom) query = query.gte("created_at", `${filters.assignedFrom}T00:00:00Z`);
    if (filters.assignedTo) query = query.lt("created_at", `${nextDay(filters.assignedTo)}T00:00:00Z`);

    return query;
  });

  if (tooMany) {
    return {
      error: `This collection has more than ${MAX_ROWS.toLocaleString()} rows. Narrow the filters — an export that quietly stopped part of the way through would be worse than none.`,
    };
  }

  const memberIds = [...new Set(obligations.map((row) => row.member_id as string))];

  const wanted = new Set(request.fieldKeys);
  const needsGroups = wanted.has("groups") || Boolean(filters.groupId);
  const needsAttendance =
    isEvent &&
    (wanted.has("checked_in") ||
      wanted.has("checked_out") ||
      wanted.has("attendance") ||
      request.subject === "arrived" ||
      (filters.attendance !== undefined && filters.attendance !== "all"));
  const customKeys = [...wanted].filter((key) => key.startsWith("attr:"));

  const [members, references, memberships, checkIns, definitions, values, tiers] = await Promise.all([
    memberIds.length === 0
      ? Promise.resolve([])
      : fetchAll<Record<string, unknown>>((from, to) =>
          supabase
            .from("members")
            .select("id, full_name, member_code, phone_e164, email")
            .in("id", memberIds)
            .range(from, to),
        ).then((result) => result.rows),
    fetchAll<Record<string, unknown>>((from, to) =>
      supabase
        .from("contributor_references")
        .select("obligation_id, reference")
        .eq("collection_id", collection.id)
        .range(from, to),
    ).then((result) => result.rows),
    needsGroups && memberIds.length > 0
      ? fetchAll<Record<string, unknown>>((from, to) =>
          supabase
            .from("member_group_memberships")
            .select("member_id, group_id, member_groups(name)")
            .in("member_id", memberIds)
            .range(from, to),
        ).then((result) => result.rows)
      : Promise.resolve([]),
    needsAttendance
      ? fetchAll<Record<string, unknown>>((from, to) =>
          supabase
            .from("event_check_ins")
            .select("obligation_id, checked_in_at, checked_out_at")
            .eq("collection_id", collection.id)
            .order("checked_in_at", { ascending: false })
            .range(from, to),
        ).then((result) => result.rows)
      : Promise.resolve([]),
    customKeys.length === 0
      ? Promise.resolve([])
      : supabase
          .from("member_attribute_definitions")
          .select("id, key, label")
          .eq("community_id", community.id)
          .then((result) => result.data ?? []),
    customKeys.length === 0 || memberIds.length === 0
      ? Promise.resolve([])
      : fetchAll<Record<string, unknown>>((from, to) =>
          supabase
            .from("member_attribute_values")
            .select("member_id, definition_id, value_text")
            .in("member_id", memberIds)
            .range(from, to),
        ).then((result) => result.rows),
    wanted.has("tier") || filters.tierId
      ? supabase
          .from("collection_tiers")
          .select("id, name")
          .eq("collection_id", collection.id)
          .then((result) => result.data ?? [])
      : Promise.resolve([]),
  ]);

  const memberById = new Map(members.map((member) => [member.id as string, member]));
  const referenceByObligation = new Map(
    references.map((row) => [row.obligation_id as string, row.reference as string]),
  );
  const tierNameById = new Map((tiers as { id: string; name: string }[]).map((tier) => [tier.id, tier.name]));

  const groupNames = new Map<string, string[]>();
  const groupIds = new Map<string, string[]>();
  for (const row of memberships) {
    const memberId = row.member_id as string;
    // PostgREST returns an embedded row as an object or an array depending on
    // how it infers the relationship; both shapes mean one group here.
    const embedded = row.member_groups as unknown;
    const names = Array.isArray(embedded)
      ? (embedded as { name: string }[]).map((group) => group.name)
      : embedded
        ? [(embedded as { name: string }).name]
        : [];
    if (names.length > 0) groupNames.set(memberId, [...(groupNames.get(memberId) ?? []), ...names]);
    groupIds.set(memberId, [...(groupIds.get(memberId) ?? []), row.group_id as string]);
  }

  // The most recent visit per person, which is what "were they here?" means
  // at a door. The rows arrive newest first.
  const latestVisit = new Map<string, { in: string; out: string | null }>();
  for (const visit of checkIns) {
    const key = visit.obligation_id as string;
    if (!latestVisit.has(key)) {
      latestVisit.set(key, {
        in: visit.checked_in_at as string,
        out: (visit.checked_out_at as string | null) ?? null,
      });
    }
  }

  const definitionIdByKey = new Map(
    (definitions as { id: string; key: string; label: string }[]).map((row) => [row.key, row.id]),
  );
  const labelByKey = new Map(
    (definitions as { id: string; key: string; label: string }[]).map((row) => [row.key, row.label]),
  );
  const valueByMemberAndDefinition = new Map<string, string>();
  for (const row of values) {
    valueByMemberAndDefinition.set(
      `${row.member_id as string}:${row.definition_id as string}`,
      (row.value_text as string | null) ?? "",
    );
  }

  // ── The rows that survive the filters this side ──────────────────────────
  let rows: Row[] = obligations.map((obligation) => ({
    obligation,
    member: memberById.get(obligation.member_id as string),
  }));

  if (filters.groupId) {
    rows = rows.filter((row) => (groupIds.get(row.obligation.member_id as string) ?? []).includes(filters.groupId!));
  }

  const attendanceOf = (row: Row): "inside" | "left" | "absent" => {
    const visit = latestVisit.get(row.obligation.id as string);
    if (!visit) return "absent";
    return visit.out ? "left" : "inside";
  };

  if (request.subject === "arrived") {
    rows = rows.filter((row) => attendanceOf(row) !== "absent");
  } else if (filters.attendance && filters.attendance !== "all") {
    rows = rows.filter((row) => attendanceOf(row) === filters.attendance);
  }

  // ── Columns ──────────────────────────────────────────────────────────────
  const money = (value: unknown): string =>
    value === null || value === undefined ? "" : formatNaira(kobo(String(value)), { decimals: false });

  const day = (value: unknown): string => (value ? formatReportDate(new Date(String(value))) : "");

  const cellFor = (key: string): { field: ExportFieldChoice; value: (row: Row) => string } | null => {
    const field =
      EXPORT_FIELDS.find((candidate) => candidate.key === key) ??
      (key.startsWith("attr:")
        ? ({
            key,
            label: labelByKey.get(key.slice(5)) ?? key.slice(5),
            group: "Custom fields" as const,
            weight: 2.4,
          } satisfies ExportFieldChoice)
        : null);
    if (!field) return null;

    switch (key) {
      case "reference":
        return { field, value: (row) => referenceByObligation.get(row.obligation.id as string) ?? "" };
      case "full_name":
        return { field, value: (row) => (row.member?.full_name as string) ?? "" };
      case "member_code":
        return { field, value: (row) => (row.member?.member_code as string) ?? "" };
      case "phone":
        return { field, value: (row) => (row.member?.phone_e164 as string) ?? "" };
      case "email":
        return { field, value: (row) => (row.member?.email as string) ?? "" };
      case "tier":
        return { field, value: (row) => tierNameById.get(row.obligation.tier_id as string) ?? "" };
      case "expected_amount":
        return { field, value: (row) => money(row.obligation.expected_amount_kobo) };
      case "waived_amount":
        return { field, value: (row) => money(row.obligation.waived_amount_kobo) };
      case "obligation_status":
        return {
          field,
          value: (row) => (row.obligation.exempt === true ? "Exempt" : String(row.obligation.status ?? "")),
        };
      case "due_at":
        return { field, value: (row) => day(row.obligation.due_at) };
      case "assigned_at":
        return { field, value: (row) => day(row.obligation.created_at) };
      case "cycle":
        return { field, value: (row) => (row.obligation.cycle_key as string) ?? "" };
      case "groups":
        return { field, value: (row) => (groupNames.get(row.obligation.member_id as string) ?? []).join("; ") };
      case "checked_in":
        return {
          field,
          value: (row) => {
            const visit = latestVisit.get(row.obligation.id as string);
            return visit ? formatReportDateTime(new Date(visit.in)) : "";
          },
        };
      case "checked_out":
        return {
          field,
          value: (row) => {
            const visit = latestVisit.get(row.obligation.id as string);
            return visit?.out ? formatReportDateTime(new Date(visit.out)) : "";
          },
        };
      case "attendance":
        return {
          field,
          value: (row) => ({ inside: "Inside", left: "Left", absent: "Not arrived" })[attendanceOf(row)],
        };
      default: {
        if (!key.startsWith("attr:")) return null;
        const definitionId = definitionIdByKey.get(key.slice(5));
        if (!definitionId) return null;
        return {
          field,
          value: (row) =>
            valueByMemberAndDefinition.get(`${row.obligation.member_id as string}:${definitionId}`) ?? "",
        };
      }
    }
  };

  // Unknown keys are dropped rather than trusted: the field list is a
  // client-supplied array, and a column name is not an instruction.
  const columns = request.fieldKeys
    .map(cellFor)
    .filter((column): column is NonNullable<ReturnType<typeof cellFor>> => column !== null);
  if (columns.length === 0) return { error: "Choose at least one column to export" };

  // ── Produce the file ─────────────────────────────────────────────────────
  const generatedAt = new Date();
  const stem = [community.name as string, collection.name as string, subject.label];

  // Recorded before the bytes leave: this is a disclosure of member data, and
  // the point of the record is that it exists whether or not the download
  // finishes (part Z). Column NAMES only — never a value out of any row.
  try {
    await recordCollectionExport(await requireCallerContext(), {
      collectionId: collection.id as string,
      subject: request.subject,
      format: request.format,
      rowCount: rows.length,
      fields: columns.map((column) => column.field.key),
    });
  } catch {
    // An audit write that fails must not swallow the export the officer is
    // entitled to; the failure is visible in the activity feed's absence.
  }

  if (request.format === "csv") {
    const csvColumns: CsvColumn<Row>[] = columns.map((column) => ({
      header: column.field.label,
      value: column.value,
    }));
    return {
      csv: toCsv(csvColumns, rows),
      filename: reportFilename(stem, generatedAt, "csv"),
      rowCount: rows.length,
    };
  }

  const reportColumns: ReportColumn[] = columns.map((column) => ({
    header: column.field.label,
    weight: column.field.weight,
    ...(column.field.align ? { align: column.field.align } : {}),
  }));

  const pdf = await renderReportPdf({
    title: collection.name as string,
    subtitle: subject.reportTitle,
    organiser: community.name as string,
    generatedAt,
    filters: describeFilters(request.subject, filters, {
      tierName: filters.tierId ? tierNameById.get(filters.tierId) : undefined,
      groupName: filters.groupId ? await groupName(supabase, filters.groupId) : undefined,
    }),
    columns: reportColumns,
    rows: rows.map((row) => columns.map((column) => column.value(row))),
    note: "Online payment is not switched on yet, so this report shows what was asked for — never what has been received.",
  });

  return {
    pdfBase64: Buffer.from(pdf).toString("base64"),
    filename: reportFilename(stem, generatedAt, "pdf"),
    rowCount: rows.length,
  };
}

async function groupName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  groupId: string,
): Promise<string | undefined> {
  const { data } = await supabase.from("member_groups").select("name").eq("id", groupId).maybeSingle();
  return (data?.name as string | undefined) ?? undefined;
}

function nextDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * What the reader of a printed report needs to know was left out.
 *
 * A report without its filters on it is a report somebody will read as the
 * whole list. Every narrowing is named, including the ones the subject chose
 * rather than the officer.
 */
function describeFilters(
  subject: ExportSubjectKey,
  filters: ExportFilters,
  names: { tierName?: string | undefined; groupName?: string | undefined },
): { label: string; value: string }[] {
  const described: { label: string; value: string }[] = [];

  if (subject === "outstanding") described.push({ label: "Who", value: "Still expected to pay" });
  else if (subject === "arrived") described.push({ label: "Who", value: "Checked in at the door" });
  else if (subject === "attendees") described.push({ label: "Who", value: "Everyone expected at the event" });

  if (subject !== "outstanding" && filters.status !== "all") {
    described.push({
      label: "Status",
      value: { expected: "Still expected", exempt: "Exempted", cancelled: "Cancelled", all: "Everyone" }[
        filters.status
      ],
    });
  }
  if (names.groupName) described.push({ label: "Group", value: names.groupName });
  if (names.tierName) described.push({ label: "Option", value: names.tierName });
  if (filters.cycleKey) described.push({ label: "Period", value: filters.cycleKey });
  if (subject !== "arrived" && filters.attendance && filters.attendance !== "all") {
    described.push({
      label: "At the door",
      value: { inside: "Inside", left: "Left", absent: "Not arrived", all: "Everyone" }[filters.attendance],
    });
  }
  if (filters.assignedFrom) described.push({ label: "Added from", value: filters.assignedFrom });
  if (filters.assignedTo) described.push({ label: "Added up to", value: filters.assignedTo });

  return described;
}
