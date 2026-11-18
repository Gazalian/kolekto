"use client";

import { Badge, Banner, Button, Card, CardBody, Dialog } from "@kolekto/ui";
import { Download, Search } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { formatDate } from "../../../../../lib/collection-display.ts";
import {
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

/**
 * The register's server filter. Acknowledging a payment is no longer part of
 * the workflow (a verified payment is successful without it), so only "all".
 */
type Filter = "all";

/**
 * The contributor register (design §2.3–2.6).
 *
 * A list of people who have successfully paid — not a transaction log. Failed
 * and pending attempts never reach it. The default row carries only what an
 * organiser reads at a glance: who, how much, what they chose, the first
 * answers, when, and that it succeeded. Everything else is in
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
  flags,
  permissions,
}: {
  slug: string;
  collectionSlug: string;
  fields: ContributorFieldDef[];
  firstPage: ContributorView[];
  firstTotal: number;
  counts: { contributions: number };
  flags: { hasOptions: boolean; isEvent: boolean; isRecurring: boolean; isManaged: boolean };
  permissions: { canExport: boolean; canViewContact: boolean };
}) {
  const [rows, setRows] = useState<ContributorView[]>(firstPage);
  const [total, setTotal] = useState(firstTotal);
  const filter: Filter = "all";
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<{ tone: "danger" | "success" | "info"; text: string } | null>(null);
  const [detail, setDetail] = useState<ContributorView | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

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
    });
  }

  function submitSearch(): void {
    const trimmed = searchInput.trim();
    setSearch(trimmed);
    load({ filter, search: trimmed, append: false });
  }

  function openDetail(row: ContributorView): void {
    setDetail(row);
    startTransition(async () => {
      const result = await contributorDetailAction(slug, collectionSlug, row.id);
      if (result.row) setDetail(result.row);
    });
  }

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
        <p className="text-sm text-[var(--color-text-muted)]">
          <span className="font-semibold tabular-nums text-[var(--color-text)]">{counts.contributions.toLocaleString()}</span>{" "}
          successful {counts.contributions === 1 ? "payment" : "payments"}, each counted the moment the payment provider
          confirms it.
        </p>
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
            canViewContact={permissions.canViewContact}
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

function ContributorRowItem({
  row,
  fields,
  onOpen,
}: {
  row: ContributorView;
  fields: ContributorFieldDef[];
  onOpen: () => void;
}) {
  const options = describeLines(row.lines);
  // The first two answers, in the organiser's own order — enough to tell
  // people apart at a glance; the rest are one tap away.
  const answers = answerEntries(fields, row.answers).filter((entry) => !entry.removed).slice(0, 2);

  return (
    <li className="flex items-start gap-3 px-3 py-3 sm:px-4">
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
          <Badge tone="success">Successful</Badge>
        </span>
      </button>
    </li>
  );
}

function ContributorDetail({
  row,
  fields,
  canViewContact,
}: {
  row: ContributorView;
  fields: ContributorFieldDef[];
  canViewContact: boolean;
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

      <p className="border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
        Successful: confirmed by the payment provider and recorded by Kolekto. Fees and when the money can be withdrawn
        are in the Activity tab.
      </p>
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
    "everyone",
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
