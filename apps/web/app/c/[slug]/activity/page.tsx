import type { AuditLog, Community } from "@kolekto/db";
import { Badge, EmptyState, Table, Tbody, Td, Th, Thead, Tr } from "@kolekto/ui";
import { formatDistanceToNow } from "../../../../lib/format.ts";
import { createClient } from "../../../../lib/supabase/server.ts";

export const metadata = { title: "Activity" };

export default async function ActivityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).single();
  const c = community as Community;

  // audit_logs_select_officer (RLS) already requires audit.view — a viewer
  // without it simply gets zero rows back, not an error.
  const { data } = await supabase
    .from("audit_logs")
    .select("*")
    .eq("community_id", c.id)
    .order("created_at", { ascending: false })
    .limit(100);
  const logs = (data ?? []) as AuditLog[];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Activity</h1>

      {logs.length === 0 ? (
        <EmptyState title="No activity yet" description="Every change to this community will be recorded here (AUD-01)." />
      ) : (
        <Table data-responsive>
          <Thead>
            <Tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>Action</Th>
              <Th>Reason</Th>
            </Tr>
          </Thead>
          <Tbody>
            {logs.map((log) => (
              <Tr key={log.id}>
                <Td data-label="When">{formatDistanceToNow(log.created_at)}</Td>
                <Td data-label="Who">
                  {log.actor_name_snapshot}
                  {log.actor_type === "staff" && (
                    <Badge tone="info" >Kolekto staff</Badge>
                  )}
                </Td>
                <Td data-label="Action">{log.action}</Td>
                <Td data-label="Reason">{log.reason ?? "—"}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </div>
  );
}
