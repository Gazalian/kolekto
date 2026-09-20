"use client";

import type { Collection } from "@kolekto/db";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  Table,
  Tbody,
  Td,
  TextField,
  Th,
  Thead,
  Tr,
} from "@kolekto/ui";
import { UserPlus } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { naira, OBLIGATION_LABEL, OBLIGATION_TONE, type ObligationStatus } from "../../../../../lib/collection-display.ts";
import {
  assignObligationsAction,
  cancelObligationAction,
  exemptObligationAction,
  waiveObligationAction,
} from "../actions.ts";
import type { AssignableMember, ObligationRow } from "./CollectionDetailClient.tsx";

/**
 * Who is expected to pay, and what has been decided about them.
 *
 * What this table does NOT have is a "Paid" column, and its absence is
 * deliberate rather than pending. An obligation records what a member is
 * expected to contribute (OBL-01); what they have actually paid is derived from
 * contributions, which do not exist yet (ADR 0006). A column of zeroes, or of
 * dashes labelled "Paid", would be a claim about money this system cannot yet
 * make. The banner says so in words rather than leaving the reader to infer it.
 */
export function ObligationsPanel({
  slug,
  collection,
  obligations,
  assignableMembers,
  canAssign,
  canExempt,
}: {
  slug: string;
  collection: Collection;
  obligations: ObligationRow[];
  assignableMembers: AssignableMember[];
  canAssign: boolean;
  canExempt: boolean;
}) {
  const [assigning, setAssigning] = useState(false);
  const [query, setQuery] = useState("");
  const [exempting, setExempting] = useState<ObligationRow | null>(null);
  const [waiving, setWaiving] = useState<ObligationRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return obligations;
    return obligations.filter(
      (row) => row.memberName.toLowerCase().includes(q) || (row.memberIdentifier ?? "").toLowerCase().includes(q),
    );
  }, [obligations, query]);

  const counts = useMemo(() => {
    const byStatus = new Map<string, number>();
    for (const row of obligations) {
      byStatus.set(row.obligation.status, (byStatus.get(row.obligation.status) ?? 0) + 1);
    }
    return byStatus;
  }, [obligations]);

  return (
    <div className="flex flex-col gap-4">
      <Banner tone="info">
        These are the members expected to contribute and what each one is asked for. Nothing here can be marked paid:
        an obligation is only settled by a verified payment, and payments are not switched on yet.
      </Banner>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-text-muted)]">
          {obligations.length} expected
          {counts.get("exempt") ? ` · ${counts.get("exempt")} exempt` : ""}
          {counts.get("cancelled") ? ` · ${counts.get("cancelled")} cancelled` : ""}
        </p>
        {canAssign && (
          <Button onClick={() => setAssigning(true)} disabled={assignableMembers.length === 0}>
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Add members
          </Button>
        )}
      </div>

      {error && <Banner tone="danger">{error}</Banner>}

      {obligations.length === 0 ? (
        <EmptyState
          title="No members have been added to this collection yet"
          description={
            assignableMembers.length === 0
              ? "Add members to the community first, then choose who is expected to contribute."
              : "Choose who is expected to contribute, and Kolekto will keep track of who still owes."
          }
        />
      ) : (
        <>
          <TextField
            label="Search"
            placeholder="Search by name or member ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Table data-responsive>
            <Thead>
              <Tr>
                <Th>Member</Th>
                <Th>Expected</Th>
                <Th>Waived</Th>
                <Th>Status</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {filtered.map((row) => (
                <Tr key={row.obligation.id}>
                  <Td data-label="Member">
                    {row.memberName}
                    {row.memberIdentifier && (
                      <span className="block text-xs text-[var(--color-text-muted)]">{row.memberIdentifier}</span>
                    )}
                  </Td>
                  <Td data-label="Expected">{naira(row.obligation.expected_amount_kobo)}</Td>
                  <Td data-label="Waived">
                    {row.obligation.waived_amount_kobo > 0 ? naira(row.obligation.waived_amount_kobo) : "—"}
                  </Td>
                  <Td data-label="Status">
                    <Badge tone={OBLIGATION_TONE[row.obligation.status as ObligationStatus]}>
                      {OBLIGATION_LABEL[row.obligation.status as ObligationStatus]}
                    </Badge>
                  </Td>
                  <Td data-label="">
                    <div className="flex justify-end gap-2">
                      {canExempt && row.obligation.status === "unpaid" && (
                        <>
                          <button
                            type="button"
                            className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                            onClick={() => setWaiving(row)}
                          >
                            Waive
                          </button>
                          <button
                            type="button"
                            className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                            onClick={() => setExempting(row)}
                          >
                            Exempt
                          </button>
                        </>
                      )}
                      {canAssign && row.obligation.status !== "cancelled" && row.obligation.status !== "paid" && (
                        <button
                          type="button"
                          className="text-xs font-medium text-[var(--color-danger)] hover:underline"
                          disabled={isPending}
                          onClick={() =>
                            startTransition(async () => {
                              const result = await cancelObligationAction(slug, collection.slug, {
                                obligationId: row.obligation.id,
                              });
                              if (result.error) setError(result.error);
                            })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </>
      )}

      {assigning && (
        <AssignDialog
          slug={slug}
          collection={collection}
          members={assignableMembers}
          onClose={() => setAssigning(false)}
          onError={setError}
        />
      )}

      {exempting && (
        <ReasonDialog
          title={`Exempt ${exempting.memberName}?`}
          description="They will no longer be expected to contribute. The reason is visible to officers and to the member."
          confirmLabel="Exempt member"
          onClose={() => setExempting(null)}
          onSubmit={(reason) =>
            exemptObligationAction(slug, collection.slug, { obligationId: exempting.obligation.id, reason })
          }
          onError={setError}
        />
      )}

      {waiving && (
        <ReasonDialog
          title={`Waive part of ${waiving.memberName}'s balance`}
          description={`They were asked for ${naira(waiving.obligation.expected_amount_kobo)}. A waiver reduces what they owe without anyone paying it, and is never counted as money collected.`}
          confirmLabel="Waive amount"
          amountLabel="Amount to waive"
          onClose={() => setWaiving(null)}
          onSubmit={(reason, amount) =>
            waiveObligationAction(slug, collection.slug, {
              obligationId: waiving.obligation.id,
              waivedAmount: amount ?? "",
              reason,
            })
          }
          onError={setError}
        />
      )}
    </div>
  );
}

function AssignDialog({
  slug,
  collection,
  members,
  onClose,
  onError,
}: {
  slug: string;
  collection: Collection;
  members: AssignableMember[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState("");
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();

  // Only a per-member collection reads this figure; everywhere else the
  // collection states the amount and the database uses it whatever is typed.
  const needsAmount = collection.amount_model !== "fixed";

  const visible = members.filter((member) => {
    const q = query.trim().toLowerCase();
    return !q || member.fullName.toLowerCase().includes(q) || (member.identifier ?? "").toLowerCase().includes(q);
  });

  return (
    <Dialog open onClose={onClose} title="Who is expected to contribute?">
      <div className="flex flex-col gap-4">
        {needsAmount && (
          <TextField
            label="Amount expected from each member selected"
            hint="In naira."
            value={amount}
            required
            onChange={(event) => setAmount(event.target.value)}
          />
        )}

        <TextField
          label="Search members"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or member ID"
        />

        <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
          <span>{selected.size} selected</span>
          <button
            type="button"
            className="font-medium text-[var(--color-primary)] hover:underline"
            onClick={() =>
              setSelected((current) =>
                current.size === visible.length ? new Set() : new Set(visible.map((member) => member.id)),
              )
            }
          >
            {selected.size === visible.length ? "Clear all" : "Select all"}
          </button>
        </div>

        <ul className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
          {visible.map((member) => (
            <li key={member.id} className="border-b border-[var(--color-border)] last:border-b-0">
              <label className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                  checked={selected.has(member.id)}
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(member.id);
                      else next.delete(member.id);
                      return next;
                    })
                  }
                />
                <span>
                  {member.fullName}
                  {member.identifier && (
                    <span className="block text-xs text-[var(--color-text-muted)]">{member.identifier}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>

        <Button
          loading={isPending}
          disabled={selected.size === 0 || (needsAmount && amount.trim() === "")}
          onClick={() =>
            startTransition(async () => {
              const result = await assignObligationsAction(slug, collection.slug, {
                collectionId: collection.id,
                memberIds: [...selected],
                expectedAmount: needsAmount ? amount : "",
              });
              if (result.error) onError(result.error);
              else onClose();
            })
          }
        >
          Add {selected.size > 0 ? selected.size : ""} member{selected.size === 1 ? "" : "s"}
        </Button>
      </div>
    </Dialog>
  );
}

function ReasonDialog({
  title,
  description,
  confirmLabel,
  amountLabel,
  onClose,
  onSubmit,
  onError,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  amountLabel?: string;
  onClose: () => void;
  onSubmit: (reason: string, amount?: string) => Promise<{ error?: string; ok?: boolean }>;
  onError: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [isPending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} title={title} description={description}>
      <div className="flex flex-col gap-4">
        {amountLabel && (
          <TextField label={amountLabel} value={amount} required onChange={(event) => setAmount(event.target.value)} />
        )}
        <TextField
          label="Reason"
          hint="Kept in the audit log and visible to the member."
          value={reason}
          required
          onChange={(event) => setReason(event.target.value)}
        />
        <Button
          loading={isPending}
          disabled={reason.trim().length < 3 || (amountLabel !== undefined && amount.trim() === "")}
          onClick={() =>
            startTransition(async () => {
              const result = await onSubmit(reason, amountLabel ? amount : undefined);
              if (result.error) onError(result.error);
              else onClose();
            })
          }
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
