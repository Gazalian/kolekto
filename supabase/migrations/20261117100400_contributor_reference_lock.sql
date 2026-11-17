-- ─────────────────────────────────────────────────────────────────────────────
-- 20261117100400 — Contributor references are locked once money has arrived
--
-- Design: docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md §6
-- Owner decision 2026-11-17 (Phase 7 = reference codes).
--
-- BEFORE: app.set_collection_code_settings refused a FORMAT change only once a
-- reference had been ISSUED. A collection that had taken payments but issued
-- no reference could still switch codes on, or change prefix / separator /
-- digits / start number / style, or give a tier a code prefix — so references
-- added later would not match the records of the people who already paid.
--
-- NOW: once a collection has ACTIVE CONTRIBUTOR ACTIVITY, the reference
-- configuration cannot gain anything new:
--   · collections.codes_enabled cannot go false → true
--   · collection_code_settings cannot be created, nor its prefix / separator /
--     digits / start_number / style changed
--   · a collection_tiers row cannot gain or change a code_prefix
-- Switching references OFF stays allowed (it only stops new ones), as does
-- every edit that does not touch these columns, and issuing references under
-- an already-fixed configuration.
--
-- ACTIVE CONTRIBUTOR ACTIVITY = money the provider confirmed for this
-- collection: an applied contribution, or a payment attempt captured /
-- needs_review (confirmed money parked for review). A failed, expired or
-- abandoned checkout is NOT activity.
--
-- WHY TRIGGERS. Enforced on the tables, so it holds for every path — the
-- settings function, the tier editor, a future function, a direct write —
-- without re-creating those functions. Each trigger first takes a FOR SHARE
-- lock on the collection row. Capture (app.complete_payment_capture) takes
-- FOR UPDATE on the same row, so a settings change and a capture serialise:
-- whichever commits second sees the first. A capture can never slip in
-- between the check and the change.
--
-- Error: CONTRIBUTOR_REFERENCES_LOCKED (P0001), mapped to the organiser's
-- explanation in apps/web code-actions.ts.
--
-- Additive; existing rows are untouched. Rollback: drop the three triggers
-- and app.assert_references_unlocked / app.collection_has_contributor_activity
-- and the three trigger functions.
-- ─────────────────────────────────────────────────────────────────────────────


create or replace function app.collection_has_contributor_activity(p_collection_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.contributions c
                 where c.collection_id = p_collection_id and c.status = 'applied')
      or exists (select 1 from public.payment_attempts a
                 where a.collection_id = p_collection_id and a.status in ('captured', 'needs_review', 'completed'));
$$;
revoke all on function app.collection_has_contributor_activity(uuid) from public;
grant execute on function app.collection_has_contributor_activity(uuid) to authenticated;

comment on function app.collection_has_contributor_activity(uuid) is
  'True once the provider has confirmed money for this collection (applied contribution, or an attempt captured / needs_review / completed). Failed, expired and abandoned checkouts do not count. Reveals a yes/no only.';

create or replace function app.assert_references_unlocked(p_collection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Serialise with capture, which holds FOR UPDATE on this row.
  perform 1 from public.collections c where c.id = p_collection_id for share;
  if app.collection_has_contributor_activity(p_collection_id) then
    raise exception 'CONTRIBUTOR_REFERENCES_LOCKED: this collection already has active contributors, so new contributor references cannot be added'
      using errcode = 'P0001',
            hint = 'This keeps existing contributor records consistent. You can still switch references off.';
  end if;
end;
$$;
revoke execute on function app.assert_references_unlocked(uuid) from public, anon, authenticated;


-- collections.codes_enabled: off → on
create or replace function app.guard_codes_enabled_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.codes_enabled and not old.codes_enabled then
    perform app.assert_references_unlocked(new.id);
  end if;
  return new;
end;
$$;
revoke execute on function app.guard_codes_enabled_lock() from public, anon, authenticated;

create trigger collections_codes_enabled_lock
  before update of codes_enabled on public.collections
  for each row
  when (old.codes_enabled is distinct from new.codes_enabled)
  execute function app.guard_codes_enabled_lock();


-- collection_code_settings: created, or the format changed
create or replace function app.guard_code_settings_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- app.set_collection_code_settings upserts (INSERT … ON CONFLICT DO UPDATE).
  -- BEFORE INSERT fires even when the row exists and the statement turns into
  -- an UPDATE; that case is judged by the UPDATE firing, which compares the
  -- format columns. Only a genuinely new settings row is judged here.
  if tg_op = 'INSERT' and exists (select 1 from public.collection_code_settings s
                                  where s.collection_id = new.collection_id) then
    return new;
  end if;

  if tg_op = 'INSERT'
     or new.prefix       is distinct from old.prefix
     or new.separator    is distinct from old.separator
     or new.digits       is distinct from old.digits
     or new.start_number is distinct from old.start_number
     or new.style        is distinct from old.style then
    perform app.assert_references_unlocked(new.collection_id);
  end if;
  return new;
end;
$$;
revoke execute on function app.guard_code_settings_lock() from public, anon, authenticated;

create trigger collection_code_settings_reference_lock
  before insert or update on public.collection_code_settings
  for each row execute function app.guard_code_settings_lock();


-- collection_tiers.code_prefix: gained or changed (cleared is allowed: it adds nothing)
--
-- app.set_collection_tiers rewrites every row in two steps inside one
-- transaction: it parks each row (code_prefix = null) and then writes the real
-- values back. Comparing with OLD alone would see the second step as "a prefix
-- appeared" and refuse an ordinary re-save. So the trigger remembers, per tier
-- and per transaction, the prefix the row had BEFORE this transaction first
-- touched it (a transaction-local setting), and compares with that.
create or replace function app.guard_tier_prefix_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key      text;
  v_recorded text;
  v_original text;
begin
  if tg_op = 'UPDATE' then
    v_key := 'kolekto.tier_prefix_' || replace(new.id::text, '-', '_');
    v_recorded := current_setting(v_key, true);
    if v_recorded is null or v_recorded = '' then
      -- 'v:' marks "recorded" so an original NULL prefix is distinguishable
      -- from "never recorded" (an unset custom setting reads as '').
      v_recorded := 'v:' || coalesce(old.code_prefix, '');
      perform set_config(v_key, v_recorded, true);
    end if;
    v_original := nullif(substr(v_recorded, 3), '');
  end if;

  if new.code_prefix is not null
     and (tg_op = 'INSERT' or new.code_prefix is distinct from v_original) then
    perform app.assert_references_unlocked(new.collection_id);
  end if;
  return new;
end;
$$;
revoke execute on function app.guard_tier_prefix_lock() from public, anon, authenticated;

create trigger collection_tiers_prefix_reference_lock
  before insert or update of code_prefix on public.collection_tiers
  for each row execute function app.guard_tier_prefix_lock();
