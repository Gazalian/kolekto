import "server-only";

/**
 * transfers.ts — the web app's money-out provider: bank list, account
 * resolution and recipients for saved payout accounts, plus the transfer
 * webhook's verify call.
 *
 *   · With a Paystack key (any environment): the real adapter. In local the
 *     key in .env.local is a TEST key, so nothing real moves.
 *   · Local without a key: the offline FakeTransferProvider (one instance per
 *     process on globalThis), so the bank-account screens work offline.
 *   · Staging / production without a key: null — the screens say payouts are
 *     not available, and the webhook answers 503.
 *
 * Environment variable names are read inside @kolekto/adapters only
 * (invariant 4). Whether NEW transfers are sent is decided by the worker
 * (`paystackTransfersEnabled`); nothing here initiates a transfer.
 *
 * SERVER ONLY.
 */

import { FakeTransferProvider, type TransferProvider, tryLoadPaystackTransferProviderFromEnv } from "@kolekto/adapters";
import { loadConfig } from "@kolekto/config";
import { ownerPaymentDb } from "@kolekto/db";
import type { TransferContext } from "@kolekto/payments";

const GLOBAL_KEY = Symbol.for("kolekto.payments.transferProvider");
type WithTransfers = typeof globalThis & { [GLOBAL_KEY]?: TransferProvider | null };

export function getTransferProvider(): TransferProvider | null {
  const store = globalThis as WithTransfers;
  if (store[GLOBAL_KEY] !== undefined) return store[GLOBAL_KEY];
  const paystack = tryLoadPaystackTransferProviderFromEnv();
  store[GLOBAL_KEY] =
    paystack ?? (loadConfig().environment === "local" ? new FakeTransferProvider({ defaultAccountName: "TEST ACCOUNT HOLDER" }) : null);
  return store[GLOBAL_KEY];
}

/** What the transfer orchestration needs, or null when no provider is configured here. */
export function getTransferContext(): TransferContext | null {
  const provider = getTransferProvider();
  return provider === null ? null : { db: ownerPaymentDb, provider };
}

/** Test-only: forget the cached provider. */
export function resetTransferProviderForTesting(): void {
  delete (globalThis as WithTransfers)[GLOBAL_KEY];
}
