"use client";

import { Banner, Button, SelectField, TextAreaField, TextField } from "@kolekto/ui";
import { normalisePrefix, referenceExample } from "@kolekto/domain";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { emptyCodes, type CodeDraft } from "./codeDefaults.ts";
import type { MemberGroup } from "@kolekto/db";
import type { CollectionAudienceMode } from "@kolekto/validation";
import { AudiencePicker, AUDIENCE_LABELS } from "../AudiencePicker.tsx";
import {
  createCollectionAction,
  rememberStepAction,
  setCollectionAudienceAction,
  setCollectionEventAction,
  setCollectionFeeModeAction,
  setCollectionFieldsAction,
  setCollectionItemsAction,
  setCollectionRecurrenceAction,
  setCollectionStoryAction,
  setCollectionSuggestedAmountsAction,
  setCollectionTiersAction,
  updateCollectionAction,
} from "../actions.ts";
import { saveCodeSettingsAction } from "../[collectionSlug]/code-actions.ts";
import { CoverUploader } from "../CoverUploader.tsx";
import { FeeConfigurator, type FeeBearerChoice } from "../FeeConfigurator.tsx";
import { EventEditor, emptyEvent, type EventDraft } from "../EventEditor.tsx";
import { emptyItem, ItemsEditor, itemsToPayload, type ItemDraft } from "../ItemsEditor.tsx";
import { emptyRecurrence, RecurrenceEditor, type RecurrenceDraft } from "../RecurrenceEditor.tsx";
import { emptyStory, StoryEditor, type StoryDraft } from "../StoryEditor.tsx";
import { SuggestedAmountsEditor } from "../SuggestedAmountsEditor.tsx";
import { emptyTier, TiersEditor, type TierDraft } from "../TiersEditor.tsx";
import { QuestionsEditor, questionsToFields, type QuestionDraft } from "../QuestionsEditor.tsx";
import { FLOWS, feePreviewRows, flowFor, type AmountModelKey, type Flow, type FlowStep, type StepKind } from "./flows.ts";
import { ReviewPanel } from "./ReviewPanel.tsx";

/**
 * Creating a collection, in the shape of the thing being created.
 *
 * ── WHAT CHANGED IN M7.7 ────────────────────────────────────────────────────
 *
 * This wizard had seven fixed positions and one body per position. Every kind
 * of collection walked the same seven screens in the same order; the most a
 * ticketed event could do was rename them. That is why the product felt like
 * one form wearing seven costumes, and renaming more of it would not have
 * helped.
 *
 * A flow is now an ordered list of step KINDS (see ./flows.ts) and this
 * component renders by kind. The lengths differ, the order differs, the
 * vocabulary differs, and two flows do not ask the same questions: a ticketed
 * event opens on the event — name, date, venue and flyer together, because
 * that is how an organiser holds it in their head — and a recurring plan has
 * no closing date at all, because a plan that repeats does not close.
 *
 * What is shared is the machinery: the same editors, the same server actions,
 * the same draft row, the same per-step persistence. Shared infrastructure,
 * purpose-built experience.
 *
 * ── WHAT IS STILL TRUE ──────────────────────────────────────────────────────
 *
 * Every step saves itself when it is completed (M7.5 part A), so closing the
 * browser loses nothing and `/continue` picks it back up (M7.6 part A4).
 * There is still no `collection_type` column — a flow is a preset over the
 * four configuration axes the database can actually check (ADR 0013).
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * It takes no payment. The fee step is a decision and a preview, not a
 * charge: Phase 4 is not implemented, and nothing here initiates, records or
 * moves money.
 */

const PURPOSE_STEP: FlowStep = {
  kind: "purpose",
  label: "Purpose",
  heading: "What are you collecting for?",
};

// `CodeDraft` and `emptyCodes` live in codeDefaults.ts, not here: a server
// component (continue/page.tsx) needs `emptyCodes()` for a draft with no
// code-settings row yet, and everything this file exports is a client
// reference by virtue of the "use client" above, which a server component
// cannot call. Re-exported so every existing import of them from this file
// keeps working unchanged.
export { emptyCodes, type CodeDraft } from "./codeDefaults.ts";

/** Everything needed to reopen a draft where it was left (M7.6 part A4). */
export interface ExistingDraft {
  collectionId: string;
  collectionSlug: string;
  flowKey: string;
  step: number;
  name: string;
  description: string;
  startsAt: string;
  deadlineAt: string;
  amountModel: AmountModelKey;
  participationMode: "open" | "managed";
  fixedAmount: string;
  minAmount: string;
  maxAmount: string;
  targetAmount: string;
  visibility: "public" | "unlisted";
  coverImageUrl: string | null;
  feeMode: FeeBearerChoice;
  suggestedAmounts: string[];
  story: StoryDraft;
  tiers: TierDraft[];
  items: ItemDraft[];
  event: EventDraft;
  recurrence: RecurrenceDraft;
  questions: QuestionDraft[];
  audienceMode: CollectionAudienceMode;
  audienceGroupIds: string[];
  codes: CodeDraft;
  /** True once a reference has been issued: the format is then history (CODE-04). */
  codesLocked: boolean;
}

export function NewCollectionForm({
  slug,
  communityId,
  memberCount,
  groups,
  canConfigureCodes,
  existing,
}: {
  slug: string;
  communityId: string;
  memberCount: number;
  groups: MemberGroup[];
  /** `collection.configure_codes` — owner and admin. Without it the reference step explains rather than offers. */
  canConfigureCodes: boolean;
  existing?: ExistingDraft | undefined;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [flow, setFlow] = useState<Flow>(existing ? flowFor(existing.flowKey) : FLOWS[0]!);
  const steps = [PURPOSE_STEP, ...flow.steps];

  // A resumed draft starts where it stopped, never on the intent picker: what
  // kind of collection this is has already been decided by rows that exist.
  const [step, setStep] = useState(existing ? Math.min(Math.max(existing.step, 1), flow.steps.length) : 0);
  const [error, setError] = useState<string | null>(null);
  const [draftHref, setDraftHref] = useState<string | null>(
    existing ? `/c/${slug}/collections/${existing.collectionSlug}` : null,
  );
  const [draftId, setDraftId] = useState<string | null>(existing?.collectionId ?? null);
  const [draftSlug, setDraftSlug] = useState<string | null>(existing?.collectionSlug ?? null);
  // The same two values, readable synchronously. See `saveCollectionRow`.
  const draftRef = useRef<{ id: string; slug: string } | null>(
    existing ? { id: existing.collectionId, slug: existing.collectionSlug } : null,
  );
  const creationRef = useRef<Promise<{ id: string; slug: string } | null> | null>(null);
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(existing?.coverImageUrl ?? null);

  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [startsAt, setStartsAt] = useState(existing?.startsAt ?? "");
  const [deadlineAt, setDeadlineAt] = useState(existing?.deadlineAt ?? "");
  const [amountModel, setAmountModel] = useState<AmountModelKey>(existing?.amountModel ?? FLOWS[0]!.amountModel);
  const [participationMode, setParticipationMode] = useState<"open" | "managed">(
    existing?.participationMode ?? FLOWS[0]!.participationMode,
  );
  const [fixedAmount, setFixedAmount] = useState(existing?.fixedAmount ?? "");
  const [minAmount, setMinAmount] = useState(existing?.minAmount ?? "");
  const [maxAmount, setMaxAmount] = useState(existing?.maxAmount ?? "");
  const [targetAmount, setTargetAmount] = useState(existing?.targetAmount ?? "");
  const [suggestedAmounts, setSuggestedAmounts] = useState<string[]>(existing?.suggestedAmounts ?? []);
  const [story, setStory] = useState<StoryDraft>(existing?.story ?? emptyStory());
  const [tiers, setTiers] = useState<TierDraft[]>(existing && existing.tiers.length > 0 ? existing.tiers : [emptyTier()]);
  const [items, setItems] = useState<ItemDraft[]>(existing && existing.items.length > 0 ? existing.items : [emptyItem()]);
  const [eventDraft, setEventDraft] = useState<EventDraft>(existing?.event ?? emptyEvent());
  const [recurrence, setRecurrence] = useState<RecurrenceDraft>(existing?.recurrence ?? emptyRecurrence());
  const [questions, setQuestions] = useState<QuestionDraft[]>(existing?.questions ?? []);
  const [visibility, setVisibility] = useState<"public" | "unlisted">(existing?.visibility ?? "unlisted");
  const [feeMode, setFeeMode] = useState<FeeBearerChoice>(existing?.feeMode ?? "community_absorbs");
  const [codes, setCodes] = useState<CodeDraft>(existing?.codes ?? emptyCodes());
  const codesLocked = existing?.codesLocked ?? false;
  const [audienceMode, setAudienceMode] = useState<CollectionAudienceMode>(
    existing?.audienceMode ?? (FLOWS[0]!.participationMode === "open" ? "public" : "all_members"),
  );
  const [audienceGroupIds, setAudienceGroupIds] = useState<string[]>(existing?.audienceGroupIds ?? []);

  const current = steps[step]!;
  const kind = current.kind;
  const hasStep = (wanted: StepKind): boolean => flow.steps.some((entry) => entry.kind === wanted);

  function chooseFlow(next: Flow): void {
    setFlow(next);
    setAmountModel(next.amountModel);
    setParticipationMode(next.participationMode);
    setAudienceMode(next.participationMode === "open" ? "public" : "all_members");
    setStep(1);
  }

  const canContinue = (() => {
    switch (kind) {
      case "basics":
      case "story":
        return name.trim().length >= 3;
      case "event":
        return name.trim().length >= 3 && eventDraft.startsAt.trim() !== "";
      case "amount":
        return fixedAmount.trim() !== "";
      case "packages":
      case "tickets":
        return tiers.every((tier) => tier.name.trim() !== "" && tier.price.trim() !== "");
      case "items":
        return items.every((item) => item.name.trim() !== "" && item.price.trim() !== "");
      case "reference":
        return !canConfigureCodes || codesLocked || !codes.enabled || codes.prefix.trim().length >= 2;
      default:
        return true;
    }
  })();

  /** The fields `create` and `update` share. Everything type-specific is its own call, made once a collection id exists. */
  function collectionConfig() {
    return {
      name,
      description: description || undefined,
      category: flow.category,
      participationMode,
      amountModel,
      schedule: flow.schedule,
      fixedAmount: amountModel === "fixed" ? fixedAmount : "",
      minAmount: amountModel === "open_amount" ? minAmount : "",
      maxAmount: amountModel === "open_amount" ? maxAmount : "",
      targetAmount,
      startsAt,
      deadlineAt,
      visibility,
    };
  }

  /**
   * Creates the draft, or updates the one already created.
   *
   * ── WHY THE DRAFT IS HELD IN A REF ──────────────────────────────────────
   *
   * `setDraftId` does not take effect inside the closure that called it, so
   * two callers in the same render both read `draftId === null` and both
   * create. That is not hypothetical: the ticketing flow creates its draft
   * mid-step (see `ensureDraft`), and a browser journey caught the resulting
   * double create — two `app.create_collection` calls for the same name, the
   * second colliding on the slug, the rejection escaping into a transition
   * and leaving the wizard showing "Saving…" with every button disabled and
   * no way out.
   *
   * `draftRef` is written synchronously, so the second caller sees the first
   * one's work. `creationRef` holds the in-flight creation so a caller that
   * arrives DURING one waits for it instead of starting another.
   */
  async function saveCollectionRow(): Promise<{ id: string; slug: string } | null> {
    // Somebody else is already creating it: wait, then fall through to the
    // update, so this caller's own fields still reach the row. Returning
    // their promise directly would silently drop anything typed after their
    // create began — a description finished after the name lost focus.
    if (creationRef.current) await creationRef.current;

    const existingRow = draftRef.current;
    if (existingRow) {
      const updated = await updateCollectionAction(slug, existingRow.slug, {
        collectionId: existingRow.id,
        ...collectionConfig(),
      });
      if (updated.error) {
        setError(updated.error);
        return null;
      }
      return existingRow;
    }

    creationRef.current = (async () => {
      const created = await createCollectionAction(slug, { communityId, ...collectionConfig() });
      if (created.error || !created.collectionId || !created.collectionSlug) {
        setError(created.error ?? "Could not save this collection");
        return null;
      }
      const row = { id: created.collectionId, slug: created.collectionSlug };
      draftRef.current = row;
      setDraftId(row.id);
      setDraftSlug(row.slug);
      setDraftHref(`/c/${slug}/collections/${row.slug}`);
      return row;
    })();

    try {
      return await creationRef.current;
    } finally {
      // Cleared either way: a failed create must be retryable, and a
      // successful one is now answered by `draftRef`.
      creationRef.current = null;
    }
  }

  /**
   * Creates the draft mid-step, so a control that needs a collection id can
   * live on the step that ought to own it.
   *
   * The flyer is why this exists. §18 requires it on the first event step,
   * and an upload has to be scoped to a real collection — so naming the event
   * creates the draft, and the uploader appears. Nothing else changes.
   */
  function ensureDraft(): void {
    if (draftRef.current || creationRef.current || name.trim().length < 3) return;
    startTransition(async () => {
      await guard(async () => {
        await saveCollectionRow();
      });
    });
  }

  /**
   * Runs a transition's work so that an unexpected throw becomes a message
   * rather than a wizard frozen on "Saving…".
   *
   * Every failure this component EXPECTS comes back as `{ error }` from a
   * server action. A thrown one — a dropped connection, a constraint nobody
   * anticipated — would otherwise reject inside `startTransition` and leave
   * `isPending` true for good, disabling Continue and Back together and
   * trapping the organiser on the step with their work apparently unsaved.
   */
  async function guard(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? `That did not save: ${cause.message}. Your earlier steps are still saved.`
          : "That did not save. Your earlier steps are still saved — try again.",
      );
    }
  }

  /**
   * Saves what one step owns. Every call is a full replace against a row that
   * exists, so a retry is safe.
   *
   * Returns the collection it saved against, because the caller needs it and
   * cannot read it from state: `setDraftId` does not take effect inside the
   * closure that called it, so on the very first step `draftId` is still null
   * here however recently the row was created.
   */
  async function persistStep(stepKind: StepKind): Promise<{ id: string; slug: string } | null> {
    if (stepKind === "purpose") return draftRef.current;

    const save = async (what: string, run: () => Promise<{ error?: string }>): Promise<boolean> => {
      const result = await run();
      if (result.error) {
        setError(`Your progress is saved, but ${what} was not: ${result.error}`);
        return false;
      }
      return true;
    };

    // The audience goes FIRST, and for every mode. `audience_mode` and
    // `participation_mode` are paired by
    // `collections_audience_matches_participation`, and
    // `app.set_collection_audience` is the one place that writes both in a
    // single statement. Updating the collection row first would try to make
    // it managed while its audience still said public — the half-changed
    // state that constraint exists to refuse.
    if (stepKind === "audience" && draftId && draftSlug) {
      const ok = await save("who it is for", () =>
        setCollectionAudienceAction(slug, draftSlug, {
          collectionId: draftId,
          audienceMode,
          groupIds: audienceMode === "groups" ? audienceGroupIds : [],
        }),
      );
      if (!ok) return null;
    }

    const row = await saveCollectionRow();
    if (!row) return null;

    if (stepKind === "packages" || stepKind === "tickets") {
      const result = await setCollectionTiersAction(slug, row.slug, {
        collectionId: row.id,
        tiers: tiers.map((tier, index) => ({
          ...(tier.id ? { id: tier.id } : {}),
          name: tier.name.trim(),
          ...(tier.description?.trim() ? { description: tier.description.trim() } : {}),
          price: tier.price.trim(),
          ...(tier.quantityLimit?.trim() ? { quantityLimit: Number(tier.quantityLimit.trim()) } : {}),
          ...(tier.perOrderLimit?.trim() ? { perOrderLimit: Number(tier.perOrderLimit.trim()) } : {}),
          ...(tier.codePrefix?.trim() ? { codePrefix: tier.codePrefix.trim() } : {}),
          sortOrder: index,
        })),
      });
      if (result.error) {
        setError(`Your progress is saved, but the ${flow.vocabulary.offerings ?? "options"} were not: ${result.error}`);
        return null;
      }
      if (result.savedIds) {
        setTiers((cur) => cur.map((tier, index) => ({ ...tier, id: result.savedIds![index] ?? tier.id })));
      }
    }

    if (stepKind === "items") {
      const result = await setCollectionItemsAction(slug, row.slug, {
        collectionId: row.id,
        items: itemsToPayload(items),
      });
      if (result.error) {
        setError(`Your progress is saved, but the items were not: ${result.error}`);
        return null;
      }
      if (result.savedIds) {
        setItems((cur) => cur.map((item, index) => ({ ...item, id: result.savedIds![index] ?? item.id })));
      }
    }

    if (stepKind === "event" || stepKind === "purchaseRules") {
      const ok = await save("the event details", () =>
        setCollectionEventAction(slug, row.slug, {
          collectionId: row.id,
          eventStartsAt: eventDraft.startsAt,
          eventEndsAt: eventDraft.endsAt,
          venue: eventDraft.venue,
          collectAttendeeDetails: eventDraft.collectAttendeeDetails,
        }),
      );
      if (!ok) return null;
    }

    if (stepKind === "openAmount" || stepKind === "goal") {
      const suggestions = suggestedAmounts.map((amount) => amount.trim()).filter((amount) => amount !== "");
      if (suggestions.length > 0) {
        const ok = await save("the suggested amounts", () =>
          setCollectionSuggestedAmountsAction(slug, row.slug, { collectionId: row.id, amounts: suggestions }),
        );
        if (!ok) return null;
      }
    }

    if (stepKind === "story" && (story.what.trim() || story.why.trim() || story.impact.trim())) {
      const ok = await save("the story", () =>
        setCollectionStoryAction(slug, row.slug, {
          collectionId: row.id,
          storyWhat: story.what,
          storyWhy: story.why,
          storyImpact: story.impact,
        }),
      );
      if (!ok) return null;
    }

    if (stepKind === "schedule") {
      const ok = await save("the schedule", () =>
        setCollectionRecurrenceAction(slug, row.slug, {
          collectionId: row.id,
          frequency: recurrence.frequency,
          intervalCount: Number(recurrence.intervalCount) || 1,
          ...(recurrence.startsOn ? { startsOn: recurrence.startsOn } : {}),
          dueAfterDays: Number(recurrence.dueAfterDays) || 0,
        }),
      );
      if (!ok) return null;
    }

    // Configuration, not a charge. Nothing here records or moves money.
    if (stepKind === "fees") {
      const ok = await save("who pays the fees", () =>
        setCollectionFeeModeAction(slug, row.slug, { collectionId: row.id, feeMode }),
      );
      if (!ok) return null;
    }

    if (stepKind === "questions") {
      const fields = questionsToFields(questions);
      if (fields.length > 0) {
        const ok = await save("the questions", () =>
          setCollectionFieldsAction(slug, row.slug, { collectionId: row.id, fields }),
        );
        if (!ok) return null;
      }
    }

    // The M7.6 reference architecture, reached from creation instead of only
    // from Settings. Same function, same permission, same freeze-on-issue.
    if (stepKind === "reference" && canConfigureCodes && !codesLocked) {
      const ok = await save("the contributor references", () =>
        saveCodeSettingsAction(slug, row.slug, {
          collectionId: row.id,
          enabled: codes.enabled,
          prefix: codes.enabled ? codes.prefix.trim() : null,
          separator: codes.separator,
          digits: Number(codes.digits) || 4,
          startNumber: Number(codes.startNumber) || 1,
          style: codes.style,
        }),
      );
      if (!ok) return null;
    }

    // The cover image saves itself the moment it is uploaded.
    return row;
  }

  function advance(): void {
    setError(null);
    startTransition(async () => {
      await guard(async () => {
        const row = await persistStep(kind);
        if (!row) return;
        const next = Math.min(steps.length - 1, step + 1);

        // Awaited, not fired and forgotten. A server action dispatched inside
        // a transition and left floating keeps React's pending state true
        // after the transition's own work is done — which left the Review
        // step showing "Saving…" with its button disabled, for ever. Two
        // browser journeys caught it; nothing else would have.
        //
        // The row comes from the save rather than from state, so the FIRST
        // step records its position too: `setDraftId` has not taken effect
        // inside this closure, however recently the draft was created.
        await rememberStepAction(slug, row.slug, row.id, next);

        setStep(next);
      });
    });
  }

  function finish(): void {
    setError(null);
    startTransition(async () => {
      await guard(async () => {
        const open = draftRef.current;
        if (open) {
          router.push(`/c/${slug}/collections/${open.slug}`);
          return;
        }
        const row = await persistStep("basics");
        if (!row) return;
        router.push(`/c/${slug}/collections/${row.slug}`);
      });
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href={`/c/${slug}/collections`} className="text-xs font-medium text-[var(--color-text-muted)] hover:underline">
          ← Collections
        </Link>
        <h1 className="text-xl font-semibold text-[var(--color-text)]">
          {step === 0
            ? "New collection"
            : existing
              ? name || `Continue this ${flow.vocabulary.noun}`
              : `New ${flow.vocabulary.noun}`}
        </h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Step {step + 1} of {steps.length} · {current.label}
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
        {steps.map((entry, index) => (
          <li
            key={`${entry.kind}-${index}`}
            aria-current={index === step ? "step" : undefined}
            className={
              index <= step
                ? "h-1 flex-1 rounded-full bg-[var(--color-primary)]"
                : "h-1 flex-1 rounded-full bg-[var(--color-border)]"
            }
          />
        ))}
      </ol>

      {kind !== "purpose" && (
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text)]">{current.heading}</h2>
          {current.hint && <p className="mt-1 text-sm text-[var(--color-text-muted)]">{current.hint}</p>}
        </div>
      )}

      {/* ── Purpose ─────────────────────────────────────────────────────── */}
      {kind === "purpose" && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">{PURPOSE_STEP.heading}</h2>
          {FLOWS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => chooseFlow(option)}
              className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left transition-colors hover:border-[var(--color-border-strong)]"
            >
              <span className="font-medium text-[var(--color-text)]">{option.title}</span>
              <span className="text-sm text-[var(--color-text-muted)]">{option.description}</span>
              <span className="text-xs text-[var(--color-text-faint)]">{option.example}</span>
            </button>
          ))}
        </section>
      )}

      {/* ── Basics ──────────────────────────────────────────────────────── */}
      {kind === "basics" && (
        <section className="flex flex-col gap-4">
          <TextField
            label={`What is this ${flow.vocabulary.noun} called?`}
            hint={`People see this. e.g. ${flow.namePlaceholder}`}
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
          <TextAreaField
            label="What is it for?"
            hint={`Optional. ${flow.descriptionPlaceholder}`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </section>
      )}

      {/* ── The event, flyer included (§18) ──────────────────────────────── */}
      {kind === "event" && (
        <section className="flex flex-col gap-4">
          <TextField
            label="What is the event called?"
            hint={`e.g. ${flow.namePlaceholder}`}
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
            onBlur={ensureDraft}
          />
          <TextAreaField
            label="What is it?"
            hint={`Optional. ${flow.descriptionPlaceholder}`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />

          <EventEditor event={eventDraft} onChange={setEventDraft} showAttendeeToggle={false} />

          <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
            <p className="text-sm font-medium text-[var(--color-text)]">Event flyer</p>
            {draftId && draftSlug ? (
              <CoverUploader
                slug={slug}
                collectionSlug={draftSlug}
                collectionId={draftId}
                coverImageUrl={coverImageUrl}
                onChanged={setCoverImageUrl}
              />
            ) : (
              <p className="text-sm text-[var(--color-text-muted)]">
                Name the event first — the flyer is saved against it, so it needs somewhere to live. It appears here the
                moment you do.
              </p>
            )}
          </div>
        </section>
      )}

      {/* ── The story (§15) ─────────────────────────────────────────────── */}
      {kind === "story" && (
        <section className="flex flex-col gap-4">
          <TextField
            label="What are you raising money for?"
            hint={`The campaign's title. e.g. ${flow.namePlaceholder}`}
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
            onBlur={ensureDraft}
          />
          <TextAreaField
            label="One line people see beside the title"
            hint={`Optional. ${flow.descriptionPlaceholder}`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />

          <StoryEditor story={story} onChange={setStory} />

          <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
            <p className="text-sm font-medium text-[var(--color-text)]">Campaign image</p>
            <p className="text-xs text-[var(--color-text-muted)]">
              The largest thing on the page. A photograph of what you are raising money for does more than any sentence.
            </p>
            {draftId && draftSlug ? (
              <CoverUploader
                slug={slug}
                collectionSlug={draftSlug}
                collectionId={draftId}
                coverImageUrl={coverImageUrl}
                onChanged={setCoverImageUrl}
              />
            ) : (
              <p className="text-sm text-[var(--color-text-muted)]">Title the campaign first, then add the image.</p>
            )}
          </div>
        </section>
      )}

      {/* ── Amounts ─────────────────────────────────────────────────────── */}
      {kind === "amount" && (
        <section className="flex flex-col gap-4">
          <TextField
            label={flow.schedule === "recurring" ? "Amount per period" : "Amount each person pays"}
            hint="In naira."
            value={fixedAmount}
            required
            onChange={(event) => setFixedAmount(event.target.value)}
          />
        </section>
      )}

      {kind === "openAmount" && (
        <section className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
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
          <SuggestedAmountsEditor amounts={suggestedAmounts} onChange={setSuggestedAmounts} />
          <TextField
            label="Target"
            hint="Optional. Shown as something to work toward."
            value={targetAmount}
            onChange={(event) => setTargetAmount(event.target.value)}
          />
        </section>
      )}

      {kind === "goal" && (
        <section className="flex flex-col gap-4">
          <TextField
            label="Fundraising goal"
            hint="Optional, but a campaign with a target raises more than one without."
            value={targetAmount}
            onChange={(event) => setTargetAmount(event.target.value)}
          />
          <SuggestedAmountsEditor amounts={suggestedAmounts} onChange={setSuggestedAmounts} />
          <TextField
            label="Smallest donation"
            hint="Optional. Leave empty to accept any amount."
            value={minAmount}
            onChange={(event) => setMinAmount(event.target.value)}
          />
        </section>
      )}

      {/* ── Priced things ───────────────────────────────────────────────── */}
      {(kind === "packages" || kind === "tickets") && (
        <section className="flex flex-col gap-4">
          <TiersEditor tiers={tiers} onChange={setTiers} vocabulary={kind === "tickets" ? "ticket" : "package"} />
        </section>
      )}

      {kind === "items" && (
        <section className="flex flex-col gap-4">
          {draftId && draftSlug ? (
            <ItemsEditor
              items={items}
              onChange={setItems}
              slug={slug}
              collectionSlug={draftSlug}
              collectionId={draftId}
            />
          ) : (
            <>
              <ItemsEditor items={items} onChange={setItems} />
              <p className="text-xs text-[var(--color-text-muted)]">
                Item photos appear once the catalogue has been named — they are saved against it.
              </p>
            </>
          )}
        </section>
      )}

      {/* ── Rules ───────────────────────────────────────────────────────── */}
      {kind === "orderRules" && (
        <section className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-muted)]">
            How many of each item one person may take is set on the item itself, beside its stock. Nothing is reserved
            until an order is paid for, so stock is not held while somebody browses.
          </p>
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

      {kind === "purchaseRules" && (
        <section className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text)]">
            One contributor can purchase multiple tickets for other people.
          </p>
          <p className="text-sm text-[var(--color-text-muted)]">
            They may take several kinds in one order too — two VIP and one Regular together. How many of each type
            exist, and the most one person may buy of it, are set on the ticket type itself on the previous step.
          </p>
          <label className="flex items-start gap-2 text-sm text-[var(--color-text)]">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-[var(--color-border-strong)]"
              checked={eventDraft.collectAttendeeDetails}
              onChange={(event) => setEventDraft({ ...eventDraft, collectAttendeeDetails: event.target.checked })}
            />
            <span>
              Ask for a name per ticket
              <span className="block text-xs text-[var(--color-text-muted)]">
                One name for every ticket bought, not just the buyer&apos;s. Useful at a door, and for a seating plan.
              </span>
            </span>
          </label>
        </section>
      )}

      {kind === "schedule" && (
        <section className="flex flex-col gap-4">
          <RecurrenceEditor recurrence={recurrence} onChange={setRecurrence} />
        </section>
      )}

      {/* ── Fees (§5, §6) ───────────────────────────────────────────────── */}
      {kind === "fees" && (
        <section className="flex flex-col gap-4">
          <FeeConfigurator
            bearer={feeMode}
            onBearerChange={setFeeMode}
            category={flow.category}
            contributionNoun={flow.vocabulary.contribution}
            amounts={feePreviewRows({ flow, fixedAmount, minAmount, suggestedAmounts, tiers, items })}
          />
        </section>
      )}

      {/* ── Cover, where it is not already asked for ─────────────────────── */}
      {kind === "cover" && (
        <section className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-muted)]">
            Optional, and shown at the top of the public page. You can add or change it later.
          </p>
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

      {/* ── Audience ────────────────────────────────────────────────────── */}
      {kind === "audience" && (
        <section className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-muted)]">
            This community has {memberCount} member{memberCount === 1 ? "" : "s"}. Choosing a group or the whole roll
            does not ask anyone for money yet — you add the obligations yourself, once it is published.
          </p>

          <AudiencePicker
            value={audienceMode}
            groups={groups}
            selectedGroupIds={audienceGroupIds}
            allowPublic={amountModel !== "per_member" && flow.schedule !== "recurring"}
            onChange={(mode) => {
              setAudienceMode(mode);
              setParticipationMode(mode === "public" ? "open" : "managed");
            }}
            onGroupsChange={setAudienceGroupIds}
          />

          {!hasStep("orderRules") && (
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
          )}
        </section>
      )}

      {/* ── Questions ───────────────────────────────────────────────────── */}
      {kind === "questions" && (
        <section className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-muted)]">
            Everyone is already asked for a name and a way to reach them. Add a question only where you need something
            this {flow.vocabulary.noun} cannot run without — a house number, a size, a dietary note.
          </p>
          <QuestionsEditor questions={questions} onChange={setQuestions} />
        </section>
      )}

      {/* ── Contributor references (§9) ──────────────────────────────────── */}
      {kind === "reference" && (
        <section className="flex flex-col gap-4">
          {!canConfigureCodes ? (
            <Banner tone="info">
              Contributor references are an owner or admin decision, so this step is not yours to set. Everything else
              here is — an owner can switch them on later from Settings, and they are issued from then on.
            </Banner>
          ) : codesLocked ? (
            <Banner tone="info">
              References have already been issued on this {flow.vocabulary.noun}, so the format is fixed — they may
              already be printed on something.
            </Banner>
          ) : (
            <>
              <ReferenceStep
                codes={codes}
                onChange={setCodes}
                tiers={hasStep("tickets") || hasStep("packages") ? tiers : []}
                offerings={flow.vocabulary.offerings ?? "options"}
                peopleNoun={flow.vocabulary.people}
              />

              {/*
                Said plainly rather than left to be discovered. A reference is
                issued against a named person on the roll, and an open
                collection has no roll until somebody is put on one — so
                switching this on for a public audience is a decision that
                takes effect later, not one that does nothing.
              */}
              {codes.enabled && audienceMode === "public" && (
                <Banner tone="info">
                  This {flow.vocabulary.noun} is open to anyone with the link, and a reference belongs to a named
                  person. Nothing is issued until you add {flow.vocabulary.people} to the{" "}
                  {flow.key === "ticketing" ? "guest list" : "roll"} — the format is saved and waiting until you do.
                </Banner>
              )}
            </>
          )}
        </section>
      )}

      {/* ── Timing, type-aware (§21) ─────────────────────────────────────── */}
      {kind === "timing" && (
        <section className="flex flex-col gap-4">
          {flow.timing === "sales_window" || flow.timing === "order_window" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={flow.timing === "sales_window" ? "Sales open" : "Orders open"}
                type="datetime-local"
                hint="Optional. Leave empty to open as soon as you publish."
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
              />
              <TextField
                label={flow.timing === "sales_window" ? "Sales close" : "Orders close"}
                type="datetime-local"
                hint="Optional."
                value={deadlineAt}
                onChange={(event) => setDeadlineAt(event.target.value)}
              />
            </div>
          ) : (
            <TextField
              label={flow.timing === "campaign_end" ? "Campaign ends" : "Closing date"}
              type="datetime-local"
              hint="Optional. Leave it empty and it stays open until you close it yourself."
              value={deadlineAt}
              onChange={(event) => setDeadlineAt(event.target.value)}
            />
          )}

          {flow.timing === "sales_window" && eventDraft.startsAt && (
            <p className="text-xs text-[var(--color-text-muted)]">
              The event itself is on {eventDraft.startsAt.replace("T", " at ")}. That is a different date from when
              tickets stop selling.
            </p>
          )}
        </section>
      )}

      {/* ── Review, per type (§23) ───────────────────────────────────────── */}
      {kind === "review" && (
        <ReviewPanel
          flow={flow}
          name={name}
          description={description}
          coverImageUrl={coverImageUrl}
          fixedAmount={fixedAmount}
          minAmount={minAmount}
          maxAmount={maxAmount}
          targetAmount={targetAmount}
          suggestedAmounts={suggestedAmounts}
          tiers={tiers}
          items={items}
          event={eventDraft}
          recurrence={recurrence}
          story={story}
          questions={questions}
          feeMode={feeMode}
          codes={codes}
          audienceLabel={AUDIENCE_LABELS[audienceMode].title}
          startsAt={startsAt}
          deadlineAt={deadlineAt}
          previewHref={draftSlug ? `/c/${slug}/collections/${draftSlug}/preview` : null}
        />
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
          onClick={() => setStep((cur) => Math.max(0, cur - 1))}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
        </Button>

        {kind === "review" ? (
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

/**
 * Contributor references, configured while the collection is being made
 * rather than discovered in Settings afterwards (§9).
 *
 * This writes through `app.set_collection_code_settings` — the same M7.6
 * function, the same permission, the same refusal to change a format once a
 * reference has been issued. There is no second reference system.
 */
function ReferenceStep({
  codes,
  onChange,
  tiers,
  offerings,
  peopleNoun,
}: {
  codes: CodeDraft;
  onChange: (codes: CodeDraft) => void;
  tiers: TierDraft[];
  offerings: string;
  peopleNoun: string;
}) {
  const example = referenceExample(
    { prefix: codes.prefix, separator: codes.separator, digits: Number(codes.digits) || 4 },
    Number(codes.startNumber) || 1,
  );
  const prefixed = tiers.filter((tier) => (tier.codePrefix ?? "").trim() !== "");

  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-start gap-2 text-sm text-[var(--color-text)]">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-[var(--color-border-strong)]"
          checked={codes.enabled}
          onChange={(event) => onChange({ ...codes, enabled: event.target.checked })}
        />
        <span>
          Give each of your {peopleNoun} a reference
          <span className="block text-xs text-[var(--color-text-muted)]">
            Issued as you add people, and never reissued. It is not their member ID — that one follows them across
            everything you ever run.
          </span>
        </span>
      </label>

      {codes.enabled && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Prefix"
              hint="2 to 10 letters or digits."
              value={codes.prefix}
              onChange={(event) => onChange({ ...codes, prefix: normalisePrefix(event.target.value) })}
            />
            <SelectField
              label="Style"
              value={codes.style}
              onChange={(event) => onChange({ ...codes, style: event.target.value as "sequential" | "random" })}
            >
              <option value="sequential">Counting up — 0001, 0002, 0003</option>
              <option value="random">Random — harder to guess</option>
            </SelectField>
            {codes.style === "sequential" && (
              <>
                <TextField
                  label="Number of digits"
                  type="number"
                  min={1}
                  max={8}
                  value={codes.digits}
                  onChange={(event) => onChange({ ...codes, digits: event.target.value })}
                />
                <TextField
                  label="Starting number"
                  type="number"
                  min={1}
                  value={codes.startNumber}
                  onChange={(event) => onChange({ ...codes, startNumber: event.target.value })}
                />
              </>
            )}
          </div>

          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
            <p className="text-xs text-[var(--color-text-muted)]">Preview</p>
            <p className="font-mono text-base font-medium text-[var(--color-text)]">
              {codes.style === "random"
                ? codes.prefix
                  ? `${codes.prefix}${codes.separator}K7M2QX`
                  : "Choose a prefix to see one"
                : example || "Choose a prefix to see one"}
            </p>
          </div>

          {prefixed.length > 0 && (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2">
              <p className="text-xs font-medium text-[var(--color-text)]">
                {offerings.charAt(0).toUpperCase() + offerings.slice(1)} with their own prefix
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm text-[var(--color-text-muted)]">
                {prefixed.map((tier, index) => (
                  <li key={tier.id ?? index}>
                    {tier.name || `Option ${index + 1}`} —{" "}
                    <span className="font-mono text-[var(--color-text)]">
                      {referenceExample(
                        {
                          prefix: (tier.codePrefix ?? "").toUpperCase(),
                          separator: codes.separator,
                          digits: Number(codes.digits) || 4,
                        },
                        1,
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Each of these counts from one, separately.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
