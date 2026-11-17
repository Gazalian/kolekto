"use client";

import { Badge, Banner, Button, Card, CardBody, Dialog } from "@kolekto/ui";
import { CheckCheck, Download, Search } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { formatDate } from "../../../../../lib/collection-display.ts";
import {
  acknowledgeContributionsAction,
  contributorDetailAction,
  exportContributorsAction,
  listContributorsAction,
} from "./contributor-actions.ts";
import {
  answerEntries,
  CONTRIBUTOR_EXPORT_GROUP_ORDER,
  contributorExportFields,
  defaultContributorExportKeys,
  describeLines,
  nairaText,
  type ContributorExportField,
  type ContributorFieldDef,
  type ContributorView,
} from "./contributor-register.ts";

type Filter = "all" | "acknowledged" | "unacknowledged";

/**
 * The contributor register (design §2.3–2.6).
 *
 * A list of people who have successfully paid — not a transaction log. Failed
 * and pending attempts never reach it. The default row carries only what an
 * organiser reads at a glance: who, how much, what they chose, the first
 * answers, when, and whether it has been acknowledged. Everything else is in
 * the details dialog, and contact details only there or in an export the
 * organiser chose them for.
 *
 * Paged, filtered and searched on the server; this component never holds the
 * whole collection.
 */
export function ContributorsPanel({
  slug,
  collectionSlug,
  fields,
  firstPage,
  firstTotal,
  counts,
  loadedAt,
  flags,
  permissions,
}: {
  slug: string;
  collectionSlug: string;
  fields: ContributorFieldDef[];
  firstPage: ContributorView[];
  firstTotal: number;
  counts: { contributions: number; acknowledged: number };
  /** When the page was rendered: "acknowledge all" stops here. */
  loadedAt: string;
  flags: { hasOptions: boolean; isEvent: boolean; isRecurring: boolean; isManaged: boolean };
  permissions: { canAcknowledge: boolean; canExport: boolean; canViewContact: boolean };
}) {
  const [rows, setRows] = useState<ContributorView[]>(firstPage);
  const [total, setTotal] = useState(firstTotal);
  const [filter, setFilter] = useState<Filter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [acknowledgedCount, setAcknowledgedCount] = useState(counts.acknowledged);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: "danger" | "success" | "info"; text: string } | null>(null);
  const [detail, setDetail] = useState<ContributorView | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const unacknowledgedCount = Math.max(0, counts.contributions - acknowledgedCount);

  function load(next: { filter: Filter; search: string; append: boolean }): void {
    setMessage(null);
    startTransition(async () => {
      const result = await listContributorsAction(slug, collectionSlug, {
        search: next.search,
        filter: next.filter,
        offset: next.append ? rows.length : 0,
      });
      if (result.error || !result.rows) {
        setMessage({ tone: "danger", text: result.error ?? "The list could not be loaded." });
        return;
      }
      setRows(next.append ? [...rows, ...result.rows] : result.rows);
      setTotal(result.total ?? 0);
      if (!next.append) setSelected(new Set());
    });
  }

  function chooseFilter(next: Filter): void {
    setFilter(next);
    load({ filter: next, search, append: false });
  }

  function submitSearch(): void {
    const trimmed = searchInput.trim();
    setSearch(trimmed);
    load({ filter, search: trimmed, append: false });
  }

  function markAcknowledged(ids: ReadonlySet<string> | "all", at: string): void {
    setRows((current) =>
      current
        .map((row) =>
          (ids === "all" ? !row.acknowledgedAt : ids.has(row.id)) && !row.acknowledgedAt
            ? { ...row, acknowledgedAt: at, acknowledgedByName: "You" }
            : row,
        )
        // Under "Not acknowledged", an acknowledged row has left the filter.
        .filter((row) => filter !== "unacknowledged" || !row.acknowledgedAt),
    );
  }

  function acknowledge(ids: string[]): void {
    setMessage(null);
    startTransition(async () => {
      const result = await acknowledgeContributionsAction(slug, collectionSlug, { contributionIds: ids });
      if (result.error) {
        setMessage({ tone: "danger", text: result.error });
        return;
      }
      const count = result.count ?? 0;
      setAcknowledgedCount((value) => value + count);
      if (filter === "unacknowledged") setTotal((value) => Math.max(0, value - count));
      markAcknowledged(new Set(ids), new Date().toISOString());
      setSelected(new Set());
      if (detail && ids.includes(detail.id)) {
        setDetail({ ...detail, acknowledgedAt: detail.acknowledgedAt ?? new Date().toISOString(), acknowledgedByName: detail.acknowledgedByName ?? "You" });
      }
      setMessage({
        tone: "success",
        text: count === 0 ? "Those were already acknowledged." : `Acknowledged ${count} ${count === 1 ? "contribution" : "contributions"}.`,
      });
    });
  }

  function acknowledgeAll(): void {
    setConfirmAll(false);
    setMessage(null);
    startTransition(async () => {
      const result = await acknowledgeContributionsAction(slug, collectionSlug, { all: true, asOf: loadedAt });
      if (result.error) {
        setMessage({ tone: "danger", text: result.error });
        return;
      }
      const count = result.count ?? 0;
      setAcknowledgedCount((value) => value + count);
      // Reload rather than guess which rows changed: the server decided.
      const reloaded = await listContributorsAction(slug, collectionSlug, { search, filter, offset: 0 });
      if (reloaded.rows) {
        setRows(reloaded.rows);
        setTotal(reloaded.total ?? 0);
      }
      setSelected(new Set());
      setMessage({
        tone: "success",
        text:
          count === 0
            ? "Everything up to when you opened this page was already acknowledged."
            : `Acknowledged ${count} ${count === 1 ? "contribution" : "contributions"}. Payments that arrived after you opened this page were left for you to see first.`,
      });
    });
  }

  function openDetail(row: ContributorView): void {
    setDetail(row);
    startTransition(async () => {
      const result = await contributorDetailAction(slug, collectionSlug, row.id);
      if (result.row) setDetail(result.row);
    });
  }

  function toggle(id: string, on: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const selectableIds = rows.filter((row) => !row.acknowledgedAt).map((row) => row.id);
  const allPageSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  if (counts.contributions === 0) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">No contributions yet</h2>
          <p className="text-sm text-[var(--color-text-muted)]">
            When someone pays successfully, they appear here with the details you asked for. Failed or unfinished
            payments never appear.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter contributors">
          <FilterChip active={filter === "all"} onClick={() => chooseFilter("all")} label="All" count={counts.contributions} />
          <FilterChip
            active={filter === "unacknowledged"}
            onClick={() => chooseFilter("unacknowledged")}
            label="Not acknowledged"
            count={unacknowledgedCount}
          />
          <FilterChip
            active={filter === "acknowledged"}
            onClick={() => chooseFilter("acknowledged")}
            label="Acknowledged"
            count={acknowledgedCount}
          />
        </div>
        {permissions.canExport && (
          <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)}>
            <Download className="h-4 w-4" aria-hidden="true" /> Export
          </Button>
        )}
      </div>

      <form
        className="flex gap-2"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
      >
        <label className="sr-only" htmlFor="contributor-search">
          Search contributors
        </label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-faint)]" aria-hidden="true" />
          <input
            id="contributor-search"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Name, reference or an answer"
            maxLength={100}
            className="h-10 w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] pl-9 pr-3 text-sm text-[var(--color-text)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          />
        </div>
        <Button type="submit" variant="secondary" loading={isPending}>
          Search
        </Button>
      </form>

      {permissions.canAcknowledge && (selected.size > 0 || unacknowledgedCount > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-bg)] px-3 py-2">
          {selectableIds.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={allPageSelected}
                onChange={(event) => setSelected(event.target.checked ? new Set(selectableIds) : new Set())}
              />
              Select shown
            </label>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {selected.size > 0 && (
              <Button size="sm" loading={isPending} onClick={() => acknowledge([...selected])}>
                <CheckCheck className="h-4 w-4" aria-hidden="true" /> Acknowledge {selected.size}
              </Button>
            )}
            {unacknowledgedCount > 0 && (
              <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setConfirmAll(true)}>
                Acknowledge all
              </Button>
            )}
          </div>
        </div>
      )}

      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <Card>
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <p className="p-4 text-sm text-[var(--color-text-muted)]">
              {search ? `Nobody matches “${search}”.` : "Nobody here yet."}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]" aria-label="Contributors">
              {rows.map((row) => (
                <ContributorRowItem
                  key={row.id}
                  row={row}
                  fields={fields}
                  selectable={permissions.canAcknowledge && !row.acknowledgedAt}
                  selected={selected.has(row.id)}
                  onToggle={(on) => toggle(row.id, on)}
                  onOpen={() => openDetail(row)}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
        <span>
          Showing {rows.length.toLocaleString()} of {total.toLocaleString()}
        </span>
        {rows.length < total && (
          <Button variant="secondary" size="sm" loading={isPending} onClick={() => load({ filter, search, append: true })}>
            Show more
          </Button>
        )}
      </div>

      <Dialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title="Acknowledge all?"
        description="Marks every payment you have not yet acknowledged as seen and recorded."
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-muted)]">
            {unacknowledgedCount.toLocaleString()} {unacknowledgedCount === 1 ? "payment" : "payments"} will be marked
            acknowledged. Payments that arrive after you opened this page are left for you to see first. This does not
            change any payment, balance or withdrawal.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmAll(false)}>
              Cancel
            </Button>
            <Button loading={isPending} onClick={acknowledgeAll}>
              Acknowledge all
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.name ?? "Contribution"}
        {...(detail ? { description: `${nairaText(detail.amountKobo)} · ${formatDate(detail.capturedAt)}` } : {})}
        className="max-w-lg"
      >
        {detail && (
          <ContributorDetail
            row={detail}
            fields={fields}
            canAcknowledge={permissions.canAcknowledge}
            canViewContact={permissions.canViewContact}
            busy={isPending}
            onAcknowledge={() => acknowledge([detail.id])}
          />
        )}
      </Dialog>

      {permissions.canExport && (
        <ExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          slug={slug}
          collectionSlug={collectionSlug}
          fields={fields}
          flags={flags}
          canViewContact={permissions.canViewContact}
          filter={filter}
          search={search}
        />
      )}
    </div>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? "rounded-full border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-fg)]"
          : "rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg)]"
      }
    >
      {label} <span className="tabular-nums opacity-80">{count.toLocaleString()}</span>
    </button>
  );
}

function ContributorRowItem({
  row,
  fields,
  selectable,
  selected,
  onToggle,
  onOpen,
}: {
  row: ContributorView;
  fields: ContributorFieldDef[];
  selectable: boolean;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}) {
  const options = describeLines(row.lines);
  // The first two answers, in the organiser's own order — enough to tell
  // people apart at a glance; the rest are one tap away.
  const answers = answerEntries(fields, row.answers).filter((entry) => !entry.removed).slice(0, 2);

  return (
    <li className="flex items-start gap-3 px-3 py-3 sm:px-4">
      <div className="w-4 pt-1">
        {selectable && (
          <input
            type="checkbox"
            className="h-4 w-4"
            aria-label={`Select ${row.name}`}
            checked={selected}
            onChange={(event) => onToggle(event.target.checked)}
          />
        )}
      </div>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-[var(--color-text)]">{row.name}</span>
            {row.isMember && <Badge tone="info">Member</Badge>}
            {row.personPayments > 1 && (
              <span className="text-xs text-[var(--color-text-muted)]">· paid {row.personPayments} times</span>
            )}
          </span>
          {(options || answers.length > 0 || row.cycleKey) && (
            <span className="truncate text-xs text-[var(--color-text-muted)]">
              {[options, row.cycleKey, ...answers.map((entry) => `${entry.label}: ${entry.value}`)]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          <span className="text-xs text-[var(--color-text-faint)]">{formatDate(row.capturedAt)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-sm font-semibold tabular-nums text-[var(--color-text)]">{nairaText(row.amountKobo)}</span>
          {row.acknowledgedAt ? <Badge tone="success">Acknowledged</Badge> : <Badge>Not acknowledged</Badge>}
        </span>
      </button>
    </li>
  );
}

function ContributorDetail({
  row,
  fields,
  canAcknowledge,
  canViewContact,
  busy,
  onAcknowledge,
}: {
  row: ContributorView;
  fields: ContributorFieldDef[];
  canAcknowledge: boolean;
  canViewContact: boolean;
  busy: boolean;
  onAcknowledge: () => void;
}) {
  const answers = answerEntries(fields, row.answers, { includeEmpty: true });
  const options = describeLines(row.lines);

  return (
    <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
      <dl className="divide-y divide-[var(--color-border)] text-sm">
        <DetailRow label="Amount" value={nairaText(row.amountKobo)} />
        {row.totalChargedKobo !== row.amountKobo && (
          <DetailRow label="Paid including fees" value={nairaText(row.totalChargedKobo)} />
        )}
        <DetailRow label="Date paid" value={new Date(row.capturedAt).toLocaleString()} />
        {options && <DetailRow label={row.lines.some((line) => line.kind === "item") ? "Items" : "Option"} value={options} />}
        {row.cycleKey && <DetailRow label="Period" value={row.cycleKey} />}
        <DetailRow label="Saved member" value={row.isMember ? `Yes${row.memberCode ? ` · ${row.memberCode}` : ""}` : "No (guest)"} />
        {row.personPayments > 1 && (
          <DetailRow
            label="From this person"
            value={`${row.personPayments} payments · ${nairaText(row.personTotalKobo)} in all`}
          />
        )}
      </dl>

      {answers.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Their answers</h3>
          <dl className="divide-y divide-[var(--color-border)] text-sm">
            {answers.map((entry) => (
              <DetailRow
                key={entry.key}
                label={entry.removed ? `${entry.label} (question removed)` : entry.label}
                value={entry.value === "" ? "—" : entry.value}
              />
            ))}
          </dl>
        </section>
      )}

      {row.attendeeNames.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Attendees</h3>
          <ul className="text-sm text-[var(--color-text)]">
            {row.attendeeNames.map((name, index) => (
              <li key={`${name}-${index}`}>{name}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Payment</h3>
        <dl className="divide-y divide-[var(--color-border)] text-sm">
          <DetailRow label="Reference" value={row.reference} mono />
          {canViewContact && row.email && <DetailRow label="Email" value={row.email} />}
          {canViewContact && row.phone && <DetailRow label="Phone" value={row.phone} />}
        </dl>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
        {row.acknowledgedAt ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            Acknowledged {row.acknowledgedByName ? `by ${row.acknowledgedByName} ` : ""}on {formatDate(row.acknowledgedAt)}
          </p>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">Not acknowledged yet</p>
        )}
        {canAcknowledge && !row.acknowledgedAt && (
          <Button size="sm" loading={busy} onClick={onAcknowledge}>
            Acknowledge
          </Button>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-2">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs text-[var(--color-text)]" : "text-right text-[var(--color-text)]"}>{value}</dd>
    </div>
  );
}

function ExportDialog({
  open,
  onClose,
  slug,
  collectionSlug,
  fields,
  flags,
  canViewContact,
  filter,
  search,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  collectionSlug: string;
  fields: ContributorFieldDef[];
  flags: { hasOptions: boolean; isEvent: boolean; isRecurring: boolean; isManaged: boolean };
  canViewContact: boolean;
  filter: Filter;
  search: string;
}) {
  const available = useMemo(
    () =>
      contributorExportFields({ fields, ...flags }).filter((field) => !field.sensitive || canViewContact),
    [fields, flags, canViewContact],
  );
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(defaultContributorExportKeys(available)));
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const byGroup = useMemo(() => {
    const map = new Map<string, ContributorExportField[]>();
    for (const field of available) map.set(field.group, [...(map.get(field.group) ?? []), field]);
    return map;
  }, [available]);

  function toggle(key: string, on: boolean): void {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  const scope = [
    filter === "acknowledged" ? "acknowledged only" : filter === "unacknowledged" ? "not acknowledged only" : "everyone",
    search ? `matching “${search}”` : null,
  ]
    .filter(Boolean)
    .join(", ");

  function download(): void {
    setMessage(null);
    startTransition(async () => {
      // Sent in the order the list shows them, so the file's columns follow it.
      const keys = available.map((field) => field.key).filter((key) => chosen.has(key));
      const result = await exportContributorsAction(slug, collectionSlug, { fieldKeys: keys, filter, search });
      if (result.error || !result.filename) {
        setMessage({ tone: "danger", text: result.error ?? "The export could not be produced." });
        return;
      }
      const blob = new Blob([result.csv ?? ""], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage({
        tone: "success",
        text:
          result.rowCount === 0
            ? "Nobody matched, so the file has its headings and no rows."
            : `Exported ${result.rowCount} ${result.rowCount === 1 ? "contribution" : "contributions"}.`,
      });
    });
  }

  const sensitiveChosen = available.some((field) => field.sensitive && chosen.has(field.key));

  return (
    <Dialog open={open} onClose={onClose} title="Export contributors" description={`CSV · ${scope}`} className="max-w-lg">
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
        <div className="flex gap-3 text-xs">
          <button
            type="button"
            className="font-medium text-[var(--color-primary)] hover:underline"
            onClick={() => setChosen(new Set(available.map((field) => field.key)))}
          >
            Select all
          </button>
          <button
            type="button"
            className="font-medium text-[var(--color-primary)] hover:underline"
            onClick={() => setChosen(new Set())}
          >
            Clear all
          </button>
        </div>

        {CONTRIBUTOR_EXPORT_GROUP_ORDER.filter((group) => (byGroup.get(group) ?? []).length > 0).map((group) => (
          <fieldset key={group} className="flex flex-col gap-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              {group === "Questions" ? "Your questions" : group}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(byGroup.get(group) ?? []).map((field) => (
                <label key={field.key} className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={chosen.has(field.key)}
                    onChange={(event) => toggle(field.key, event.target.checked)}
                  />
                  {field.label}
                </label>
              ))}
            </div>
          </fieldset>
        ))}

        {sensitiveChosen && (
          <Banner tone="info">This file will contain email addresses or phone numbers. Keep it somewhere private.</Banner>
        )}
        {message && <Banner tone={message.tone}>{message.text}</Banner>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button loading={isPending} disabled={chosen.size === 0} onClick={download}>
            <Download className="h-4 w-4" aria-hidden="true" /> Download CSV
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
