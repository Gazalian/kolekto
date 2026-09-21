"use client";

import { Monitor, Smartphone } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

/**
 * The chrome around a contributor preview (M7.6 part B).
 *
 * Two things an organiser asks that a bare preview cannot answer:
 *
 *   "What does this look like on a phone?" — which is how almost everyone
 *   will open it, and which a laptop preview flatters. The phone view is a
 *   real 390-pixel column, so a long ticket name really does wrap where it
 *   will wrap.
 *
 *   "How do I get back to running this?" — the host view and the contributor
 *   view are the same collection seen from two sides, and moving between them
 *   should be one click rather than a trip through the collections list.
 *
 * The frame is presentation only. What it wraps is the same CollectionView
 * the published page renders, from the same rows — a preview that had its own
 * rendering would drift from the page within a milestone (part B: "do not
 * build a second fake preview implementation").
 */
export function PreviewFrame({
  hostHref,
  isDraft,
  children,
}: {
  hostHref: string;
  isDraft: boolean;
  children: ReactNode;
}) {
  const [device, setDevice] = useState<"phone" | "desktop">("phone");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-[var(--color-text)]">Contributor view</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {isDraft
              ? "What people will see once you publish. Nothing here can be submitted."
              : "What people see on the public page. Nothing here can be submitted."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div
            className="flex rounded-[var(--radius-md)] border border-[var(--color-border)] p-0.5"
            role="group"
            aria-label="Preview size"
          >
            <button
              type="button"
              aria-pressed={device === "phone"}
              onClick={() => setDevice("phone")}
              className={
                device === "phone"
                  ? "flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-2.5 py-1 text-xs font-medium text-[var(--color-primary-fg)]"
                  : "flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }
            >
              <Smartphone className="h-3.5 w-3.5" aria-hidden="true" /> Phone
            </button>
            <button
              type="button"
              aria-pressed={device === "desktop"}
              onClick={() => setDevice("desktop")}
              className={
                device === "desktop"
                  ? "flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] px-2.5 py-1 text-xs font-medium text-[var(--color-primary-fg)]"
                  : "flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }
            >
              <Monitor className="h-3.5 w-3.5" aria-hidden="true" /> Desktop
            </button>
          </div>

          <Link href={hostHref} className="text-sm font-medium text-[var(--color-primary)] hover:underline">
            Host view →
          </Link>
        </div>
      </div>

      <div className="flex justify-center">
        <div
          className={
            device === "phone"
              ? "w-full max-w-[390px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] shadow-sm"
              : "w-full rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] shadow-sm"
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
