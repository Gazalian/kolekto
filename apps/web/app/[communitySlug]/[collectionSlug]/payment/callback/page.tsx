import { PaymentCallback } from "./PaymentCallback.tsx";

export const metadata = {
  title: "Payment",
  robots: { index: false, follow: false },
};

export default async function PaymentCallbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ communitySlug: string; collectionSlug: string }>;
  searchParams: Promise<{ reference?: string | string[]; trxref?: string | string[] }>;
}) {
  const { communitySlug, collectionSlug } = await params;
  const sp = await searchParams;
  const rawRef = sp.reference;
  const ref = Array.isArray(rawRef) ? rawRef[0] : rawRef;
  const rawTrx = sp.trxref;
  const trx = Array.isArray(rawTrx) ? rawTrx[0] : rawTrx;
  const reference = ref ?? trx ?? null;
  return <PaymentCallback reference={reference} communitySlug={communitySlug} collectionSlug={collectionSlug} />;
}
