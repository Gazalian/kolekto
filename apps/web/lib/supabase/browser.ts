"use client";

/**
 * browser.ts — the Supabase client for Client Components.
 *
 * Reads `NEXT_PUBLIC_*` vars directly rather than through
 * `@kolekto/config#loadConfig`: that function also requires `KOLEKTO_ENV`,
 * which is deliberately NOT a `NEXT_PUBLIC_` var (ADR 0007 — nothing that
 * decides which database a process talks to is exposed further than it has
 * to be), so it is unset in a browser bundle and loadConfig() would throw
 * there on every call. Next.js inlines `NEXT_PUBLIC_*` references at build
 * time regardless, which is what makes reading them directly safe here.
 *
 * Only ever holds the publishable key. RLS (ADR 0008) is what makes that
 * safe to ship to a browser — this client can SELECT exactly what the
 * signed-in user's officer_terms allow, and nothing else, and it cannot
 * write to anything (the `authenticated` grant is SELECT-only; every write
 * goes through a server action calling @kolekto/db instead).
 */

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
}
