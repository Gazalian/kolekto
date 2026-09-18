/** Joins class names, dropping falsy values. No dependency — the merge logic clsx/tailwind-merge add is not needed at the size of this design system. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
