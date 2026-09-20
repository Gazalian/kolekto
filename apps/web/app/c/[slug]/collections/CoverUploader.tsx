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
}: {
  slug: string;
  collectionSlug: string;
  collectionId: string;
  coverImageUrl: string | null;
  disabled?: boolean;
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
      const result = await uploadCoverAction(slug, collectionSlug, collectionId, formData);
      URL.revokeObjectURL(localUrl);

      if (result.error || !result.url) {
        // Put the screen back to what is actually stored, so a failed upload
        // never leaves a flyer showing that nobody else can see.
        setPreview(coverImageUrl);
        setError(result.error ?? "The image could not be uploaded.");
        return;
      }

      setPreview(result.url);
      router.refresh();
    });
  }

  function remove(): void {
    if (!coverImageUrl) return;
    setError(null);
    startTransition(async () => {
      const result = await removeCoverAction(slug, collectionSlug, collectionId, coverImageUrl);
      if (result.error) {
        setError(result.error);
        return;
      }
      setPreview(null);
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
          alt="Collection flyer"
          className="max-h-64 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] object-cover"
        />
      ) : (
        <div className="flex h-32 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
          No flyer yet
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        aria-label="Collection flyer"
        onChange={(event) => {
          choose(event.target.files?.[0]);
          // Clearing the input means picking the same file twice still fires.
          event.target.value = "";
        }}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || isPending}
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
          {coverImageUrl ? "Replace flyer" : "Upload a flyer"}
        </Button>
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
