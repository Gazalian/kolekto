"use client";

import { Button, Dialog } from "@kolekto/ui";
import { Check, Copy, ExternalLink, Mail, MessageCircle, Send, Share2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The header's Share button and its dialog. The link is the PUBLIC collection
 * page (`collectionPath`), the address a contributor opens without signing in —
 * never this management page, never an internal id.
 */
export function ShareCollectionButton({
  url,
  name,
  description,
  disabledReason,
}: {
  /** Absolute public URL; empty until the browser knows its origin. */
  url: string;
  name: string;
  description: string | null;
  /** Shown instead of the dialog when the link does not work yet (a draft). */
  disabledReason: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className="shadow-sm"
        aria-haspopup="dialog"
        title={disabledReason ?? "Share this collection"}
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        Share
      </Button>
      {open && (
        <ShareDialog url={url} name={name} description={description} disabledReason={disabledReason} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function ShareDialog({
  url,
  name,
  description,
  disabledReason,
  onClose,
}: {
  url: string;
  name: string;
  description: string | null;
  disabledReason: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const message = `${name} — contribute here: ${url}`;
  const blurb = description ? (description.length > 160 ? `${description.slice(0, 157).trimEnd()}…` : description) : null;

  // navigator.share exists only in the browser, and only on some; checked
  // after mount so the server render and the first client render agree.
  useEffect(() => {
    const id = requestAnimationFrame(() => setCanNativeShare(typeof navigator !== "undefined" && typeof navigator.share === "function"));
    return () => cancelAnimationFrame(id);
  }, []);

  async function copy(): Promise<void> {
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // Clipboard API refused (embedded browser, no permission): select the
      // field and fall back to the legacy copy command.
      const field = document.getElementById("share-link") as HTMLInputElement | null;
      field?.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) setTimeout(() => setCopied(false), 2500);
  }

  async function nativeShare(): Promise<void> {
    try {
      await navigator.share({ title: name, text: `${name} — contribute here:`, url });
    } catch {
      // Dismissed by the person, or refused by the browser: nothing to do.
    }
  }

  const targets = [
    { label: "WhatsApp", href: `https://wa.me/?text=${encodeURIComponent(message)}`, icon: MessageCircle },
    { label: "Telegram", href: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(name)}`, icon: Send },
    { label: "X", href: `https://x.com/intent/post?text=${encodeURIComponent(message)}`, icon: Share2 },
    { label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, icon: Share2 },
    { label: "Email", href: `mailto:?subject=${encodeURIComponent(name)}&body=${encodeURIComponent(message)}`, icon: Mail },
  ];

  if (disabledReason) {
    return (
      <Dialog open onClose={onClose} title="Not ready to share yet">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-text)]">{disabledReason}</p>
          <Button variant="secondary" onClick={onClose} className="self-start">
            OK
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title="Share this collection" className="max-w-md">
      <div className="flex flex-col gap-4">
        {/* What people will see. */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <p className="text-sm font-semibold text-[var(--color-text)]">{name}</p>
          {blurb && <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">{blurb}</p>}
          <p className="mt-2 truncate text-xs text-[var(--color-primary)]">{url.replace(/^https?:\/\//, "")}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="share-link" className="text-xs font-medium text-[var(--color-text-muted)]">
            Collection link
          </label>
          <div className="flex gap-2">
            <input
              id="share-link"
              readOnly
              value={url}
              onFocus={(event) => event.currentTarget.select()}
              className="h-10 min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
            />
            <Button onClick={() => void copy()} variant={copied ? "secondary" : "primary"} className="shrink-0">
              {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p aria-live="polite" className="min-h-4 text-xs">
            {copied ? (
              <span className="text-[var(--color-success)]">Link copied. Paste it anywhere.</span>
            ) : copyFailed ? (
              <span className="text-[var(--color-danger)]">Your browser blocked copying. Select the link and copy it.</span>
            ) : (
              <span className="text-[var(--color-text-muted)]">Anyone with this link can open the page and pay, no account needed.</span>
            )}
          </p>
        </div>

        {canNativeShare && (
          <Button variant="secondary" onClick={() => void nativeShare()}>
            <Share2 className="h-4 w-4" aria-hidden="true" /> Share with an app…
          </Button>
        )}

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {targets.map((target) => (
            <a
              key={target.label}
              href={target.href}
              target="_blank"
              rel="noreferrer noopener"
              className="flex flex-col items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-2.5 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg)]"
            >
              <target.icon className="h-4 w-4" aria-hidden="true" />
              {target.label}
            </a>
          ))}
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex flex-col items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-2.5 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg)]"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Open
          </a>
        </div>
      </div>
    </Dialog>
  );
}
