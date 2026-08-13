import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchAllServices } from "@/lib/server/fetch-all-services";
import { collapseLinkedBookingPairs, filterBookingsBySearch } from "@/lib/booking-search";
import { ferryPortLabel, findArrivalScheduleForService, findDepartureScheduleForService, type FerryScheduleRow } from "@/lib/ferry-schedule-options";
import { getPickupRuleByRange, normalizeZonaIschia } from "@/lib/departure-pickup-rules";
import { findFerryPickupRule, resolveAgencyLogic, type FerryPickupRule } from "@/lib/ferry-pickup-rules";

export const runtime = "nodejs";

function cleanTime(value: string | null | undefined): string | null {
  const match = String(value ?? "").match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function transferTransportType(kind: string | null | undefined): "train" | "flight" | null {
  if (!kind) return null;
  if (kind.includes("train")) return "train";
  if (kind.includes("airport")) return "flight";
  return null;
}

function transferBoatType(kind: string | null | undefined): "traghetto" | "aliscafo" {
  return kind?.endsWith("_aliscafo") ? "aliscafo" : "traghetto";
}

function transferDepartureRuleType(kind: string | null | undefined): string | null {
  const transportType = transferTransportType(kind);
  if (!transportType) return null;
  const prefix = transportType === "train" ? "treno" : "volo";
  return `${prefix}_${transferBoatType(kind)}`;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    const agency = (req.nextUrl.searchParams.get("agency") ?? "").trim();
    if (q.length < 1 && agency.length < 1) return NextResponse.json({ ok: true, results: [] });

    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "30"), 100);

    const [servicesResult, hotelsResult, agenciesResult, schedulesResult, ferryPickupRulesResult] = await Promise.all([
      fetchAllServices(auth.admin, tenantId),
      auth.admin.from("hotels").select("id,name,zone").eq("tenant_id", tenantId),
      auth.admin.from("agencies").select("id,name").eq("tenant_id", tenantId),
      auth.admin.from("ferry_schedules").select("company,departure_port,arrival_port,departure_time,arrival_time,direction,days_of_week,valid_from,valid_to"),
      auth.admin.from("ferry_pickup_rules").select("*"),
    ]);

    const error = servicesResult.error ?? hotelsResult.error ?? agenciesResult.error ?? schedulesResult.error ?? ferryPickupRulesResult.error ?? null;
    if (error) throw new Error(error.message);

    const hotelNameById = new Map((hotelsResult.data ?? []).map((hotel: { id: string; name: string }) => [hotel.id, hotel.name]));
    const hotelZoneById = new Map((hotelsResult.data ?? []).map((hotel: { id: string; zone?: string | null }) => [hotel.id, hotel.zone ?? null]));
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
        const schedules = (schedulesResult.data ?? []) as FerryScheduleRow[];
        const ferryPickupRules = (ferryPickupRulesResult.data ?? []) as FerryPickupRule[];
        const joinedName = [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ").trim();
        const owner = r.billing_party_name ?? (r.agency_id ? agencyNameById.get(r.agency_id) : null) ?? "Privato";
        const hotelZone = r.hotel_id ? hotelZoneById.get(r.hotel_id) ?? null : null;
        const transportType = transferTransportType(arrivalLeg.booking_service_kind);
        const ruleTransportTime = cleanTime(arrivalLeg.train_arrival_time) ?? cleanTime(arrivalLeg.arrival_time) ?? cleanTime(arrivalLeg.time);
        const ferryPickupRule = transportType && ruleTransportTime
          ? findFerryPickupRule(
            ferryPickupRules,
            resolveAgencyLogic(owner),
            transportType,
            transferBoatType(arrivalLeg.booking_service_kind),
            ruleTransportTime,
            arrivalLeg.arrival_date ?? arrivalLeg.date
          )
          : null;
        const arrivalSchedule = findArrivalScheduleForService(
          schedules,
          arrivalLeg.arrival_date ?? arrivalLeg.date,
          arrivalLeg.time,
          arrivalLeg.booking_service_kind ?? null
        );
        const returnFerryDepartureTime = departureLeg?.orario_barca ?? r.orario_barca ?? departureLeg?.departure_time ?? r.departure_time ?? null;
        const returnSchedule = findDepartureScheduleForService(
          schedules,
          departureLeg?.departure_date ?? r.departure_date ?? r.date,
          returnFerryDepartureTime,
          departureLeg?.booking_service_kind ?? r.booking_service_kind ?? null
        );
        const departureRuleType = transferDepartureRuleType(departureLeg?.booking_service_kind);
        const departureTransportTime = cleanTime(departureLeg?.train_departure_time) ?? cleanTime(departureLeg?.departure_time) ?? cleanTime(departureLeg?.time);
        const departurePickupRule = departureRuleType && departureTransportTime
          ? getPickupRuleByRange(owner, departureRuleType, departureTransportTime, normalizeZonaIschia(hotelZone))
          : null;
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
          outbound_ferry_departure_time: ferryPickupRule?.departureTime ?? arrivalLeg.time ?? null,
          outbound_ferry_arrival_time: ferryPickupRule?.arrivalTime ?? arrivalSchedule?.arrivalTime ?? arrivalLeg.arrival_time ?? null,
          return_pickup_time: departureLeg?.pickup_time ?? departurePickupRule?.pickup ?? departureLeg?.departure_time ?? null,
          return_ferry_departure_time: departureLeg?.orario_barca ?? departurePickupRule?.boat_t ?? null,
          outbound_ferry_company: arrivalSchedule?.company?.toUpperCase() ?? null,
          outbound_ferry_departure_port: arrivalSchedule ? ferryPortLabel(arrivalSchedule.departurePort) : null,
          outbound_ferry_arrival_port: arrivalSchedule ? ferryPortLabel(arrivalSchedule.arrivalPort) : null,
          return_ferry_company: returnSchedule?.company?.toUpperCase() ?? null,
          return_ferry_departure_port: returnSchedule ? ferryPortLabel(returnSchedule.departurePort) : null,
          return_ferry_arrival_port: returnSchedule ? ferryPortLabel(returnSchedule.arrivalPort) : null,
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
