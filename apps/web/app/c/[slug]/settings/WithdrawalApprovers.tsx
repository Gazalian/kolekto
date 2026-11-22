"use client";

import { Badge, Banner, Button, Dialog, SelectField } from "@kolekto/ui";
import { useState, useTransition } from "react";
import { replaceWithdrawalApproverAction, setWithdrawalApproverAction } from "./actions.ts";
import type { ApproverPanelState, CurrentApproverView } from "./approver-view.ts";

const when = (iso: string) => new Date(iso).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short" });

type Pending = { kind: "designate" } | { kind: "replace"; from: CurrentApproverView } | { kind: "remove"; from: CurrentApproverView } | null;

/**
 * Owner-only section of Settings → Team (session 39). Shown only to a
 * community owner; every change is re-checked by the database, so hiding it
 * from others is presentation, not security.
 */
export function WithdrawalApprovers({
  slug,
  communityId,
  state,
  onInviteAdmin,
}: {
  slug: string;
  communityId: string;
  /** Null when the approver list could not be loaded. */
  state: ApproverPanelState | null;
  onInviteAdmin: () => void;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="withdrawal-approver-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="withdrawal-approver-heading" className="text-sm font-semibold text-[var(--color-text)]">
          Withdrawal second approver
        </h2>
        {state && state.choices.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => setPending({ kind: "designate" })}>
            {state.current.length === 0 ? "Designate approver" : "Add approver"}
          </Button>
        )}
      </div>

      <p className="text-sm text-[var(--color-text-muted)]">
        Withdrawals you initiate must be reviewed by your designated second approver. You cannot approve your own withdrawal. The person you
        designate here is authorised to review, approve or reject withdrawal requests made by a community owner, after the requester has
        verified the request with the code sent to their email. Only a current admin (or co-owner) of this community can be designated; the
        treasurer role alone does not give approval authority.
      </p>

      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      {state === null ? (
        <Banner tone="danger">The approver list could not be loaded. Reload the page to try again.</Banner>
      ) : (
        <>
          {state.notice === "none_designated" && (
            <Banner tone="info">
              No second approver is designated. A withdrawal you request cannot be approved until you designate one.
            </Banner>
          )}
          {state.notice === "none_effective" && (
            <Banner tone="danger">
              Your designated approver can no longer approve withdrawals. Replace them, or a withdrawal you request cannot be approved.
            </Banner>
          )}

          {state.current.length > 0 && (
            <ul className="flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
              {state.current.map((approver) => (
                <li key={approver.designationId} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-[var(--color-text)]">{approver.fullName}</p>
                      <Badge tone={approver.status === "active" ? "success" : "danger"}>{approver.statusLabel}</Badge>
                    </div>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {approver.roleLabel} · designated {when(approver.designatedAt)} by {approver.designatedByName}
                    </p>
                    {approver.statusHelp && <p className="text-xs text-[var(--color-danger)]">{approver.statusHelp}</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {state.choices.length > 0 && (
                      <Button size="sm" variant="secondary" onClick={() => setPending({ kind: "replace", from: approver })}>
                        Replace
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="text-[var(--color-danger)]" onClick={() => setPending({ kind: "remove", from: approver })}>
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {state.needsAdmin && (
            <div className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] p-4">
              <p className="text-sm text-[var(--color-text-muted)]">
                Nobody in this community can be designated yet. Invite someone you trust as an <strong>admin</strong>; once they accept, you can
                designate them here.
              </p>
              <Button size="sm" variant="secondary" className="w-fit" onClick={onInviteAdmin}>
                Invite an admin
              </Button>
            </div>
          )}

          {state.past.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-[var(--color-text-muted)]">Earlier designations ({state.past.length})</summary>
              <ul className="mt-2 flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                {state.past.map((p) => (
                  <li key={p.designationId}>
                    {p.fullName}: designated {when(p.designatedAt)} by {p.designatedByName}; ended {when(p.endedAt)}
                    {p.endedByName ? ` by ${p.endedByName}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <ApproverDialog
            pending={pending}
            choices={state.choices}
            onClose={() => setPending(null)}
            onDone={(result) => {
              setPending(null);
              setMessage(result);
            }}
            slug={slug}
            communityId={communityId}
          />
        </>
      )}
    </section>
  );
}

function ApproverDialog({
  pending,
  choices,
  onClose,
  onDone,
  slug,
  communityId,
}: {
  pending: Pending;
  choices: ApproverPanelState["choices"];
  onClose: () => void;
  onDone: (result: { tone: "success" | "danger"; text: string }) => void;
  slug: string;
  communityId: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const open = pending !== null;
  const close = () => {
    setChoice("");
    setError(null);
    onClose();
  };

  const title =
    pending?.kind === "remove" ? "Remove second approver?" : pending?.kind === "replace" ? `Replace ${pending.from.fullName}?` : "Designate a second approver";
  const chosenName = choices.find((c) => c.userId === choice)?.fullName;

  function confirm() {
    if (!pending) return;
    setError(null);
    startTransition(async () => {
      let result;
      if (pending.kind === "remove") {
        result = await setWithdrawalApproverAction(slug, communityId, pending.from.userId, false);
      } else if (!choice) {
        setError("Choose a person.");
        return;
      } else if (pending.kind === "replace") {
        result = await replaceWithdrawalApproverAction(slug, communityId, pending.from.userId, choice);
      } else {
        result = await setWithdrawalApproverAction(slug, communityId, choice, true);
      }
      if (result.error) {
        setError(result.error);
        return;
      }
      setChoice("");
      onDone({
        tone: "success",
        text:
          pending.kind === "remove"
            ? `${pending.from.fullName} is no longer a second approver.`
            : pending.kind === "replace"
              ? `${chosenName ?? "The new approver"} now replaces ${pending.from.fullName} as second approver.`
              : `${chosenName ?? "They"} can now review withdrawals you request.`,
      });
    });
  }

  return (
    <Dialog open={open} onClose={close} title={title}>
      <div className="flex flex-col gap-4">
        {pending?.kind === "remove" ? (
          <p className="text-sm text-[var(--color-text)]">
            {pending.from.fullName} will no longer be able to approve withdrawals you request. Approvals they already gave stay on record
            unchanged.
          </p>
        ) : (
          <>
            <SelectField label="Administrator" value={choice} onChange={(e) => setChoice(e.currentTarget.value)} required>
              <option value="" disabled>
                Choose an admin
              </option>
              {choices.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.fullName} ({c.officerRole === "owner" ? "Owner" : c.officerTitle ? `Admin, ${c.officerTitle}` : "Admin"})
                </option>
              ))}
            </SelectField>
            <p className="text-sm text-[var(--color-text-muted)]">
              {pending?.kind === "replace"
                ? `${pending.from.fullName} loses approval authority the moment the new approver is designated. Approvals they already gave stay on record unchanged.`
                : "They will be able to review, approve or reject withdrawals requested by a community owner — never their own."}
            </p>
          </>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button variant={pending?.kind === "remove" ? "danger" : "primary"} loading={isPending} onClick={confirm}>
            {pending?.kind === "remove" ? "Remove approver" : pending?.kind === "replace" ? "Replace approver" : "Designate"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
