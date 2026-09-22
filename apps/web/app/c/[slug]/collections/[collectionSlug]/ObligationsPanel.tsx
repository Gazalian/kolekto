"use client";

import type { Collection, CollectionTier } from "@kolekto/db";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  Dialog,
  EmptyState,
  SelectField,
  Table,
  Tbody,
  Td,
  TextField,
  Th,
  Thead,
  Tr,
} from "@kolekto/ui";
import { UserPlus } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { naira, OBLIGATION_LABEL, OBLIGATION_TONE, type ObligationStatus } from "../../../../../lib/collection-display.ts";
import {
  assignObligationsAction,
  cancelObligationAction,
  exemptObligationAction,
  syncObligationsAction,
  waiveObligationAction,
} from "../actions.ts";
import type { ObligationRow } from "./CollectionDetailClient.tsx";
import { loadRollAction, searchAssignableMembersAction } from "./roll-actions.ts";
import { ROLL_PAGE_SIZE, type RollCounts, type RollFilter } from "./roll.ts";

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
  firstPage,
  initialCounts,
  audienceGroups,
  audienceCounts,
  openCycleKey,
  tiers,
  canAssign,
  canExempt,
}: {
  slug: string;
  collection: Collection;
  /** The first page of the roll, rendered on the server. Everything after it is fetched. */
  firstPage: ObligationRow[];
  initialCounts: RollCounts;
  tiers: CollectionTier[];
  audienceGroups: string[];
  audienceCounts: { eligible: number; with_obligation: number; awaiting: number };
  /** The period being charged for, on a recurring collection. Null when none is open. */
  openCycleKey: string | null;
  canAssign: boolean;
  canExempt: boolean;
}) {
  const [assigning, setAssigning] = useState(false);
  const [query, setQuery] = useState("");
  /**
   * "Outstanding" is the question an organiser opens this screen to ask, and
   * part C lists it as a section of its own. It is a filter rather than a tab
   * because it is the same people, the same columns and the same actions —
   * a second tab would be a second place to learn.
   */
  const [shown, setShown] = useState<RollFilter>("all");
  const [exempting, setExempting] = useState<ObligationRow | null>(null);
  const [waiving, setWaiving] = useState<ObligationRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  /**
   * The roll is paged and searched by the server (M7.6 hardening).
   *
   * The first page arrives with the page, so the screen is never empty while
   * it waits. Everything after it — another page, a different filter, a
   * search — is a request, because a five-thousand-member association is not
   * something to send to a phone so that JavaScript can filter it. PostgREST
   * would also have stopped at a thousand rows, silently.
   */
  const [rows, setRows] = useState<ObligationRow[]>(firstPage);
  const [counts, setCounts] = useState<RollCounts>(initialCounts);
  const [total, setTotal] = useState<number>(initialCounts.all);
  const [page, setPage] = useState(0);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Bumped by anything that changes the roll, to ask for it again. */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Debounced only because of typing; a filter or a page change is a click
    // and deserves to feel immediate.
    const delay = query.trim() === "" ? 0 : 200;

    const timer = setTimeout(() => {
      setLoading(true);
      void loadRollAction(slug, collection.slug, { filter: shown, query, page }).then((result) => {
        if (cancelled) return;
        setLoading(false);
        if (result.error) {
          setError(result.error);
          return;
        }
        setRows(result.rows ?? []);
        setCounts(result.counts ?? initialCounts);
        setSearched(result.searched ?? false);
        setTotal(result.total ?? result.rows?.length ?? 0);
      });
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [collection.slug, initialCounts, page, query, reloadToken, shown, slug]);

  /** After a change to somebody's row: re-read the page being looked at, and the counts. */
  function refreshRoll(): void {
    setReloadToken((current) => current + 1);
  }

  const filtered = rows;
  const pageCount = searched ? 1 : Math.max(Math.ceil(total / ROLL_PAGE_SIZE), 1);

  // A recurring collection charges per period, so there has to be one open
  // before anybody can be expected to pay. Saying so is better than letting the
  // database refuse the click with CYCLE_REQUIRED.
  const isRecurring = collection.schedule === "recurring";
  const needsCycle = isRecurring && openCycleKey === null;
  const isTiered = collection.amount_model === "tiers";
  // Only shown once there is something to show. A column of dashes on a
  // collection that does not issue references is a column that asks a
  // question and answers it with nothing.
  const showReference = rows.some((row) => row.reference !== null) || collection.codes_enabled;

  return (
    <div className="flex flex-col gap-4">
      <Banner tone="info">
        These are the members expected to contribute and what each one is asked for. Nothing here can be marked paid:
        an obligation is only settled by a verified payment, and payments are not switched on yet.
      </Banner>

      {needsCycle && (
        <Banner tone="info">
          This collection charges per period, and no period is open. Open one under Settings, then come back to say who
          is expected to pay for it.
        </Banner>
      )}

      {isRecurring && openCycleKey && (
        <Banner tone="info">
          You are working on <strong>{openCycleKey}</strong>. Members are expected to pay once per period, so adding
          someone here charges them for {openCycleKey} only.
        </Banner>
      )}

      <Card>
        <CardBody className="flex flex-col gap-2">
          <p className="text-sm font-medium text-[var(--color-text)]">
            {collection.audience_mode === "all_members"
              ? "For everyone on the roll"
              : collection.audience_mode === "groups"
                ? `For ${audienceGroups.join(" and ") || "selected groups"}`
                : "For members you pick"}
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {audienceCounts.eligible} eligible · {audienceCounts.with_obligation} already expected to pay
          </p>

          {/* §38: eligibility is resolved live, but becoming eligible never
              creates a debt on its own. This is the prompt that asks a person
              to decide, and the only thing that materialises obligations. */}
          {canAssign && audienceCounts.awaiting > 0 && collection.audience_mode !== "selected_members" && !needsCycle && (
            <SyncPrompt
              slug={slug}
              collection={collection}
              awaiting={audienceCounts.awaiting}
              cycleKey={openCycleKey}
              onError={setError}
            />
          )}
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-text-muted)]">
          {counts.all} expected
          {counts.exempt > 0 ? ` · ${counts.exempt} exempt` : ""}
        </p>
        {canAssign && (
          <Button onClick={() => setAssigning(true)} disabled={needsCycle}>
            <UserPlus className="h-4 w-4" aria-hidden="true" /> Add members
          </Button>
        )}
      </div>

      {error && <Banner tone="danger">{error}</Banner>}

      {counts.all === 0 ? (
        <EmptyState
          title="No members have been added to this collection yet"
          description="Choose who is expected to contribute, and Kolekto will keep track of who still owes."
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["all", `Everyone (${counts.all})`],
                ["outstanding", `Outstanding (${counts.outstanding})`],
                ["exempt", `Exempt (${counts.exempt})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={shown === key}
                onClick={() => {
                  setShown(key);
                  setPage(0);
                }}
                className={
                  shown === key
                    ? "rounded-[var(--radius-md)] border border-transparent bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-fg)]"
                    : "rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }
              >
                {label}
              </button>
            ))}
          </div>

          <TextField
            label="Search"
            placeholder="Search by name, member ID or reference"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
          <Table data-responsive>
            <Thead>
              <Tr>
                {showReference && <Th>Reference</Th>}
                <Th>Member</Th>
                {isTiered && <Th>Option</Th>}
                {/* Which month this row is: the same member appears once per
                    period, and the rows are only distinguishable by it. */}
                {isRecurring && <Th>Period</Th>}
                <Th>Expected</Th>
                <Th>Waived</Th>
                <Th>Status</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {filtered.map((row) => (
                <Tr key={row.obligation.id}>
                  {showReference && (
                    <Td data-label="Reference">
                      <span className="font-mono text-sm text-[var(--color-text)]">{row.reference ?? "—"}</span>
                    </Td>
                  )}
                  <Td data-label="Member">
                    {row.memberName}
                    {row.memberIdentifier && (
                      <span className="block text-xs text-[var(--color-text-muted)]">{row.memberIdentifier}</span>
                    )}
                  </Td>
                  {isTiered && <Td data-label="Option">{row.tierName ?? "—"}</Td>}
                  {isRecurring && <Td data-label="Period">{row.obligation.cycle_key ?? "—"}</Td>}
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
                              else refreshRoll();
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

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-text-muted)]">
              {loading
                ? "Loading…"
                : searched
                  ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}${
                      filtered.length === 50 ? " — the first 50. Narrow the search to see the rest." : ""
                    }`
                  : `Showing ${filtered.length === 0 ? 0 : page * ROLL_PAGE_SIZE + 1}–${
                      page * ROLL_PAGE_SIZE + filtered.length
                    } of ${total}`}
            </p>

            {!searched && pageCount > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page === 0 || loading}
                  onClick={() => setPage((current) => Math.max(current - 1, 0))}
                >
                  Previous
                </Button>
                <span className="text-xs text-[var(--color-text-muted)]">
                  Page {page + 1} of {pageCount}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page >= pageCount - 1 || loading}
                  onClick={() => setPage((current) => Math.min(current + 1, pageCount - 1))}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {assigning && (
        <AssignDialog
          slug={slug}
          collection={collection}
          cycleKey={openCycleKey}
          tiers={tiers}
          collectionSlug={collection.slug}
          onClose={() => setAssigning(false)}
          onAssigned={refreshRoll}
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
          onDone={refreshRoll}
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
          onDone={refreshRoll}
          onError={setError}
        />
      )}
    </div>
  );
}

/**
 * "3 new members are eligible — Review & Add Obligations" (§38).
 *
 * The button is the whole point. A member joining 300 Level makes them eligible
 * for the dues that group is being charged; it does not make them owe anything.
 * Somebody decides that, here, and the decision is audited.
 */
function SyncPrompt({
  slug,
  collection,
  awaiting,
  cycleKey,
  onError,
}: {
  slug: string;
  collection: Collection;
  awaiting: number;
  cycleKey: string | null;
  onError: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [amount, setAmount] = useState("");
  const needsAmount = collection.amount_model !== "fixed";

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-warning-bg)]/40 p-3">
      <p className="text-sm text-[var(--color-text)]">
        {awaiting} eligible member{awaiting === 1 ? " is" : "s are"} not expected to pay yet.
      </p>

      {needsAmount && (
        <TextField
          label="Amount to expect from each"
          hint="In naira."
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      )}

      <Button
        size="sm"
        loading={isPending}
        disabled={needsAmount && amount.trim() === ""}
        onClick={() =>
          startTransition(async () => {
            const result = await syncObligationsAction(slug, collection.slug, {
              collectionId: collection.id,
              expectedAmount: needsAmount ? amount : "",
              ...(cycleKey ? { cycleKey } : {}),
            });
            if (result.error) onError(result.error);
          })
        }
      >
        Add {awaiting} obligation{awaiting === 1 ? "" : "s"}
        {cycleKey ? ` for ${cycleKey}` : ""}
      </Button>
    </div>
  );
}

function AssignDialog({
  slug,
  collection,
  collectionSlug,
  cycleKey,
  tiers,
  onClose,
  onAssigned,
  onError,
}: {
  slug: string;
  collection: Collection;
  collectionSlug: string;
  cycleKey: string | null;
  tiers: CollectionTier[];
  onClose: () => void;
  onAssigned: () => void;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState("");
  const [tierId, setTierId] = useState("");
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();

  /**
   * Who is still assignable, asked of the server.
   *
   * This dialog used to be handed every member of the community so it could
   * filter them in the browser. Same objection as the roll itself: a big
   * association is not something to ship to a phone, and PostgREST would have
   * stopped at a thousand of them anyway. It asks for a name and gets at most
   * fifty answers, already filtered to people who are not on this collection
   * for this period.
   */
  const [visible, setVisible] = useState<{ id: string; fullName: string; identifier: string | null }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        setLoading(true);
        void searchAssignableMembersAction(slug, collectionSlug, query, cycleKey).then((result) => {
          if (cancelled) return;
          setLoading(false);
          if (result.error) onError(result.error);
          else setVisible(result.members ?? []);
        });
      },
      query.trim() === "" ? 0 : 200,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [collectionSlug, cycleKey, onError, query, slug]);

  const isTiered = collection.amount_model === "tiers";
  const chosenTier = tiers.find((tier) => tier.id === tierId);

  // Only a per-member collection reads this figure; everywhere else the
  // collection states the amount and the database uses it whatever is typed.
  // A chosen option states it too — the tier IS the price (ADR 0010) — so
  // asking for a figure as well would be asking which of two numbers to
  // believe.
  const needsAmount = collection.amount_model !== "fixed" && !chosenTier;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Who is expected to contribute?"
      {...(cycleKey ? { description: `They will be expected to pay for ${cycleKey}.` } : {})}
    >
      <div className="flex flex-col gap-4">
        {isTiered && tiers.length > 0 && (
          <SelectField
            label="Which option?"
            value={tierId}
            onChange={(event) => setTierId(event.target.value)}
            hint={
              chosenTier
                ? `They will be expected to pay ${naira(chosenTier.price_kobo)} — the price of this option.`
                : "Choosing an option sets the amount, and gives each person a reference in that option's own series."
            }
          >
            <option value="">No particular option</option>
            {tiers
              .filter((tier) => !tier.hidden)
              .map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.name} — {naira(tier.price_kobo)}
                  {tier.code_prefix ? ` (${tier.code_prefix})` : ""}
                </option>
              ))}
          </SelectField>
        )}

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
          <span>
            {selected.size} selected
            {loading ? " · looking…" : visible.length === 50 ? " · showing the first 50" : ""}
          </span>
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
          {!loading && visible.length === 0 && (
            <li className="px-3 py-2 text-sm text-[var(--color-text-muted)]">
              {query.trim() === ""
                ? "Everybody in this community is already on this collection."
                : `Nobody available matches “${query.trim()}”.`}
            </li>
          )}
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
                ...(cycleKey ? { cycleKey } : {}),
                ...(tierId ? { tierId } : {}),
              });
              if (result.error) {
                onError(result.error);
                return;
              }
              onAssigned();
              onClose();
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
  onDone,
  onError,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  amountLabel?: string;
  onClose: () => void;
  onSubmit: (reason: string, amount?: string) => Promise<{ error?: string; ok?: boolean }>;
  /** The roll is paged now, so a changed row has to be re-read rather than assumed. */
  onDone: () => void;
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
              if (result.error) {
                onError(result.error);
                return;
              }
              onDone();
              onClose();
            })
          }
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
