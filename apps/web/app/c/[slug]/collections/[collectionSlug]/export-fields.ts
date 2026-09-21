/**
 * What an export can be, as data rather than as behaviour.
 *
 * Separate from `export-actions.ts` because that file is `"use server"`, and
 * a server-action module may only export async functions — a plain constant
 * there fails the production build rather than the typecheck, which is how it
 * got past the first check in M7.5.
 *
 * WHAT CAN HONESTLY BE EXPORTED (M7.6 part E). The brief asks for
 * contributors, contributions, outstanding members, ticket attendees and
 * item orders. Three of those have no rows behind them in this phase: no
 * contribution, purchase or order is recorded anywhere — ADR 0012 rejected a
 * pending-contribution table on purpose and ADR 0006 gates the real one. So
 * they are not offered. An export named "Contributions" that produced an
 * empty file would read as "nobody paid", which is a different and much worse
 * statement than "this does not exist yet".
 *
 * What DOES exist is the collection's roll: the members it asks, what each
 * was asked for, which option they are on, the reference they were issued,
 * whether an officer exempted or waived any of it, the community's own member
 * fields, and — for an event — whether they came through the door. That is
 * what an organiser needs the night before, and every subject below is a view
 * of it.
 *
 * The shape is built so Phase 4 slots in rather than replaces: a new subject
 * is a row in EXPORT_SUBJECTS and a new source query, and a new column is a
 * row in EXPORT_FIELDS. Neither touches the builder, the filters or the PDF.
 */

export type ExportFormat = "csv" | "pdf";

export type ExportSubjectKey = "roll" | "outstanding" | "attendees" | "arrived";

export interface ExportSubjectChoice {
  readonly key: ExportSubjectKey;
  readonly label: string;
  readonly description: string;
  /** Only offered on a collection that can answer it. */
  readonly needs?: "event";
  /** The report's own heading when it is printed. */
  readonly reportTitle: string;
}

export const EXPORT_SUBJECTS: readonly ExportSubjectChoice[] = [
  {
    key: "roll",
    label: "Everyone on this collection",
    description: "Every member this collection asks, whatever their state.",
    reportTitle: "Contributor Report",
  },
  {
    key: "outstanding",
    label: "Still expected to pay",
    description: "Leaves out anyone an officer exempted or cancelled.",
    reportTitle: "Outstanding Report",
  },
  {
    key: "attendees",
    label: "Guest list",
    description: "Everyone expected at the event, with their door status.",
    needs: "event",
    reportTitle: "Guest List",
  },
  {
    key: "arrived",
    label: "Only those who arrived",
    description: "Everyone who has been checked in at the door.",
    needs: "event",
    reportTitle: "Attendance Report",
  },
];

export type ExportStatusFilter = "all" | "expected" | "exempt" | "cancelled";
export type ExportAttendanceFilter = "all" | "inside" | "left" | "absent";

export interface ExportFilters {
  readonly status: ExportStatusFilter;
  /** Only members in this group. Absent means every group. */
  readonly groupId?: string | undefined;
  /** Only people assigned to this option. Tiered collections only. */
  readonly tierId?: string | undefined;
  /** Only this period. Recurring collections only. */
  readonly cycleKey?: string | undefined;
  readonly attendance?: ExportAttendanceFilter | undefined;
  /** Added to the roll on or after this date, as yyyy-mm-dd. */
  readonly assignedFrom?: string | undefined;
  /** Added to the roll on or before this date, as yyyy-mm-dd. */
  readonly assignedTo?: string | undefined;
}

export interface ExportRequest {
  readonly subject: ExportSubjectKey;
  readonly format: ExportFormat;
  readonly fieldKeys: readonly string[];
  readonly filters: ExportFilters;
}

export type ExportFieldGroup = "Identity" | "Collection" | "Membership" | "Event" | "Custom fields";

export interface ExportFieldChoice {
  readonly key: string;
  readonly label: string;
  readonly group: ExportFieldGroup;
  /** How much of a printed page this column asks for, relative to the others. */
  readonly weight: number;
  readonly align?: "left" | "right";
  /** Only offered on a collection that can answer it. */
  readonly needs?: "event" | "tiers" | "recurring";
  /** Personal data. Shown under its own warning in the builder (part Y). */
  readonly sensitive?: boolean;
}

/**
 * The fixed columns. Custom member fields are discovered per community and
 * appended under "Custom fields" with `attr:` keys.
 *
 * `weight` is the column's share of a printed page. A name needs room; a
 * status does not.
 */
export const EXPORT_FIELDS: readonly ExportFieldChoice[] = [
  { key: "reference", label: "Reference", group: "Identity", weight: 2.2 },
  { key: "full_name", label: "Full name", group: "Identity", weight: 4 },
  { key: "member_code", label: "Member ID", group: "Identity", weight: 2.2 },
  { key: "phone", label: "Phone number", group: "Identity", weight: 2.6, sensitive: true },
  { key: "email", label: "Email", group: "Identity", weight: 3.4, sensitive: true },

  { key: "tier", label: "Option", group: "Collection", weight: 2, needs: "tiers" },
  { key: "expected_amount", label: "Expected amount", group: "Collection", weight: 2.2, align: "right" },
  { key: "waived_amount", label: "Waived amount", group: "Collection", weight: 2.2, align: "right" },
  { key: "obligation_status", label: "Status", group: "Collection", weight: 1.6 },
  { key: "due_at", label: "Due date", group: "Collection", weight: 1.8 },
  { key: "cycle", label: "Period", group: "Collection", weight: 1.6, needs: "recurring" },
  { key: "assigned_at", label: "Added on", group: "Collection", weight: 1.8 },

  { key: "groups", label: "Groups", group: "Membership", weight: 3 },

  { key: "checked_in", label: "Checked in", group: "Event", weight: 2.4, needs: "event" },
  { key: "checked_out", label: "Checked out", group: "Event", weight: 2.4, needs: "event" },
  { key: "attendance", label: "At the door", group: "Event", weight: 1.8, needs: "event" },
];

export const EXPORT_FIELD_GROUP_ORDER: readonly ExportFieldGroup[] = [
  "Identity",
  "Collection",
  "Membership",
  "Event",
  "Custom fields",
];

/** What is ticked when the builder opens, per subject. Enough to be useful, not so much that it needs trimming. */
export const DEFAULT_FIELDS: Record<ExportSubjectKey, readonly string[]> = {
  roll: ["reference", "full_name", "member_code", "expected_amount", "obligation_status"],
  outstanding: ["reference", "full_name", "member_code", "expected_amount", "due_at"],
  attendees: ["reference", "full_name", "tier", "attendance", "checked_in"],
  arrived: ["reference", "full_name", "tier", "checked_in", "checked_out"],
};

/**
 * Which controls a subject has already answered, so the builder does not ask
 * again. "Still expected to pay" has decided the status; "only those who
 * arrived" has decided the door. The SERVER applies these regardless of what
 * the browser sends — this record only keeps the form from contradicting
 * itself on screen.
 */
export const SUBJECT_LOCKS: Record<ExportSubjectKey, { status: boolean; attendance: boolean }> = {
  roll: { status: false, attendance: false },
  outstanding: { status: true, attendance: false },
  attendees: { status: false, attendance: false },
  arrived: { status: false, attendance: true },
};
