import type { Community } from "@kolekto/db";
import { Card, CardBody, EmptyState } from "@kolekto/ui";
import Link from "next/link";
import { requireUser } from "../../lib/auth.ts";
import { createClient } from "../../lib/supabase/server.ts";

export const metadata = { title: "Your communities" };

export default async function CommunitiesPage() {
  await requireUser();
  const supabase = await createClient();

  // RLS (communities_select_officer) already scopes this to communities the
  // caller holds an active role in — no community_id filter to add here.
  const { data } = await supabase.from("communities").select("*").order("is_personal", { ascending: false }).order("name");
  const communities = (data ?? []) as Community[];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Your communities</h1>
        <Link href="/communities/new" className="text-sm font-medium text-[var(--color-primary)] hover:underline">
          + New community
        </Link>
      </div>

      {communities.length === 0 ? (
        <EmptyState title="No communities yet" description="Create one to start collecting money from a group." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {communities.map((community) => (
            <Link key={community.id} href={`/c/${community.slug}`}>
              <Card className="h-full transition-shadow hover:shadow-[var(--shadow-md)]">
                <CardBody className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-[var(--color-text)]">
                      {community.is_personal ? "My Workspace" : community.name}
                    </span>
                  </div>
                  <span className="text-xs text-[var(--color-text-muted)]">kolekto.app/{community.slug}</span>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
