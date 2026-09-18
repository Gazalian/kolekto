import type { ReactNode } from "react";
import { cn } from "../cn.ts";

/** A spinning indicator — text alongside it, never alone, so a screen reader has something to announce. */
export function Spinner({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-sm text-[var(--color-text-muted)]", className)}>
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Skeleton block for a loading data surface (section 23: never a blank screen). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-border)]", className)} />;
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

/** The default state for any data surface with nothing in it yet — never a blank screen (section 23). */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] px-6 py-12 text-center">
      {icon && <div className="text-[var(--color-text-faint)]">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-[var(--color-text)]">{title}</p>
        {description && <p className="text-sm text-[var(--color-text-muted)]">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  description: string;
  action?: ReactNode;
}

/** An honest error state — financial software does not hide failures (section 23). */
export function ErrorState({ title = "Something went wrong", description, action }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] px-6 py-10 text-center"
    >
      <p className="text-sm font-semibold text-[var(--color-danger)]">{title}</p>
      <p className="text-sm text-[var(--color-text-muted)]">{description}</p>
      {action}
    </div>
  );
}

/** Inline, dismiss-free feedback banner — success or error, shown after a form submits. */
export function Banner({ tone, children }: { tone: "success" | "danger" | "info"; children: ReactNode }) {
  const classes =
    tone === "success"
      ? "bg-[var(--color-success-bg)] text-[var(--color-success)]"
      : tone === "danger"
        ? "bg-[var(--color-danger-bg)] text-[var(--color-danger)]"
        : "bg-[var(--color-info-bg)] text-[var(--color-info)]";
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium", classes)}>
      {children}
    </div>
  );
}
