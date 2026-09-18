"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "../cn.ts";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Built on the native `<dialog>` element rather than a custom focus-trap: the
 * browser already gives it modal focus containment, Escape-to-close and
 * `::backdrop`, which is more reliable than a hand-rolled trap (section 21).
 */
export function Dialog({ open, onClose, title, description, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="dialog-title"
      aria-describedby={description ? "dialog-description" : undefined}
      className={cn(
        "m-auto w-[calc(100vw-2rem)] max-w-md rounded-[var(--radius-lg)] border border-[var(--color-border)]",
        "bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-md)] backdrop:bg-black/40",
        className,
      )}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] p-4">
        <div>
          <h2 id="dialog-title" className="text-base font-semibold">
            {title}
          </h2>
          {description && (
            <p id="dialog-description" className="mt-0.5 text-sm text-[var(--color-text-muted)]">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-[var(--radius-sm)] p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
        >
          ✕
        </button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}
