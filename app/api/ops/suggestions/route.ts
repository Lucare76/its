import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { generateSuggestions, type Suggestion, type SuggestionActionPayload } from "@/lib/operations-suggestions";
import type { Assignment, BusLotConfig, Hotel, Service } from "@/lib/types";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { extractFeatures, logAssignmentChange, type AssignmentHistoryEntry } from "@/lib/server/assignment-history";
import { updateLearnedPatterns } from "@/lib/server/learned-patterns";
import { effectiveServiceDisembarkTime } from "@/lib/piano-arrival-time";

export const runtime = "nodejs";

// Sprint Performance 14F: client polls every 30s (see
// components/operations-suggestions.tsx). Cache TTL must be >= that interval
// or every single tick is a guaranteed miss (the old 20s TTL was shorter than
// the 30s poll, so it almost never actually absorbed a tick). 45s — the upper
// end of "30-45s" — keeps at most 2 polls stale before a recompute, which is
// well within the advisory (non-real-time-critical) freshness this panel
// needs, while roughly halving actual recomputes versus the old value.
const CACHE_MS = 45_000;

type CacheEntry = {
  expiresAt: number;
  suggestions: Suggestion[];
};

const cache = new Map<string, CacheEntry>();

const SERVICE_QUERY_PAGE = 1000;

/**
 * Sprint Performance 14F. Both consumers of `state.services` in this module —
 * generateSuggestions() (via buildBuses()'s isActiveService(s) and the
 * top-level activeServices = filter(s => isActiveService(s, horizon))) and
 * this file's own executeMovePax() (services.filter(isActiveService), same
 * 3-condition predicate) — ALWAYS apply the identical
 * `status !== "cancelled" && status !== "completato" && is_draft !== true`
 * filter before ever reading a service. Neither ever reads the raw,
 * unfiltered array. Pushing that exact predicate into the query is therefore
 * provably equivalent to fetchAllServices() + isActiveService() — never a new
 * business rule, never a date window (see
 * tests/unit/operations-suggestions-parity.test.ts for the proof). `IS NOT
 * TRUE` (not `<> true`) is required so NULL/undefined is_draft — "not a
 * draft" per the JS `!== true` check — isn't wrongly excluded by SQL's NULL
 * comparison semantics.
 */
async function fetchActiveServicesForSuggestions(admin: SupabaseClient, tenantId: string): Promise<{ data: Service[] | null; error: { message: string } | null }> {
  const all: Service[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("services")
      .select("*")
      .eq("tenant_id", tenantId)
      .not("status", "in", "(cancelled,completato)")
      .not("is_draft", "is", true)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + SERVICE_QUERY_PAGE - 1);
    if (error) return { data: null, error };
    if (data) all.push(...(data as Service[]));
    if (!data || data.length < SERVICE_QUERY_PAGE) break;
    from += SERVICE_QUERY_PAGE;
  }
  return { data: all, error: null };
}

const executeSchema = z.object({
  suggestion_id: z.string().min(3),
  suggestion_type: z.enum(["overcapacity", "geo_issue", "missing_data", "imbalance"]).optional(),
  resolution_note: z.string().trim().max(500).optional(),
  action_payload: z.object({
    action: z.enum(["move_pax_between_buses", "open_service", "open_hotel", "mark_resolved", "restore"]),
    from_bus_id: z.string().optional(),
    from_bus_label: z.string().optional(),
    to_bus_id: z.string().optional(),
    to_bus_label: z.string().optional(),
    pax: z.number().int().min(1).max(120).optional(),
    service_id: z.string().optional(),
    hotel_id: z.string().optional(),
    date: z.string().optional(),
    direction: z.enum(["arrival", "departure"]).optional()
  })
});

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function isActiveService(service: Service) {
  return service.status !== "cancelled" && service.status !== "completato" && service.is_draft !== true;
}

function movePaxOperationalTime(service: Service): string {
  if (service.direction === "departure") return (service.time ?? "").slice(0, 5);
  return effectiveServiceDisembarkTime(service) ?? (service.time ?? "").slice(0, 5);
}

function isNavettaService(service: Pick<Service, "booking_service_kind" | "service_type_code">): boolean {
  const kind = service.booking_service_kind ?? service.service_type_code ?? "";
  return kind === "navetta" || kind === "shuttle_hotel" || kind === "bus_city_hotel";
}

function matchesBusLot(service: Service, lot: BusLotConfig) {
  if (service.date !== lot.service_date || service.direction !== lot.direction) return false;
  if (lot.billing_party_name && normalize(service.billing_party_name) !== normalize(lot.billing_party_name)) return false;
  if (lot.bus_city_origin && normalize(service.bus_city_origin) !== normalize(lot.bus_city_origin)) return false;
  if (lot.transport_code && normalize(service.transport_code) !== normalize(lot.transport_code)) return false;
  return service.service_type_code === "bus_line" || service.booking_service_kind === "bus_city_hotel";
}

async function readResolvedIds(auth: Awaited<ReturnType<typeof authorizePricingRequest>>) {
  if (auth instanceof NextResponse) return new Set<string>();
  const result = await auth.admin
    .from("operations_suggestions")
    .select("suggestion_id")
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("resolved", true);

  if (result.error) return new Set<string>();
  return new Set((result.data ?? []).map((row: { suggestion_id: string }) => row.suggestion_id));
}

async function loadState(auth: Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>) {
  const tenantId = auth.membership.tenant_id;
  const [servicesResult, assignmentsResult, hotelsResult, busLotConfigsResult] = await Promise.all([
    fetchActiveServicesForSuggestions(auth.admin, tenantId),
    // Sprint 14F: minimal columns — buildBuses()/executeMovePax() only ever
    // read id, service_id, vehicle_label, group_id (and `id` to target an
    // update). Verified via full read of lib/operations-suggestions.ts and
    // this file's executeMovePax().
    auth.admin.from("assignments").select("id, tenant_id, service_id, vehicle_label, group_id").eq("tenant_id", tenantId),
    // Sprint 14F: minimal columns — id/name/geo_status read directly by
    // generateSuggestions(), the rest (address, zone, lat, lng, geo_source,
    // geo_accuracy, geo_verified_at) are exactly what hotelGeoQuality() reads
    // (lib/hotel-geocoding.ts). Verified via full read of both functions.
    auth.admin
      .from("hotels")
      .select("id, name, address, zone, lat, lng, geo_status, geo_source, geo_accuracy, geo_verified_at")
      .eq("tenant_id", tenantId),
    auth.admin.from("bus_lot_configs").select("*").eq("tenant_id", tenantId)
  ]);

  const error = servicesResult.error ?? assignmentsResult.error ?? hotelsResult.error;
  if (error) throw new Error(error.message);

  return {
    services: (servicesResult.data ?? []) as Service[],
    assignments: (assignmentsResult.data ?? []) as Assignment[],
    hotels: (hotelsResult.data ?? []) as Hotel[],
    busLotConfigs: ((busLotConfigsResult.error ? [] : busLotConfigsResult.data) ?? []) as BusLotConfig[]
  };
}

async function markResolved(
  auth: Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>,
  suggestionId: string,
  suggestionType: string,
  payload: SuggestionActionPayload,
  resolutionNote?: string | null
) {
  const operatorName = await getOperatorName(auth);
  const baseRow = {
    tenant_id: auth.membership.tenant_id,
    suggestion_id: suggestionId,
    type: suggestionType,
    action_payload: payload,
    resolved: true,
    resolved_at: new Date().toISOString(),
    resolved_by_user_id: auth.user.id
  };
  const { error } = await auth.admin.from("operations_suggestions").upsert(
    {
      ...baseRow,
      resolved_by_name: operatorName,
      resolution_note: resolutionNote?.trim() || null,
      restored_at: null,
      restored_by_user_id: null,
      restored_by_name: null,
      restore_note: null
    },
    { onConflict: "tenant_id,suggestion_id" }
  );
  if (error && /column .* does not exist|schema cache/i.test(error.message)) {
    const retry = await auth.admin.from("operations_suggestions").upsert(baseRow, { onConflict: "tenant_id,suggestion_id" });
    if (retry.error) throw new Error(retry.error.message);
    return;
  }
  if (error) throw new Error(error.message);
}

async function getOperatorName(auth: Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>) {
  const { data } = await auth.admin
    .from("memberships")
    .select("full_name")
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  return String(data?.full_name ?? auth.user.email ?? "Operatore").trim() || "Operatore";
}

async function restoreSuggestion(
  auth: Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>,
  suggestionId: string,
  restoreNote?: string | null
) {
  const operatorName = await getOperatorName(auth);
  const { error } = await auth.admin
    .from("operations_suggestions")
    .update({
      resolved: false,
      restored_at: new Date().toISOString(),
      restored_by_user_id: auth.user.id,
      restored_by_name: operatorName,
      restore_note: restoreNote?.trim() || null
    })
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("suggestion_id", suggestionId);
  if (error && /column .* does not exist|schema cache/i.test(error.message)) {
    const retry = await auth.admin
      .from("operations_suggestions")
      .update({ resolved: false })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("suggestion_id", suggestionId);
    if (retry.error) throw new Error(retry.error.message);
    return;
  }
  if (error) throw new Error(error.message);
}

async function executeMovePax(
  auth: Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>,
  payload: SuggestionActionPayload
) {
  if (!payload.from_bus_label || !payload.to_bus_label || !payload.pax) {
    throw new Error("Payload spostamento incompleto.");
  }

  const tenantId = auth.membership.tenant_id;
  const { services, assignments, hotels, busLotConfigs } = await loadState(auth);
  const activeServices = services.filter(isActiveService);
  const assignmentsByServiceId = new Map(assignments.map((assignment) => [assignment.service_id, assignment]));
  const hotelsById = new Map(hotels.map((hotel) => [hotel.id, hotel]));
  const fromBusLot = busLotConfigs.find((lot) => lot.id === payload.from_bus_id) ?? null;

  const candidates = activeServices
    .filter((service) => {
      if (payload.date && service.date !== payload.date) return false;
      if (payload.direction && service.direction !== payload.direction) return false;
      if (fromBusLot) return matchesBusLot(service, fromBusLot);
      if (payload.from_bus_id === service.id) return true;
      return normalize(assignmentsByServiceId.get(service.id)?.vehicle_label) === normalize(payload.from_bus_label);
    })
    .filter((service) => normalize(assignmentsByServiceId.get(service.id)?.vehicle_label) !== normalize(payload.to_bus_label))
    .sort((a, b) => (b.pax ?? 0) - (a.pax ?? 0));

  const selected: Service[] = [];
  let movedPax = 0;
  for (const service of candidates) {
    if (movedPax >= payload.pax) break;
    selected.push(service);
    movedPax += service.pax ?? 0;
  }

  if (selected.length === 0) {
    throw new Error("Nessun servizio compatibile da spostare.");
  }

  // CONC-07: previous vehicle_label/group_id già disponibili in
  // assignmentsByServiceId, caricato prima di qualunque mutazione — nessuna
  // query aggiuntiva necessaria. Riusa il contratto già validato in
  // move_services/swap_vehicle: changeType "vehicle_binding" (qui il driver
  // non viene mai toccato, quindi mai "driver_swap"), un entry al massimo per
  // service_id, history costruita solo dopo la mutazione riuscita per quel
  // servizio.
  const toVehicleLabel = payload.to_bus_label;
  const historyEntries: AssignmentHistoryEntry[] = [];

  // CONC-07 (rischio residuo): il flush di historyEntries deve avvenire anche
  // se un servizio successivo del batch fallisce a metà loop — altrimenti le
  // mutazioni già persistite con successo (service precedenti) restano senza
  // storico perché il throw usciva dalla funzione prima di raggiungere il
  // flush unico di fine loop. Un solo punto di flush esegue per invocazione:
  // o quello di fine try (tutti i servizi riusciti) o quello nel catch (solo
  // le entry già committed prima del fallimento) — mai entrambi, quindi zero
  // doppio evento. L'errore originale della mutazione DB viene sempre
  // ripropagato invariato dopo il flush best-effort.
  const flushHistory = () => {
    if (historyEntries.length === 0) return;
    void logAssignmentChange(auth.admin, historyEntries)
      .then(() => updateLearnedPatterns(auth.admin, tenantId))
      .catch(() => undefined);
  };

  try {
    for (const service of selected) {
      const existing = assignmentsByServiceId.get(service.id);
      const prevVehicleLabel = existing?.vehicle_label ?? null;
      const prevGroupId = existing?.group_id ?? null;

      if (existing) {
        const { error } = await auth.admin
          .from("assignments")
          .update({ vehicle_label: toVehicleLabel })
          .eq("tenant_id", tenantId)
          .eq("id", existing.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await auth.admin.from("assignments").insert({
          tenant_id: tenantId,
          service_id: service.id,
          driver_user_id: null,
          vehicle_label: toVehicleLabel
        });
        if (error) throw new Error(error.message);
      }

      if (prevVehicleLabel !== toVehicleLabel) {
        const hotel = service.hotel_id ? hotelsById.get(service.hotel_id) : null;
        const features = extractFeatures({
          serviceDate: service.date,
          changeType: "vehicle_binding",
          fromVehicleLabel: prevVehicleLabel,
          toVehicleLabel,
          direction: service.direction ?? null,
          zone: hotel?.zone ?? service.meeting_point ?? null,
          time: movePaxOperationalTime(service),
          vessel: service.vessel ?? service.barca_compagnia ?? null,
          pax: service.pax ?? null,
          isNavetta: isNavettaService(service)
        });
        historyEntries.push({
          tenantId,
          serviceDate: service.date,
          serviceId: service.id,
          groupId: prevGroupId,
          changeType: "vehicle_binding",
          fromVehicleLabel: prevVehicleLabel,
          toVehicleLabel,
          features,
          operatorId: auth.user.id
        });
      }
    }
  } catch (err) {
    flushHistory();
    throw err;
  }

  flushHistory();

  return { moved_services: selected.length, moved_pax: movedPax };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const cacheKey = `${auth.membership.tenant_id}:static`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return NextResponse.json({ ok: true, cached: true, suggestions: hit.suggestions });
    }

    const [state, resolvedSuggestionIds] = await Promise.all([loadState(auth), readResolvedIds(auth)]);
    const suggestions = generateSuggestions({ ...state, resolvedSuggestionIds });

    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_MS, suggestions });
    return NextResponse.json({ ok: true, cached: false, suggestions });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore suggerimenti" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const parsed = executeSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Payload non valido", issues: parsed.error.flatten() }, { status: 400 });
    }

    const payload = parsed.data.action_payload;
    let result: Record<string, unknown> = {};

    if (payload.action === "restore") {
      await restoreSuggestion(auth, parsed.data.suggestion_id, parsed.data.resolution_note);
      for (const key of cache.keys()) {
        if (key.startsWith(`${auth.membership.tenant_id}:`)) cache.delete(key);
      }
      return NextResponse.json({ ok: true, resolved: false, restored: true });
    }

    if (payload.action === "move_pax_between_buses") {
      result = await executeMovePax(auth, payload);
    }

    await markResolved(auth, parsed.data.suggestion_id, parsed.data.suggestion_type ?? payload.action, payload, parsed.data.resolution_note);
    for (const key of cache.keys()) {
      if (key.startsWith(`${auth.membership.tenant_id}:`)) cache.delete(key);
    }

    return NextResponse.json({ ok: true, resolved: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Azione suggerimento fallita" },
      { status: 500 }
    );
  }
}
