"use server";

import {
  acknowledgeContributions,
  DatabaseError,
  listCollectionContributors,
  recordCollectionExport,
  type ContributorRow,
} from "@kolekto/db";
import { reportFilename, toCsv } from "@kolekto/domain";
import { requireCallerContext } from "../../../../../lib/caller.ts";
import { formatReportDateTime } from "../../../../../lib/pdf/report.ts";
import { createClient } from "../../../../../lib/supabase/server.ts";
import {
  CONTRIBUTOR_PAGE_SIZE,
  contributorCsvColumns,
  contributorExportFields,
  toContributorView,
  type ContributorFieldDef,
  type ContributorView,
} from "./contributor-register.ts";

/**
 * The contributor register's server side (design:
 * docs/product/COLLECTION-FINANCIAL-OVERVIEW-AND-REGISTER.md).
 *
 * SECURITY. The community is resolved from the slug through RLS and the
 * collection inside it, exactly like the roll and the export (SEC-18). Every
 * read and write after that is an `app.*` function running as the signed-in
 * officer, which checks the permission against the collection itself —
 * transaction.view to read, member.view_contact for email and phone,
 * contribution.acknowledge to acknowledge, member.export (in
 * app.record_collection_export) to export. Hiding a button is not a control.
 */

type Filter = "all" | "acknowledged" | "unacknowledged";

const acknowledgedFor = (filter: Filter): boolean | undefined =>
  filter === "acknowledged" ? true : filter === "unacknowledged" ? false : undefined;

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof DatabaseError) {
    if (error.code === "FORBIDDEN") return "You do not have permission to do that on this collection.";
    if (error.code === "INVALID" || error.code === "NOT_FOUND") return error.message;
  }
  return fallback;
}

async function resolve(slug: string, collectionSlug: string) {
  const supabase = await createClient();
  const { data: community } = await supabase.from("communities").select("id, name").eq("slug", slug).maybeSingle();
  if (!community) return { error: "That community could not be found" as const };
  const { data: collection } = await supabase
    .from("collections")
    .select("id, name, category, amount_model, schedule, participation_mode")
    .eq("community_id", community.id)
    .eq("slug", collectionSlug)
    .maybeSingle();
  if (!collection) return { error: "That collection could not be found" as const };
  return { supabase, community, collection };
}

export interface ContributorListResult {
  error?: string;
  rows?: ContributorView[];
  total?: number;
}

/** One page of the register. */
export async function listContributorsAction(
  slug: string,
  collectionSlug: string,
  input: { search?: string; filter: Filter; offset: number },
): Promise<ContributorListResult> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  try {
    const page = await listCollectionContributors(await requireCallerContext(), {
      collectionId: resolved.collection.id as string,
      search: input.search?.slice(0, 100),
      acknowledged: acknowledgedFor(input.filter),
      limit: CONTRIBUTOR_PAGE_SIZE,
      offset: Math.max(0, Math.floor(input.offset)),
    });
    return { rows: page.rows.map(toContributorView), total: page.total };
  } catch (error) {
    return { error: messageFor(error, "The contributor list could not be loaded.") };
  }
}

/**
 * One contribution in full, for the details drawer. Contact details are
 * included only when the caller holds member.view_contact; without it the
 * same row comes back without them rather than an error.
 */
export async function contributorDetailAction(
  slug: string,
  collectionSlug: string,
  contributionId: string,
): Promise<{ error?: string; row?: ContributorView }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  const caller = await requireCallerContext();
  const query = {
    collectionId: resolved.collection.id as string,
    contributionIds: [contributionId],
    limit: 1,
  };
  try {
    let page;
    try {
      page = await listCollectionContributors(caller, { ...query, includeContact: true });
    } catch (error) {
      if (!(error instanceof DatabaseError) || error.code !== "FORBIDDEN") throw error;
      page = await listCollectionContributors(caller, query);
    }
    const row = page.rows[0];
    return row ? { row: toContributorView(row) } : { error: "That contribution could not be found" };
  } catch (error) {
    return { error: messageFor(error, "The contribution could not be loaded.") };
  }
}

/**
 * Acknowledges the given contributions, or — with `all` — every one not yet
 * acknowledged that appeared at or before `asOf` (when the list was loaded).
 */
export async function acknowledgeContributionsAction(
  slug: string,
  collectionSlug: string,
  input: { contributionIds: string[] } | { all: true; asOf: string },
): Promise<{ error?: string; count?: number }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  if ("contributionIds" in input && input.contributionIds.length === 0) return { count: 0 };
  if ("all" in input && Number.isNaN(Date.parse(input.asOf))) return { error: "Reload the page and try again." };
  try {
    const count = await acknowledgeContributions(await requireCallerContext(), {
      collectionId: resolved.collection.id as string,
      contributionIds: "contributionIds" in input ? input.contributionIds.slice(0, 1000) : null,
      asOf: "all" in input ? input.asOf : undefined,
    });
    return { count };
  } catch (error) {
    return { error: messageFor(error, "Those contributions could not be acknowledged.") };
  }
}

/** Refused rather than truncated, like the roll export. */
const MAX_EXPORT_ROWS = 20_000;
const EXPORT_PAGE = 200;

export async function exportContributorsAction(
  slug: string,
  collectionSlug: string,
  input: { fieldKeys: string[]; search?: string; filter: Filter },
): Promise<{ error?: string; csv?: string; filename?: string; rowCount?: number }> {
  const resolved = await resolve(slug, collectionSlug);
  if ("error" in resolved) return { error: resolved.error };
  const { supabase, community, collection } = resolved;

  const { data: fieldRows } = await supabase
    .from("collection_fields")
    .select("key, label, type, sort_order")
    .eq("collection_id", collection.id);
  const fields = (fieldRows ?? []) as ContributorFieldDef[];

  const available = contributorExportFields({
    fields,
    hasOptions: collection.amount_model === "tiers" || collection.amount_model === "items",
    isEvent: collection.category === "event",
    isRecurring: collection.schedule === "recurring",
    isManaged: collection.participation_mode === "managed",
  });
  const columns = contributorCsvColumns(input.fieldKeys, available, (iso) => formatReportDateTime(new Date(iso)));
  if (columns.length === 0) return { error: "Choose at least one column to export" };
  const includeContact = input.fieldKeys.some((key) => key === "email" || key === "phone");

  const caller = await requireCallerContext();
  const rows: ContributorRow[] = [];
  try {
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const page = await listCollectionContributors(caller, {
        collectionId: collection.id as string,
        search: input.search?.slice(0, 100),
        acknowledged: acknowledgedFor(input.filter),
        includeContact,
        limit: EXPORT_PAGE,
        offset,
      });
      if (page.total > MAX_EXPORT_ROWS) {
        return {
          error: `This export would have ${page.total.toLocaleString()} rows, more than ${MAX_EXPORT_ROWS.toLocaleString()}. Narrow it with search or a filter.`,
        };
      }
      rows.push(...page.rows);
      if (page.rows.length < EXPORT_PAGE) break;
    }

    // Recorded before the file leaves, and it is also the permission check:
    // app.record_collection_export refuses without member.export. Column
    // names only — never a value (SEC-26).
    await recordCollectionExport(caller, {
      collectionId: collection.id as string,
      subject: "contributors",
      format: "csv",
      rowCount: rows.length,
      fields: columns.map((column) => column.header),
    });
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "FORBIDDEN") {
      return {
        error: includeContact
          ? "Exporting contributors with email or phone needs the member-export and contact permissions."
          : "Exporting contributors needs the member-export permission. An owner, admin or treasurer can do it.",
      };
    }
    return { error: messageFor(error, "The export could not be produced.") };
  }

  const generatedAt = new Date();
  return {
    csv: toCsv(columns, rows),
    filename: reportFilename([community.name as string, collection.name as string, "Contributors"], generatedAt, "csv"),
    rowCount: rows.length,
  };
}
