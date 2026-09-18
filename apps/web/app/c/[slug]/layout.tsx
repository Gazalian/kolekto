import type { Community } from "@kolekto/db";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "../../../lib/auth.ts";
import { getCommunityAccess } from "../../../lib/permissions.ts";
import { createClient } from "../../../lib/supabase/server.ts";
import { AppShell } from "../../../components/AppShell.tsx";

export default async function CommunityLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser();
  const supabase = await createClient();

  // communities_select_officer (RLS) already returns this row only if the
  // caller holds an active role in it — a slug for a community they are not
  // part of resolves to no row, indistinguishable from a slug that does not
  // exist, which is the point (SEC-18: an id/slug from the URL never implies
  // access on its own).
  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();

  const access = await getCommunityAccess(community.id);
  if (!access) notFound();

  return (
    <AppShell community={community as Community} role={access.role} userName={user.full_name}>
      {children}
    </AppShell>
  );
}
