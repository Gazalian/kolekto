import "server-only";

/**
 * server.ts — the Supabase client for Server Components, Server Actions and
 * Route Handlers. Reads and writes the session cookie via `next/headers`, per
 * @supabase/ssr's documented pattern.
 *
 * This client still only ever holds the publishable key and is still bound
 * by RLS (ADR 0008) — it is not a privileged connection. The privileged path
 * (calling `app.*` write functions) is `@kolekto/db`, used from server
 * actions, never from here.
 */

import { loadConfig } from "@kolekto/config";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  const config = loadConfig();

  return createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, which cannot set cookies. The
          // middleware below refreshes the session on every request, so a
          // Server Component skipping this write is harmless.
        }
      },
    },
  });
}
