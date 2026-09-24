"use client";

import type {
  Collection,
  CollectionCycleRow,
  CollectionField,
  CollectionItem,
  CollectionRecurrence,
  CollectionTier,
} from "@kolekto/db";
import { Banner, Button, Card, CardBody, Dialog, SelectField, TextAreaField, TextField } from "@kolekto/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  deleteDraftCollectionAction,
  openCollectionCycleAction,
  setCollectionEventAction,
  setCollectionFieldsAction,
  setCollectionItemsAction,
  setCollectionRecurrenceAction,
  setCollectionStoryAction,
  setCollectionSuggestedAmountsAction,
  setCollectionTiersAction,
  setItemHiddenAction,
  setTierHiddenAction,
  updateCollectionAction,
} from "../actions.ts";
import { CoverUploader } from "../CoverUploader.tsx";
import { EventEditor, type EventDraft } from "../EventEditor.tsx";
import { ItemsEditor, itemsToPayload, type ItemDraft } from "../ItemsEditor.tsx";
import { RecurrenceEditor, type RecurrenceDraft } from "../RecurrenceEditor.tsx";
import { StoryEditor, type StoryDraft } from "../StoryEditor.tsx";
import { SuggestedAmountsEditor } from "../SuggestedAmountsEditor.tsx";
import { QuestionsEditor, questionsToFields, type QuestionDraft } from "../QuestionsEditor.tsx";
import { TiersEditor, type TierDraft } from "../TiersEditor.tsx";

/** A `datetime-local` input needs "YYYY-MM-DDTHH:mm" in local time, which is not what a timestamptz round-trips to. */
function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * Kobo back into the naira text an amount field holds, without losing the
 * kobo: 500050 is "5000.50", not "5000". Truncating here would mean a form
 * that silently reduces an amount every time someone opens it and saves.
 */
function nairaFromKobo(value: number | null): string {
  if (value === null) return "";
  const total = BigInt(value);
  const whole = total / 100n;
  const remainder = total % 100n;
  return remainder === 0n ? whole.toString() : `${whole}.${remainder.toString().padStart(2, "0")}`;
}

export function SettingsPanel({
  slug,
  collection,
  tiers,
  fields,
  items,
  recurrence,
  cycles,
  canEdit,
}: {
  slug: string;
  collection: Collection;
  tiers: CollectionTier[];
  fields: CollectionField[];
  items: CollectionItem[];
  recurrence: CollectionRecurrence | null;
  cycles: CollectionCycleRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const isDraft = collection.status === "draft";
  const isFinished = collection.status === "closed" || collection.status === "archived";

  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description ?? "");
  const [deadlineAt, setDeadlineAt] = useState(toLocalInput(collection.deadline_at));
  const [startsAt, setStartsAt] = useState(toLocalInput(collection.starts_at));
  const [visibility, setVisibility] = useState(collection.visibility);
  const [fixedAmount, setFixedAmount] = useState(nairaFromKobo(collection.fixed_amount_kobo));
  const [minAmount, setMinAmount] = useState(nairaFromKobo(collection.min_amount_kobo));
  const [maxAmount, setMaxAmount] = useState(nairaFromKobo(collection.max_amount_kobo));
  const [targetAmount, setTargetAmount] = useState(nairaFromKobo(collection.target_amount_kobo));
  const [thankYouMessage, setThankYouMessage] = useState(collection.thank_you_message ?? "");

  const [tierDrafts, setTierDrafts] = useState<TierDraft[]>(
    tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      description: tier.description ?? "",
      price: nairaFromKobo(tier.price_kobo),
      quantityLimit: tier.quantity_limit === null ? "" : String(tier.quantity_limit),
      perOrderLimit: tier.per_order_limit === null ? "" : String(tier.per_order_limit),
      codePrefix: tier.code_prefix ?? "",
    })),
  );
  const [questionDrafts, setQuestionDrafts] = useState<QuestionDraft[]>(
    fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      options: (field.options ?? []).join(", "),
      required: field.required,
    })),
  );

  const [itemDrafts, setItemDrafts] = useState<ItemDraft[]>(
    items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description ?? "",
      price: nairaFromKobo(item.price_kobo),
      quantityAvailable: item.quantity_available === null ? "" : String(item.quantity_available),
      maxPerOrder: item.max_per_order === null ? "" : String(item.max_per_order),
      imageUrl: item.image_url ?? undefined,
    })),
  );
  const [eventDraft, setEventDraft] = useState<EventDraft>({
    startsAt: toLocalInput(collection.event_starts_at),
    endsAt: toLocalInput(collection.event_ends_at),
    venue: collection.venue ?? "",
    collectAttendeeDetails: collection.collect_attendee_details,
  });
  const [suggestedAmounts, setSuggestedAmounts] = useState<string[]>(
    collection.suggested_amounts_kobo.map((amount) => nairaFromKobo(amount)),
  );
  const [storyDraft, setStoryDraft] = useState<StoryDraft>({
    what: collection.story_what ?? "",
    why: collection.story_why ?? "",
    impact: collection.story_impact ?? "",
  });
  const [recurrenceDraft, setRecurrenceDraft] = useState<RecurrenceDraft>({
    frequency: recurrence?.frequency ?? "monthly",
    intervalCount: String(recurrence?.interval_count ?? 1),
    startsOn: recurrence?.starts_on ?? "",
    dueAfterDays: String(recurrence?.due_after_days ?? 0),
  });

  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (!canEdit) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-[var(--color-text-muted)]">
            You can view this collection but not change it. Editing needs the collection.draft permission.
          </p>
        </CardBody>
      </Card>
    );
  }

  /** Every panel below saves the same way: run the action, say what happened, and re-read the row rather than trusting the form. */
  function save(successText: string, run: () => Promise<{ error?: string }>): void {
    setMessage(null);
    startTransition(async () => {
      const result = await run();
      setMessage(result.error ? { tone: "danger", text: result.error } : { tone: "success", text: successText });
      if (!result.error) router.refresh();
    });
  }

  function saveDetails(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await updateCollectionAction(slug, collection.slug, {
        collectionId: collection.id,
        name,
        description: description || undefined,
        category: collection.category,
        amountModel: collection.amount_model,
        participationMode: collection.participation_mode,
        paymentPlan: collection.payment_plan,
        fixedAmount: isDraft ? fixedAmount : nairaFromKobo(collection.fixed_amount_kobo),
        minAmount: isDraft ? minAmount : nairaFromKobo(collection.min_amount_kobo),
        maxAmount: isDraft ? maxAmount : nairaFromKobo(collection.max_amount_kobo),
        targetAmount,
        startsAt,
        deadlineAt,
        visibility,
        allowNonMembers: collection.allow_non_members,
        allowAnonymous: collection.allow_anonymous,
        thankYouMessage: thankYouMessage || undefined,
      });
      setMessage(
        result.error ? { tone: "danger", text: result.error } : { tone: "success", text: "Saved." },
      );
      if (!result.error) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {!isDraft && !isFinished && (
        <Banner tone="info">
          This collection is published, so what it asks people to pay is fixed. Its wording, dates and visibility can
          still be changed. Changing an amount after publication needs a second approver, which is not built yet.
        </Banner>
      )}
      {isFinished && (
        <Banner tone="info">A {collection.status} collection is a record. It can be read but not edited.</Banner>
      )}

      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <Card>
        <CardBody className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Details</h2>
          <TextField label="Name" value={name} disabled={isFinished} onChange={(event) => setName(event.target.value)} />
          <TextAreaField
            label="What this is for"
            value={description}
            disabled={isFinished}
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Opens"
              type="datetime-local"
              value={startsAt}
              disabled={isFinished}
              onChange={(event) => setStartsAt(event.target.value)}
            />
            <TextField
              label="Deadline"
              type="datetime-local"
              value={deadlineAt}
              disabled={isFinished}
              onChange={(event) => setDeadlineAt(event.target.value)}
            />
          </div>

          {isDraft && collection.amount_model === "fixed" && (
            <TextField label="Amount each person pays" value={fixedAmount} onChange={(event) => setFixedAmount(event.target.value)} />
          )}
          {isDraft && collection.amount_model === "open_amount" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Smallest contribution" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} />
              <TextField label="Largest contribution" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} />
            </div>
          )}

          <TextField
            label="Target"
            hint="What the collection is working toward. Not an amount received."
            value={targetAmount}
            disabled={isFinished}
            onChange={(event) => setTargetAmount(event.target.value)}
          />

          <SelectField
            label="Visibility"
            value={visibility}
            disabled={isFinished}
            onChange={(event) => setVisibility(event.target.value as Collection["visibility"])}
          >
            <option value="unlisted">Link only</option>
            <option value="public">Listed publicly</option>
            <option value="members_only">Members only</option>
          </SelectField>

          <TextAreaField
            label="Thank-you message"
            hint="Shown to a contributor after they submit their details."
            value={thankYouMessage}
            disabled={isFinished}
            onChange={(event) => setThankYouMessage(event.target.value)}
          />

          {!isFinished && (
            <Button loading={isPending} onClick={saveDetails}>
              Save details
            </Button>
          )}
        </CardBody>
      </Card>

      {collection.amount_model === "tiers" && (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Options</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                {isDraft
                  ? "Each option keeps its identity when you rename it, so a contributor who chose it still gets what they paid for."
                  : "A published option's price cannot change. Hide one to take it off sale — it is never deleted."}
              </p>
            </div>

            {isDraft ? (
              <>
                <TiersEditor tiers={tierDrafts} onChange={setTierDrafts} />
                <Button
                  variant="secondary"
                  loading={isPending}
                  onClick={() => {
                    setMessage(null);
                    startTransition(async () => {
                      const result = await setCollectionTiersAction(slug, collection.slug, {
                        collectionId: collection.id,
                        tiers: tierDrafts.map((tier, index) => ({
                          ...(tier.id ? { id: tier.id } : {}),
                          name: tier.name.trim(),
                          ...(tier.description?.trim() ? { description: tier.description.trim() } : {}),
                          price: tier.price.trim(),
                          ...(tier.quantityLimit?.trim() ? { quantityLimit: Number(tier.quantityLimit.trim()) } : {}),
                          ...(tier.perOrderLimit?.trim()
                            ? { perOrderLimit: Number(tier.perOrderLimit.trim()) }
                            : {}),
                          ...(tier.codePrefix?.trim() ? { codePrefix: tier.codePrefix.trim() } : {}),
                          sortOrder: index,
                        })),
                      });
                      setMessage(
                        result.error
                          ? { tone: "danger", text: result.error }
                          : { tone: "success", text: "Options saved." },
                      );
                      if (!result.error) router.refresh();
                    });
                  }}
                >
                  Save options
                </Button>
              </>
            ) : (
              <ul className="flex flex-col gap-2">
                {tiers.map((tier) => (
                  <li key={tier.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className={tier.hidden ? "text-[var(--color-text-faint)] line-through" : ""}>{tier.name}</span>
                    <button
                      type="button"
                      className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                      disabled={isPending || isFinished}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await setTierHiddenAction(slug, collection.slug, tier.id, !tier.hidden);
                          if (result.error) setMessage({ tone: "danger", text: result.error });
                          else router.refresh();
                        })
                      }
                    >
                      {tier.hidden ? "Show" : "Hide"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {collection.amount_model === "items" && (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Items</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                {isDraft
                  ? "Each item keeps its identity when you rename it, so an order already placed still refers to the same thing."
                  : "A published item's price cannot change. Hide one to take it off sale — it is never deleted."}
              </p>
            </div>

            {isDraft ? (
              <>
                <ItemsEditor
                  items={itemDrafts}
                  onChange={setItemDrafts}
                  slug={slug}
                  collectionSlug={collection.slug}
                  collectionId={collection.id}
                />
                <Button
                  variant="secondary"
                  loading={isPending}
                  onClick={() =>
                    save("Items saved.", () =>
                      setCollectionItemsAction(slug, collection.slug, {
                        collectionId: collection.id,
                        items: itemsToPayload(itemDrafts),
                      }),
                    )
                  }
                >
                  Save items
                </Button>
              </>
            ) : items.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">This collection has no items.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className={item.hidden ? "text-[var(--color-text-faint)] line-through" : ""}>{item.name}</span>
                    <button
                      type="button"
                      className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                      disabled={isPending || isFinished}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await setItemHiddenAction(slug, collection.slug, item.id, !item.hidden);
                          if (result.error) setMessage({ tone: "danger", text: result.error });
                          else router.refresh();
                        })
                      }
                    >
                      {item.hidden ? "Show" : "Hide"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {collection.category === "event" && (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">The event</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                When and where it happens. Separate from the dates above, which are when this collection sells tickets.
              </p>
            </div>
            <EventEditor event={eventDraft} onChange={setEventDraft} disabled={isFinished} />
            {!isFinished && (
              <Button
                variant="secondary"
                loading={isPending}
                onClick={() =>
                  save("Event details saved.", () =>
                    setCollectionEventAction(slug, collection.slug, {
                      collectionId: collection.id,
                      eventStartsAt: eventDraft.startsAt,
                      eventEndsAt: eventDraft.endsAt,
                      venue: eventDraft.venue,
                      collectAttendeeDetails: eventDraft.collectAttendeeDetails,
                    }),
                  )
                }
              >
                Save event details
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      {collection.amount_model === "open_amount" && (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Suggested amounts</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                Shown as one-tap choices. A suggestion is not a price — contributors can still enter any amount you
                allow, which is why these can change after publication.
              </p>
            </div>
            <SuggestedAmountsEditor amounts={suggestedAmounts} onChange={setSuggestedAmounts} disabled={isFinished} />
            {!isFinished && (
              <Button
                variant="secondary"
                loading={isPending}
                onClick={() =>
                  save("Suggested amounts saved.", () =>
                    setCollectionSuggestedAmountsAction(slug, collection.slug, {
                      collectionId: collection.id,
                      amounts: suggestedAmounts.map((amount) => amount.trim()).filter((amount) => amount !== ""),
                    }),
                  )
                }
              >
                Save suggested amounts
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      {collection.category === "fundraiser" && (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Your story</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                Shown on the public page before the amount — a campaign with a clear story raises more than a bare
                target figure.
              </p>
            </div>
            <StoryEditor story={storyDraft} onChange={setStoryDraft} disabled={isFinished} />
            {!isFinished && (
              <Button
                variant="secondary"
                loading={isPending}
                onClick={() =>
                  save("Story saved.", () =>
                    setCollectionStoryAction(slug, collection.slug, {
                      collectionId: collection.id,
                      storyWhat: storyDraft.what,
                      storyWhy: storyDraft.why,
                      storyImpact: storyDraft.impact,
                    }),
                  )
                }
              >
                Save story
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      {collection.schedule === "recurring" && (
        <Card>
          <CardBody className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">How this repeats</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                {isDraft
                  ? "Set before you publish. Members agree to a schedule, so it cannot change afterwards."
                  : "Fixed, because members agreed to it. Close this collection and start another if it has to change."}
              </p>
            </div>

            {isDraft ? (
              <>
                <RecurrenceEditor recurrence={recurrenceDraft} onChange={setRecurrenceDraft} />
                <Button
                  variant="secondary"
                  loading={isPending}
                  onClick={() =>
                    save("Schedule saved.", () =>
                      setCollectionRecurrenceAction(slug, collection.slug, {
                        collectionId: collection.id,
                        frequency: recurrenceDraft.frequency,
                        intervalCount: Number(recurrenceDraft.intervalCount) || 1,
                        ...(recurrenceDraft.startsOn ? { startsOn: recurrenceDraft.startsOn } : {}),
                        dueAfterDays: Number(recurrenceDraft.dueAfterDays) || 0,
                      }),
                    )
                  }
                >
                  Save schedule
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-[var(--color-text)]">
                  {recurrence
                    ? `${recurrence.frequency}, every ${recurrence.interval_count}, from ${recurrence.starts_on}`
                    : "No schedule was set before this collection was published."}
                </p>

                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium text-[var(--color-text)]">Periods</p>
                  {cycles.length === 0 ? (
                    <p className="text-sm text-[var(--color-text-muted)]">No period has been opened yet.</p>
                  ) : (
                    <ul className="flex flex-col gap-1 text-sm text-[var(--color-text-muted)]">
                      {cycles.map((cycle) => (
                        <li key={cycle.id}>
                          {cycle.cycle_key} — {cycle.period_start} to {cycle.period_end}
                          {cycle.closed_at && " (closed)"}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Opening a period does not ask anyone for money. You add that period&apos;s obligations from the
                    Members tab, as a separate step.
                  </p>
                </div>

                {!isFinished && recurrence && (
                  <Button
                    variant="secondary"
                    loading={isPending}
                    onClick={() => {
                      setMessage(null);
                      startTransition(async () => {
                        const result = await openCollectionCycleAction(slug, collection.slug, collection.id);
                        setMessage(
                          result.error
                            ? { tone: "danger", text: result.error }
                            : { tone: "success", text: `Opened ${result.cycleKey}.` },
                        );
                        if (!result.error) router.refresh();
                      });
                    }}
                  >
                    Open the next period
                  </Button>
                )}
              </>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Flyer</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              An optional image at the top of the public page.
            </p>
          </div>
          <CoverUploader
            slug={slug}
            collectionSlug={collection.slug}
            collectionId={collection.id}
            coverImageUrl={collection.cover_image_url}
            disabled={isFinished}
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Questions</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              {isDraft
                ? "Asked in addition to the contributor's name and contact details."
                : "A published collection's questions are fixed, because each answer is stored against its question."}
            </p>
          </div>

          {isDraft ? (
            <>
              <QuestionsEditor questions={questionDrafts} onChange={setQuestionDrafts} />
              <Button
                variant="secondary"
                loading={isPending}
                onClick={() => {
                  setMessage(null);
                  startTransition(async () => {
                    const result = await setCollectionFieldsAction(slug, collection.slug, {
                      collectionId: collection.id,
                      fields: questionsToFields(questionDrafts),
                    });
                    setMessage(
                      result.error
                        ? { tone: "danger", text: result.error }
                        : { tone: "success", text: "Questions saved." },
                    );
                    if (!result.error) router.refresh();
                  });
                }}
              >
                Save questions
              </Button>
            </>
          ) : fields.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">This collection asks no extra questions.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm text-[var(--color-text-muted)]">
              {fields.map((field) => (
                <li key={field.id}>
                  {field.label}
                  {field.required && " (required)"}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {isDraft && (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-[var(--color-text)]">Discard this draft</p>
              <p className="text-xs text-[var(--color-text-muted)]">
                Only a draft can be discarded. Once a collection is published it is closed or archived, never deleted.
              </p>
            </div>
            <Button variant="danger" onClick={() => setConfirmDiscard(true)}>
              Discard draft
            </Button>
          </CardBody>
        </Card>
      )}

      {confirmDiscard && (
        <Dialog
          open
          onClose={() => setConfirmDiscard(false)}
          title="Discard this draft?"
          description="This cannot be undone. Nothing has been published, so nothing is lost but the configuration on this screen."
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)} disabled={isPending}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={isPending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteDraftCollectionAction(slug, collection.id);
                  if (result.error) {
                    setMessage({ tone: "danger", text: result.error });
                    setConfirmDiscard(false);
                  } else {
                    router.push(`/c/${slug}/collections`);
                  }
                })
              }
            >
              Discard draft
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
