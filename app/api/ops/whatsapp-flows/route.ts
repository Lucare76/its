import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { createAdminClient, getTenantWhatsAppSettings } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

function addDays(baseIso: string, days: number) {
  const base = new Date(`${baseIso}T00:00:00`);
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function nextMondayIso() {
  const today = new Date();
  const delta = (8 - today.getDay()) % 7 || 7;
  today.setDate(today.getDate() + delta);
  return today.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const tenantId = auth.membership.tenant_id;
    const kind = request.nextUrl.searchParams.get("kind") ?? "arrivals_48h";
    const today = new Date().toISOString().slice(0, 10);
    const targetDate = request.nextUrl.searchParams.get("date") ?? (
      kind === "bus_monday" ? nextMondayIso() : addDays(today, 2)
    );
    const settings = await getTenantWhatsAppSettings(admin, tenantId);

    if (kind === "bus_monday") {
      const { data, error } = await admin
        .from("ops_bus_allocation_details")
        .select("*")
        .eq("service_date", targetDate);
      if (error) throw new Error(error.message);

      const grouped = new Map<string, { pax: number; bookings: number; stops: Set<string> }>();
      for (const row of data ?? []) {
        const key = `${row.line_name}`;
        const current = grouped.get(key) ?? { pax: 0, bookings: 0, stops: new Set<string>() };
        current.pax += Number(row.pax_assigned ?? 0);
        current.bookings += 1;
        if (row.stop_name) current.stops.add(String(row.stop_name));
        grouped.set(key, current);
      }

      return NextResponse.json({
        ok: true,
        kind,
        target_date: targetDate,
        previews: Array.from(grouped.entries()).map(([lineName, info]) => ({
          audience: "operations_bus",
          line_name: lineName,
          template: "bus_monday_summary",
          variables: {
            line_name: lineName,
            target_date: targetDate,
            bookings: String(info.bookings),
            pax: String(info.pax),
            stops: Array.from(info.stops).join(", ")
          },
          hook_payload: {
            trigger: "bus_monday",
            target_date: targetDate,
            line_name: lineName
          }
        }))
      });
    }

    const direction = kind === "departures_48h" ? "departure" : "arrival";
    const { data, error } = await admin
      .from("services")
      .select("id, customer_name, phone, phone_e164, date, time, departure_date, departure_time, direction, meeting_point, vessel")
      .eq("tenant_id", tenantId)
      .eq("direction", direction)
      .eq(direction === "arrival" ? "date" : "departure_date", targetDate);
    if (error) throw new Error(error.message);

    return NextResponse.json({
      ok: true,
      kind,
      target_date: targetDate,
      settings: {
        default_template: settings.default_template,
        arrival_template: settings.arrival_template,
        template_language: settings.template_language
      },
      previews: (data ?? []).map((service: Record<string, unknown>) => ({
        service_id: service.id,
        customer_name: service.customer_name,
        phone: service.phone_e164 ?? service.phone ?? null,
        template: direction === "arrival" ? settings.arrival_template : settings.default_template,
        variables: {
          name: String(service.customer_name ?? ""),
          time: String((direction === "arrival" ? service.time : service.departure_time) ?? "").slice(0, 5),
          meeting_point: String(service.meeting_point ?? ""),
          vessel: String(service.vessel ?? "")
        },
        hook_payload: {
          trigger: kind,
          target_date: targetDate,
          service_id: service.id
        }
      }))
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
