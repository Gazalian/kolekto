"use client";

import type { Collection, CollectionCodeSettings, CollectionTier } from "@kolekto/db";
import { Banner, Button, Card, CardBody, SelectField, TextField } from "@kolekto/ui";
import { normalisePrefix, referenceExample, type ReferenceSeparator } from "@kolekto/domain";
import { useState, useTransition } from "react";
import { issueAllReferencesAction, saveCodeSettingsAction } from "./code-actions.ts";

/**
 * Contributor references, configured (M7.6 parts I and N).
 *
 * The example under the fields is the whole point of this screen. "Digits: 4"
 * means nothing on its own; "BIO26-0001" is immediately either right or
 * wrong, and an organiser can tell which without saving anything. It is
 * computed by the same rule the database issues by (@kolekto/domain's
 * formatReference mirrors app.build_contributor_reference, and both are
 * pinned to the same test vectors).
 *
 * What cannot be changed, and why: once a reference has been issued, the
 * format is fixed. Those codes are printed on receipts and read out at doors,
 * and a collection whose first fifty references say BIO26-0001 and whose next
 * fifty say DIN-0051 has no reference system at all. The database refuses it;
 * this screen explains it before the organiser gets there.
 */
export function CodeSettingsPanel({
  slug,
  collection,
  settings,
  tiers,
  issuedCount,
  rollCount,
  canConfigure,
  canIssue,
}: {
  slug: string;
  collection: Collection;
  settings: CollectionCodeSettings | null;
  tiers: CollectionTier[];
  issuedCount: number;
  rollCount: number;
  canConfigure: boolean;
  canIssue: boolean;
}) {
  const [enabled, setEnabled] = useState(collection.codes_enabled);
  const [prefix, setPrefix] = useState(settings?.prefix ?? "");
  const [separator, setSeparator] = useState<ReferenceSeparator>((settings?.separator ?? "-") as ReferenceSeparator);
  const [digits, setDigits] = useState(String(settings?.digits ?? 4));
  const [startNumber, setStartNumber] = useState(String(settings?.start_number ?? 1));
  const [style, setStyle] = useState<"sequential" | "random">(settings?.style ?? "sequential");

  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const locked = issuedCount > 0;
  const example =
    style === "random"
      ? prefix
        ? `${prefix}${separator}K7M2QX`
        : ""
      : referenceExample({ prefix, separator, digits: Number(digits) || 4 }, Number(startNumber) || 1);

  const prefixedTiers = tiers.filter((tier) => tier.code_prefix);
  const waiting = Math.max(rollCount - issuedCount, 0);

  function save(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await saveCodeSettingsAction(slug, collection.slug, {
        collectionId: collection.id,
        enabled,
        prefix: prefix || null,
        separator,
        digits: Number(digits) || 4,
        startNumber: Number(startNumber) || 1,
        style,
      });
      setMessage(
        result.error
          ? { tone: "danger", text: result.error }
          : { tone: "success", text: "Saved." },
      );
    });
  }

  function issueAll(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await issueAllReferencesAction(slug, collection.slug, collection.id);
      setMessage(
        result.error
          ? { tone: "danger", text: result.error }
          : {
              tone: "success",
              text:
                result.issued === 0
                  ? "Everyone on the roll already has a reference."
                  : `Issued ${result.issued} reference${result.issued === 1 ? "" : "s"}.`,
            },
      );
    });
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Contributor reference</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            A short code for each person on this collection — the thing you write on a receipt, read out at a door, and
            search for when somebody rings up about their payment. It is not their member ID, which follows them across
            every collection you ever run.
          </p>
        </div>

        <label className="flex items-start gap-2 text-sm text-[var(--color-text)]">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-[var(--color-border-strong)]"
            checked={enabled}
            disabled={!canConfigure}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            Give everyone on this collection a reference
            <span className="block text-xs text-[var(--color-text-muted)]">
              Issued automatically as you add people to the roll.
            </span>
          </span>
        </label>

        {enabled && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Prefix"
                value={prefix}
                disabled={!canConfigure || locked}
                onChange={(event) => setPrefix(normalisePrefix(event.target.value))}
                hint="2 to 10 letters or digits, e.g. BIO26"
              />
              <SelectField
                label="Separator"
                value={separator}
                disabled={!canConfigure || locked}
                onChange={(event) => setSeparator(event.target.value as ReferenceSeparator)}
              >
                <option value="-">Hyphen — BIO26-0001</option>
                <option value="/">Slash — BIO26/0001</option>
                <option value=".">Dot — BIO26.0001</option>
                <option value="">None — BIO260001</option>
              </SelectField>
              <SelectField
                label="Style"
                value={style}
                disabled={!canConfigure || locked}
                onChange={(event) => setStyle(event.target.value as "sequential" | "random")}
              >
                <option value="sequential">Counting up — 0001, 0002, 0003</option>
                <option value="random">Random — harder to guess</option>
              </SelectField>
              {style === "sequential" && (
                <>
                  <TextField
                    label="Number of digits"
                    type="number"
                    min={1}
                    max={8}
                    value={digits}
                    disabled={!canConfigure || locked}
                    onChange={(event) => setDigits(event.target.value)}
                  />
                  <TextField
                    label="Starting number"
                    type="number"
                    min={1}
                    value={startNumber}
                    disabled={!canConfigure || locked}
                    onChange={(event) => setStartNumber(event.target.value)}
                    hint="Continuing a paper series from last year? Start where it stopped."
                  />
                </>
              )}
            </div>

            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
              <p className="text-xs text-[var(--color-text-muted)]">Example</p>
              <p className="font-mono text-base font-medium text-[var(--color-text)]">
                {example || "Choose a prefix to see what a reference will look like"}
              </p>
            </div>

            {prefixedTiers.length > 0 && (
              <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2">
                <p className="text-xs font-medium text-[var(--color-text)]">Options with their own prefix</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Each of these counts separately, so the first VIP and the first Regular are both number one.
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 text-sm text-[var(--color-text-muted)]">
                  {prefixedTiers.map((tier) => (
                    <li key={tier.id}>
                      {tier.name} —{" "}
                      <span className="font-mono text-[var(--color-text)]">
                        {referenceExample(
                          { prefix: tier.code_prefix!, separator, digits: Number(digits) || 4 },
                          1,
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Set an option&apos;s prefix where you edit the options, under Settings.
                </p>
              </div>
            )}

            {locked && (
              <Banner tone="info">
                {issuedCount} reference{issuedCount === 1 ? " has" : "s have"} been issued, so the format is fixed —
                they may already be printed on tickets or receipts. You can still switch references off, which only
                stops new ones being issued.
              </Banner>
            )}
          </>
        )}

        {message && <Banner tone={message.tone}>{message.text}</Banner>}

        <div className="flex flex-wrap gap-2">
          {canConfigure && (
            <Button loading={isPending} onClick={save}>
              Save
            </Button>
          )}
          {canIssue && enabled && waiting > 0 && (
            <Button variant="secondary" loading={isPending} onClick={issueAll}>
              Issue {waiting} missing reference{waiting === 1 ? "" : "s"}
            </Button>
          )}
        </div>

        {!canConfigure && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Changing the reference format is an owner or admin decision.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
