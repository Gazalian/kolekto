"use server";

import { isPaymentReference } from "@kolekto/domain";
import { notFound, redirect } from "next/navigation";
import { getFakePaymentProvider } from "../../../../../lib/payments/provider-factory.ts";

const OUTCOMES = ["success", "payment_failed", "abandoned"] as const;
type FakeOutcome = (typeof OUTCOMES)[number];

/**
 * LOCAL ONLY. Plays the contributor on the provider's checkout page: records
 * how this fake payment ends, then returns to the callback the checkout was
 * initialized with — as a path on this app, never an absolute URL, so the
 * form cannot be turned into an open redirect.
 */
export async function completeFakeCheckoutAction(formData: FormData): Promise<void> {
  const fake = getFakePaymentProvider();
  if (!fake) notFound();

  const reference = formData.get("reference");
  const outcome = formData.get("outcome");
  if (typeof reference !== "string" || !isPaymentReference(reference)) notFound();
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome as FakeOutcome)) notFound();

  const checkout = fake.checkoutFor(reference);
  if (!checkout) notFound();

  fake.completeCheckout(reference, outcome as FakeOutcome);
  const callback = new URL(checkout.callbackUrl);
  redirect(`${callback.pathname}${callback.search}`);
}
