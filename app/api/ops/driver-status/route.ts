/**
 * POST /api/ops/driver-status
 *
 * Aggiorna lo stato di un servizio dal driver, catturando la posizione GPS
 * dal sistema Radius/Kinesis (se configurato) oppure dalla posizione inviata
 * dal browser come fallback.
 *
 * Body: { service_id, status, browser_lat?, browser_lng? }
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import type { ServiceStatus } from "@/lib/types";

export const runtime = "nodejs";

const VALID_STATUSES = new Set<string>([
  "attesa", "partito", "arrivato", "caricato", "scaricato",
  "completato", "problema", "cancelled",
]);

export async function POST(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "supervisor", "operator", "driver"],
    auditPrefix: "driver_status",
  });
  if (auth instanceof NextResponse) return auth;

  const { admin, user, membership } = auth;
  const tenantId = membership.tenant_id;

  let body: {
    service_id?: string;
    status?: string;
    browser_lat?: number | null;
    browser_lng?: number | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 });
  }

  const { service_id, status, browser_lat, browser_lng } = body;

  if (!service_id || !status) {
    return NextResponse.json({ ok: false, error: "service_id e status sono obbligatori." }, { status: 400 });
  }
  if (!VALID_STATUSES.has(status)) {
    return NextResponse.json({ ok: false, error: `Stato non valido: ${status}` }, { status: 400 });
  }

  // Verifica che il servizio appartenga al tenant
  const { data: service, error: svcError } = await admin
    .from("services")
    .select("id, tenant_id, status")
    .eq("id", service_id)
    .eq("tenant_id", tenantId)
    .single();

  if (svcError || !service) {
    return NextResponse.json({ ok: false, error: "Servizio non trovato." }, { status: 404 });
  }

  // SEC-04: il body non porta alcun identificativo target (solo service_id) —
  // il ruolo "driver" deve poter aggiornare solo servizi effettivamente
  // assegnati a sé stesso. Senza questo guard, qualunque driver autenticato
  // del tenant può alterare lo stato del servizio di un collega semplicemente
  // conoscendone il service_id. Stesso pattern già usato in sola lettura da
  // driver-data/route.ts:94-96 (assignments.driver_user_id = auth.user.id),
  // qui applicato prima di qualsiasi scrittura. admin/operator/supervisor non
  // hanno un concetto di "driver target" in questa route (nessun campo body
  // lo esprime): il filtro tenant sul servizio, già esistente sopra, resta
  // l'unica e sufficiente verifica di ownership per questi ruoli — invariato.
  if (membership.role === "driver") {
    const { data: ownedAssignment, error: ownershipError } = await admin
      .from("assignments")
      .select("id")
      .eq("service_id", service_id)
      .eq("tenant_id", tenantId)
      .eq("driver_user_id", user.id)
      .maybeSingle();

    if (ownershipError) {
      return NextResponse.json(
        { ok: false, error: "DRIVER_STATUS_CHECK_FAILED", message: "Errore durante la verifica dell'autista." },
        { status: 500 }
      );
    }

    if (!ownedAssignment) {
      return NextResponse.json(
        { ok: false, error: "DRIVER_STATUS_FORBIDDEN", message: "Non puoi modificare lo stato di un altro autista." },
        { status: 403 }
      );
    }
  }

  // Recupera il radius_vehicle_id assegnato al driver per questo servizio
  let gpsLat: number | null = null;
  let gpsLng: number | null = null;

  if (process.env.RADIUS_REFRESH_TOKEN) {
    try {
      const { data: assignment } = await admin
        .from("assignments")
        .select("vehicle_id")
        .eq("service_id", service_id)
        .eq("tenant_id", tenantId)
        .limit(1)
        .maybeSingle();

      if (assignment?.vehicle_id) {
        const { data: vehicle } = await admin
          .from("vehicles")
          .select("radius_vehicle_id")
          .eq("id", assignment.vehicle_id)
          .maybeSingle();

        if (vehicle?.radius_vehicle_id) {
          const { fetchRadiusVehiclePosition } = await import("@/lib/server/radius-adapter");
          const pos = await fetchRadiusVehiclePosition(vehicle.radius_vehicle_id);
          if (pos && pos.lat && pos.lng) {
            gpsLat = pos.lat;
            gpsLng = pos.lng;
          }
        }
      }
    } catch {
      // GPS fallback silenzioso — non blocca l'aggiornamento stato
    }
  }

  // Usa posizione browser come fallback se Radius non disponibile
  if (gpsLat === null && browser_lat != null && browser_lng != null) {
    gpsLat = browser_lat;
    gpsLng = browser_lng;
  }

  // Aggiorna stato servizio
  const { error: updateError } = await admin
    .from("services")
    .update({ status: status as ServiceStatus })
    .eq("id", service_id)
    .eq("tenant_id", tenantId);

  if (updateError) {
    return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
  }

  // Inserisci evento stato con GPS
  const eventPayload: Record<string, unknown> = {
    tenant_id: tenantId,
    service_id,
    status,
    by_user_id: user.id,
  };
  if (gpsLat !== null) eventPayload.gps_lat = gpsLat;
  if (gpsLng !== null) eventPayload.gps_lng = gpsLng;

  const { error: eventError } = await admin
    .from("status_events")
    .insert(eventPayload);

  if (eventError) {
    // Non critico: lo stato è già aggiornato
    console.error("[driver-status] status_events insert error:", eventError.message);
  }

  return NextResponse.json({
    ok: true,
    status,
    gps_captured: gpsLat !== null,
    gps_source: gpsLat !== null
      ? (process.env.RADIUS_REFRESH_TOKEN ? "radius" : "browser")
      : null,
  });
}
