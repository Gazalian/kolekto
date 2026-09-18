import type { ReactNode } from "react";
import { cn } from "../cn.ts";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-[var(--color-bg)] text-[var(--color-text-muted)] border-[var(--color-border)]",
  success: "bg-[var(--color-success-bg)] text-[var(--color-success)] border-transparent",
  warning: "bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-transparent",
  danger: "bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-transparent",
  info: "bg-[var(--color-info-bg)] text-[var(--color-info)] border-transparent",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}
