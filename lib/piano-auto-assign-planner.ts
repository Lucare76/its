import type { AssignableMacroCategory } from "@/lib/piano-assignable-service";
import type { AutoAssignPreviewServiceRow } from "@/lib/piano-assignable-preview";
import {
  findVehicleTimelineConflict,
  vehicleResourceKey,
  vehicleUsageCount,
  type VehicleTimelineEntry,
} from "@/lib/piano-vehicle-timeline";
import { buildVehicleDailyBinding } from "@/lib/piano-vehicle-daily-binding";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";

export type PlannerDriver = {
  id: string;
  name: string;
  available?: boolean | null;
  available_from?: string | null;
  available_to?: string | null;
  max_vehicle_capacity?: number | null;
};

export type PlannerVehicle = {
  id: string;
  label: string;
  capacity: number | null;
  available?: boolean | null;
};

export type PlannerLockedAssignment = {
  service_id: string;
  driver_id: string | null;
  driver_name?: string | null;
  vehicle_id?: string | null;
  vehicle_label: string | null;
};

export type PlannerProposedService = Pick<
  AutoAssignPreviewServiceRow,
  | "service_id"
  | "customer_name"
  | "macro_category"
  | "operational_time"
  | "pickup_label"
  | "pickup_zone"
  | "destination_label"
  | "destination_zone"
  | "pax"
>;

export type PlannerProposedGroup = {
  temp_group_id: string;
  driver_id: string;
  driver_name: string;
  vehicle_id: string;
  vehicle_label: string;
  services: PlannerProposedService[];
  start_time: string;
  end_time: string;
  total_pax: number;
  macro_categories: AssignableMacroCategory[];
  zones: string[];
  score: number;
  confidence: number;
  explanation: string[];
  warnings: string[];
};

export type PlannerResult = {
  proposed_groups: PlannerProposedGroup[];
  unplanned: Array<{ service_id: string; customer_name: string | null; reason: string }>;
  conflicts: Array<{ service_id: string; conflict_type: string; reason: string }>;
  protected_locked: Array<{
    service_id: string;
    customer_name: string | null;
    driver_id: string | null;
    driver_name: string | null;
    vehicle_id: string | null;
    vehicle_label: string | null;
    operational_time: string | null;
  }>;
  summary: {
    candidate_services: number;
    proposed_groups_count: number;
    planned_services_count: number;
    unplanned_count: number;
    conflict_count: number;
    locked_count: number;
  };
};

type DriverEvent = {
  time: number;
  zone: string | null;
  driverId: string;
};

type CandidateEvaluation = {
  ok: boolean;
  score: number;
  buffer: number;
  warnings: string[];
  explanation: string[];
  reason?: string;
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalize(value?: string | null) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() ?? "";
}

function minutes(value?: string | null) {
  const [h = "0", m = "0"] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number.parseInt(h, 10);
  const minute = Number.parseInt(m, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

function formatMinutes(total: number) {
  const normalized = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function area(zone?: string | null): "north_west" | "east_south" | null {
  const text = normalize(zone);
  if (!text) return null;
  if (/(forio|lacco|casamicciola|sant angelo|serrara|fontana|panza|citara|cuotto)/.test(text)) return "north_west";
  if (/(ischia|barano|testaccio|fiaiano|cartaromana)/.test(text)) return "east_south";
  return null;
}

function sameText(left?: string | null, right?: string | null) {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function serviceStartZone(service: AutoAssignPreviewServiceRow) {
  return service.pickup_zone ?? service.pickup_label;
}

function serviceEndZone(service: AutoAssignPreviewServiceRow) {
  return service.destination_zone ?? service.destination_label;
}

export function estimateTravelBuffer(
  previous: Pick<AutoAssignPreviewServiceRow, "destination_label" | "destination_zone" | "macro_category" | "pax">,
  next: Pick<AutoAssignPreviewServiceRow, "pickup_label" | "pickup_zone" | "macro_category" | "pax">
): { minutes: number; warning: string | null } {
  let base: number;
  const fromLabel = previous.destination_label;
  const toLabel = next.pickup_label;
  const fromZone = serviceEndZone(previous as AutoAssignPreviewServiceRow);
  const toZone = serviceStartZone(next as AutoAssignPreviewServiceRow);
  const fromArea = area(fromZone);
  const toArea = area(toZone);

  if (sameText(fromLabel, toLabel)) base = 5;
  else if (sameText(fromZone, toZone)) base = 15;
  else if (fromArea && toArea && fromArea === toArea) base = 25;
  else if (fromArea && toArea) base = 50;
  else base = 60;

  if ((previous.pax ?? 0) >= 15 || (next.pax ?? 0) >= 15) base += 10;
  if (previous.macro_category === "ESCURSIONE" || next.macro_category === "ESCURSIONE") base = Math.max(base, 15);

  return {
    minutes: base,
    warning: !fromArea || !toArea ? "Zona sconosciuta: buffer prudente 60 minuti" : null,
  };
}

function macroCompatible(a: AssignableMacroCategory, b: AssignableMacroCategory) {
  if (a === b) return true;
  if ((a === "ARRIVO" && b === "NAVETTA") || (a === "NAVETTA" && b === "ARRIVO")) return true;
  if ((a === "PARTENZA" && b === "NAVETTA") || (a === "NAVETTA" && b === "PARTENZA")) return true;
  return false;
}

function evaluateAppend(group: PlannerProposedGroup, service: AutoAssignPreviewServiceRow, vehicle: PlannerVehicle): CandidateEvaluation {
  const last = group.services[group.services.length - 1];
  if (!last?.operational_time || !service.operational_time) {
    return { ok: false, score: -200, buffer: 0, warnings: [], explanation: [], reason: "Orario operativo mancante" };
  }

  const available = minutes(service.operational_time) - minutes(last.operational_time);
  const samePickupBatch = last.macro_category === service.macro_category
    && sameText(last.pickup_label, service.pickup_label)
    && ["PARTENZA", "ARRIVO", "NAVETTA", "ESCURSIONE"].includes(service.macro_category);
  const buffer = samePickupBatch
    ? { minutes: 5, warning: null }
    : estimateTravelBuffer(last, service);
  const totalPax = group.total_pax + (service.pax ?? 0);
  const warnings = buffer.warning ? [buffer.warning] : [];
  const explanation: string[] = [];
  let score = 0;

  if (totalPax > (vehicle.capacity ?? 0)) {
    return { ok: false, score: -100, buffer: buffer.minutes, warnings, explanation, reason: "Capienza mezzo insufficiente" };
  }
  if (available < buffer.minutes) {
    return {
      ok: false,
      score: -200,
      buffer: buffer.minutes,
      warnings,
      explanation,
      reason: `Buffer insufficiente: ${available} minuti disponibili, ${buffer.minutes} richiesti`,
    };
  }
  if (!macroCompatible(last.macro_category, service.macro_category)) {
    return { ok: false, score: -80, buffer: buffer.minutes, warnings, explanation, reason: "Macro-categorie non compatibili" };
  }

  if (sameText(last.destination_label, service.pickup_label)) {
    score += 70;
    explanation.push("Continuita percorso destinazione -> pickup");
  }
  if (samePickupBatch) {
    score += 110;
    explanation.push("Servizi con stesso pickup operativo");
  }
  if (sameText(last.pickup_label, service.pickup_label) || sameText(last.destination_label, service.destination_label)) {
    score += 100;
    explanation.push("Servizi nello stesso punto/hotel");
  }
  if (sameText(serviceStartZone(last as AutoAssignPreviewServiceRow), serviceStartZone(service))) {
    score += 80;
    explanation.push(`Pickup nella stessa zona ${serviceStartZone(service)}`);
  }
  if (last.macro_category === service.macro_category) {
    score += 60;
    explanation.push(`Stesso macro-flusso ${service.macro_category}`);
  }
  if (available <= buffer.minutes + 30) {
    score += 50;
    explanation.push(`Buffer ${buffer.minutes} minuti rispettato`);
  }
  score += 40;
  explanation.push(`Capienza mezzo ${vehicle.capacity ?? "?"}, pax totale ${totalPax}`);

  if (warnings.length > 0) score -= 150;
  if (group.services.length >= 4) score -= 50;
  if (service.macro_category === "ESCURSIONE" && (service.pax ?? 0) >= 15) score -= 80;

  return { ok: score >= 50, score, buffer: buffer.minutes, warnings, explanation };
}

function driverAvailable(driver: PlannerDriver, time: string) {
  if (driver.available === false) return false;
  const value = minutes(time);
  if (driver.available_from && value < minutes(driver.available_from)) return false;
  if (driver.available_to && value >= minutes(driver.available_to)) return false;
  return true;
}

function vehicleAvailable(vehicle: PlannerVehicle) {
  return vehicle.available !== false && (vehicle.capacity ?? 0) > 0;
}

function driverCanUseVehicle(driver: PlannerDriver, vehicle: PlannerVehicle) {
  return canDriverUseVehicle(driver, vehicle).allowed;
}

function smallestVehicleAvailableAt(
  vehicles: PlannerVehicle[],
  pax: number,
  vehicleTimeline: Map<string, VehicleTimelineEntry[]>,
  serviceTime: string,
  driver?: PlannerDriver | null,
  durationMin = 30,
  bufferMin = 20
) {
  const serviceMin = minutes(serviceTime);
  const interval = { start_min: serviceMin, end_min: serviceMin + durationMin };
  return [...vehicles]
    .filter((vehicle) => vehicleAvailable(vehicle) && (vehicle.capacity ?? 0) >= pax)
    .filter((vehicle) => !driver || driverCanUseVehicle(driver, vehicle))
    .filter((vehicle) => {
      const key = vehicleResourceKey({ id: vehicle.id, label: vehicle.label }).key;
      if (!key) return false;
      return !findVehicleTimelineConflict(vehicleTimeline.get(key) ?? [], interval, bufferMin);
    })
    .sort((a, b) =>
      vehicleUsageCount(vehicleTimeline, { id: a.id, label: a.label }) - vehicleUsageCount(vehicleTimeline, { id: b.id, label: b.label }) ||
      (a.capacity ?? 0) - (b.capacity ?? 0) ||
      a.label.localeCompare(b.label)
    )[0] ?? null;
}

function proposedService(service: AutoAssignPreviewServiceRow): PlannerProposedService {
  return {
    service_id: service.service_id,
    customer_name: service.customer_name,
    macro_category: service.macro_category,
    operational_time: service.operational_time,
    pickup_label: service.pickup_label,
    pickup_zone: service.pickup_zone,
    destination_label: service.destination_label,
    destination_zone: service.destination_zone,
    pax: service.pax,
  };
}

function groupZones(services: PlannerProposedService[]) {
  return Array.from(new Set(
    services.flatMap((service) => [service.pickup_zone ?? service.pickup_label, service.destination_zone ?? service.destination_label])
      .map(clean)
      .filter((value): value is string => Boolean(value))
  ));
}

function updateGroup(group: PlannerProposedGroup, service: AutoAssignPreviewServiceRow, evaluation: CandidateEvaluation) {
  group.services.push(proposedService(service));
  group.services.sort((a, b) => String(a.operational_time ?? "").localeCompare(String(b.operational_time ?? "")));
  group.start_time = group.services[0]?.operational_time ?? group.start_time;
  group.end_time = group.services[group.services.length - 1]?.operational_time ?? group.end_time;
  group.total_pax += service.pax ?? 0;
  group.macro_categories = Array.from(new Set(group.services.map((item) => item.macro_category)));
  group.zones = groupZones(group.services);
  group.score = Math.round((group.score + evaluation.score) / 2);
  group.confidence = Math.max(50, Math.min(100, group.confidence - evaluation.warnings.length * 10));
  group.explanation = Array.from(new Set([...group.explanation, ...evaluation.explanation]));
  group.warnings = Array.from(new Set([...group.warnings, ...evaluation.warnings]));
}

function createGroup(
  index: number,
  service: AutoAssignPreviewServiceRow,
  driver: PlannerDriver,
  vehicle: PlannerVehicle
): PlannerProposedGroup {
  const explanations = [
    `${service.macro_category} pianificato come giro ${service.macro_category === "ESCURSIONE" && (service.pax ?? 0) >= 15 ? "dedicato" : "compatibile"}`,
    `Capienza mezzo ${vehicle.capacity ?? "?"}, pax totale ${service.pax ?? 0}`,
  ];
  if (service.pickup_zone) explanations.push(`Pickup nella zona ${service.pickup_zone}`);
  if (service.port_arrival || service.port_departure) explanations.push(`Porto ${service.port_arrival ?? service.port_departure}`);

  return {
    temp_group_id: `preview-${String(index).padStart(4, "0")}`,
    driver_id: driver.id,
    driver_name: driver.name,
    vehicle_id: vehicle.id,
    vehicle_label: vehicle.label,
    services: [proposedService(service)],
    start_time: service.operational_time ?? "00:00",
    end_time: service.operational_time ?? "00:00",
    total_pax: service.pax ?? 0,
    macro_categories: [service.macro_category],
    zones: groupZones([proposedService(service)]),
    score: 90,
    confidence: service.confidence_score,
    explanation: explanations,
    warnings: [],
  };
}

export function planAutoAssignPreview(args: {
  services: AutoAssignPreviewServiceRow[];
  drivers: PlannerDriver[];
  vehicles: PlannerVehicle[];
  availability_confirmed: boolean;
  locked_assignments?: PlannerLockedAssignment[];
}): PlannerResult {
  const protectedLocked = args.services
    .filter((service) => service.is_locked)
    .map((service) => {
      const locked = args.locked_assignments?.find((assignment) => assignment.service_id === service.service_id);
      return {
        service_id: service.service_id,
        customer_name: service.customer_name,
        driver_id: locked?.driver_id ?? null,
        driver_name: locked?.driver_name ?? null,
        vehicle_id: locked?.vehicle_id ?? null,
        vehicle_label: locked?.vehicle_label ?? null,
        operational_time: service.operational_time,
      };
    });

  const candidates = args.services
    .filter((service) =>
      service.assignable &&
      !service.needs_review &&
      !service.is_locked &&
      !service.already_assigned &&
      service.confidence_score >= 80
    )
    .sort((a, b) =>
      String(a.operational_time ?? "").localeCompare(String(b.operational_time ?? "")) ||
      a.macro_category.localeCompare(b.macro_category)
    );

  const unplanned: PlannerResult["unplanned"] = [];
  const conflicts: PlannerResult["conflicts"] = [];
  if (!args.availability_confirmed) {
    return {
      proposed_groups: [],
      unplanned: candidates.map((service) => ({
        service_id: service.service_id,
        customer_name: service.customer_name,
        reason: "Disponibilita del giorno non confermata",
      })),
      conflicts: [],
      protected_locked: protectedLocked,
      summary: {
        candidate_services: candidates.length,
        proposed_groups_count: 0,
        planned_services_count: 0,
        unplanned_count: candidates.length,
        conflict_count: 0,
        locked_count: protectedLocked.length,
      },
    };
  }

  const drivers = args.drivers.filter((driver) => driver.available !== false);
  const vehicles = args.vehicles.filter(vehicleAvailable);
  const fixedVehicleMode = vehicles.length >= drivers.length;
  const groups: PlannerProposedGroup[] = [];
  const driverEvents = new Map<string, DriverEvent[]>();
  for (const locked of protectedLocked) {
    if (!locked.driver_id || !locked.operational_time) continue;
    driverEvents.set(locked.driver_id, [
      ...(driverEvents.get(locked.driver_id) ?? []),
      { time: minutes(locked.operational_time), zone: null, driverId: locked.driver_id },
    ]);
  }
  const dailyBinding = buildVehicleDailyBinding({
    drivers: drivers.map((driver) => ({ driver_id: driver.id, driver_name: driver.name })),
    vehicles,
    assignments: protectedLocked.map((locked) => ({
      driver_id: locked.driver_id,
      driver_name: locked.driver_name,
      id: locked.vehicle_id,
      label: locked.vehicle_label,
    })),
    allowSharedVehicles: !fixedVehicleMode,
  });
  const driverVehicleBinding = new Map<string, PlannerVehicle>();
  const vehicleDriverBinding = new Map<string, string>();
  for (const [driverKey, vehicle] of dailyBinding.driver_to_vehicle.entries()) {
    const driverId = driverKey.replace(/^driver:/, "");
    const matched = vehicles.find((item) =>
      (vehicle.id && item.id === vehicle.id) || (!vehicle.id && vehicle.label && item.label === vehicle.label)
    );
    if (!matched) continue;
    driverVehicleBinding.set(driverId, matched);
    const vehicleKey = vehicleResourceKey({ id: matched.id, label: matched.label }).key;
    if (vehicleKey) vehicleDriverBinding.set(vehicleKey, driverId);
  }
  const vehicleTimeline = new Map<string, VehicleTimelineEntry[]>();
  for (const locked of protectedLocked) {
    if (!locked.vehicle_label || !locked.operational_time) continue;
    const keyInfo = vehicleResourceKey({ id: locked.vehicle_id, label: locked.vehicle_label });
    if (!keyInfo.key) continue;
    const startMin = minutes(locked.operational_time);
    vehicleTimeline.set(keyInfo.key, [
      ...(vehicleTimeline.get(keyInfo.key) ?? []),
      {
        start_min: startMin,
        end_min: startMin + 30,
        driver_id: locked.driver_id,
        driver_name: locked.driver_name,
        vehicle_id: locked.vehicle_id ?? null,
        vehicle_label: locked.vehicle_label,
        warning: keyInfo.warning,
      },
    ]);
  }

  let nextGroupIndex = 1;

  for (const service of candidates) {
    if (!service.operational_time || !service.pickup_label || !service.destination_label) {
      unplanned.push({ service_id: service.service_id, customer_name: service.customer_name, reason: "Servizio operativo incompleto" });
      continue;
    }

    const currentMin = minutes(service.operational_time);
    const compatibleGroups = groups
      .map((group) => {
        const vehicle = vehicles.find((item) => item.id === group.vehicle_id);
        if (!vehicle) return null;
        const evaluation = evaluateAppend(group, service, vehicle);
        return evaluation.ok ? { group, evaluation } : null;
      })
      .filter((value): value is { group: PlannerProposedGroup; evaluation: CandidateEvaluation } => Boolean(value))
      .sort((a, b) => b.evaluation.score - a.evaluation.score);

    const bestGroup = compatibleGroups[0];
    if (bestGroup && bestGroup.evaluation.score >= 80) {
      updateGroup(bestGroup.group, service, bestGroup.evaluation);
      driverEvents.set(bestGroup.group.driver_id, [
        ...(driverEvents.get(bestGroup.group.driver_id) ?? []),
        { time: currentMin, zone: serviceEndZone(service), driverId: bestGroup.group.driver_id },
      ]);
      const keyInfo = vehicleResourceKey({ id: bestGroup.group.vehicle_id, label: bestGroup.group.vehicle_label });
      if (keyInfo.key) vehicleTimeline.set(keyInfo.key, [
        ...(vehicleTimeline.get(keyInfo.key) ?? []),
        {
          start_min: currentMin,
          end_min: currentMin + 30,
          driver_id: bestGroup.group.driver_id,
          driver_name: bestGroup.group.driver_name,
          vehicle_id: bestGroup.group.vehicle_id,
          vehicle_label: bestGroup.group.vehicle_label,
          warning: keyInfo.warning,
        },
      ]);
      continue;
    }

    const driver = [...drivers]
      .filter((item) => driverAvailable(item, service.operational_time!))
      .filter((item) => {
        const bound = driverVehicleBinding.get(item.id);
        if (bound) return (bound.capacity ?? 0) >= (service.pax ?? 0) && driverCanUseVehicle(item, bound);
        if (!fixedVehicleMode) return true;
        return vehicles.some((vehicle) => {
          const key = vehicleResourceKey({ id: vehicle.id, label: vehicle.label }).key;
          return Boolean(key && !vehicleDriverBinding.has(key) && (vehicle.capacity ?? 0) >= (service.pax ?? 0) && driverCanUseVehicle(item, vehicle));
        });
      })
      .filter((item) => {
        const events = driverEvents.get(item.id) ?? [];
        return !events.some((event) => Math.abs(event.time - currentMin) < 30);
      })
      .sort((a, b) => (driverEvents.get(a.id)?.length ?? 0) - (driverEvents.get(b.id)?.length ?? 0) || a.name.localeCompare(b.name))[0];

    if (!driver) {
      const timeAvailableDrivers = drivers.filter((item) => driverAvailable(item, service.operational_time!));
      const reason = timeAvailableDrivers.length > 0
        ? "Nessun mezzo disponibile compatibile con abilitazione autista e capienza"
        : "Nessun autista disponibile nella finestra operativa";
      conflicts.push({ service_id: service.service_id, conflict_type: timeAvailableDrivers.length > 0 ? "driver_vehicle_eligibility" : "driver_availability", reason });
      unplanned.push({ service_id: service.service_id, customer_name: service.customer_name, reason });
      continue;
    }

    const boundVehicle = driverVehicleBinding.get(driver.id) ?? null;
    const availableVehiclePool = boundVehicle
      ? [boundVehicle]
      : vehicles.filter((vehicle) => {
          if (!fixedVehicleMode) return true;
          const key = vehicleResourceKey({ id: vehicle.id, label: vehicle.label }).key;
          return Boolean(key && !vehicleDriverBinding.has(key));
        });
    const vehicle = smallestVehicleAvailableAt(availableVehiclePool, service.pax ?? 0, vehicleTimeline, service.operational_time, driver);
    if (!vehicle) {
      const reason = boundVehicle
        ? "Mezzo fisso dell'autista non disponibile nella finestra operativa"
        : fixedVehicleMode
          ? "Nessun mezzo libero da associare all'autista per la giornata"
          : "Nessun mezzo disponibile con capienza sufficiente";
      conflicts.push({ service_id: service.service_id, conflict_type: "capacity", reason });
      unplanned.push({ service_id: service.service_id, customer_name: service.customer_name, reason });
      continue;
    }

    const vehicleKey = vehicleResourceKey({ id: vehicle.id, label: vehicle.label }).key;
    if (fixedVehicleMode && vehicleKey) {
      const boundDriver = vehicleDriverBinding.get(vehicleKey);
      if (boundDriver && boundDriver !== driver.id) {
        conflicts.push({
          service_id: service.service_id,
          conflict_type: "same_vehicle_different_driver_same_day",
          reason: "Mezzo gia assegnato a un altro autista per questa giornata",
        });
        unplanned.push({
          service_id: service.service_id,
          customer_name: service.customer_name,
          reason: "Mezzo gia assegnato a un altro autista per questa giornata",
        });
        continue;
      }
      driverVehicleBinding.set(driver.id, vehicle);
      vehicleDriverBinding.set(vehicleKey, driver.id);
    }

    const group = createGroup(nextGroupIndex, service, driver, vehicle);
    nextGroupIndex += 1;
    if (service.macro_category === "ESCURSIONE" && (service.pax ?? 0) >= 15) {
      group.warnings.push("Escursione pax alto: giro dedicato consigliato");
      group.explanation.push("Escursione separata per pax alto");
    }
    groups.push(group);
    driverEvents.set(driver.id, [
      ...(driverEvents.get(driver.id) ?? []),
      { time: currentMin, zone: serviceEndZone(service), driverId: driver.id },
    ]);
    const keyInfo = vehicleResourceKey({ id: vehicle.id, label: vehicle.label });
    if (keyInfo.key) vehicleTimeline.set(keyInfo.key, [
      ...(vehicleTimeline.get(keyInfo.key) ?? []),
      {
        start_min: currentMin,
        end_min: currentMin + 30,
        driver_id: driver.id,
        driver_name: driver.name,
        vehicle_id: vehicle.id,
        vehicle_label: vehicle.label,
        warning: keyInfo.warning,
      },
    ]);
  }

  groups.sort((a, b) =>
    b.warnings.length - a.warnings.length ||
    a.start_time.localeCompare(b.start_time)
  );

  const plannedServicesCount = groups.reduce((sum, group) => sum + group.services.length, 0);
  return {
    proposed_groups: groups,
    unplanned,
    conflicts,
    protected_locked: protectedLocked,
    summary: {
      candidate_services: candidates.length,
      proposed_groups_count: groups.length,
      planned_services_count: plannedServicesCount,
      unplanned_count: unplanned.length,
      conflict_count: conflicts.length,
      locked_count: protectedLocked.length,
    },
  };
}
