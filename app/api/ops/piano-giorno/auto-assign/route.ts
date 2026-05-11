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
import { hotelGeoQuality } from "@/lib/hotel-geocoding";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { loadVehicleCommitmentsForDate } from "@/lib/server/vehicle-commitments";
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

function arrivalMergeKey(service: ServiceRow): string {
  const port = cleanPortName(service.meeting_point) || "Ischia Porto";
  return `${port.toLowerCase()}|${Math.floor(timeToMin(service.time) / ARRIVAL_MERGE_WINDOW_MINUTES)}`;
}

function departureBaseGroupKey(service: ServiceRow, hotelMap: Map<string, HotelRow>): string {
  const hotelKey = service.hotel_id ?? `zone:${hotelMap.get(service.hotel_id ?? "")?.zone ?? "Sconosciuto"}`;
  const pickup = (service.pickup_hotel ?? service.time).slice(0, 5);
  const port = cleanPortName(service.meeting_point) || "Imbarco da verificare";
  return `${hotelKey}|${pickup}|${port.toLowerCase()}`;
}

// ─── Tipi interni ─────────────────────────────────────────────────────────────

type ServiceRow = {
  id: string; time: string; direction: "arrival" | "departure";
  vessel: string | null; hotel_id: string | null; pax: number;
  status: string; meeting_point: string | null; pickup_hotel: string | null;
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
type DriverRow = { profile_id: string; user_id: string; full_name: string; max_vehicle_capacity: number | null };

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
          .select("id, time, direction, vessel, hotel_id, pax, status, meeting_point, pickup_hotel")
          .eq("tenant_id", tenantId).eq("date", date)
          .neq("status", "cancelled").neq("is_draft", true),
        auth.admin.from("hotels").select("id, name, address, zone, lat, lng, geo_status, geo_source, geo_accuracy, geo_verified_at").eq("tenant_id", tenantId),
        auth.admin.from("vehicles")
          .select("id, label, capacity")
          .eq("tenant_id", tenantId).eq("active", true)
          .order("capacity"),
        listDriverRegistry(auth.admin, tenantId),
        auth.admin.from("assignments")
          .select("service_id, group_id")
          .eq("tenant_id", tenantId),
        auth.admin.from("trip_groups")
          .select("id")
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

    const allDrivers = (driverRegistry ?? [])
      .filter((driver) => driver.user_id && !driver.access_suspended)
      .map((driver) => ({
        profile_id: driver.id,
        user_id: driver.user_id!,
        full_name: driver.full_name,
        max_vehicle_capacity: driver.max_vehicle_capacity,
      })) as DriverRow[];
    // Filtra autisti dichiarati non disponibili (available=false)
    const drivers = allDrivers.filter((d) => {
      const avail = driverAvailMap.get(d.profile_id);
      return !avail || avail.available;
    });

    const allDayServiceIds = new Set(allServices.map((s) => s.id));
    const assignedMap = new Map(
      (assignmentsRes.data ?? [])
        .filter((a) => a.group_id && allDayServiceIds.has(a.service_id as string))
        .map((a) => [a.service_id as string, a.group_id as string])
    );
    const existingGroups = (groupsRes.data ?? []).map((g) => g.id as string);

    // Capacità massima disponibile (o 8 come fallback)
    const maxCap = vehicles.length > 0
      ? Math.max(...vehicles.map((v) => v.capacity ?? 0))
      : 8;

    // ── 2. Se regenerate_all: pulisci esistenti ───────────────────────────────

    const now = new Date().toISOString();

    if (mode === "regenerate_all" && existingGroups.length > 0) {
      const dayIds = allServices.map((s) => s.id);
      await Promise.all([
        auth.admin.from("assignments").delete().in("group_id", existingGroups).eq("tenant_id", tenantId),
        auth.admin.from("trip_groups").update({ status: "cancelled", updated_at: now }).in("id", existingGroups).eq("tenant_id", tenantId),
      ]);
      if (dayIds.length > 0) {
        await auth.admin.from("services").update({ status: "new" })
          .in("id", dayIds).eq("tenant_id", tenantId).eq("status", "assigned");
      }
      assignedMap.clear();
    }

    // ── 3. Seleziona servizi da assegnare ────────────────────────────────────

    const toAssign = mode === "unassigned_only"
      ? allServices.filter((s) => !assignedMap.has(s.id))
      : allServices;

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

    const arrivals = toAssign.filter((s) => s.direction === "arrival");
    const departures = toAssign.filter((s) => s.direction === "departure");

    const drafts: TripDraft[] = [];

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
        const zone = hotelMap.get(svc.hotel_id ?? "")?.zone ?? "Sconosciuto";
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
      const zone = hotelMap.get(sorted[0]?.hotel_id ?? "")?.zone ?? "Sconosciuto";
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
    const driverCurrentArea = new Map<string, "nordovest" | "estsud" | "unknown">();
    for (const d of drivers) driverTimes.set(d.user_id, []);

    const draftAssignments: Array<{ draft: TripDraft; driverId: string | null }> = [];

    for (const draft of drafts) {
      const tripMin = timeToMin(draft.time);
      const tripArea = zoneArea(draft.zoneLabel);
      let assigned: string | null = null;

      if (drivers.length > 0) {
        const timeAvailable = [...drivers].filter((d) =>
          driverAvailableAtTime(d.profile_id, tripMin, driverAvailMap)
        );

        // Hard block: < 30 min → fisicamente impossibile fare due giri
        // Soft penalty: 30-75 min → penalizzato ma usabile come ultima risorsa
        const hardFree = timeAvailable.filter((d) => {
          const times = driverTimes.get(d.user_id) ?? [];
          return !times.some((t) => Math.abs(t - tripMin) < 30);
        });
        // Solo se tutti hanno hard conflict si usa il pool completo
        const candidates = hardFree.length > 0 ? hardFree : timeAvailable;

        // Score: conflitto 30-75 min (100_000) >> num giri (×100) >> zona (0/2/5 tiebreaker)
        const best = candidates
          .map((d) => {
            const times = driverTimes.get(d.user_id) ?? [];
            const conflictPenalty = times.some((t) => Math.abs(t - tripMin) < 75) ? 100_000 : 0;
            const lastArea = driverCurrentArea.get(d.user_id);
            const zonePenalty = !lastArea || tripArea === "unknown" ? 2
              : lastArea === tripArea ? 0 : 5;
            return { driver: d, score: conflictPenalty + times.length * 100 + zonePenalty };
          })
          .sort((a, b) => a.score - b.score)[0];

        if (best) {
          assigned = best.driver.user_id;
          const times = driverTimes.get(assigned) ?? [];
          times.push(tripMin);
          driverTimes.set(assigned, times);
          if (tripArea !== "unknown") driverCurrentArea.set(assigned, tripArea);
        }
      }

      draftAssignments.push({ draft, driverId: assigned });
    }

    // ── 8. Assegna mezzi (il più piccolo che soddisfa PAX + vincoli hotel + autista) ─

    const pickVehicle = (pax: number, draft: TripDraft, driverId: string | null): VehicleRow | null => {
      const tripMin = timeToMin(draft.time);

      // Calcola la capienza massima consentita per questo giro:
      // 1. Limite hotel: minima max_capacity tra tutti gli hotel del giro
      const hotelIds = draft.serviceIds
        .map((sid) => allServices.find((s) => s.id === sid)?.hotel_id)
        .filter((id): id is string => Boolean(id));
      const hotelMaxCap = hotelIds.reduce<number | null>((min, hid) => {
        const limit = hotelVehicleLimitMap.get(hid);
        if (limit == null) return min;
        return min == null ? limit : Math.min(min, limit);
      }, null);

      // 2. Limite autista: max_vehicle_capacity del driver
      const driver = driverId ? allDrivers.find((d) => d.user_id === driverId) : null;
      const driverMaxCap = driver?.max_vehicle_capacity ?? null;

      // Capienza massima finale: il più restrittivo tra hotel e autista
      const hardMaxCap = hotelMaxCap != null && driverMaxCap != null
        ? Math.min(hotelMaxCap, driverMaxCap)
        : hotelMaxCap ?? driverMaxCap ?? null;

      // Cerca il veicolo più piccolo che soddisfa i PAX, rispetta i limiti e non ha blocchi orari
      const candidate = vehicles.find((v) => {
        const cap = v.capacity ?? 0;
        if (cap < pax) return false;
        if (hardMaxCap != null && cap > hardMaxCap) return false;
        if (!vehicleAvailableAtTime(v.id, tripMin, vehicleAvailByIdMap, vehicleBlocksByIdMap)) return false;
        return true;
      });
      if (candidate) return candidate;

      // Fallback: veicolo più grande disponibile (anche se non soddisfa i vincoli di capienza)
      const fallback = [...vehicles]
        .filter((v) => vehicleAvailableAtTime(v.id, tripMin, vehicleAvailByIdMap, vehicleBlocksByIdMap))
        .sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0))[0];
      return fallback ?? null;
    };

    // ── 9. Persisti giri (batch — O(4) invece di O(n×4)) ────────────────────

    let assignedCount = 0;
    let tripsCreated = 0;
    const errors: string[] = [];
    const batchAdmin = auth.admin as SupabaseClient;

    if (draftAssignments.length > 0) {
      // Seleziona veicoli per tutti i giri, poi crea tutti i trip_groups in un unico insert
      const prepared = draftAssignments.map(({ draft, driverId }) => ({
        draft,
        driverId,
        vehicle: pickVehicle(draft.pax, draft, driverId),
      }));

      const groupRows = prepared.map(({ draft: _, driverId, vehicle }) => ({
        tenant_id: tenantId,
        date,
        driver_user_id: driverId,
        vehicle_label: vehicle?.label ?? null,
        vehicle_capacity: vehicle?.capacity ?? null,
        notes: null,
        created_by: userId,
        created_at: now,
        updated_at: now,
      }));

      const { data: groups, error: groupsErr } = await auth.admin
        .from("trip_groups")
        .insert(groupRows)
        .select("id");

      if (groupsErr || !groups?.length) {
        errors.push(`Errore creazione giri: ${groupsErr?.message ?? "nessun ID restituito"}`);
      } else {
        const allAssignRows: Array<{
          tenant_id: string; service_id: string;
          driver_user_id: string | null; vehicle_label: string; group_id: string;
        }> = [];
        const allServiceIds: string[] = [];
        const allStatusEvents: Array<{
          tenant_id: string; service_id: string; status: string; at: string; by_user_id: string;
        }> = [];

        for (let i = 0; i < groups.length; i++) {
          const { draft, driverId, vehicle } = prepared[i];
          const groupId = (groups[i] as { id: string }).id;
          for (const sid of draft.serviceIds) {
            allAssignRows.push({
              tenant_id: tenantId, service_id: sid,
              driver_user_id: driverId, vehicle_label: vehicle?.label ?? "", group_id: groupId,
            });
            allServiceIds.push(sid);
            allStatusEvents.push({ tenant_id: tenantId, service_id: sid, status: "assigned", at: now, by_user_id: userId });
          }
          tripsCreated++;
          assignedCount += draft.serviceIds.length;
        }

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

    const unassignedCount = toAssign.length - assignedCount;
    const geoBlockedServices = toAssign.filter((service) => {
      if (!service.hotel_id) return true;
      const hotel = hotelMap.get(service.hotel_id);
      return !hotel || geoBlockedByHotelId.has(service.hotel_id);
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
