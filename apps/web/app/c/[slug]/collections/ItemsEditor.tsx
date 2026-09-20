"use client";

import { Button, TextField } from "@kolekto/ui";
import { Plus, Trash2 } from "lucide-react";

/**
 * What an item-based collection sells (§31).
 *
 * The same contract as TiersEditor, for the same reason: `id` is carried
 * through every edit and is what the server matches on, so renaming "Blue" to
 * "Royal Blue" keeps whatever already pointed at that item. A name is a label
 * (ADR 0010).
 *
 * Distinct from an option on a tiered collection in what it carries: stock, and
 * how many one person may take. An aso-ebi order has 40 yards of the blue.
 */
export interface ItemDraft {
  id?: string | undefined;
  name: string;
  description?: string;
  price: string;
  quantityAvailable?: string;
  maxPerOrder?: string;
}

export function emptyItem(): ItemDraft {
  return { name: "", description: "", price: "", quantityAvailable: "", maxPerOrder: "" };
}

export function ItemsEditor({
  items,
  onChange,
  disabled = false,
}: {
  items: ItemDraft[];
  onChange: (items: ItemDraft[]) => void;
  disabled?: boolean;
}) {
  function update(index: number, patch: Partial<ItemDraft>): void {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  const duplicateNames = new Set(
    items
      .map((item) => item.name.trim().toLowerCase())
      .filter((name, index, all) => name !== "" && all.indexOf(name) !== index),
  );

  return (
    <div className="flex flex-col gap-4">
      {items.map((item, index) => {
        const isDuplicate = duplicateNames.has(item.name.trim().toLowerCase());
        return (
          <div
            key={item.id ?? index}
            className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Item"
                placeholder="e.g. Aso-ebi (blue)"
                value={item.name}
                disabled={disabled}
                required
                {...(isDuplicate ? { error: "Two items cannot share a name" } : {})}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <TextField
                label="Price"
                placeholder="e.g. 35000"
                hint="In naira, per item."
                value={item.price}
                disabled={disabled}
                required
                onChange={(event) => update(index, { price: event.target.value })}
              />
            </div>
            <TextField
              label="Description"
              hint="Optional. What the item is, or what it includes."
              value={item.description ?? ""}
              disabled={disabled}
              onChange={(event) => update(index, { description: event.target.value })}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="How many are available"
                hint="Optional. Leave empty if there is no limit."
                inputMode="numeric"
                value={item.quantityAvailable ?? ""}
                disabled={disabled}
                onChange={(event) => update(index, { quantityAvailable: event.target.value })}
              />
              <TextField
                label="Most one person may take"
                hint="Optional."
                inputMode="numeric"
                value={item.maxPerOrder ?? ""}
                disabled={disabled}
                onChange={(event) => update(index, { maxPerOrder: event.target.value })}
              />
            </div>
            {items.length > 1 && !disabled && (
              <button
                type="button"
                className="self-start text-xs font-medium text-[var(--color-danger)] hover:underline"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                <Trash2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                Remove item
              </button>
            )}
          </div>
        );
      })}

      {!disabled && (
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...items, emptyItem()])}>
          <Plus className="h-4 w-4" aria-hidden="true" /> Add another item
        </Button>
      )}
    </div>
  );
}

/** The payload shape `setCollectionItemsAction` validates. Empty optional fields are dropped rather than sent as "". */
export function itemsToPayload(items: ItemDraft[]): Record<string, unknown>[] {
  return items.map((item, index) => ({
    ...(item.id ? { id: item.id } : {}),
    name: item.name.trim(),
    ...(item.description?.trim() ? { description: item.description.trim() } : {}),
    price: item.price.trim(),
    ...(item.quantityAvailable?.trim() ? { quantityAvailable: Number(item.quantityAvailable.trim()) } : {}),
    ...(item.maxPerOrder?.trim() ? { maxPerOrder: Number(item.maxPerOrder.trim()) } : {}),
    sortOrder: index,
  }));
}
