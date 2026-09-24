/**
 * The contributor-reference draft shape, and its empty default.
 *
 * Pulled out of `NewCollectionForm.tsx` (a `"use client"` module) because
 * `continue/page.tsx` — a server component — needs `emptyCodes()` too, for a
 * draft that has no `collection_code_settings` row yet (an organiser who left
 * before reaching the reference step). Everything exported from a
 * `"use client"` file becomes a client reference when a server component
 * imports it, even a pure function with no browser dependency, and Next.js
 * refuses to invoke a client reference during server rendering:
 *
 *   "Attempted to call emptyCodes() from the server but emptyCodes is on the
 *   client."
 *
 * That crash is exactly what resuming such a draft produced — caught by an
 * error boundary as "Something went wrong," with no wizard rendered at all.
 * This file has no directive, so it is a plain module either side can import.
 */

export interface CodeDraft {
  enabled: boolean;
  prefix: string;
  separator: "-" | "/" | "." | "";
  digits: string;
  startNumber: string;
  style: "sequential" | "random";
}

export function emptyCodes(): CodeDraft {
  return { enabled: false, prefix: "", separator: "-", digits: "4", startNumber: "1", style: "sequential" };
}
