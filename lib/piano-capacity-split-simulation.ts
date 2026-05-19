import { proposeVehicleDailyRealignment, type VehicleBindingProposalDriver, type VehicleBindingProposalVehicle } from "@/lib/piano-vehicle-binding-proposal";

export type CapacitySplitService = {
  service_id: string;
  pax: number;
  customer_name?: string | null;
  pickup_label?: string | null;
  destination_label?: string | null;
  direction?: string | null;
  booking_service_kind?: string | null;
  operational_time?: string | null;
};

export type CapacityCriticalGroup = {
  group_id: string;
  driver_key: string;
  driver_name: string;
  current_vehicle_label?: string | null;
  current_vehicle_capacity?: number | null;
  pax: number;
  start_time?: string | null;
  services: CapacitySplitService[];
};

export type CapacitySplitProposal = {
  group_id: string;
  driver_name: string;
  pax: number;
  split_possible: boolean;
  reason: string;
  chunks: Array<{
    pax: number;
    service_ids: string[];
    suggested_vehicle_capacity: number | null;
  }>;
};

export type CapacitySimulationDecision =
  | "AGGIUNGERE_MEZZO_25"
  | "SPLITTARE_GIRO"
  | "CAMBIARE_BINDING"
  | "OVERRIDE_MANUALE"
  | "NON_RISOLVIBILE_CON_DATI_ATTUALI";

export type CapacitySimulationResult = {
  binding_before: ReturnType<typeof proposeVehicleDailyRealignment>;
  split_proposals: CapacitySplitProposal[];
  after: {
    vehicle_conflicts_after: number;
    overbooking_after: number;
    drivers_without_vehicle_after: number;
    split_needed: number;
    simulated_new_groups: number;
  };
  decision: CapacitySimulationDecision;
  decision_reason: string;
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function sameValue(values: Array<string | null | undefined>) {
  const normalized = new Set(values.map((value) => clean(value)?.toUpperCase() ?? ""));
  return normalized.size <= 1;
}

function isMandatorySameStop(group: CapacityCriticalGroup) {
  if (group.services.length <= 1) return true;
  return sameValue(group.services.map((service) => service.operational_time)) &&
    sameValue(group.services.map((service) => service.pickup_label)) &&
    sameValue(group.services.map((service) => service.destination_label)) &&
    sameValue(group.services.map((service) => service.direction));
}

function serviceSortKey(service: CapacitySplitService) {
  return [
    clean(service.destination_label) ?? "",
    clean(service.pickup_label) ?? "",
    clean(service.operational_time) ?? "",
    clean(service.customer_name) ?? "",
    service.service_id,
  ].join("|");
}

export function proposeCapacitySplit(group: CapacityCriticalGroup, vehicles: VehicleBindingProposalVehicle[]): CapacitySplitProposal {
  const capacitiesAscending = [...new Set(vehicles.map((vehicle) => vehicle.capacity).filter((capacity): capacity is number => typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0))]
    .sort((a, b) => a - b);
  const capacitiesDescending = [...capacitiesAscending].sort((a, b) => b - a);
  const largestCapacity = capacitiesDescending[0] ?? null;

  if (largestCapacity == null) {
    return {
      group_id: group.group_id,
      driver_name: group.driver_name,
      pax: group.pax,
      split_possible: false,
      reason: "Capienza mezzi non disponibile.",
      chunks: [],
    };
  }

  if (isMandatorySameStop(group)) {
    return {
      group_id: group.group_id,
      driver_name: group.driver_name,
      pax: group.pax,
      split_possible: false,
      reason: group.services.length <= 1
        ? "Singolo servizio: split automatico non applicabile senza decisione operatore."
        : "Same-stop obbligatorio: split automatico non consigliato.",
      chunks: [],
    };
  }

  if (group.pax <= largestCapacity) {
    return {
      group_id: group.group_id,
      driver_name: group.driver_name,
      pax: group.pax,
      split_possible: false,
      reason: "Giro gia compatibile con almeno un mezzo disponibile.",
      chunks: [{ pax: group.pax, service_ids: group.services.map((service) => service.service_id), suggested_vehicle_capacity: largestCapacity }],
    };
  }

  const chunks: CapacitySplitProposal["chunks"] = [];
  const sortedServices = [...group.services].sort((a, b) => serviceSortKey(a).localeCompare(serviceSortKey(b)));

  for (const service of sortedServices) {
    const pax = Math.max(0, Number(service.pax) || 0);
    const existing = chunks.find((chunk) => chunk.pax + pax <= (chunk.suggested_vehicle_capacity ?? 0));
    if (existing) {
      existing.pax += pax;
      existing.service_ids.push(service.service_id);
      continue;
    }
    const capacity = capacitiesAscending.find((candidate) => candidate >= pax) ?? null;
    if (!capacity) {
      return {
        group_id: group.group_id,
        driver_name: group.driver_name,
        pax: group.pax,
        split_possible: false,
        reason: `Servizio ${service.service_id} da ${pax} pax non compatibile con i mezzi disponibili.`,
        chunks: [],
      };
    }
    chunks.push({ pax, service_ids: [service.service_id], suggested_vehicle_capacity: capacity });
  }

  return {
    group_id: group.group_id,
    driver_name: group.driver_name,
    pax: group.pax,
    split_possible: chunks.length > 1 && chunks.every((chunk) => chunk.suggested_vehicle_capacity != null && chunk.pax <= chunk.suggested_vehicle_capacity),
    reason: chunks.length > 1 ? "Split simulabile per servizi distinti, da confermare operativamente." : "Split non necessario dopo raggruppamento servizi.",
    chunks,
  };
}

export function simulateCapacityResolution(args: {
  drivers: VehicleBindingProposalDriver[];
  vehicles: VehicleBindingProposalVehicle[];
  criticalGroups: CapacityCriticalGroup[];
}): CapacitySimulationResult {
  const bindingBefore = proposeVehicleDailyRealignment({ drivers: args.drivers, vehicles: args.vehicles });
  const splitProposals = args.criticalGroups.map((group) => proposeCapacitySplit(group, args.vehicles));
  const usableSplits = splitProposals.filter((proposal) => proposal.split_possible);
  const unresolvedDrivers = new Set(bindingBefore.drivers_without_vehicle_after);

  for (const split of usableSplits) {
    unresolvedDrivers.delete(split.driver_name);
  }

  const after = {
    vehicle_conflicts_after: bindingBefore.conflicts_after.length,
    overbooking_after: bindingBefore.overbooking_after.length,
    drivers_without_vehicle_after: unresolvedDrivers.size,
    split_needed: usableSplits.length > 0 ? 1 : 0,
    simulated_new_groups: usableSplits.length > 0 ? usableSplits[0]!.chunks.length - 1 : 0,
  };

  let decision: CapacitySimulationDecision = "NON_RISOLVIBILE_CON_DATI_ATTUALI";
  let decisionReason = "I dati disponibili non producono una soluzione senza scritture o override.";
  if (bindingBefore.drivers_without_vehicle_after.length === 0 && bindingBefore.overbooking_after.length === 0) {
    decision = "CAMBIARE_BINDING";
    decisionReason = "Il solo cambio binding risolve capienza e conflitti.";
  } else if (after.drivers_without_vehicle_after === 0 && after.overbooking_after === 0) {
    decision = "SPLITTARE_GIRO";
    decisionReason = "Uno split read-only simulato elimina il blocker di capienza.";
  } else if (bindingBefore.drivers_without_vehicle_after.some((driverName) => {
    const driver = args.drivers.find((item) => item.driver_name === driverName);
    const maxUnusedCapacity = Math.max(0, ...bindingBefore.unused_vehicles_after.map((vehicle) => vehicle.capacity ?? 0));
    return (driver?.max_pax ?? 0) > maxUnusedCapacity;
  }) || splitProposals.some((proposal) => !proposal.split_possible && proposal.reason.includes("Singolo servizio"))) {
    decision = "AGGIUNGERE_MEZZO_25";
    decisionReason = "Resta un autista senza mezzo compatibile e i giri critici sono singoli servizi non splittabili automaticamente.";
  } else if (bindingBefore.drivers_without_vehicle_after.length > 0) {
    decision = "OVERRIDE_MANUALE";
    decisionReason = "Resta almeno un autista senza mezzo compatibile: serve scelta operatore tracciata.";
  }

  return {
    binding_before: bindingBefore,
    split_proposals: splitProposals,
    after,
    decision,
    decision_reason: decisionReason,
  };
}
