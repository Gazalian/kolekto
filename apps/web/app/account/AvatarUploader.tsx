"use client";

import { Banner } from "@kolekto/ui";
import { Camera, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Avatar } from "../../components/Avatar.tsx";
import { AVATAR_ACCEPT, AVATAR_MAX_BYTES } from "../../lib/avatar-file.ts";
import { removeAvatarAction, uploadAvatarAction } from "./avatar-actions.ts";

/**
 * Profile photo picker. The browser only chooses a file; the server checks the
 * bytes, names the object and stores it. The checks here only give a quick,
 * clear message.
 */
export function AvatarUploader({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(avatarUrl);
  const [isPending, startTransition] = useTransition();

  function choose(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!AVATAR_ACCEPT.split(",").includes(file.type)) {
      setError("Upload a JPG, PNG or WebP image.");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError("That image is larger than 2 MB. Try a smaller one.");
      return;
    }
    const formData = new FormData();
    formData.append("avatar", file);
    startTransition(async () => {
      const result = await uploadAvatarAction(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setCurrent(result.url ?? null);
      router.refresh();
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await removeAvatarAction();
      if (result.error) {
        setError(result.error);
        return;
      }
      setCurrent(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isPending}
        aria-label={current ? "Change profile photo" : "Add a profile photo"}
        className="group relative rounded-full focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-60"
      >
        <Avatar name={name} url={current} className="h-16 w-16 text-lg" />
        <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-[var(--shadow-sm)]">
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ACCEPT}
        className="sr-only"
        aria-label="Profile photo"
        disabled={isPending}
        onChange={(event) => {
          choose(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {current && (
        <button
          type="button"
          onClick={remove}
          disabled={isPending}
          className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:underline disabled:opacity-60"
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" /> Remove
        </button>
      )}
      {isPending && <span className="text-xs text-[var(--color-text-muted)]">Saving…</span>}
      {error && (
        <div className="w-56">
          <Banner tone="danger">{error}</Banner>
        </div>
      )}
    </div>
  );
}
