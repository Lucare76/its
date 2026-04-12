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

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "driver", "supervisor"]);
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
      return NextResponse.json({
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
        .select("*")
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

    return NextResponse.json({
      ok: true,
      tenant_id: tenantId,
      user_id: userId,
      role: auth.membership.role,
      assignments: assignments ?? [],
      services: servicesResult.data ?? [],
      status_events: statusEventsResult.data ?? [],
      hotels: hotelsResult.data ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore sconosciuto" },
      { status: 500 }
    );
  }
}
