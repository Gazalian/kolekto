import "server-only";

/**
 * paystack.ts — lazy, process-wide holder for the real Paystack adapter.
 *
 * Lives in its own file so the route and the orchestrator share one
 * instance per process and so the single env-reading call sits beside its
 * cache. The adapter itself is stateless — but holding one lets a future
 * change add pooling, retries or circuit breakers without hunting the
 * constructor across the codebase.
 *
 * The invariant "every Paystack call goes through packages/adapters" (ADR
 * 0002, invariant 4) forbids naming `PAYSTACK_SECRET_KEY` as a string
 * anywhere outside `packages/adapters`. The env loader therefore lives in
 * the adapter package and is imported here by name.
 *
 * SERVER ONLY.
 */

import {
  createPaystackPaymentProvider,
  type PaystackPaymentProvider,
  tryLoadPaystackConfigFromEnv,
} from "@kolekto/adapters";

const GLOBAL_KEY = Symbol.for("kolekto.payments.paystackProvider");

type WithPaystack = typeof globalThis & { [GLOBAL_KEY]?: PaystackPaymentProvider | null };

/**
 * The configured Paystack adapter, or null when the environment has not
 * provided both `PAYSTACK_SECRET_KEY` and `PAYSTACK_WEBHOOK_SECRET`. A
 * loaded value is cached on `globalThis` so the route, the orchestrator
 * and the sweep share one instance per process.
 *
 * Returns null — never throws — when the env is incomplete, so a staging
 * deploy that is partly configured keeps serving pages at the checkout
 * boundary. Fully misconfigured values (an `sk_` prefix that is wrong, a
 * missing `whsec_` prefix) do throw from the env loader: those are
 * startup-fatal.
 */
export function getPaystackPaymentProvider(): PaystackPaymentProvider | null {
  const store = globalThis as WithPaystack;
  if (store[GLOBAL_KEY] !== undefined) return store[GLOBAL_KEY];
  const config = tryLoadPaystackConfigFromEnv();
  store[GLOBAL_KEY] = config === null ? null : createPaystackPaymentProvider(config);
  return store[GLOBAL_KEY];
}

/** Test-only: reset the cache so the next call re-reads env. */
export function resetPaystackPaymentProviderForTesting(): void {
  const store = globalThis as WithPaystack;
  delete store[GLOBAL_KEY];
}
