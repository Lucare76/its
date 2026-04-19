/**
 * GET /api/ops/piano-giorno?date=YYYY-MM-DD
 * Carica tutti i dati necessari per il Piano del Giorno.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    // Giorno della settimana (0=dom, 1=lun, …) per ferry schedules
    const dow = new Date(date + "T12:00:00Z").getDay();

    const [
      servicesResult,
      tripGroupsResult,
      assignmentsResult,
      hotelsResult,
      membershipsResult,
      vehiclesResult,
      ferryResult,
    ] = await Promise.all([
      auth.admin
        .from("services")
        .select("id, date, time, direction, customer_name, customer_first_name, customer_last_name, pax, hotel_id, vessel, notes, status, meeting_point, place_type, pickup_hotel, booking_service_kind, service_type, phone, phone_e164")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .neq("status", "cancelled")
        .neq("is_draft", true)
        .order("time"),

      auth.admin
        .from("trip_groups")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("status", "active"),

      auth.admin
        .from("assignments")
        .select("id, service_id, driver_user_id, vehicle_label, group_id")
        .eq("tenant_id", tenantId),

      auth.admin
        .from("hotels")
        .select("id, name, zone")
        .eq("tenant_id", tenantId),

      auth.admin
        .from("memberships")
        .select("user_id, full_name, role")
        .eq("tenant_id", tenantId)
        .in("role", ["driver", "admin", "operator"]),

      auth.admin
        .from("vehicles")
        .select("id, label, capacity, vehicle_size, active")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("label"),

      auth.admin
        .from("ferry_schedules")
        .select("id, company, departure_port, arrival_port, departure_time, direction, notes")
        .eq("direction", "mainland_to_ischia")
        .contains("days_of_week", [dow])
        .order("departure_time"),
    ]);

    const error =
      servicesResult.error ??
      tripGroupsResult.error ??
      assignmentsResult.error ??
      hotelsResult.error ??
      membershipsResult.error ??
      vehiclesResult.error;

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    // Filtra assignments per i servizi del giorno (join in JS per evitare query complessa)
    const dayServiceIds = new Set((servicesResult.data ?? []).map((s) => s.id));
    const dayAssignments = (assignmentsResult.data ?? []).filter(
      (a) => dayServiceIds.has(a.service_id)
    );

    return NextResponse.json({
      ok: true,
      date,
      services: servicesResult.data ?? [],
      trip_groups: tripGroupsResult.data ?? [],
      assignments: dayAssignments,
      hotels: hotelsResult.data ?? [],
      memberships: membershipsResult.data ?? [],
      vehicles: vehiclesResult.data ?? [],
      ferry_schedules: ferryResult.data ?? [],
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore." },
      { status: 500 }
    );
  }
}
