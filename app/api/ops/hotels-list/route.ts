import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

// Sprint Performance 14C. app/(app)/settings/shuttles/page.tsx used to call
// GET /api/ops/tenant-data (legacy path: fetchAllServices + all
// assignments/status_events/hotels/memberships/bus_lot_configs) only to read
// `hotels` for an <option> label. This endpoint returns just the minimal
// columns that consumer actually reads (id, name) — same roles as
// tenant-data's own authorizePricingRequest call, same tenant isolation.
export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await auth.admin
    .from("hotels")
    .select("id, name")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("name", { ascending: true });

  if (error) {
    return NextResponse.json({ ok: false, error: "Errore caricamento hotel." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, hotels: data ?? [] });
}
