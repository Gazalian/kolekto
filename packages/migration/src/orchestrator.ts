/**
 * The importer orchestrator. Reads a legacy source (D2 restore or synthetic
 * fixtures) and writes into a disposable rehearsal target under one open
 * migration.import_runs row.
 *
 * KEY INVARIANT: every group of statements that needs the import context or
 * kolekto_importer role runs inside ONE `sql.begin()` block, because both
 * `set_config(..., true)` and `SET LOCAL role` are transaction-scoped.
 */

import type { Sql } from "postgres";
import { createHash, randomUUID } from "node:crypto";
import {
  transformUser, transformCollection,
  buildContributorCodeLink, resolveCodeSequences,
  nairaToKobo,
  type LegacyProfile, type LegacyCollection, type LegacyTierEntry,
} from "./transformers/index.ts";

export type SourceProject =
  | `legacy-production:${string}`
  | `legacy-test:${string}`
  | `synthetic:${string}`;

export interface LegacyContribution {
  readonly id: string;
  readonly collection_id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly amount: string;
  readonly gross_amount: string | null;
  readonly contributor_information: unknown;
  readonly contributor_unique_code: string | null;
  readonly payment_reference: string | null;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly payment_id: string | null;
  readonly check_in_status: string | null;
  readonly line_index: number | null;
}

export interface LegacyDeposit {
  readonly id: string;
  readonly full_name: string;
  readonly email: string;
  readonly phone_number: string | null;
  readonly amount: string;
  readonly status: string;
  readonly payment_reference: string;
  readonly access_code: string | null;
  readonly authorization_url: string | null;
  readonly contributor_id: string | null;
  readonly collection_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly paid_at: Date | null;
  readonly channel: string | null;
  readonly currency: string | null;
  readonly wallet_id: string | null;
  readonly settled_at: Date | null;
  readonly settlement_status: string | null;
  readonly net_amount: string;
  readonly init_email_sent: boolean;
  readonly contributor_confirmed_sent: boolean;
  readonly organizer_notified_sent: boolean;
}

export interface LegacyWithdrawal {
  readonly id: string;
  readonly user_id: string;
  readonly collection_id: string;
  readonly wallet_id: string;
  readonly amount: string;
  readonly status: string;
  readonly destination_account: unknown;
  readonly paystack_transfer_code: string | null;
  readonly paystack_recipient_code: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface LegacyWallet {
  readonly id: string;
  readonly collection_id: string;
  readonly available_balance: string;
  readonly ledger_balance: string;
  readonly gross_payment: string;
  readonly net_payment: string;
  readonly withdrawn: string;
  readonly fee_breakdown: unknown;
  readonly pending_balance: string;
  readonly created_at: Date | null;
  readonly updated_at: Date | null;
}

export interface LegacyPaymentRecoveryLog {
  readonly id: string;
  readonly reference: string | null;
  readonly collection_id: string | null;
  readonly success: boolean | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly context: unknown;
  readonly invocation_source: string | null;
  readonly attempt_number: number | null;
  readonly duration_ms: number | null;
  readonly created_at: Date | null;
}

export interface LegacyPendingPaymentContext {
  readonly reference: string;
  readonly collection_id: string | null;
  readonly metadata: unknown;
  readonly created_at: Date;
  readonly paystack_transaction_id: string | null;
  readonly paystack_status: string | null;
  readonly captured_amount: string | null;
  readonly currency: string | null;
  readonly channel: string | null;
  readonly paid_at: Date | null;
  readonly captured_at: Date | null;
  readonly verified_at: Date | null;
  readonly verification_payload: unknown;
  readonly contributor_email: string | null;
  readonly organizer_id: string | null;
  readonly state: string;
  readonly failure_code: string | null;
  readonly failure_reason: string | null;
  readonly failure_context: unknown;
  readonly retry_count: number;
  readonly last_attempt_at: Date | null;
  readonly next_retry_at: Date | null;
  readonly reconciliation_state: string | null;
  readonly resolved_at: Date | null;
  readonly resolved_by: string | null;
  readonly updated_at: Date;
}

export interface LegacyPaymentAdminAction {
  readonly id: string;
  readonly reference: string | null;
  readonly collection_id: string | null;
  readonly admin_user_id: string | null;
  readonly action: string | null;
  readonly old_status: string | null;
  readonly new_status: string | null;
  readonly reason: string | null;
  readonly notes: string | null;
  readonly created_at: Date | null;
}

export interface LegacySettlementRun {
  readonly id: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly cutoff_used: Date | null;
  readonly wallets_processed: number | null;
  readonly drift_after: number | null;
  readonly triggered_by: string | null;
  readonly ok: boolean | null;
  readonly overwithdrawn_after: number | null;
}

export interface LegacyAdminEvent {
  readonly id: string;
  readonly event_type: string | null;
  readonly severity: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly actor_id: string | null;
  readonly metadata: unknown;
  readonly created_at: Date | null;
}

export interface LegacyCampus {
  readonly campus_id: number;
  readonly campus_name: string | null;
  readonly campus_code: string | null;
}

export interface SourceRepository {
  readonly listProfiles: () => Promise<readonly LegacyProfile[]>;
  readonly listCollections: () => Promise<readonly LegacyCollection[]>;
  readonly listTiersForCollection: (legacyCollectionId: string) => Promise<readonly LegacyTierEntry[]>;
  readonly listContributionsForCollection: (
    legacyCollectionId: string,
  ) => Promise<readonly LegacyContribution[]>;
  readonly listContributionCodeCounters: () => Promise<readonly {
    readonly collection_id: string; readonly prefix: string; readonly next_number: number;
  }[]>;
  readonly listAttributedDeposits: () => Promise<readonly LegacyDeposit[]>;
  readonly listUnattributedDeposits: () => Promise<readonly LegacyDeposit[]>;
  readonly listWithdrawals: () => Promise<readonly LegacyWithdrawal[]>;
  readonly listWallets: () => Promise<readonly LegacyWallet[]>;
  readonly listPaymentRecoveryLogs: () => Promise<readonly LegacyPaymentRecoveryLog[]>;
  readonly listPendingPaymentContexts: () => Promise<readonly LegacyPendingPaymentContext[]>;
  readonly listPaymentAdminActions: () => Promise<readonly LegacyPaymentAdminAction[]>;
  readonly listSettlementRuns: () => Promise<readonly LegacySettlementRun[]>;
  readonly listAdminEvents: () => Promise<readonly LegacyAdminEvent[]>;
  readonly listCampuses: () => Promise<readonly LegacyCampus[]>;
}

export interface OrchestratorInput {
  readonly source_project: SourceProject;
  readonly source_snapshot_label: string;
  readonly notes: string;
  readonly source: SourceRepository;
  readonly target: Sql;
}

export interface OrchestratorOutput {
  readonly runId: string;
  readonly counts: OrchestratorCounts;
}

export interface OrchestratorCounts {
  profiles_seen: number;
  users_imported: number;
  personal_communities_imported: number;
  owner_terms_imported: number;
  collections_seen: number;
  collections_imported: number;
  collections_excluded_rejected: number;
  tiers_imported: number;
  code_sequences_seeded: number;
  code_sequences_orphaned: number;
  contributor_code_links: number;
  legacy_profile_rows: number;
  legacy_collection_rows: number;
  legacy_contribution_rows: number;
  attributed_deposits_seen: number;
  attributed_deposits_imported: number;
  unattributed_deposits_seen: number;
  unattributed_deposits_imported: number;
  withdrawals_seen: number;
  withdrawals_imported: number;
  phones_deduped: number;
  overflow_imported: number;
}

/**
 * Deterministic target UUID for a legacy id.
 *
 * Keyed by (source_project, kind, legacy_id) — NOT by run id. Two runs of the
 * same source-and-kind produce the same target uuid, which is the whole point
 * of idempotent re-import: personal community <user X> resolves to the same
 * uuid on run 1, run 2, and every run after.
 *
 * source_project discriminates different data sets that might carry the same
 * legacy id: synthetic:foo and legacy-production:busf… never collide.
 */
function targetUuidFor(sourceProject: string, kind: string, legacyId: string): string {
  const hex = createHash("sha256").update(`${sourceProject}|${kind}|${legacyId}`).digest("hex");
  const bytes = Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function withdrawalFields(w: LegacyWithdrawal): Record<string, unknown> {
  return {
    user_id: w.user_id, collection_id: w.collection_id, wallet_id: w.wallet_id,
    amount: w.amount, status: w.status,
    paystack_transfer_code: w.paystack_transfer_code ?? null,
    paystack_recipient_code: w.paystack_recipient_code ?? null,
    created_at: w.created_at, updated_at: w.updated_at,
  };
}

function depositFields(d: LegacyDeposit): Record<string, unknown> {
  return {
    full_name: d.full_name, email: d.email, phone_number: d.phone_number ?? null,
    amount: d.amount, status: d.status, payment_reference: d.payment_reference,
    access_code: d.access_code ?? null, authorization_url: d.authorization_url ?? null,
    contributor_id: d.contributor_id ?? null, collection_id: d.collection_id ?? null,
    created_at: d.created_at, updated_at: d.updated_at, paid_at: d.paid_at ?? null,
    channel: d.channel ?? null, currency: d.currency ?? null, wallet_id: d.wallet_id ?? null,
    settled_at: d.settled_at ?? null, settlement_status: d.settlement_status ?? null,
    net_amount: d.net_amount,
    init_email_sent: d.init_email_sent, contributor_confirmed_sent: d.contributor_confirmed_sent,
    organizer_notified_sent: d.organizer_notified_sent,
  };
}

export async function runImport(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const { source, target, source_project, source_snapshot_label, notes } = input;
  const runId = randomUUID();

  const counts: OrchestratorCounts = {
    profiles_seen: 0, users_imported: 0, personal_communities_imported: 0, owner_terms_imported: 0,
    collections_seen: 0, collections_imported: 0, collections_excluded_rejected: 0,
    tiers_imported: 0, code_sequences_seeded: 0, code_sequences_orphaned: 0,
    contributor_code_links: 0,
    legacy_profile_rows: 0, legacy_collection_rows: 0, legacy_contribution_rows: 0,
    attributed_deposits_seen: 0, attributed_deposits_imported: 0,
    unattributed_deposits_seen: 0, unattributed_deposits_imported: 0,
    withdrawals_seen: 0, withdrawals_imported: 0,
    phones_deduped: 0,
    overflow_imported: 0,
  };

  // 1. Open the run.
  await target`insert into migration.import_runs (id, source_project, source_snapshot_label, notes)
               values (${runId}, ${source_project}, ${source_snapshot_label}, ${notes})`;

  // 2. Users, communities, owner terms — one transaction per user so the
  //    import context and role stay set across the trigger-firing insert into
  //    auth.users and every follow-up.
  //    Sorted by id for deterministic phone deduplication: within each group of
  //    profiles sharing a phone number, the first by UUID sort keeps phone_e164;
  //    the rest get NULL. Original phone is preserved in legacy_profile.fields.
  const profiles = (await source.listProfiles()).slice().sort((a, b) => a.id.localeCompare(b.id));
  counts.profiles_seen = profiles.length;
  const seenPhones = new Set<string>();
  for (const p of profiles) {
    const communityId = targetUuidFor(source_project, "personal_community", p.id);
    const { user, community, term } = transformUser({ profile: p, newCommunityId: communityId });

    let effectivePhone = user.phone_e164;
    let phoneDeduped = false;
    if (effectivePhone !== null) {
      if (seenPhones.has(effectivePhone)) {
        effectivePhone = null;
        phoneDeduped = true;
        counts.phones_deduped++;
      } else {
        seenPhones.add(effectivePhone);
      }
    }

    await target.begin(async (tx) => {
      // The import context — makes the sign-up trigger stand aside for this transaction.
      await tx`select set_config('kolekto.import_run_id', ${runId}, true)`;

      // auth.users first (as the connection role — owner privilege)
      await tx`insert into auth.users (id, instance_id, aud, role, email)
               values (${p.id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${p.email})
               on conflict (id) do nothing`;

      // Switch to importer for the migration-schema and public writes.
      await tx`set local role kolekto_importer`;

      // public.users first — legacy_profile.user_id references it.
      await tx`insert into public.users (id, full_name, phone_e164, email, avatar_url)
               values (${user.id}, ${user.full_name}, ${effectivePhone}, ${user.email ?? null}, ${user.avatar_url})
               on conflict (id) do nothing`;
      counts.users_imported++;

      const profileFields: Record<string, unknown> = {
        full_name: p.full_name ?? null, first_name: p.first_name ?? null, last_name: p.last_name ?? null,
        email: p.email ?? null, phone_number: p.phone_number ?? null, avatar_url: p.avatar_url ?? null,
        address: p.address ?? null, date_of_birth: p.date_of_birth ?? null,
        signup_ip: p.signup_ip ?? null, role: p.role ?? null,
        ...(phoneDeduped ? { _phone_deduped: true } : {}),
      };
      await tx`insert into migration.legacy_profile (source_table, source_id, user_id, fields, import_run_id)
               values ('profiles', ${p.id}, ${p.id}, ${tx.json(profileFields)}, ${runId})
               on conflict (source_table, source_id) do nothing`;
      counts.legacy_profile_rows++;

      // The user's personal community. `communities_one_personal_per_user` is a
      // partial unique index on (created_by) WHERE is_personal, so on re-import
      // the row already exists — we skip and then RESOLVE the actual id below.
      await tx`insert into public.communities (id, slug, name, type, is_personal, created_by)
               select ${community.id}, app.generate_unique_community_slug(${community.slug_hint}),
                       ${community.name}, 'personal', true, ${community.created_by}
               where not exists (select 1 from public.communities where created_by = ${community.created_by} and is_personal)`;
      counts.personal_communities_imported++;

      // Resolve the ACTUAL personal community id, whether it was just inserted
      // or was already there. This is the id used for provenance and the term.
      const [{ id: actualCommunityId }] = await tx<{ id: string }[]>`
        select id from public.communities where created_by = ${community.created_by} and is_personal limit 1`;

      // Owner term (start_reason='migration'). Ordered AFTER the community and
      // pointed at the actual id to satisfy the FK.
      await tx`insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason)
               select ${actualCommunityId}, ${term.user_id}, 'owner', ${term.actor_name_snapshot}, 'migration'
               where not exists (
                 select 1 from public.officer_terms ot
                 where ot.community_id = ${actualCommunityId} and ot.user_id = ${term.user_id} and ot.role = 'owner' and ot.ended_at is null
               )`;
      counts.owner_terms_imported++;

      // Provenance — for the actual community, not the derived candidate.
      for (const [target_table, target_id] of [
        ["public.users", user.id],
        ["public.communities", actualCommunityId],
      ] as const) {
        await tx`insert into migration.imported_objects
                 (source_project, import_run_id, source_table, source_id, target_table, target_id)
                 values (${source_project}, ${runId}, 'auth.users', ${p.id}, ${target_table}, ${target_id})
                 on conflict (source_project, source_table, source_id, target_table) do nothing`;
      }
    });
  }

  // 3. Collections + tiers. One transaction per collection.
  const collections = await source.listCollections();
  counts.collections_seen = collections.length;
  const legacyToNewCollection = new Map<string, string>();
  const tierPrefixLookup: { new_collection_id: string; new_tier_id: string; normalised_prefix: string }[] = [];

  for (const legacy of collections) {
    const communityId = targetUuidFor(source_project, "personal_community", legacy.user_id);
    const newCollectionId = targetUuidFor(source_project, "collection", legacy.id);
    const tiers = await source.listTiersForCollection(legacy.id);
    const newTierIds = tiers.map((t) => targetUuidFor(source_project, "tier", `${legacy.id}|${t.ord}|${t.id ?? ""}`));
    const out = transformCollection({ legacy, tiers, newCollectionId, newTierIds, communityId });

    await target.begin(async (tx) => {
      await tx`select set_config('kolekto.import_run_id', ${runId}, true)`;
      await tx`set local role kolekto_importer`;

      // migration history (always, even for the excluded rejected campaign)
      const collectionFields: Record<string, unknown> = {
        title: legacy.title, description: legacy.description ?? null, slug: legacy.slug,
        status: legacy.status, collection_type: legacy.collection_type, type: legacy.type,
        amount: legacy.amount, target_amount: legacy.target_amount ?? null,
        min_contribution: legacy.min_contribution ?? null,
        fee_bearer: legacy.fee_bearer, currency: legacy.currency,
        deadline: legacy.deadline ?? null, event_date: legacy.event_date ?? null,
        rejection_reason: legacy.rejection_reason ?? null,
        banner_url: legacy.banner_url ?? null, story: legacy.story ?? null,
        price_tiers: legacy.price_tiers ?? null,
      };
      await tx`insert into migration.legacy_collection
               (source_table, source_id, fields, import_run_id)
               values ('collections', ${legacy.id}, ${tx.json(collectionFields)}, ${runId})
               on conflict (source_table, source_id) do nothing`;
      counts.legacy_collection_rows++;

      if (out.kind === "excluded") { counts.collections_excluded_rejected++; return; }

      await tx`insert into public.collections
               (id, community_id, created_by, slug, name, category, amount_model,
                participation_mode, audience_mode, status,
                fixed_amount_kobo, target_amount_kobo, min_amount_kobo,
                deadline_at, event_starts_at, fee_mode, cover_image_url,
                archived_at, published_at, published_by,
                is_imported, source_system, source_table, source_id, imported_at, import_run_id)
               values (${out.row.id}, ${out.row.community_id}, ${out.row.created_by},
                 app.generate_unique_collection_slug(${out.row.community_id}, ${out.row.slug}),
                 ${out.row.name}, ${out.row.category}, ${out.row.amount_model},
                 ${out.row.participation_mode}, ${out.row.audience_mode}, ${out.row.status},
                 ${out.row.fixed_amount_kobo}, ${out.row.target_amount_kobo}, ${out.row.min_amount_kobo},
                 ${out.row.deadline_at ?? null}, ${out.row.event_starts_at ?? null}, ${out.row.fee_mode}, ${null},
                 ${out.row.archived_at}, ${out.row.published_at}, ${out.row.published_by},
                 true, 'kolekto-v1', 'collections', ${out.row.source_id}, ${new Date()}, ${runId})
               on conflict (id) do nothing`;
      counts.collections_imported++;
      legacyToNewCollection.set(legacy.id, newCollectionId);

      for (const t of out.tiers) {
        await tx`insert into public.collection_tiers
                 (id, collection_id, community_id, name, price_kobo, code_prefix, description, quantity_limit, sort_order)
                 values (${t.id}, ${t.collection_id}, ${communityId}, ${t.name}, ${t.price_kobo},
                         ${t.code_prefix}, ${t.description}, ${t.quantity_limit}, ${t.sort_order})
                 on conflict (id) do nothing`;
        counts.tiers_imported++;
        if (t.code_prefix) {
          tierPrefixLookup.push({ new_collection_id: t.collection_id, new_tier_id: t.id, normalised_prefix: t.code_prefix });
        }
        await tx`insert into migration.imported_objects
                 (source_project, import_run_id, source_table, source_id, target_table, target_id)
                 values (${source_project}, ${runId}, 'public.legacy_tier',
                   ${`${legacy.id}|tier${t.sort_order}|${t.source_tier_id ?? ""}`}, 'public.collection_tiers', ${t.id})
                 on conflict (source_project, source_table, source_id, target_table) do nothing`;
      }

      await tx`insert into migration.imported_objects
               (source_project, import_run_id, source_table, source_id, target_table, target_id)
               values (${source_project}, ${runId}, 'public.collections', ${legacy.id}, 'public.collections', ${out.row.id})
               on conflict (source_project, source_table, source_id, target_table) do nothing`;
    });
  }

  // 4. Contributions + contributor codes.
  for (const legacy of collections) {
    const contributions = await source.listContributionsForCollection(legacy.id);
    for (const c of contributions) {
      const rowId = targetUuidFor(source_project, "legacy_contribution", c.id);
      await target.begin(async (tx) => {
        await tx`select set_config('kolekto.import_run_id', ${runId}, true)`;
        await tx`set local role kolekto_importer`;
        await tx`insert into migration.legacy_contribution
                 (id, source_table, source_id, fields, import_run_id)
                 values (${rowId}, 'contributions', ${c.id}, ${tx.json({
                   collection_id: c.collection_id, name: c.name ?? null,
                   email: c.email ?? null, phone: c.phone ?? null,
                   amount: c.amount, gross_amount: c.gross_amount ?? null,
                   contributor_information: c.contributor_information ?? null,
                   contributor_unique_code: c.contributor_unique_code,
                   payment_reference: c.payment_reference, status: c.status,
                   created_at: c.created_at, updated_at: c.updated_at,
                   payment_id: c.payment_id ?? null,
                   check_in_status: c.check_in_status ?? null,
                   line_index: c.line_index ?? null,
                 } as Record<string, unknown>)}, ${runId})
                 on conflict (source_table, source_id) do nothing`;
        counts.legacy_contribution_rows++;

        if (c.contributor_unique_code && c.contributor_unique_code.trim() !== "") {
          const link = buildContributorCodeLink({
            source_contribution_id: c.id, legacy_contribution_row_id: rowId,
            legacy_collection_id: legacy.id, new_collection_id: legacyToNewCollection.get(legacy.id) ?? null,
            contributor_unique_code: c.contributor_unique_code,
          });
          if (link) {
            await tx`insert into public.legacy_links
                     (kind, old_path, new_path, collection_id, notes)
                     values (${link.kind}, ${link.old_path}, ${link.new_path}, ${link.collection_id}, ${link.notes})
                     on conflict (old_path) do nothing`;
            counts.contributor_code_links++;
          }
        }
      });
    }
  }

  // 5. Attributed deposits → migration.legacy_deposit.
  const attributedDeposits = await source.listAttributedDeposits();
  counts.attributed_deposits_seen = attributedDeposits.length;
  for (const d of attributedDeposits) {
    const rowId = targetUuidFor(source_project, "legacy_deposit", d.id);
    await target.begin(async (tx) => {
      await tx`select set_config('kolekto.import_run_id', ${runId}, true)`;
      await tx`set local role kolekto_importer`;
      await tx`insert into migration.legacy_deposit
               (id, source_table, source_id, fields, import_run_id)
               values (${rowId}, 'deposits', ${d.id}, ${tx.json(depositFields(d))}, ${runId})
               on conflict (source_table, source_id) do nothing`;
      counts.attributed_deposits_imported++;
    });
  }

  // 6. Unattributed deposits → migration.unattributed_payments.
  const unattributedDeposits = await source.listUnattributedDeposits();
  counts.unattributed_deposits_seen = unattributedDeposits.length;
  for (const d of unattributedDeposits) {
    const rowId = targetUuidFor(source_project, "unattributed_payment", d.id);
    await target.begin(async (tx) => {
      await tx`select set_config('kolekto.import_run_id', ${runId}, true)`;
      await tx`set local role kolekto_importer`;
      await tx`insert into migration.unattributed_payments
               (id, source_table, source_id, payment_reference, amount_kobo, net_amount_kobo,
                original_created_at, original_paid_at, original_status, raw_payload, import_run_id)
               values (${rowId}, 'deposits', ${d.id}, ${d.payment_reference},
                 ${nairaToKobo(d.amount)}, ${nairaToKobo(d.net_amount)},
                 ${d.created_at}, ${d.paid_at ?? null}, ${d.status},
                 ${tx.json(depositFields(d))}, ${runId})
               on conflict (source_table, source_id) do nothing`;
      counts.unattributed_deposits_imported++;
    });
  }

  // 7. Withdrawals → migration.legacy_withdrawal.
  const withdrawals = await source.listWithdrawals();
  counts.withdrawals_seen = withdrawals.length;
  for (const w of withdrawals) {
    const rowId = targetUuidFor(source_project, "legacy_withdrawal", w.id);
    const mappedCollectionId = legacyToNewCollection.get(w.collection_id) ?? null;
    await target.begin(async (tx) => {
      await tx`select set_config('kolekto.import_run_id', ${runId}, true)`;
      await tx`set local role kolekto_importer`;
      await tx`insert into migration.legacy_withdrawal
               (id, source_project, source_id, import_run_id,
                amount_kobo, original_status, original_created_at, original_updated_at,
                collection_id, legacy_collection_id, legacy_user_id, legacy_wallet_id,
                provider_transfer_code, provider_recipient_code, fields)
               values (${rowId}, ${source_project}, ${w.id}, ${runId},
                 ${nairaToKobo(w.amount)}, ${w.status}, ${w.created_at}, ${w.updated_at},
                 ${mappedCollectionId}, ${w.collection_id}, ${w.user_id}, ${w.wallet_id},
                 ${w.paystack_transfer_code ?? null}, ${w.paystack_recipient_code ?? null},
                 ${tx.json(withdrawalFields(w))})
               on conflict (source_project, source_table, source_id) do nothing`;
      await tx`insert into migration.imported_objects
               (source_project, import_run_id, source_table, source_id, target_table, target_id)
               values (${source_project}, ${runId}, 'public.withdrawals', ${w.id}, 'migration.legacy_withdrawal', ${rowId})
               on conflict (source_project, source_table, source_id, target_table) do nothing`;
      counts.withdrawals_imported++;
    });
  }

  // 8. Legacy overflow → migration.legacy_overflow.
  const overflowTables: {
    sourceTable: string;
    keyColumns: string[];
    rows: readonly object[];
    idField: string;
  }[] = [
    { sourceTable: "public.wallets", keyColumns: ["id"], idField: "id",
      rows: await source.listWallets() },
    { sourceTable: "public.payment_recovery_log", keyColumns: ["id"], idField: "id",
      rows: await source.listPaymentRecoveryLogs() },
    { sourceTable: "public.pending_payment_context", keyColumns: ["reference"], idField: "reference",
      rows: await source.listPendingPaymentContexts() },
    { sourceTable: "public.payment_admin_actions", keyColumns: ["id"], idField: "id",
      rows: await source.listPaymentAdminActions() },
    { sourceTable: "public.settlement_runs", keyColumns: ["id"], idField: "id",
      rows: await source.listSettlementRuns() },
    { sourceTable: "public.admin_events", keyColumns: ["id"], idField: "id",
      rows: await source.listAdminEvents() },
    { sourceTable: "public.campuses", keyColumns: ["campus_id"], idField: "campus_id",
      rows: await source.listCampuses() },
  ];
  for (const { sourceTable, keyColumns, rows: overflowRows, idField } of overflowTables) {
    for (const row of overflowRows) {
      const rec = row as Record<string, unknown>;
      const sourceId = String(rec[idField]);
      const rowId = targetUuidFor(source_project, `legacy_overflow:${sourceTable}`, sourceId);
      await target.begin(async (tx) => {
        await tx`select set_config('kolekto.import_run_id', ${runId}, true)`;
        await tx`set local role kolekto_importer`;
        await tx`insert into migration.legacy_overflow
                 (id, source_project, source_table, source_id, source_key_columns, import_run_id, fields)
                 values (${rowId}, ${source_project}, ${sourceTable}, ${sourceId},
                   ${keyColumns}, ${runId}, ${tx.json(rec)})
                 on conflict (source_project, source_table, source_id) do nothing`;
        await tx`insert into migration.imported_objects
                 (source_project, import_run_id, source_table, source_id, target_table, target_id)
                 values (${source_project}, ${runId}, ${sourceTable}, ${sourceId},
                   'migration.legacy_overflow', ${rowId})
                 on conflict (source_project, source_table, source_id, target_table) do nothing`;
        counts.overflow_imported++;
      });
    }
  }

  // 9. Code sequences (unchanged — contributor code counters).
  const counters = await source.listContributionCodeCounters();
  const res = resolveCodeSequences(counters, tierPrefixLookup, legacyToNewCollection);
  for (const r of res.rows) {
    await target.begin(async (tx) => {
      await tx`select set_config('kolekto.import_run_id', ${runId}, true)`;
      await tx`set local role kolekto_importer`;
      await tx`insert into public.collection_code_sequences (collection_id, tier_id, next_number)
               values (${r.collection_id}, ${r.tier_id}, ${r.next_number})
               on conflict (collection_id, tier_id) do nothing`;
      counts.code_sequences_seeded++;
    });
  }
  counts.code_sequences_orphaned = res.orphaned.length;

  // 10. Close the run.
  await target`update migration.import_runs set status = 'completed', completed_at = now() where id = ${runId}`;
  return { runId, counts };
}
