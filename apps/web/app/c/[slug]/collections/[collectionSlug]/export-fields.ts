/**
 * What an export can contain, as data rather than as behaviour.
 *
 * Separate from `export-actions.ts` because that file is `"use server"`, and
 * a server-action module may only export async functions — a plain constant
 * there fails the build rather than the typecheck, which is how it got past
 * the first check.
 */

export interface ExportFieldChoice {
  readonly key: string;
  readonly label: string;
}

export interface ExportFilters {
  /** `all`, or only those an officer has exempted / not exempted. Payment status does not exist in this phase. */
  readonly status: "all" | "expected" | "exempt";
  /** Only members in this group. Absent means every group. */
  readonly groupId?: string | undefined;
}

/** The fixed columns, in the order they appear in the file. Custom member fields are discovered per community. */
export const EXPORT_FIELDS: readonly ExportFieldChoice[] = [
  { key: "full_name", label: "Full name" },
  { key: "member_code", label: "Member ID" },
  { key: "phone", label: "Phone number" },
  { key: "email", label: "Email" },
  { key: "groups", label: "Groups" },
  { key: "expected_amount", label: "Expected amount" },
  { key: "waived_amount", label: "Waived amount" },
  { key: "obligation_status", label: "Status" },
  { key: "due_at", label: "Due date" },
  { key: "cycle", label: "Period" },
  { key: "checked_in", label: "Checked in" },
];
