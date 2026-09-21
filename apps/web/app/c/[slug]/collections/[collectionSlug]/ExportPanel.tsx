"use client";

import type { CollectionCycleRow, CollectionTier, MemberGroup } from "@kolekto/db";
import { Banner, Button, Card, CardBody, SelectField, TextField } from "@kolekto/ui";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { exportCollectionAction } from "./export-actions.ts";
import {
  DEFAULT_FIELDS,
  EXPORT_FIELD_GROUP_ORDER,
  EXPORT_FIELDS,
  EXPORT_SUBJECTS,
  SUBJECT_LOCKS,
  type ExportFieldChoice,
  type ExportFieldGroup,
  type ExportFilters,
  type ExportFormat,
  type ExportSubjectKey,
} from "./export-fields.ts";

/**
 * The export builder (M7.6 parts E and F).
 *
 * Three questions in the order a person asks them: what am I exporting, who
 * is in it, and what do I want to know about them. Then a format — a
 * spreadsheet to work with, or a document to print and carry.
 *
 * Only what this collection can answer is offered. A fixed-amount collection
 * has no options, so there is no Option column and no option filter; a
 * collection with no event has no door, so there is no attendance anything.
 * An empty control is a question the organiser has to work out the answer to.
 *
 * The file is built on the server. The browser receives a finished file and
 * saves it, so a large roll is never assembled in page memory (part AD).
 */
export function ExportPanel({
  slug,
  collectionSlug,
  customFields,
  groups,
  tiers,
  cycles,
  isEvent,
  isTiered,
  isRecurring,
  canExport,
}: {
  slug: string;
  collectionSlug: string;
  customFields: ExportFieldChoice[];
  groups: MemberGroup[];
  tiers: CollectionTier[];
  cycles: CollectionCycleRow[];
  isEvent: boolean;
  isTiered: boolean;
  isRecurring: boolean;
  canExport: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);

  const subjects = EXPORT_SUBJECTS.filter((option) => option.needs !== "event" || isEvent);
  const [subject, setSubject] = useState<ExportSubjectKey>("roll");

  const [status, setStatus] = useState<ExportFilters["status"]>("all");
  const [groupId, setGroupId] = useState("");
  const [tierId, setTierId] = useState("");
  const [cycleKey, setCycleKey] = useState("");
  const [attendance, setAttendance] = useState<NonNullable<ExportFilters["attendance"]>>("all");
  const [assignedFrom, setAssignedFrom] = useState("");
  const [assignedTo, setAssignedTo] = useState("");

  const available = useMemo(() => {
    const fixed = EXPORT_FIELDS.filter((field) => {
      if (field.needs === "event") return isEvent;
      if (field.needs === "tiers") return isTiered;
      if (field.needs === "recurring") return isRecurring;
      return true;
    });
    return [...fixed, ...customFields];
  }, [customFields, isEvent, isRecurring, isTiered]);

  const [chosen, setChosen] = useState<Set<string>>(new Set(DEFAULT_FIELDS.roll));

  const byGroup = useMemo(() => {
    const map = new Map<ExportFieldGroup, ExportFieldChoice[]>();
    for (const field of available) {
      map.set(field.group, [...(map.get(field.group) ?? []), field]);
    }
    return map;
  }, [available]);

  const locks = SUBJECT_LOCKS[subject];

  function chooseSubject(next: ExportSubjectKey): void {
    setSubject(next);
    // The defaults for the new subject, minus any column this collection
    // cannot answer — a guest list on a collection without options should not
    // arrive with an empty Option column ticked.
    const keys = new Set(available.map((field) => field.key));
    setChosen(new Set(DEFAULT_FIELDS[next].filter((key) => keys.has(key))));
  }

  function toggle(key: string, on: boolean): void {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  if (!canExport) {
    return (
      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Export</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Exporting member details needs the member-export permission. An owner, admin or treasurer can do it.
          </p>
        </CardBody>
      </Card>
    );
  }

  function download(format: ExportFormat): void {
    setMessage(null);
    startTransition(async () => {
      const result = await exportCollectionAction(slug, collectionSlug, {
        subject,
        format,
        fieldKeys: [...chosen],
        filters: {
          status: locks.status ? "all" : status,
          ...(groupId ? { groupId } : {}),
          ...(tierId ? { tierId } : {}),
          ...(cycleKey ? { cycleKey } : {}),
          ...(isEvent && !locks.attendance ? { attendance } : {}),
          ...(assignedFrom ? { assignedFrom } : {}),
          ...(assignedTo ? { assignedTo } : {}),
        },
      });

      if (result.error || !result.filename) {
        setMessage({ tone: "danger", text: result.error ?? "The export could not be produced." });
        return;
      }

      // The server produced the file; this only hands it to the browser.
      const blob =
        format === "csv"
          ? new Blob([result.csv ?? ""], { type: "text/csv;charset=utf-8" })
          : new Blob([Uint8Array.from(atob(result.pdfBase64 ?? ""), (character) => character.charCodeAt(0))], {
              type: "application/pdf",
            });

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
            : `Exported ${result.rowCount} ${result.rowCount === 1 ? "person" : "people"} as ${format.toUpperCase()}.`,
      });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">What do you want to export?</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              Every report below is built from this collection&apos;s own roll — who it asks, and what each person was
              asked for.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {subjects.map((option) => (
              <label
                key={option.key}
                className={
                  subject === option.key
                    ? "flex cursor-pointer gap-3 rounded-[var(--radius-md)] border-2 border-[var(--color-primary)] p-3"
                    : "flex cursor-pointer gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 hover:border-[var(--color-border-strong)]"
                }
              >
                <input
                  type="radio"
                  name="export-subject"
                  className="mt-0.5 h-4 w-4"
                  checked={subject === option.key}
                  onChange={() => chooseSubject(option.key)}
                />
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-[var(--color-text)]">{option.label}</span>
                  <span className="text-xs text-[var(--color-text-muted)]">{option.description}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Part AI, said out loud rather than left to be discovered: the
              things a host might expect to find here and will not. */}
          <p className="rounded-[var(--radius-md)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
            There is no contributions or payments report yet. Online payment is not switched on, so nothing has been
            received against any collection, and a file of empty amount columns would read as though nobody had paid.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Who to include</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            {!locks.status && (
              <SelectField
                label="Status"
                value={status}
                onChange={(event) => setStatus(event.target.value as ExportFilters["status"])}
              >
                <option value="all">Everyone on this collection</option>
                <option value="expected">Still expected to pay</option>
                <option value="exempt">Exempted by an officer</option>
                <option value="cancelled">Cancelled</option>
              </SelectField>
            )}

            {groups.length > 0 && (
              <SelectField label="Group" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                <option value="">Every group</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </SelectField>
            )}

            {isTiered && tiers.length > 0 && (
              <SelectField label="Option" value={tierId} onChange={(event) => setTierId(event.target.value)}>
                <option value="">Every option</option>
                {tiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.name}
                  </option>
                ))}
              </SelectField>
            )}

            {isRecurring && cycles.length > 0 && (
              <SelectField label="Period" value={cycleKey} onChange={(event) => setCycleKey(event.target.value)}>
                <option value="">Every period</option>
                {cycles.map((cycle) => (
                  <option key={cycle.cycle_key} value={cycle.cycle_key}>
                    {cycle.cycle_key}
                  </option>
                ))}
              </SelectField>
            )}

            {isEvent && !locks.attendance && (
              <SelectField
                label="At the door"
                value={attendance}
                onChange={(event) => setAttendance(event.target.value as NonNullable<ExportFilters["attendance"]>)}
              >
                <option value="all">However they arrived, or did not</option>
                <option value="inside">Inside now</option>
                <option value="left">Checked in and left</option>
                <option value="absent">Not arrived</option>
              </SelectField>
            )}

            <TextField
              label="Added to the roll from"
              type="date"
              value={assignedFrom}
              onChange={(event) => setAssignedFrom(event.target.value)}
            />
            <TextField
              label="Added to the roll up to"
              type="date"
              value={assignedTo}
              onChange={(event) => setAssignedTo(event.target.value)}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-text)]">What to include about them</h2>
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
          </div>

          {EXPORT_FIELD_GROUP_ORDER.filter((group) => (byGroup.get(group) ?? []).length > 0).map((group) => (
            <fieldset key={group} className="flex flex-col gap-2">
              <legend className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                {group}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(byGroup.get(group) ?? []).map((field) => (
                  <label key={field.key} className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                      checked={chosen.has(field.key)}
                      onChange={(event) => toggle(field.key, event.target.checked)}
                    />
                    {field.label}
                    {field.sensitive && (
                      <span className="text-xs text-[var(--color-text-muted)]">· personal</span>
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}

          {customFields.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">
              Your community&apos;s own member fields appear here once you add them under Members → Member profile.
            </p>
          )}

          {[...chosen].some((key) => available.find((field) => field.key === key)?.sensitive) && (
            <Banner tone="info">
              This export will contain phone numbers or email addresses. Keep the file where the rest of your member
              list is kept.
            </Banner>
          )}
        </CardBody>
      </Card>

      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={isPending} disabled={chosen.size === 0} onClick={() => download("csv")}>
          <FileSpreadsheet className="h-4 w-4" aria-hidden="true" /> Download CSV
        </Button>
        <Button variant="secondary" loading={isPending} disabled={chosen.size === 0} onClick={() => download("pdf")}>
          <FileText className="h-4 w-4" aria-hidden="true" /> Download PDF
        </Button>
        <p className="w-full text-xs text-[var(--color-text-muted)]">
          <Download className="mr-1 inline h-3 w-3" aria-hidden="true" />
          CSV opens in Excel, Numbers or Google Sheets. PDF is laid out to print.
        </p>
      </div>
    </div>
  );
}
