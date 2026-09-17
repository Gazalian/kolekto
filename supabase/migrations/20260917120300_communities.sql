-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120300 — Communities
--
-- The root aggregate (ADR 0004). `community_id` is the tenancy key for RLS and
-- sits on almost every row in this schema.
--
-- The rule this table exists to enforce: a community is permanent and owns its
-- own record. People join it and leave it through terms. When a treasurer
-- graduates, nothing moves.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.communities (
  id                    uuid primary key default app.uuid_generate_v7(),
  slug                  text        not null,
  name                  text        not null,
  type                  public.community_type   not null,
  status                public.community_status not null default 'active',

  -- COM-01: every user gets a personal community at sign-up. Exactly one per
  -- user, enforced by a partial unique index below. COM-02: it is a full
  -- community and can later be converted to a named one without losing history,
  -- which is a `type` change and nothing else.
  is_personal           boolean     not null default false,

  description           text,
  logo_url              text,
  location_state        text,
  location_city         text,
  institution           text,

  contact_email         extensions.citext,
  contact_phone_e164    text,
  contact_verified_at   timestamptz,

  verification_status   public.verification_status not null default 'unverified',
  verified_at           timestamptz,

  -- PRD 3.2: the owner opts in to showing officers publicly.
  show_officers_publicly boolean    not null default false,

  -- HND-01: prompts at 30 and 7 days before the expected handover month.
  term_length_months    smallint,

  -- PRC-02: the default for new collections. Per-collection setting overrides.
  -- Subject to DEC-12.
  default_fee_mode      public.fee_mode not null default 'community_absorbs',

  created_by            uuid        not null references public.users (id) on delete restrict,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  archived_at           timestamptz,

  constraint communities_name_length
    check (char_length(name) between 3 and 80),
  constraint communities_description_length
    check (description is null or char_length(description) <= 500),
  constraint communities_term_length_sane
    check (term_length_months is null or term_length_months between 1 and 120),
  constraint communities_contact_phone_is_e164
    check (contact_phone_e164 is null or contact_phone_e164 ~ '^\+[1-9][0-9]{7,15}$'),

  -- COM-04: the slug is the public URL. Lowercase, hyphenated, no leading or
  -- trailing hyphen, long enough not to collide by accident.
  constraint communities_slug_format
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$'),

  -- A personal community is always type 'personal', and vice versa. Keeping
  -- these in step means "is this someone's own space" is one question, not two.
  constraint communities_personal_type_agrees
    check (is_personal = (type = 'personal')),

  constraint communities_archived_has_timestamp
    check ((status = 'archived') = (archived_at is not null))
);

comment on table public.communities is
  'The root aggregate. Owns members, collections, money records and officer history (ADR 0004, PRD OWN-01).';
comment on column public.communities.is_personal is
  'COM-01: the community created automatically at sign-up. Exactly one per user. COM-02: convertible to a named community without losing history.';

create unique index communities_slug_key on public.communities (slug);
create index communities_type_idx        on public.communities (type);
create index communities_status_idx      on public.communities (status) where status = 'active';

create trigger communities_set_updated_at
  before update on public.communities
  for each row execute function app.set_updated_at();

alter table public.communities enable row level security;
alter table public.communities force row level security;


-- ── Slug history (COM-04) ────────────────────────────────────────────────────
-- A slug change keeps a redirect from the old one. A shared link is a promise;
-- renaming a community must not break every link already sent on WhatsApp.
create table public.community_slug_history (
  id            uuid primary key default app.uuid_generate_v7(),
  community_id  uuid not null references public.communities (id) on delete cascade,
  slug          text not null,
  released_at   timestamptz not null default now(),

  constraint community_slug_history_format
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$')
);

create unique index community_slug_history_slug_key on public.community_slug_history (slug);
create index community_slug_history_community_idx  on public.community_slug_history (community_id);

alter table public.community_slug_history enable row level security;
alter table public.community_slug_history force row level security;

comment on table public.community_slug_history is
  'COM-04: previously used slugs, kept so old links keep resolving. A slug here can never be reissued to another community.';


-- ── Terminology overrides (COM-05, 14.3) ─────────────────────────────────────
-- "Member" displays as "Unit" for an estate. This is the mechanism that lets
-- the estates vertical be a configuration of the core model rather than a
-- second product — a PRD 14.3 precondition that must exist in MVP even though
-- estate features ship in Phase 5.
create table public.community_labels (
  community_id  uuid not null references public.communities (id) on delete cascade,
  key           text not null,
  label         text not null,
  primary key (community_id, key),

  constraint community_labels_key_known
    check (key in ('member', 'members', 'member_identifier', 'group', 'groups',
                   'collection', 'collections', 'obligation', 'officer')),
  constraint community_labels_label_length
    check (char_length(label) between 1 and 40)
);

alter table public.community_labels enable row level security;
alter table public.community_labels force row level security;

comment on table public.community_labels is
  'COM-05 / PRD 14.3: per-community display terminology, so "Member" can read as "Unit". Defaults only — never restricts behaviour.';


-- ── Exactly one personal community per user ──────────────────────────────────
-- A partial unique index rather than application logic, because "every user has
-- exactly one personal space" is an invariant and invariants belong in the
-- database.
create unique index communities_one_personal_per_user
  on public.communities (created_by)
  where is_personal;
