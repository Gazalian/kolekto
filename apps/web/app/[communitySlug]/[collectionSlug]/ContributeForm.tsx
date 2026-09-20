"use client";

import { Banner, Button, SelectField, TextField } from "@kolekto/ui";
import { useState, useTransition } from "react";
import { submitContributionAction, type ContributionResult } from "./actions.ts";

/**
 * The contributor's form. Three rules it follows, all of them product
 * decisions rather than implementation details:
 *
 *   · No account. Nothing here asks anyone to sign up, sign in, or remember a
 *     password. A contributor is a person with a link.
 *   · Contact details and collection questions are visibly separate sections,
 *     because they are different things (PRD 4.3).
 *   · The client never decides what anything costs. It shows prices and
 *     collects a choice; the server resolves the amount from the collection.
 */

interface PublicTier {
  id: string;
  name: string;
  description: string | null;
  price: string;
}

interface PublicField {
  key: string;
  label: string;
  type: "text" | "number" | "single_select" | "date";
  options: string[] | null;
  required: boolean;
}

export function ContributeForm({
  communitySlug,
  collectionSlug,
  amountModel,
  fixedAmount,
  minAmount,
  maxAmount,
  tiers,
  fields,
  thankYouMessage,
  organiser,
}: {
  communitySlug: string;
  collectionSlug: string;
  amountModel: "fixed" | "open_amount" | "tiers" | "per_member";
  fixedAmount: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  tiers: PublicTier[];
  fields: PublicField[];
  thankYouMessage: string | null;
  organiser: string;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [tierId, setTierId] = useState("");
  const [amount, setAmount] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ContributionResult["summary"] | null>(null);
  const [isPending, startTransition] = useTransition();

  if (amountModel === "per_member") {
    return (
      <Banner tone="info">
        This collection is for a named list of members, each with their own amount. {organiser} will send you your own
        payment link.
      </Banner>
    );
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h2 className="text-lg font-semibold text-[var(--color-text)]">Your details are checked, {done.contributorName}</h2>

        <dl className="divide-y divide-[var(--color-border)]">
          {done.tierName && (
            <div className="flex justify-between gap-3 py-2 text-sm">
              <dt className="text-[var(--color-text-muted)]">You chose</dt>
              <dd className="font-medium text-[var(--color-text)]">{done.tierName}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3 py-2 text-sm">
            <dt className="text-[var(--color-text-muted)]">Amount</dt>
            <dd className="font-medium text-[var(--color-text)]">{done.amount}</dd>
          </div>
        </dl>

        {/* The exact state of affairs, said plainly. No receipt, no reference
            number, no "payment successful" — nothing has been paid, and
            nothing has been stored. */}
        <Banner tone="info">
          {organiser} cannot take payment through Kolekto yet. Nothing has been charged and these details have not been
          saved — please contact {organiser} to arrange payment, and check back here when online payment opens.
        </Banner>

        {thankYouMessage && <p className="text-sm text-[var(--color-text-muted)]">{thankYouMessage}</p>}

        <Button variant="secondary" onClick={() => setDone(null)}>
          Back to the form
        </Button>
      </div>
    );
  }

  function submit(): void {
    setError(null);
    startTransition(async () => {
      const result = await submitContributionAction(communitySlug, collectionSlug, {
        fullName,
        email,
        phone,
        tierId,
        amount,
        answers,
      });
      if (result.error) setError(result.error);
      else if (result.summary) setDone(result.summary);
    });
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {amountModel === "tiers" && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold text-[var(--color-text)]">What are you paying for?</legend>
          {tiers.map((tier) => (
            <label
              key={tier.id}
              className={
                tierId === tier.id
                  ? "flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border-2 border-[var(--color-primary)] p-3"
                  : "flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
              }
            >
              <input
                type="radio"
                name="tier"
                value={tier.id}
                checked={tierId === tier.id}
                onChange={() => setTierId(tier.id)}
                className="mt-1 h-4 w-4"
              />
              <span className="flex flex-1 flex-col">
                <span className="flex items-center justify-between gap-3">
                  <span className="font-medium text-[var(--color-text)]">{tier.name}</span>
                  <span className="text-sm font-medium text-[var(--color-text)]">{tier.price}</span>
                </span>
                {tier.description && (
                  <span className="text-sm text-[var(--color-text-muted)]">{tier.description}</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {amountModel === "open_amount" && (
        <TextField
          label="How much would you like to contribute?"
          inputMode="decimal"
          placeholder="e.g. 5000"
          value={amount}
          required
          hint={
            minAmount && maxAmount
              ? `Between ${minAmount} and ${maxAmount}.`
              : minAmount
                ? `${minAmount} or more.`
                : maxAmount
                  ? `Up to ${maxAmount}.`
                  : "Any amount, in naira."
          }
          onChange={(event) => setAmount(event.target.value)}
        />
      )}

      {amountModel === "fixed" && fixedAmount && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
          <p className="text-sm text-[var(--color-text-muted)]">Amount</p>
          <p className="text-xl font-semibold text-[var(--color-text)]">{fixedAmount}</p>
        </div>
      )}

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold text-[var(--color-text)]">Your details</legend>
        <TextField label="Full name" value={fullName} required onChange={(event) => setFullName(event.target.value)} />
        <TextField
          label="Email address"
          type="email"
          hint="For your receipt. An email address or a phone number is enough."
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label="Phone number"
          inputMode="tel"
          placeholder="+2348012345678"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
      </fieldset>

      {fields.length > 0 && (
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-sm font-semibold text-[var(--color-text)]">
            {organiser} also needs to know
          </legend>
          {fields.map((field) =>
            field.type === "single_select" ? (
              <SelectField
                key={field.key}
                label={field.label}
                required={field.required}
                value={answers[field.key] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [field.key]: event.target.value }))}
              >
                <option value="">Choose one</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </SelectField>
            ) : (
              <TextField
                key={field.key}
                label={field.label}
                required={field.required}
                type={field.type === "date" ? "date" : "text"}
                inputMode={field.type === "number" ? "numeric" : undefined}
                value={answers[field.key] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [field.key]: event.target.value }))}
              />
            ),
          )}
        </fieldset>
      )}

      {error && <Banner tone="danger">{error}</Banner>}

      <Banner tone="info">
        Online payment for this collection is not open yet. You can check your details now; {organiser} will confirm how
        to pay.
      </Banner>

      <Button type="submit" size="lg" loading={isPending}>
        Continue
      </Button>
    </form>
  );
}
