/**
 * Tier prefix normalisation and shared-prefix disambiguation.
 *
 * Rules from MIGRATION-DECISION-EVIDENCE.md §7 and §8, approved by founder.
 *
 *   normalise:   strip non-alphanumerics, uppercase, truncate to 8
 *                FRONT-EN → FRONTEN;  UI/UX → UIUX
 *
 *   share rule:  within a duplicate-prefix group the tier with the HIGHEST
 *                price keeps the prefix; ties broken by highest sort_order.
 *                Others receive null. Legacy value preserved in overflow.
 */

export function normalisePrefix(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
  return s === "" ? null : s;
}

export interface TierForPrefixResolution {
  readonly ord: number;      // 1-based position from the legacy price_tiers array
  readonly rawPrefix: string | null;
  readonly priceKobo: bigint;
}

/**
 * Given tiers with their raw legacy prefixes, decide which ones keep a live
 * `code_prefix`. Returns a Map keyed by `ord` with the resolved value.
 *
 * Deterministic:
 *   - each raw prefix is normalised via `normalisePrefix`;
 *   - tiers with the same normalised value form a group;
 *   - within a group the tier with the highest `priceKobo` keeps the prefix;
 *   - ties broken by highest `ord` (D-brief: "highest sort_order");
 *   - all other tiers in the group get `null`;
 *   - groups of one carry the single normalised value through unchanged.
 */
export function resolveTierPrefixes(tiers: readonly TierForPrefixResolution[]): Map<number, string | null> {
  const normalised = tiers.map((t) => ({ ord: t.ord, priceKobo: t.priceKobo, norm: normalisePrefix(t.rawPrefix) }));
  const groups = new Map<string, typeof normalised>();
  const result = new Map<number, string | null>();
  for (const n of normalised) {
    if (n.norm == null) { result.set(n.ord, null); continue; }
    const g = groups.get(n.norm) ?? [];
    g.push(n); groups.set(n.norm, g);
  }
  for (const [norm, members] of groups) {
    if (members.length === 1) { result.set(members[0]!.ord, norm); continue; }
    // sort descending: price, then ord
    const sorted = [...members].sort((a, b) =>
      a.priceKobo === b.priceKobo ? b.ord - a.ord : (b.priceKobo > a.priceKobo ? 1 : -1),
    );
    result.set(sorted[0]!.ord, norm);
    for (const other of sorted.slice(1)) result.set(other.ord, null);
  }
  return result;
}
