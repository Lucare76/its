/**
 * POST /api/ops/piano-giorno/auto-assign
 * Genera automaticamente i giri del Piano del Giorno.
 *
 * Body: { date: string, mode: "unassigned_only" | "regenerate_all" }
 *
 * Algoritmo arrivi:
 *   - Raggruppa per corsa traghetto (vessel+time)
 *   - Cluster per zona hotel → area nordovest/estsud in base al porto di arrivo
 *   - Split batch se pax > max capienza veicoli disponibili
 *
 * Algoritmo partenze:
 *   - Protegge i blocchi "stesso hotel + stesso pickup + stesso porto"
 *   - Consente merge tra blocchi diversi solo se il mezzo li assorbe senza spezzare un blocco
 *   - Non spezza automaticamente un hotel con stesso pickup
 *
 * Regole comuni:
 *   - Autisti assegnati per punteggio: no-conflitto orario (75 min) > stessa zona > minor carico
 *   - Mezzo più piccolo che soddisfa i PAX del giro
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { hotelGeoQuality, inferZoneFromText } from "@/lib/hotel-geocoding";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { loadVehicleCommitmentsForDate } from "@/lib/server/vehicle-commitments";
import {
  strongestGeographicResult,
  validateGeographicCompatibility,
  zoneToGeoArea,
  type GeographicCompatibilityService,
} from "@/lib/server/geo-assignment";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// ─── Mapping zona → area geografica ──────────────────────────────────────────

function zoneArea(zone: string | null): "nordovest" | "estsud" | "unknown" {
  const z = (zone ?? "").toLowerCase();
  if (!z) return "unknown";
  if (z.includes("ischia") || z.includes("barano") || z.includes("testaccio")) return "estsud";
  if (
    z.includes("forio") || z.includes("lacco") || z.includes("casamicciola") ||
    z.includes("sant") || z.includes("serrara") || z.includes("panza") ||
    z.includes("cuotto") || z.includes("citara")
  ) return "nordovest";
  return "unknown";
}

function normalizedPlace(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function operationalZoneFromText(value: string | null | undefined): string | null {
  const text = normalizedPlace(value);
  if (!text) return null;
  if (text.includes("san nicola") || text.includes("parroco d abundo") || text.includes("panza")) return "Forio";
  if (text.includes("mortella") || text === "la villa" || text.includes("hotel la villa")) return "Forio";
  if (text.includes("nitrodi")) return "Barano";
  if (text.includes("sant angelo")) return "Serrara Fontana";
  if (text.includes("casamicciola")) return "Casamicciola";
  if (text.includes("lacco")) return "Lacco Ameno";
  if (text.includes("forio")) return "Forio";
  if (
    text.includes("ischia") ||
    text.includes("piazzale trieste") ||
    text.includes("caffe del direttore") ||
    text.includes("president") ||
    text.includes("parco aurora") ||
    text.includes("re ferdinando") ||
    text.includes("felix") ||
    text.includes("cristallo")
  ) return "Ischia Porto";
  return inferZoneFromText(value ?? "");
}

function hotelOperationalZone(hotel: HotelRow | undefined) {
  if (!hotel) return null;
  const knownOperationalZone = operationalZoneFromText([hotel.name, hotel.address].filter(Boolean).join(" "));
  return knownOperationalZone
    ?? inferZoneFromText(hotel.zone ?? "")
    ?? operationalZoneFromText(hotel.address)
    ?? operationalZoneFromText(hotel.name);
}

function serviceOperationalZone(service: ServiceRow, hotelMap: Map<string, HotelRow>) {
  const hotel = service.hotel_id ? hotelMap.get(service.hotel_id) : undefined;
  return hotelOperationalZone(hotel)
    ?? operationalZoneFromText(service.meeting_point);
}

function hasUsableOperationalPosition(service: ServiceRow, hotelMap: Map<string, HotelRow>) {
  const hotel = service.hotel_id ? hotelMap.get(service.hotel_id) : undefined;
  if (!hotel) return Boolean(serviceOperationalZone(service, hotelMap));
  const quality = hotelGeoQuality(hotel);
  if (quality.routeUsable) return true;
  return Boolean(hotelOperationalZone(hotel) && (hotel.address || hotel.name));
}

function portPriority(meetingPoint: string | null): "nordovest" | "estsud" {
  return (meetingPoint ?? "").toLowerCase().includes("casamicciola") ? "nordovest" : "estsud";
}

function timeToMin(t: string): number {
  const parts = (t ?? "").split(":");
  return (parseInt(parts[0] ?? "0", 10)) * 60 + (parseInt(parts[1] ?? "0", 10));
}

const PORT_COORDS: Record<string, { lat: number; lng: number }> = {
  casamicciola: { lat: 40.7507, lng: 13.9013 },
  "ischia porto": { lat: 40.7329, lng: 13.9477 },
  ischia: { lat: 40.7329, lng: 13.9477 },
  forio: { lat: 40.7355, lng: 13.8675 },
  "lacco ameno": { lat: 40.7580, lng: 13.8887 },
};

function cleanPortName(value: string | null | undefined): string {
  const raw = (value ?? "").toLowerCase();
  if (raw.includes("casamicciola")) return "Casamicciola";
  if (raw.includes("forio")) return "Forio";
  if (raw.includes("lacco")) return "Lacco Ameno";
  if (raw.includes("ischia porto") || raw.includes("uscita arrivi") || raw.includes("ischia")) return "Ischia Porto";
  return value ?? "";
}

function portCoords(value: string | null | undefined): { lat: number; lng: number } {
  const normalized = cleanPortName(value).toLowerCase();
  for (const [key, coords] of Object.entries(PORT_COORDS)) {
    if (normalized.includes(key)) return coords;
  }
  return PORT_COORDS["ischia porto"]!;
}

function distanceScore(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dLat = a.lat - b.lat;
  const dLng = a.lng - b.lng;
  return dLat * dLat + dLng * dLng;
}

function hotelCoords(hotel: HotelRow | undefined): { lat: number; lng: number } | null {
  if (!hotel) return null;
  const quality = hotelGeoQuality(hotel);
  if (!quality.routeUsable || hotel.lat == null || hotel.lng == null) return null;
  return { lat: hotel.lat, lng: hotel.lng };
}

function routeSort(
  services: ServiceRow[],
  hotelMap: Map<string, HotelRow>,
  start: { lat: number; lng: number },
  direction: "arrival" | "departure"
): ServiceRow[] {
  const withCoords = services.filter((svc) => hotelCoords(hotelMap.get(svc.hotel_id ?? "")));
  const withoutCoords = services.filter((svc) => !hotelCoords(hotelMap.get(svc.hotel_id ?? "")))
    .sort((a, b) => b.pax - a.pax);

  if (direction === "departure") {
    return [
      ...withCoords.sort((a, b) => {
        const aCoords = hotelCoords(hotelMap.get(a.hotel_id ?? ""))!;
        const bCoords = hotelCoords(hotelMap.get(b.hotel_id ?? ""))!;
        return distanceScore(bCoords, start) - distanceScore(aCoords, start);
      }),
      ...withoutCoords,
    ];
  }

  const remaining = [...withCoords];
  const sorted: ServiceRow[] = [];
  let current = start;
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const coords = hotelCoords(hotelMap.get(remaining[i]!.hotel_id ?? ""))!;
      const distance = distanceScore(current, coords);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    const next = remaining.splice(bestIndex, 1)[0]!;
    sorted.push(next);
    current = hotelCoords(hotelMap.get(next.hotel_id ?? "")) ?? current;
  }

  return [...sorted, ...withoutCoords];
}

// Suddivide servizi in batch senza mai eccedere capMax pax per batch
function batchByCapacity(
  services: Array<{ id: string; pax: number }>,
  capMax: number
): Array<Array<{ id: string; pax: number }>> {
  if (!capMax || capMax <= 0) return [services];
  const batches: Array<Array<{ id: string; pax: number }>> = [];
  let current: Array<{ id: string; pax: number }> = [];
  let currentPax = 0;
  for (const svc of services) {
    if (currentPax + svc.pax > capMax && current.length > 0) {
      batches.push(current);
      current = [];
      currentPax = 0;
    }
    current.push(svc);
    currentPax += svc.pax;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const ARRIVAL_MERGE_WINDOW_MINUTES = 25;
const DEPARTURE_SAME_HOTEL_MERGE_WINDOW_MINUTES = 30;
const MIN_VEHICLE_CHANGE_MINUTES = 20;
const MIN_SAME_VEHICLE_REUSE_MINUTES = 20;

function arrivalMergeKey(service: ServiceRow): string {
  const port = cleanPortName(service.meeting_point) || "Ischia Porto";
  return `${port.toLowerCase()}|${Math.floor(timeToMin(service.time) / ARRIVAL_MERGE_WINDOW_MINUTES)}`;
}

function departureBaseGroupKey(service: ServiceRow, hotelMap: Map<string, HotelRow>): string {
  const hotelKey = service.hotel_id ?? `zone:${serviceOperationalZone(service, hotelMap) ?? "Sconosciuto"}`;
  const pickup = (service.pickup_hotel ?? service.time).slice(0, 5);
  const port = cleanPortName(service.meeting_point) || "Imbarco da verificare";
  return `${hotelKey}|${pickup}|${port.toLowerCase()}`;
}

function isNavettaService(service: ServiceRow) {
  const kind = service.booking_service_kind ?? service.service_type_code ?? "";
  return kind === "navetta" || kind === "shuttle_hotel" || kind === "bus_city_hotel";
}

function shuttlePairKey(service: ServiceRow) {
  return service.hotel_id
    ? `hotel:${service.hotel_id}`
    : `customer:${normalizedPlace(service.customer_name)}|point:${normalizedPlace(service.meeting_point)}`;
}

function buildShuttlePairDrafts(services: ServiceRow[], hotelMap: Map<string, HotelRow>) {
  const drafts: TripDraft[] = [];
  const pairedIds = new Set<string>();
  const byKey = new Map<string, ServiceRow[]>();

  for (const service of services) {
    if (!isNavettaService(service)) continue;
    const key = shuttlePairKey(service);
    byKey.set(key, [...(byKey.get(key) ?? []), service]);
  }

  for (const group of byKey.values()) {
    const departures = group
      .filter((service) => service.direction === "departure")
      .sort((a, b) => serviceOperationalTime(a).localeCompare(serviceOperationalTime(b)));
    const arrivals = group
      .filter((service) => service.direction === "arrival")
      .sort((a, b) => serviceOperationalTime(a).localeCompare(serviceOperationalTime(b)));

    for (const departure of departures) {
      if (pairedIds.has(departure.id)) continue;
      const depMin = timeToMin(serviceOperationalTime(departure));
      const arrival = arrivals.find((candidate) => {
        if (pairedIds.has(candidate.id)) return false;
        const diff = timeToMin(serviceOperationalTime(candidate)) - depMin;
        return diff >= 0 && diff <= 10;
      });
      if (!arrival) continue;

      pairedIds.add(departure.id);
      pairedIds.add(arrival.id);
      drafts.push({
        serviceIds: [departure.id, arrival.id],
        pax: departure.pax + arrival.pax,
        time: serviceOperationalTime(departure),
        direction: "arrival",
        zoneLabel: serviceOperationalZone(arrival, hotelMap)
          ?? serviceOperationalZone(departure, hotelMap)
          ?? "Sconosciuto",
      });
    }
  }

  return { drafts, pairedIds };
}

// ─── Tipi interni ─────────────────────────────────────────────────────────────

type ServiceRow = {
  id: string; time: string; direction: "arrival" | "departure";
  vessel: string | null; hotel_id: string | null; pax: number;
  status: string; meeting_point: string | null; pickup_hotel: string | null;
  customer_name: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
};
type HotelRow = {
  id: string;
  name: string | null;
  address: string | null;
  zone: string | null;
  lat: number | null;
  lng: number | null;
  geo_status: string | null;
  geo_source: string | null;
  geo_accuracy: string | null;
  geo_verified_at: string | null;
};
type VehicleRow = { id: string; label: string; capacity: number | null };
type DriverRow = { profile_id: string; user_id: string | null; full_name: string };
type DriverVehicleEvent = { time: number; vehicleLabel: string | null };
type VehicleEvent = { time: number; driverProfileId: string | null };

// Verifica se un veicolo è disponibile in un certo orario tenendo conto dei blocchi orari
function vehicleAvailableAtTime(
  vehicleId: string,
  tripTimeMin: number,
  vehicleAvailMap: Map<string, boolean>,
  vehicleBlocksMap: Map<string, Array<{ block_from: string; block_to: string }>>,
  durationMin = 90
): boolean {
  if (vehicleAvailMap.get(vehicleId) === false) return false;
  const blocks = vehicleBlocksMap.get(vehicleId) ?? [];
  const tripEnd = tripTimeMin + durationMin;
  for (const b of blocks) {
    const bStart = timeToMin(b.block_from);
    const bEnd = timeToMin(b.block_to);
    if (tripTimeMin < bEnd && tripEnd > bStart) return false;
  }
  return true;
}

// Verifica disponibilità oraria autista
function driverAvailableAtTime(
  driverProfileId: string,
  tripTimeMin: number,
  driverAvailMap: Map<string, { available: boolean; available_from: string | null; available_to: string | null }>
): boolean {
  const avail = driverAvailMap.get(driverProfileId);
  if (!avail) return true; // non dichiarato = disponibile
  if (!avail.available) return false;
  if (avail.available_from) {
    const fromMin = timeToMin(avail.available_from);
    if (tripTimeMin < fromMin) return false;
  }
  if (avail.available_to) {
    const toMin = timeToMin(avail.available_to);
    if (tripTimeMin >= toMin) return false;
  }
  return true;
}

type TripDraft = {
  serviceIds: string[];
  pax: number;
  time: string;
  direction: "arrival" | "departure";
  zoneLabel: string;
};

function serviceOperationalTime(service: ServiceRow): string {
  return service.direction === "departure"
    ? (service.pickup_hotel ?? service.time).slice(0, 5)
    : service.time.slice(0, 5);
}

function serviceToGeographicWindow(service: ServiceRow, hotelMap: Map<string, HotelRow>): GeographicCompatibilityService {
  const hotelZone = serviceOperationalZone(service, hotelMap);
  const startTime = serviceOperationalTime(service);
  if (service.direction === "departure") {
    return { id: service.id, startTime, startZone: hotelZone, endZone: service.meeting_point };
  }
  return { id: service.id, startTime, startZone: service.meeting_point, endZone: hotelZone };
}

function draftToGeographicWindow(
  draft: TripDraft,
  serviceMap: Map<string, ServiceRow>,
  hotelMap: Map<string, HotelRow>
): GeographicCompatibilityService {
  const services = draft.serviceIds
    .map((serviceId) => serviceMap.get(serviceId))
    .filter((service): service is ServiceRow => Boolean(service));
  const windows = services.map((service) => serviceToGeographicWindow(service, hotelMap));
  const first = windows[0];
  const last = windows[windows.length - 1] ?? first;
  return {
    id: draft.serviceIds.join(","),
    label: draft.zoneLabel,
    startTime: first?.startTime ?? draft.time,
    startZone: first?.startZone ?? draft.zoneLabel,
    startArea: first?.startArea ?? zoneToGeoArea(first?.startZone ?? draft.zoneLabel),
    endZone: last?.endZone ?? draft.zoneLabel,
    endArea: last?.endArea ?? zoneToGeoArea(last?.endZone ?? draft.zoneLabel),
  };
}

function vehicleChangeCompatible(
  events: DriverVehicleEvent[],
  tripMin: number,
  nextVehicleLabel: string | null,
) {
  if (!nextVehicleLabel) return true;
  return !events.some((event) =>
    event.vehicleLabel &&
    event.vehicleLabel !== nextVehicleLabel &&
    Math.abs(event.time - tripMin) < MIN_VEHICLE_CHANGE_MINUTES
  );
}

function vehicleScheduleCompatible(events: VehicleEvent[], tripMin: number) {
  return !events.some((event) => Math.abs(event.time - tripMin) < MIN_SAME_VEHICLE_REUSE_MINUTES);
}

function serviceRouteLabel(service: ServiceRow, hotelMap: Map<string, HotelRow>) {
  const hotel = service.hotel_id ? hotelMap.get(service.hotel_id) : null;
  const hotelName = hotel?.name ?? "destinazione da verificare";
  const meetingPoint = service.meeting_point ?? "punto da verificare";
  if (service.direction === "arrival") return `${meetingPoint} -> ${hotelName}`;
  return `${hotelName} -> ${meetingPoint}`;
}

function draftConflictLabel(draft: TripDraft, serviceMap: Map<string, ServiceRow>, hotelMap: Map<string, HotelRow>) {
  const services = draft.serviceIds
    .map((serviceId) => serviceMap.get(serviceId))
    .filter((service): service is ServiceRow => Boolean(service));
  const names = services
    .map((service) => service.customer_name?.trim())
    .filter(Boolean);
  const uniqueNames = Array.from(new Set(names));
  const routes = Array.from(new Set(services.map((service) => serviceRouteLabel(service, hotelMap))));
  const pax = services.reduce((sum, service) => sum + service.pax, 0);
  const nameLabel = uniqueNames.length > 0 ? uniqueNames.slice(0, 3).join(" + ") : `${services.length} servizi`;
  const routeLabel = routes.length === 1
    ? routes[0]
    : routes.slice(0, 2).join(" / ") + (routes.length > 2 ? "..." : "");
  return `${draft.time} ${draft.zoneLabel} - ${nameLabel}${pax ? ` (${pax} pax)` : ""}: ${routeLabel} - nessun autista compatibile geograficamente.`;
}

function servicesToExistingTripGeographicWindow(
  services: ServiceRow[],
  hotelMap: Map<string, HotelRow>
): GeographicCompatibilityService {
  const windows = [...services]
    .sort((a, b) => timeToMin(serviceOperationalTime(a)) - timeToMin(serviceOperationalTime(b)))
    .map((service) => serviceToGeographicWindow(service, hotelMap));
  const first = windows[0];
  const last = windows[windows.length - 1] ?? first;
  return {
    id: services.map((service) => service.id).join(","),
    startTime: first?.startTime ?? "00:00",
    startZone: first?.startZone ?? null,
    startArea: first?.startArea ?? null,
    endZone: last?.endZone ?? first?.endZone ?? null,
    endArea: last?.endArea ?? first?.endArea ?? null,
  };
}

function geographicScheduleIssue(
  existing: GeographicCompatibilityService[],
  next: GeographicCompatibilityService
) {
  const windows = [...existing, next].sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));
  const issues = [];
  for (let i = 1; i < windows.length; i++) {
    issues.push(validateGeographicCompatibility(windows[i - 1]!, windows[i]!));
  }
  return strongestGeographicResult(issues.filter((issue) => issue.severity !== "ok"));
}

type DepartureProtectedBlock = {
  serviceIds: string[];
  pax: number;
  pickup: string;
  zone: string;
  port: string;
};

function batchProtectedBlocksByCapacity(
  blocks: DepartureProtectedBlock[],
  capMax: number
): DepartureProtectedBlock[][] {
  if (!blocks.length) return [];
  if (!capMax || capMax <= 0) return [blocks];

  const batches: DepartureProtectedBlock[][] = [];
  let current: DepartureProtectedBlock[] = [];
  let currentPax = 0;

  for (const block of blocks) {
    if (block.pax > capMax) {
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentPax = 0;
      }
      batches.push([block]);
      continue;
    }

    if (currentPax + block.pax > capMax && current.length > 0) {
      batches.push(current);
      current = [];
      currentPax = 0;
    }

    current.push(block);
    currentPax += block.pax;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;
    const body = (await request.json().catch(() => ({}))) as { date?: string; mode?: string };
    const date = body.date ?? new Date().toISOString().slice(0, 10);
    const mode: "unassigned_only" | "regenerate_all" =
      body.mode === "regenerate_all" ? "regenerate_all" : "unassigned_only";

    // ── 1. Carica dati ────────────────────────────────────────────────────────

    const [servicesRes, hotelsRes, vehiclesRes, driverRegistry, assignmentsRes, groupsRes,
           hotelLimitsRes, driverAvailRes, vehicleAvailRes, vehicleBlocksRes, availabilityConfirmRes, commitments] =
      await Promise.all([
        auth.admin.from("services")
          .select("id, time, direction, vessel, hotel_id, pax, status, meeting_point, pickup_hotel, customer_name, booking_service_kind, service_type_code")
          .eq("tenant_id", tenantId).eq("date", date)
          .neq("status", "cancelled").neq("is_draft", true),
        auth.admin.from("hotels").select("id, name, address, zone, lat, lng, geo_status, geo_source, geo_accuracy, geo_verified_at").eq("tenant_id", tenantId),
        auth.admin.from("vehicles")
          .select("id, label, capacity")
          .eq("tenant_id", tenantId).eq("active", true)
          .order("capacity"),
        listDriverRegistry(auth.admin, tenantId),
        auth.admin.from("assignments")
          .select("service_id, group_id, driver_user_id, driver_profile_id, vehicle_label, locked_by_operator")
          .eq("tenant_id", tenantId),
        auth.admin.from("trip_groups")
          .select("id, driver_user_id, driver_profile_id")
          .eq("tenant_id", tenantId).eq("date", date).eq("status", "active"),
        // Vincoli rigidi hotel → capienza mezzo
        auth.admin.from("hotel_vehicle_limits")
          .select("hotel_id, max_capacity")
          .eq("tenant_id", tenantId),
        // Disponibilità autisti del giorno
        auth.admin.from("driver_daily_availability")
          .select("driver_profile_id, available, available_from, available_to")
          .eq("tenant_id", tenantId).eq("date", date),
        // Disponibilità mezzi del giorno
        auth.admin.from("vehicle_daily_availability")
          .select("vehicle_id, available")
          .eq("tenant_id", tenantId).eq("date", date),
        // Blocchi orari mezzi
        auth.admin.from("vehicle_time_blocks")
          .select("vehicle_id, block_from, block_to")
          .eq("tenant_id", tenantId).eq("date", date),
        auth.admin.from("daily_availability_confirmations")
          .select("confirmed")
          .eq("tenant_id", tenantId).eq("date", date)
          .maybeSingle(),
        loadVehicleCommitmentsForDate(auth.admin, tenantId, date),
      ]);

    if (servicesRes.error || hotelsRes.error)
      return NextResponse.json({ ok: false, error: "Errore caricamento dati." }, { status: 500 });

    const allServices = (servicesRes.data ?? []) as ServiceRow[];
    const hotelMap = new Map<string, HotelRow>(
      (hotelsRes.data ?? []).map((h) => [h.id, h as HotelRow])
    );
    const geoBlockedByHotelId = new Map<string, ReturnType<typeof hotelGeoQuality>>();
    for (const hotel of hotelMap.values()) {
      const quality = hotelGeoQuality(hotel);
      if (!quality.routeUsable) geoBlockedByHotelId.set(hotel.id, quality);
    }

    // hotel_id → max_capacity limite rigido
    const hotelVehicleLimitMap = new Map<string, number>(
      (hotelLimitsRes.data ?? []).map((l) => [l.hotel_id as string, l.max_capacity as number])
    );

    // driver_user_id → disponibilità giornaliera
    const driverAvailMap = new Map(
      (driverAvailRes.data ?? []).map((d) => [
        d.driver_profile_id as string,
        { available: d.available as boolean, available_from: d.available_from as string | null, available_to: d.available_to as string | null },
      ])
    );

    // vehicle_id → disponibile (false = non disponibile)
    const vehicleAvailByIdMap = new Map(
      (vehicleAvailRes.data ?? []).map((v) => [v.vehicle_id as string, v.available as boolean])
    );
    for (const vehicleId of commitments.byVehicleId.keys()) {
      vehicleAvailByIdMap.set(vehicleId, false);
    }
    // vehicle_id → blocchi orari
    const vehicleBlocksByIdMap = new Map<string, Array<{ block_from: string; block_to: string }>>();
    for (const b of vehicleBlocksRes.data ?? []) {
      const list = vehicleBlocksByIdMap.get(b.vehicle_id as string) ?? [];
      list.push({ block_from: b.block_from as string, block_to: b.block_to as string });
      vehicleBlocksByIdMap.set(b.vehicle_id as string, list);
    }

    const allVehicles = ((vehiclesRes.data ?? []) as VehicleRow[])
      .filter((v) => v.capacity && v.capacity > 0)
      .sort((a, b) => (a.capacity ?? 0) - (b.capacity ?? 0));

    // Filtra veicoli globalmente non disponibili (available=false senza blocchi orari specifici)
    const vehicles = allVehicles.filter((v) => vehicleAvailByIdMap.get(v.id) !== false);
    const vehicleScheduleEvents = new Map<string, VehicleEvent[]>(
      vehicles.map((vehicle) => [vehicle.label, []])
    );

    const allDrivers = (driverRegistry ?? [])
      .filter((driver) => !driver.access_suspended)
      .map((driver) => ({
        profile_id: driver.id,
        user_id: driver.user_id ?? null,
        full_name: driver.full_name,
      })) as DriverRow[];
    // Filtra autisti dichiarati non disponibili (available=false)
    const drivers = allDrivers.filter((d) => {
      const avail = driverAvailMap.get(d.profile_id);
      return !avail || avail.available;
    });

    const allDayServiceIds = new Set(allServices.map((s) => s.id));
    const serviceMap = new Map(allServices.map((service) => [service.id, service]));
    const assignedMap = new Map(
      (assignmentsRes.data ?? [])
        .filter((a) => a.group_id && allDayServiceIds.has(a.service_id as string))
        .map((a) => [a.service_id as string, a.group_id as string])
    );
    const lockedAssignments = (assignmentsRes.data ?? [])
      .filter((a) => a.locked_by_operator === true && allDayServiceIds.has(a.service_id as string));
    const lockedServiceIds = new Set(lockedAssignments.map((a) => a.service_id as string));
    const lockedGroupIds = new Set(
      lockedAssignments
        .map((a) => a.group_id as string | null)
        .filter((groupId): groupId is string => Boolean(groupId))
    );
    const existingGroups = (groupsRes.data ?? []).map((g) => g.id as string);
    const activeGroupDriverByUserId = new Map(
      (groupsRes.data ?? []).map((group) => [group.id as string, (group.driver_user_id as string | null) ?? null])
    );
    const activeGroupDriverByProfileId = new Map(
      (groupsRes.data ?? []).map((group) => [group.id as string, (group.driver_profile_id as string | null) ?? null])
    );
    const groupIdsForExistingLoad = mode === "regenerate_all"
      ? lockedGroupIds
      : new Set(existingGroups);
    const userIdToProfileId = new Map(
      allDrivers.filter((d) => d.user_id).map((d) => [d.user_id!, d.profile_id])
    );

    // Capacità massima disponibile (o 8 come fallback)
    const maxCap = vehicles.length > 0
      ? Math.max(...vehicles.map((v) => v.capacity ?? 0))
      : 8;

    // ── 2. Se regenerate_all: pulisci esistenti ───────────────────────────────

    const now = new Date().toISOString();

    if (mode === "regenerate_all" && existingGroups.length > 0) {
      const unlockedGroupIds = existingGroups.filter((groupId) => !lockedGroupIds.has(groupId));
      const unlockedServiceIds = (assignmentsRes.data ?? [])
        .filter((a) =>
          a.group_id &&
          existingGroups.includes(a.group_id as string) &&
          a.locked_by_operator !== true &&
          allDayServiceIds.has(a.service_id as string)
        )
        .map((a) => a.service_id as string);
      await Promise.all([
        auth.admin
          .from("assignments")
          .delete()
          .in("group_id", existingGroups)
          .eq("tenant_id", tenantId)
          .or("locked_by_operator.is.null,locked_by_operator.eq.false"),
        unlockedGroupIds.length > 0
          ? auth.admin.from("trip_groups").update({ status: "cancelled", updated_at: now }).in("id", unlockedGroupIds).eq("tenant_id", tenantId)
          : Promise.resolve({ error: null }),
      ]);
      if (unlockedServiceIds.length > 0) {
        await auth.admin.from("services").update({ status: "new" })
          .in("id", unlockedServiceIds).eq("tenant_id", tenantId).eq("status", "assigned");
      }
      assignedMap.clear();
      for (const assignment of lockedAssignments) {
        if (assignment.group_id) assignedMap.set(assignment.service_id as string, assignment.group_id as string);
      }
    }

    // ── 3. Seleziona servizi da assegnare ────────────────────────────────────

    const toAssign = mode === "unassigned_only"
      ? allServices.filter((s) => !assignedMap.has(s.id) && !lockedServiceIds.has(s.id))
      : allServices.filter((s) => !lockedServiceIds.has(s.id));

    if (!toAssign.length) {
      return NextResponse.json({
        ok: true, assigned: 0, trips: 0, skipped: 0,
        report: ["Nessun servizio da assegnare per questa data."],
      });
    }

    const availabilityConfirmed = availabilityConfirmRes.data?.confirmed === true;
    if (!availabilityConfirmed) {
      return NextResponse.json({
        ok: false,
        error: "Disponibilita del giorno non confermata. Conferma autisti e mezzi prima di lanciare l'auto-assign.",
      }, { status: 409 });
    }

    const shuttlePairs = buildShuttlePairDrafts(toAssign, hotelMap);
    const unpairedToAssign = toAssign.filter((service) => !shuttlePairs.pairedIds.has(service.id));
    const arrivals = unpairedToAssign.filter((s) => s.direction === "arrival");
    const departures = unpairedToAssign.filter((s) => s.direction === "departure");

    const drafts: TripDraft[] = [...shuttlePairs.drafts];

    // ── 4. Algoritmo ARRIVI ──────────────────────────────────────────────────

    // Raggruppa arrivi vicini per porto: se due navi arrivano entro ~25 minuti,
    // l'operatore spesso preferisce aspettare e accorpare il giro.
    const ferryGroups = new Map<string, ServiceRow[]>();
    for (const svc of arrivals) {
      const key = arrivalMergeKey(svc);
      const list = ferryGroups.get(key) ?? [];
      list.push(svc);
      ferryGroups.set(key, list);
    }

    for (const ferryServices of ferryGroups.values()) {
      // Porto di arrivo → priorità area
      const priority = portPriority(ferryServices[0]?.meeting_point ?? null);

      // Raggruppa per zona hotel
      const byZone = new Map<string, ServiceRow[]>();
      for (const svc of ferryServices) {
        const zone = serviceOperationalZone(svc, hotelMap) ?? "Sconosciuto";
        const list = byZone.get(zone) ?? [];
        list.push(svc);
        byZone.set(zone, list);
      }

      // Ordina zone: area prioritaria prima, poi altra area, poi sconosciuta
      const sortedZones = Array.from(byZone.entries()).sort(([za], [zb]) => {
        const score = (z: string) => {
          const area = zoneArea(z);
          if (area === priority) return 0;
          if (area === "unknown") return 2;
          return 1;
        };
        return score(za) - score(zb);
      });

      for (const [zone, zoneSvcs] of sortedZones) {
        const sorted = routeSort(zoneSvcs, hotelMap, portCoords(ferryServices[0]?.meeting_point), "arrival");
        // Applica anche il limite hotel più restrittivo nella zona
        const zoneHotelMax = zoneSvcs.reduce<number | null>((min, s) => {
          const limit = s.hotel_id ? hotelVehicleLimitMap.get(s.hotel_id) : null;
          if (limit == null) return min;
          return min == null ? limit : Math.min(min, limit);
        }, null);
        const effectiveCap = zoneHotelMax != null ? Math.min(maxCap, zoneHotelMax) : maxCap;
        const batches = batchByCapacity(sorted.map((s) => ({ id: s.id, pax: s.pax })), effectiveCap);
        for (const batch of batches) {
          drafts.push({
            serviceIds: batch.map((b) => b.id),
            pax: batch.reduce((n, b) => n + b.pax, 0),
            time: [...ferryServices].sort((a, b) => a.time.localeCompare(b.time))[0]?.time ?? "00:00",
            direction: "arrival",
            zoneLabel: zone,
          });
        }
      }
    }

    // ── 5. Algoritmo PARTENZE ────────────────────────────────────────────────

    // Protegge i blocchi "stesso hotel + stesso pickup + stesso porto"
    const depBaseGroups = new Map<string, ServiceRow[]>();
    for (const svc of departures) {
      const key = departureBaseGroupKey(svc, hotelMap);
      const list = depBaseGroups.get(key) ?? [];
      list.push(svc);
      depBaseGroups.set(key, list);
    }

    const protectedBlocks = Array.from(depBaseGroups.values()).map((services) => {
      const sorted = routeSort(services, hotelMap, portCoords(services[0]?.meeting_point), "departure");
      const pickup = (sorted[0]?.pickup_hotel ?? sorted[0]?.time ?? "00:00").slice(0, 5);
      const zone = sorted[0] ? serviceOperationalZone(sorted[0], hotelMap) ?? "Sconosciuto" : "Sconosciuto";
      const port = cleanPortName(sorted[0]?.meeting_point) || "Imbarco da verificare";
      return {
        serviceIds: sorted.map((service) => service.id),
        pax: sorted.reduce((sum, service) => sum + service.pax, 0),
        pickup,
        zone,
        port,
      } satisfies DepartureProtectedBlock;
    });

    const departureClusterMap = new Map<string, DepartureProtectedBlock[]>();
    for (const block of protectedBlocks) {
      const key = `${block.zone}|${block.port}`;
      const list = departureClusterMap.get(key) ?? [];
      list.push(block);
      departureClusterMap.set(key, list);
    }

    for (const blocks of departureClusterMap.values()) {
      const sortedBlocks = [...blocks].sort((a, b) => a.pickup.localeCompare(b.pickup));
      const pickupClusters: DepartureProtectedBlock[][] = [];

      for (const block of sortedBlocks) {
        const pickupMin = timeToMin(block.pickup);
        const current = pickupClusters[pickupClusters.length - 1];
        if (!current || current.length === 0) {
          pickupClusters.push([block]);
          continue;
        }

        const anchorMin = timeToMin(current[0]?.pickup ?? "00:00");
        if (pickupMin - anchorMin <= DEPARTURE_SAME_HOTEL_MERGE_WINDOW_MINUTES) {
          current.push(block);
        } else {
          pickupClusters.push([block]);
        }
      }

      for (const cluster of pickupClusters) {
        const hotelIds = cluster
          .flatMap((block) => block.serviceIds)
          .map((sid) => allServices.find((s) => s.id === sid)?.hotel_id)
          .filter((id): id is string => Boolean(id));
        const groupHotelMax = hotelIds.reduce<number | null>((min, hid) => {
          const limit = hotelVehicleLimitMap.get(hid);
          if (limit == null) return min;
          return min == null ? limit : Math.min(min, limit);
        }, null);
        const effectiveCap = groupHotelMax != null ? Math.min(maxCap, groupHotelMax) : maxCap;
        const batches = batchProtectedBlocksByCapacity(cluster, effectiveCap);

        for (const batch of batches) {
          drafts.push({
            serviceIds: batch.flatMap((block) => block.serviceIds),
            pax: batch.reduce((sum, block) => sum + block.pax, 0),
            time: batch[0]?.pickup ?? "00:00",
            direction: "departure",
            zoneLabel: batch[0]?.zone ?? "—",
          });
        }
      }
    }

    // ── 6. Ordina per orario ─────────────────────────────────────────────────

    drafts.sort((a, b) => a.time.localeCompare(b.time));

    // ── 7. Assegna autisti (score-based: no-conflict + zona geografica + workload) ──
    //
    // Selezione autista in due fasi:
    //   1. Hard block < 30 min: esclusi dal pool (fisicamente impossibile)
    //      → fallback al pool completo solo se tutti sono hard-bloccati
    //   2. Score sul pool residuo:
    //      conflitto 30-75 min → +100_000 | num giri × 100 | zona +0/2/5 (tiebreaker)

    const driverTimes = new Map<string, number[]>();
    const driverCurrentArea = new Map<string, "nord_ovest" | "est_sud" | null>();
    const driverGeoWindows = new Map<string, GeographicCompatibilityService[]>();
    const driverVehicleEvents = new Map<string, DriverVehicleEvent[]>();
    for (const d of drivers) {
      driverTimes.set(d.profile_id, []);
      driverGeoWindows.set(d.profile_id, []);
      driverVehicleEvents.set(d.profile_id, []);
    }

    const existingServicesByDriverGroup = new Map<string, ServiceRow[]>();
    for (const assignment of assignmentsRes.data ?? []) {
      const serviceId = assignment.service_id as string;
      const groupId = assignment.group_id as string | null;
      if (!groupId || !allDayServiceIds.has(serviceId)) continue;
      if (!groupIdsForExistingLoad.has(groupId)) continue;
      const assignUserId = (assignment.driver_user_id as string | null) ?? activeGroupDriverByUserId.get(groupId) ?? null;
      const assignProfileId = (assignment.driver_profile_id as string | null)
        ?? activeGroupDriverByProfileId.get(groupId)
        ?? (assignUserId ? userIdToProfileId.get(assignUserId) : null)
        ?? null;
      const service = serviceMap.get(serviceId);
      if (!assignProfileId || !service) continue;
      const times = driverTimes.get(assignProfileId) ?? [];
      const serviceMin = timeToMin(serviceOperationalTime(service));
      times.push(serviceMin);
      driverTimes.set(assignProfileId, times);
      const vehicleLabel = (assignment.vehicle_label as string | null) ?? null;
      driverVehicleEvents.set(assignProfileId, [
        ...(driverVehicleEvents.get(assignProfileId) ?? []),
        { time: serviceMin, vehicleLabel },
      ]);
      if (vehicleLabel) {
        vehicleScheduleEvents.set(vehicleLabel, [
          ...(vehicleScheduleEvents.get(vehicleLabel) ?? []),
          { time: serviceMin, driverProfileId: assignProfileId },
        ]);
      }
      const key = `${assignProfileId}|${groupId}`;
      existingServicesByDriverGroup.set(key, [...(existingServicesByDriverGroup.get(key) ?? []), service]);
    }

    for (const [key, services] of existingServicesByDriverGroup.entries()) {
      const profileId = key.split("|")[0]!;
      const window = servicesToExistingTripGeographicWindow(services, hotelMap);
      driverGeoWindows.set(profileId, [...(driverGeoWindows.get(profileId) ?? []), window]);
      const area = zoneToGeoArea(window.endZone ?? window.startZone);
      if (area) driverCurrentArea.set(profileId, area);
    }

    const draftAssignments: Array<{ draft: TripDraft; profileId: string | null; userId: string | null }> = [];
    const geographicSkips: string[] = [];

    for (const draft of drafts) {
      const tripMin = timeToMin(draft.time);
      const tripArea = zoneToGeoArea(draft.zoneLabel);
      const draftGeoWindow = draftToGeographicWindow(draft, serviceMap, hotelMap);
      let assignedProfileId: string | null = null;
      let assignedUserId: string | null = null;

      if (drivers.length > 0) {
        const timeAvailable = [...drivers].filter((d) =>
          driverAvailableAtTime(d.profile_id, tripMin, driverAvailMap)
        );

        // Hard block: < 30 min → fisicamente impossibile fare due giri
        // Soft penalty: 30-75 min → penalizzato ma usabile come ultima risorsa
        const hardFree = timeAvailable.filter((d) => {
          const times = driverTimes.get(d.profile_id) ?? [];
          return !times.some((t) => Math.abs(t - tripMin) < 30);
        });
        // Solo se tutti hanno hard conflict si usa il pool completo
        const candidates = (hardFree.length > 0 ? hardFree : timeAvailable)
          .map((driver) => ({
            driver,
            geoIssue: geographicScheduleIssue(driverGeoWindows.get(driver.profile_id) ?? [], draftGeoWindow),
          }))
          .filter((candidate) => candidate.geoIssue?.severity !== "block");

        // Score: conflitto 30-75 min (100_000) >> num giri (×100) >> zona (0/2/5 tiebreaker)
        const best = candidates
          .map(({ driver, geoIssue }) => {
            const times = driverTimes.get(driver.profile_id) ?? [];
            const conflictPenalty = times.some((t) => Math.abs(t - tripMin) < 75) ? 100_000 : 0;
            const lastArea = driverCurrentArea.get(driver.profile_id);
            const zonePenalty = !lastArea || !tripArea ? 2
              : lastArea === tripArea ? 0 : 5;
            const warningPenalty = geoIssue?.severity === "warning" ? 20 : 0;
            return { driver, score: conflictPenalty + times.length * 100 + zonePenalty + warningPenalty };
          })
          .sort((a, b) => a.score - b.score)[0];

        if (best) {
          assignedProfileId = best.driver.profile_id;
          assignedUserId = best.driver.user_id;
          const times = driverTimes.get(assignedProfileId) ?? [];
          times.push(tripMin);
          driverTimes.set(assignedProfileId, times);
          driverGeoWindows.set(assignedProfileId, [...(driverGeoWindows.get(assignedProfileId) ?? []), draftGeoWindow]);
          if (tripArea) driverCurrentArea.set(assignedProfileId, tripArea);
        } else if (timeAvailable.length > 0) {
          geographicSkips.push(draftConflictLabel(draft, serviceMap, hotelMap));
        }
      }

      draftAssignments.push({ draft, profileId: assignedProfileId, userId: assignedUserId });
    }

    // ── 8. Assegna mezzi (il più piccolo che soddisfa PAX + vincoli hotel + autista) ─

    const pickVehicle = (
      pax: number,
      draft: TripDraft,
      profileId: string | null,
      preferredVehicleLabel: string | null = null,
      strictPreferred: boolean = false,
      driverEvents: Map<string, DriverVehicleEvent[]> = driverVehicleEvents,
      vehicleEvents: Map<string, VehicleEvent[]> = vehicleScheduleEvents,
    ): VehicleRow | null => {
      const tripMin = timeToMin(draft.time);
      const existingDriverVehicleEvents = profileId ? driverEvents.get(profileId) ?? [] : [];

      // Limite hotel: minima max_capacity tra tutti gli hotel del giro
      const hotelIds = draft.serviceIds
        .map((sid) => allServices.find((s) => s.id === sid)?.hotel_id)
        .filter((id): id is string => Boolean(id));
      const hotelMaxCap = hotelIds.reduce<number | null>((min, hid) => {
        const limit = hotelVehicleLimitMap.get(hid);
        if (limit == null) return min;
        return min == null ? limit : Math.min(min, limit);
      }, null);
      const hardMaxCap = hotelMaxCap ?? null;

      const usageCount = (label: string) => vehicleEvents.get(label)?.length ?? 0;
      const bySmallestAndLeastUsed = (a: VehicleRow, b: VehicleRow) =>
        ((a.capacity ?? 0) - (b.capacity ?? 0)) ||
        (usageCount(a.label) - usageCount(b.label)) ||
        a.label.localeCompare(b.label);

      // Se l'autista ha già un mezzo preferito, proviamo prima quello.
      // In strict mode (già cambiato una volta) è l'unica opzione ammessa.
      if (preferredVehicleLabel) {
        const preferred = vehicles.find((v) => v.label === preferredVehicleLabel);
        if (preferred) {
          const cap = preferred.capacity ?? 0;
          const scheduleOk =
            vehicleAvailableAtTime(preferred.id, tripMin, vehicleAvailByIdMap, vehicleBlocksByIdMap) &&
            vehicleScheduleCompatible(vehicleEvents.get(preferred.label) ?? [], tripMin);
          if (scheduleOk && cap >= pax && (hardMaxCap == null || cap <= hardMaxCap)) {
            return preferred;
          }
        }
        if (strictPreferred) return null;
      }

      // Cerca il veicolo più piccolo che soddisfa i PAX, rispetta i limiti hotel,
      // non ha blocchi orari e non è già impegnato in un giro troppo vicino.
      const candidate = vehicles
        .filter((v) => {
          const cap = v.capacity ?? 0;
          if (cap < pax) return false;
          if (hardMaxCap != null && cap > hardMaxCap) return false;
          if (!vehicleAvailableAtTime(v.id, tripMin, vehicleAvailByIdMap, vehicleBlocksByIdMap)) return false;
          if (!vehicleChangeCompatible(existingDriverVehicleEvents, tripMin, v.label)) return false;
          if (!vehicleScheduleCompatible(vehicleEvents.get(v.label) ?? [], tripMin)) return false;
          return true;
        })
        .sort(bySmallestAndLeastUsed)[0];
      if (candidate) return candidate;

      // Fallback: qualsiasi veicolo con cap >= pax e slot libero (ignora hardMaxCap hotel).
      // Non crea mai overbooking: se nessun veicolo ha cap >= pax il giro resta senza mezzo.
      const fallback = [...vehicles]
        .filter((v) => {
          const cap = v.capacity ?? 0;
          if (cap < pax) return false;
          return (
            vehicleAvailableAtTime(v.id, tripMin, vehicleAvailByIdMap, vehicleBlocksByIdMap) &&
            vehicleChangeCompatible(existingDriverVehicleEvents, tripMin, v.label) &&
            vehicleScheduleCompatible(vehicleEvents.get(v.label) ?? [], tripMin)
          );
        })
        .sort(bySmallestAndLeastUsed)[0];
      return fallback ?? null;
    };

    // ── 9. Persisti giri (batch — O(4) invece di O(n×4)) ────────────────────

    let assignedCount = 0;
    let tripsCreated = 0;
    const errors: string[] = [];
    const batchAdmin = auth.admin as SupabaseClient;

    if (draftAssignments.length > 0) {
      // Seleziona veicoli per tutti i giri, poi crea tutti i trip_groups in un unico insert
      const prepared: Array<{
        draft: TripDraft;
        profileId: string;
        driverUserId: string | null;
        vehicle: VehicleRow | null;
      }> = [];
      const plannedDriverVehicleEvents = new Map(
        [...driverVehicleEvents.entries()].map(([profileId, events]) => [profileId, [...events]])
      );
      const plannedVehicleScheduleEvents = new Map(
        [...vehicleScheduleEvents.entries()].map(([vehicleLabel, events]) => [vehicleLabel, [...events]])
      );

      // Traccia mezzo preferito per autista: minimizza i cambi, ammette al più 1 cambio/giorno.
      // Inizializzato da eventi già presenti (unassigned_only con giri locked).
      const driverPreferredVehicle = new Map<string, string>();
      const driverHasChanged = new Map<string, boolean>();
      for (const [pid, events] of driverVehicleEvents.entries()) {
        const labels = events.map((e) => e.vehicleLabel).filter((l): l is string => Boolean(l));
        if (labels.length > 0) driverPreferredVehicle.set(pid, labels[labels.length - 1]!);
        const distinct = new Set(labels);
        if (distinct.size > 1) driverHasChanged.set(pid, true);
      }

      for (const { draft, profileId, userId: driverUserId } of draftAssignments) {
        if (!profileId) continue;
        const preferredLabel = driverPreferredVehicle.get(profileId) ?? null;
        const strictPreferred = driverHasChanged.get(profileId) === true;
        const vehicle = pickVehicle(
          draft.pax,
          draft,
          profileId,
          preferredLabel,
          strictPreferred,
          plannedDriverVehicleEvents,
          plannedVehicleScheduleEvents
        );
        prepared.push({ draft, profileId, driverUserId, vehicle });
        const tripMin = timeToMin(draft.time);
        plannedDriverVehicleEvents.set(profileId, [
          ...(plannedDriverVehicleEvents.get(profileId) ?? []),
          { time: tripMin, vehicleLabel: vehicle?.label ?? null },
        ]);
        if (vehicle?.label) {
          plannedVehicleScheduleEvents.set(vehicle.label, [
            ...(plannedVehicleScheduleEvents.get(vehicle.label) ?? []),
            { time: tripMin, driverProfileId: profileId },
          ]);
          // Aggiorna tracking mezzo preferito
          const prev = driverPreferredVehicle.get(profileId);
          if (!prev) {
            driverPreferredVehicle.set(profileId, vehicle.label);
          } else if (prev !== vehicle.label && !driverHasChanged.get(profileId)) {
            driverHasChanged.set(profileId, true);
            driverPreferredVehicle.set(profileId, vehicle.label);
          }
        }
      }

      const groupRows = prepared.map(({ draft: _, driverUserId, profileId, vehicle }) => ({
        tenant_id: tenantId,
        date,
        driver_user_id: driverUserId ?? null,
        driver_profile_id: profileId ?? null,
        vehicle_label: vehicle?.label ?? null,
        vehicle_capacity: vehicle?.capacity ?? null,
        notes: null,
        created_by: userId,
        created_at: now,
        updated_at: now,
      }));

      const { data: groups, error: groupsErr } = prepared.length > 0
        ? await auth.admin
            .from("trip_groups")
            .insert(groupRows)
            .select("id")
        : { data: [] as Array<{ id: string }>, error: null };

      if (prepared.length > 0 && (groupsErr || !groups?.length)) {
        errors.push(`Errore creazione giri: ${groupsErr?.message ?? "nessun ID restituito"}`);
      } else {
        const allAssignRows: Array<{
          tenant_id: string; service_id: string;
          driver_user_id: string | null; driver_profile_id: string | null; vehicle_label: string; group_id: string;
          assignment_source: string; locked_by_operator: boolean; assigned_by: string; assigned_at: string; lock_reason: null;
        }> = [];
        const allServiceIds: string[] = [];
        const allStatusEvents: Array<{
          tenant_id: string; service_id: string; status: string; at: string; by_user_id: string;
        }> = [];

        const createdGroups = groups ?? [];
        for (let i = 0; i < createdGroups.length; i++) {
          const { draft, driverUserId, profileId, vehicle } = prepared[i]!;
          const groupId = (createdGroups[i] as { id: string }).id;
          for (const sid of draft.serviceIds) {
            allAssignRows.push({
              tenant_id: tenantId, service_id: sid,
              driver_user_id: driverUserId ?? null,
              driver_profile_id: profileId ?? null,
              vehicle_label: vehicle?.label ?? "", group_id: groupId,
              assignment_source: "auto_assign",
              locked_by_operator: false,
              assigned_by: userId,
              assigned_at: now,
              lock_reason: null,
            });
            allServiceIds.push(sid);
            allStatusEvents.push({ tenant_id: tenantId, service_id: sid, status: "assigned", at: now, by_user_id: userId });
          }
          tripsCreated++;
          assignedCount += draft.serviceIds.length;
        }

        if (allServiceIds.length > 0) {
          // Tutti e tre i write in parallelo
          const [assignRes, svcRes, statusRes] = await Promise.all([
            batchAdmin.from("assignments").upsert(allAssignRows, { onConflict: "service_id,tenant_id", ignoreDuplicates: false }),
            auth.admin.from("services").update({ status: "assigned" }).in("id", allServiceIds).eq("tenant_id", tenantId),
            batchAdmin.from("status_events").insert(allStatusEvents),
          ]);

          if (assignRes.error) errors.push(`Assignments: ${assignRes.error.message}`);
          if (svcRes.error) errors.push(`Services update: ${svcRes.error.message}`);
          if (statusRes.error) errors.push(`Status events: ${statusRes.error.message}`);
        }
      }
    }

    const unassignedCount = toAssign.length - assignedCount;
    const geoBlockedServices = toAssign.filter((service) => {
      if (!service.hotel_id) return !hasUsableOperationalPosition(service, hotelMap);
      const hotel = hotelMap.get(service.hotel_id);
      if (!hotel) return !hasUsableOperationalPosition(service, hotelMap);
      return geoBlockedByHotelId.has(service.hotel_id) && !hasUsableOperationalPosition(service, hotelMap);
    });
    const geoBlockedHotels = Array.from(new Set(
      geoBlockedServices
        .map((service) => (service.hotel_id ? hotelMap.get(service.hotel_id)?.name ?? service.hotel_id : "Hotel mancante"))
        .filter(Boolean)
    ));

    const report: string[] = [
      `${assignedCount} servizi assegnati in ${tripsCreated} giri.`,
      ...(unassignedCount > 0 ? [`${unassignedCount} servizi non assegnati.`] : []),
      ...(geoBlockedServices.length > 0
        ? [`${geoBlockedServices.length} servizi hanno hotel con geolocalizzazione dubbia: ${geoBlockedHotels.slice(0, 6).join(", ")}${geoBlockedHotels.length > 6 ? "..." : ""}.`]
        : []),
      ...(geographicSkips.length > 0
        ? [`${geographicSkips.length} giri non assegnati per conflitto geografico: ${geographicSkips.slice(0, 3).join("; ")}${geographicSkips.length > 3 ? "..." : ""}`]
        : []),
      ...(errors.length > 0 ? [`${errors.length} errori: ${errors.slice(0, 2).join("; ")}`] : []),
    ];

    return NextResponse.json({ ok: true, assigned: assignedCount, trips: tripsCreated, skipped: unassignedCount, report });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore." },
      { status: 500 }
    );
  }
}
