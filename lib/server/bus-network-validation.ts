import type { PricingAuthContext } from "@/lib/server/pricing-auth";
import { deriveServiceBusIdentity } from "@/lib/server/bus-network";
import type { Service } from "@/lib/types";

type BusLineRow = {
  id: string;
  code: string;
  name: string;
  family_code: string;
  family_name: string;
  active: boolean;
};

type BusUnitRow = {
  id: string;
  bus_line_id: string;
  label: string;
  capacity: number;
  status: "open" | "low" | "closed" | "completed";
};

type BusStopRow = {
  id: string;
  bus_line_id: string;
  direction: "arrival" | "departure";
  stop_name: string;
  city: string;
  active: boolean;
};

type AllocationRow = {
  id: string;
  service_id: string;
  bus_line_id: string;
  bus_unit_id: string;
  stop_id: string | null;
  stop_name: string;
  direction: "arrival" | "departure";
  pax_assigned: number;
};

export async function validateBusAllocationRequest(
  auth: PricingAuthContext,
  input: {
    tenantId: string;
    serviceId: string;
    busLineId: string;
    busUnitId: string;
    stopId: string;
    stopName: string;
    direction: "arrival" | "departure";
  }
) {
  const [serviceResult, lineResult, unitResult, stopResult] = await Promise.all([
    auth.admin.from("services").select("*").eq("tenant_id", input.tenantId).eq("id", input.serviceId).maybeSingle(),
    auth.admin.from("tenant_bus_lines").select("id,code,name,family_code,family_name,active").eq("tenant_id", input.tenantId).eq("id", input.busLineId).maybeSingle(),
    auth.admin.from("tenant_bus_units").select("id,bus_line_id,label,capacity,status").eq("tenant_id", input.tenantId).eq("id", input.busUnitId).maybeSingle(),
    auth.admin.from("tenant_bus_line_stops").select("id,bus_line_id,direction,stop_name,city,active").eq("tenant_id", input.tenantId).eq("id", input.stopId).maybeSingle()
  ]);

  const error = serviceResult.error || lineResult.error || unitResult.error || stopResult.error;
  if (error) throw new Error(error.message);

  const service = serviceResult.data as Service | null;
  const line = lineResult.data as BusLineRow | null;
  const unit = unitResult.data as BusUnitRow | null;
  const stop = stopResult.data as BusStopRow | null;

  if (!service) throw new Error("Servizio non trovato.");
  if (!line || !line.active) throw new Error("Linea bus non trovata.");
  if (!unit) throw new Error("Bus non trovato.");
  if (!stop || !stop.active) throw new Error("Fermata non trovata.");

  if (service.direction !== input.direction) {
    throw new Error("Direzione servizio e fermata non coerenti.");
  }

  if (unit.bus_line_id !== line.id) {
    throw new Error("Il bus selezionato non appartiene alla linea scelta.");
  }

  if (stop.bus_line_id !== line.id) {
    throw new Error("La fermata selezionata non appartiene alla linea scelta.");
  }

  if (stop.direction !== input.direction) {
    throw new Error("La fermata selezionata non appartiene alla direzione scelta.");
  }

  if (stop.stop_name !== input.stopName) {
    throw new Error("Nome fermata incoerente con lo stop selezionato.");
  }

  const serviceIdentity = deriveServiceBusIdentity(service);
  const isBusService = service.booking_service_kind === "bus_city_hotel" || service.service_type_code === "bus_line";

  if (!isBusService) {
    throw new Error("Il servizio selezionato non appartiene al flusso bus operativo.");
  }

  if (serviceIdentity.family_code !== line.family_code) {
    throw new Error("Il servizio selezionato non e coerente con la linea bus scelta.");
  }

  return { service, line, unit, stop, serviceIdentity };
}

export async function validateBusMoveRequest(
  auth: PricingAuthContext,
  input: {
    tenantId: string;
    allocationId: string;
    toBusUnitId: string;
    paxMoved: number;
  }
) {
  const [allocationResult, targetUnitResult] = await Promise.all([
    auth.admin
      .from("tenant_bus_allocations")
      .select("id,service_id,bus_line_id,bus_unit_id,stop_id,stop_name,direction,pax_assigned")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.allocationId)
      .maybeSingle(),
    auth.admin
      .from("tenant_bus_units")
      .select("id,bus_line_id,label,capacity,status")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.toBusUnitId)
      .maybeSingle()
  ]);

  const error = allocationResult.error || targetUnitResult.error;
  if (error) throw new Error(error.message);

  const allocation = allocationResult.data as AllocationRow | null;
  const targetUnit = targetUnitResult.data as BusUnitRow | null;

  if (!allocation) throw new Error("Allocazione non trovata.");
  if (!targetUnit) throw new Error("Bus destinazione non trovato.");

  if (input.paxMoved <= 0) {
    throw new Error("Numero pax da spostare non valido.");
  }

  if (input.paxMoved > allocation.pax_assigned) {
    throw new Error("Non puoi spostare piu pax di quelli assegnati.");
  }

  if (allocation.bus_unit_id === targetUnit.id) {
    throw new Error("Il bus destinazione deve essere diverso dal bus origine.");
  }

  if (allocation.bus_line_id !== targetUnit.bus_line_id) {
    throw new Error("Il bus destinazione deve appartenere alla stessa linea.");
  }

  const { data: targetAllocations, error: targetAllocationsError } = await auth.admin
    .from("tenant_bus_allocations")
    .select("pax_assigned")
    .eq("tenant_id", input.tenantId)
    .eq("bus_unit_id", targetUnit.id);

  if (targetAllocationsError) {
    throw new Error(targetAllocationsError.message);
  }

  const assignedToTarget = (targetAllocations ?? []).reduce(
    (total: number, row: { pax_assigned: number | null }) => total + Number(row.pax_assigned ?? 0),
    0
  );
  const remainingSeats = Math.max(0, Number(targetUnit.capacity ?? 0) - assignedToTarget);

  if (input.paxMoved > remainingSeats) {
    throw new Error(`Il bus destinazione non ha posti sufficienti. Residui disponibili: ${remainingSeats}.`);
  }

  return { allocation, targetUnit };
}
