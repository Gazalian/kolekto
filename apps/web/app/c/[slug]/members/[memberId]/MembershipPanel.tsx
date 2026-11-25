"use client";

import { Banner, Button, Card, CardBody, Dialog, TextField } from "@kolekto/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  issueMembershipIdAction,
  reinstateMemberAction,
  replaceMembershipIdAction,
  revokeMembershipIdAction,
  suspendMemberAction,
} from "../membership-actions.ts";

/**
 * Membership ID and standing for one member (product doc Part F; M9b).
 *
 * The full ID is shown, with Copy, only to the owner and officers holding
 * membership.issue_ids (owner decision D5, 2026-11-23); other officers who can
 * see contact details get the masked form. Issue / replace / revoke need
 * membership.issue_ids; suspend / reinstate need member.suspend. The database
 * re-checks every one.
 */

export interface MembershipIdView {
  fullId: string | null;
  masked: string;
  issuedAt: string;
}

type DialogKind = "replace" | "revoke" | "suspend" | "reinstate" | null;

export function MembershipPanel({
  slug,
  memberId,
  memberName,
  status,
  membershipId,
  idsEnabled,
  canIssue,
  canSuspend,
}: {
  slug: string;
  memberId: string;
  memberName: string;
  status: string;
  membershipId: MembershipIdView | null;
  idsEnabled: boolean;
  canIssue: boolean;
  canSuspend: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [justIssued, setJustIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  const suspended = status === "suspended";
  const inGoodStanding = status === "active" || status === "unclaimed" || status === "invited";
  const shown = justIssued ?? membershipId?.fullId ?? null;

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function run(task: () => Promise<{ error?: string; fullId?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.fullId) setJustIssued(result.fullId);
      setDialog(null);
      after?.();
      router.refresh();
    });
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Membership</h2>
          <div className="flex flex-wrap gap-2">
            {canIssue && idsEnabled && inGoodStanding && !membershipId && !justIssued && (
              <Button size="sm" loading={isPending} onClick={() => run(() => issueMembershipIdAction(slug, memberId))}>
                Issue membership ID
              </Button>
            )}
            {canIssue && idsEnabled && inGoodStanding && (membershipId || justIssued) && (
              <Button size="sm" variant="secondary" onClick={() => setDialog("replace")}>
                Replace ID
              </Button>
            )}
            {canIssue && (membershipId || justIssued) && (
              <Button size="sm" variant="ghost" onClick={() => setDialog("revoke")}>
                Revoke ID
              </Button>
            )}
            {canSuspend && inGoodStanding && (
              <Button size="sm" variant="danger" onClick={() => setDialog("suspend")}>
                Suspend
              </Button>
            )}
            {canSuspend && suspended && (
              <Button size="sm" onClick={() => setDialog("reinstate")}>
                Reinstate
              </Button>
            )}
          </div>
        </div>

        {suspended && (
          <Banner tone="info">
            Suspended. Their membership ID does not work while they are suspended, they are left out of new collections
            and announcements, and nothing they already paid is changed. Reinstating makes the same ID work again.
          </Banner>
        )}

        <dl className="divide-y divide-[var(--color-border)]">
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <dt className="text-sm text-[var(--color-text-muted)]">Membership ID</dt>
            <dd className="flex items-center gap-2">
              {shown ? (
                <>
                  <span className="font-mono text-sm font-semibold text-[var(--color-text)]" data-testid="membership-id">
                    {shown}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => copy(shown)}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </>
              ) : membershipId ? (
                <span className="font-mono text-sm text-[var(--color-text)]">{membershipId.masked}</span>
              ) : (
                <span className="text-sm text-[var(--color-text-muted)]">
                  {idsEnabled ? "Not issued yet" : "Membership IDs are off for this community"}
                </span>
              )}
            </dd>
          </div>
          {membershipId && !justIssued && (
            <div className="flex flex-wrap justify-between gap-2 py-2">
              <dt className="text-sm text-[var(--color-text-muted)]">Issued</dt>
              <dd className="text-sm font-medium text-[var(--color-text)]">
                {new Date(membershipId.issuedAt).toLocaleDateString()}
              </dd>
            </div>
          )}
        </dl>

        {justIssued && (
          <p className="text-xs text-[var(--color-text-muted)]">
            New ID issued. Give it to {memberName}; it stays visible here to officers who can see contact details.
          </p>
        )}

        {error && !dialog && <Banner tone="danger">{error}</Banner>}
      </CardBody>

      {dialog && (
        <Dialog
          open
          onClose={() => {
            setDialog(null);
            setError(null);
          }}
          title={
            dialog === "replace"
              ? "Replace membership ID?"
              : dialog === "revoke"
                ? "Revoke membership ID?"
                : dialog === "suspend"
                  ? `Suspend ${memberName}?`
                  : `Reinstate ${memberName}?`
          }
          description={
            dialog === "replace"
              ? "The current ID stops working at once and a new one is issued. Use this if the ID was shared with someone it should not have been."
              : dialog === "revoke"
                ? "The ID stops working at once. The member keeps everything else; you can issue a new ID later."
                : dialog === "suspend"
                  ? "Their membership ID stops working, any open member access ends, and they are left out of new collections and announcements. Their record and payments are kept."
                  : "They return to the status they had before, and their membership ID works again. Replace it if it may have been shared."
          }
        >
          <form
            className="flex flex-col gap-4"
            action={(formData) => {
              const reason = formData.get("reason");
              if (dialog === "replace") run(() => replaceMembershipIdAction(slug, memberId, reason));
              else if (dialog === "revoke") run(() => revokeMembershipIdAction(slug, memberId, reason), () => setJustIssued(null));
              else if (dialog === "suspend") run(() => suspendMemberAction(slug, memberId, reason), () => setJustIssued(null));
              else run(() => reinstateMemberAction(slug, memberId, reason));
            }}
          >
            <TextField
              label="Reason"
              name="reason"
              required={dialog === "revoke" || dialog === "suspend"}
              hint={dialog === "revoke" || dialog === "suspend" ? "Required, kept in the audit log." : "Optional, kept in the audit log."}
            />
            {error && <Banner tone="danger">{error}</Banner>}
            <Button type="submit" variant={dialog === "suspend" || dialog === "revoke" ? "danger" : "primary"} loading={isPending}>
              {dialog === "replace"
                ? "Replace ID"
                : dialog === "revoke"
                  ? "Revoke ID"
                  : dialog === "suspend"
                    ? "Suspend member"
                    : "Reinstate member"}
            </Button>
          </form>
        </Dialog>
      )}
    </Card>
  );
}
