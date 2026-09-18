import "server-only";

import { type CallerContext } from "@kolekto/db";
import { redirect } from "next/navigation";
import { createClient } from "./supabase/server.ts";

/** The `CallerContext` every server action passes to `@kolekto/db`'s write functions, so the direct-Postgres connection impersonates the actual signed-in user rather than running with the connection's own privileges. */
export async function requireCallerContext(): Promise<CallerContext> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { userId: user.id };
}
