/**
 * GET /api/ops/driver-data
 * Restituisce solo i dati necessari al driver autenticato:
 *   - assignments dove driver_user_id = utente corrente
 *   - services corrispondenti
 *   - hotels
 *   - status_events per i suoi servizi
 *
 * Accessibile con role "driver" (o qualsiasi ruolo valido).
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const DRIVER_SERVICE_SELECT =
  "id,tenant_id,date,time,service_type,direction,vessel,pax,hotel_id,customer_name,phone,notes,status,meeting_point,pickup_time,linked_service_id,booking_service_kind";

type DriverServiceRow = {
  id: string;
  tenant_id: string;
  date: string;
  time: string;
  service_type: string | null;
  direction: string;
  vessel: string | null;
  pax: number;
  hotel_id: string | null;
  customer_name: string;
  phone: string | null;
  phone_e164?: string | null;
  notes: string | null;
  status: string;
  meeting_point: string | null;
  pickup_time: string | null;
  linked_service_id: string | null;
  booking_service_kind: string | null;
};

function withPhoneE164Fallback(services: DriverServiceRow[]) {
  return services.map((service) => ({
    ...service,
    phone_e164: service.phone_e164 ?? null,
  }));
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "driver", "supervisor", "autista"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;

    // 1. Prendo solo gli assignment di questo driver
    const { data: assignments, error: assignError } = await auth.admin
      .from("assignments")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("driver_user_id", userId);

    if (assignError) throw new Error(assignError.message);

    if (!assignments?.length) {
      const { data: hotels } = await auth.admin
        .from("hotels")
        .select("id, name, zone, lat, lng")
        .eq("tenant_id", tenantId);
      return jsonNoStore({
        ok: true,
        tenant_id: tenantId,
        user_id: userId,
        role: auth.membership.role,
        assignments: [],
        services: [],
        status_events: [],
        hotels: hotels ?? [],
      });
    }

    const serviceIds = assignments.map((a: { service_id: string }) => a.service_id);

    // 2. Servizi assegnati al driver — ultimi 60 giorni + tutti i futuri
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    const [servicesResult, statusEventsResult, hotelsResult] = await Promise.all([
      auth.admin
        .from("services")
        .select(DRIVER_SERVICE_SELECT)
        .eq("tenant_id", tenantId)
        .in("id", serviceIds)
        .gte("date", cutoffIso),
      auth.admin
        .from("status_events")
        .select("*")
        .eq("tenant_id", tenantId)
        .in("service_id", serviceIds),
      auth.admin
        .from("hotels")
        .select("id, name, zone, lat, lng")
        .eq("tenant_id", tenantId),
    ]);

    if (servicesResult.error) throw new Error(servicesResult.error.message);

    // 3. Carica anche i servizi linkati (tratta A/R) non direttamente assegnati
    //    per permettere all'autista di vedere entrambe le tratte in contesto
    const services = withPhoneE164Fallback((servicesResult.data ?? []) as DriverServiceRow[]);
    const linkedIds = services
      .map((s: { linked_service_id?: string | null }) => s.linked_service_id)
      .filter((id): id is string => !!id && !serviceIds.includes(id));

    let linkedServices: typeof services = [];
    if (linkedIds.length > 0) {
      const { data: linked } = await auth.admin
        .from("services")
        .select(DRIVER_SERVICE_SELECT)
        .eq("tenant_id", tenantId)
        .in("id", linkedIds);
      linkedServices = withPhoneE164Fallback((linked ?? []) as DriverServiceRow[]);
    }

    return jsonNoStore({
      ok: true,
      tenant_id: tenantId,
      user_id: userId,
      role: auth.membership.role,
      assignments: assignments ?? [],
      services: [...services, ...linkedServices],
      status_events: statusEventsResult.data ?? [],
      hotels: hotelsResult.data ?? [],
    });
  } catch (error) {
    return jsonNoStore(
      { ok: false, error: error instanceof Error ? error.message : "Errore sconosciuto" },
      { status: 500 }
    );
  }
}
