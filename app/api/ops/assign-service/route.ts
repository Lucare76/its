/**
 * POST /api/ops/assign-service
 * Assegna o rimuove un singolo servizio creando sempre un trip_group con group_id.
 * Usato da dispatch, service-workflow e dashboard per garantire che le
 * assegnazioni siano visibili nel Piano del Giorno.
 *
 * Adapter sottile (Sprint 2 MCP): la business logic (guard, overlap driver/
 * mezzo, geo validation, scrittura trip_groups/assignments/status_events,
 * assignment history, learned patterns) vive ora in
 * lib/server/assign-service-core.ts, condivisa con il tool MCP
 * its.assign_driver. Questa route si limita ad autenticare, validare la
 * forma dell'input HTTP e tradurre l'esito in NextResponse — stesso
 * comportamento esterno di prima, invariato.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { assignServiceCore } from "@/lib/server/assign-service-core";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    type Body = {
      service_id: string;
      driver_user_id?: string | null;
      driver_profile_id?: string | null;
      vehicle_label?: string | null;
      action?: "assign" | "remove";
      source?: string | null;
    };

    const body = (await request.json().catch(() => null)) as Body | null;
    if (!body?.service_id) {
      return NextResponse.json({ ok: false, error: "service_id obbligatorio." }, { status: 400 });
    }

    // ML Data Collection Sprint 3 (chiusura bypass P0): source opzionale,
    // whitelisted — mai un valore libero dal client dentro
    // driver_assignment_history.features. Assente -> nessun cambiamento per
    // i chiamanti esistenti (arrivals/dashboard/departures/dispatch/
    // service-workflow), che continuano a ricevere il default di
    // assignServiceCore ("manual_assign_service").
    const ALLOWED_SOURCES = new Set(["bus_tours", "map"]);
    const source = body.source && ALLOWED_SOURCES.has(body.source) ? body.source : undefined;

    const result = await assignServiceCore(auth.admin, {
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      serviceId: body.service_id,
      driverUserId: body.driver_user_id ?? null,
      driverProfileId: body.driver_profile_id ?? null,
      vehicleLabel: body.vehicle_label ?? null,
      action: body.action ?? "assign",
      source,
    });

    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore." },
      { status: 500 }
    );
  }
}
