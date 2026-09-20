"use client";

import { Button, TextField } from "@kolekto/ui";
import { Plus, Trash2 } from "lucide-react";

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
  quantityLimit?: string;
}

export function emptyTier(): TierDraft {
  return { name: "", description: "", price: "", quantityLimit: "" };
}

export function TiersEditor({
  tiers,
  onChange,
  disabled = false,
}: {
  tiers: TierDraft[];
  onChange: (tiers: TierDraft[]) => void;
  disabled?: boolean;
}) {
  function update(index: number, patch: Partial<TierDraft>): void {
    onChange(tiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  }

  const duplicateNames = new Set(
    tiers
      .map((tier) => tier.name.trim().toLowerCase())
      .filter((name, index, all) => name !== "" && all.indexOf(name) !== index),
  );

  return (
    <div className="flex flex-col gap-4">
      {tiers.map((tier, index) => {
        const isDuplicate = duplicateNames.has(tier.name.trim().toLowerCase());
        return (
          <div
            key={tier.id ?? index}
            className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Option name"
                value={tier.name}
                disabled={disabled}
                required
                {...(isDuplicate ? { error: "Two options cannot share a name" } : {})}
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
                hint="Optional. What this option includes."
                value={tier.description ?? ""}
                disabled={disabled}
                onChange={(event) => update(index, { description: event.target.value })}
              />
              <TextField
                label="Limit"
                hint="Optional. How many of this option are available."
                inputMode="numeric"
                value={tier.quantityLimit ?? ""}
                disabled={disabled}
                onChange={(event) => update(index, { quantityLimit: event.target.value })}
              />
            </div>
            {tiers.length > 1 && !disabled && (
              <button
                type="button"
                className="self-start text-xs font-medium text-[var(--color-danger)] hover:underline"
                onClick={() => onChange(tiers.filter((_, i) => i !== index))}
              >
                <Trash2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                Remove option
              </button>
            )}
          </div>
        );
      })}

      {!disabled && (
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...tiers, emptyTier()])}>
          <Plus className="h-4 w-4" aria-hidden="true" /> Add another option
        </Button>
      )}
    </div>
  );
}
