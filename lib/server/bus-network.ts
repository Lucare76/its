import { BUS_LINES_2026, findBusLineByCode, findNearestBusStop } from "@/lib/bus-lines-catalog";
import type { Hotel, Service } from "@/lib/types";

export type BusLineFamilyCode = "ITALIA" | "CENTRO" | "ADRIATICA";

export type BusNetworkLine = {
  code: string;
  name: string;
  family_code: BusLineFamilyCode;
  family_name: string;
  variant_label: string | null;
  default_capacity: number;
  alert_threshold: number;
  active: boolean;
};

export type BusNetworkStop = {
  code: string;
  name: string;
  family_code: BusLineFamilyCode;
  family_name: string;
  direction: "arrival" | "departure";
  stop_name: string;
  city: string;
  pickup_note: string | null;
  stop_order: number;
  lat: number | null;
  lng: number | null;
  is_manual: boolean;
  active: boolean;
};

type RawBusUnit = {
  id: string;
  bus_line_id: string;
  label: string;
  capacity: number;
  low_seat_threshold: number;
  minimum_passengers: number | null;
  status: "open" | "low" | "closed" | "completed";
  manual_close: boolean;
  close_reason: string | null;
  sort_order: number;
  active: boolean;
};

type RawBusAllocation = {
  id: string;
  service_id: string;
  bus_line_id: string;
  bus_unit_id: string;
  stop_id: string | null;
  stop_name: string;
  direction: "arrival" | "departure";
  pax_assigned: number;
  notes: string | null;
};

const DEFAULT_BUS_FAMILY_CAPACITY: Record<BusLineFamilyCode, { buses: number; capacity: number }> = {
  ITALIA: { buses: 5, capacity: 54 },
  CENTRO: { buses: 3, capacity: 54 },
  ADRIATICA: { buses: 1, capacity: 54 }
};

function extractLineNumber(source: string) {
  const normalized = source.toLowerCase();
  const match = normalized.match(/linea[_\s-]*(\d{1,2})/);
  return match ? Number(match[1]) : null;
}

export function deriveBusFamily(code?: string | null, name?: string | null): { family_code: BusLineFamilyCode; family_name: string } {
  const source = `${code ?? ""} ${name ?? ""}`;
  const lineNumber = extractLineNumber(source);
  const normalized = source.toLowerCase();

  if (normalized.includes("linea centro") || normalized.trim() === "centro" || normalized.includes(" family centro")) {
    return { family_code: "CENTRO", family_name: "Linea Centro" };
  }

  if (normalized.includes("linea italia") || normalized.trim() === "italia" || normalized.includes(" family italia")) {
    return { family_code: "ITALIA", family_name: "Linea Italia" };
  }

  if (lineNumber === 11 || normalized.includes("adriatica")) {
    return { family_code: "ADRIATICA", family_name: "Linea Adriatica" };
  }

  if (lineNumber === 7) {
    return { family_code: "CENTRO", family_name: "Linea Centro" };
  }

  return { family_code: "ITALIA", family_name: "Linea Italia" };
}

export function getDefaultBusNetworkLines(): BusNetworkLine[] {
  return ([
    { code: "ITALIA", name: "Linea Italia", family_code: "ITALIA", family_name: "Linea Italia", variant_label: "Linea 1/2/3/4/5/6/8/9/10", default_capacity: 54, alert_threshold: 5, active: true },
    { code: "CENTRO", name: "Linea Centro", family_code: "CENTRO", family_name: "Linea Centro", variant_label: "Linea 7 Centro", default_capacity: 54, alert_threshold: 5, active: true },
    { code: "ADRIATICA", name: "Linea Adriatica", family_code: "ADRIATICA", family_name: "Linea Adriatica", variant_label: "Linea 11 Adriatica", default_capacity: 54, alert_threshold: 5, active: true }
  ] satisfies BusNetworkLine[]);
}

export function getDefaultStopsForLine(code: string): BusNetworkStop[] {
  const directLine = findBusLineByCode(code);
  const familyOnly = !directLine ? deriveBusFamily(code, code) : deriveBusFamily(directLine.code, directLine.name);
  const sourceLines = directLine
    ? [directLine]
    : BUS_LINES_2026.filter((line) => deriveBusFamily(line.code, line.name).family_code === familyOnly.family_code);
  if (sourceLines.length === 0) return [];

  const outwardStops = sourceLines
    .flatMap((line) =>
      line.stops.map((stop) => ({
        code,
        name: code,
        family_code: familyOnly.family_code,
        family_name: familyOnly.family_name,
        stop_name: stop.city,
        city: stop.city,
        pickup_note: stop.pickupNote,
        sort_key: stop.time
      }))
    )
    .sort((left, right) => left.sort_key.localeCompare(right.sort_key))
    .filter((stop, index, all) => all.findIndex((candidate) => candidate.stop_name === stop.stop_name) === index);

  const outbound = outwardStops.map((stop, index) => ({
    code,
    name: code,
    family_code: familyOnly.family_code,
    family_name: familyOnly.family_name,
    direction: "arrival" as const,
    stop_name: stop.stop_name,
    city: stop.city,
    pickup_note: stop.pickup_note,
    stop_order: index + 1,
    lat: null,
    lng: null,
    is_manual: false,
    active: true
  }));
  const inbound = [...outwardStops].reverse().map((stop, index) => ({
    code,
    name: code,
    family_code: familyOnly.family_code,
    family_name: familyOnly.family_name,
    direction: "departure" as const,
    stop_name: stop.stop_name,
    city: stop.city,
    pickup_note: stop.pickup_note,
    stop_order: index + 1,
    lat: null,
    lng: null,
    is_manual: false,
    active: true
  }));
  return [...outbound, ...inbound];
}

export function getDefaultBusUnitsForFamily(lineId: string, familyCode: BusLineFamilyCode) {
  const config = DEFAULT_BUS_FAMILY_CAPACITY[familyCode];
  return Array.from({ length: config.buses }, (_, index) => ({
    bus_line_id: lineId,
    label: `${familyCode} ${index + 1}`,
    capacity: config.capacity,
    low_seat_threshold: 5,
    minimum_passengers: null,
    status: "open" as const,
    manual_close: false,
    close_reason: null,
    sort_order: index + 1,
    active: true
  }));
}

export function deriveServiceBusIdentity(service: Pick<Service, "transport_code" | "bus_city_origin" | "outbound_time" | "time" | "service_type_code" | "booking_service_kind">) {
  const directLine = service.transport_code ? findBusLineByCode(service.transport_code) : null;
  const nearest = !directLine ? findNearestBusStop(service.bus_city_origin, service.outbound_time ?? service.time) : null;
  const lineCode = directLine?.code ?? nearest?.lineCode ?? null;
  const lineName = directLine?.name ?? nearest?.lineName ?? null;
  const family = deriveBusFamily(lineCode, lineName);
  return {
    lineCode,
    lineName,
    family_code: family.family_code,
    family_name: family.family_name,
    city: service.bus_city_origin ?? nearest?.stop.city ?? null,
    stop_name: service.bus_city_origin ?? nearest?.stop.city ?? null
  };
}

export function suggestLocalVehicleType(input: { pax: number; hotelZone?: string | null }) {
  const zone = (input.hotelZone ?? "").toLowerCase();
  if (input.pax >= 7) return "large";
  if (input.pax >= 5) return zone.includes("serrara") || zone.includes("barano") ? "medium" : "large";
  if (zone.includes("serrara") || zone.includes("barano") || zone.includes("forio")) return "small";
  return input.pax >= 3 ? "medium" : "small";
}

export function buildBusUnitLoadSummary(units: RawBusUnit[], allocations: RawBusAllocation[]) {
  const paxByUnit = new Map<string, number>();
  for (const allocation of allocations) {
    paxByUnit.set(allocation.bus_unit_id, (paxByUnit.get(allocation.bus_unit_id) ?? 0) + allocation.pax_assigned);
  }
  return units.map((unit) => {
    const pax = paxByUnit.get(unit.id) ?? 0;
    const remaining = Math.max(0, unit.capacity - pax);
    const suggestedStatus =
      unit.status === "completed" || unit.status === "closed"
        ? unit.status
        : remaining <= 0
          ? "closed"
          : remaining <= unit.low_seat_threshold
            ? "low"
            : "open";
    return {
      ...unit,
      pax_assigned: pax,
      remaining_seats: remaining,
      suggested_status: suggestedStatus
    };
  });
}

export function buildStopLoadSummary(stops: BusNetworkStop[], allocations: RawBusAllocation[]) {
  const paxByStop = new Map<string, number>();
  for (const allocation of allocations) {
    const key = `${allocation.direction}|${allocation.stop_name.toLowerCase()}`;
    paxByStop.set(key, (paxByStop.get(key) ?? 0) + allocation.pax_assigned);
  }
  return stops
    .filter((stop) => stop.active)
    .map((stop) => ({
      ...stop,
      pax_assigned: paxByStop.get(`${stop.direction}|${stop.stop_name.toLowerCase()}`) ?? 0
    }))
    .sort((left, right) => {
      if (left.direction !== right.direction) return left.direction.localeCompare(right.direction);
      return left.stop_order - right.stop_order;
    });
}

export function suggestBusRedistribution(units: RawBusUnit[], allocations: RawBusAllocation[]) {
  const loads = buildBusUnitLoadSummary(units, allocations).sort((a, b) => a.remaining_seats - b.remaining_seats);
  const overloaded = loads.filter((unit) => unit.remaining_seats <= unit.low_seat_threshold && unit.status !== "closed" && unit.status !== "completed");
  const receivers = loads.filter((unit) => unit.remaining_seats > unit.low_seat_threshold && unit.status === "open");
  return overloaded.map((source) => {
    const target = receivers.find((unit) => unit.id !== source.id && unit.remaining_seats >= Math.max(1, Math.ceil(source.pax_assigned * 0.1)));
    return {
      source_unit_id: source.id,
      source_label: source.label,
      target_unit_id: target?.id ?? null,
      target_label: target?.label ?? null,
      reason: target ? "Ridistribuzione consigliata: alleggerire bus quasi pieno." : "Nessun bus compatibile disponibile."
    };
  });
}

export function buildArrivalWindowSummary(services: Service[]) {
  const grouped = new Map<string, { time: string; totalPax: number; snavPax: number; medmarPax: number; otherPax: number; refs: string[] }>();
  for (const service of services) {
    const time = (service.arrival_time || service.time || "00:00").slice(0, 5);
    const existing = grouped.get(time) ?? { time, totalPax: 0, snavPax: 0, medmarPax: 0, otherPax: 0, refs: [] };
    existing.totalPax += service.pax;
    const vessel = `${service.vessel ?? ""} ${service.transport_code ?? ""}`.toLowerCase();
    if (vessel.includes("snav")) existing.snavPax += service.pax;
    else if (vessel.includes("medmar")) existing.medmarPax += service.pax;
    else existing.otherPax += service.pax;
    existing.refs.push(`${service.customer_name} (${service.pax})`);
    grouped.set(time, existing);
  }
  return Array.from(grouped.values()).sort((left, right) => left.time.localeCompare(right.time));
}

export function buildGeographicSuggestions(input: {
  services: Service[];
  hotels: Hotel[];
  stops: Array<{ stop_name: string; city: string; stop_order: number; direction: "arrival" | "departure"; lat?: number | null; lng?: number | null }>;
}) {
  const hotelsById = new Map(input.hotels.map((hotel) => [hotel.id, hotel]));
  const suggestions = input.services.map((service) => {
    const hotel = hotelsById.get(service.hotel_id);
    const stop = input.stops.find((item) => item.city.toLowerCase() === (service.bus_city_origin ?? "").toLowerCase() && item.direction === service.direction);
    return {
      service_id: service.id,
      customer_name: service.customer_name,
      stop_name: stop?.stop_name ?? service.bus_city_origin ?? "Fermata da definire",
      grouped_zone: hotel?.zone ?? "N/D",
      suggested_vehicle_type: suggestLocalVehicleType({ pax: service.pax, hotelZone: hotel?.zone }).toUpperCase(),
      suggested_stop_order: stop?.stop_order ?? null
    };
  });
  return suggestions;
}
