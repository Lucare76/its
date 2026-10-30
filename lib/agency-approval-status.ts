export const PENDING_AGENCY_APPROVAL_STATUSES = ["pending_operator", "price_mismatch"];
export function needsAgencyApproval(status?: string | null) {
  return PENDING_AGENCY_APPROVAL_STATUSES.includes(status ?? "");
}
