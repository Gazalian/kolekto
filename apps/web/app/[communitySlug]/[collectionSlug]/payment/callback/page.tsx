import { PaymentCallback } from "./PaymentCallback.tsx";

export default async function PaymentCallbackPage({
  searchParams,
}: {
  params: Promise<{ communitySlug: string; collectionSlug: string }>;
  searchParams: Promise<{ reference?: string; trxref?: string }>;
}) {
  const sp = await searchParams;
  const reference = sp.reference ?? sp.trxref ?? null;
  return <PaymentCallback reference={reference} />;
}
