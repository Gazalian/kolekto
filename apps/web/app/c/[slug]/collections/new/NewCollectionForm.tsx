"use client";

import { Banner, Button, SelectField, TextAreaField, TextField } from "@kolekto/ui";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { MemberGroup } from "@kolekto/db";
import type { CollectionAudienceMode } from "@kolekto/validation";
import { AMOUNT_MODEL_LABEL } from "../../../../../lib/collection-display.ts";
import { AudiencePicker, AUDIENCE_LABELS } from "../AudiencePicker.tsx";
import {
  createCollectionAction,
  setCollectionAudienceAction,
  setCollectionEventAction,
  setCollectionFieldsAction,
  setCollectionItemsAction,
  setCollectionRecurrenceAction,
  setCollectionSuggestedAmountsAction,
  setCollectionTiersAction,
} from "../actions.ts";
import { EventEditor, emptyEvent, type EventDraft } from "../EventEditor.tsx";
import { emptyItem, ItemsEditor, itemsToPayload, type ItemDraft } from "../ItemsEditor.tsx";
import { emptyRecurrence, RecurrenceEditor, type RecurrenceDraft } from "../RecurrenceEditor.tsx";
import { SuggestedAmountsEditor } from "../SuggestedAmountsEditor.tsx";
import { emptyTier, TiersEditor, type TierDraft } from "../TiersEditor.tsx";
import { QuestionsEditor, questionsToFields, type QuestionDraft } from "../QuestionsEditor.tsx";

/**
 * Creating a collection, as a conversation rather than a form.
 *
 * The configuration axes the database stores (participation, amount model,
 * payment plan, schedule — PRD 4.1) are not how an organiser thinks. They think
 * "I am collecting dues", "I am selling tickets", "I am taking aso-ebi orders".
 * Each intent below is a preset over those axes plus the configuration that
 * only that kind of collection needs — an event has a venue, an order has
 * items, a service charge repeats.
 *
 * That is why there is no `collection_type` column: a template decides which
 * questions get asked, and the answers are stored as the columns and rows the
 * database can actually check. Nothing here is a display label standing in for
 * a domain fact.
 *
 * Every step shows only what the previous answers made relevant. Nothing is
 * saved until the last step, and what is saved is a draft.
 */

type AmountModelKey = "fixed" | "open_amount" | "tiers" | "per_member" | "items";

interface Intent {
  key: string;
  title: string;
  description: string;
  category: "dues" | "contribution" | "event" | "fundraiser" | "items" | "other";
  participationMode: "open" | "managed";
  amountModel: AmountModelKey;
  schedule: "one_time" | "recurring";
  /** What this kind of collection additionally has to say. */
  collects?: {
    event?: boolean;
    recurrence?: boolean;
    suggestions?: boolean;
    target?: boolean;
  };
  /** Shown above the contribution step, in the organiser's own terms. */
  contributionHeading: string;
}

const INTENTS: Intent[] = [
  {
    key: "dues",
    title: "Dues or a levy",
    description: "One set amount from a list of members you manage, so you can see who has not paid.",
    category: "dues",
    participationMode: "managed",
    amountModel: "fixed",
    schedule: "one_time",
    contributionHeading: "How much does each member pay?",
  },
  {
    key: "recurring",
    title: "A charge that repeats",
    description: "A service charge or subscription billed every month, quarter or year, per period.",
    category: "dues",
    participationMode: "managed",
    amountModel: "fixed",
    schedule: "recurring",
    collects: { recurrence: true },
    contributionHeading: "How much, and how often?",
  },
  {
    key: "contribution",
    title: "An open contribution",
    description: "People give what they can, within limits you set.",
    category: "contribution",
    participationMode: "open",
    amountModel: "open_amount",
    schedule: "one_time",
    collects: { suggestions: true },
    contributionHeading: "What may people contribute?",
  },
  {
    key: "fundraiser",
    title: "Fundraiser",
    description: "Any amount, toward a target you are working to.",
    category: "fundraiser",
    participationMode: "open",
    amountModel: "open_amount",
    schedule: "one_time",
    collects: { suggestions: true, target: true },
    contributionHeading: "What may people give?",
  },
  {
    key: "tiers",
    title: "Options at different prices",
    description: "A few named options — levels, packages, categories — and the contributor picks one.",
    category: "contribution",
    participationMode: "open",
    amountModel: "tiers",
    schedule: "one_time",
    contributionHeading: "What are the options?",
  },
  {
    key: "event",
    title: "Tickets for an event",
    description: "Ticket types at different prices, for something happening on a date, at a place.",
    category: "event",
    participationMode: "open",
    amountModel: "tiers",
    schedule: "one_time",
    collects: { event: true },
    contributionHeading: "What tickets are you selling?",
  },
  {
    key: "items",
    title: "Items or packages",
    description: "Things people order and pay for — aso-ebi, a kit, a package — each with its own stock.",
    category: "items",
    participationMode: "open",
    amountModel: "items",
    schedule: "one_time",
    contributionHeading: "What are you selling?",
  },
  {
    key: "custom",
    title: "Something else",
    description: "Set how people contribute yourself.",
    category: "other",
    participationMode: "open",
    amountModel: "fixed",
    schedule: "one_time",
    contributionHeading: "How should people contribute?",
  },
];

const STEPS = ["Purpose", "Details", "Contribution", "Who pays", "Questions", "Review"] as const;

export function NewCollectionForm({
  slug,
  communityId,
  memberCount,
  groups,
}: {
  slug: string;
  communityId: string;
  memberCount: number;
  groups: MemberGroup[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [draftHref, setDraftHref] = useState<string | null>(null);

  const [intent, setIntent] = useState<Intent>(INTENTS[0]!);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deadlineAt, setDeadlineAt] = useState("");
  const [amountModel, setAmountModel] = useState<AmountModelKey>(INTENTS[0]!.amountModel);
  const [participationMode, setParticipationMode] = useState<Intent["participationMode"]>(
    INTENTS[0]!.participationMode,
  );
  const [fixedAmount, setFixedAmount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [suggestedAmounts, setSuggestedAmounts] = useState<string[]>([]);
  const [tiers, setTiers] = useState<TierDraft[]>([emptyTier()]);
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [eventDraft, setEventDraft] = useState<EventDraft>(emptyEvent());
  const [recurrence, setRecurrence] = useState<RecurrenceDraft>(emptyRecurrence());
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [visibility, setVisibility] = useState<"public" | "unlisted">("unlisted");
  const [audienceMode, setAudienceMode] = useState<CollectionAudienceMode>(
    INTENTS[0]!.participationMode === "open" ? "public" : "all_members",
  );
  const [audienceGroupIds, setAudienceGroupIds] = useState<string[]>([]);

  const collects = intent.collects ?? {};

  function chooseIntent(next: Intent): void {
    setIntent(next);
    setAmountModel(next.amountModel);
    setParticipationMode(next.participationMode);
    setAudienceMode(next.participationMode === "open" ? "public" : "all_members");
    setStep(1);
  }

  const canContinue = (() => {
    switch (step) {
      case 1:
        return name.trim().length >= 3;
      case 2:
        if (amountModel === "fixed") return fixedAmount.trim() !== "";
        if (amountModel === "tiers") return tiers.every((tier) => tier.name.trim() !== "" && tier.price.trim() !== "");
        if (amountModel === "items") return items.every((item) => item.name.trim() !== "" && item.price.trim() !== "");
        return true;
      default:
        return true;
    }
  })();

  function submit(): void {
    setError(null);
    startTransition(async () => {
      const created = await createCollectionAction(slug, {
        communityId,
        name,
        description: description || undefined,
        category: intent.category,
        participationMode,
        amountModel,
        schedule: intent.schedule,
        fixedAmount: amountModel === "fixed" ? fixedAmount : "",
        minAmount: amountModel === "open_amount" ? minAmount : "",
        maxAmount: amountModel === "open_amount" ? maxAmount : "",
        targetAmount,
        deadlineAt,
        visibility,
      });

      if (created.error || !created.collectionId || !created.collectionSlug) {
        setError(created.error ?? "Could not create the collection");
        return;
      }

      const { collectionId, collectionSlug } = created;
      const href = `/c/${slug}/collections/${collectionSlug}`;
      setDraftHref(href);

      /** Everything after creation edits a draft that already exists, so a failure leaves the draft to be finished by hand rather than losing the work. */
      const save = async (what: string, run: () => Promise<{ error?: string }>): Promise<boolean> => {
        const result = await run();
        if (result.error) {
          setError(`The draft was created, but ${what} was not saved: ${result.error}`);
          return false;
        }
        return true;
      };

      // The collection is created with the audience its participation mode
      // implies — public, or all members. Anything narrower is a second,
      // explicit decision, and still creates no obligation for anyone.
      if (audienceMode === "groups" || audienceMode === "selected_members") {
        const ok = await save("who it is for", () =>
          setCollectionAudienceAction(slug, collectionSlug, { collectionId, audienceMode, groupIds: audienceGroupIds }),
        );
        if (!ok) return;
      }

      if (amountModel === "tiers") {
        const ok = await save("the options", () =>
          setCollectionTiersAction(slug, collectionSlug, {
            collectionId,
            tiers: tiers.map((tier, index) => ({
              name: tier.name.trim(),
              ...(tier.description?.trim() ? { description: tier.description.trim() } : {}),
              price: tier.price.trim(),
              ...(tier.quantityLimit?.trim() ? { quantityLimit: Number(tier.quantityLimit.trim()) } : {}),
              sortOrder: index,
            })),
          }),
        );
        if (!ok) return;
      }

      if (amountModel === "items") {
        const ok = await save("the items", () =>
          setCollectionItemsAction(slug, collectionSlug, { collectionId, items: itemsToPayload(items) }),
        );
        if (!ok) return;
      }

      if (collects.event && (eventDraft.startsAt || eventDraft.venue)) {
        const ok = await save("the event details", () =>
          setCollectionEventAction(slug, collectionSlug, {
            collectionId,
            eventStartsAt: eventDraft.startsAt,
            eventEndsAt: eventDraft.endsAt,
            venue: eventDraft.venue,
          }),
        );
        if (!ok) return;
      }

      const suggestions = suggestedAmounts.map((amount) => amount.trim()).filter((amount) => amount !== "");
      if (collects.suggestions && suggestions.length > 0) {
        const ok = await save("the suggested amounts", () =>
          setCollectionSuggestedAmountsAction(slug, collectionSlug, { collectionId, amounts: suggestions }),
        );
        if (!ok) return;
      }

      if (collects.recurrence) {
        const ok = await save("the schedule", () =>
          setCollectionRecurrenceAction(slug, collectionSlug, {
            collectionId,
            frequency: recurrence.frequency,
            intervalCount: Number(recurrence.intervalCount) || 1,
            ...(recurrence.startsOn ? { startsOn: recurrence.startsOn } : {}),
            dueAfterDays: Number(recurrence.dueAfterDays) || 0,
          }),
        );
        if (!ok) return;
      }

      const fields = questionsToFields(questions);
      if (fields.length > 0) {
        const ok = await save("the questions", () =>
          setCollectionFieldsAction(slug, collectionSlug, { collectionId, fields }),
        );
        if (!ok) return;
      }

      router.push(href);
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href={`/c/${slug}/collections`} className="text-xs font-medium text-[var(--color-text-muted)] hover:underline">
          ← Collections
        </Link>
        <h1 className="text-xl font-semibold text-[var(--color-text)]">New collection</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Step {step + 1} of {STEPS.length} · {STEPS[step]}
        </p>
      </div>

      <ol className="flex gap-1" aria-label="Progress">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            className={
              index <= step
                ? "h-1 flex-1 rounded-full bg-[var(--color-primary)]"
                : "h-1 flex-1 rounded-full bg-[var(--color-border)]"
            }
          />
        ))}
      </ol>

      {step === 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">What are you collecting for?</h2>
          {INTENTS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => chooseIntent(option)}
              className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left transition-colors hover:border-[var(--color-border-strong)]"
            >
              <span className="font-medium text-[var(--color-text)]">{option.title}</span>
              <span className="text-sm text-[var(--color-text-muted)]">{option.description}</span>
            </button>
          ))}
        </section>
      )}

      {step === 1 && (
        <section className="flex flex-col gap-4">
          <TextField
            label="What is this collection called?"
            hint="Contributors see this. e.g. CS 300 Class Dues 2026"
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
          <TextAreaField
            label="What is it for?"
            hint="Optional. Shown on the public page, so contributors know what they are paying for."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <TextField
            label="Deadline"
            type="datetime-local"
            hint={
              collects.event
                ? "Optional. When ticket sales close — not when the event is."
                : "Optional. After this, the collection stops accepting contributions."
            }
            value={deadlineAt}
            onChange={(event) => setDeadlineAt(event.target.value)}
          />
        </section>
      )}

      {step === 2 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">{intent.contributionHeading}</h2>

          {intent.key === "custom" && (
            <SelectField
              label="Contribution type"
              value={amountModel}
              onChange={(event) => setAmountModel(event.target.value as AmountModelKey)}
            >
              <option value="fixed">Everyone pays the same amount</option>
              <option value="open_amount">Contributors choose the amount</option>
              <option value="tiers">Options to choose from</option>
              <option value="items">Items with prices and stock</option>
              <option value="per_member">A different amount per member</option>
            </SelectField>
          )}

          {amountModel === "fixed" && (
            <TextField
              label="Amount each person pays"
              placeholder="e.g. 5000"
              hint={collects.recurrence ? "In naira, per period." : "In naira. 5,000 and 5k both work."}
              value={fixedAmount}
              required
              onChange={(event) => setFixedAmount(event.target.value)}
            />
          )}

          {collects.recurrence && <RecurrenceEditor recurrence={recurrence} onChange={setRecurrence} />}

          {amountModel === "open_amount" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Smallest contribution"
                  hint="Optional."
                  value={minAmount}
                  onChange={(event) => setMinAmount(event.target.value)}
                />
                <TextField
                  label="Largest contribution"
                  hint="Optional."
                  value={maxAmount}
                  onChange={(event) => setMaxAmount(event.target.value)}
                />
              </div>
              {collects.suggestions && (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-[var(--color-text)]">Suggested amounts</h3>
                  <SuggestedAmountsEditor amounts={suggestedAmounts} onChange={setSuggestedAmounts} />
                </div>
              )}
            </>
          )}

          {amountModel === "tiers" && <TiersEditor tiers={tiers} onChange={setTiers} />}

          {amountModel === "items" && <ItemsEditor items={items} onChange={setItems} />}

          {collects.event && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-[var(--color-text)]">The event itself</h3>
              <EventEditor event={eventDraft} onChange={setEventDraft} />
            </div>
          )}

          {amountModel === "per_member" && (
            <p className="text-sm text-[var(--color-text-muted)]">
              You will set each member&apos;s amount when you add them to this collection.
            </p>
          )}

          {(collects.target || intent.key === "custom") && (
            <TextField
              label="Target"
              hint="Optional. Shown as what the collection is working toward — not an amount received."
              value={targetAmount}
              onChange={(event) => setTargetAmount(event.target.value)}
            />
          )}
        </section>
      )}

      {step === 3 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Who is expected to contribute?</h2>

          <p className="text-sm text-[var(--color-text-muted)]">
            This community has {memberCount} member{memberCount === 1 ? "" : "s"}. Choosing a group or the whole roll
            does not ask anyone for money yet — you add the obligations yourself, once the collection is published.
          </p>

          <AudiencePicker
            value={audienceMode}
            groups={groups}
            selectedGroupIds={audienceGroupIds}
            allowPublic={amountModel !== "per_member" && intent.schedule !== "recurring"}
            onChange={(mode) => {
              setAudienceMode(mode);
              setParticipationMode(mode === "public" ? "open" : "managed");
            }}
            onGroupsChange={setAudienceGroupIds}
          />

          <SelectField
            label="Visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as "public" | "unlisted")}
            hint={
              visibility === "public"
                ? "Listed on your community page as well as reachable by link."
                : "Reachable by link only. Not listed anywhere."
            }
          >
            <option value="unlisted">Link only</option>
            <option value="public">Listed publicly</option>
          </SelectField>
        </section>
      )}

      {step === 4 && (
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Anything else to ask contributors?</h2>
            <p className="text-sm text-[var(--color-text-muted)]">
              Their name and contact details are always collected. Add a question only if you need something else — a
              matric number, a size, a unit.
            </p>
          </div>
          <QuestionsEditor questions={questions} onChange={setQuestions} />
        </section>
      )}

      {step === 5 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Check this over</h2>
          <dl className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
            <Row label="Name" value={name} />
            <Row label="For" value={description || "—"} />
            <Row label="Contribution" value={AMOUNT_MODEL_LABEL[amountModel] ?? amountModel} />
            {amountModel === "fixed" && <Row label="Amount" value={fixedAmount} />}
            {collects.recurrence && (
              <Row
                label="Repeats"
                value={`${recurrence.frequency}, every ${recurrence.intervalCount || "1"}`}
              />
            )}
            {amountModel === "tiers" && (
              <Row label="Options" value={tiers.map((tier) => `${tier.name} — ${tier.price}`).join(", ")} />
            )}
            {amountModel === "items" && (
              <Row label="Items" value={items.map((item) => `${item.name} — ${item.price}`).join(", ")} />
            )}
            {collects.event && (eventDraft.startsAt || eventDraft.venue) && (
              <Row label="Event" value={[eventDraft.startsAt, eventDraft.venue].filter(Boolean).join(" · ")} />
            )}
            {amountModel === "open_amount" && (minAmount || maxAmount) && (
              <Row label="Range" value={`${minAmount || "any"} to ${maxAmount || "any"}`} />
            )}
            {collects.suggestions && suggestedAmounts.some((amount) => amount.trim() !== "") && (
              <Row label="Suggested" value={suggestedAmounts.filter((amount) => amount.trim() !== "").join(", ")} />
            )}
            {targetAmount && <Row label="Target" value={targetAmount} />}
            <Row label="Who it is for" value={AUDIENCE_LABELS[audienceMode].title} />
            <Row label="Deadline" value={deadlineAt || "None"} />
            <Row label="Questions" value={questions.length === 0 ? "None" : questions.map((q) => q.label).join(", ")} />
          </dl>

          <p className="text-sm text-[var(--color-text-muted)]">
            This saves a draft. Nothing is public and no link works until you publish it.
            {collects.recurrence && " No period is opened and nobody owes anything yet."}
          </p>
        </section>
      )}

      {error && (
        <Banner tone="danger">
          {error}
          {draftHref && (
            <>
              {" "}
              <Link href={draftHref} className="font-medium underline">
                Open the draft
              </Link>
            </>
          )}
        </Banner>
      )}

      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          disabled={step === 0 || isPending}
          onClick={() => setStep((current) => Math.max(0, current - 1))}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
        </Button>

        {step === STEPS.length - 1 ? (
          <Button type="button" loading={isPending} onClick={submit}>
            <Check className="h-4 w-4" aria-hidden="true" /> Save as draft
          </Button>
        ) : (
          step > 0 && (
            <Button
              type="button"
              disabled={!canContinue}
              onClick={() => setStep((current) => Math.min(STEPS.length - 1, current + 1))}
            >
              Continue <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          )
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 px-4 py-2.5">
      <dt className="text-sm text-[var(--color-text-muted)]">{label}</dt>
      <dd className="text-sm font-medium text-[var(--color-text)]">{value}</dd>
    </div>
  );
}
