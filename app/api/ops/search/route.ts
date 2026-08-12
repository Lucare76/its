import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchAllServices } from "@/lib/server/fetch-all-services";
import { collapseLinkedBookingPairs, filterBookingsBySearch } from "@/lib/booking-search";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    const agency = (req.nextUrl.searchParams.get("agency") ?? "").trim();
    if (q.length < 1 && agency.length < 1) return NextResponse.json({ ok: true, results: [] });

    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "30"), 100);

    const [servicesResult, hotelsResult, agenciesResult] = await Promise.all([
      fetchAllServices(auth.admin, tenantId),
      auth.admin.from("hotels").select("id,name").eq("tenant_id", tenantId),
      auth.admin.from("agencies").select("id,name").eq("tenant_id", tenantId),
    ]);

    const error = servicesResult.error ?? hotelsResult.error ?? agenciesResult.error ?? null;
    if (error) throw new Error(error.message);

    const hotelNameById = new Map((hotelsResult.data ?? []).map((hotel: { id: string; name: string }) => [hotel.id, hotel.name]));
    const agencyNameById = new Map((agenciesResult.data ?? []).map((item: { id: string; name: string }) => [item.id, item.name]));
    const searchable = (servicesResult.data ?? [])
      .filter((service) => !service.is_draft)
      .map((service) => ({
        ...service,
        hotel_name: service.hotel_id ? hotelNameById.get(service.hotel_id) ?? null : null,
      }));

    const results = collapseLinkedBookingPairs(
      filterBookingsBySearch(searchable, q, agency, agencyNameById, Math.max(limit * 2, 100))
    ).slice(0, limit)
      .map((r) => {
        const linked = r.linked_service_id
          ? (servicesResult.data ?? []).find((candidate) => candidate.id === r.linked_service_id)
          : null;
        const arrivalLeg = r.direction === "arrival" ? r : linked?.direction === "arrival" ? linked : r;
        const departureLeg = r.direction === "departure" ? r : linked?.direction === "departure" ? linked : null;
        const joinedName = [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ").trim();
        const owner = r.billing_party_name ?? (r.agency_id ? agencyNameById.get(r.agency_id) : null) ?? "Privato";
        return {
          id: r.id,
          inbound_email_id: r.inbound_email_id ?? null,
          customer_name: r.customer_name?.trim() || joinedName || "Cliente N/D",
          customer_first_name: r.customer_first_name ?? null,
          customer_last_name: r.customer_last_name ?? null,
          customer_email: r.customer_email ?? null,
          phone: r.phone ?? null,
          phone_e164: r.phone_e164 ?? null,
          date: r.date,
          time: r.time,
          status: r.status,
          direction: r.direction,
          pax: r.pax,
          vessel: r.vessel ?? null,
          booking_service_kind: r.booking_service_kind ?? null,
          service_type: r.service_type ?? null,
          service_type_code: r.service_type_code ?? null,
          arrival_date: r.arrival_date ?? null,
          arrival_time: r.arrival_time ?? null,
          train_arrival_time: r.train_arrival_time ?? null,
          departure_date: r.departure_date ?? null,
          departure_time: r.departure_time ?? null,
          train_departure_time: r.train_departure_time ?? null,
          orario_barca: r.orario_barca ?? null,
          transport_code: r.transport_code ?? null,
          bus_city_origin: r.bus_city_origin ?? null,
          hotel_id: r.hotel_id ?? null,
          hotel_name: r.hotel_name ?? null,
          billing_party_name: r.billing_party_name ?? null,
          agency_id: r.agency_id ?? null,
          owner_label: owner,
          meeting_point: r.meeting_point ?? null,
          notes: r.notes ?? null,
          linked_service_id: r.linked_service_id ?? null,
          outbound_ferry_departure_time: arrivalLeg.time ?? null,
          outbound_ferry_arrival_time: arrivalLeg.arrival_time ?? null,
          return_pickup_time: departureLeg?.pickup_time ?? departureLeg?.departure_time ?? null,
          return_ferry_departure_time: departureLeg?.orario_barca ?? null,
        };
      });

    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
