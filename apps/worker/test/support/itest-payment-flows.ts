/**
 * itest-payment-flows.ts — fixtures for the seven collection flows (plan §3.1)
 * used by payments-orchestrator.integration.test.ts.
 *
 * Every function takes a transaction handle the caller owns (always inside
 * inRollback) and run-unique ids from the harness scope, so nothing here can
 * commit, connect or collide. Collections are inserted directly: these tests
 * are about paying, not about creating collections (same rule as
 * supabase/tests/52_payments.sql).
 *
 * Amounts are kobo. Each flow also returns the ResolvedContribution the web
 * action would have produced for that order, so the orchestrator receives
 * exactly what it receives in production.
 */

import { kobo, type FeeBearer, type ResolvedContribution } from "@kolekto/domain";

import type { ItestTx as Tx } from "./itest-db.ts";

export interface FlowIds {
  uuid(): string;
  slug(): string;
  address(): string;
}

export type FlowName = "fixed" | "open" | "tiered" | "items" | "ticketing" | "fundraiser" | "recurring";

export const FLOW_NAMES: readonly FlowName[] = ["fixed", "open", "tiered", "items", "ticketing", "fundraiser", "recurring"];

export interface PaymentCommunity {
  ownerId: string;
  communityId: string;
  communitySlug: string;
  memberIds: readonly [string, string];
}

export interface FlowFixture {
  name: FlowName;
  collectionId: string;
  collectionSlug: string;
  category: string;
  amountModel: "fixed" | "open_amount" | "tiers" | "items";
  feeBearer: FeeBearer;
  memberId: string | null;
  obligationId: string | null;
  resolved: ResolvedContribution;
  attendeeNames: string[];
  /** Limited tiers/items in this order, and how many units it takes of each. */
  limitedLines: { tierId?: string; itemId?: string; quantity: number }[];
}

export async function seedPaymentCommunity(tx: Tx, ids: FlowIds): Promise<PaymentCommunity> {
  const ownerId = ids.uuid();
  const communityId = ids.uuid();
  const communitySlug = ids.slug();
  const ownerEmail = ids.address();
  const memberA = ids.uuid();
  const memberB = ids.uuid();

  await tx`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
    (${ownerId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${ownerEmail}, now())`;
  await tx`insert into public.users (id, full_name, email) values (${ownerId}, 'Pay ITest Owner', ${ownerEmail})
    on conflict (id) do update set full_name = excluded.full_name`;
  await tx`insert into public.communities (id, slug, name, type, is_personal, created_by)
    values (${communityId}, ${communitySlug}, 'ITest Payments', 'social_group', false, ${ownerId})`;
  await tx`insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason)
    values (${communityId}, ${ownerId}, 'owner', 'Pay ITest Owner', 'created')`;
  await tx`insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
    (${memberA}, ${communityId}, 'Ada Payer', '+2348097771001', ${`IT/${memberA.slice(0, 8)}`}, 'active', 'manual'),
    (${memberB}, ${communityId}, 'Bola Payer', '+2348097771002', ${`IT/${memberB.slice(0, 8)}`}, 'active', 'manual')`;

  return { ownerId, communityId, communitySlug, memberIds: [memberA, memberB] };
}

interface CollectionRow {
  category: string;
  participation: "open" | "managed";
  audience: "public" | "all_members";
  amountModel: FlowFixture["amountModel"];
  fixed: bigint | null;
  min: bigint | null;
  target: bigint | null;
  feeMode: "contributor_pays" | "community_absorbs";
  attendees: boolean;
  closeOnTarget: boolean;
  schedule: "one_time" | "recurring";
}

async function insertCollection(tx: Tx, ids: FlowIds, c: PaymentCommunity, row: CollectionRow): Promise<{ id: string; slug: string }> {
  const id = ids.uuid();
  const slug = ids.slug();
  await tx`
    insert into public.collections
      (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
       min_amount_kobo, target_amount_kobo, status, visibility, fee_mode, collect_attendee_details,
       close_when_target_reached, schedule, created_by)
    values
      (${id}, ${c.communityId}, ${slug}, 'ITest Pay', ${row.category}::public.collection_category,
       ${row.participation}::public.participation_mode, ${row.audience}::public.collection_audience_mode,
       ${row.amountModel}::public.amount_model, ${row.fixed?.toString() ?? null}::bigint,
       ${row.min?.toString() ?? null}::bigint, ${row.target?.toString() ?? null}::bigint, 'active',
       ${row.audience === "public" ? "public" : "unlisted"}::public.collection_visibility,
       ${row.feeMode}::public.fee_mode, ${row.attendees}, ${row.closeOnTarget},
       ${row.schedule}::public.collection_schedule, ${c.ownerId})`;
  return { id, slug };
}

const bearerOf = (feeMode: CollectionRow["feeMode"]): FeeBearer => (feeMode === "contributor_pays" ? "contributor" : "community");

export async function seedFlow(tx: Tx, ids: FlowIds, c: PaymentCommunity, name: FlowName): Promise<FlowFixture> {
  const [memberA] = c.memberIds;
  const base = { name, attendeeNames: [] as string[], limitedLines: [] as FlowFixture["limitedLines"], memberId: null as string | null, obligationId: null as string | null };

  switch (name) {
    // Dues, managed, fixed ₦5,000, one obligation for member A. Host absorbs fees.
    case "fixed": {
      const row: CollectionRow = { category: "dues", participation: "managed", audience: "all_members", amountModel: "fixed", fixed: 500000n, min: null, target: null, feeMode: "community_absorbs", attendees: false, closeOnTarget: false, schedule: "one_time" };
      const col = await insertCollection(tx, ids, c, row);
      const obligationId = ids.uuid();
      await tx`insert into public.obligations (id, community_id, collection_id, member_id, expected_amount_kobo)
        values (${obligationId}, ${c.communityId}, ${col.id}, ${memberA}, 500000)`;
      return { ...base, collectionId: col.id, collectionSlug: col.slug, category: row.category, amountModel: row.amountModel, feeBearer: bearerOf(row.feeMode), memberId: memberA, obligationId, resolved: { amountKobo: kobo(500000n), tierId: null } };
    }
    // Contribution, open amount (min ₦100), contributor gives ₦2,500. Host absorbs.
    case "open": {
      const row: CollectionRow = { category: "contribution", participation: "open", audience: "public", amountModel: "open_amount", fixed: null, min: 10000n, target: null, feeMode: "community_absorbs", attendees: false, closeOnTarget: false, schedule: "one_time" };
      const col = await insertCollection(tx, ids, c, row);
      return { ...base, collectionId: col.id, collectionSlug: col.slug, category: row.category, amountModel: row.amountModel, feeBearer: bearerOf(row.feeMode), resolved: { amountKobo: kobo(250000n), tierId: null } };
    }
    // Contribution with tiers; one tier × 1 (₦3,000). Contributor pays fees.
    case "tiered": {
      const row: CollectionRow = { category: "contribution", participation: "open", audience: "public", amountModel: "tiers", fixed: null, min: null, target: null, feeMode: "contributor_pays", attendees: false, closeOnTarget: false, schedule: "one_time" };
      const col = await insertCollection(tx, ids, c, row);
      const tierId = ids.uuid();
      await tx`insert into public.collection_tiers (id, collection_id, community_id, name, price_kobo, quantity_limit, per_order_limit, hidden)
        values (${tierId}, ${col.id}, ${c.communityId}, 'Supporter', 300000, null, null, false)`;
      return { ...base, collectionId: col.id, collectionSlug: col.slug, category: row.category, amountModel: row.amountModel, feeBearer: bearerOf(row.feeMode), resolved: { amountKobo: kobo(300000n), tierId } };
    }
    // Items basket: 2 × ₦1,500 (limited stock of 10) + 1 × ₦800 (unlimited). Contributor pays.
    case "items": {
      const row: CollectionRow = { category: "items", participation: "open", audience: "public", amountModel: "items", fixed: null, min: null, target: null, feeMode: "contributor_pays", attendees: false, closeOnTarget: false, schedule: "one_time" };
      const col = await insertCollection(tx, ids, c, row);
      const capId = ids.uuid();
      const scarfId = ids.uuid();
      await tx`insert into public.collection_items (id, collection_id, community_id, name, price_kobo, quantity_available, max_per_order) values
        (${capId}, ${col.id}, ${c.communityId}, 'Cap', 150000, 10, 5),
        (${scarfId}, ${col.id}, ${c.communityId}, 'Scarf', 80000, null, null)`;
      return {
        ...base, collectionId: col.id, collectionSlug: col.slug, category: row.category, amountModel: row.amountModel, feeBearer: bearerOf(row.feeMode),
        resolved: {
          amountKobo: kobo(380000n), tierId: null,
          itemLines: [
            { itemId: capId, name: "Cap", quantity: 2, amountKobo: kobo(300000n) },
            { itemId: scarfId, name: "Scarf", quantity: 1, amountKobo: kobo(80000n) },
          ],
        },
        limitedLines: [{ itemId: capId, quantity: 2 }],
      };
    }
    // Event tickets: VIP × 1 (₦5,000, 5 left) + Regular × 2 (₦2,000), a name per ticket. Contributor pays.
    case "ticketing": {
      const row: CollectionRow = { category: "event", participation: "open", audience: "public", amountModel: "tiers", fixed: null, min: null, target: null, feeMode: "contributor_pays", attendees: true, closeOnTarget: false, schedule: "one_time" };
      const col = await insertCollection(tx, ids, c, row);
      const vipId = ids.uuid();
      const regularId = ids.uuid();
      await tx`insert into public.collection_tiers (id, collection_id, community_id, name, price_kobo, quantity_limit, per_order_limit, hidden) values
        (${vipId}, ${col.id}, ${c.communityId}, 'VIP', 500000, 5, 2, false),
        (${regularId}, ${col.id}, ${c.communityId}, 'Regular', 200000, null, null, false)`;
      return {
        ...base, collectionId: col.id, collectionSlug: col.slug, category: row.category, amountModel: row.amountModel, feeBearer: bearerOf(row.feeMode),
        resolved: {
          amountKobo: kobo(900000n), tierId: null,
          lines: [
            { tierId: vipId, name: "VIP", quantity: 1, amountKobo: kobo(500000n) },
            { tierId: regularId, name: "Regular", quantity: 2, amountKobo: kobo(400000n) },
          ],
        },
        attendeeNames: ["Ada Guest", "Bola Guest", "Chidi Guest"],
        limitedLines: [{ tierId: vipId, quantity: 1 }],
      };
    }
    // Fundraiser, target ₦10,000, closes on target; gives ₦4,000. Host absorbs.
    case "fundraiser": {
      const row: CollectionRow = { category: "fundraiser", participation: "open", audience: "public", amountModel: "open_amount", fixed: null, min: null, target: 1000000n, feeMode: "community_absorbs", attendees: false, closeOnTarget: true, schedule: "one_time" };
      const col = await insertCollection(tx, ids, c, row);
      return { ...base, collectionId: col.id, collectionSlug: col.slug, category: row.category, amountModel: row.amountModel, feeBearer: bearerOf(row.feeMode), resolved: { amountKobo: kobo(400000n), tierId: null } };
    }
    // Recurring monthly dues ₦2,000: an open cycle and member A's obligation for it. Host absorbs.
    case "recurring": {
      const row: CollectionRow = { category: "dues", participation: "managed", audience: "all_members", amountModel: "fixed", fixed: 200000n, min: null, target: null, feeMode: "community_absorbs", attendees: false, closeOnTarget: false, schedule: "recurring" };
      const col = await insertCollection(tx, ids, c, row);
      await tx`insert into public.collection_recurrences (collection_id, community_id, frequency, starts_on)
        values (${col.id}, ${c.communityId}, 'monthly', (now() at time zone 'Africa/Lagos')::date)`;
      await tx`insert into public.collection_cycles (collection_id, community_id, cycle_key, period_start, period_end)
        values (${col.id}, ${c.communityId}, 'itest-cycle', (now() at time zone 'Africa/Lagos')::date, (now() at time zone 'Africa/Lagos')::date + 30)`;
      const obligationId = ids.uuid();
      await tx`insert into public.obligations (id, community_id, collection_id, member_id, expected_amount_kobo, cycle_key)
        values (${obligationId}, ${c.communityId}, ${col.id}, ${memberA}, 200000, 'itest-cycle')`;
      return { ...base, collectionId: col.id, collectionSlug: col.slug, category: row.category, amountModel: row.amountModel, feeBearer: bearerOf(row.feeMode), memberId: memberA, obligationId, resolved: { amountKobo: kobo(200000n), tierId: null } };
    }
  }
}
