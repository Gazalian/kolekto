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
import { useState, useTransition } from "react";
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
import { transitionCollectionStatusAction } from "../actions.ts";
import { ObligationsPanel } from "./ObligationsPanel.tsx";
import { CheckInPanel, type CheckInPerson } from "./CheckInPanel.tsx";
import { ExportPanel } from "./ExportPanel.tsx";
import type { ExportFieldChoice } from "./export-fields.ts";
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

export interface AssignableMember {
  id: string;
  fullName: string;
  identifier: string | null;
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
  obligations,
  assignableMembers,
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
  obligations: ObligationRow[];
  assignableMembers: AssignableMember[];
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

  const status = collection.status as CollectionStatus;
  const publicUrl = typeof window === "undefined" ? "" : `${window.location.origin}${collectionPath(communitySlug, collection.slug)}`;
  const isLive = status === "active" || status === "paused" || status === "closed" || status === "scheduled";

  function runTransition(target: CollectionStatus): void {
    setError(null);
    startTransition(async () => {
      const result = await transitionCollectionStatusAction(slug, collection.slug, {
        collectionId: collection.id,
        expected: collection.status,
        target,
      });
      if (result.error) setError(result.error);
      setPendingTarget(null);
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
              {actionsFor(status).map((action) => (
                <Button
                  key={action.target}
                  variant={action.variant ?? "primary"}
                  disabled={isPending}
                  onClick={() => setPendingTarget(action.target)}
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
                {isManaged && <Row label="Members expected" value={String(obligations.length)} />}
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
          obligations={obligations}
          assignableMembers={assignableMembers}
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
              issuedCount={obligations.filter((row) => row.reference !== null).length}
              rollCount={obligations.filter((row) => row.obligation.status !== "cancelled").length}
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
          onClose={() => setPendingTarget(null)}
          title={TRANSITION_COPY[pendingTarget]?.title ?? "Change status"}
          description={TRANSITION_COPY[pendingTarget]?.body ?? ""}
        >
          <div className="flex flex-col gap-4">
            {pendingTarget === "active" && status === "draft" && (
              <dl className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
                <Row label="Name" value={collection.name} />
                <Row label="Contribution" value={describeAmount(collection)} />
                <Row label="Who can pay" value={PARTICIPATION_LABEL[collection.participation_mode] ?? ""} />
                <Row label="Deadline" value={collection.deadline_at ? formatDate(collection.deadline_at) : "None"} />
                <Row label="Address" value={collectionPath(communitySlug, collection.slug)} />
              </dl>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPendingTarget(null)} disabled={isPending}>
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
