import { Skeleton } from "@kolekto/ui";

export default function Loading() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <Skeleton className="h-7 w-48" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </main>
  );
}
