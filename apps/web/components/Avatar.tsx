import { initials } from "../lib/community-display.ts";

/**
 * A person's photo, or their initials when there is none (D-F). Only URLs
 * from this deployment's profile-avatars bucket are rendered — the database
 * refuses anything else (app.set_my_avatar), and this check keeps a stray
 * value from ever loading a third-party image.
 */
export function isProfileAvatarUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https?:\/\/[^/?#]+\/storage\/v1\/object\/public\/profile-avatars\//.test(url);
}

export function Avatar({
  name,
  url,
  className = "h-9 w-9 text-xs",
}: {
  name: string;
  url?: string | null | undefined;
  className?: string;
}) {
  if (isProfileAvatarUrl(url)) {
    return (
      // A user-uploaded image on the storage host, not a bundled asset.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        className={`${className} shrink-0 rounded-full object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${className} flex shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] font-semibold text-[var(--color-primary-fg)]`}
    >
      {initials(name)}
    </span>
  );
}
