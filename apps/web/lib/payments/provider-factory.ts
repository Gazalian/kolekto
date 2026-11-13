/**
 * provider-factory.ts — resolves which PaymentProvider to use.
 *
 * M8.5: only FakePaymentProvider, and only when KOLEKTO_ENV is local. M8.9
 * adds the Paystack adapter, selected by environment. The orchestrator
 * receives the provider as a value, never constructs it, so the factory is
 * the single place where selection lives.
 *
 * The fake keeps its checkouts in memory, so the checkout action, the local
 * fake checkout page and the callback must all see ONE instance. Next may
 * load this module once per route bundle, so the instance lives on
 * globalThis rather than in a module variable.
 *
 * SERVER ONLY.
 */

import { createFakePaymentProvider, type FakePaymentProvider, type PaymentProvider } from "@kolekto/adapters";
import { loadConfig } from "@kolekto/config";
import { ownerPaymentDb } from "@kolekto/db";
import { type PaymentContext, resolveAppOrigin } from "@kolekto/payments";

/** A dummy signing secret for the local fake. Not a Paystack key; the fake signs nothing real. */
const FAKE_WEBHOOK_SECRET = "test-webhook-secret-m8.5";

const GLOBAL_KEY = Symbol.for("kolekto.payments.fakeProvider");

type WithFake = typeof globalThis & { [GLOBAL_KEY]?: FakePaymentProvider };

/** The local fake, or null outside local. */
export function getFakePaymentProvider(): FakePaymentProvider | null {
  if (loadConfig().environment !== "local") return null;
  const store = globalThis as WithFake;
  // "pending" until the contributor picks an outcome on the fake checkout
  // page: a callback for a checkout nobody finished must not read as paid.
  store[GLOBAL_KEY] ??= createFakePaymentProvider({ webhookSecret: FAKE_WEBHOOK_SECRET, defaultScenario: "pending" });
  return store[GLOBAL_KEY];
}

/** The provider for this environment, or null when none is configured (no real provider until M8.9). */
export function getPaymentProvider(): PaymentProvider | null {
  return getFakePaymentProvider();
}

/**
 * Whether online checkout can start in this environment. Used by server
 * components to decide what the contributor is told up front (a banner on
 * the contribution form), without having to call the full
 * `getPaymentContext()` from a render path.
 */
export function isPaymentEnabled(): boolean {
  return getPaymentProvider() !== null;
}

/** Everything the orchestrator needs, or null when payments are not available here. */
export function getPaymentContext(): (PaymentContext & {
  environment: ReturnType<typeof loadConfig>["environment"];
  appOrigin: string | null;
}) | null {
  const provider = getPaymentProvider();
  if (!provider) return null;
  const { environment } = loadConfig();
  return {
    db: ownerPaymentDb,
    provider,
    environment,
    appOrigin: resolveAppOrigin(environment, process.env["APP_BASE_URL"]),
  };
}

/**
 * Where to send the contributor to pay. The fake's own URL is on `.invalid`
 * and resolves nowhere, so locally it is replaced by the fake checkout page.
 */
export function contributorCheckoutUrl(
  provider: PaymentProvider,
  providerCheckoutUrl: string,
  communitySlug: string,
  collectionSlug: string,
  reference: string,
): string {
  if (provider.name !== "fake") return providerCheckoutUrl;
  return `/${encodeURIComponent(communitySlug)}/${encodeURIComponent(collectionSlug)}/payment/fake-checkout?reference=${encodeURIComponent(reference)}`;
}
