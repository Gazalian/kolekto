"use client";

import { Badge, Banner, Button, Card, CardBody, Dialog, Spinner, TextField } from "@kolekto/ui";
import { useCallback, useEffect, useState, useTransition } from "react";
import { formatDistanceToNow } from "../../../../../lib/format.ts";
import {
  loadRemindersAction,
  sendRemindersAction,
  type ReminderRowView,
  type ReminderSummaryView,
} from "./money-actions.ts";

/**
 * Payment reminders to members who have not paid (design:
 * docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md §7).
 *
 * Who has paid, who can be reminded and why not are all decided by the
 * database; this panel shows the answer and sends the organiser's selection.
 * Nothing is sent without a confirmation, nothing is sent automatically, and a
 * member reminded in the last 24 hours cannot be reminded again.
 */

type Filter = "unpaid" | "reminded" | "paid" | "all";
const PAGE = 50;

const BLOCKED: Record<NonNullable<ReminderRowView["blockedReason"]>, string> = {
  paid: "Paid",
  exempt: "Exempt",
  opted_out: "Opted out of reminders",
  no_contact: "No email or Kolekto account",
  cooldown: "Reminded in the last 24 hours",
};

const EMAIL_STATUS: Record<string, string> = {
  pending: "email queued",
  sending: "email sending",
  sent: "email sent",
  delivered: "email delivered",
  skipped: "email not sent",
  failed: "email failed",
  dead: "email failed",
};

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function RemindersPanel({ slug, collectionSlug }: { slug: string; collectionSlug: string }) {
  const [filter, setFilter] = useState<Filter>("unpaid");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [summary, setSummary] = useState<ReminderSummaryView | null>(null);
  const [rows, setRows] = useState<ReminderRowView[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [key, setKey] = useState(newKey);
  const [message, setMessage] = useState<{ tone: "danger" | "success" | "info"; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const result = await loadRemindersAction(slug, collectionSlug, { filter, search: query, offset });
      if (result.error || !result.summary) {
        setLoadError(result.error ?? "Reminders could not be loaded.");
        return;
      }
      setLoadError(null);
      setSummary(result.summary);
      setRows(result.rows ?? []);
      setTotal(result.total ?? 0);
    });
  }, [slug, collectionSlug, filter, query, offset]);

  useEffect(load, [load]);

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function send(ids: string[]): void {
    setMessage(null);
    startTransition(async () => {
      const result = await sendRemindersAction(slug, collectionSlug, { memberIds: ids, idempotencyKey: key });
      setConfirm(null);
      setKey(newKey());
      if (result.error) {
        setMessage({ tone: "danger", text: result.error });
        return;
      }
      const skipped = result.skipped!;
      const notes = [
        skipped.paid && `${skipped.paid} already paid`,
        skipped.cooldown && `${skipped.cooldown} reminded in the last 24 hours`,
        skipped.unreachable && `${skipped.unreachable} with no way to reach them`,
        skipped.ineligible && `${skipped.ineligible} no longer on this collection`,
      ].filter(Boolean);
      setMessage({
        tone: result.sent ? "success" : "info",
        text:
          (result.sent
            ? `Reminder sent to ${result.sent} member${result.sent === 1 ? "" : "s"}.`
            : "Nobody was reminded.") + (notes.length ? ` Skipped: ${notes.join(", ")}.` : ""),
      });
      setSelected(new Set());
      load();
    });
  }

  if (loadError) return <Banner tone="danger">{loadError}</Banner>;
  if (!summary) {
    return (
      <div className="flex justify-center py-8">
        <Spinner label="Loading reminders" />
      </div>
    );
  }

  if (!summary.supported) {
    return (
      <Banner tone="info">
        {summary.unsupportedReason === "recurring_collection"
          ? "Payment reminders for recurring collections are not available yet."
          : "This collection is open to anyone with the link, so there is no member list to remind."}
      </Banner>
    );
  }

  const remindableOnPage = rows.filter((r) => r.canRemind).map((r) => r.memberId);
  const canSend = summary.canSend && summary.collectionActive;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Count label="Members" value={summary.eligibleCount} />
        <Count label="Paid" value={summary.paidCount} />
        <Count label="Not paid" value={summary.unpaidCount} />
        <Count label="Can be reminded now" value={summary.remindableNowCount} />
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        {summary.remindersSent === 0
          ? "No reminders sent yet."
          : `${summary.remindersSent} reminder${summary.remindersSent === 1 ? "" : "s"} sent${summary.lastSentAt ? `, last ${formatDistanceToNow(summary.lastSentAt)}` : ""}.`}{" "}
        A reminder goes to the member&apos;s Kolekto inbox if they have an account, and by email unless they opted out.
        Each member can be reminded at most once a day.
        {summary.exemptCount > 0 && ` ${summary.exemptCount} exempt member${summary.exemptCount === 1 ? " is" : "s are"} never reminded.`}
      </p>

      {!summary.collectionActive && <Banner tone="info">Reminders can be sent while the collection is taking payments.</Banner>}
      {summary.collectionActive && !summary.canSend && (
        <Banner tone="info">Sending reminders needs the reminder permission (owner, admin, treasurer or collector).</Banner>
      )}
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter members">
            {(["unpaid", "reminded", "paid", "all"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => {
                  setFilter(f);
                  setOffset(0);
                  setSelected(new Set());
                }}
                className={
                  filter === f
                    ? "rounded-full bg-[var(--color-text)] px-3 py-1 text-xs font-medium text-[var(--color-surface)]"
                    : "rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text-muted)]"
                }
              >
                {{ unpaid: "Not paid", reminded: "Reminded", paid: "Paid", all: "Everyone" }[f]}
              </button>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setOffset(0);
              setQuery(search.trim());
            }}
          >
            <TextField label="Search by name or member ID" value={search} onChange={(event) => setSearch(event.target.value)} />
          </form>

          {canSend && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={selected.size === 0} onClick={() => setConfirm([...selected])}>
                Remind selected ({selected.size})
              </Button>
              <Button size="sm" variant="secondary" disabled={remindableOnPage.length === 0} onClick={() => setConfirm(remindableOnPage)}>
                Remind everyone on this page ({remindableOnPage.length})
              </Button>
            </div>
          )}

          {isPending && rows.length === 0 ? (
            <Spinner label="Loading" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">Nobody here.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {rows.map((r) => (
                <li key={r.memberId} className="flex items-start gap-3 py-2">
                  {canSend && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.fullName}`}
                      className="mt-1 h-4 w-4"
                      disabled={!r.canRemind}
                      checked={selected.has(r.memberId)}
                      onChange={() => toggle(r.memberId)}
                    />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-[var(--color-text)]">{r.fullName}</span>
                      {r.memberCode && <span className="font-mono text-xs text-[var(--color-text-muted)]">{r.memberCode}</span>}
                      {r.paid ? (
                        <Badge tone="success">Paid</Badge>
                      ) : r.exempt ? (
                        <Badge>Exempt</Badge>
                      ) : (
                        <Badge tone="warning">Not paid</Badge>
                      )}
                    </div>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {r.reminderCount > 0
                        ? `Reminded ${r.reminderCount}× · last ${formatDistanceToNow(r.lastRemindedAt!)}${r.lastEmailStatus ? ` · ${EMAIL_STATUS[r.lastEmailStatus] ?? r.lastEmailStatus}` : ""}`
                        : "Not reminded"}
                      {r.blockedReason && r.blockedReason !== "paid" && r.blockedReason !== "exempt" && ` · ${BLOCKED[r.blockedReason]}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {total > PAGE && (
            <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
              <span>
                {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  Previous
                </Button>
                <Button size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {confirm && (
        <Dialog open onClose={() => setConfirm(null)} title={`Remind ${confirm.length} member${confirm.length === 1 ? "" : "s"}?`}>
          <div className="flex flex-col gap-3 text-sm text-[var(--color-text)]">
            <p>
              They will be told they haven&apos;t contributed to this collection yet, with a link to pay. Anyone who has paid
              by the time it is sent is skipped automatically.
            </p>
            <p className="text-xs text-[var(--color-text-muted)]">
              Each member can be reminded once every 24 hours. Members who opted out of reminders get no email.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button loading={isPending} onClick={() => send(confirm)}>
                Send reminder
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Go back
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-[var(--color-text)]">{value.toLocaleString()}</p>
    </div>
  );
}
