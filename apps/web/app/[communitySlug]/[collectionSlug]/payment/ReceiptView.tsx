import type { FormattedReceipt } from "../../../../lib/payments/receipt-format.ts";

export function ReceiptView({ receipt, pdfHref }: { receipt: FormattedReceipt; pdfHref: string }) {
  return (
    <section
      aria-labelledby="receipt-title"
      className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-sm)] sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">{receipt.title}</p>
          <h2 id="receipt-title" className="mt-0.5 text-base font-semibold text-[var(--color-text)]">
            {receipt.collectionName}
          </h2>
          <p className="text-sm text-[var(--color-text-muted)]">{receipt.communityName}</p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-success-bg)]">
          <svg className="h-4.5 w-4.5 text-[var(--color-success)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
      </div>

      <dl className="mt-5 flex flex-col gap-0.5 text-sm">
        <div className="flex justify-between gap-3 py-1.5">
          <dt className="text-[var(--color-text-muted)]">Reference</dt>
          <dd className="break-all text-right font-mono text-xs text-[var(--color-text)]">{receipt.reference}</dd>
        </div>
        <div className="flex justify-between gap-3 py-1.5">
          <dt className="text-[var(--color-text-muted)]">Date</dt>
          <dd className="text-right text-[var(--color-text)]">{receipt.paidOn}</dd>
        </div>
        {receipt.payer.map((row) => (
          <div key={row.label} className="flex justify-between gap-3 py-1.5">
            <dt className="text-[var(--color-text-muted)]">{row.label}</dt>
            <dd className="break-all text-right text-[var(--color-text)]">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 border-t border-[var(--color-border)]" />

      <ul className="mt-3 flex flex-col gap-0.5 text-sm">
        {receipt.items.map((item, i) => (
          <li key={i} className="flex justify-between gap-3 py-1.5">
            <span className="text-[var(--color-text)]">{item.description}</span>
            <span className="tabular-nums text-[var(--color-text)]">{item.amount}</span>
          </li>
        ))}
      </ul>

      <div className="mt-3 border-t border-[var(--color-border)]" />

      <dl className="mt-3 flex flex-col gap-0.5 text-sm">
        {receipt.amounts.map((row) => (
          <div key={row.label} className="flex justify-between gap-3 py-1.5">
            <dt className={row.emphasis ? "font-semibold text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>
              {row.label}
            </dt>
            <dd className={`tabular-nums ${row.emphasis ? "font-semibold text-[var(--color-text)]" : "text-[var(--color-text)]"}`}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {receipt.note && (
        <p className="mt-4 rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
          {receipt.note}
        </p>
      )}

      <a
        href={pdfHref}
        download
        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--color-primary-fg)] no-underline hover:bg-[var(--color-primary-strong)]"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Download receipt (PDF)
      </a>
    </section>
  );
}
