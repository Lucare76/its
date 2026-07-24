import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateSuggestions, type Suggestion, type SuggestionActionPayload } from "@/lib/operations-suggestions";
import type { Assignment, BusLotConfig, Hotel, Service } from "@/lib/types";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchAllServices } from "@/lib/server/fetch-all-services";

export const runtime = "nodejs";

const CACHE_MS = 20_000;

type CacheEntry = {
  expiresAt: number;
  suggestions: Suggestion[];
};

const cache = new Map<string, CacheEntry>();

const executeSchema = z.object({
  suggestion_id: z.string().min(3),
  suggestion_type: z.enum(["overcapacity", "geo_issue", "missing_data", "imbalance"]).optional(),
  action_payload: z.object({
    action: z.enum(["move_pax_between_buses", "open_service", "open_hotel", "mark_resolved"]),
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
    fetchAllServices(auth.admin, tenantId),
    auth.admin.from("assignments").select("*").eq("tenant_id", tenantId),
    auth.admin.from("hotels").select("*").eq("tenant_id", tenantId),
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
  payload: SuggestionActionPayload
) {
  const { error } = await auth.admin.from("operations_suggestions").upsert(
    {
      tenant_id: auth.membership.tenant_id,
      suggestion_id: suggestionId,
      type: suggestionType,
      action_payload: payload,
      resolved: true,
      resolved_at: new Date().toISOString(),
      resolved_by_user_id: auth.user.id
    },
    { onConflict: "tenant_id,suggestion_id" }
  );
  if (error) throw new Error(error.message);
}

async function executeMovePax(
  auth: Exclude<Awaited<ReturnType<typeof authorizePricingRequest>>, NextResponse>,
  payload: SuggestionActionPayload
) {
  if (!payload.from_bus_label || !payload.to_bus_label || !payload.pax) {
    throw new Error("Payload spostamento incompleto.");
  }

  const { services, assignments, busLotConfigs } = await loadState(auth);
  const activeServices = services.filter(isActiveService);
  const assignmentsByServiceId = new Map(assignments.map((assignment) => [assignment.service_id, assignment]));
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

  for (const service of selected) {
    const existing = assignmentsByServiceId.get(service.id);
    if (existing) {
      const { error } = await auth.admin
        .from("assignments")
        .update({ vehicle_label: payload.to_bus_label })
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
      continue;
    }

    const { error } = await auth.admin.from("assignments").insert({
      tenant_id: auth.membership.tenant_id,
      service_id: service.id,
      driver_user_id: null,
      vehicle_label: payload.to_bus_label
    });
    if (error) throw new Error(error.message);
  }

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

    if (payload.action === "move_pax_between_buses") {
      result = await executeMovePax(auth, payload);
    }

    await markResolved(auth, parsed.data.suggestion_id, parsed.data.suggestion_type ?? payload.action, payload);
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
