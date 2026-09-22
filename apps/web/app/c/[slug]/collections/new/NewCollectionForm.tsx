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
  rememberStepAction,
  setCollectionAudienceAction,
  setCollectionEventAction,
  setCollectionFieldsAction,
  setCollectionItemsAction,
  setCollectionRecurrenceAction,
  setCollectionStoryAction,
  setCollectionSuggestedAmountsAction,
  setCollectionTiersAction,
  updateCollectionAction,
} from "../actions.ts";
import { CoverUploader } from "../CoverUploader.tsx";
import { EventEditor, emptyEvent, type EventDraft } from "../EventEditor.tsx";
import { emptyItem, ItemsEditor, itemsToPayload, type ItemDraft } from "../ItemsEditor.tsx";
import { emptyRecurrence, RecurrenceEditor, type RecurrenceDraft } from "../RecurrenceEditor.tsx";
import { emptyStory, StoryEditor, type StoryDraft } from "../StoryEditor.tsx";
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
 * Every step shows only what the previous answers made relevant, and every
 * step saves as it is completed (M7.5 part A) — the draft is a real
 * collection row from the Details step onward, so closing the browser
 * halfway loses nothing. What exists is always a draft: no link works and
 * nothing is public until it is published.
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
    story?: boolean;
  };
  /** Shown above the contribution step, in the organiser's own terms. */
  contributionHeading: string;
  /**
   * What the seven steps are called for THIS kind of collection (M7.6 part
   * A1: "do not force every collection type into exactly the same wizard").
   *
   * The positions are shared because what they write is shared — the same
   * row, the same audience rows, the same questions — but what they ASK
   * differs, and so does what they should be called. Step three is "Tickets"
   * when you are selling tickets and "Your story" when you are raising money,
   * because that is what is on the screen.
   */
  steps?: readonly string[];
}

const INTENTS: Intent[] = [
  {
    key: "dues",
    steps: ["Purpose", "Basics", "Amount", "Cover image", "Who pays", "Questions", "Review"],
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
    steps: ["Purpose", "Basics", "Amount and schedule", "Cover image", "Who pays", "Questions", "Review"],
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
    steps: ["Purpose", "Basics", "What people may give", "Cover image", "Who can give", "Questions", "Review"],
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
    steps: ["Purpose", "The cause", "Story and target", "Cover image", "Who can give", "Questions", "Review"],
    title: "Fundraiser",
    description: "Any amount, toward a target you are working to.",
    category: "fundraiser",
    participationMode: "open",
    amountModel: "open_amount",
    schedule: "one_time",
    collects: { suggestions: true, target: true, story: true },
    contributionHeading: "Tell your story, then set what people may give",
  },
  {
    key: "tiers",
    steps: ["Purpose", "Basics", "Options", "Cover image", "Who can choose", "Questions", "Review"],
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
    steps: ["Purpose", "The event", "Tickets", "Flyer", "Who can buy", "Attendee details", "Review"],
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
    steps: ["Purpose", "Basics", "Items", "Cover image", "Who can order", "Questions", "Review"],
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
    steps: ["Purpose", "Basics", "Contribution", "Cover image", "Who pays", "Questions", "Review"],
    title: "Something else",
    description: "Set how people contribute yourself.",
    category: "other",
    participationMode: "open",
    amountModel: "fixed",
    schedule: "one_time",
    contributionHeading: "How should people contribute?",
  },
];

const DEFAULT_STEPS = ["Purpose", "Details", "Contribution", "Cover image", "Who pays", "Questions", "Review"] as const;

/** Seven positions, whatever the collection. Only the names change. */
const STEP_COUNT = DEFAULT_STEPS.length;
/** The step index at which the draft is created, so the cover-image step has a real collection to upload against. */
const COVER_STEP = 3;

/**
 * Everything needed to reopen a draft where it was left (M7.6 part A4).
 *
 * Assembled on the server by the /continue route from the draft's own rows —
 * there is no separate "wizard state" anywhere, because the draft IS the
 * state. What could not be derived from those rows is `step`, which is why
 * collections.draft_step exists.
 */
export interface ExistingDraft {
  collectionId: string;
  collectionSlug: string;
  intentKey: string;
  step: number;
  name: string;
  description: string;
  deadlineAt: string;
  amountModel: AmountModelKey;
  participationMode: "open" | "managed";
  fixedAmount: string;
  minAmount: string;
  maxAmount: string;
  targetAmount: string;
  visibility: "public" | "unlisted";
  coverImageUrl: string | null;
  suggestedAmounts: string[];
  story: StoryDraft;
  tiers: TierDraft[];
  items: ItemDraft[];
  event: EventDraft;
  recurrence: RecurrenceDraft;
  questions: QuestionDraft[];
  audienceMode: CollectionAudienceMode;
  audienceGroupIds: string[];
}

export function NewCollectionForm({
  slug,
  communityId,
  memberCount,
  groups,
  existing,
}: {
  slug: string;
  communityId: string;
  memberCount: number;
  groups: MemberGroup[];
  /** A draft being continued. Absent when this is a new collection. */
  existing?: ExistingDraft | undefined;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const initialIntent = existing ? INTENTS.find((option) => option.key === existing.intentKey) ?? INTENTS[0]! : INTENTS[0]!;

  // A resumed draft starts where it stopped, never on the Purpose step: the
  // kind of collection is decided by rows that already exist, and offering to
  // change it would offer to contradict them.
  const [step, setStep] = useState(existing ? Math.min(Math.max(existing.step, 1), STEP_COUNT - 1) : 0);
  const [error, setError] = useState<string | null>(null);
  const [draftHref, setDraftHref] = useState<string | null>(
    existing ? `/c/${slug}/collections/${existing.collectionSlug}` : null,
  );
  // Set once the draft is created, at the Contribution → Cover image
  // transition (§1/§33: the flyer belongs in the creation flow, not hidden in
  // settings — which means a real collection has to exist by the time this
  // step renders, so its uploader has something to attach the image to).
  const [draftId, setDraftId] = useState<string | null>(existing?.collectionId ?? null);
  const [draftSlug, setDraftSlug] = useState<string | null>(existing?.collectionSlug ?? null);
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(existing?.coverImageUrl ?? null);

  const [intent, setIntent] = useState<Intent>(initialIntent);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [deadlineAt, setDeadlineAt] = useState(existing?.deadlineAt ?? "");
  const [amountModel, setAmountModel] = useState<AmountModelKey>(existing?.amountModel ?? initialIntent.amountModel);
  const [participationMode, setParticipationMode] = useState<Intent["participationMode"]>(
    existing?.participationMode ?? initialIntent.participationMode,
  );
  const [fixedAmount, setFixedAmount] = useState(existing?.fixedAmount ?? "");
  const [minAmount, setMinAmount] = useState(existing?.minAmount ?? "");
  const [maxAmount, setMaxAmount] = useState(existing?.maxAmount ?? "");
  const [targetAmount, setTargetAmount] = useState(existing?.targetAmount ?? "");
  const [suggestedAmounts, setSuggestedAmounts] = useState<string[]>(existing?.suggestedAmounts ?? []);
  const [story, setStory] = useState<StoryDraft>(existing?.story ?? emptyStory());
  const [tiers, setTiers] = useState<TierDraft[]>(
    existing && existing.tiers.length > 0 ? existing.tiers : [emptyTier()],
  );
  const [items, setItems] = useState<ItemDraft[]>(
    existing && existing.items.length > 0 ? existing.items : [emptyItem()],
  );
  const [eventDraft, setEventDraft] = useState<EventDraft>(existing?.event ?? emptyEvent());
  const [recurrence, setRecurrence] = useState<RecurrenceDraft>(existing?.recurrence ?? emptyRecurrence());
  const [questions, setQuestions] = useState<QuestionDraft[]>(existing?.questions ?? []);
  const [visibility, setVisibility] = useState<"public" | "unlisted">(existing?.visibility ?? "unlisted");
  const [audienceMode, setAudienceMode] = useState<CollectionAudienceMode>(
    existing?.audienceMode ?? (initialIntent.participationMode === "open" ? "public" : "all_members"),
  );
  const [audienceGroupIds, setAudienceGroupIds] = useState<string[]>(existing?.audienceGroupIds ?? []);

  /** The step names this kind of collection uses (part A1). */
  const steps = intent.steps ?? DEFAULT_STEPS;

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

  /** The fields `create` and `update` share. Everything type-specific (tiers, items, event, recurrence, fields, audience) is its own call, made once a collection id exists. */
  function collectionConfig() {
    return {
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
    };
  }

  /**
   * Creates the draft, or updates the one already created, from the identity
   * and contribution fields. Called every time a step that owns any of those
   * fields is completed.
   *
   * Idempotent: the draft is created once, and every later call is an update
   * of the same row. Returns the row's id and slug so the caller can go on to
   * save the parts that need them.
   */
  async function saveCollectionRow(): Promise<{ id: string; slug: string } | null> {
    if (draftId && draftSlug) {
      const updated = await updateCollectionAction(slug, draftSlug, {
        collectionId: draftId,
        ...collectionConfig(),
      });
      if (updated.error) {
        setError(updated.error);
        return null;
      }
      return { id: draftId, slug: draftSlug };
    }

    const created = await createCollectionAction(slug, { communityId, ...collectionConfig() });
    if (created.error || !created.collectionId || !created.collectionSlug) {
      setError(created.error ?? "Could not save this collection");
      return null;
    }
    setDraftId(created.collectionId);
    setDraftSlug(created.collectionSlug);
    setDraftHref(`/c/${slug}/collections/${created.collectionSlug}`);
    return { id: created.collectionId, slug: created.collectionSlug };
  }

  /**
   * Saves what one step owns, so leaving the browser after it loses nothing
   * (M7.5 part A). Every call is a full replace of that step's own data
   * against a collection that already exists, which makes retrying safe and
   * makes a second click a no-op rather than a duplicate.
   *
   * The ids that come back from the list writes are carried into the drafts:
   * a tier sent without an id becomes a new row, so identity has to survive
   * the round trip or editing an option twice would leave two of it.
   */
  async function persistStep(current: number): Promise<boolean> {
    // Nothing before Details is the collection's own data yet — the intent
    // picker only decides which questions get asked.
    if (current < 1) return true;

    const save = async (what: string, run: () => Promise<{ error?: string }>): Promise<boolean> => {
      const result = await run();
      if (result.error) {
        setError(`Your progress is saved, but ${what} was not: ${result.error}`);
        return false;
      }
      return true;
    };

    // The audience goes FIRST on the step that owns it, and for every mode —
    // not only the narrow ones. `audience_mode` and `participation_mode` are
    // paired by `collections_audience_matches_participation`, and
    // `app.set_collection_audience` is the one place that writes both in a
    // single statement. Updating the collection row first would try to make
    // it managed while its audience still said public, which is exactly the
    // half-changed state that constraint exists to refuse.
    if (current === 4 && draftId && draftSlug) {
      const ok = await save("who it is for", () =>
        setCollectionAudienceAction(slug, draftSlug, {
          collectionId: draftId,
          audienceMode,
          groupIds: audienceMode === "groups" ? audienceGroupIds : [],
        }),
      );
      if (!ok) return false;
    }

    const row = await saveCollectionRow();
    if (!row) return false;

    if (current === 2) {
      if (amountModel === "tiers") {
        const result = await setCollectionTiersAction(slug, row.slug, {
          collectionId: row.id,
          tiers: tiers.map((tier, index) => ({
            ...(tier.id ? { id: tier.id } : {}),
            name: tier.name.trim(),
            ...(tier.description?.trim() ? { description: tier.description.trim() } : {}),
            price: tier.price.trim(),
            ...(tier.quantityLimit?.trim() ? { quantityLimit: Number(tier.quantityLimit.trim()) } : {}),
            ...(tier.codePrefix?.trim() ? { codePrefix: tier.codePrefix.trim() } : {}),
            sortOrder: index,
          })),
        });
        if (result.error) {
          setError(`Your progress is saved, but the options were not: ${result.error}`);
          return false;
        }
        if (result.savedIds) {
          setTiers((current_) => current_.map((tier, index) => ({ ...tier, id: result.savedIds![index] ?? tier.id })));
        }
      }

      if (amountModel === "items") {
        const result = await setCollectionItemsAction(slug, row.slug, {
          collectionId: row.id,
          items: itemsToPayload(items),
        });
        if (result.error) {
          setError(`Your progress is saved, but the items were not: ${result.error}`);
          return false;
        }
        if (result.savedIds) {
          setItems((current_) => current_.map((item, index) => ({ ...item, id: result.savedIds![index] ?? item.id })));
        }
      }

      if (collects.event && (eventDraft.startsAt || eventDraft.venue || eventDraft.collectAttendeeDetails)) {
        const ok = await save("the event details", () =>
          setCollectionEventAction(slug, row.slug, {
            collectionId: row.id,
            eventStartsAt: eventDraft.startsAt,
            eventEndsAt: eventDraft.endsAt,
            venue: eventDraft.venue,
            collectAttendeeDetails: eventDraft.collectAttendeeDetails,
          }),
        );
        if (!ok) return false;
      }

      const suggestions = suggestedAmounts.map((amount) => amount.trim()).filter((amount) => amount !== "");
      if (collects.suggestions && suggestions.length > 0) {
        const ok = await save("the suggested amounts", () =>
          setCollectionSuggestedAmountsAction(slug, row.slug, { collectionId: row.id, amounts: suggestions }),
        );
        if (!ok) return false;
      }

      if (collects.story && (story.what.trim() || story.why.trim() || story.impact.trim())) {
        const ok = await save("the story", () =>
          setCollectionStoryAction(slug, row.slug, {
            collectionId: row.id,
            storyWhat: story.what,
            storyWhy: story.why,
            storyImpact: story.impact,
          }),
        );
        if (!ok) return false;
      }

      if (collects.recurrence) {
        const ok = await save("the schedule", () =>
          setCollectionRecurrenceAction(slug, row.slug, {
            collectionId: row.id,
            frequency: recurrence.frequency,
            intervalCount: Number(recurrence.intervalCount) || 1,
            ...(recurrence.startsOn ? { startsOn: recurrence.startsOn } : {}),
            dueAfterDays: Number(recurrence.dueAfterDays) || 0,
          }),
        );
        if (!ok) return false;
      }
    }

    // The cover image saves itself the moment it is uploaded, so the Cover
    // step has nothing of its own left to write.

    if (current === 5) {
      const fields = questionsToFields(questions);
      if (fields.length > 0) {
        const ok = await save("the questions", () =>
          setCollectionFieldsAction(slug, row.slug, { collectionId: row.id, fields }),
        );
        if (!ok) return false;
      }
    }

    return true;
  }

  /** Saves the step just completed, then moves on. A failed save keeps the organiser where they are, with the reason. */
  function advance(): void {
    setError(null);
    startTransition(async () => {
      const ok = await persistStep(step);
      if (!ok) return;
      const next = Math.min(steps.length - 1, step + 1);

      // Awaited, not fired and forgotten. A server action dispatched inside a
      // transition and left floating keeps React's pending state true after
      // the transition's own work is done — which left the Review step
      // showing "Saving…" with its button disabled, for ever. Two browser
      // journeys caught it; nothing else would have.
      //
      // The failure is still not allowed to matter: a draft that remembers
      // the wrong step is an inconvenience, and a step that could not be
      // recorded must not stop the organiser moving on.
      if (draftId && draftSlug) await rememberStepAction(slug, draftSlug, draftId, next);

      setStep(next);
    });
  }

  /**
   * The last step. Everything before it is already saved, so this saves
   * what the Review step itself can still change (nothing but a late edit
   * on an earlier step) and opens the draft.
   */
  function finish(): void {
    setError(null);
    startTransition(async () => {
      const ok = await persistStep(2) && await persistStep(4) && await persistStep(5);
      if (!ok) return;
      if (draftSlug) router.push(`/c/${slug}/collections/${draftSlug}`);
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href={`/c/${slug}/collections`} className="text-xs font-medium text-[var(--color-text-muted)] hover:underline">
          ← Collections
        </Link>
        <h1 className="text-xl font-semibold text-[var(--color-text)]">
          {existing ? name || "Continue this draft" : "New collection"}
        </h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Step {step + 1} of {steps.length} · {steps[step]}
        </p>
        {draftId && (
          <p className="text-xs text-[var(--color-text-muted)]">
            {isPending ? "Saving…" : "Your progress is saved automatically."}{" "}
            {draftHref && (
              <Link href={draftHref} className="font-medium underline">
                Open the draft
              </Link>
            )}
          </p>
        )}
      </div>

      <ol className="flex gap-1" aria-label="Progress">
        {steps.map((label, index) => (
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

          {collects.story && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-[var(--color-text)]">Your story</h3>
              <StoryEditor story={story} onChange={setStory} />
            </div>
          )}

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
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Add a flyer</h2>
            <p className="text-sm text-[var(--color-text-muted)]">
              Optional, but this is what {intent.key === "event" ? "an event page" : "a collection"} looks like without
              one — shown at the top of the public page, so give contributors something to recognise. You can add or
              change it later too.
            </p>
          </div>
          {draftId && draftSlug ? (
            <CoverUploader
              slug={slug}
              collectionSlug={draftSlug}
              collectionId={draftId}
              coverImageUrl={coverImageUrl}
              onChanged={setCoverImageUrl}
            />
          ) : (
            <p className="text-sm text-[var(--color-danger)]">
              {error ?? "Could not create the draft. Go back and try again."}
            </p>
          )}
        </section>
      )}

      {step === 4 && (
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

      {step === 5 && (
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

      {step === 6 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Check this over</h2>
          <dl className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
            <Row label="Name" value={name} />
            <Row label="For" value={description || "—"} />
            <Row label="Flyer" value={coverImageUrl ? "Added" : "None yet"} />
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
            {collects.story && (story.what || story.why || story.impact) && (
              <Row label="Story" value="Added" />
            )}
            <Row label="Who it is for" value={AUDIENCE_LABELS[audienceMode].title} />
            <Row label="Deadline" value={deadlineAt || "None"} />
            <Row label="Questions" value={questions.length === 0 ? "None" : questions.map((q) => q.label).join(", ")} />
          </dl>

          <p className="text-sm text-[var(--color-text-muted)]">
            Your progress is saved as you go. Nothing is public and no link works until you publish it.
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

        {step === steps.length - 1 ? (
          <Button type="button" loading={isPending} onClick={finish}>
            <Check className="h-4 w-4" aria-hidden="true" /> Open this draft
          </Button>
        ) : (
          step > 0 && (
            <Button type="button" loading={isPending} disabled={!canContinue} onClick={advance}>
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
