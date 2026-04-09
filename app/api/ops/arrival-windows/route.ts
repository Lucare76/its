import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildArrivalWindowSummary } from "@/lib/server/bus-network";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const date = request.nextUrl.searchParams.get("date");

    const query = auth.admin
      .from("services")
      .select("*")
      .eq("tenant_id", tenantId)
      .or(
        "booking_service_kind.eq.transfer_port_hotel,booking_service_kind.eq.transfer_train_hotel,booking_service_kind.eq.transfer_airport_hotel,service_type_code.eq.transfer_port_hotel,service_type_code.eq.transfer_station_hotel,service_type_code.eq.transfer_airport_hotel"
      )
      .order("date")
      .order("time");

    if (date) query.eq("date", date);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, windows: buildArrivalWindowSummary(data ?? []) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
