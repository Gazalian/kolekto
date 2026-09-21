"use client";

import type { MemberGroup } from "@kolekto/db";
import { Banner, Button, Card, CardBody, SelectField } from "@kolekto/ui";
import { Download } from "lucide-react";
import { useState, useTransition } from "react";
import { exportCollectionPeopleAction } from "./export-actions.ts";
import type { ExportFieldChoice, ExportFilters } from "./export-fields.ts";

/**
 * Export the people this collection is asking (M7.5 part D).
 *
 * Deliberately a builder rather than a "download everything" button: an
 * organiser exporting for the caterer wants names and dietary answers, and
 * one exporting for the treasurer wants amounts. Both are two ticks apart.
 *
 * Columns for money received and payment status are absent, not empty —
 * nothing records a payment in this phase, and an empty "Paid" column in a
 * spreadsheet reads as "nobody paid" rather than "this does not exist yet".
 *
 * The file is built on the server. The browser receives finished text and
 * saves it, so a large roll is never assembled in page memory.
 */
export function ExportPanel({
  slug,
  collectionSlug,
  fixedFields,
  customFields,
  groups,
  canExport,
}: {
  slug: string;
  collectionSlug: string;
  fixedFields: ExportFieldChoice[];
  customFields: ExportFieldChoice[];
  groups: MemberGroup[];
  canExport: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [status, setStatus] = useState<ExportFilters["status"]>("all");
  const [groupId, setGroupId] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(
    new Set(["full_name", "member_code", "phone", "email", "expected_amount", "obligation_status"]),
  );

  const all = [...fixedFields, ...customFields];

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

  function download(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await exportCollectionPeopleAction(slug, collectionSlug, [...chosen], {
        status,
        ...(groupId ? { groupId } : {}),
      });

      if (result.error || !result.csv || !result.filename) {
        setMessage({ tone: "danger", text: result.error ?? "The export could not be produced." });
        return;
      }

      // The server produced the file; this only hands it to the browser.
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
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
            ? "Nobody is on this collection yet, so the file has its headings and no rows."
            : `Exported ${result.rowCount} ${result.rowCount === 1 ? "person" : "people"}.`,
      });
    });
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Export</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Choose who to include and what to include about them. Downloads as a CSV that opens in Excel, Numbers or
            Google Sheets.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Who to include"
            value={status}
            onChange={(event) => setStatus(event.target.value as ExportFilters["status"])}
          >
            <option value="all">Everyone on this collection</option>
            <option value="expected">Only those still expected to pay</option>
            <option value="exempt">Only those an officer exempted</option>
          </SelectField>

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
        </div>

        <fieldset className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <legend className="text-sm font-medium text-[var(--color-text)]">What to include</legend>
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                className="font-medium text-[var(--color-primary)] hover:underline"
                onClick={() => setChosen(new Set(all.map((field) => field.key)))}
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

          <div className="grid gap-2 sm:grid-cols-2">
            {all.map((field) => (
              <label key={field.key} className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                  checked={chosen.has(field.key)}
                  onChange={(event) => toggle(field.key, event.target.checked)}
                />
                {field.label}
              </label>
            ))}
          </div>

          {customFields.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">
              Your community&apos;s own member fields appear here once you add them under Members → Member profile.
            </p>
          )}
        </fieldset>

        {message && <Banner tone={message.tone}>{message.text}</Banner>}

        <Button variant="secondary" loading={isPending} disabled={chosen.size === 0} onClick={download}>
          <Download className="h-4 w-4" aria-hidden="true" /> Download CSV
        </Button>
      </CardBody>
    </Card>
  );
}
