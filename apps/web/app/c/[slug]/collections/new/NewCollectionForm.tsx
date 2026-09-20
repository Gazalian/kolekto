"use client";

import { Banner, Button, SelectField, TextAreaField, TextField } from "@kolekto/ui";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AMOUNT_MODEL_LABEL } from "../../../../../lib/collection-display.ts";
import {
  createCollectionAction,
  setCollectionFieldsAction,
  setCollectionTiersAction,
} from "../actions.ts";
import { emptyTier, TiersEditor, type TierDraft } from "../TiersEditor.tsx";
import { QuestionsEditor, questionsToFields, type QuestionDraft } from "../QuestionsEditor.tsx";

/**
 * Creating a collection, as a conversation rather than a form.
 *
 * The four configuration axes (participation, amount model, payment plan,
 * schedule — PRD 4.1) are what the database stores. An organiser does not think
 * in axes; they think "I am collecting dues" or "I am selling tickets". The
 * intents below are presets over those axes, which is why there is no
 * `collection_type` column for them to be stored in: a template is a starting
 * point, not a kind of collection.
 *
 * Every step only shows what the previous answers made relevant. Nothing is
 * saved until the last step, and what is saved is a draft.
 */

interface Intent {
  key: string;
  title: string;
  description: string;
  category: "dues" | "contribution" | "event" | "fundraiser" | "items" | "other";
  participationMode: "open" | "managed";
  amountModel: "fixed" | "open_amount" | "tiers" | "per_member";
}

const INTENTS: Intent[] = [
  {
    key: "dues",
    title: "Dues or a levy",
    description: "A set amount from a list of members you manage, so you can see who has not paid.",
    category: "dues",
    participationMode: "managed",
    amountModel: "fixed",
  },
  {
    key: "event",
    title: "Tickets or registration",
    description: "Options at different prices, open to anyone with the link.",
    category: "event",
    participationMode: "open",
    amountModel: "tiers",
  },
  {
    key: "fundraiser",
    title: "Fundraiser",
    description: "Anyone can give any amount, toward a target you set.",
    category: "fundraiser",
    participationMode: "open",
    amountModel: "open_amount",
  },
  {
    key: "items",
    title: "An item or package",
    description: "People choose what they are paying for — aso-ebi, a kit, a package.",
    category: "items",
    participationMode: "open",
    amountModel: "tiers",
  },
  {
    key: "custom",
    title: "Something else",
    description: "Set how people contribute yourself.",
    category: "other",
    participationMode: "open",
    amountModel: "fixed",
  },
];

const STEPS = ["Purpose", "Details", "Contribution", "Who pays", "Questions", "Review"] as const;

export function NewCollectionForm({
  slug,
  communityId,
  memberCount,
}: {
  slug: string;
  communityId: string;
  memberCount: number;
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
  const [amountModel, setAmountModel] = useState<Intent["amountModel"]>(INTENTS[0]!.amountModel);
  const [participationMode, setParticipationMode] = useState<Intent["participationMode"]>(
    INTENTS[0]!.participationMode,
  );
  const [fixedAmount, setFixedAmount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [tiers, setTiers] = useState<TierDraft[]>([emptyTier()]);
  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [visibility, setVisibility] = useState<"public" | "unlisted">("unlisted");

  function chooseIntent(next: Intent): void {
    setIntent(next);
    setAmountModel(next.amountModel);
    setParticipationMode(next.participationMode);
    setStep(1);
  }

  const canContinue = (() => {
    switch (step) {
      case 1:
        return name.trim().length >= 3;
      case 2:
        if (amountModel === "fixed") return fixedAmount.trim() !== "";
        if (amountModel === "tiers") return tiers.every((tier) => tier.name.trim() !== "" && tier.price.trim() !== "");
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

      const href = `/c/${slug}/collections/${created.collectionSlug}`;
      setDraftHref(href);

      if (amountModel === "tiers") {
        const tierResult = await setCollectionTiersAction(slug, created.collectionSlug, {
          collectionId: created.collectionId,
          tiers: tiers.map((tier, index) => ({
            name: tier.name.trim(),
            ...(tier.description?.trim() ? { description: tier.description.trim() } : {}),
            price: tier.price.trim(),
            ...(tier.quantityLimit?.trim() ? { quantityLimit: Number(tier.quantityLimit.trim()) } : {}),
            sortOrder: index,
          })),
        });
        if (tierResult.error) {
          setError(`The draft was created, but the options were not saved: ${tierResult.error}`);
          return;
        }
      }

      const fields = questionsToFields(questions);
      if (fields.length > 0) {
        const fieldResult = await setCollectionFieldsAction(slug, created.collectionSlug, {
          collectionId: created.collectionId,
          fields,
        });
        if (fieldResult.error) {
          setError(`The draft was created, but the questions were not saved: ${fieldResult.error}`);
          return;
        }
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
            hint="Optional. After this, the collection stops accepting contributions."
            value={deadlineAt}
            onChange={(event) => setDeadlineAt(event.target.value)}
          />
        </section>
      )}

      {step === 2 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">How should people contribute?</h2>

          {intent.key === "custom" && (
            <SelectField
              label="Contribution type"
              value={amountModel}
              onChange={(event) => setAmountModel(event.target.value as Intent["amountModel"])}
            >
              <option value="fixed">Everyone pays the same amount</option>
              <option value="open_amount">Contributors choose the amount</option>
              <option value="tiers">Options to choose from</option>
              <option value="per_member">A different amount per member</option>
            </SelectField>
          )}

          {amountModel === "fixed" && (
            <TextField
              label="Amount each person pays"
              placeholder="e.g. 5000"
              hint="In naira. 5,000 and 5k both work."
              value={fixedAmount}
              required
              onChange={(event) => setFixedAmount(event.target.value)}
            />
          )}

          {amountModel === "open_amount" && (
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
          )}

          {amountModel === "tiers" && <TiersEditor tiers={tiers} onChange={setTiers} />}

          {amountModel === "per_member" && (
            <p className="text-sm text-[var(--color-text-muted)]">
              You will set each member&apos;s amount when you add them to this collection.
            </p>
          )}

          <TextField
            label="Target"
            hint="Optional. Shown as what the collection is working toward — not an amount received."
            value={targetAmount}
            onChange={(event) => setTargetAmount(event.target.value)}
          />
        </section>
      )}

      {step === 3 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Who is expected to contribute?</h2>

          <SelectField
            label="Who can pay"
            value={participationMode}
            onChange={(event) => setParticipationMode(event.target.value as Intent["participationMode"])}
            hint={
              participationMode === "managed"
                ? `You add members to this collection and Kolekto tracks who still owes. This community has ${memberCount} member${memberCount === 1 ? "" : "s"}.`
                : "Anyone with the link can contribute. Nobody needs a Kolekto account."
            }
          >
            <option value="open">Anyone with the link</option>
            <option value="managed">A list of members I choose</option>
          </SelectField>

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
            {amountModel === "tiers" && (
              <Row label="Options" value={tiers.map((tier) => `${tier.name} — ${tier.price}`).join(", ")} />
            )}
            {amountModel === "open_amount" && (minAmount || maxAmount) && (
              <Row label="Range" value={`${minAmount || "any"} to ${maxAmount || "any"}`} />
            )}
            {targetAmount && <Row label="Target" value={targetAmount} />}
            <Row label="Who can pay" value={participationMode === "managed" ? "A list of members" : "Anyone with the link"} />
            <Row label="Deadline" value={deadlineAt || "None"} />
            <Row label="Questions" value={questions.length === 0 ? "None" : questions.map((q) => q.label).join(", ")} />
          </dl>

          <p className="text-sm text-[var(--color-text-muted)]">
            This saves a draft. Nothing is public and no link works until you publish it.
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
