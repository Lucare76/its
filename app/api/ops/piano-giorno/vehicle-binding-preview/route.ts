/**
 * Read-only preview for hybrid vehicle binding realignment.
 *
 * This endpoint only reads operator availability, trip_groups, assignments and
 * services. It does not update services, assignments, trip_groups or statuses.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildVehicleBindingPreview } from "@/lib/server/piano-vehicle-binding-preview";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const date = request.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const preview = await buildVehicleBindingPreview({
      admin: auth.admin,
      tenantId: auth.membership.tenant_id,
      date,
    });

    return NextResponse.json(preview);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Preview riallineamento mezzi non disponibile." },
      { status: 500 }
    );
  }
}
