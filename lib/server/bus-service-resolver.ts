import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveBusFamily, deriveServiceBusIdentity, type BusLineFamilyCode } from "@/lib/server/bus-network";
import { resolveBusStop } from "@/lib/server/bus-lines-catalog";

type BusDirection = "arrival" | "departure";
type ResolverStatus = "ready" | "needs_review" | "blocked";
type MatchConfidence = "exact" | "alias" | "derived" | "manual" | "none";

type BusLineRow = {
  id: string;
  code: string | null;
  name: string | null;
  family_code: BusLineFamilyCode | string | null;
  family_name: string | null;
  active: boolean | null;
};

type BusStopRow = {
  id: string;
  bus_line_id: string;
  direction: BusDirection;
  stop_name: string;
  city: string | null;
  pickup_note: string | null;
  active: boolean | null;
};

type BusUnitRow = {
  id: string;
  bus_line_id: string;
  label: string | null;
  capacity: number | null;
  status: "open" | "low" | "closed" | "completed" | string | null;
  active: boolean | null;
  sort_order: number | null;
};

type BusAllocationRow = {
  service_id: string;
  bus_unit_id: string;
  pax_assigned: number | null;
};

type AllocatedServiceRow = {
  id: string;
  date: string | null;
  direction: BusDirection | string | null;
};

type HotelRow = {
  id: string;
  name: string;
  zone: string | null;
};

type FerryConfigRow = {
  bus_line_family_code: string | null;
  departure_port: string | null;
  arrival_port: string | null;
  departure_time: string | null;
};

export type BusResolverInput = {
  tenantId: string;
  date: string;
  direction: BusDirection;
  bookingServiceKind?: string | null;
  serviceTypeCode?: string | null;
  importCategory?: string | null;
  busCityOrigin?: string | null;
  transportCode?: string | null;
  lineName?: string | null;
  stopName?: string | null;
  hotelName?: string | null;
  hotelId?: string | null;
  pax: number;
  customerName?: string | null;
  phone?: string | null;
  agencyName?: string | null;
  notes?: string | null;
  time?: string | null;
};

export type BusAllocationPlan = {
  lineId: string;
  unitId: string;
  stopId: string;
  stopName: string;
  direction: BusDirection;
  pax: number;
  pendingPayload?: Record<string, unknown>;
};

export type BusResolverResult = {
  isBusService: boolean;
  status: ResolverStatus;
  reasons: string[];
  canonicalLine?: {
    familyCode: BusLineFamilyCode;
    lineId?: string;
    lineName?: string;
  };
  ferryBlock?: {
    departurePort?: string;
    arrivalPort?: string;
    departureTime?: string;
    arrivalTime?: string;
    source?: "bus_line_ferry_config" | "none";
  };
  stop?: {
    stopId?: string;
    stopName?: string;
    confidence: MatchConfidence;
  };
  hotel?: {
    hotelId?: string;
    hotelName?: string;
    zone?: string | null;
    confidence: "exact" | "alias" | "derived" | "none";
  };
  allocation?: {
    canAllocate: boolean;
    busUnitId?: string;
    remainingSeats?: number;
    reason?: string;
  };
  allocationPlan?: BusAllocationPlan;
  pendingPayload?: Record<string, unknown>;
};

export type BusResolverContext = {
  lines: BusLineRow[];
  stops: BusStopRow[];
  units: BusUnitRow[];
  allocations: BusAllocationRow[];
  allocatedServicesById: Map<string, AllocatedServiceRow>;
  hotels: HotelRow[];
  ferryConfigs: FerryConfigRow[];
  plannedAllocations: Array<{ busUnitId: string; date: string; direction: BusDirection; pax: number }>;
};

function normalizeBusText(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isBusCandidate(input: BusResolverInput) {
  const source = normalizeBusText([
    input.bookingServiceKind,
    input.serviceTypeCode,
    input.importCategory,
    input.lineName,
    input.transportCode,
    input.notes
  ].filter(Boolean).join(" "));
  return input.bookingServiceKind === "bus_city_hotel" ||
    input.serviceTypeCode === "bus_line" ||
    /\b(bus|linea bus|lineabus|transfer bus)\b/.test(source);
}

function familyFromText(value?: string | null): BusLineFamilyCode | null {
  const normalized = normalizeBusText(value);
  if (!normalized) return null;
  if (/\badriatica\b/.test(normalized)) return "ADRIATICA";
  if (/\bcentro\b/.test(normalized)) return "CENTRO";
  if (/\bitalia\b/.test(normalized)) return "ITALIA";
  if (/\blinea\s*11\b/.test(normalized)) return "ADRIATICA";
  if (/\blinea\s*7\b/.test(normalized)) return "CENTRO";
  return null;
}

function formatTime(value?: string | null) {
  const raw = String(value ?? "");
  return raw ? raw.slice(0, 5) : undefined;
}

function stopMatches(stop: BusStopRow, candidates: string[]) {
  const normalizedStop = normalizeBusText(stop.stop_name);
  const normalizedCity = normalizeBusText(stop.city);
  return candidates.some((candidate) => candidate && (candidate === normalizedStop || candidate === normalizedCity));
}

function findStop(context: BusResolverContext, input: BusResolverInput, line: BusLineRow | null) {
  if (!line?.id) return { confidence: "none" as const };
  const rawStop = input.stopName || input.busCityOrigin || "";
  const normalizedRaw = normalizeBusText(rawStop);
  const catalog = resolveBusStop(rawStop || input.transportCode || "");
  const candidates = [
    normalizedRaw,
    normalizeBusText(catalog?.canonicalCity)
  ].filter(Boolean);

  const eligibleStops = context.stops.filter((stop) =>
    stop.active !== false &&
    stop.bus_line_id === line.id &&
    stop.direction === input.direction
  );
  const exact = eligibleStops.find((stop) => stopMatches(stop, [normalizedRaw]));
  if (exact) {
    return { stop: exact, confidence: "exact" as const };
  }
  const derived = eligibleStops.find((stop) => stopMatches(stop, candidates));
  if (derived) {
    return { stop: derived, confidence: catalog ? "derived" as const : "alias" as const };
  }
  return { confidence: "none" as const };
}

function findHotel(context: BusResolverContext, input: BusResolverInput) {
  if (input.hotelId) {
    const byId = context.hotels.find((hotel) => hotel.id === input.hotelId);
    if (byId) return { hotel: byId, confidence: "exact" as const };
  }
  const normalized = normalizeBusText(input.hotelName);
  if (!normalized) return { confidence: "none" as const };
  const exact = context.hotels.find((hotel) => normalizeBusText(hotel.name) === normalized);
  if (exact) return { hotel: exact, confidence: "exact" as const };
  const fuzzy = context.hotels.find((hotel) => {
    const hay = normalizeBusText(hotel.name);
    return hay.includes(normalized) || normalized.includes(hay);
  });
  if (fuzzy) return { hotel: fuzzy, confidence: "derived" as const };
  return { confidence: "none" as const };
}

function allocatedPaxForUnit(context: BusResolverContext, busUnitId: string, date: string) {
  let pax = 0;
  for (const allocation of context.allocations) {
    if (allocation.bus_unit_id !== busUnitId) continue;
    const service = context.allocatedServicesById.get(allocation.service_id);
    if (service?.date === date) {
      pax += allocation.pax_assigned ?? 0;
    }
  }
  for (const planned of context.plannedAllocations) {
    if (planned.busUnitId === busUnitId && planned.date === date) {
      pax += planned.pax;
    }
  }
  return pax;
}

function buildPendingPayload(input: BusResolverInput, line: BusLineRow | null, stopName: string | null, reasons: string[]) {
  if (!line?.id) return null;
  return {
    bus_line_id: line.id,
    direction: input.direction,
    travel_date: input.date,
    passenger_name: input.customerName || "Cliente da verificare",
    passenger_phone: input.phone || null,
    city_original: input.stopName || input.busCityOrigin || input.lineName || input.transportCode || "Fermata da verificare",
    pax: input.pax,
    notes: [input.notes, input.agencyName ? `Agenzia: ${input.agencyName}` : "", reasons.length ? `Resolver bus: ${reasons.join("; ")}` : ""]
      .filter(Boolean)
      .join(" | ") || null,
    geo_suggested_stop: stopName
  };
}

export async function loadBusResolverContext(
  admin: SupabaseClient,
  tenantId: string
): Promise<BusResolverContext> {
  const [linesResult, stopsResult, unitsResult, allocationsResult, hotelsResult, ferryResult] = await Promise.all([
    admin.from("tenant_bus_lines").select("id,code,name,family_code,family_name,active").eq("tenant_id", tenantId),
    admin.from("tenant_bus_line_stops").select("id,bus_line_id,direction,stop_name,city,pickup_note,active").eq("tenant_id", tenantId),
    admin.from("tenant_bus_units").select("id,bus_line_id,label,capacity,status,active,sort_order").eq("tenant_id", tenantId).order("sort_order"),
    admin.from("tenant_bus_allocations").select("service_id,bus_unit_id,pax_assigned").eq("tenant_id", tenantId),
    admin.from("hotels").select("id,name,zone").eq("tenant_id", tenantId),
    admin.from("bus_line_ferry_config").select("bus_line_family_code,departure_port,arrival_port,departure_time").eq("tenant_id", tenantId)
  ]);

  const error = linesResult.error || stopsResult.error || unitsResult.error || allocationsResult.error || hotelsResult.error || ferryResult.error;
  if (error) throw new Error(error.message);

  const allocations = (allocationsResult.data ?? []) as BusAllocationRow[];
  const serviceIds = [...new Set(allocations.map((row) => row.service_id).filter(Boolean))];
  let allocatedServices: AllocatedServiceRow[] = [];
  if (serviceIds.length > 0) {
    const servicesResult = await admin
      .from("services")
      .select("id,date,direction")
      .eq("tenant_id", tenantId)
      .in("id", serviceIds);
    if (servicesResult.error) throw new Error(servicesResult.error.message);
    allocatedServices = (servicesResult.data ?? []) as AllocatedServiceRow[];
  }

  return {
    lines: (linesResult.data ?? []) as BusLineRow[],
    stops: (stopsResult.data ?? []) as BusStopRow[],
    units: (unitsResult.data ?? []) as BusUnitRow[],
    allocations,
    allocatedServicesById: new Map(allocatedServices.map((service) => [service.id, service])),
    hotels: (hotelsResult.data ?? []) as HotelRow[],
    ferryConfigs: (ferryResult.data ?? []) as FerryConfigRow[],
    plannedAllocations: []
  };
}

export function registerBusResolverAllocation(
  context: BusResolverContext,
  allocation: { busUnitId: string; date: string; direction: BusDirection; pax: number }
) {
  context.plannedAllocations.push(allocation);
}

export function resolveBusImportRow(context: BusResolverContext, input: BusResolverInput): BusResolverResult {
  if (!isBusCandidate(input)) {
    return { isBusService: false, status: "blocked", reasons: ["Riga non riconosciuta come servizio bus."] };
  }

  const reasons: string[] = [];
  const explicitFamily =
    familyFromText(input.lineName) ??
    familyFromText(input.transportCode) ??
    familyFromText(input.importCategory);
  const catalogFamily = resolveBusStop(input.stopName || input.busCityOrigin || input.transportCode || "")?.familyCode ?? null;
  const identity = deriveServiceBusIdentity({
    transport_code: input.transportCode ?? explicitFamily ?? null,
    bus_city_origin: input.busCityOrigin ?? input.stopName ?? null,
    outbound_time: null,
    time: input.time ?? "",
    service_type_code: input.serviceTypeCode as never,
    booking_service_kind: input.bookingServiceKind as never
  });
  const familyCode = explicitFamily ?? catalogFamily ?? (input.transportCode ? identity.family_code : null);
  if (!familyCode) {
    return {
      isBusService: true,
      status: "blocked",
      reasons: ["Linea bus mancante o non deducibile: indicare Italia, Centro o Adriatica."]
    };
  }
  const line = context.lines.find((candidate) =>
    candidate.active !== false && String(candidate.family_code ?? "").toUpperCase() === familyCode
  ) ?? null;

  if (!line) {
    return {
      isBusService: true,
      status: "blocked",
      reasons: [`Linea bus non riconosciuta o non configurata: ${familyCode || input.lineName || input.transportCode || "vuota"}.`],
      canonicalLine: { familyCode }
    };
  }

  const ferry = context.ferryConfigs.find((config) => normalizeBusText(config.bus_line_family_code) === familyCode.toLowerCase());
  const stopMatch = findStop(context, input, line);
  if (!stopMatch.stop) reasons.push(`Fermata non trovata per la linea ${line.name ?? familyCode}: ${input.stopName || input.busCityOrigin || "vuota"}.`);

  const hotelMatch = findHotel(context, input);
  if (!hotelMatch.hotel) {
    reasons.push(`Hotel non trovato nel catalogo: ${input.hotelName || input.hotelId || "vuoto"}.`);
  } else if (!hotelMatch.hotel.zone) {
    reasons.push(`Zona hotel mancante: ${hotelMatch.hotel.name}.`);
  }

  const units = context.units
    .filter((unit) => unit.active !== false && unit.bus_line_id === line.id && unit.status !== "closed" && unit.status !== "completed")
    .sort((left, right) => (left.sort_order ?? 999) - (right.sort_order ?? 999));
  const unitCandidates = units.map((unit) => {
    const capacity = unit.capacity ?? 0;
    const assigned = allocatedPaxForUnit(context, unit.id, input.date);
    return { unit, remaining: Math.max(0, capacity - assigned) };
  });
  const selectedUnit = unitCandidates.find((candidate) => candidate.remaining >= input.pax);
  if (!selectedUnit) {
    reasons.push(units.length > 0 ? "Capienza non sufficiente sui bus aperti della linea per questa data." : "Nessun bus aperto configurato per la linea.");
  }

  const pendingPayload = buildPendingPayload(input, line, stopMatch.stop?.stop_name ?? null, reasons);
  const base: Omit<BusResolverResult, "status"> = {
    isBusService: true,
    reasons,
    canonicalLine: {
      familyCode,
      lineId: line.id,
      lineName: line.name ?? undefined
    },
    ferryBlock: {
      departurePort: ferry?.departure_port ?? undefined,
      arrivalPort: ferry?.arrival_port ?? undefined,
      departureTime: formatTime(ferry?.departure_time),
      source: ferry ? "bus_line_ferry_config" : "none"
    },
    stop: {
      stopId: stopMatch.stop?.id,
      stopName: stopMatch.stop?.stop_name,
      confidence: stopMatch.confidence
    },
    hotel: {
      hotelId: hotelMatch.hotel?.id,
      hotelName: hotelMatch.hotel?.name,
      zone: hotelMatch.hotel?.zone,
      confidence: hotelMatch.confidence
    },
    allocation: {
      canAllocate: Boolean(selectedUnit && stopMatch.stop && hotelMatch.hotel && hotelMatch.hotel.zone),
      busUnitId: selectedUnit?.unit.id,
      remainingSeats: selectedUnit?.remaining,
      reason: selectedUnit ? undefined : reasons[reasons.length - 1]
    },
    pendingPayload: pendingPayload ?? undefined
  };

  if (base.allocation?.canAllocate && stopMatch.stop && selectedUnit) {
    return {
      ...base,
      status: "ready",
      allocationPlan: {
        lineId: line.id,
        unitId: selectedUnit.unit.id,
        stopId: stopMatch.stop.id,
        stopName: stopMatch.stop.stop_name,
        direction: input.direction,
        pax: input.pax,
        pendingPayload: pendingPayload ?? undefined
      }
    };
  }

  return { ...base, status: "needs_review" };
}
