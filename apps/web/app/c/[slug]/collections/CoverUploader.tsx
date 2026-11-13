"use client";

import { Banner, Button } from "@kolekto/ui";
import { ImagePlus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { removeCoverAction, uploadCoverAction } from "./actions.ts";

/**
 * The flyer on a collection's public page (§33).
 *
 * The browser only chooses a file. It holds no storage credential and writes to
 * no bucket: the bytes go to a server action, which checks the caller may edit
 * this collection, validates the file, and uploads with the service role. The
 * checks repeated here are for a quick, clear message — the server's are the
 * ones that decide.
 */

const ACCEPT = "image/jpeg,image/png,image/webp";
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

export function CoverUploader({
  slug,
  collectionSlug,
  collectionId,
  coverImageUrl,
  disabled = false,
  onChanged,
  ensureCollection,
  unavailableReason,
  noun = "flyer",
}: {
  slug: string;
  /** Absent while the creation wizard has not saved a draft yet — `ensureCollection` then creates one. */
  collectionSlug?: string | null | undefined;
  collectionId?: string | null | undefined;
  coverImageUrl: string | null;
  disabled?: boolean;
  /** Optional: told the new URL (or null, on remove) whenever it changes — for a caller with no server round trip of its own to learn from, like the creation wizard. */
  onChanged?: (url: string | null) => void;
  /**
   * The creation wizard's way of putting the image beside the name: an upload
   * has to be scoped to a real collection, so choosing a file before the
   * draft exists creates the draft first, then uploads against it.
   */
  ensureCollection?: () => Promise<{ id: string; slug: string } | null>;
  /** Why the image cannot be added yet — shown instead of an enabled button. */
  unavailableReason?: string | null | undefined;
  /** "flyer" for an event, "image" elsewhere. */
  noun?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // What is on screen right now: the saved flyer, or the one being uploaded.
  // A local preview means the person sees their choice immediately instead of
  // waiting for a round trip to tell them it worked.
  const [preview, setPreview] = useState<string | null>(coverImageUrl);

  function choose(file: File | undefined): void {
    setError(null);
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError("Upload a JPG, PNG or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That image is larger than 5 MB. Try a smaller one.");
      return;
    }

    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);

    const formData = new FormData();
    formData.append("cover", file);

    startTransition(async () => {
      const target =
        collectionId && collectionSlug
          ? { id: collectionId, slug: collectionSlug }
          : ((await ensureCollection?.()) ?? null);
      if (!target) {
        URL.revokeObjectURL(localUrl);
        setPreview(coverImageUrl);
        setError(`The ${noun} could not be saved yet — check the name, then try again.`);
        return;
      }

      const result = await uploadCoverAction(slug, target.slug, target.id, formData);
      URL.revokeObjectURL(localUrl);

      if (result.error || !result.url) {
        // Put the screen back to what is actually stored, so a failed upload
        // never leaves a flyer showing that nobody else can see.
        setPreview(coverImageUrl);
        setError(result.error ?? "The image could not be uploaded.");
        return;
      }

      setPreview(result.url);
      onChanged?.(result.url);
      router.refresh();
    });
  }

  function remove(): void {
    if (!coverImageUrl || !collectionSlug || !collectionId) return;
    setError(null);
    startTransition(async () => {
      const result = await removeCoverAction(slug, collectionSlug, collectionId, coverImageUrl);
      if (result.error) {
        setError(result.error);
        return;
      }
      setPreview(null);
      onChanged?.(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <Banner tone="danger">{error}</Banner>}

      {preview ? (
        // An arbitrary uploaded image on a storage host, not a bundled asset.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt={`Collection ${noun}`}
          className="max-h-64 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] object-cover"
        />
      ) : (
        <div className="flex h-32 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
          No {noun} yet
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        aria-label={`Collection ${noun}`}
        disabled={disabled || isPending || Boolean(unavailableReason)}
        onChange={(event) => {
          choose(event.target.files?.[0]);
          // Clearing the input means picking the same file twice still fires.
          event.target.value = "";
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || isPending || Boolean(unavailableReason)}
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
          {coverImageUrl ? `Replace ${noun}` : `Upload ${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`}
        </Button>
        {unavailableReason && <span className="text-xs text-[var(--color-text-muted)]">{unavailableReason}</span>}
        {coverImageUrl && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled || isPending} onClick={remove}>
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
          </Button>
        )}
      </div>

      <p className="text-xs text-[var(--color-text-muted)]">
        JPG, PNG or WebP, up to 5 MB. Shown at the top of the public page, so anyone with the link can see it.
      </p>
    </div>
  );
}
