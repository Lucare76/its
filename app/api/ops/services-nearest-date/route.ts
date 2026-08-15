import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import type { Service } from "@/lib/types";

// Sprint Performance 13 — targeted fix. Planning's date-range scope (see
// lib/planning-date-fallback.ts and app/(app)/planning/page.tsx) means the
// page no longer sees the tenant's full service history, so it can no longer
// compute its pre-existing "jump to the earliest date with any data"
// fallback (used when the selected date has zero services) from data already
// in memory. This endpoint answers exactly that one question — the earliest
// business date with at least one operationally-visible service instance,
// tenant-wide — without ever fetching full service rows or the entire
// history.
//
// Approach: three tiny indexed-order queries (one per date-bearing column:
// date, arrival_date, departure_date), each limited to a small candidate
// batch, selecting only the columns buildOperationalInstances() actually
// reads. The exact business-date-resolution logic (arrival_date falling back
// to `date` for direction=arrival, linked-pair handling) is NOT reimplemented
// here — the unchanged buildOperationalInstances() is reused directly on the
// small candidate set, so there is zero risk of the two diverging.
//
// Correctness note (verified fix): each query ALSO applies the same
// is_draft/status predicate buildOperationalInstances' isOperationallyVisible()
// uses (is_draft is false/null, status is not "cancelled") directly in SQL,
// ascending-ordered with a deterministic `id` tie-break. Without this, a
// tenant with 200+ draft/cancelled rows older than its oldest VALID service
// would exhaust the LIMIT budget on rows that can never produce an instance,
// silently returning a later (wrong) date instead of the true earliest one —
// ascending ORDER BY alone does not guarantee this, only ordering the already
// SQL-filtered set does. See tests/unit/services-nearest-date-route.test.ts.
const CANDIDATE_LIMIT = 200;
const CANDIDATE_COLUMNS = "id,date,arrival_date,departure_date,direction,linked_service_id,is_draft,status,customer_name";
const VISIBLE_DRAFT_FILTER = "is_draft.eq.false,is_draft.is.null";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const [byDate, byArrival, byDeparture] = await Promise.all([
      auth.admin
        .from("services")
        .select(CANDIDATE_COLUMNS)
        .eq("tenant_id", tenantId)
        .or(VISIBLE_DRAFT_FILTER)
        .neq("status", "cancelled")
        .order("date", { ascending: true })
        .order("id", { ascending: true })
        .limit(CANDIDATE_LIMIT),
      auth.admin
        .from("services")
        .select(CANDIDATE_COLUMNS)
        .eq("tenant_id", tenantId)
        .or(VISIBLE_DRAFT_FILTER)
        .neq("status", "cancelled")
        .not("arrival_date", "is", null)
        .order("arrival_date", { ascending: true })
        .order("id", { ascending: true })
        .limit(CANDIDATE_LIMIT),
      auth.admin
        .from("services")
        .select(CANDIDATE_COLUMNS)
        .eq("tenant_id", tenantId)
        .or(VISIBLE_DRAFT_FILTER)
        .neq("status", "cancelled")
        .not("departure_date", "is", null)
        .order("departure_date", { ascending: true })
        .order("id", { ascending: true })
        .limit(CANDIDATE_LIMIT)
    ]);

    const error = byDate.error ?? byArrival.error ?? byDeparture.error;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const candidatesById = new Map<string, Service>();
    for (const row of [...(byDate.data ?? []), ...(byArrival.data ?? []), ...(byDeparture.data ?? [])]) {
      const candidate = row as unknown as Service;
      candidatesById.set(candidate.id, candidate);
    }

    const instances = buildOperationalInstances([...candidatesById.values()]);
    const earliestDate = instances.reduce<string | null>(
      (min, instance) => (min === null || instance.date < min ? instance.date : min),
      null
    );

    return NextResponse.json({ ok: true, date: earliestDate });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
