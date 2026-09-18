import "server-only";

import type { User } from "@kolekto/db";
import { redirect } from "next/navigation";
import { createClient } from "./supabase/server.ts";

/**
 * The signed-in user's `public.users` row (ADR 0004: never `auth.users`
 * directly — that table is a login, not a profile). Returns `null` rather
 * than redirecting, for callers on a page that renders differently either
 * way (the landing page's "Sign in" vs "Go to your communities").
 */
export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return null;

  const { data } = await supabase.from("users").select("*").eq("id", authUser.id).single();
  return (data as User | null) ?? null;
}

/** For a page that only makes sense signed in. Middleware already redirects an anonymous request away from most routes; this is the same guard at the page level, for defence in depth and for pages middleware does not cover. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
