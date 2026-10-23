/**
 * @kolekto/adapters — the only outbound callers (ADR 0001, ADR 0002).
 *
 * `api.paystack.co` may appear only in this package, and the fourth source-tree
 * invariant fails the build if it appears anywhere else. The previous estate had
 * five Paystack call sites across three runtimes, which is why FIN-02's
 * settlement swap was not achievable in it.
 *
 * Nothing in this package makes a network request today. The settlement provider
 * and the payment provider are contracts; the only implementation is a
 * deterministic offline fake.
 *
 * This file was missing until M8.2 — `package.json` declared it as the export
 * entry point and it did not exist, so `import … from "@kolekto/adapters"` would
 * have failed. Nothing imported the package yet, so nothing had noticed.
 */

export * from "./settlement-provider.ts";
export * from "./payment-provider.ts";
export * from "./fake-payment-provider.ts";
export * from "./fixtures.ts";
export * from "./email-provider.ts";
export * from "./fake-email-provider.ts";
export * from "./mailpit-email-provider.ts";
export * from "./email-factory.ts";
export * from "./email-webhook-provider.ts";
export * from "./ses-email-provider.ts";
export * from "./ses-sns-webhook-provider.ts";
export * from "./fake-ses-webhook-provider.ts";
