"use client";

import { Button, TextField } from "@kolekto/ui";
import { ChevronDown, ChevronUp, ImagePlus, Plus, Trash2 } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { removeItemImageAction, uploadItemImageAction } from "./actions.ts";

/**
 * What an item-based collection sells (§31), now with an image per item
 * (§4/§16).
 *
 * The same contract as TiersEditor, for the same reason: `id` is carried
 * through every edit and is what the server matches on, so renaming "Blue" to
 * "Royal Blue" keeps whatever already pointed at that item. A name is a label
 * (ADR 0010).
 *
 * Distinct from an option on a tiered collection in what it carries: stock,
 * how many one person may take, and a picture — an aso-ebi order has 40 yards
 * of the blue, and a contributor deciding between the blue and the gold wants
 * to see which is which.
 */
export interface ItemDraft {
  id?: string | undefined;
  name: string;
  description?: string;
  price: string;
  quantityAvailable?: string;
  maxPerOrder?: string;
  /** Set only by the upload control below — never typed in by hand. */
  imageUrl?: string | undefined;
}

export function emptyItem(): ItemDraft {
  return { name: "", description: "", price: "", quantityAvailable: "", maxPerOrder: "", imageUrl: undefined };
}

export function ItemsEditor({
  items,
  onChange,
  disabled = false,
  slug,
  collectionSlug,
  collectionId,
}: {
  items: ItemDraft[];
  onChange: (items: ItemDraft[]) => void;
  disabled?: boolean;
  /**
   * All three present enables the image control. A draft has to exist before
   * an image can be uploaded against it (the upload is a server action scoped
   * to a real collection id) — so on the creation wizard, where items are
   * chosen before the draft exists, these are left undefined and images are
   * added afterwards, in Settings, where they always are.
   */
  slug?: string;
  collectionSlug?: string;
  collectionId?: string;
}) {
  function update(index: number, patch: Partial<ItemDraft>): void {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  /** Same contract as TiersEditor's: position in this array becomes `sortOrder`, and ids travel with their rows. */
  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const moved = next[index]!;
    next[index] = next[target]!;
    next[target] = moved;
    onChange(next);
  }

  const duplicateNames = new Set(
    items
      .map((item) => item.name.trim().toLowerCase())
      .filter((name, index, all) => name !== "" && all.indexOf(name) !== index),
  );

  const canUploadImages = Boolean(slug && collectionSlug && collectionId);

  return (
    <div className="flex flex-col gap-4">
      {items.map((item, index) => {
        const isDuplicate = duplicateNames.has(item.name.trim().toLowerCase());
        return (
          <div
            key={item.id ?? index}
            className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
          >
            {items.length > 1 && !disabled && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--color-text-muted)]">Item {index + 1}</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label={`Move ${item.name || `item ${index + 1}`} up`}
                    disabled={index === 0}
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border)] p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40"
                    onClick={() => move(index, -1)}
                  >
                    <ChevronUp className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${item.name || `item ${index + 1}`} down`}
                    disabled={index === items.length - 1}
                    className="rounded-[var(--radius-sm)] border border-[var(--color-border)] p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40"
                    onClick={() => move(index, 1)}
                  >
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}
            {canUploadImages && (
              <ItemImage
                slug={slug!}
                collectionSlug={collectionSlug!}
                collectionId={collectionId!}
                imageUrl={item.imageUrl ?? null}
                disabled={disabled}
                onChanged={(url) => update(index, { imageUrl: url ?? undefined })}
              />
            )}
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

const ACCEPT = "image/jpeg,image/png,image/webp";
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * One item's picture. A smaller, inline cousin of `CoverUploader` — same
 * validation, same server-only upload path, same "put the screen back to
 * what is stored" behaviour on failure — sized for a card in a list rather
 * than a page of its own.
 */
function ItemImage({
  slug,
  collectionSlug,
  collectionId,
  imageUrl,
  disabled,
  onChanged,
}: {
  slug: string;
  collectionSlug: string;
  collectionId: string;
  imageUrl: string | null;
  disabled: boolean;
  onChanged: (url: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(imageUrl);
  const [isPending, startTransition] = useTransition();

  function choose(file: File | undefined): void {
    setError(null);
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError("Upload a JPG, PNG or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That image is larger than 5 MB.");
      return;
    }

    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);

    const formData = new FormData();
    formData.append("image", file);

    startTransition(async () => {
      const result = await uploadItemImageAction(slug, collectionSlug, collectionId, formData);
      URL.revokeObjectURL(localUrl);

      if (result.error || !result.url) {
        setPreview(imageUrl);
        setError(result.error ?? "The image could not be uploaded.");
        return;
      }

      // The image just replaced is now nothing's — taken out rather than left
      // as storage nobody can see or delete.
      if (imageUrl) void removeItemImageAction(collectionId, imageUrl);

      setPreview(result.url);
      onChanged(result.url);
    });
  }

  function remove(): void {
    if (!imageUrl) return;
    setError(null);
    startTransition(async () => {
      const result = await removeItemImageAction(collectionId, imageUrl);
      if (result.error) {
        setError(result.error);
        return;
      }
      setPreview(null);
      onChanged(null);
    });
  }

  return (
    <div className="flex items-center gap-3">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt=""
          className="h-16 w-16 flex-shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] object-cover"
        />
      ) : (
        <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)]">
          <ImagePlus className="h-5 w-5" aria-hidden="true" />
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        aria-label="Item image"
        onChange={(event) => {
          choose(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || isPending}
            onClick={() => inputRef.current?.click()}
          >
            {preview ? "Replace image" : "Add image"}
          </Button>
          {preview && (
            <Button type="button" variant="ghost" size="sm" disabled={disabled || isPending} onClick={remove}>
              Remove
            </Button>
          )}
        </div>
        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      </div>
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
    ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
    sortOrder: index,
  }));
}
