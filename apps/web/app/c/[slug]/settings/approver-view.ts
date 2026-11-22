/**
 * approver-view.ts — what the owner's "Withdrawal second approver" section
 * shows, derived from the database's answers (session 39). Pure, so the
 * screen's rules are unit-tested; the authority itself is decided only by the
 * database (app.set_withdrawal_approver / replace / withdrawal_decider_basis).
 */

import type { WithdrawalApproverCandidate, WithdrawalApproverDesignation } from "@kolekto/db";

export interface CurrentApproverView {
  designationId: string;
  userId: string;
  fullName: string;
  roleLabel: string;
  status: "active" | "not_eligible";
  statusLabel: string;
  statusHelp: string | null;
  designatedAt: string;
  designatedByName: string;
}

export interface PastApproverView {
  designationId: string;
  fullName: string;
  designatedAt: string;
  designatedByName: string;
  endedAt: string;
  endedByName: string | null;
}

export interface ApproverPanelState {
  current: CurrentApproverView[];
  past: PastApproverView[];
  /** Eligible people not designated now: the choices for Designate and Replace. */
  choices: WithdrawalApproverCandidate[];
  /** Whether an owner's own withdrawal can be approved by anyone right now. */
  hasEffectiveApprover: boolean;
  notice: "none_designated" | "none_effective" | null;
  /** No eligible administrator exists at all: the owner must invite one first. */
  needsAdmin: boolean;
}

const roleLabel = (role: "owner" | "admin" | null): string => (role === "owner" ? "Owner" : role === "admin" ? "Admin" : "No longer an admin");

export function approverPanelState(history: readonly WithdrawalApproverDesignation[], candidates: readonly WithdrawalApproverCandidate[]): ApproverPanelState {
  const current = history
    .filter((d) => d.active)
    .map<CurrentApproverView>((d) => ({
      designationId: d.designationId,
      userId: d.userId,
      fullName: d.fullName,
      roleLabel: roleLabel(d.officerRole),
      status: d.eligible ? "active" : "not_eligible",
      statusLabel: d.eligible ? "Active" : "Not eligible",
      statusHelp: d.eligible
        ? null
        : "This person no longer holds an active admin or owner role (or their account is suspended), so they cannot approve withdrawals. Replace or remove this designation.",
      designatedAt: d.startedAt,
      designatedByName: d.designatedByName,
    }));
  const past = history
    .filter((d) => !d.active && d.endedAt !== null)
    .map<PastApproverView>((d) => ({
      designationId: d.designationId,
      fullName: d.fullName,
      designatedAt: d.startedAt,
      designatedByName: d.designatedByName,
      endedAt: d.endedAt!,
      endedByName: d.endedByName,
    }));
  const choices = candidates.filter((c) => !c.designated);
  const hasEffectiveApprover = current.some((c) => c.status === "active");
  return {
    current,
    past,
    choices,
    hasEffectiveApprover,
    notice: current.length === 0 ? "none_designated" : hasEffectiveApprover ? null : "none_effective",
    needsAdmin: candidates.length === 0,
  };
}

/** Friendly text for the database's refusal codes. */
export function approverErrorMessage(code: string): string {
  switch (code) {
    case "FORBIDDEN":
      return "Only a community owner can manage withdrawal approvers.";
    case "WITHDRAWAL_APPROVER_NOT_ELIGIBLE":
      return "That person cannot be designated. Only a current admin or owner of this community, with an active account, can approve withdrawals.";
    case "WITHDRAWAL_APPROVER_SELF":
      return "You cannot designate yourself: nobody approves their own withdrawal.";
    case "WITHDRAWAL_APPROVER_NOT_DESIGNATED":
      return "That designation has already ended. Reload to see the current approvers.";
    case "WITHDRAWAL_APPROVER_ALREADY_DESIGNATED":
      return "That person is already a designated approver.";
    default:
      return "The approver could not be changed. Reload and try again.";
  }
}
