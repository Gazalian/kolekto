"use client";

import { Button, TextField } from "@kolekto/ui";
import { normalisePrefix } from "@kolekto/domain";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

/**
 * The options a tiered collection offers.
 *
 * `id` is carried through every edit and is what the server matches on. A name
 * is a label: two options may not share one (the database refuses it), but the
 * name is never what identifies the row (ADR 0010).
 */
export interface TierDraft {
  id?: string | undefined;
  name: string;
  description?: string;
  price: string;
  /** How many of this option exist in total. */
  quantityLimit?: string;
  /**
   * How many of this option one person may take in a single order.
   *
   * M7.7: the column, the write function and the server-side check have all
   * existed since the first migration — `resolveContribution` refuses an
   * order that exceeds it (packages/domain/src/contribution.ts) — and nothing
   * in the UI could ever set it. This is the control, not a new rule.
   */
  perOrderLimit?: string;
  /** M7.6 part K: this option's own reference series. "VIP" makes VIP-0001, VIP-0002. */
  codePrefix?: string;
}

export function emptyTier(): TierDraft {
  return { name: "", description: "", price: "", quantityLimit: "", perOrderLimit: "", codePrefix: "" };
}

/**
 * What this editor calls the rows it is editing (M7.7 §22).
 *
 * One editor, three vocabularies. An organiser selling tickets should read
 * "Ticket name" and "Add another ticket type", not "Option name" — but the
 * rows are the same `collection_tiers` rows underneath, saved by the same
 * function, and nothing about the data model changes with the word. Settings
 * keeps the neutral "option", which is right for a screen that does not know
 * what it is looking at.
 */
export type TierVocabulary = "option" | "package" | "ticket";

interface TierWords {
  one: string;
  add: string;
  remove: string;
  limitHint: string;
  perOrder: string;
  perOrderHint: string;
  prefixExample: string;
}

const WORDS: Record<TierVocabulary, TierWords> = {
  option: {
    one: "Option",
    add: "Add another option",
    remove: "Remove option",
    limitHint: "Optional. How many of this option are available.",
    perOrder: "Most one person may take",
    perOrderHint: "Optional. Leave empty for no limit per person.",
    prefixExample: "VIP",
  },
  package: {
    one: "Package",
    add: "Add another package",
    remove: "Remove package",
    limitHint: "Optional. How many of this package are available — leave empty for no limit.",
    perOrder: "Most one person may take",
    perOrderHint: "Optional. Leave empty for no limit per person.",
    prefixExample: "GOLD",
  },
  ticket: {
    one: "Ticket type",
    add: "Add another ticket type",
    remove: "Remove ticket type",
    limitHint: "How many of this ticket exist. Leave empty for unlimited.",
    perOrder: "Most one person may buy",
    perOrderHint: "Optional. One buyer can take several tickets — this caps how many of THIS type in one order.",
    prefixExample: "VIP",
  },
};

export function TiersEditor({
  tiers,
  onChange,
  disabled = false,
  vocabulary = "option",
}: {
  tiers: TierDraft[];
  onChange: (tiers: TierDraft[]) => void;
  disabled?: boolean;
  vocabulary?: TierVocabulary;
}) {
  const words = WORDS[vocabulary];
  const lower = words.one.toLowerCase();

  function update(index: number, patch: Partial<TierDraft>): void {
    onChange(tiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  }

  /**
   * Moves one option up or down the list. Order is what the contributor sees
   * on the public page, and it is saved as `sortOrder` from this array's own
   * positions — so swapping two entries here is the whole change. The rows
   * carry their ids with them, so reordering renames nothing and re-creates
   * nothing (ADR 0010).
   */
  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= tiers.length) return;
    const next = [...tiers];
    const moved = next[index]!;
    next[index] = next[target]!;
    next[target] = moved;
    onChange(next);
  }

  // Two options sharing a prefix would merge two series that exist precisely
  // to be separate, so it is flagged here as well as refused by the database.
  const duplicatePrefixes = new Set(
    tiers
      .map((tier) => (tier.codePrefix ?? "").trim().toUpperCase())
      .filter((prefix, index, all) => prefix !== "" && all.indexOf(prefix) !== index),
  );

  const duplicateNames = new Set(
    tiers
      .map((tier) => tier.name.trim().toLowerCase())
      .filter((name, index, all) => name !== "" && all.indexOf(name) !== index),
  );

  return (
    <div className="flex flex-col gap-4">
      {tiers.map((tier, index) => {
        const isDuplicate = duplicateNames.has(tier.name.trim().toLowerCase());
        const isDuplicatePrefix = duplicatePrefixes.has((tier.codePrefix ?? "").trim().toUpperCase());
        return (
          <div
            key={tier.id ?? index}
            className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
          >
            {tiers.length > 1 && !disabled && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--color-text-muted)]">
                  {words.one} {index + 1}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label={`Move ${tier.name || `row ${index + 1}`} up`}
                    disabled={index === 0}
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border)] p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40"
                    onClick={() => move(index, -1)}
                  >
                    <ChevronUp className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${tier.name || `row ${index + 1}`} down`}
                    disabled={index === tiers.length - 1}
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border)] p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40"
                    onClick={() => move(index, 1)}
                  >
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={`${words.one} name`}
                value={tier.name}
                disabled={disabled}
                required
                {...(isDuplicate ? { error: `Two ${lower}s cannot share a name` } : {})}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <TextField
                label="Price"
                value={tier.price}
                disabled={disabled}
                required
                placeholder="e.g. 20000"
                onChange={(event) => update(index, { price: event.target.value })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Description"
                hint={`Optional. What this ${lower} includes.`}
                value={tier.description ?? ""}
                disabled={disabled}
                onChange={(event) => update(index, { description: event.target.value })}
              />
              <TextField
                label={vocabulary === "ticket" ? "How many exist" : "Limit"}
                hint={words.limitHint}
                inputMode="numeric"
                value={tier.quantityLimit ?? ""}
                disabled={disabled}
                onChange={(event) => update(index, { quantityLimit: event.target.value })}
              />
            </div>
            {/*
              M7.9 §2D / QA Finding 2: a package is a single, exclusive choice
              — the public page renders it as one radio group, never a basket
              a contributor adds several of the same package to (confirmed
              against the legacy contribute flow, which never offered package
              quantities either — only tickets did). A per-order limit on a
              package can therefore never be exceeded or have any visible
              effect, so the control that configures it is not offered here.
              Tickets and the neutral Settings view keep it: both allow taking
              more than one of a kind.
            */}
            {vocabulary !== "package" && (
              <TextField
                label={words.perOrder}
                hint={words.perOrderHint}
                inputMode="numeric"
                value={tier.perOrderLimit ?? ""}
                disabled={disabled}
                onChange={(event) => update(index, { perOrderLimit: event.target.value })}
              />
            )}
            <TextField
              label="Reference prefix"
              hint={
                tier.codePrefix
                  ? `References for this ${lower} read ${tier.codePrefix.toUpperCase()}-0001, ${tier.codePrefix.toUpperCase()}-0002 — its own series.`
                  : `Optional. Give this ${lower} its own series, e.g. ${words.prefixExample}. Without one it shares the collection's.`
              }
              value={tier.codePrefix ?? ""}
              disabled={disabled}
              {...(isDuplicatePrefix ? { error: `Two ${lower}s cannot share a prefix` } : {})}
              onChange={(event) => update(index, { codePrefix: normalisePrefix(event.target.value, { maxLength: 8 }) })}
            />
            {tiers.length > 1 && !disabled && (
              <button
                type="button"
                className="self-start text-xs font-medium text-[var(--color-danger)] hover:underline"
                onClick={() => onChange(tiers.filter((_, i) => i !== index))}
              >
                <Trash2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                {words.remove}
              </button>
            )}
          </div>
        );
      })}

      {!disabled && (
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...tiers, emptyTier()])}>
          <Plus className="h-4 w-4" aria-hidden="true" /> {words.add}
        </Button>
      )}
    </div>
  );
}
