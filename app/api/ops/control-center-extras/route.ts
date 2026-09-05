/**
 * GET /api/ops/control-center-extras?date=YYYY-MM-DD
 *
 * Supporto READ-ONLY minimo per la pagina Centro Operativo / Controllo
 * Giornata (app/(app)/controllo-giornata/page.tsx). Copre SOLO le lacune
 * confermate dall'audit — nessun endpoint esistente le espone già:
 *
 *  1. servizi strutturalmente assegnabili (piano-unassigned-services-
 *     diagnostics.ts, INVARIATO — usato solo per la classificazione) che
 *     NON hanno ancora un assignments.driver_user_id non nullo;
 *  2. prenotazioni agenzia con approval_status='pending_operator' (backlog,
 *     non filtrato per data — una prenotazione da approvare puo' riguardare
 *     qualunque data futura);
 *  3. cancellation_requests in stato pending_review/pending_agency_approval
 *     (backlog, stesso motivo);
 *  4. whatsapp_events di kind "info_3d" con stato normalizzato realmente
 *     "failed", per i service_id della giornata richiesta.
 *
 * Nessuna logica di assegnazione, bus o WhatsApp viene modificata o
 * reimplementata qui: solo letture + le funzioni pure di
 * lib/server/control-center-extras.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildUnassignedServicesDiagnostics } from "@/lib/piano-unassigned-services-diagnostics";
import type { AutoAssignPreviewHotel, AutoAssignPreviewService } from "@/lib/piano-assignable-preview";
import { romeDateKey } from "@/lib/server/operational-health/operations-health";
import {
  computeAssignableUnassigned,
  computeWhatsAppFailedForServices,
  evaluatePendingAgencyApprovals,
  evaluatePendingCancellationRequests,
  WHATSAPP_CONTROL_CENTER_KIND,
} from "@/lib/server/control-center-extras";

export const runtime = "nodejs";

// Stessa selezione colonne di app/api/ops/piano-giorno/unassigned-diagnostics/route.ts
// (INVARIATO, non importato da lì per non introdurre un accoppiamento tra
// route — stesso pattern già usato da group-diagnostics/route.ts).
const BASE_SERVICE_COLUMNS = [
  "id",
  "date",
  "time",
  "time_from",
  "time_to",
  "direction",
  "customer_name",
  "pax",
  "hotel_id",
  "vessel",
  "notes",
  "status",
  "meeting_point",
  "place_type",
  "pickup_hotel",
  "booking_service_kind",
  "service_type",
  "phone",
];

const OPTIONAL_SERVICE_COLUMNS = [
  "service_type_code",
  "transport_code",
  "orario_barca",
  "porto_bruno",
  "barca_compagnia",
  "ferry_details",
  "excursion_details",
  "tour_name",
  "pickup_time",
  "origin_place_type",
  "destination_place_type",
  "origin_place_id",
  "destination_place_id",
  "arrival_time",
  "departure_time",
];

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1]
    ?? message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1]
    ?? message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1]
    ?? null;
}

async function handleControlCenterExtras(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const url = new URL(request.url);
    const date = url.searchParams.get("date")?.trim() || romeDateKey(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ ok: false, error: "Parametro 'date' non valido (atteso YYYY-MM-DD)." }, { status: 400 });
    }

    const tenantId = auth.membership.tenant_id;

    // 1. Servizi della giornata (stessa query di unassigned-diagnostics/route.ts) —
    // usati per: classificazione assegnabilità, header (numero servizi/pax),
    // e come base per le query assignments/whatsapp_events sotto.
    let serviceColumns = [...BASE_SERVICE_COLUMNS, ...OPTIONAL_SERVICE_COLUMNS];
    let servicesResult: {
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    } = { data: null, error: null };
    const omittedServiceColumns: string[] = [];

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const result = await auth.admin
        .from("services")
        .select(serviceColumns.join(", "))
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .neq("status", "cancelled")
        .neq("is_draft", true)
        .order("time")
        .limit(3000);

      servicesResult = result as typeof servicesResult;
      if (!result.error) break;

      const missingColumn = missingSchemaColumn(result.error.message);
      if (!missingColumn || !serviceColumns.includes(missingColumn)) break;
      omittedServiceColumns.push(missingColumn);
      serviceColumns = serviceColumns.filter((column) => column !== missingColumn);
    }

    if (servicesResult.error) {
      return NextResponse.json({ ok: false, error: `services: ${servicesResult.error.message}` }, { status: 500 });
    }

    const services = (servicesResult.data ?? []) as AutoAssignPreviewService[];
    const dayServiceIds = services.map((service) => service.id);
    const paxTotal = services.reduce((sum, service) => sum + (Number(service.pax) || 0), 0);

    const hotelsResult = await auth.admin
      .from("hotels")
      .select("id, name, zone, lat, lng")
      .eq("tenant_id", tenantId);

    if (hotelsResult.error) {
      return NextResponse.json({ ok: false, error: `hotels: ${hotelsResult.error.message}` }, { status: 500 });
    }

    // Classificazione INVARIATA — stessa funzione usata da
    // app/api/ops/piano-giorno/unassigned-diagnostics/route.ts.
    const classification = buildUnassignedServicesDiagnostics({
      date,
      services,
      hotels: (hotelsResult.data ?? []) as AutoAssignPreviewHotel[],
    });

    // 2. Assignments della giornata (TUTTI i servizi, non solo quelli
    // strutturalmente assegnabili) — servono sia per sottrarre chi ha già un
    // autista sia per l'header (autisti/mezzi in uso oggi).
    const assignmentsResult = dayServiceIds.length
      ? await auth.admin
          .from("assignments")
          .select("service_id, driver_user_id, vehicle_label")
          .eq("tenant_id", tenantId)
          .in("service_id", dayServiceIds)
      : { data: [] as Array<{ service_id: string; driver_user_id: string | null; vehicle_label: string | null }>, error: null };

    if (assignmentsResult.error) {
      return NextResponse.json({ ok: false, error: `assignments: ${assignmentsResult.error.message}` }, { status: 500 });
    }

    const assignments = assignmentsResult.data ?? [];
    // driver_user_id è nullable dalla migration 0137: un giro puo' avere un
    // mezzo assegnato e nessun autista ancora. Solo driver_user_id non nullo
    // conta come "autista assegnato".
    const assignedServiceIdsWithDriver = new Set(
      assignments.filter((row) => row.driver_user_id != null).map((row) => row.service_id)
    );
    const driversInUse = new Set(
      assignments.filter((row) => row.driver_user_id != null).map((row) => row.driver_user_id as string)
    );
    const busesInUse = new Set(
      assignments
        .filter((row) => row.vehicle_label != null && String(row.vehicle_label).trim().length > 0)
        .map((row) => row.vehicle_label as string)
    );

    const assignableUnassigned = computeAssignableUnassigned(classification.stops, assignedServiceIdsWithDriver);

    // 3. Prenotazioni agenzia in attesa (backlog tenant, non filtrato per data).
    const pendingApprovalServicesResult = await auth.admin
      .from("services")
      .select("id, customer_name, date, created_at, approval_status")
      .eq("tenant_id", tenantId)
      .eq("approval_status", "pending_operator");

    if (pendingApprovalServicesResult.error) {
      return NextResponse.json(
        { ok: false, error: `services(approval_status): ${pendingApprovalServicesResult.error.message}` },
        { status: 500 }
      );
    }

    const pendingApprovalServices = (pendingApprovalServicesResult.data ?? []) as Array<{
      id: string;
      customer_name: string | null;
      date: string | null;
      created_at: string | null;
      approval_status: string | null;
    }>;
    const pendingApprovalIds = pendingApprovalServices.map((service) => service.id);

    const tokensResult = pendingApprovalIds.length
      ? await auth.admin
          .from("booking_approval_tokens")
          .select("service_id, expires_at")
          .eq("tenant_id", tenantId)
          .in("service_id", pendingApprovalIds)
      : { data: [] as Array<{ service_id: string; expires_at: string | null }>, error: null };

    if (tokensResult.error) {
      return NextResponse.json(
        { ok: false, error: `booking_approval_tokens: ${tokensResult.error.message}` },
        { status: 500 }
      );
    }

    // Un servizio può avere più token nel tempo (es. riemesso dopo scadenza):
    // teniamo la scadenza più recente per la valutazione di urgenza.
    const tokenExpiryByServiceId = new Map<string, string | null>();
    for (const token of tokensResult.data ?? []) {
      const current = tokenExpiryByServiceId.get(token.service_id);
      if (!current || (token.expires_at && token.expires_at > current)) {
        tokenExpiryByServiceId.set(token.service_id, token.expires_at);
      }
    }

    const agencyApprovalsPending = evaluatePendingAgencyApprovals(pendingApprovalServices, tokenExpiryByServiceId);

    // 4. Cancellazioni pendenti (backlog tenant, non filtrato per data).
    const cancellationRequestsResult = await auth.admin
      .from("cancellation_requests")
      .select("id, service_id, status, created_at")
      .eq("tenant_id", tenantId)
      .in("status", ["pending_review", "pending_agency_approval"]);

    if (cancellationRequestsResult.error) {
      return NextResponse.json(
        { ok: false, error: `cancellation_requests: ${cancellationRequestsResult.error.message}` },
        { status: 500 }
      );
    }

    const cancellationRequestsPending = evaluatePendingCancellationRequests(
      (cancellationRequestsResult.data ?? []) as Array<{
        id: string;
        service_id: string;
        status: string;
        created_at: string | null;
      }>
    );

    // 5. WhatsApp falliti — SOLO kind "info_3d" (unico attivo/joinabile,
    // vedi vercel.json e nota su WHATSAPP_CONTROL_CENTER_KIND), scoped ai
    // service_id della giornata selezionata.
    const whatsappEventsResult = dayServiceIds.length
      ? await auth.admin
          .from("whatsapp_events")
          .select("service_id, status, happened_at, to_phone, template")
          .eq("tenant_id", tenantId)
          .eq("kind", WHATSAPP_CONTROL_CENTER_KIND)
          .in("service_id", dayServiceIds)
      : {
          data: [] as Array<{
            service_id: string | null;
            status: string;
            happened_at: string;
            to_phone: string | null;
            template: string | null;
          }>,
          error: null,
        };

    if (whatsappEventsResult.error) {
      return NextResponse.json(
        { ok: false, error: `whatsapp_events: ${whatsappEventsResult.error.message}` },
        { status: 500 }
      );
    }

    const whatsappFailed = computeWhatsAppFailedForServices(whatsappEventsResult.data ?? []);

    return NextResponse.json({
      ok: true,
      date,
      header: {
        services_count: services.length,
        pax_total: paxTotal,
        drivers_in_use_count: driversInUse.size,
        buses_in_use_count: busesInUse.size,
      },
      assignable_unassigned: assignableUnassigned,
      agency_approvals_pending: agencyApprovalsPending,
      cancellation_requests_pending: cancellationRequestsPending,
      whatsapp_failed: { ...whatsappFailed, kind: WHATSAPP_CONTROL_CENTER_KIND },
      omitted_service_columns: omittedServiceColumns,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore Centro Operativo (extras)." },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handleControlCenterExtras(request);
}
