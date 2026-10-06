/**
 * A-1 · legacy contributor code → public.legacy_links row.
 *
 * Legacy codes are not globally unique — the D2 evidence found 34 codes used
 * across more than one collection. Since `legacy_links.old_path` is globally
 * unique, we namespace the stored value:
 *
 *     old_path = `contributor:{legacy_collection_id}:{contributor_unique_code}`
 *
 * The kolekto-fe-old check-in workflow always has a collection context when
 * the scan input arrives (dashboard is scoped to a collection page), so the
 * lookup side can build the same key from `<collection>:<scan input>`.
 *
 * new_path points at the imported historical row's id in migration.legacy_contribution
 * (that table's own uuid, not the source_id) so the redirect handler resolves
 * without a second lookup.
 */

export interface LegacyContributionForLink {
  readonly source_contribution_id: string;           // legacy contributions.id
  readonly legacy_contribution_row_id: string;       // migration.legacy_contribution.id (new)
  readonly legacy_collection_id: string;
  readonly new_collection_id: string | null;         // null if the collection was excluded (rejected campaign)
  readonly contributor_unique_code: string;
}

export interface NewLegacyLinkRow {
  readonly kind: "contributor_code";
  readonly old_path: string;
  readonly new_path: string;
  readonly collection_id: string | null;
  readonly notes: string | null;
}

export function buildContributorCodeLink(c: LegacyContributionForLink): NewLegacyLinkRow | null {
  const code = c.contributor_unique_code.trim();
  if (code === "") return null;
  return {
    kind: "contributor_code",
    old_path: `contributor:${c.legacy_collection_id}:${code}`,
    new_path: c.legacy_contribution_row_id,
    collection_id: c.new_collection_id,
    notes: `legacy code ${JSON.stringify(code)}`,
  };
}
