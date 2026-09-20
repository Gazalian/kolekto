"use server";

import { getPublicCollection, getPublicCollectionFields, getPublicCollectionTiers } from "@kolekto/db";
import {
  ContributionError,
  formatNaira,
  fromNaira,
  kobo,
  resolveContributionAmount,
  type ContributionTier,
} from "@kolekto/domain";
import { buildContributorAnswersSchema, contributorContactSchema } from "@kolekto/validation";

/**
 * What happens when a contributor submits the form.
 *
 * Every figure is re-derived here from the database. The browser's copy of the
 * collection is a convenience for rendering and is treated as hostile input:
 * the tier is resolved by ID against the collection's own rows, the amount for
 * a fixed collection comes from the collection, and an answer to a question the
 * collection does not ask is dropped. SEC-18, applied to an anonymous caller.
 *
 * Nothing is stored. There is no contributions table, no payment attempt and no
 * Paystack call in this phase (ADR 0006 gates all three on decisions outside
 * it), so this returns a checked summary and says plainly that payment is not
 * open yet. It does not say "payment received", it does not issue a receipt,
 * and it does not record a pending contribution that a later phase would have
 * to reconcile against money that never arrived.
 */

export interface ContributionResult {
  ok?: boolean;
  error?: string;
  /** Present on success: what the server resolved, for the confirmation screen. */
  summary?: {
    amount: string;
    tierName: string | null;
    contributorName: string;
  };
}

export async function submitContributionAction(
  communitySlug: string,
  collectionSlug: string,
  input: {
    fullName: string;
    email: string;
    phone: string;
    tierId: string;
    amount: string;
    answers: Record<string, string>;
  },
): Promise<ContributionResult> {
  const collection = await getPublicCollection(communitySlug, collectionSlug);
  if (!collection) return { error: "This collection is no longer available." };
  if (collection.status !== "active") {
    return {
      error:
        collection.status === "paused"
          ? "This collection is paused and is not accepting contributions right now."
          : "This collection is closed and is no longer accepting contributions.",
    };
  }

  const contact = contributorContactSchema.safeParse({
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
  });
  if (!contact.success) return { error: contact.error.issues[0]?.message ?? "Check your details and try again" };

  const fields = await getPublicCollectionFields(collection.collection_id);
  const answers = buildContributorAnswersSchema(
    fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      options: field.options,
      required: field.required,
    })),
  ).safeParse(input.answers);
  if (!answers.success) return { error: answers.error.issues[0]?.message ?? "Check your answers and try again" };

  const tiers: ContributionTier[] =
    collection.amount_model === "tiers"
      ? (await getPublicCollectionTiers(collection.collection_id)).map((tier) => ({
          id: tier.tier_id,
          name: tier.name,
          priceKobo: kobo(tier.price_kobo),
        }))
      : [];

  let resolved;
  try {
    resolved = resolveContributionAmount(
      {
        amountModel: collection.amount_model,
        fixedAmountKobo: collection.fixed_amount_kobo === null ? null : kobo(collection.fixed_amount_kobo),
        minAmountKobo: collection.min_amount_kobo === null ? null : kobo(collection.min_amount_kobo),
        maxAmountKobo: collection.max_amount_kobo === null ? null : kobo(collection.max_amount_kobo),
        tiers,
      },
      {
        ...(input.tierId ? { tierId: input.tierId } : {}),
        ...(input.amount ? { amountKobo: fromNaira(input.amount) } : {}),
      },
    );
  } catch (error) {
    if (error instanceof ContributionError) return { error: error.message };
    return { error: "That amount could not be read. Enter it in naira, for example 5000." };
  }

  return {
    ok: true,
    summary: {
      amount: formatNaira(resolved.amountKobo, { decimals: false }),
      tierName: tiers.find((tier) => tier.id === resolved.tierId)?.name ?? null,
      contributorName: contact.data.fullName,
    },
  };
}
