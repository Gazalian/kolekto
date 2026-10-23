import "server-only";

/**
 * adapter.ts — lazy construction of the SES/SNS webhook adapter.
 *
 * Lives in its own file so the route file (route.ts) exports only the HTTP
 * method handlers Next.js recognises: Next's dev tooling warns on unknown
 * exports from a route module, and `__setAdapterForTesting` is a legitimate
 * test seam that belongs beside the adapter cache, not next to the handler.
 */

import {
  FakeSesSnsWebhookProvider,
  SesSnsWebhookProvider,
  type EmailWebhookProvider,
} from "@kolekto/adapters";
import { loadConfig, loadSesIngestionConfig } from "@kolekto/config";

let cachedAdapter: EmailWebhookProvider | null | undefined;

/**
 * Return the configured adapter, or null when SES ingestion is not
 * configured for this process. Fail-closed: the loader throws on a
 * half-configured deploy, so a non-null return is always usable.
 */
export function getSesWebhookAdapter(): EmailWebhookProvider | null {
  if (cachedAdapter !== undefined) return cachedAdapter;
  const ingestion = loadSesIngestionConfig();
  if (ingestion === null) {
    cachedAdapter = null;
    return null;
  }
  const { environment } = loadConfig();
  // Local development may seed a shared secret through SES_FAKE_WEBHOOK_SECRET
  // to exercise the ingestion route without AWS. The variable is ignored
  // outside local — a hosted environment uses the real adapter unconditionally.
  const localFakeSecret = environment === "local" ? process.env.SES_FAKE_WEBHOOK_SECRET?.trim() : undefined;
  if (localFakeSecret !== undefined && localFakeSecret.length >= 8) {
    cachedAdapter = new FakeSesSnsWebhookProvider({
      expectedTopicArn: ingestion.topicArn,
      sharedSecret: localFakeSecret,
    });
    return cachedAdapter;
  }
  cachedAdapter = new SesSnsWebhookProvider({
    region: ingestion.region,
    expectedTopicArn: ingestion.topicArn,
    acceptedSignatureVersions: ingestion.acceptedSignatureVersions,
  });
  return cachedAdapter;
}

/** Test-only seam: inject an adapter instance (or null to disable). */
export function setSesWebhookAdapterForTesting(adapter: EmailWebhookProvider | null): void {
  cachedAdapter = adapter;
}

/** Test-only: clear the cache so the next call re-reads configuration. */
export function clearSesWebhookAdapterForTesting(): void {
  cachedAdapter = undefined;
}
