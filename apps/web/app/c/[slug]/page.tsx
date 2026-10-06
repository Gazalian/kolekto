import type { Community } from "@kolekto/db";
import { Badge, Card, CardBody } from "@kolekto/ui";
import Link from "next/link";
import { createClient } from "../../../lib/supabase/server.ts";

export default async function CommunityOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).single();
  const c = community as Community;

  const [{ count: memberCount }, { count: officerCount }] = await Promise.all([
    supabase.from("members").select("id", { count: "exact", head: true }).eq("community_id", c.id),
    supabase.from("officer_terms").select("id", { count: "exact", head: true }).eq("community_id", c.id).is("ended_at", null),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-text)]">{c.is_personal ? "My Workspace" : c.name}</h1>
        {!c.is_personal && <p className="text-sm text-[var(--color-text-muted)]">kolekto.app/{c.slug}</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardBody>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Members</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--color-text)]">{memberCount ?? 0}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Officers</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--color-text)]">{officerCount ?? 0}</p>
          </CardBody>
        </Card>
      </div>

      {c.verification_status !== "verified" && (
        <Card>
          <CardBody className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-[var(--color-text)]">Verification</p>
              <p className="text-sm text-[var(--color-text-muted)]">
                Submitting for verification is not yet available in this build.
              </p>
            </div>
            <Badge tone="neutral">{c.verification_status}</Badge>
          </CardBody>
        </Card>
      )}

      {/* Financial figures (balances, collection totals) belong to Phase 3/4
          (ADR 0006) — this page shows only what the community already has:
          members and officers. No placeholder numbers. */}
    </div>
  );
}
