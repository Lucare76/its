import { expect, it } from "vitest";
import { needsAgencyApproval, PENDING_AGENCY_APPROVAL_STATUSES } from "@/lib/agency-approval-status";
it.each(["pending_operator", "price_mismatch"])("keeps %s visible for operator approval", status => {
  expect(needsAgencyApproval(status)).toBe(true);
  expect(PENDING_AGENCY_APPROVAL_STATUSES).toContain(status);
});
it.each(["confirmed", "rejected", "agency_changes_requested", null, undefined, ""])("does not treat %s as a new request", status => {
  expect(needsAgencyApproval(status)).toBe(false);
});

import { resolveAssignableService } from "@/lib/piano-assignable-service";
it.each(["pending_operator", "price_mismatch", "rejected"])("blocks %s from island assignment", approval_status => {
 const row = resolveAssignableService({ id: "request", approval_status, direction: "arrival", time: "12:00", pax: 2, meeting_point: "Ischia Porto" }, { hotel: { name: "Hotel", zone: "Forio" } });
 expect(row.assignable).toBe(false);
 expect(row.hard_constraints).toContain("agency_approval_required");
});
