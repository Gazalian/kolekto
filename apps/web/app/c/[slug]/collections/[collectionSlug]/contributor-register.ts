/**
 * The contributor register as data: how a contribution row is shown, how an
 * organiser's answers are labelled, and which columns an export may have.
 *
 * Plain functions with no I/O, shared by the server actions (which build the
 * CSV) and the panel (which renders the list), so the screen and the file
 * cannot disagree. Separate from `contributor-actions.ts` because a
 * `"use server"` module may only export async functions.
 *
 * Money stays integer kobo end to end. Values cross to the browser as decimal
 * strings and are formatted only by `formatNaira`; nothing here adds, rounds
 * or converts an amount.
 */

import type { CollectionFinancialOverview, ContributionLine, ContributorRow } from "@kolekto/db";
import { formatNaira, kobo, type CsvColumn } from "@kolekto/domain";

export const CONTRIBUTOR_PAGE_SIZE = 50;

/** The parts of `collection_fields` the register needs. */
export interface ContributorFieldDef {
  key: string;
  label: string;
  type: string;
  sort_order: number;
}

/** What the browser receives for one contribution. Serializable: kobo is a string. */
export interface ContributorView {
  id: string;
  capturedAt: string;
  amountKobo: string;
  totalChargedKobo: string;
  reference: string;
  name: string;
  isMember: boolean;
  memberCode: string | null;
  email: string | null;
  phone: string | null;
  answers: Record<string, string>;
  attendeeNames: string[];
  lines: { kind: "tier" | "item"; name: string | null; quantity: number; amountKobo: string }[];
  cycleKey: string | null;
  personPayments: number;
  personTotalKobo: string;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
}

export function toContributorView(row: ContributorRow): ContributorView {
  return {
    id: row.contributionId,
    capturedAt: row.capturedAt,
    amountKobo: row.contributionKobo.toString(),
    totalChargedKobo: row.totalChargedKobo.toString(),
    reference: row.reference,
    name: row.name,
    isMember: row.isMember,
    memberCode: row.memberCode,
    email: row.email,
    phone: row.phone,
    answers: row.answers,
    attendeeNames: row.attendeeNames,
    lines: row.lines.map((line) => ({
      kind: line.kind,
      name: line.name,
      quantity: line.quantity,
      amountKobo: line.amountKobo.toString(),
    })),
    cycleKey: row.cycleKey,
    personPayments: row.contributorPaymentCount,
    personTotalKobo: row.contributorTotalKobo.toString(),
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedByName: row.acknowledgedByName,
  };
}

/** The overview as the browser receives it. Balances are null when the viewer may not see them. */
export interface OverviewView {
  totalRaisedKobo: string;
  feesDeductedKobo: string;
  netRaisedKobo: string;
  contributionCount: number;
  contributorCount: number;
  acknowledgedCount: number;
  underReviewCount: number;
  lastContributionAt: string | null;
  canViewBalances: boolean;
  pendingKobo: string | null;
  availableKobo: string | null;
  onHoldKobo: string | null;
  withdrawingKobo: string | null;
  withdrawnKobo: string | null;
}

const str = (value: bigint | null): string | null => (value === null ? null : value.toString());

export function toOverviewView(overview: CollectionFinancialOverview): OverviewView {
  return {
    totalRaisedKobo: overview.totalRaisedKobo.toString(),
    feesDeductedKobo: overview.feesDeductedKobo.toString(),
    netRaisedKobo: overview.netRaisedKobo.toString(),
    contributionCount: overview.contributionCount,
    contributorCount: overview.contributorCount,
    acknowledgedCount: overview.acknowledgedCount,
    underReviewCount: overview.underReviewCount,
    lastContributionAt: overview.lastContributionAt,
    canViewBalances: overview.canViewBalances,
    pendingKobo: str(overview.pendingKobo),
    availableKobo: str(overview.availableKobo),
    onHoldKobo: str(overview.onHoldKobo),
    withdrawingKobo: str(overview.withdrawingKobo),
    withdrawnKobo: str(overview.withdrawnKobo),
  };
}

/** "Regular seat × 2 · VIP" — what a payment bought, or "" for a plain amount. */
export function describeLines(lines: readonly Pick<ContributionLine, "name" | "quantity">[]): string {
  return lines
    .map((line) => {
      const name = line.name ?? "Option";
      return line.quantity > 1 ? `${name} × ${line.quantity}` : name;
    })
    .join(" · ");
}

export interface AnswerEntry {
  key: string;
  label: string;
  value: string;
  /** The question was removed from the collection after this payment was made. */
  removed: boolean;
}

/** "matric_no" → "Matric no". Only for an answer whose question no longer exists. */
function humanizeKey(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.length === 0 ? "Answer" : words[0]!.toUpperCase() + words.slice(1);
}

/**
 * The organiser's questions with this contributor's answers, in the
 * collection's own order and under its own labels. An answer whose question
 * was later removed is kept (it is what the contributor submitted) and
 * labelled as such, never shown as a raw key or as JSON.
 */
export function answerEntries(
  fields: readonly ContributorFieldDef[],
  answers: Readonly<Record<string, string>>,
  { includeEmpty = false }: { includeEmpty?: boolean } = {},
): AnswerEntry[] {
  const ordered = [...fields].sort((a, b) => a.sort_order - b.sort_order);
  const known = new Set(ordered.map((field) => field.key));
  const entries: AnswerEntry[] = [];
  for (const field of ordered) {
    const value = (answers[field.key] ?? "").trim();
    if (value === "" && !includeEmpty) continue;
    entries.push({ key: field.key, label: field.label, value, removed: false });
  }
  for (const [key, raw] of Object.entries(answers)) {
    if (known.has(key)) continue;
    const value = raw.trim();
    if (value === "") continue;
    entries.push({ key, label: humanizeKey(key), value, removed: true });
  }
  return entries;
}

/** Naira for a screen: "₦5,000" or "₦5,000.50". */
export function nairaText(value: string | bigint): string {
  const amount = kobo(value);
  return formatNaira(amount, { decimals: amount % 100n !== 0n });
}

// ── Export ──────────────────────────────────────────────────────────────────

export type ContributorExportGroup = "Basic" | "Contact" | "Questions" | "Management";

export const CONTRIBUTOR_EXPORT_GROUP_ORDER: readonly ContributorExportGroup[] = [
  "Basic",
  "Contact",
  "Questions",
  "Management",
];

export interface ContributorExportField {
  key: string;
  label: string;
  group: ContributorExportGroup;
  /** Personal contact data: off by default, needs member.view_contact. */
  sensitive?: boolean;
}

export interface ContributorExportContext {
  fields: readonly ContributorFieldDef[];
  /** Tiers or items: payments buy named options. */
  hasOptions: boolean;
  isEvent: boolean;
  isRecurring: boolean;
  isManaged: boolean;
}

/** Every column this collection can answer, generated from its own configuration. */
export function contributorExportFields(context: ContributorExportContext): ContributorExportField[] {
  const basic: ContributorExportField[] = [
    { key: "name", label: "Contributor name", group: "Basic" },
    { key: "amount", label: "Amount (NGN)", group: "Basic" },
    { key: "date", label: "Date paid", group: "Basic" },
  ];
  if (context.hasOptions) basic.push({ key: "options", label: "Option", group: "Basic" });
  if (context.isEvent) basic.push({ key: "attendees", label: "Attendee names", group: "Basic" });
  if (context.isRecurring) basic.push({ key: "period", label: "Period", group: "Basic" });
  if (context.isManaged) basic.push({ key: "member_code", label: "Member ID", group: "Basic" });
  basic.push({ key: "member", label: "Saved member", group: "Basic" });
  basic.push({ key: "total_paid", label: "Total paid incl. fees (NGN)", group: "Basic" });

  const contact: ContributorExportField[] = [
    { key: "email", label: "Email", group: "Contact", sensitive: true },
    { key: "phone", label: "Phone number", group: "Contact", sensitive: true },
  ];

  const questions: ContributorExportField[] = [...context.fields]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((field) => ({ key: `q:${field.key}`, label: field.label, group: "Questions" as const }));

  const management: ContributorExportField[] = [
    { key: "acknowledged", label: "Acknowledged", group: "Management" },
    { key: "acknowledged_at", label: "Acknowledged on", group: "Management" },
    { key: "acknowledged_by", label: "Acknowledged by", group: "Management" },
    { key: "reference", label: "Payment reference", group: "Management" },
    { key: "person_payments", label: "Payments by this person", group: "Management" },
    { key: "person_total", label: "Total from this person (NGN)", group: "Management" },
  ];

  return [...basic, ...contact, ...questions, ...management];
}

/** Ticked when the export opens: who, how much, when, what — and every question. Never contact details. */
export function defaultContributorExportKeys(available: readonly ContributorExportField[]): string[] {
  const basics = new Set(["name", "amount", "date", "options", "attendees", "period", "member_code"]);
  return available
    .filter((field) => (field.group === "Basic" && basics.has(field.key)) || field.group === "Questions")
    .map((field) => field.key);
}

/** Naira for a spreadsheet cell: "5,000.00", no symbol. Formatting only — the kobo are not changed. */
function nairaCell(value: bigint): string {
  return formatNaira(kobo(value), { symbol: false, decimals: true });
}

/**
 * The CSV columns for the chosen keys, in the order the export lists them.
 * Keys the collection cannot answer are dropped rather than trusted: the list
 * comes from the browser.
 */
export function contributorCsvColumns(
  keys: readonly string[],
  available: readonly ContributorExportField[],
  formatDateTime: (iso: string) => string,
): CsvColumn<ContributorRow>[] {
  const wanted = new Set(keys);
  const columns: CsvColumn<ContributorRow>[] = [];
  for (const field of available) {
    if (!wanted.has(field.key)) continue;
    const value = cellValue(field.key, formatDateTime);
    if (value) columns.push({ header: field.label, value });
  }
  return columns;
}

function cellValue(
  key: string,
  formatDateTime: (iso: string) => string,
): ((row: ContributorRow) => string) | null {
  switch (key) {
    case "name":
      return (row) => row.name;
    case "amount":
      return (row) => nairaCell(row.contributionKobo);
    case "total_paid":
      return (row) => nairaCell(row.totalChargedKobo);
    case "date":
      return (row) => formatDateTime(row.capturedAt);
    case "options":
      return (row) => describeLines(row.lines);
    case "attendees":
      return (row) => row.attendeeNames.join("; ");
    case "period":
      return (row) => row.cycleKey ?? "";
    case "member_code":
      return (row) => row.memberCode ?? "";
    case "member":
      return (row) => (row.isMember ? "Yes" : "No");
    case "email":
      return (row) => row.email ?? "";
    case "phone":
      return (row) => row.phone ?? "";
    case "acknowledged":
      return (row) => (row.acknowledgedAt ? "Yes" : "No");
    case "acknowledged_at":
      return (row) => (row.acknowledgedAt ? formatDateTime(row.acknowledgedAt) : "");
    case "acknowledged_by":
      return (row) => row.acknowledgedByName ?? "";
    case "reference":
      return (row) => row.reference;
    case "person_payments":
      return (row) => String(row.contributorPaymentCount);
    case "person_total":
      return (row) => nairaCell(row.contributorTotalKobo);
    default:
      if (key.startsWith("q:")) {
        const fieldKey = key.slice(2);
        return (row) => (row.answers[fieldKey] ?? "").trim();
      }
      return null;
  }
}
