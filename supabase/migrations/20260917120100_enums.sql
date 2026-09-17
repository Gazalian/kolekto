-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120100 — Enumerated types
--
-- PRD STM-01: states are Postgres enums, and each object has one transition
-- function that checks the current state with compare-and-set.
--
-- The previous system used `character varying(20)` free text for every status.
-- `contributions.status` held 'paid', 'pending' and 'duplicate_voided' with no
-- constraint; `withdrawals.status` held 'approved', 'success', 'rejected' and
-- 'pending', where the difference between 'approved' and 'success' existed only
-- in a TypeScript Set and the admin UI disagreed with it. ₦41.6m sits in that
-- ambiguity. Enums make a status mean one thing.
--
-- Only states for objects this phase actually creates are defined here. Money
-- object states arrive with the ledger (ADR 0006).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Communities ──────────────────────────────────────────────────────────────

create type public.community_type as enum (
  'personal',              -- COM-01: created for every user at sign-up
  'university_association',
  'fellowship',
  'alumni_association',
  'cooperative',
  'estate',
  'professional_association',
  'event_committee',
  'social_group',
  'school_pta',
  'community_development',
  'other'
);

create type public.community_status as enum (
  'active',
  'restricted',   -- trust action: no new collections, existing continue
  'suspended',    -- trust action: everything suspended, records kept
  'archived'      -- OWN-04: read-only, reactivatable, never auto-deleted
);

create type public.verification_status as enum (
  'unverified',
  'pending',
  'verified',
  'rejected',
  'expired'       -- TRU-04: verified officers all left without a successor
);


-- ── Officers and roles ───────────────────────────────────────────────────────

-- PRD 2.1. Five officer roles. `member` and `contributor` are NOT in this enum:
-- they are not officer roles and hold no officer permissions. Keeping them out
-- means a membership row can never be mistaken for an authority row.
create type public.officer_role as enum (
  'owner',
  'admin',
  'treasurer',
  'collector',
  'viewer'
);

-- OFF-02: how a term started and how it ended, so leadership history reads as
-- a narrative rather than a set of orphaned rows.
create type public.officer_term_start_reason as enum (
  'created',      -- founded the community
  'invited',
  'handover',
  'recovery'      -- 13.8 emergency ownership recovery
);

create type public.officer_term_end_reason as enum (
  'handover',
  'removed',
  'resigned',
  'recovered',    -- superseded by an ownership recovery
  'account_closed'
);


-- ── Members ──────────────────────────────────────────────────────────────────

-- PRD 3.3. A member record is created by the community and is not a user
-- account. It may be claimed later by the person it describes.
create type public.member_status as enum (
  'pending_approval',  -- joined via invite link, community requires approval
  'unclaimed',         -- imported or added by an officer, not yet confirmed
  'invited',           -- an invite has been sent
  'active',            -- confirmed their details and verified their phone
  'archived',          -- graduated, moved out. History kept.
  'merged'             -- folded into another record; points at the survivor
);

create type public.member_joined_via as enum (
  'invite_link',
  'import',
  'manual',
  'payment',           -- MEM-15: became a contributor profile first
  'migration'          -- imported from the previous Kolekto platform (ENG-05)
);

create type public.member_attribute_type as enum (
  'text',
  'number',
  'single_select',
  'date'
);


-- ── Collections ──────────────────────────────────────────────────────────────

-- PRD 4.1, the four configuration axes. Templates in the UI are presets over
-- these; they are not themselves a type, which is why the previous system's
-- `collection_type` string is not reproduced.
create type public.participation_mode as enum (
  'open',      -- anyone with the link may pay
  'managed'    -- a defined list of members is expected to pay
);

create type public.amount_model as enum (
  'fixed',
  'open_amount',
  'tiers',
  'per_member'  -- managed only
);

create type public.payment_plan as enum (
  'full_only',
  'installments_allowed'
);

create type public.collection_schedule as enum (
  'one_time',
  'recurring'   -- managed only; monthly in MVP
);

-- PRD 4.8 and the state machine in 18.1.
create type public.collection_status as enum (
  'draft',
  'scheduled',
  'active',
  'paused',
  'closed',
  'suspended',  -- Kolekto risk action only
  'archived'    -- terminal, read-only
);

create type public.collection_visibility as enum (
  'public',      -- listed on the community page
  'unlisted',    -- link only
  'members_only'
);

-- PRD 4.3: category drives risk review, not behaviour.
create type public.collection_category as enum (
  'dues',
  'contribution',
  'event',
  'fundraiser',
  'items',
  'other'
);

-- PRD 15.3 / PRC-02. Subject to DEC-12: whether fees may be passed to
-- contributors at all is a legal question. Both values exist so the engine can
-- express either answer.
create type public.fee_mode as enum (
  'community_absorbs',
  'contributor_pays'
);


-- ── Obligations ──────────────────────────────────────────────────────────────

-- PRD 5.2 and the state machine in 18.2.
--
-- There is deliberately no 'manually_paid' value, and there never will be:
-- CASH-01, CASH-02 and SEC-20a forbid any path that marks an obligation paid
-- without a Paystack transaction. A pgTAP test asserts no such path exists.
create type public.obligation_status as enum (
  'unpaid',
  'in_installments',
  'overdue',
  'paid',
  'exempt',
  'cancelled'
);


-- ── Invitations ──────────────────────────────────────────────────────────────

create type public.invite_status as enum (
  'active',
  'expired',
  'exhausted',   -- usage limit reached
  'revoked'
);

create type public.officer_invitation_status as enum (
  'sent',
  'accepted',
  'declined',
  'expired',
  'revoked'
);


-- ── Audit ────────────────────────────────────────────────────────────────────

create type public.audit_actor_type as enum (
  'officer',
  'member',
  'contributor',
  'staff',        -- ADR 0009: visible to the community (AUD-03)
  'system'        -- a job, not a person
);
