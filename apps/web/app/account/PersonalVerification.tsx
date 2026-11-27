import type { MyIdentitySummary, SavedBankAccount } from "@kolekto/db";
import { Badge } from "@kolekto/ui";
import { CheckCircle2, Circle, Clock, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { identityLevelView } from "../../lib/community-display.ts";

/**
 * Personal verification, read from the database only:
 *   · email confirmed            auth.users.email_confirmed_at (my_identity_summary)
 *   · payout name match          user_bank_accounts.status (owner decision Q3, 2026-11-18:
 *                                a Paystack-resolved name that matches the legal name is
 *                                what withdrawals require today)
 *   · identity check             users.identity_level = identity_verified — no provider is
 *                                connected (DEC-04), so this step is shown as not available.
 *
 * Nothing here can mark anyone verified. Completing a form never does.
 */
export function PersonalVerification({
  identity,
  accounts,
}: {
  identity: MyIdentitySummary | null;
  /** null when the saved accounts could not be read. */
  accounts: SavedBankAccount[] | null;
}) {
  const level = identityLevelView(identity?.identityLevel ?? "none");
  const verifiedAccount = accounts?.some((a) => a.status === "verified") ?? false;
  const reviewing = accounts?.some((a) => a.status === "needs_review") ?? false;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="verification-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="verification-heading" className="text-base font-semibold text-[var(--color-text)]">
          Personal verification
        </h2>
        <Badge tone={level.tone}>{level.label}</Badge>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        This is about you as a person, across every community. It is separate from any community&apos;s own verification,
        and your details are never shown to other officers or members.
      </p>
      <ol className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
        <Step
          state={identity?.emailConfirmed ? "done" : "todo"}
          title="Email address confirmed"
          detail={identity?.emailConfirmed ? "Withdrawal codes are sent to it." : "Confirm your email from the link we sent you."}
        />
        <Step
          state={accounts === null ? "unknown" : verifiedAccount ? "done" : reviewing ? "waiting" : "todo"}
          title="Payout account matches your legal name"
          detail={
            accounts === null
              ? "Your bank accounts could not be checked right now."
              : verifiedAccount
                ? "Your bank confirmed the account is in your name. This is what withdrawals require today."
                : reviewing
                  ? "Kolekto is checking an account whose name did not match exactly."
                  : "Add a bank account below. Withdrawals need one that is verified in your name."
          }
        />
        <Step
          state={identity?.identityLevel === "identity_verified" ? "done" : "locked"}
          title="Identity check"
          detail={
            identity?.identityLevel === "identity_verified"
              ? "Kolekto has verified your identity."
              : "Checking an ID document or BVN is not available yet. You will be told here when it opens; you do not need it to withdraw today."
          }
        />
      </ol>
    </section>
  );
}

function Step({
  state,
  title,
  detail,
}: {
  state: "done" | "todo" | "waiting" | "locked" | "unknown";
  title: string;
  detail: ReactNode;
}) {
  const icon =
    state === "done" ? (
      <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" aria-label="Done" />
    ) : state === "waiting" ? (
      <Clock className="h-4 w-4 text-[var(--color-warning)]" aria-label="In review" />
    ) : state === "locked" ? (
      <Lock className="h-4 w-4 text-[var(--color-text-faint)]" aria-label="Not available yet" />
    ) : (
      <Circle className="h-4 w-4 text-[var(--color-text-faint)]" aria-label="Not done" />
    );
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-text)]">
          {title}
          {state === "locked" && <Badge tone="neutral">Not available yet</Badge>}
          {state === "waiting" && <Badge tone="warning">In review</Badge>}
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">{detail}</p>
      </div>
    </li>
  );
}
