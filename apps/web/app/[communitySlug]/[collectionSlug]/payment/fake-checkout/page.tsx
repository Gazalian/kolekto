import { formatNaira, isPaymentReference } from "@kolekto/domain";
import { notFound } from "next/navigation";
import { getFakePaymentProvider } from "../../../../../lib/payments/provider-factory.ts";
import { completeFakeCheckoutAction } from "./actions.ts";

/**
 * LOCAL ONLY. Stands in for the provider's hosted checkout while the only
 * provider is FakePaymentProvider (M8.5). 404 everywhere except
 * KOLEKTO_ENV=local. Nothing here moves money: it only tells the in-memory
 * fake how the payment ended, then goes to the normal callback, which
 * verifies and captures through the same path a real provider will use.
 */
export default async function FakeCheckoutPage({
  searchParams,
}: {
  params: Promise<{ communitySlug: string; collectionSlug: string }>;
  searchParams: Promise<{ reference?: string }>;
}) {
  const fake = getFakePaymentProvider();
  if (!fake) notFound();

  const { reference } = await searchParams;
  if (!reference || !isPaymentReference(reference)) notFound();

  const checkout = fake.checkoutFor(reference);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-5 px-4 py-12">
      <p className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        Local test checkout — no real money
      </p>
      {checkout ? (
        <>
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold text-[var(--color-text)]">Pay {formatNaira(checkout.amount)}</h1>
            <p className="text-sm text-[var(--color-text-muted)]">Reference {reference}</p>
          </div>
          <form action={completeFakeCheckoutAction} className="flex flex-col gap-2">
            <input type="hidden" name="reference" value={reference} />
            <button
              type="submit"
              name="outcome"
              value="success"
              className="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 py-2 font-medium text-white"
            >
              Pay successfully
            </button>
            <button
              type="submit"
              name="outcome"
              value="payment_failed"
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-2 font-medium text-[var(--color-text)]"
            >
              Card declined
            </button>
            <button
              type="submit"
              name="outcome"
              value="abandoned"
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-2 font-medium text-[var(--color-text)]"
            >
              Cancel payment
            </button>
          </form>
        </>
      ) : (
        <p className="text-sm text-[var(--color-text)]">
          This test checkout is gone — the dev server restarted since it was opened. Go back to the collection and press
          Pay again.
        </p>
      )}
    </main>
  );
}
