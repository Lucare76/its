/**
 * GET /api/ops/foglio-viaggio?date=YYYY-MM-DD
 * Restituisce tutti i servizi del giorno con assignments + hotel,
 * raggruppati per veicolo/autista.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const date = request.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    const admin = auth.admin;
    const [servicesRes, assignmentsRes, hotelsRes] = await Promise.all([
      admin
        .from("services")
        .select("id, date, time, direction, customer_name, customer_first_name, customer_last_name, pax, vessel, hotel_id, meeting_point, place_type, phone, notes, status, service_type, booking_service_kind, service_type_code")
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .eq("is_draft", false)
        .neq("status", "cancelled")
        .order("time"),
      admin
        .from("assignments")
        .select("id, service_id, driver_user_id, vehicle_label")
        .eq("tenant_id", tenantId),
      admin
        .from("hotels")
        .select("id, name, zone")
        .eq("tenant_id", tenantId),
    ]);

    if (servicesRes.error) throw new Error(servicesRes.error.message);

    const services = (servicesRes.data ?? []) as Array<{
      id: string;
      date: string;
      time: string;
      direction: string;
      customer_name: string;
      customer_first_name: string | null;
      customer_last_name: string | null;
      pax: number;
      vessel: string | null;
      hotel_id: string | null;
      meeting_point: string | null;
      place_type: string | null;
      phone: string | null;
      notes: string | null;
      status: string | null;
      service_type: string | null;
      booking_service_kind: string | null;
      service_type_code: string | null;
    }>;

    const assignments = (assignmentsRes.data ?? []) as Array<{
      id: string;
      service_id: string;
      driver_user_id: string;
      vehicle_label: string;
    }>;

    const hotels = new Map(
      ((hotelsRes.data ?? []) as Array<{ id: string; name: string; zone: string | null }>)
        .map((h) => [h.id, h])
    );

    // Map service_id → assignment
    const assignmentByService = new Map(assignments.map((a) => [a.service_id, a]));

    // Arricchisci servizi con hotel e assignment
    const enriched = services.map((s) => {
      const hotel = s.hotel_id ? hotels.get(s.hotel_id) : null;
      const assignment = assignmentByService.get(s.id) ?? null;
      return {
        ...s,
        hotel_name: hotel?.name ?? null,
        hotel_zone: hotel?.zone ?? null,
        vehicle_label: assignment?.vehicle_label ?? null,
        driver_user_id: assignment?.driver_user_id ?? null,
        assignment_id: assignment?.id ?? null,
      };
    });

    // Raggruppa per vehicle_label (null → non assegnati)
    const vehicleMap = new Map<string, typeof enriched>();
    const unassigned: typeof enriched = [];

    for (const s of enriched) {
      if (!s.vehicle_label) {
        unassigned.push(s);
      } else {
        const key = s.vehicle_label;
        if (!vehicleMap.has(key)) vehicleMap.set(key, []);
        vehicleMap.get(key)!.push(s);
      }
    }

    // Ordina i gruppi per primo orario del gruppo
    const groups = Array.from(vehicleMap.entries())
      .sort(([, a], [, b]) => {
        const ta = a[0]?.time ?? "";
        const tb = b[0]?.time ?? "";
        return ta.localeCompare(tb);
      })
      .map(([vehicle_label, services]) => ({ vehicle_label, services }));

    return NextResponse.json({
      ok: true,
      date,
      groups,
      unassigned,
      total_services: enriched.length,
      total_pax: enriched.reduce((s, x) => s + (x.pax ?? 0), 0),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
