"use client";

import Link from "next/link";
import { Card, CardBody } from "@kolekto/ui";
import type { EventDraft } from "../EventEditor.tsx";
import type { ItemDraft } from "../ItemsEditor.tsx";
import type { QuestionDraft } from "../QuestionsEditor.tsx";
import type { RecurrenceDraft } from "../RecurrenceEditor.tsx";
import type { StoryDraft } from "../StoryEditor.tsx";
import type { TierDraft } from "../TiersEditor.tsx";
import type { FeeBearerChoice } from "../FeeConfigurator.tsx";
import type { CodeDraft } from "./NewCollectionForm.tsx";
import type { Flow } from "./flows.ts";

/**
 * The last step, in the shape of the thing being made (§23).
 *
 * A catalogue is reviewed by looking at the catalogue — the photographs, the
 * prices, what is in stock. An event is reviewed by looking at the event: the
 * flyer, the date, the venue, the ticket types. A campaign is reviewed by
 * reading the story back.
 *
 * The old review was one table of labelled rows for all seven, which told an
 * organiser what fields had been filled in rather than what they had built.
 * Those are different questions, and only the second one catches a mistake.
 */
export function ReviewPanel({
  flow,
  name,
  description,
  coverImageUrl,
  fixedAmount,
  minAmount,
  maxAmount,
  targetAmount,
  suggestedAmounts,
  tiers,
  items,
  event,
  recurrence,
  story,
  questions,
  feeMode,
  codes,
  audienceLabel,
  startsAt,
  deadlineAt,
  previewHref,
}: {
  flow: Flow;
  name: string;
  description: string;
  coverImageUrl: string | null;
  fixedAmount: string;
  minAmount: string;
  maxAmount: string;
  targetAmount: string;
  suggestedAmounts: string[];
  tiers: TierDraft[];
  items: ItemDraft[];
  event: EventDraft;
  recurrence: RecurrenceDraft;
  story: StoryDraft;
  questions: QuestionDraft[];
  feeMode: FeeBearerChoice;
  codes: CodeDraft;
  audienceLabel: string;
  startsAt: string;
  deadlineAt: string;
  previewHref: string | null;
}) {
  return (
    <section className="flex flex-col gap-4">
      {/* Every type leads with its own headline object. */}
      {flow.key === "ticketing" && <EventHeadline name={name} event={event} cover={coverImageUrl} />}
      {flow.key === "fundraiser" && (
        <CampaignHeadline name={name} story={story} target={targetAmount} cover={coverImageUrl} />
      )}
      {flow.key === "items" && <CatalogueHeadline name={name} items={items} cover={coverImageUrl} />}
      {flow.key === "tiered" && <PackagesHeadline name={name} tiers={tiers} cover={coverImageUrl} />}
      {flow.key === "recurring" && <PlanHeadline name={name} amount={fixedAmount} recurrence={recurrence} />}
      {flow.key === "fixed" && <AmountHeadline name={name} amount={fixedAmount} cover={coverImageUrl} />}
      {flow.key === "open" && (
        <OpenHeadline
          name={name}
          min={minAmount}
          max={maxAmount}
          target={targetAmount}
          suggestions={suggestedAmounts}
          cover={coverImageUrl}
        />
      )}

      {description && (
        <Card>
          <CardBody>
            <p className="whitespace-pre-line text-sm text-[var(--color-text-muted)]">{description}</p>
          </CardBody>
        </Card>
      )}

      {/* The three things every type still has to be right about. */}
      <Card>
        <CardBody>
          <dl className="divide-y divide-[var(--color-border)]">
            <Row label={`Who can ${flow.key === "items" ? "order" : flow.key === "ticketing" ? "buy" : "contribute"}`} value={audienceLabel} />
            <Row
              label="Fees"
              value={
                feeMode === "contributor_pays"
                  ? `Added to what the contributor pays`
                  : `Taken out of what you receive`
              }
            />
            <Row
              label="References"
              value={
                codes.enabled
                  ? `On — ${codes.prefix || "no prefix yet"}`
                  : "Off"
              }
            />
            <Row label="Timing" value={describeTiming(flow, startsAt, deadlineAt, event)} />
            {questions.length > 0 && (
              <Row label="You also ask for" value={questions.map((question) => question.label).join(", ")} />
            )}
          </dl>
        </CardBody>
      </Card>

      {previewHref && (
        <Link
          href={previewHref}
          className="self-start text-sm font-medium text-[var(--color-primary)] hover:underline"
        >
          See what your {flow.vocabulary.people} will see →
        </Link>
      )}
    </section>
  );
}

function EventHeadline({ name, event, cover }: { name: string; event: EventDraft; cover: string | null }) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="max-h-56 w-full rounded-[var(--radius-md)] object-cover" />
        ) : (
          <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] px-3 py-6 text-center text-sm text-[var(--color-text-muted)]">
            No flyer. An event page without one is a page people scroll past.
          </p>
        )}
        <div>
          <p className="text-lg font-semibold text-[var(--color-text)]">{name || "Untitled event"}</p>
          <p className="text-sm text-[var(--color-text-muted)]">
            {event.startsAt ? event.startsAt.replace("T", " at ") : "No date yet"}
            {event.venue ? ` · ${event.venue}` : ""}
          </p>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">
          {event.collectAttendeeDetails ? "A name is asked for every ticket." : "Only the buyer's name is asked for."}
        </p>
      </CardBody>
    </Card>
  );
}

function CampaignHeadline({
  name,
  story,
  target,
  cover,
}: {
  name: string;
  story: StoryDraft;
  target: string;
  cover: string | null;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="max-h-56 w-full rounded-[var(--radius-md)] object-cover" />
        )}
        <p className="text-lg font-semibold text-[var(--color-text)]">{name || "Untitled campaign"}</p>
        {target && (
          <p className="text-sm text-[var(--color-text-muted)]">
            Working toward <span className="font-semibold text-[var(--color-text)]">₦{target}</span>
          </p>
        )}
        {story.what ? (
          <p className="whitespace-pre-line text-sm text-[var(--color-text)]">{story.what}</p>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">
            No story yet. It is the thing that decides whether somebody gives.
          </p>
        )}
        {story.impact && (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">What a gift funds</p>
            <p className="whitespace-pre-line text-sm text-[var(--color-text)]">{story.impact}</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function CatalogueHeadline({ name, items, cover }: { name: string; items: ItemDraft[]; cover: string | null }) {
  const real = items.filter((item) => item.name.trim() !== "");
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-lg font-semibold text-[var(--color-text)]">{name || "Untitled catalogue"}</p>
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="max-h-40 w-full rounded-[var(--radius-md)] object-cover" />
        )}
        <ul className="grid gap-2 sm:grid-cols-2">
          {real.map((item, index) => (
            <li
              key={item.id ?? index}
              className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2"
            >
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.imageUrl}
                  alt=""
                  className="h-14 w-14 flex-shrink-0 rounded-[var(--radius-sm)] object-cover"
                />
              ) : (
                <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
                  No photo
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[var(--color-text)]">{item.name}</span>
                <span className="block text-xs text-[var(--color-text-muted)]">
                  ₦{item.price}
                  {item.quantityAvailable?.trim() ? ` · ${item.quantityAvailable} available` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
        {real.some((item) => !item.imageUrl) && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Items without a photo still sell — they just sell less. You can add one later.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function PackagesHeadline({ name, tiers, cover }: { name: string; tiers: TierDraft[]; cover: string | null }) {
  const real = tiers.filter((tier) => tier.name.trim() !== "");
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-lg font-semibold text-[var(--color-text)]">{name || "Untitled collection"}</p>
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="max-h-40 w-full rounded-[var(--radius-md)] object-cover" />
        )}
        <ul className="flex flex-col gap-2">
          {real.map((tier, index) => (
            <li
              key={tier.id ?? index}
              className="flex items-start justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--color-text)]">{tier.name}</span>
                {tier.description && (
                  <span className="block text-xs text-[var(--color-text-muted)]">{tier.description}</span>
                )}
                {tier.codePrefix && (
                  <span className="block font-mono text-xs text-[var(--color-text-muted)]">
                    {tier.codePrefix.toUpperCase()}-0001
                  </span>
                )}
              </span>
              <span className="whitespace-nowrap text-sm font-semibold text-[var(--color-text)]">₦{tier.price}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function PlanHeadline({
  name,
  amount,
  recurrence,
}: {
  name: string;
  amount: string;
  recurrence: RecurrenceDraft;
}) {
  const every =
    Number(recurrence.intervalCount) > 1
      ? `every ${recurrence.intervalCount} ${recurrence.frequency.replace(/ly$/, "")}s`
      : `every ${recurrence.frequency.replace(/ly$/, "")}`;

  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <p className="text-lg font-semibold text-[var(--color-text)]">{name || "Untitled plan"}</p>
        <p className="text-2xl font-semibold text-[var(--color-text)]">
          ₦{amount || "—"} <span className="text-sm font-normal text-[var(--color-text-muted)]">{every}</span>
        </p>
        <p className="text-sm text-[var(--color-text-muted)]">
          {recurrence.startsOn ? `First period starts ${recurrence.startsOn}. ` : ""}
          {Number(recurrence.dueAfterDays) > 0
            ? `Due ${recurrence.dueAfterDays} days after each period opens.`
            : "Due as soon as each period opens."}
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">
          Each period is asked for separately. Nothing is charged automatically — you open each period yourself.
        </p>
      </CardBody>
    </Card>
  );
}

function AmountHeadline({ name, amount, cover }: { name: string; amount: string; cover: string | null }) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="max-h-40 w-full rounded-[var(--radius-md)] object-cover" />
        )}
        <p className="text-lg font-semibold text-[var(--color-text)]">{name || "Untitled collection"}</p>
        <p className="text-2xl font-semibold text-[var(--color-text)]">₦{amount || "—"}</p>
        <p className="text-sm text-[var(--color-text-muted)]">The same amount from everyone.</p>
      </CardBody>
    </Card>
  );
}

function OpenHeadline({
  name,
  min,
  max,
  target,
  suggestions,
  cover,
}: {
  name: string;
  min: string;
  max: string;
  target: string;
  suggestions: string[];
  cover: string | null;
}) {
  const real = suggestions.map((amount) => amount.trim()).filter((amount) => amount !== "");
  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="max-h-40 w-full rounded-[var(--radius-md)] object-cover" />
        )}
        <p className="text-lg font-semibold text-[var(--color-text)]">{name || "Untitled collection"}</p>
        <p className="text-sm text-[var(--color-text)]">
          {min || max
            ? `People give between ₦${min || "any"} and ₦${max || "any"}.`
            : "People give whatever they choose."}
        </p>
        {real.length > 0 && (
          <p className="text-sm text-[var(--color-text-muted)]">
            One tap for {real.map((amount) => `₦${amount}`).join(" · ")}
          </p>
        )}
        {target && <p className="text-sm text-[var(--color-text-muted)]">Working toward ₦{target}</p>}
      </CardBody>
    </Card>
  );
}

/** The timing sentence, in the vocabulary the flow used to ask for it (§21). */
function describeTiming(flow: Flow, startsAt: string, deadlineAt: string, event: EventDraft): string {
  switch (flow.timing) {
    case "none":
      return "No closing date — a plan that repeats does not close";
    case "sales_window":
      return [
        startsAt ? `Sales open ${startsAt.replace("T", " ")}` : "Sales open on publishing",
        deadlineAt ? `close ${deadlineAt.replace("T", " ")}` : "no closing date",
        event.startsAt ? `event ${event.startsAt.replace("T", " ")}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "order_window":
      return [
        startsAt ? `Orders open ${startsAt.replace("T", " ")}` : "Orders open on publishing",
        deadlineAt ? `close ${deadlineAt.replace("T", " ")}` : "no closing date",
      ].join(" · ");
    case "campaign_end":
      return deadlineAt ? `Ends ${deadlineAt.replace("T", " ")}` : "No end date";
    default:
      return deadlineAt ? `Closes ${deadlineAt.replace("T", " ")}` : "No closing date";
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-2">
      <dt className="text-sm text-[var(--color-text-muted)]">{label}</dt>
      <dd className="text-sm font-medium text-[var(--color-text)]">{value}</dd>
    </div>
  );
}
