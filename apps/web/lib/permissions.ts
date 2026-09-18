import "server-only";

/**
 * permissions.ts — the UI's read of ADR 0008's permission model.
 *
 * This is NOT the authorization boundary (section 14: "UI visibility is NOT
 * security"). It exists so the app can decide what to render — an "Add
 * member" button, a "Members" nav item — by reading the same
 * `role_permissions` matrix every `app.*` write function and every RLS
 * policy already checks server-side. Every write this app performs is
 * re-checked by `app.has_permission` inside the function that performs it
 * (packages/db/src/write.ts), regardless of what this file returns.
 *
 * Implemented as two `public`-schema reads (officer_terms, role_permissions)
 * rather than calling `app.has_permission` directly, because that function
 * lives in a schema PostgREST does not expose (see @kolekto/db/client.ts) —
 * this stays on the ordinary RLS-protected read path the browser already
 * uses, with no direct-Postgres connection needed just to draw a sidebar.
 */

import type { OfficerRole } from "@kolekto/db";
import { createClient } from "./supabase/server.ts";

export interface CommunityAccess {
  role: OfficerRole;
  permissions: ReadonlySet<string>;
}

/** `null` when the caller holds no active role in this community — RLS already guarantees they could not have read the community row at all in that case. */
export async function getCommunityAccess(communityId: string): Promise<CommunityAccess | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: term } = await supabase
    .from("officer_terms")
    .select("role")
    .eq("community_id", communityId)
    .eq("user_id", user.id)
    .is("ended_at", null)
    .maybeSingle();

  if (!term) return null;

  const { data: rolePermissions } = await supabase.from("role_permissions").select("permission").eq("role", term.role);

  return {
    role: term.role as OfficerRole,
    permissions: new Set((rolePermissions ?? []).map((row) => row.permission as string)),
  };
}

export function hasPermission(access: CommunityAccess | null, permission: string): boolean {
  return access?.permissions.has(permission) ?? false;
}
