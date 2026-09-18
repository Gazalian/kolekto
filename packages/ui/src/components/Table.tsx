import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../cn.ts";

/**
 * A responsive table shell. Below `sm`, cells stack via `data-label` (CSS in
 * apps/web/app/globals.css) rather than forcing horizontal scroll on a phone
 * — a 5-column member table does not fit 360px, and horizontal scroll hides
 * columns a touch user does not know are there (section 22).
 */
export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)]">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function Thead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className="bg-[var(--color-bg)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]" {...props} />;
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn("px-4 py-2.5 font-medium", className)} {...props} />;
}

export function Tbody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className="divide-y divide-[var(--color-border)]" {...props} />;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("hover:bg-[var(--color-bg)]", className)} {...props} />;
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-2.5 align-middle text-[var(--color-text)]", className)} {...props} />;
}
