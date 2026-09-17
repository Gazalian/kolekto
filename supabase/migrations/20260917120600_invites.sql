-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120600 — Invite links and officer invitations
--
-- SEC-20b: invite-link tokens, personal-link tokens and installment codes are
-- stored HASHED, are non-guessable, and are rate-limited on entry.
--
-- The pattern used throughout: store `token_hash` (sha-256 of the secret) plus
-- a short `token_prefix` for lookup. The prefix narrows the index scan; the
-- hash proves the bearer holds the secret. A database dump therefore contains
-- no usable invite link, which is not true of the previous system's tokens.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── MEM-05: member invite links ──────────────────────────────────────────────
create table public.invite_links (
  id                  uuid primary key default app.uuid_generate_v7(),
  community_id        uuid not null references public.communities (id) on delete cascade,

  token_prefix        text not null,
  token_hash          text not null,

  -- MEM-05: a link may be scoped to one or more groups; joiners land in them
  -- automatically. MEM-04 governs which groups a joiner may pick for themselves.
  group_ids           uuid[] not null default '{}',
  allow_group_choice  boolean not null default false,
  allow_multi_group   boolean not null default false,

  -- MEM-09: when on, a joiner stays `pending_approval` until an officer acts.
  approve_joiners     boolean not null default false,

  expires_at          timestamptz,
  max_uses            integer,
  uses                integer not null default 0,
  status              public.invite_status not null default 'active',

  label               text,
  created_by          uuid not null references public.users (id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  revoked_at          timestamptz,

  constraint invite_links_token_prefix_format check (token_prefix ~ '^[A-Za-z0-9_-]{8,16}$'),
  constraint invite_links_token_hash_format   check (token_hash   ~ '^[a-f0-9]{64}$'),
  constraint invite_links_max_uses_positive   check (max_uses is null or max_uses > 0),
  constraint invite_links_uses_within_max     check (max_uses is null or uses <= max_uses),
  constraint invite_links_uses_not_negative   check (uses >= 0),
  constraint invite_links_label_length        check (label is null or char_length(label) <= 60),
  constraint invite_links_revoked_consistently
    check ((status = 'revoked') = (revoked_at is not null))
);

comment on table public.invite_links is
  'MEM-05: the primary way members join. The token is never stored in the clear (SEC-20b) — a database dump yields no working link.';
comment on column public.invite_links.token_prefix is
  'Lookup key. Narrows the index scan so the hash comparison happens on one row.';

create unique index invite_links_token_prefix_key on public.invite_links (token_prefix);
create index invite_links_community_idx on public.invite_links (community_id)
  where status = 'active';

create trigger invite_links_set_updated_at
  before update on public.invite_links
  for each row execute function app.set_updated_at();

alter table public.invite_links enable row level security;
alter table public.invite_links force row level security;

-- Deferred from the members migration: a member may record which link it
-- arrived through, for attribution and for revoking a leaked link's intake.
alter table public.members
  add constraint members_invite_link_fkey
  foreign key (invite_link_id) references public.invite_links (id) on delete set null;


-- ── OFF-01: officer invitations ──────────────────────────────────────────────
-- An owner invites by phone or email. The invitee signs in with OTP and
-- accepts. Invites expire after seven days.
create table public.officer_invitations (
  id                  uuid primary key default app.uuid_generate_v7(),
  community_id        uuid not null references public.communities (id) on delete cascade,

  role                public.officer_role not null,
  title               text,
  scope               jsonb,

  invitee_name        text,
  invitee_phone_e164  text,
  invitee_email       extensions.citext,

  token_prefix        text not null,
  token_hash          text not null,

  status              public.officer_invitation_status not null default 'sent',
  expires_at          timestamptz not null default (now() + interval '7 days'),

  -- Set when a handover created this invitation, so the acceptance flows into
  -- the right term rather than creating a loose one.
  handover_id         uuid,

  accepted_at         timestamptz,
  accepted_by         uuid references public.users (id) on delete set null,
  declined_at         timestamptz,
  revoked_at          timestamptz,

  invited_by          uuid not null references public.users (id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint officer_invitations_token_prefix_format check (token_prefix ~ '^[A-Za-z0-9_-]{8,16}$'),
  constraint officer_invitations_token_hash_format   check (token_hash   ~ '^[a-f0-9]{64}$'),
  constraint officer_invitations_phone_is_e164
    check (invitee_phone_e164 is null or invitee_phone_e164 ~ '^\+[1-9][0-9]{7,15}$'),
  constraint officer_invitations_reachable
    check (invitee_phone_e164 is not null or invitee_email is not null),
  constraint officer_invitations_scope_only_for_collectors
    check (scope is null or role = 'collector'),
  constraint officer_invitations_accepted_consistently
    check ((status = 'accepted') = (accepted_at is not null)
           and (accepted_at is null) = (accepted_by is null))
);

comment on table public.officer_invitations is
  'OFF-01: an invitation to hold a role. Accepting creates an officer_term; the invitation itself never grants anything.';

create unique index officer_invitations_token_prefix_key on public.officer_invitations (token_prefix);
create index officer_invitations_community_idx on public.officer_invitations (community_id)
  where status = 'sent';

create trigger officer_invitations_set_updated_at
  before update on public.officer_invitations
  for each row execute function app.set_updated_at();

alter table public.officer_invitations enable row level security;
alter table public.officer_invitations force row level security;
