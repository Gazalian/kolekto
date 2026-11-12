/**
 * provider-factory.ts — resolves which PaymentProvider to use.
 *
 * M8.5: only FakePaymentProvider. M8.9 adds the Paystack adapter, selected
 * by environment. The orchestrator receives the provider as a value, never
 * constructs it, so the factory is the single place where selection lives.
 *
 * SERVER ONLY.
 */

import { createFakePaymentProvider, type PaymentProvider } from "@kolekto/adapters";

const FAKE_WEBHOOK_SECRET = "test-webhook-secret-m8.5";

let cached: PaymentProvider | undefined;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  cached = createFakePaymentProvider({
    webhookSecret: FAKE_WEBHOOK_SECRET,
    defaultScenario: "success",
  });
  return cached;
}
