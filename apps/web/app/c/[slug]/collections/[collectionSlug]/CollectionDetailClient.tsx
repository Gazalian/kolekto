"use client";

import type {
  AuditLog,
  Collection,
  CollectionCycleRow,
  CollectionField,
  CollectionItem,
  CollectionRecurrence,
  CollectionCodeSettings,
  CollectionTier,
  MemberGroup,
  Obligation,
} from "@kolekto/db";
import { Badge, Banner, Button, Card, CardBody, Dialog } from "@kolekto/ui";
import { Copy, ExternalLink, Share2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import {
  AMOUNT_MODEL_LABEL,
  CATEGORY_LABEL,
  collectionPath,
  describeAmount,
  formatDate,
  naira,
  PARTICIPATION_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  type CollectionStatus,
} from "../../../../../lib/collection-display.ts";
import { formatDistanceToNow } from "../../../../../lib/format.ts";
import {
  previewPublishRecipientsAction,
  publishCollectionAction,
  sendCollectionReminderAction,
  transitionCollectionStatusAction,
  announceCollectionUpdateAction,
} from "../actions.ts";
import type { AnnouncementRecipientPreview } from "@kolekto/db";
import { ObligationsPanel } from "./ObligationsPanel.tsx";
import { CheckInPanel, type CheckInPerson } from "./CheckInPanel.tsx";
import { ExportPanel } from "./ExportPanel.tsx";
import type { ExportFieldChoice } from "./export-fields.ts";
import type { RollCounts } from "./roll.ts";
import { CodeSettingsPanel } from "./CodeSettingsPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";

export interface ObligationRow {
  obligation: Obligation;
  memberName: string;
  memberIdentifier: string | null;
  /** "BIO26-0042", when this collection issues references (M7.6). */
  reference: string | null;
  /** Which option they were put down for, on a tiered collection. */
  tierName: string | null;
}

export interface CollectionPermissions {
  canEdit: boolean;
  canPublish: boolean;
  canAssign: boolean;
  canExempt: boolean;
  canShare: boolean;
  canExport: boolean;
  canCheckIn: boolean;
  canConfigureCodes: boolean;
}

/** The transitions an officer can reach from here, in the order a person would want them. Mirrors app.transition_collection_status, which is what actually decides. */
function actionsFor(status: CollectionStatus): { target: CollectionStatus; label: string; variant?: "secondary" | "danger" }[] {
  switch (status) {
    case "draft":
      return [{ target: "active", label: "Review and publish" }];
    case "scheduled":
    case "active":
      return [
        { target: "paused", label: "Pause", variant: "secondary" },
        { target: "closed", label: "Close", variant: "secondary" },
      ];
    case "paused":
      return [
        { target: "active", label: "Resume" },
        { target: "closed", label: "Close", variant: "secondary" },
      ];
    case "closed":
      return [{ target: "archived", label: "Archive", variant: "secondary" }];
    default:
      return [];
  }
}

const TRANSITION_COPY: Partial<Record<CollectionStatus, { title: string; body: string; confirm: string }>> = {
  active: {
    title: "Publish this collection?",
    body: "The link starts working and anyone who has it can open the page. You can pause it at any time.",
    confirm: "Publish",
  },
  paused: {
    title: "Pause this collection?",
    body: "The page stays reachable and explains that contributions are paused. Resume whenever you are ready.",
    confirm: "Pause",
  },
  closed: {
    title: "Close this collection?",
    body: "Closing is final: the collection stops accepting contributions and cannot be reopened. Its record is kept.",
    confirm: "Close",
  },
  archived: {
    title: "Archive this collection?",
    body: "It moves out of your active list. The record, including who was expected to pay, is kept and stays readable.",
    confirm: "Archive",
  },
};

export function CollectionDetailClient({
  slug,
  communitySlug,
  collection,
  tiers,
  fields,
  items,
  recurrence,
  cycles,
  roll,
  rollCounts,
  referenceCount,
  audienceGroups,
  audienceCounts,
  activity,
  exportCustomFields,
  exportGroups,
  codeSettings,
  checkInPeople,
  checkInTotals,
  permissions,
}: {
  slug: string;
  communitySlug: string;
  collection: Collection;
  tiers: CollectionTier[];
  fields: CollectionField[];
  items: CollectionItem[];
  recurrence: CollectionRecurrence | null;
  cycles: CollectionCycleRow[];
  /** The first page of the roll. The rest is fetched by the panel (M7.6 hardening). */
  roll: ObligationRow[];
  rollCounts: RollCounts;
  /** How many references this collection has issued, counted by the database. */
  referenceCount: number;
  audienceGroups: string[];
  audienceCounts: { eligible: number; with_obligation: number; awaiting: number };
  activity: AuditLog[];
  exportCustomFields: ExportFieldChoice[];
  exportGroups: MemberGroup[];
  codeSettings: CollectionCodeSettings | null;
  checkInPeople: CheckInPerson[];
  checkInTotals: { expected: number; inside: number; left: number; notArrived: number };
  permissions: CollectionPermissions;
}) {
  const isManaged = collection.participation_mode === "managed";
  const isEvent = collection.category === "event";
  const isTiered = collection.amount_model === "tiers";
  const isRecurring = collection.schedule === "recurring";

  /**
   * The sections this collection actually has (M7.6 part C).
   *
   * A ticketed event is worked from a door, an item collection from a
   * catalogue, a fundraiser from a story — and none of them is worked from
   * the same table. What differs is the vocabulary as much as the set: the
   * same roll is "Members" on a dues collection, "Attendees" at an event and
   * "Orders" on an item collection, because that is what the people in it
   * are. A tab that says nothing about the collection it belongs to is a tab
   * an organiser has to open to find out whether it is for them.
   */
  const rollLabel = isEvent ? "Attendees" : collection.amount_model === "items" ? "Orders" : "Members";

  const tabs = [
    { key: "overview", label: "Overview" },
    ...(isManaged ? [{ key: "members", label: rollLabel }] : []),
    ...(isEvent ? [{ key: "checkin", label: "Check-in" }] : []),
    { key: "export", label: "Exports" },
    { key: "activity", label: "Activity" },
    { key: "settings", label: "Settings" },
  ] as const;

  const [tab, setTab] = useState<(typeof tabs)[number]["key"]>("overview");
  const [pendingTarget, setPendingTarget] = useState<CollectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  /**
   * The host's publish-time notification target: 'all' notifies the
   * collection's members (in-app for account holders, email from the member
   * record for everyone eligible); 'none' publishes without notifying.
   * "Members who have not paid" is not offered: payment status cannot be
   * established (no payments are recorded), see RecipientPreview below.
   */
  const [notifyMode, setNotifyMode] = useState<NotifyMode>("all");
  const [recipientPreview, setRecipientPreview] = useState<RecipientPreview>({ kind: "idle" });

  // Post-publish reminder dialog state (20261029100000). Opened from the
  // "Send reminder" button for an active or scheduled collection. The
  // dialog's own component owns the local form state (choice, submission,
  // outcome) so the parent only decides when the dialog is open.
  const [reminderOpen, setReminderOpen] = useState(false);
  // Member announcements: "Announce changes" is an explicit organiser action;
  // editing a collection never notifies anyone by itself.
  const [announceOpen, setAnnounceOpen] = useState(false);

  const status = collection.status as CollectionStatus;
  const publicUrl = typeof window === "undefined" ? "" : `${window.location.origin}${collectionPath(communitySlug, collection.slug)}`;
  const isLive = status === "active" || status === "paused" || status === "closed" || status === "scheduled";
  const isPublishDialog = pendingTarget === "active" && status === "draft";

  // Fetch the recipient preview when the publish dialog opens, so the host
  // sees who would be notified before confirming. The reset path lives in
  // `closePendingDialog` below (called from Cancel / Dialog onClose) so this
  // effect only runs an async fetch — a `setRecipientPreview` here would
  // trip react-hooks/set-state-in-effect. `loading` is set synchronously by
  // closePendingDialog's inverse — opening — which runs the fetch next tick.
  useEffect(() => {
    if (!isPublishDialog) return;
    let cancelled = false;
    (async () => {
      const result = await previewPublishRecipientsAction(collection.id);
      if (cancelled) return;
      if ("error" in result) {
        setRecipientPreview({ kind: "error", message: result.error });
      } else {
        setRecipientPreview({ kind: "ready", ...result });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPublishDialog, collection.id]);

  function openPendingDialog(target: CollectionStatus): void {
    setPendingTarget(target);
    // Opening the publish dialog resets the host's choice back to the default
    // (notify everyone) and shows a loading state until the preview fetch
    // completes. Setting state in an event handler is allowed — only the
    // effect-body setState would trip the lint rule.
    if (target === "active" && status === "draft") {
      setNotifyMode("all");
      setRecipientPreview({ kind: "loading" });
    }
  }

  function closePendingDialog(): void {
    setPendingTarget(null);
    setRecipientPreview({ kind: "idle" });
    setNotifyMode("all");
  }

  function runTransition(target: CollectionStatus): void {
    setError(null);
    startTransition(async () => {
      // Publishing from draft goes through the host-facing publish action so
      // the notify choice is honoured; every other transition uses the
      // ordinary status-transition path (no notification side effect).
      const result = target === "active" && status === "draft"
        ? await publishCollectionAction(slug, collection.slug, {
            collectionId: collection.id,
            expected: "draft" as const,
            notifyTarget: notifyMode,
          })
        : await transitionCollectionStatusAction(slug, collection.slug, {
            collectionId: collection.id,
            expected: collection.status,
            target,
          });
      if (result.error) setError(result.error);
      closePendingDialog();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href={`/c/${slug}/collections`} className="text-xs font-medium text-[var(--color-text-muted)] hover:underline">
          ← Collections
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-[var(--color-text)]">{collection.name}</h1>
            <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
          </div>
          {permissions.canPublish && (
            <div className="flex flex-wrap gap-2">
              {(status === "active" || status === "scheduled") && (
                <Button
                  variant="secondary"
                  disabled={isPending}
                  onClick={() => setReminderOpen(true)}
                >
                  Send reminder
                </Button>
              )}
              {(status === "active" || status === "scheduled" || status === "paused") && (
                <Button
                  variant="secondary"
                  disabled={isPending}
                  onClick={() => setAnnounceOpen(true)}
                >
                  Announce changes
                </Button>
              )}
              {actionsFor(status).map((action) => (
                <Button
                  key={action.target}
                  variant={action.variant ?? "primary"}
                  disabled={isPending}
                  onClick={() => openPendingDialog(action.target)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        <p className="text-sm text-[var(--color-text-muted)]">
          {CATEGORY_LABEL[collection.category] ?? collection.category} · {AMOUNT_MODEL_LABEL[collection.amount_model]}
        </p>
      </div>

      {error && <Banner tone="danger">{error}</Banner>}

      <nav className="flex gap-1 border-b border-[var(--color-border)]" aria-label="Collection sections">
        {tabs.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setTab(option.key)}
            aria-current={tab === option.key ? "page" : undefined}
            className={
              tab === option.key
                ? "-mb-px border-b-2 border-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-text)]"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }
          >
            {option.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="flex flex-col gap-4">
          {/* The honest state of this build. A collection can be configured,
              published and shared; money cannot move yet (ADR 0006), and no
              screen here shows an amount received, because none exists. */}
          <Banner tone="info">
            Online payment is not switched on yet, so no contribution has been recorded against any collection. What you
            see here is what this collection asks for, never what has been received.
          </Banner>

          {status === "draft" && (
            <Banner tone="info">
              This is a draft. Its link does not work and nobody outside your officers can see it.{" "}
              {permissions.canEdit && (
                <Link
                  href={`/c/${slug}/collections/${collection.slug}/continue`}
                  className="font-medium underline"
                >
                  Carry on setting it up
                </Link>
              )}
            </Banner>
          )}

          {/* M7.5 part B: the same components the public page renders, from
              this collection's own rows — not a summary that can drift. */}
          <Link
            href={`/c/${slug}/collections/${collection.slug}/preview`}
            className="self-start text-sm font-medium text-[var(--color-primary)] hover:underline"
          >
            Preview as a contributor →
          </Link>

          {isLive && (
            <Card>
              <CardBody className="flex flex-col gap-3">
                <div>
                  <p className="text-sm font-medium text-[var(--color-text)]">Share this collection</p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    One address, and it does not change when you rename the collection.
                  </p>
                </div>
                <ShareRow url={publicUrl} name={collection.name} canShare={permissions.canShare} />
              </CardBody>
            </Card>
          )}

          {collection.cover_image_url && (
            // An uploaded flyer on the storage host, not a bundled asset.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={collection.cover_image_url}
              alt=""
              className="max-h-64 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] object-cover"
            />
          )}

          <Card>
            <CardBody>
              <dl className="divide-y divide-[var(--color-border)]">
                <Row label="Contribution" value={describeAmount(collection)} />
                <Row label="Who can pay" value={PARTICIPATION_LABEL[collection.participation_mode] ?? ""} />
                <Row label="Target" value={collection.target_amount_kobo ? naira(collection.target_amount_kobo) : "None"} />
                {/* The event is a separate fact from the collection's own dates:
                    tickets sell for weeks, the dinner is one evening. */}
                {collection.event_starts_at && (
                  <Row label="Event" value={formatDate(collection.event_starts_at)} />
                )}
                {collection.venue && <Row label="Venue" value={collection.venue} />}
                <Row label="Opens" value={collection.starts_at ? formatDate(collection.starts_at) : "Immediately"} />
                <Row label="Deadline" value={collection.deadline_at ? formatDate(collection.deadline_at) : "None"} />
                {recurrence && (
                  <Row
                    label="Repeats"
                    value={`${recurrence.frequency}${recurrence.interval_count > 1 ? ` (every ${recurrence.interval_count})` : ""}`}
                  />
                )}
                {recurrence && (
                  <Row
                    label="Periods opened"
                    value={cycles.length === 0 ? "None yet" : cycles.map((cycle) => cycle.cycle_key).join(", ")}
                  />
                )}
                <Row label="Visibility" value={collection.visibility === "public" ? "Listed publicly" : "Link only"} />
                {isManaged && <Row label="Members expected" value={String(rollCounts.all)} />}
              </dl>
            </CardBody>
          </Card>

          {collection.suggested_amounts_kobo.length > 0 && (
            <Card>
              <CardBody className="flex flex-col gap-2">
                <p className="text-sm font-medium text-[var(--color-text)]">Suggested amounts</p>
                <p className="text-sm text-[var(--color-text-muted)]">
                  {collection.suggested_amounts_kobo.map((amount) => naira(amount)).join(" · ")}
                </p>
              </CardBody>
            </Card>
          )}

          {items.length > 0 && (
            <Card>
              <CardBody className="flex flex-col gap-2">
                <p className="text-sm font-medium text-[var(--color-text)]">Items</p>
                <ul className="flex flex-col gap-1">
                  {items.map((item) => (
                    <li key={item.id} className="flex justify-between gap-3 text-sm">
                      <span className={item.hidden ? "text-[var(--color-text-faint)] line-through" : "text-[var(--color-text)]"}>
                        {item.name}
                        {item.hidden && " (hidden)"}
                        {item.quantity_available !== null && (
                          <span className="text-[var(--color-text-muted)]"> · {item.quantity_available} available</span>
                        )}
                      </span>
                      <span className="text-[var(--color-text-muted)]">{naira(item.price_kobo)}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          {collection.description && (
            <Card>
              <CardBody className="flex flex-col gap-1">
                <p className="text-sm font-medium text-[var(--color-text)]">What this is for</p>
                <p className="whitespace-pre-line text-sm text-[var(--color-text-muted)]">{collection.description}</p>
              </CardBody>
            </Card>
          )}

          {tiers.length > 0 && (
            <Card>
              <CardBody className="flex flex-col gap-2">
                <p className="text-sm font-medium text-[var(--color-text)]">Options</p>
                <ul className="flex flex-col gap-1">
                  {tiers.map((tier) => (
                    <li key={tier.id} className="flex justify-between gap-3 text-sm">
                      <span className={tier.hidden ? "text-[var(--color-text-faint)] line-through" : "text-[var(--color-text)]"}>
                        {tier.name}
                        {tier.hidden && " (hidden)"}
                      </span>
                      <span className="text-[var(--color-text-muted)]">{naira(tier.price_kobo)}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          {fields.length > 0 && (
            <Card>
              <CardBody className="flex flex-col gap-2">
                <p className="text-sm font-medium text-[var(--color-text)]">Questions contributors are asked</p>
                <ul className="flex flex-col gap-1 text-sm text-[var(--color-text-muted)]">
                  {fields.map((field) => (
                    <li key={field.id}>
                      {field.label}
                      {field.required && " (required)"}
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </div>
      )}

      {tab === "members" && (
        <ObligationsPanel
          slug={slug}
          collection={collection}
          firstPage={roll}
          initialCounts={rollCounts}
          audienceGroups={audienceGroups}
          audienceCounts={audienceCounts}
          // The period being charged for: the most recent one still open. The
          // rows arrive newest first, so the first unclosed one is that period.
          openCycleKey={cycles.find((cycle) => cycle.closed_at === null)?.cycle_key ?? null}
          tiers={tiers}
          canAssign={permissions.canAssign}
          canExempt={permissions.canExempt}
        />
      )}

      {tab === "checkin" && (
        <CheckInPanel
          slug={slug}
          collectionSlug={collection.slug}
          people={checkInPeople}
          totals={checkInTotals}
          canCheckIn={permissions.canCheckIn}
        />
      )}

      {tab === "export" && (
        <ExportPanel
          slug={slug}
          collectionSlug={collection.slug}
          customFields={exportCustomFields}
          groups={exportGroups}
          tiers={tiers}
          cycles={cycles}
          isEvent={isEvent}
          isTiered={isTiered}
          isRecurring={isRecurring}
          canExport={permissions.canExport}
        />
      )}

      {tab === "activity" && (
        <Card>
          <CardBody>
            {activity.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">Nothing has happened to this collection yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {activity.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap justify-between gap-2 text-sm">
                    <span className="text-[var(--color-text)]">
                      {entry.action.replace("collection.", "").replace(/_/g, " ")} — {entry.actor_name_snapshot}
                      {entry.reason && (
                        <span className="block text-xs text-[var(--color-text-muted)]">{entry.reason}</span>
                      )}
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)]">{formatDistanceToNow(entry.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {tab === "settings" && (
        <div className="flex flex-col gap-4">
          {isManaged && (
            <CodeSettingsPanel
              slug={slug}
              collection={collection}
              settings={codeSettings}
              tiers={tiers}
              issuedCount={referenceCount}
              rollCount={rollCounts.all}
              canConfigure={permissions.canConfigureCodes}
              canIssue={permissions.canAssign}
            />
          )}
          <SettingsPanel
          slug={slug}
          collection={collection}
          tiers={tiers}
          fields={fields}
          items={items}
          recurrence={recurrence}
          cycles={cycles}
          canEdit={permissions.canEdit}
        />
        </div>
      )}

      {pendingTarget && (
        <Dialog
          open
          onClose={closePendingDialog}
          title={TRANSITION_COPY[pendingTarget]?.title ?? "Change status"}
          description={TRANSITION_COPY[pendingTarget]?.body ?? ""}
        >
          <div className="flex flex-col gap-4">
            {isPublishDialog && (
              <dl className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
                <Row label="Name" value={collection.name} />
                <Row label="Contribution" value={describeAmount(collection)} />
                <Row label="Who can pay" value={PARTICIPATION_LABEL[collection.participation_mode] ?? ""} />
                <Row label="Deadline" value={collection.deadline_at ? formatDate(collection.deadline_at) : "None"} />
                <Row label="Address" value={collectionPath(communitySlug, collection.slug)} />
              </dl>
            )}
            {isPublishDialog && (
              <PublishNotifyControls
                mode={notifyMode}
                onChange={setNotifyMode}
                preview={recipientPreview}
                disabled={isPending}
              />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closePendingDialog} disabled={isPending}>
                Cancel
              </Button>
              <Button
                variant={pendingTarget === "closed" || pendingTarget === "archived" ? "danger" : "primary"}
                loading={isPending}
                onClick={() => runTransition(pendingTarget)}
              >
                {TRANSITION_COPY[pendingTarget]?.confirm ?? "Confirm"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {reminderOpen && (
        <SendReminderDialog
          collectionId={collection.id}
          collectionName={collection.name}
          onClose={() => setReminderOpen(false)}
        />
      )}

      {announceOpen && (
        <AnnounceUpdateDialog
          collectionId={collection.id}
          collectionName={collection.name}
          communityGroups={exportGroups}
          onClose={() => setAnnounceOpen(false)}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-2">
      <dt className="text-sm text-[var(--color-text-muted)]">{label}</dt>
      <dd className="text-sm font-medium text-[var(--color-text)]">{value}</dd>
    </div>
  );
}

/**
 * Publish-time notification controls.
 *
 * Members are community records, not accounts. A notification reaches:
 *   · in-app — members who have a Kolekto account (`eligible`);
 *   · email — members whose record has a usable email address and who have
 *     not opted out, once an owner or admin has confirmed the community's
 *     communication notice (M13.3; consent is not required). Counts come from
 *     app.preview_collection_announcement_recipients (`email`). Null until
 *     that function is installed.
 * Counts are shown before sending and say "queued", never "delivered".
 *
 * "Only members who have not paid" is deliberately NOT offered. Kolekto does
 * not record payments yet (no contributions, cash or transfers are entered,
 * and no obligation is ever marked paid), so such a list would include people
 * who have already paid.
 */
type RecipientPreview =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ready";
      eligible: number;
      with_obligation: number;
      awaiting: number;
      email: AnnouncementRecipientPreview | null;
    }
  | { kind: "error"; message: string };

type NotifyMode = "all" | "none";

/** Why "members who have not paid" is unavailable. One sentence, used by every dialog. */
const UNPAID_UNAVAILABLE =
  "Kolekto does not record payments yet, so it cannot tell who has paid. Sending to “members who have not paid” could reach people who already paid in cash or by transfer.";

/** Who an announcement reaches, by channel, and why the rest are skipped. Counts only — never addresses. */
function AnnouncementReach({ preview }: { preview: RecipientPreview }) {
  if (preview.kind === "loading") return <p className="text-xs text-[var(--color-text-muted)]">Counting recipients…</p>;
  if (preview.kind === "error") {
    return (
      <p className="text-xs text-[var(--color-danger)]" role="alert">
        Could not load the recipient preview: {preview.message}
      </p>
    );
  }
  if (preview.kind !== "ready") return null;
  const e = preview.email;
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-sm)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
      <p>
        <strong className="font-semibold text-[var(--color-text)]">In-app:</strong> {preview.eligible}{" "}
        {preview.eligible === 1 ? "member has" : "members have"} a Kolekto account.
      </p>
      {e === null ? (
        <p>
          <strong className="font-semibold text-[var(--color-text)]">Email:</strong> email to members is not available yet.
          Members do not need an account to be reached by email once it is.
        </p>
      ) : (
        <>
          <p>
            <strong className="font-semibold text-[var(--color-text)]">Email:</strong> {e.emailEligible} of {e.audienceTotal}{" "}
            {e.audienceTotal === 1 ? "member" : "members"} can be emailed at the address on their member record (no account needed).
          </p>
          {!e.collectionReachable && (
            <p>
              No email will be sent: this collection’s page cannot be opened without an account (it is members-only, or the community
              is not active). Make it public or unlisted to email members a link.
            </p>
          )}
          {e.collectionReachable && e.startsLater && (
            <p>No email will be sent while the collection has not started: its page opens on the start date.</p>
          )}
          {!e.communityNoticeAttested && e.skippedNoticeMissing > 0 && (
            <p>
              No community email will be sent yet: an owner or admin has not confirmed that members were told how their contact
              details are used for community messages ({e.skippedNoticeMissing}{" "}
              {e.skippedNoticeMissing === 1 ? "member" : "members"} waiting).
            </p>
          )}
          <SkipLine count={e.skippedOptedOut} text="have opted out of these messages" />
          <SkipLine count={e.skippedNoEmail} text="have no email address on their member record" />
          <SkipLine count={e.skippedInvalidEmail} text="have an email address that is not valid" />
          <SkipLine count={e.skippedUnverifiedAccount} text="have an account whose email is not confirmed" />
          <p>Emails are queued when you confirm and sent only once email delivery is switched on.</p>
        </>
      )}
    </div>
  );
}

function SkipLine({ count, text }: { count: number; text: string }) {
  if (count === 0) return null;
  return (
    <p>
      Not emailed: {count} {count === 1 ? "member" : "members"} {text}.
    </p>
  );
}

function UnpaidUnavailableNote() {
  return (
    <div className="flex items-start gap-3 opacity-70">
      <input type="radio" disabled className="mt-1" aria-label="Only members who have not paid (unavailable)" />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-[var(--color-text)]">Only members who have not paid — not available</span>
        <span className="text-xs text-[var(--color-text-muted)]">{UNPAID_UNAVAILABLE}</span>
      </span>
    </div>
  );
}

function PublishNotifyControls({
  mode,
  onChange,
  preview,
  disabled,
}: {
  mode: NotifyMode;
  onChange: (next: NotifyMode) => void;
  preview: RecipientPreview;
  disabled: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
      <legend className="px-1 text-sm font-medium text-[var(--color-text)]">
        Notify members on publish
      </legend>
      <label className="flex items-start gap-3">
        <input
          type="radio"
          name="notify-mode"
          value="all"
          checked={mode === "all"}
          onChange={() => onChange("all")}
          disabled={disabled}
          className="mt-1"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-[var(--color-text)]">Announce to all members of this collection</span>
          <span className="text-xs text-[var(--color-text-muted)]">
            Members get the collection name, details, deadline and a link to pay. No account is needed to open it.
          </span>
        </span>
      </label>
      <UnpaidUnavailableNote />
      <label className="flex items-start gap-3">
        <input
          type="radio"
          name="notify-mode"
          value="none"
          checked={mode === "none"}
          onChange={() => onChange("none")}
          disabled={disabled}
          className="mt-1"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-[var(--color-text)]">Publish without notifying</span>
          <span className="text-xs text-[var(--color-text-muted)]">
            The collection goes live immediately; no notification is sent. You can share the link yourself.
          </span>
        </span>
      </label>
      {mode === "all" && <AnnouncementReach preview={preview} />}
    </fieldset>
  );
}

function ShareRow({ url, name, canShare }: { url: string; name: string; canShare: boolean }) {
  const [copied, setCopied] = useState(false);
  const message = `${name} — contribute here: ${url}`;

  return (
    <div className="flex flex-col gap-2">
      <code className="block overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text)]">
        {url}
      </code>
      {canShare && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            <Copy className="h-4 w-4" aria-hidden="true" /> {copied ? "Copied" : "Copy link"}
          </Button>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(message)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg)]"
          >
            <Share2 className="h-4 w-4" aria-hidden="true" /> WhatsApp
          </a>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg)]"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open page
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * SendReminderDialog — post-publish reminders (20261029100000).
 *
 * Opened from the "Send reminder" button on a published (active or scheduled)
 * collection. The organiser picks who to notify, previews the count server-
 * side, then submits. The server function
 * `app.send_collection_publish_reminder` is idempotent on an `idempotencyKey`
 * generated here when the dialog opens — a double-click or re-submission with
 * the same key returns the previously-recorded audit event without enqueuing
 * a second notification. A fresh dialog open mints a new key, so a later
 * reminder goes through on its own.
 *
 * "No notification" is a client-side cancel. It never calls the server, so no
 * event, no delivery row and no audit entry are created — unlike publish, no
 * audit action is written for it.
 */
function SendReminderDialog({
  collectionId,
  collectionName,
  onClose,
}: {
  collectionId: string;
  collectionName: string;
  onClose: () => void;
}) {
  // crypto.randomUUID is a browser native; this is a client component and
  // the dialog never renders during server rendering (parent gates on
  // reminderOpen = false initially).
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `rk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [mode, setMode] = useState<NotifyMode>("all");
  const [preview, setPreview] = useState<RecipientPreview>({ kind: "loading" });
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "sent"; recipients: number; reused: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await previewPublishRecipientsAction(collectionId, "reminder");
      if (cancelled) return;
      if ("error" in result) {
        setPreview({ kind: "error", message: result.error });
      } else {
        setPreview({ kind: "ready", ...result });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collectionId]);

  const queued = queuedCounts(preview);
  const isBusy = state.kind === "submitting";
  const alreadySent = state.kind === "sent";

  async function onSubmit(): Promise<void> {
    if (isBusy || alreadySent) return;
    if (mode === "none") {
      // "No notification" is a cancel. It is not a successful send.
      onClose();
      return;
    }
    setState({ kind: "submitting" });
    const result = await sendCollectionReminderAction({
      collectionId,
      notifyTarget: mode,
      idempotencyKey,
    });
    if ("error" in result) {
      setState({ kind: "error", message: result.error });
      return;
    }
    setState({
      kind: "sent",
      recipients: queued.inApp + queued.email,
      reused: !result.created,
    });
  }

  const dialogTitle = `Send a reminder for ${collectionName}`;

  return (
    <Dialog
      open
      onClose={isBusy ? () => undefined : onClose}
      title={dialogTitle}
      description="Remind this collection’s members about it. The reminder does not say anyone owes money — Kolekto cannot tell who has paid yet."
    >
      <div className="flex flex-col gap-4">
        {state.kind !== "sent" && (
          <fieldset className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
            <legend className="px-1 text-sm font-medium text-[var(--color-text)]">Who should be notified?</legend>
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="reminder-mode"
                value="all"
                checked={mode === "all"}
                onChange={() => setMode("all")}
                disabled={isBusy}
                className="mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-[var(--color-text)]">All members of this collection</span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  In-app for members with an account, and email for members who can be emailed.
                </span>
              </span>
            </label>
            <UnpaidUnavailableNote />
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="reminder-mode"
                value="none"
                checked={mode === "none"}
                onChange={() => setMode("none")}
                disabled={isBusy}
                className="mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-[var(--color-text)]">No notification</span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  Close this dialog without sending anything. You can share the link yourself.
                </span>
              </span>
            </label>
            {mode === "all" && <AnnouncementReach preview={preview} />}
          </fieldset>
        )}

        {state.kind === "sent" && (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
            <p className="text-sm font-medium text-[var(--color-text)]">
              {state.reused
                ? "This reminder was already sent."
                : `Reminder queued for ${state.recipients} ${state.recipients === 1 ? "recipient" : "recipients"}.`}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Queued is not delivered: in-app notifications appear as they are processed, and emails are sent only once email
              delivery is switched on.
            </p>
          </div>
        )}

        {state.kind === "error" && (
          <p className="text-xs text-[var(--color-danger)]" role="alert">
            {state.message}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {state.kind === "sent" ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={isBusy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={isBusy}
                disabled={preview.kind === "loading"}
                onClick={onSubmit}
              >
                {mode === "none" ? "Close without notifying" : "Send reminder"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** In-app and email counts the organiser is about to queue. Email is 0 when not available or not reachable. */
function queuedCounts(preview: RecipientPreview): { inApp: number; email: number } {
  if (preview.kind !== "ready") return { inApp: 0, email: 0 };
  const e = preview.email;
  const email = e && e.collectionReachable && !e.startsLater ? e.emailEligible : 0;
  return { inApp: preview.eligible, email };
}

const CHANGE_OPTIONS: { value: "name" | "description" | "deadline" | "start_date" | "story" | "other"; label: string }[] = [
  { value: "deadline", label: "Payment deadline" },
  { value: "description", label: "Description" },
  { value: "name", label: "Collection name" },
  { value: "start_date", label: "Start date" },
  { value: "story", label: "Collection details or instructions" },
  { value: "other", label: "Something else" },
];

/**
 * AnnounceUpdateDialog — member announcements.
 *
 * The organiser tells members that a live collection changed. Nothing is sent
 * when a collection is edited; this dialog is the only way, and the organiser
 * chooses what to announce from a fixed list (no free text reaches members).
 * The email shows the collection's current details and links to its page.
 * Idempotent on a key minted when the dialog opens.
 */
type AnnounceAudience = "default" | "all_members" | "groups" | "selected_members";

function AnnounceUpdateDialog({
  collectionId,
  collectionName,
  communityGroups,
  onClose,
}: {
  collectionId: string;
  collectionName: string;
  communityGroups: MemberGroup[];
  onClose: () => void;
}) {
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `ak-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [changed, setChanged] = useState<string[]>([]);
  const [message, setMessage] = useState<string>("");
  const [audience, setAudience] = useState<AnnounceAudience>("default");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<RecipientPreview>({ kind: "loading" });
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "sent"; recipients: number; reused: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await previewPublishRecipientsAction(collectionId, "update");
      if (cancelled) return;
      if ("error" in result) setPreview({ kind: "error", message: result.error });
      else setPreview({ kind: "ready", ...result });
    })();
    return () => {
      cancelled = true;
    };
  }, [collectionId]);

  const isBusy = state.kind === "submitting";
  const unavailable = preview.kind === "ready" && preview.email === null;
  const trimmedMessage = message.trim();
  const messageOverLimit = trimmedMessage.length > 1000;
  const needsGroups = audience === "groups" && groupIds.length === 0;
  const canSubmit = changed.length > 0 && !messageOverLimit && !needsGroups;

  function toggle(value: string): void {
    setChanged((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  function toggleGroup(id: string): void {
    setGroupIds((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  }

  async function onSubmit(): Promise<void> {
    if (isBusy || state.kind === "sent" || !canSubmit) return;
    setState({ kind: "submitting" });
    const result = await announceCollectionUpdateAction({
      collectionId,
      changedFields: changed,
      idempotencyKey,
      customMessage: trimmedMessage.length > 0 ? trimmedMessage : undefined,
      targetAudience: audience === "default" ? undefined : audience,
      targetGroupIds: audience === "groups" ? groupIds : [],
    });
    if ("error" in result && result.error) {
      setState({ kind: "error", message: result.error });
      return;
    }
    const q = queuedCounts(preview);
    setState({ kind: "sent", recipients: q.inApp + q.email, reused: "created" in result && result.created === false });
  }

  const activeGroups = communityGroups.filter((g) => g.archived_at === null);

  return (
    <Dialog
      open
      onClose={isBusy ? () => undefined : onClose}
      title={`Announce changes to ${collectionName}`}
      description="Tell this collection’s members what changed. Editing a collection never notifies anyone on its own."
    >
      <div className="flex flex-col gap-4">
        {state.kind !== "sent" && (
          <>
            <fieldset className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
              <legend className="px-1 text-sm font-medium text-[var(--color-text)]">What changed?</legend>
              {CHANGE_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-3 text-sm text-[var(--color-text)]">
                  <input
                    type="checkbox"
                    checked={changed.includes(option.value)}
                    onChange={() => toggle(option.value)}
                    disabled={isBusy}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>

            <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
              <label htmlFor="announce-message" className="text-sm font-medium text-[var(--color-text)]">
                Message (optional)
              </label>
              <textarea
                id="announce-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={isBusy}
                maxLength={1200}
                rows={4}
                placeholder="Add a short note for members. Email addresses are removed before sending."
                className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)]"
              />
              <p className={`text-xs ${messageOverLimit ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}>
                {trimmedMessage.length}/1000 characters. The email will also carry a “View &amp; pay” button linking to this collection.
              </p>
            </div>

            <fieldset className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
              <legend className="px-1 text-sm font-medium text-[var(--color-text)]">Who receives this</legend>
              {(
                [
                  { value: "default", label: "This collection’s current audience" },
                  { value: "all_members", label: "All members of the community" },
                  { value: "groups", label: "Members in selected groups" },
                  { value: "selected_members", label: "Only members who already have an obligation on this collection" },
                ] as { value: AnnounceAudience; label: string }[]
              ).map((option) => (
                <label key={option.value} className="flex items-center gap-3 text-sm text-[var(--color-text)]">
                  <input
                    type="radio"
                    name="announce-audience"
                    checked={audience === option.value}
                    onChange={() => setAudience(option.value)}
                    disabled={isBusy}
                  />
                  {option.label}
                </label>
              ))}

              {audience === "groups" && (
                <div className="mt-2 flex flex-col gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3">
                  <p className="text-xs font-medium text-[var(--color-text-muted)]">Groups</p>
                  {activeGroups.length === 0 ? (
                    <p className="text-xs text-[var(--color-text-muted)]">This community has no groups yet.</p>
                  ) : (
                    activeGroups.map((g) => (
                      <label key={g.id} className="flex items-center gap-3 text-sm text-[var(--color-text)]">
                        <input
                          type="checkbox"
                          checked={groupIds.includes(g.id)}
                          onChange={() => toggleGroup(g.id)}
                          disabled={isBusy}
                        />
                        {g.name}
                      </label>
                    ))
                  )}
                  {needsGroups && (
                    <p className="text-xs text-[var(--color-danger)]">Choose at least one group.</p>
                  )}
                </div>
              )}

              <p className="text-xs text-[var(--color-text-muted)]">
                “Members who have not paid” is not available. {UNPAID_UNAVAILABLE}
              </p>
              <AnnouncementReach preview={preview} />
            </fieldset>
          </>
        )}

        {state.kind === "sent" && (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
            <p className="text-sm font-medium text-[var(--color-text)]">
              {state.reused
                ? "This announcement was already sent."
                : `Announcement queued for ${state.recipients} ${state.recipients === 1 ? "recipient" : "recipients"}.`}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Queued is not delivered: emails are sent only once email delivery is switched on.
            </p>
          </div>
        )}

        {state.kind === "error" && (
          <p className="text-xs text-[var(--color-danger)]" role="alert">
            {state.message}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {state.kind === "sent" ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={isBusy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={isBusy}
                disabled={preview.kind === "loading" || !canSubmit || unavailable}
                onClick={onSubmit}
              >
                {unavailable ? "Not available yet" : "Send announcement"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
