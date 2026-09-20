"use client";

import { Banner, Button, SelectField, TextField } from "@kolekto/ui";
import { useState, useTransition } from "react";
import { forgetMemberAction, submitContributionAction, type ContributionResult } from "./actions.ts";
import { FindYourself, type IdentifiedMember } from "./FindYourself.tsx";

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

interface PublicItem {
  id: string;
  name: string;
  description: string | null;
  price: string;
  /** Shown so a contributor knows what is left before choosing. The server decides what is actually allowed. */
  quantityAvailable: number | null;
  maxPerOrder: number | null;
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
  audienceMode,
  amountModel,
  fixedAmount,
  minAmount,
  maxAmount,
  suggestedAmounts,
  tiers,
  items,
  fields,
  thankYouMessage,
  organiser,
}: {
  communitySlug: string;
  collectionSlug: string;
  /** `public` means anyone with the link. Anything else means a named list, and the contributor identifies first. */
  audienceMode: "all_members" | "groups" | "selected_members" | "public";
  amountModel: "fixed" | "open_amount" | "tiers" | "per_member" | "items";
  fixedAmount: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  suggestedAmounts: string[];
  tiers: PublicTier[];
  items: PublicItem[];
  fields: PublicField[];
  thankYouMessage: string | null;
  organiser: string;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [tierId, setTierId] = useState("");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [amount, setAmount] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ContributionResult["summary"] | null>(null);
  const [member, setMember] = useState<IdentifiedMember | null>(null);
  const [isPending, startTransition] = useTransition();

  const isManaged = audienceMode !== "public";

  // A managed collection asks named people, so it asks who is here first.
  // Nothing about amounts, questions or contact details appears until the
  // contributor has said "yes, this is me".
  if (isManaged && !member && !done) {
    return (
      <FindYourself
        communitySlug={communitySlug}
        collectionSlug={collectionSlug}
        organiser={organiser}
        onIdentified={setMember}
      />
    );
  }

  if (!isManaged && amountModel === "per_member") {
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
          {done.memberName && (
            <div className="flex justify-between gap-3 py-2 text-sm">
              <dt className="text-[var(--color-text-muted)]">Contributing as</dt>
              <dd className="font-medium text-[var(--color-text)]">
                {done.memberName}
                {done.memberCode && (
                  <span className="block text-xs font-normal text-[var(--color-text-muted)]">{done.memberCode}</span>
                )}
              </dd>
            </div>
          )}
          {done.cycleLabel && (
            <div className="flex justify-between gap-3 py-2 text-sm">
              <dt className="text-[var(--color-text-muted)]">For the period</dt>
              <dd className="font-medium text-[var(--color-text)]">{done.cycleLabel}</dd>
            </div>
          )}
          {done.tierName && (
            <div className="flex justify-between gap-3 py-2 text-sm">
              <dt className="text-[var(--color-text-muted)]">You chose</dt>
              <dd className="font-medium text-[var(--color-text)]">{done.tierName}</dd>
            </div>
          )}
          {done.itemName && (
            <div className="flex justify-between gap-3 py-2 text-sm">
              <dt className="text-[var(--color-text-muted)]">You ordered</dt>
              <dd className="font-medium text-[var(--color-text)]">
                {done.quantity && done.quantity > 1 ? `${done.quantity} × ${done.itemName}` : done.itemName}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-3 py-2 text-sm">
            <dt className="text-[var(--color-text-muted)]">Amount</dt>
            <dd className="font-medium text-[var(--color-text)]">{done.amount}</dd>
          </div>
        </dl>

        {/* The payment boundary (ADR 0012). This is where M7 stops: the amount
            is resolved and everything needed to pay it is in hand. The exact
            state of affairs is said plainly — no receipt, no reference number,
            no "payment successful", because nothing has been paid and nothing
            has been stored. */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
          <p className="text-sm font-medium text-[var(--color-text)]">Ready to continue to payment</p>
          <p className="text-sm text-[var(--color-text-muted)]">
            {organiser} cannot take payment through Kolekto yet. Nothing has been charged, nothing has been saved, and
            nothing you owe has changed — contact {organiser} to arrange payment, and check back here when online
            payment opens.
          </p>
        </div>

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
        itemId,
        quantity,
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

      {member && (
        <section className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                Contributing as
              </p>
              <p className="text-base font-semibold text-[var(--color-text)]">{member.fullName}</p>
              {member.memberCode && (
                <p className="text-xs text-[var(--color-text-muted)]">{member.memberCode}</p>
              )}
            </div>
            <button
              type="button"
              className="text-xs font-medium text-[var(--color-primary)] hover:underline"
              onClick={() =>
                startTransition(async () => {
                  await forgetMemberAction();
                  setMember(null);
                })
              }
            >
              Not you?
            </button>
          </div>

          {member.cycleLabel && (
            <p className="text-sm text-[var(--color-text-muted)]">For the period {member.cycleLabel}</p>
          )}

          {/* What the community expects of this member, read from their own
              obligation. `paid` is not a state anything here can produce: only
              a verified payment will ever set it. */}
          {member.expectedAmount ? (
            <dl className="flex flex-col gap-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-text-muted)]">Expected</dt>
                <dd className="font-semibold text-[var(--color-text)]">{member.expectedAmount}</dd>
              </div>
              {member.waivedAmount && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Waived by {organiser}</dt>
                  <dd className="font-medium text-[var(--color-text)]">−{member.waivedAmount}</dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-text-muted)]">Status</dt>
                <dd className="font-medium text-[var(--color-text)]">
                  {member.obligationStatus === "exempt"
                    ? "Exempt — nothing to pay"
                    : member.obligationStatus === "paid"
                      ? "Paid"
                      : "Awaiting contribution"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">
              {organiser} has not recorded an amount against your name for this collection. You can still contribute.
            </p>
          )}
        </section>
      )}

      {amountModel === "items" && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold text-[var(--color-text)]">What are you ordering?</legend>
          {items.map((item) => {
            const soldOut = item.quantityAvailable === 0;
            return (
              <label
                key={item.id}
                className={
                  itemId === item.id
                    ? "flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border-2 border-[var(--color-primary)] p-3"
                    : soldOut
                      ? "flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 opacity-60"
                      : "flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
                }
              >
                <input
                  type="radio"
                  name="item"
                  value={item.id}
                  checked={itemId === item.id}
                  disabled={soldOut}
                  onChange={() => setItemId(item.id)}
                  className="mt-1 h-4 w-4"
                />
                <span className="flex flex-1 flex-col">
                  <span className="flex items-center justify-between gap-3">
                    <span className="font-medium text-[var(--color-text)]">{item.name}</span>
                    <span className="text-sm font-medium text-[var(--color-text)]">{item.price}</span>
                  </span>
                  {item.description && (
                    <span className="text-sm text-[var(--color-text-muted)]">{item.description}</span>
                  )}
                  {item.quantityAvailable !== null && (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {soldOut ? "Sold out" : `${item.quantityAvailable} left`}
                    </span>
                  )}
                </span>
              </label>
            );
          })}

          {itemId && (
            <TextField
              label="How many?"
              inputMode="numeric"
              value={quantity}
              required
              hint={(() => {
                const chosen = items.find((item) => item.id === itemId);
                if (chosen?.maxPerOrder) return `Up to ${chosen.maxPerOrder} per person.`;
                return "A whole number.";
              })()}
              onChange={(event) => setQuantity(event.target.value)}
            />
          )}
        </fieldset>
      )}

      {amountModel === "open_amount" && suggestedAmounts.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-[var(--color-text)]">Common amounts</legend>
          <div className="flex flex-wrap gap-2">
            {suggestedAmounts.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setAmount(suggestion.replace(/[₦,]/g, ""))}
                className="rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg)]"
              >
                {suggestion}
              </button>
            ))}
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">Or enter any other amount below.</p>
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

      {/* The collection's headline amount, shown only when this contributor
          has no obligation of their own to show instead. */}
      {amountModel === "fixed" && fixedAmount && !member?.expectedAmount && (
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
