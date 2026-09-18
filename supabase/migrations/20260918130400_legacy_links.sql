-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918130400 — Phase 1.5 / M6: legacy_links
--
-- Migration Architecture section 6 and section 15 (M6). A shared collection
-- URL is a promise made to hundreds of people in WhatsApp groups; a receipt
-- link is evidence someone paid. Neither may break when a collection's address
-- changes from a bare `/{slug}` to `/{community-slug}/{collection-slug}`.
--
-- This table is DATA, not a routing rule compiled into the application, which
-- is what makes it auditable (Part C, M6: "It must be auditable") and
-- extensible to link shapes discovered after this migration — including ones
-- printed on paper, which no pattern-matching rule could anticipate.
--
-- Populated by the migration pipeline when it runs. Empty after this
-- migration, and empty is the correct state for Phase 1.5 (Part E: "Do not
-- populate it with production data yet").
-- ─────────────────────────────────────────────────────────────────────────────

create type public.legacy_link_kind as enum (
  'collection_slug',    -- old bare /{slug}
  'collection_uuid',     -- old /{uuid}, if such a route existed
  'receipt',              -- old receipt/verification link
  'contributor_code',    -- old ticket/pickup code verification link
  'other'
);

create table public.legacy_links (
  id            uuid primary key default app.uuid_generate_v7(),

  -- The path as it appeared in the old system, WITHOUT a leading slash (so a
  -- comparison is a straight string match regardless of how the serving route
  -- normalises a leading slash). Unique: one old path resolves to exactly one
  -- place, or the redirect is ambiguous by definition.
  old_path      text not null,
  new_path      text not null,

  kind          public.legacy_link_kind not null,

  -- The collection this link ultimately concerns, when there is one. Nullable
  -- because a receipt link's target is a receipt, not necessarily identified
  -- by collection alone at the schema level.
  collection_id uuid references public.collections (id) on delete cascade,

  notes         text,
  created_by    uuid references public.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint legacy_links_old_path_not_empty check (char_length(old_path) > 0),
  constraint legacy_links_new_path_not_empty check (char_length(new_path) > 0),
  -- An old path never carries a leading slash, so string comparison against
  -- an incoming request path (after trimming) is unambiguous either way.
  constraint legacy_links_old_path_no_leading_slash check (old_path not like '/%')
);

comment on table public.legacy_links is
  'Old URL to new path, for every legacy link shape discovered during migration: collection slugs, receipt links, contributor codes. Migration Architecture section 6. Read by the web application''s server-side catch-all redirect handler using the service role — never exposed to anon or authenticated (see 20260918130800_phase1_5_grants.sql), because the redirect lookup is server-side routing logic, not client data.';
comment on column public.legacy_links.old_path is
  'The path exactly as it appeared in the old system, with no leading slash. Unique — one old path resolves to exactly one destination.';

create unique index legacy_links_old_path_key on public.legacy_links (old_path);
create index legacy_links_collection_idx on public.legacy_links (collection_id) where collection_id is not null;

create trigger legacy_links_set_updated_at
  before update on public.legacy_links
  for each row execute function app.set_updated_at();

alter table public.legacy_links enable row level security;
alter table public.legacy_links force row level security;

-- No client role ever reads this table directly — the redirect lookup runs
-- server-side, through the service role (which bypasses RLS entirely, so this
-- policy never governs its access). This policy exists to make that a stated
-- decision rather than a silent zero-policy gap: 01_rls_coverage.sql asserts
-- every table in public carries at least one policy, precisely so an absence
-- is never mistaken for an oversight.
create policy legacy_links_deny_client_access
  on public.legacy_links for select to authenticated
  using (false);
