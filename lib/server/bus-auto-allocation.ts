import type { SupabaseClient } from "@supabase/supabase-js";
import { findBusStopsByCity, resolveBusStop } from "@/lib/server/bus-lines-catalog";
import { deriveServiceBusIdentity } from "@/lib/server/bus-network";
import type { AgencyBookingServiceKind, OperationalServiceType } from "@/lib/types";

type BusDirection = "arrival" | "departure";

type ServiceRow = {
  id: string;
  date: string | null;
  time: string | null;
  outbound_time: string | null;
  direction: BusDirection | null;
  pax: number | null;
  customer_name: string | null;
  bus_city_origin: string | null;
  transport_code: string | null;
  service_type_code: string | null;
  booking_service_kind: string | null;
};

type BusLineRow = {
  id: string;
  code: string;
  name: string;
  family_code: string;
};

type BusStopRow = {
  id: string;
  bus_line_id: string;
  direction: BusDirection;
  stop_name: string;
  city: string;
  stop_order: number | null;
};

type BusUnitRow = {
  id: string;
  bus_line_id: string;
  label: string;
  capacity: number;
  status: string | null;
  sort_order: number | null;
};

type AllocationRow = {
  service_id: string;
  bus_unit_id: string;
  bus_line_id: string | null;
  stop_id: string | null;
  pax_assigned: number | null;
};

export type BusAutoAllocationResult =
  | { ok: true; allocated: true; serviceId: string; busUnitId: string; busLabel: string; stopId: string; stopName: string; pax: number }
  | { ok: true; allocated: false; serviceId: string; reason: string };

function normCity(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pickBusWithAvailability(
  units: BusUnitRow[],
  datePaxByBus: Map<string, number>,
  stopBusMap: Map<string, Set<string>>,
  input: { lineId: string; stopId: string; pax: number }
) {
  const lineUnits = units.filter((unit) =>
    unit.bus_line_id === input.lineId &&
    unit.status !== "closed" &&
    unit.status !== "completed"
  );
  const hasRoom = (unit: BusUnitRow) => unit.capacity - (datePaxByBus.get(unit.id) ?? 0) >= input.pax;

  const sameStopBusIds = stopBusMap.get(`${input.lineId}:${input.stopId}`) ?? new Set<string>();
  const sameStop = lineUnits.find((unit) => sameStopBusIds.has(unit.id) && hasRoom(unit));
  if (sameStop) return sameStop;

  return lineUnits.find(hasRoom) ?? null;
}

export async function autoAllocateBusService(params: {
  admin: SupabaseClient;
  tenantId: string;
  serviceId: string;
  userId: string;
}): Promise<BusAutoAllocationResult> {
  const { admin, tenantId, serviceId, userId } = params;

  const serviceRes = await admin
    .from("services")
    .select("id,date,time,outbound_time,direction,pax,customer_name,bus_city_origin,transport_code,service_type_code,booking_service_kind")
    .eq("tenant_id", tenantId)
    .eq("id", serviceId)
    .maybeSingle();

  if (serviceRes.error) return { ok: true, allocated: false, serviceId, reason: serviceRes.error.message };
  const service = serviceRes.data as ServiceRow | null;
  if (!service) return { ok: true, allocated: false, serviceId, reason: "Servizio non trovato" };
  if (service.booking_service_kind !== "bus_city_hotel" && service.service_type_code !== "bus_line") {
    return { ok: true, allocated: false, serviceId, reason: "Non è una prenotazione linea bus" };
  }
  if (!service.date || !service.direction || !service.pax || service.pax <= 0) {
    return { ok: true, allocated: false, serviceId, reason: "Dati bus incompleti" };
  }

  const existingAlloc = await admin
    .from("tenant_bus_allocations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("service_id", serviceId)
    .limit(1);
  if (existingAlloc.error) return { ok: true, allocated: false, serviceId, reason: existingAlloc.error.message };
  if ((existingAlloc.data ?? []).length > 0) {
    return { ok: true, allocated: false, serviceId, reason: "Già allocato" };
  }

  const [linesRes, stopsRes, unitsRes, allocRes] = await Promise.all([
    admin.from("tenant_bus_lines").select("id,code,name,family_code").eq("tenant_id", tenantId).eq("active", true),
    admin
      .from("tenant_bus_line_stops")
      .select("id,bus_line_id,direction,stop_name,city,stop_order")
      .eq("tenant_id", tenantId)
      .eq("direction", service.direction)
      .eq("active", true),
    admin
      .from("tenant_bus_units")
      .select("id,bus_line_id,label,capacity,status,sort_order")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .order("sort_order"),
    admin
      .from("tenant_bus_allocations")
      .select("service_id,bus_unit_id,bus_line_id,stop_id,pax_assigned,services!inner(date,direction)")
      .eq("tenant_id", tenantId)
      .eq("services.date", service.date)
      .eq("services.direction", service.direction),
  ]);

  if (linesRes.error) return { ok: true, allocated: false, serviceId, reason: linesRes.error.message };
  if (stopsRes.error) return { ok: true, allocated: false, serviceId, reason: stopsRes.error.message };
  if (unitsRes.error) return { ok: true, allocated: false, serviceId, reason: unitsRes.error.message };
  if (allocRes.error) return { ok: true, allocated: false, serviceId, reason: allocRes.error.message };

  const lines = (linesRes.data ?? []) as BusLineRow[];
  const stops = (stopsRes.data ?? []) as BusStopRow[];
  const units = ((unitsRes.data ?? []) as BusUnitRow[]).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const allocations = (allocRes.data ?? []) as AllocationRow[];

  const identity = deriveServiceBusIdentity({
    transport_code: service.transport_code,
    bus_city_origin: service.bus_city_origin,
    outbound_time: service.outbound_time,
    time: service.time ?? "",
    service_type_code: service.service_type_code as OperationalServiceType | null,
    booking_service_kind: service.booking_service_kind as AgencyBookingServiceKind | null,
  });
  const line = lines.find((candidate) => candidate.family_code === identity.family_code || candidate.code === identity.lineCode);
  if (!line) return { ok: true, allocated: false, serviceId, reason: "Linea non trovata" };

  const reqCity = normCity(service.bus_city_origin);
  const identCity = normCity(identity.city);
  const aliasCities = findBusStopsByCity(service.bus_city_origin).map((entry) => normCity(entry.stop.city));
  const stop = stops.find((candidate) => {
    if (candidate.bus_line_id !== line.id) return false;
    const stopName = normCity(candidate.stop_name);
    const stopCity = normCity(candidate.city);
    return (
      stopName === reqCity ||
      stopCity === reqCity ||
      stopName === identCity ||
      stopCity === identCity ||
      aliasCities.includes(stopName) ||
      aliasCities.includes(stopCity) ||
      (reqCity.length > 2 && (stopName.includes(reqCity) || stopCity.includes(reqCity) || reqCity.includes(stopName) || reqCity.includes(stopCity)))
    );
  });

  if (!stop) {
    const catalogMatch = resolveBusStop(service.bus_city_origin);
    const reason = catalogMatch && catalogMatch.familyCode !== line.family_code
      ? `${service.bus_city_origin ?? "Fermata"} appartiene a ${catalogMatch.familyName}`
      : `Fermata non trovata per ${service.bus_city_origin ?? "N/D"}`;
    return { ok: true, allocated: false, serviceId, reason };
  }

  const datePaxByBus = new Map<string, number>();
  const stopBusMap = new Map<string, Set<string>>();
  for (const allocation of allocations) {
    datePaxByBus.set(allocation.bus_unit_id, (datePaxByBus.get(allocation.bus_unit_id) ?? 0) + (allocation.pax_assigned ?? 0));
    if (allocation.bus_line_id && allocation.stop_id) {
      const key = `${allocation.bus_line_id}:${allocation.stop_id}`;
      if (!stopBusMap.has(key)) stopBusMap.set(key, new Set());
      stopBusMap.get(key)!.add(allocation.bus_unit_id);
    }
  }

  const chosenBus = pickBusWithAvailability(units, datePaxByBus, stopBusMap, {
    lineId: line.id,
    stopId: stop.id,
    pax: service.pax,
  });
  if (!chosenBus) return { ok: true, allocated: false, serviceId, reason: "Nessun bus con posti disponibili" };

  const allocRpc = await admin.rpc("allocate_bus_service", {
    p_tenant_id: tenantId,
    p_service_id: serviceId,
    p_bus_line_id: line.id,
    p_bus_unit_id: chosenBus.id,
    p_stop_id: stop.id,
    p_stop_name: stop.stop_name,
    p_direction: service.direction,
    p_pax_assigned: service.pax,
    p_notes: null,
    p_created_by_user_id: userId,
  });

  if (allocRpc.error) return { ok: true, allocated: false, serviceId, reason: allocRpc.error.message };
  return {
    ok: true,
    allocated: true,
    serviceId,
    busUnitId: chosenBus.id,
    busLabel: chosenBus.label,
    stopId: stop.id,
    stopName: stop.stop_name,
    pax: service.pax,
  };
}
