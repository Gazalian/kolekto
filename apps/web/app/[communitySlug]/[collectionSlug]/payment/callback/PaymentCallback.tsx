"use client";

import { useEffect, useState } from "react";

import type { ConfirmPaymentResult } from "@kolekto/payments";

import type { FormattedReceipt } from "../../../../../lib/payments/receipt-format.ts";
import { ReceiptView } from "../ReceiptView.tsx";
import { receiptAction, verifyPaymentAction } from "./actions.ts";

type Status = "verifying" | "completed" | "pending" | "waiting" | "failed" | "abandoned" | "review" | "error";

const POLL_MS = 3_000;
const POLL_ATTEMPTS = 20;

interface View {
  status: Status;
  message: string;
}

function viewFor(result: ConfirmPaymentResult): View {
  switch (result.outcome) {
    case "completed":
      return { status: "completed", message: "Your payment was successful. Thank you!" };
    case "needs_review":
      return {
        status: "review",
        message:
          "We received your payment. The organiser needs to check it before it is applied, so it is not confirmed yet. You do not need to pay again; we will email you.",
      };
    case "pending":
      return {
        status: "pending",
        message:
          "We have not received your payment yet. If you are still paying, finish on the payment page and it will be confirmed automatically. A payment that is not completed within 30 minutes is marked as abandoned.",
      };
    case "failed":
      if (result.failureCode === "abandoned") {
        return {
          status: "abandoned",
          message: "This payment was not completed within 30 minutes, so it was cancelled. No payment was received. You can start a new payment.",
        };
      }
      return { status: "failed", message: "Your payment was not successful. Please try again." };
    case "not_found":
      return { status: "error", message: "This payment could not be found." };
    case "provider_unavailable":
      return { status: "pending", message: "We could not verify your payment right now. We are trying again." };
    case "error":
      return {
        status: "review",
        message: "We could not confirm your payment yet. If money left your account, it is safe and will be checked. We will email you.",
      };
  }
}

const HEADINGS: Record<Status, string> = {
  verifying: "Verifying your payment",
  completed: "Payment Successful",
  pending: "Payment Pending",
  waiting: "Payment Pending",
  failed: "Payment Failed",
  abandoned: "Payment Abandoned",
  review: "Payment Under Review",
  error: "Error",
};

function Spinner() {
  return (
    <svg className="mx-auto h-10 w-10 animate-spin text-[var(--color-primary)]" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-80"
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-success-bg)]">
      <svg className="h-7 w-7 text-[var(--color-success)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </div>
  );
}

function WarningIcon() {
  return (
    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-warning-bg)]">
      <svg className="h-7 w-7 text-[var(--color-warning)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    </div>
  );
}

function ErrorIcon() {
  return (
    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-danger-bg)]">
      <svg className="h-7 w-7 text-[var(--color-danger)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </div>
  );
}

function ClockIcon() {
  return (
    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-warning-bg)]">
      <svg className="h-7 w-7 text-[var(--color-warning)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    </div>
  );
}

function StatusIcon({ status }: { status: Status }) {
  switch (status) {
    case "verifying":
      return <Spinner />;
    case "completed":
      return <CheckIcon />;
    case "pending":
    case "waiting":
      return <ClockIcon />;
    case "review":
      return <WarningIcon />;
    case "failed":
    case "abandoned":
    case "error":
      return <ErrorIcon />;
  }
}

export function PaymentCallback({
  reference,
  communitySlug,
  collectionSlug,
}: {
  reference: string | null;
  communitySlug: string;
  collectionSlug: string;
}) {
  const [view, setView] = useState<View>(
    reference ? { status: "verifying", message: "" } : { status: "error", message: "No payment reference found." },
  );
  const [receipt, setReceipt] = useState<{ receipt: FormattedReceipt; pdfHref: string } | null>(null);

  useEffect(() => {
    if (!reference) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async (attempt: number): Promise<void> => {
      let next: View;
      try {
        const result = await verifyPaymentAction(reference);
        next = viewFor(result);
        if (result.outcome === "completed") {
          const r = await receiptAction(communitySlug, collectionSlug, reference).catch(() => null);
          if (!cancelled) setReceipt(r);
        }
      } catch {
        next = { status: "error", message: "Something went wrong while checking your payment. Please contact the organiser." };
      }
      if (cancelled) return;

      if (next.status === "pending") {
        if (attempt + 1 < POLL_ATTEMPTS) {
          setView(next);
          timer = setTimeout(() => void check(attempt + 1), POLL_MS);
          return;
        }
        next = {
          status: "waiting",
          message:
            "Your payment is not confirmed yet. If you paid, you do not need to pay again: it will be confirmed automatically and we will email your receipt. If you did not finish paying, you can start a new payment.",
        };
      }
      setView(next);
    };

    void check(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reference, communitySlug, collectionSlug]);

  return (
    <main className="flex min-h-svh flex-col items-center justify-start bg-[var(--color-bg)] px-4 pt-16 pb-12 sm:pt-24">
      <div className="w-full max-w-md">
        {/* Status card */}
        <div
          className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-md)] sm:p-8"
          role="status"
          aria-live="polite"
        >
          <div className="mb-5">
            <StatusIcon status={view.status} />
          </div>

          <h1 className="text-center text-xl font-semibold text-[var(--color-text)]">
            {HEADINGS[view.status]}
          </h1>

          <p className="mt-3 text-center text-sm leading-relaxed text-[var(--color-text-muted)]">
            {view.message || "Please wait a moment…"}
          </p>

          {view.status === "completed" && (
            <p className="mt-2 text-center text-xs text-[var(--color-text-faint)]">
              A copy of this receipt has been emailed to you.
            </p>
          )}

          {reference && view.status !== "completed" && view.status !== "verifying" && view.status !== "error" && (
            <p className="mt-4 break-all rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-3 py-2 text-center font-mono text-xs text-[var(--color-text-muted)]">
              {reference}
            </p>
          )}

          {(view.status === "failed" || view.status === "abandoned" || view.status === "waiting") && (
            <a
              href={`/${encodeURIComponent(communitySlug)}/${encodeURIComponent(collectionSlug)}`}
              className="mt-5 flex w-full items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--color-primary-fg)] no-underline hover:bg-[var(--color-primary-strong)]"
            >
              Start a new payment
            </a>
          )}
        </div>

        {/* Receipt */}
        {view.status === "completed" && receipt && (
          <div className="mt-6">
            <ReceiptView receipt={receipt.receipt} pdfHref={receipt.pdfHref} />
          </div>
        )}

        {/* Footer */}
        <p className="mt-8 text-center text-xs text-[var(--color-text-faint)]">
          Secured by Kolekto
        </p>
      </div>
    </main>
  );
}
