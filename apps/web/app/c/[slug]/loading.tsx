import { Skeleton } from "@kolekto/ui";

export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
      <div className="grid gap-6 xl:grid-cols-5">
        <Skeleton className="h-56 w-full xl:col-span-3" />
        <Skeleton className="h-56 w-full xl:col-span-2" />
      </div>
    </div>
  );
}
