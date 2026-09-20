import "server-only";

import { headers } from "next/headers";

/**
 * A brake on member lookups.
 *
 * `app.find_collection_member` cannot be browsed — every match is an equality
 * on something the person already knows, and an ambiguous query returns a count
 * rather than a list. What it cannot prevent on its own is somebody with a list
 * of guesses trying them one after another: given a stolen roll of matric
 * numbers, a script could confirm which of them are in a given collection.
 *
 * This makes that slow and noisy rather than free. It is DELIBERATELY MODEST,
 * and the honest description of it is: a per-process, in-memory counter. It
 * resets when the server restarts, it does not coordinate across instances, and
 * a determined attacker on many addresses is not stopped by it. Real limiting
 * belongs at the edge (the CDN or the reverse proxy), which is where it will go
 * when this is deployed; this is the part the application itself can enforce.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;

const attempts = new Map<string, number[]>();

/** Best effort: the address the request came from, which behind a proxy is a header and therefore a hint, not a fact. */
async function callerKey(scope: string): Promise<string> {
  const headerList = await headers();
  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${scope}:${forwarded ?? headerList.get("x-real-ip") ?? "unknown"}`;
}

/** True when the caller may search again. Call once per attempt. */
export async function allowLookup(scope: string): Promise<boolean> {
  const key = await callerKey(scope);
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < WINDOW_MS);

  if (recent.length >= MAX_PER_WINDOW) {
    attempts.set(key, recent);
    return false;
  }

  recent.push(now);
  attempts.set(key, recent);

  // Keep the map from growing without bound on a long-lived server.
  if (attempts.size > 5_000) {
    for (const [existing, times] of attempts) {
      if (times.every((at) => now - at >= WINDOW_MS)) attempts.delete(existing);
    }
  }

  return true;
}
