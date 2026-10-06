/**
 * The synthetic fixtures. Covers all 30 cases the brief specified.
 * Ids follow the pattern `SXNNNNNN-…` so an id tells you which fixture it
 * belongs to on inspection. Pure data — no I/O.
 */

import type {
  LegacyProfile, LegacyCollection, LegacyTierEntry,
} from "../src/transformers/index.ts";
import type {
  LegacyContribution, LegacyDeposit, LegacyWithdrawal,
  LegacyWallet, LegacyPaymentRecoveryLog, LegacyPendingPaymentContext,
  LegacyPaymentAdminAction, LegacySettlementRun, LegacyAdminEvent, LegacyCampus,
} from "../src/orchestrator.ts";

export type SyntheticContribution = LegacyContribution;

export interface SyntheticCounter {
  readonly collection_id: string;
  readonly prefix: string;
  readonly next_number: number;
}

export interface SyntheticFixtures {
  readonly profiles: readonly LegacyProfile[];
  readonly collections: readonly LegacyCollection[];
  readonly tiers: ReadonlyMap<string, readonly LegacyTierEntry[]>;
  readonly contributions: ReadonlyMap<string, readonly SyntheticContribution[]>;
  readonly counters: readonly SyntheticCounter[];
  readonly attributedDeposits: readonly LegacyDeposit[];
  readonly unattributedDeposits: readonly LegacyDeposit[];
  readonly withdrawals: readonly LegacyWithdrawal[];
  readonly overflowWallets: readonly LegacyWallet[];
  readonly overflowPaymentRecoveryLogs: readonly LegacyPaymentRecoveryLog[];
  readonly overflowPendingPaymentContexts: readonly LegacyPendingPaymentContext[];
  readonly overflowPaymentAdminActions: readonly LegacyPaymentAdminAction[];
  readonly overflowSettlementRuns: readonly LegacySettlementRun[];
  readonly overflowAdminEvents: readonly LegacyAdminEvent[];
  readonly overflowCampuses: readonly LegacyCampus[];
  /** Case metadata for the report */
  readonly cases: readonly SyntheticCase[];
}

export interface SyntheticCase {
  readonly n: number;
  readonly name: string;
  readonly collection_id?: string;
  readonly user_id?: string;
}

const DATE = (s: string): Date => new Date(s);

// ── users ────────────────────────────────────────────────────────────────────
const U1 = "51000001-0000-4000-8000-000000000001";     // 1. normal organizer
const U2 = "51000002-0000-4000-8000-000000000002";     // 2. no-phone user
const U3 = "51000003-0000-4000-8000-000000000003";     // 3. second organizer
const U4 = "51000004-0000-4000-8000-000000000004";     // 4. long-name organizer
const U5 = "51000005-0000-4000-8000-000000000005";     // dup phone group A (first by id)
const U6 = "51000006-0000-4000-8000-000000000006";     // dup phone group A (second)
const U7 = "51000007-0000-4000-8000-000000000007";     // dup phone group B (first by id)
const U8 = "51000008-0000-4000-8000-000000000008";     // dup phone group B (second)
const U9 = "51000009-0000-4000-8000-000000000009";     // dup phone group B (third)

const profiles: LegacyProfile[] = [
  { id: U1, full_name: "Ada One",   email: "ada.one@synth.test", phone_number: "+2348010000001",
    avatar_url: "https://busfgcmbndleljklrcbd.supabase.co/x.png", first_name: null, last_name: null,
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: DATE("2026-01-01"), updated_at: DATE("2026-01-02") },
  { id: U2, full_name: "No Phone",  email: "no.phone@synth.test", phone_number: null,
    avatar_url: null, first_name: null, last_name: null,
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: DATE("2026-01-01"), updated_at: DATE("2026-01-02") },
  { id: U3, full_name: "Ngozi Two", email: "ngozi.two@synth.test", phone_number: "+2348010000003",
    avatar_url: null, first_name: "Ngozi", last_name: "Two",
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: DATE("2026-01-01"), updated_at: DATE("2026-01-02") },
  { id: U4, full_name: "X".repeat(200), email: "long@synth.test", phone_number: "+2348010000004",
    avatar_url: null, first_name: null, last_name: null,
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: DATE("2026-01-01"), updated_at: DATE("2026-01-02") },
  { id: U5, full_name: "Dup Phone A1", email: "dup.a1@synth.test", phone_number: "+2348010000055",
    avatar_url: null, first_name: null, last_name: null,
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: DATE("2026-01-01"), updated_at: DATE("2026-01-02") },
  { id: U6, full_name: "Dup Phone A2", email: "dup.a2@synth.test", phone_number: "+2348010000055",
    avatar_url: null, first_name: null, last_name: null,
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: DATE("2026-01-01"), updated_at: DATE("2026-01-02") },
  { id: U7, full_name: "Dup Phone B1", email: "dup.b1@synth.test", phone_number: "+2348010000077",
    avatar_url: null, first_name: null, last_name: null,
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: DATE("2026-01-01"), updated_at: DATE("2026-01-02") },
  { id: U8, full_name: "Dup Phone B2", email: "dup.b2@synth.test", phone_number: "+2348010000077",
    avatar_url: null, first_name: null, last_name: null,
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: DATE("2026-01-01"), updated_at: DATE("2026-01-02") },
  { id: U9, full_name: "Dup Phone B3", email: "dup.b3@synth.test", phone_number: "+2348010000077",
    avatar_url: null, first_name: null, last_name: null,
    address: null, date_of_birth: null, signup_ip: null, role: "user",
    created_at: DATE("2026-01-01"), updated_at: DATE("2026-01-02") },
];

// ── collections ──────────────────────────────────────────────────────────────
const C_FIXED       = "52000005-0000-4000-8000-000000000005";  // 5. fixed collection
const C_FLAT        = "52000006-0000-4000-8000-000000000006";  // 6. flat (legacy type variant)
const C_TIERED      = "52000007-0000-4000-8000-000000000007";  // 7. tiered
const C_TICKET      = "52000008-0000-4000-8000-000000000008";  // 8. ticket
const C_FUND        = "52000009-0000-4000-8000-000000000009";  // 9. fundraising
const C_OPEN_POOL   = "52000010-0000-4000-8000-000000000010";  // 10. open_pool
const C_DELETED     = "52000011-0000-4000-8000-000000000011";  // 11. deleted
const C_REJECTED    = "2b4fe58a-d1b2-4081-8f59-90287b96eba0";  // 12. rejected campaign — uses the real D3 uuid
const C_DUP_NAMES   = "52000013-0000-4000-8000-000000000013";  // 13. duplicate tier names
const C_DUP_PREFIX  = "52000014-0000-4000-8000-000000000014";  // 14. duplicate prefixes
const C_INV_PREFIX  = "52000015-0000-4000-8000-000000000015";  // 15. invalid prefix format
const C_QTY_ZERO    = "52000016-0000-4000-8000-000000000016";  // 16. tier quantity = 0
const C_FREE_FIXED  = "52000017-0000-4000-8000-000000000017";  // 17. zero-price fixed
const C_EMPTY_TICK  = "52000018-0000-4000-8000-000000000018";  // 18. ticket with zero tiers
const C_NO_TIER_ID  = "52000019-0000-4000-8000-000000000019";  // 19. tiers with missing legacy ids
const C_WITH_CODES  = "52000020-0000-4000-8000-000000000020";  // 20+21. codes and counter

const mkc = (id: string, user_id: string, over: Partial<LegacyCollection>): LegacyCollection => ({
  id, user_id, title: "Synthetic", description: null, slug: `synth-${id.slice(0, 8)}`,
  status: "active", collection_type: "fixed", type: "fixed",
  amount: "1000.00", target_amount: null, min_contribution: null,
  fee_bearer: "contributor", currency: "NGN",
  deadline: null, event_date: null, rejection_reason: null,
  banner_url: null, story: null, price_tiers: [],
  created_at: DATE("2026-06-01"), updated_at: DATE("2026-06-02"),
  ...over,
});

const collections: LegacyCollection[] = [
  mkc(C_FIXED,       U1, { title: "Fixed Contribution" }),
  mkc(C_FLAT,        U1, { title: "Flat Legacy Type", type: "flat" }),
  mkc(C_TIERED,      U1, { title: "Tiered Contribution", collection_type: "tiered", type: "tiered" }),
  mkc(C_TICKET,      U1, { title: "Ticket Event", collection_type: "ticket", type: "ticket" }),
  mkc(C_FUND,        U3, { title: "Fundraising Cause", collection_type: "fundraising", type: "fundraising",
                            amount: "0", target_amount: "1000000.00" }),
  mkc(C_OPEN_POOL,   U3, { title: "Open Pool", collection_type: "open_pool", type: "open_pool", amount: "0" }),
  mkc(C_DELETED,     U1, { title: "Deleted Collection", status: "deleted",
                            created_at: DATE("2026-01-01"), updated_at: DATE("2026-06-29") }),
  mkc(C_REJECTED,    U3, { title: "Help Nofisat", status: "rejected", collection_type: "fundraising",
                            type: "fundraising", amount: "0", rejection_reason: "This campaign is not valid",
                            created_at: DATE("2026-06-25T21:11:26Z"), updated_at: DATE("2026-06-25T21:19:16Z") }),
  // price_tiers mirrors the jsonb snapshot legacy Postgres keeps on the row
  // itself. Tests 13 and 16 read it back out of migration.legacy_collection.fields
  // as the history record of the ORIGINAL tier data (before renaming/prefix
  // resolution). Must match the corresponding tiers Map entry by name/qty.
  mkc(C_DUP_NAMES,   U1, { title: "Duplicate Tier Names Collection", collection_type: "tiered", type: "tiered",
                            price_tiers: [
                              { name: "Cyber Security", price: "30000", prefix: "HCYB", description: "Part payment", quantity: null },
                              { name: "Cyber Security", price: "50000", prefix: "FCYB", description: "Full payment", quantity: null },
                              { name: "Data Analysis",  price: "40000", prefix: "HDAT", description: "Part payment", quantity: null },
                              { name: "Data Analysis",  price: "60000", prefix: "FDAT", description: "Full payment", quantity: null },
                            ] }),
  mkc(C_DUP_PREFIX,  U3, { title: "Dinner Tickets", collection_type: "ticket", type: "ticket" }),
  mkc(C_INV_PREFIX,  U1, { title: "SIWES Payment", collection_type: "tiered", type: "tiered" }),
  mkc(C_QTY_ZERO,    U3, { title: "Kwara Career Expo", collection_type: "ticket", type: "ticket",
                            event_date: DATE("2026-11-21"),
                            price_tiers: [
                              { name: "Early Bird", price: "3000", prefix: "EKCE", description: null, quantity: null },
                              { name: "Late Bird",  price: "5000", prefix: "LKCE", description: null, quantity: 0    },
                            ] }),
  mkc(C_FREE_FIXED,  U1, { title: "Free Fixed", amount: "0.00" }),
  mkc(C_EMPTY_TICK,  U3, { title: "Ticket No Tiers", collection_type: "ticket", type: "ticket" }),
  mkc(C_NO_TIER_ID,  U1, { title: "Tiers Without Ids", collection_type: "tiered", type: "tiered" }),
  mkc(C_WITH_CODES,  U3, { title: "Uses Contributor Codes", collection_type: "tiered", type: "tiered" }),
];

// ── tiers ────────────────────────────────────────────────────────────────────
const tiers = new Map<string, readonly LegacyTierEntry[]>();
tiers.set(C_TIERED,     [
  { ord: 1, id: "t1", name: "Basic",   price: "1000", prefix: "BS", description: "basic",   quantity: null,  remaining_quantity: null, sold_quantity: 0 },
  { ord: 2, id: "t2", name: "Premium", price: "3000", prefix: "PR", description: "premium", quantity: 100,   remaining_quantity: 95,   sold_quantity: 5 },
]);
tiers.set(C_TICKET,     [
  { ord: 1, id: "t3", name: "Standard", price: "500",  prefix: "ST", description: null, quantity: 200, remaining_quantity: 200, sold_quantity: 0 },
]);
tiers.set(C_DUP_NAMES,  [
  { ord: 1, id: "t4",  name: "Cyber Security", price: "30000", prefix: "HCYB", description: "Part payment", quantity: null, remaining_quantity: null, sold_quantity: 0 },
  { ord: 2, id: "t5",  name: "Cyber Security", price: "50000", prefix: "FCYB", description: "Full payment", quantity: null, remaining_quantity: null, sold_quantity: 0 },
  { ord: 3, id: "t4b", name: "Data Analysis",  price: "40000", prefix: "HDAT", description: "Part payment", quantity: null, remaining_quantity: null, sold_quantity: 0 },
  { ord: 4, id: "t5b", name: "Data Analysis",  price: "60000", prefix: "FDAT", description: "Full payment", quantity: null, remaining_quantity: null, sold_quantity: 0 },
]);
tiers.set(C_DUP_PREFIX, [
  { ord: 1, id: "t6", name: "Table for 5",  price: "30000", prefix: "TAB2026", description: "5 seats",  quantity: null, remaining_quantity: null, sold_quantity: 0 },
  { ord: 2, id: "t7", name: "Table for 10", price: "50000", prefix: "TAB2026", description: "10 seats", quantity: null, remaining_quantity: null, sold_quantity: 0 },
]);
tiers.set(C_INV_PREFIX, [
  { ord: 1, id: "t8", name: "Frontend",     price: "30000", prefix: "FRONT-EN", description: null, quantity: null, remaining_quantity: null, sold_quantity: 0 },
  { ord: 2, id: "t9", name: "UI/UX Design", price: "30000", prefix: "UI/UX",    description: null, quantity: null, remaining_quantity: null, sold_quantity: 0 },
]);
tiers.set(C_QTY_ZERO,   [
  { ord: 1, id: "t10", name: "Early Bird", price: "3000", prefix: "EKCE", description: null, quantity: undefined, remaining_quantity: undefined, sold_quantity: 1 },
  { ord: 2, id: "t11", name: "Late Bird",  price: "5000", prefix: "LKCE", description: null, quantity: 0,         remaining_quantity: 0,         sold_quantity: 0 },
]);
tiers.set(C_NO_TIER_ID, [
  { ord: 1, id: null, name: "No Id A", price: "1000", prefix: "NA", description: null, quantity: null, remaining_quantity: null, sold_quantity: 0 },
  { ord: 2, id: null, name: "No Id B", price: "2000", prefix: "NB", description: null, quantity: null, remaining_quantity: null, sold_quantity: 0 },
]);
tiers.set(C_WITH_CODES, [
  { ord: 1, id: "t12", name: "Codes Tier", price: "1000", prefix: "PHS", description: null, quantity: null, remaining_quantity: null, sold_quantity: 5 },
]);
// C_EMPTY_TICK has no tiers on purpose

// ── contributions ────────────────────────────────────────────────────────────
const contributions = new Map<string, readonly SyntheticContribution[]>();
// Contribution ids are UUIDs — migration.legacy_contribution.source_id is a
// uuid column by contract, matching what legacy Postgres actually stores.
// Prefix `59...` groups them visually in the same way collection ids use `52...`.
//
// Every contribution now carries the full 16-column legacy shape. In real D2
// data, gross_amount differs from amount (includes fees), and
// contributor_information holds a rich jsonb receipt snapshot.
const mkContrib = (
  over: Pick<SyntheticContribution, "collection_id" | "id" | "contributor_unique_code" | "payment_reference" | "amount" | "status" | "created_at">
    & Partial<SyntheticContribution>,
): SyntheticContribution => ({
  name: null, email: null, phone: null, gross_amount: null,
  contributor_information: null, updated_at: over.created_at,
  payment_id: null, check_in_status: null, line_index: null,
  ...over,
});
contributions.set(C_WITH_CODES, [
  mkContrib({
    collection_id: C_WITH_CODES, id: "59000020-0000-4000-8000-000000000001",
    contributor_unique_code: "PHS-1", payment_reference: "ref-1",
    amount: "1000", gross_amount: "1020",
    status: "paid", created_at: DATE("2026-07-01"), updated_at: DATE("2026-07-01T12:00:00Z"),
    name: "Synth Payer One", email: "payer1@synth.test", phone: "+2348099000001",
    payment_id: "pay_synth_001", check_in_status: "not_checked_in", line_index: 0,
    contributor_information: [{ Tier: "Codes Tier", Quantity: 1, TierAmount: 1000,
      _receipt: { name: "Synth Payer One", _payer: { name: "Synth Payer One", email: "payer1@synth.test", phone: "+2348099000001" },
        paid_at: "2026-07-01T10:00:00.000Z", reference: "ref-1", tier_name: "Codes Tier",
        unique_code: "PHS-1", line_item_amount: 1000, order_total_paid: 1020,
        order_gateway_fee: 15, order_platform_fee: 5 } }],
  }),
  mkContrib({
    collection_id: C_WITH_CODES, id: "59000020-0000-4000-8000-000000000002",
    contributor_unique_code: "PHS-2", payment_reference: "ref-2",
    amount: "1000", gross_amount: "1020",
    status: "paid", created_at: DATE("2026-07-02"), updated_at: DATE("2026-07-02T14:00:00Z"),
    name: "Synth Payer Two", email: "payer2@synth.test", phone: null,
    payment_id: "pay_synth_002", check_in_status: "checked_in", line_index: 1,
    contributor_information: [{ Tier: "Codes Tier", Quantity: 1, TierAmount: 1000,
      _receipt: { name: "Synth Payer Two", reference: "ref-2", tier_name: "Codes Tier",
        unique_code: "PHS-2", line_item_amount: 1000, order_total_paid: 1020 } }],
  }),
  mkContrib({
    collection_id: C_WITH_CODES, id: "59000020-0000-4000-8000-000000000003",
    contributor_unique_code: null, payment_reference: null,
    amount: "1000", status: "pending", created_at: DATE("2026-07-03"),
  }),
]);
// A second collection reuses the code "PHS-1" — proving the namespacing works.
// This contribution has amount != gross_amount, exercising independent preservation.
contributions.set(C_TIERED, [
  mkContrib({
    collection_id: C_TIERED, id: "59000007-0000-4000-8000-000000000004",
    contributor_unique_code: "PHS-1", payment_reference: "ref-4",
    amount: "3000", gross_amount: "3060",
    status: "paid", created_at: DATE("2026-07-04"), updated_at: DATE("2026-07-04T09:30:00Z"),
    name: "Synth Payer Three", email: "payer3@synth.test", phone: "+2348099000003",
    payment_id: "pay_synth_004", check_in_status: "not_checked_in", line_index: 0,
    contributor_information: [{ Tier: "Premium", Quantity: 1, TierAmount: 3000,
      _receipt: { name: "Synth Payer Three", reference: "ref-4", tier_name: "Premium",
        unique_code: "PHS-1", line_item_amount: 3000, order_total_paid: 3060,
        order_gateway_fee: 45, order_platform_fee: 15 } }],
  }),
]);

// ── counters ─────────────────────────────────────────────────────────────────
const counters: SyntheticCounter[] = [
  { collection_id: C_WITH_CODES, prefix: "PHS",     next_number: 3 },
  { collection_id: C_DUP_PREFIX, prefix: "TAB2026", next_number: 7 }, // seeds the surviving shared prefix
];

// ── deposits ────────────────────────────────────────────────────────────────
// Deposit ids follow the `5D...` prefix to distinguish them visually.
// D2 has 23 columns per deposit; all must survive in the fields/raw_payload snapshot.
const mkDeposit = (
  over: Partial<LegacyDeposit> & Pick<LegacyDeposit, "id" | "full_name" | "email" | "amount" | "status" | "payment_reference" | "net_amount" | "created_at">,
): LegacyDeposit => ({
  phone_number: null, access_code: null, authorization_url: null,
  contributor_id: null, collection_id: null, updated_at: over.created_at,
  paid_at: null, channel: null, currency: "NGN", wallet_id: null,
  settled_at: null, settlement_status: null,
  init_email_sent: false, contributor_confirmed_sent: false, organizer_notified_sent: false,
  ...over,
});

const attributedDeposits: LegacyDeposit[] = [
  // 1. attributed success — full provider metadata
  mkDeposit({
    id: "5d000001-0000-4000-8000-000000000001",
    full_name: "Synth Depositor One", email: "dep1@synth.test", phone_number: "+2348099100001",
    amount: "5000.00", net_amount: "4925.00", status: "success",
    payment_reference: "ref_dep_001", access_code: "access_001",
    authorization_url: "https://checkout.paystack.test/access_001",
    contributor_id: U1, collection_id: C_TIERED, wallet_id: "5d0000w1-0000-4000-8000-000000000001",
    created_at: DATE("2026-07-10T10:00:00Z"), updated_at: DATE("2026-07-10T10:05:00Z"),
    paid_at: DATE("2026-07-10T10:02:00Z"), channel: "card", currency: "NGN",
    settled_at: DATE("2026-07-11T00:00:00Z"), settlement_status: "settled",
    init_email_sent: true, contributor_confirmed_sent: true, organizer_notified_sent: true,
  }),
  // 2. attributed pending — minimal fields
  mkDeposit({
    id: "5d000001-0000-4000-8000-000000000002",
    full_name: "Synth Depositor Two", email: "dep2@synth.test",
    amount: "3120.00", net_amount: "0.00", status: "pending",
    payment_reference: "ref_dep_002", access_code: "access_002",
    authorization_url: "https://checkout.paystack.test/access_002",
    contributor_id: U3, collection_id: C_FIXED,
    created_at: DATE("2026-07-12T14:00:00Z"),
    settlement_status: "unsettled",
  }),
  // 3. attributed abandoned — both exist in D2
  mkDeposit({
    id: "5d000001-0000-4000-8000-000000000003",
    full_name: "Synth Depositor Abandon", email: "dep3@synth.test",
    amount: "8150.00", net_amount: "0.00", status: "abandoned",
    payment_reference: "ref_dep_003",
    contributor_id: U1, collection_id: C_TIERED,
    created_at: DATE("2026-07-13T09:00:00Z"),
  }),
];

const unattributedDeposits: LegacyDeposit[] = [
  // 4. unattributed success — represents the ₦19.8M historical exception population
  mkDeposit({
    id: "5d000002-0000-4000-8000-000000000001",
    full_name: "Unknown Payer A", email: "unknown_a@synth.test",
    amount: "15000.00", net_amount: "14775.00", status: "success",
    payment_reference: "ref_unattr_001",
    created_at: DATE("2026-06-01T08:00:00Z"), updated_at: DATE("2026-06-01T08:05:00Z"),
    paid_at: DATE("2026-06-01T08:02:00Z"), channel: "bank_transfer",
    settled_at: DATE("2026-06-02T00:00:00Z"), settlement_status: "settled",
  }),
  // 5. unattributed pending
  mkDeposit({
    id: "5d000002-0000-4000-8000-000000000002",
    full_name: "Unknown Payer B", email: "unknown_b@synth.test", phone_number: "+2348099200002",
    amount: "7500.50", net_amount: "0.00", status: "pending",
    payment_reference: "ref_unattr_002",
    created_at: DATE("2026-06-15T11:30:00Z"),
  }),
];

// ── withdrawals ─────────────────────────────────────────────────────────────
// Withdrawal ids use the `5w...` prefix. D2 withdrawals have 11 columns, but
// destination_account (bank details) is intentionally excluded from the
// legacy_withdrawal.fields snapshot by a CHECK constraint.
const W_WALLET_1 = "5e000001-0000-4000-8000-000000000001";

const withdrawals: LegacyWithdrawal[] = [
  // 1. approved — full Paystack codes, destination_account present, on imported collection
  {
    id: "5b000001-0000-4000-8000-000000000001",
    user_id: U1, collection_id: C_TIERED, wallet_id: W_WALLET_1,
    amount: "25000.00", status: "approved",
    destination_account: { accountName: "Ada One", accountNumber: "0123456789", bank_code: "058", bankCode: "058", bank_name: "GTBank" },
    paystack_transfer_code: "TRF_synth001", paystack_recipient_code: "RCP_synth001",
    created_at: DATE("2026-08-01T10:00:00Z"), updated_at: DATE("2026-08-01T10:05:00Z"),
  },
  // 2. success — null Paystack codes, no destination_account, on imported collection
  {
    id: "5b000001-0000-4000-8000-000000000002",
    user_id: U3, collection_id: C_FIXED, wallet_id: W_WALLET_1,
    amount: "10500.50", status: "success",
    destination_account: null,
    paystack_transfer_code: null, paystack_recipient_code: null,
    created_at: DATE("2026-08-05T14:00:00Z"), updated_at: DATE("2026-08-05T14:30:00Z"),
  },
  // 3. rejected — on the excluded (rejected) collection, proving collection_id FK is null
  {
    id: "5b000001-0000-4000-8000-000000000003",
    user_id: U3, collection_id: C_REJECTED, wallet_id: W_WALLET_1,
    amount: "5000.00", status: "rejected",
    destination_account: { accountName: "Ngozi Two", accountNumber: "9876543210", bank_code: "033", bankCode: "033", bank_name: "UBA" },
    paystack_transfer_code: "TRF_synth003", paystack_recipient_code: "RCP_synth003",
    created_at: DATE("2026-08-10T09:00:00Z"), updated_at: DATE("2026-08-10T09:15:00Z"),
  },
];

// ── overflow (B4) ──────────────────────────────────────────────────────────
const overflowWallets: LegacyWallet[] = [
  {
    id: "5f000001-0000-4000-8000-000000000001",
    collection_id: C_FIXED,
    available_balance: "1500.50", ledger_balance: "1500.50",
    gross_payment: "2000.00", net_payment: "1970.00",
    withdrawn: "470.00", pending_balance: "0.00",
    fee_breakdown: { platform_fee: "30.00", gateway_fee: "0.00" },
    created_at: DATE("2026-07-01"), updated_at: DATE("2026-07-15"),
  },
];

const overflowPaymentRecoveryLogs: LegacyPaymentRecoveryLog[] = [
  {
    id: "5f000002-0000-4000-8000-000000000001",
    reference: "ref_dep_001", collection_id: C_TIERED,
    success: false, error_code: "amount_mismatch",
    error_message: "Expected 5000, got 4925", context: { verifiedTotal: "4925" },
    invocation_source: "scheduled_recovery", attempt_number: 1, duration_ms: 230,
    created_at: DATE("2026-07-11T12:00:00Z"),
  },
];

const overflowPendingPaymentContexts: LegacyPendingPaymentContext[] = [
  {
    reference: "KLK_REF_SYNTH_001",
    collection_id: C_FIXED,
    metadata: { contact: { name: "Synth PPC Payer", email: "ppc@synth.test" }, selectedTier: "Fixed" },
    created_at: DATE("2026-07-20T09:00:00Z"),
    paystack_transaction_id: "txn_synth_001", paystack_status: "success",
    captured_amount: "1000.00", currency: "NGN", channel: "card",
    paid_at: DATE("2026-07-20T09:02:00Z"), captured_at: DATE("2026-07-20T09:02:30Z"),
    verified_at: DATE("2026-07-20T09:03:00Z"),
    verification_payload: { status: true, amount: 100000 },
    contributor_email: "ppc@synth.test", organizer_id: U1,
    state: "completed", failure_code: null, failure_reason: null, failure_context: null,
    retry_count: 0, last_attempt_at: null, next_retry_at: null,
    reconciliation_state: null, resolved_at: null, resolved_by: null,
    updated_at: DATE("2026-07-20T09:03:00Z"),
  },
];

const overflowPaymentAdminActions: LegacyPaymentAdminAction[] = [
  {
    id: "5f000004-0000-4000-8000-000000000001",
    reference: "ref_dep_001", collection_id: C_TIERED,
    admin_user_id: U1, action: "force_reconcile",
    old_status: "needs_review", new_status: "completed",
    reason: "Manual verification confirmed payment", notes: "Synth test action",
    created_at: DATE("2026-07-12T10:00:00Z"),
  },
];

const overflowSettlementRuns: LegacySettlementRun[] = [
  {
    id: "5f000005-0000-4000-8000-000000000001",
    started_at: DATE("2026-07-15T00:00:00Z"), finished_at: DATE("2026-07-15T00:05:00Z"),
    cutoff_used: DATE("2026-07-14T23:59:59Z"),
    wallets_processed: 3, drift_after: 0,
    triggered_by: "cron", ok: true, overwithdrawn_after: 0,
  },
];

const overflowAdminEvents: LegacyAdminEvent[] = [
  {
    id: "5f000006-0000-4000-8000-000000000001",
    event_type: "collection_status_change", severity: "info",
    entity_type: "collection", entity_id: C_FIXED,
    actor_id: U1, metadata: { old_status: "draft", new_status: "active" },
    created_at: DATE("2026-06-01T10:00:00Z"),
  },
];

const overflowCampuses: LegacyCampus[] = [
  { campus_id: 99, campus_name: "Synthetic Campus", campus_code: "SYN" },
];

// ── case list, aligned to the brief's 30 cases ───────────────────────────────
const cases: SyntheticCase[] = [
  { n: 1, name: "normal organizer/user", user_id: U1 },
  { n: 2, name: "no-phone legacy user (F-M1)", user_id: U2 },
  { n: 3, name: "multiple organizers", user_id: U3 },
  { n: 4, name: "personal community creation (F-L1)", user_id: U1 },
  { n: 5, name: "fixed collection", collection_id: C_FIXED },
  { n: 6, name: "flat collection (legacy type)", collection_id: C_FLAT },
  { n: 7, name: "tiered collection", collection_id: C_TIERED },
  { n: 8, name: "ticket collection", collection_id: C_TICKET },
  { n: 9, name: "fundraising collection", collection_id: C_FUND },
  { n: 10, name: "open_pool collection", collection_id: C_OPEN_POOL },
  { n: 11, name: "deleted collection → archived (E-COL-1)", collection_id: C_DELETED },
  { n: 12, name: "rejected campaign excluded (E-COL-2)", collection_id: C_REJECTED },
  { n: 13, name: "duplicate tier names (F-L4)", collection_id: C_DUP_NAMES },
  { n: 14, name: "duplicate tier prefixes (D6)", collection_id: C_DUP_PREFIX },
  { n: 15, name: "invalid tier prefixes (D5)", collection_id: C_INV_PREFIX },
  { n: 16, name: "tier quantity = 0 (D7)", collection_id: C_QTY_ZERO },
  { n: 17, name: "zero-price fixed collection (D5)", collection_id: C_FREE_FIXED },
  { n: 18, name: "ticket collection with zero tiers (A03)", collection_id: C_EMPTY_TICK },
  { n: 19, name: "tiers with missing legacy ids", collection_id: C_NO_TIER_ID },
  { n: 20, name: "legacy contributor codes → legacy_links (A-1)", collection_id: C_WITH_CODES },
  { n: 21, name: "legacy code counter → seed next_number", collection_id: C_WITH_CODES },
  { n: 22, name: "collection fields preserved in legacy_collection.fields", collection_id: C_FIXED },
  { n: 23, name: "campaign row → legacy_overflow", collection_id: C_REJECTED },
  { n: 24, name: "wallet overflow (no-op here — no wallet row is imported)" },
  { n: 25, name: "withdrawal history (no-op — nothing here creates a withdrawal)" },
  { n: 26, name: "unattributed deposit history (no-op — no deposit rows generated)" },
  { n: 27, name: "provenance via imported_objects", collection_id: C_FIXED },
  { n: 28, name: "idempotent re-import — orchestrator can be re-run" },
  { n: 29, name: "immutable migration history — refuses UPDATE" },
  { n: 30, name: "auth import context — sign-up trigger stands aside" },
  { n: 31, name: "duplicate phone (2-way) — first by id keeps phone", user_id: U5 },
  { n: 32, name: "duplicate phone (2-way) — second gets null phone", user_id: U6 },
  { n: 33, name: "duplicate phone (3-way) — first by id keeps phone", user_id: U7 },
  { n: 34, name: "duplicate phone (3-way) — second gets null phone", user_id: U8 },
  { n: 35, name: "duplicate phone (3-way) — third gets null phone", user_id: U9 },
];

export const DUP_PHONE_IDS = {
  A1: U5, A2: U6,
  B1: U7, B2: U8, B3: U9,
  PHONE_A: "+2348010000055",
  PHONE_B: "+2348010000077",
} as const;

export const fixtures: SyntheticFixtures = {
  profiles, collections, tiers, contributions, counters,
  attributedDeposits, unattributedDeposits, withdrawals,
  overflowWallets, overflowPaymentRecoveryLogs, overflowPendingPaymentContexts,
  overflowPaymentAdminActions, overflowSettlementRuns, overflowAdminEvents, overflowCampuses,
  cases,
};

// Helpful control totals used by tests.
export const CONTROL = Object.freeze({
  profiles: profiles.length,
  collections: collections.length,
  collections_excluded_rejected: 1,
  collections_by_status: { active: 14, deleted: 1, rejected: 1 } as Record<string, number>,
  tier_entries: [...tiers.values()].reduce((a, t) => a + t.length, 0),
  tier_entries_with_legacy_id: [...tiers.values()].flat().filter((t) => t.id != null && t.id !== "").length,
  contributions: [...contributions.values()].reduce((a, c) => a + c.length, 0),
  contributions_with_code: [...contributions.values()].flat().filter((c) => c.contributor_unique_code && c.contributor_unique_code.trim() !== "").length,
  code_counters: counters.length,
  attributed_deposits: attributedDeposits.length,
  unattributed_deposits: unattributedDeposits.length,
  withdrawals: withdrawals.length,
  overflow_wallets: overflowWallets.length,
  overflow_payment_recovery_log: overflowPaymentRecoveryLogs.length,
  overflow_pending_payment_context: overflowPendingPaymentContexts.length,
  overflow_payment_admin_actions: overflowPaymentAdminActions.length,
  overflow_settlement_runs: overflowSettlementRuns.length,
  overflow_admin_events: overflowAdminEvents.length,
  overflow_campuses: overflowCampuses.length,
});
