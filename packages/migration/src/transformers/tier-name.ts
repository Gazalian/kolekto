/**
 * F-L4 tier renaming. Approved rule: when two or more tiers on the same
 * collection share a lower(trim(name)), each gets a bracketed suffix so it
 * becomes uniquely identifiable in the live schema.
 *
 * Suffix source order (first non-empty wins):
 *   1. the tier's own `code_prefix` (verified for every duplicate group)
 *   2. the first six words of its `description` — the fallback the brief spec's
 *      when a prefix is empty (never observed in the D2 duplicate groups)
 *   3. the tier's 1-based ord: `#{ord}` — only if neither above yields a suffix
 *
 * The transformation is:
 *   - deterministic: same inputs → same output;
 *   - idempotent: re-running on a name that already ends with " [X]" and no
 *     longer collides leaves it alone (only apply when the input group actually
 *     duplicates);
 *   - stable: a tier that is not in a duplicate group keeps its original name.
 */

export interface TierForNameResolution {
  readonly ord: number;
  readonly rawName: string;
  readonly rawPrefix: string | null;
  readonly rawDescription: string | null;
}

const NORM = (s: string): string => s.trim().toLowerCase();

function suffixWordsFromDescription(desc: string | null): string | null {
  if (desc == null) return null;
  const words = desc.trim().split(/\s+/).slice(0, 6).join(" ");
  return words === "" ? null : words;
}

function tidyName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function resolveTierNames(tiers: readonly TierForNameResolution[]): Map<number, string> {
  const bucket = new Map<string, TierForNameResolution[]>();
  for (const t of tiers) {
    const k = NORM(t.rawName);
    const g = bucket.get(k) ?? []; g.push(t); bucket.set(k, g);
  }
  const out = new Map<number, string>();
  for (const [, members] of bucket) {
    if (members.length === 1) { out.set(members[0]!.ord, tidyName(members[0]!.rawName)); continue; }
    for (const m of members) {
      const base = tidyName(m.rawName);
      const suffix =
        (m.rawPrefix != null && m.rawPrefix.trim() !== "" && m.rawPrefix.trim())
        || suffixWordsFromDescription(m.rawDescription)
        || `#${m.ord}`;
      out.set(m.ord, `${base} [${suffix}]`);
    }
  }
  return out;
}
