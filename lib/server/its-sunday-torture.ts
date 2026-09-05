export type TortureDirection = "arrival" | "departure" | string;

export type TortureService = {
  id: string;
  tenant_id: string;
  date: string;
  pax: number | null;
  direction: TortureDirection | null;
  status?: string | null;
  is_test_data?: boolean | null;
};

export type TortureAssignment = {
  id?: string;
  tenant_id: string;
  service_id: string;
  driver_user_id?: string | null;
  vehicle_label?: string | null;
  locked_by_operator?: boolean | null;
};

export type TortureBusAllocation = {
  id?: string;
  tenant_id: string;
  service_id: string;
  bus_unit_id: string;
  pax_assigned: number | null;
};

export type TortureBusUnit = {
  id: string;
  tenant_id: string;
  label?: string | null;
  capacity: number | null;
};

export type ItsSundayTortureSnapshot = {
  tenantId: string;
  date: string;
  expectedMinServices?: number;
  services: TortureService[];
  assignments: TortureAssignment[];
  busAllocations: TortureBusAllocation[];
  busUnits: TortureBusUnit[];
};

export type TortureIssueLevel = "hard" | "warning";

export type TortureIssue = {
  level: TortureIssueLevel;
  code: string;
  message: string;
  entityIds?: string[];
};

export type ItsSundayTortureReport = {
  passed: boolean;
  hardFailures: TortureIssue[];
  warnings: TortureIssue[];
  stats: {
    services: number;
    pax: number;
    assignments: number;
    busAllocations: number;
    busUnits: number;
    arrivalServices: number;
    departureServices: number;
  };
};

function addIssue(target: TortureIssue[], issue: TortureIssue) {
  target.push(issue);
}

function finitePositive(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function evaluateItsSundayTorture(snapshot: ItsSundayTortureSnapshot): ItsSundayTortureReport {
  const hardFailures: TortureIssue[] = [];
  const warnings: TortureIssue[] = [];
  const expectedMinServices = snapshot.expectedMinServices ?? 400;

  const serviceById = new Map(snapshot.services.map((service) => [service.id, service]));
  const busById = new Map(snapshot.busUnits.map((bus) => [bus.id, bus]));

  if (snapshot.services.length < expectedMinServices) {
    addIssue(hardFailures, {
      level: "hard",
      code: "INSUFFICIENT_LOAD",
      message: `Stress test non valido: trovati ${snapshot.services.length} servizi, minimo atteso ${expectedMinServices}.`,
    });
  }

  const duplicateServiceIds = snapshot.services
    .map((service) => service.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateServiceIds.length > 0) {
    addIssue(hardFailures, {
      level: "hard",
      code: "DUPLICATE_SERVICE_ID",
      message: `Trovati ${new Set(duplicateServiceIds).size} service_id duplicati nello snapshot.`,
      entityIds: [...new Set(duplicateServiceIds)],
    });
  }

  const badScopeServices = snapshot.services.filter(
    (service) => service.tenant_id !== snapshot.tenantId || service.date !== snapshot.date || service.is_test_data !== true,
  );
  if (badScopeServices.length > 0) {
    addIssue(hardFailures, {
      level: "hard",
      code: "SERVICE_SCOPE_LEAK",
      message: `${badScopeServices.length} servizi non appartengono al tenant/data/test scope richiesto.`,
      entityIds: badScopeServices.map((service) => service.id),
    });
  }

  const invalidPax = snapshot.services.filter((service) => !finitePositive(service.pax));
  if (invalidPax.length > 0) {
    addIssue(hardFailures, {
      level: "hard",
      code: "INVALID_SERVICE_PAX",
      message: `${invalidPax.length} servizi hanno pax nullo, non numerico o <= 0.`,
      entityIds: invalidPax.map((service) => service.id),
    });
  }

  const assignmentCountByService = new Map<string, number>();
  for (const assignment of snapshot.assignments) {
    if (assignment.tenant_id !== snapshot.tenantId) {
      addIssue(hardFailures, {
        level: "hard",
        code: "ASSIGNMENT_TENANT_LEAK",
        message: `Assignment ${assignment.id ?? assignment.service_id} appartiene a un tenant diverso.`,
        entityIds: [assignment.service_id],
      });
    }
    if (!serviceById.has(assignment.service_id)) {
      addIssue(hardFailures, {
        level: "hard",
        code: "ORPHAN_ASSIGNMENT",
        message: `Assignment riferito a service_id non presente nella giornata di test: ${assignment.service_id}.`,
        entityIds: [assignment.service_id],
      });
    }
    assignmentCountByService.set(assignment.service_id, (assignmentCountByService.get(assignment.service_id) ?? 0) + 1);
  }

  const multiplyAssigned = [...assignmentCountByService.entries()].filter(([, count]) => count > 1);
  if (multiplyAssigned.length > 0) {
    addIssue(hardFailures, {
      level: "hard",
      code: "MULTIPLE_ASSIGNMENTS_PER_SERVICE",
      message: `${multiplyAssigned.length} servizi hanno più di un record assignment.`,
      entityIds: multiplyAssigned.map(([serviceId]) => serviceId),
    });
  }

  const allocationPaxByService = new Map<string, number>();
  const capacityBuckets = new Map<string, { busId: string; direction: string; pax: number }>();

  for (const allocation of snapshot.busAllocations) {
    if (allocation.tenant_id !== snapshot.tenantId) {
      addIssue(hardFailures, {
        level: "hard",
        code: "BUS_ALLOCATION_TENANT_LEAK",
        message: `Allocazione bus ${allocation.id ?? allocation.service_id} appartiene a un tenant diverso.`,
        entityIds: [allocation.service_id],
      });
    }

    const service = serviceById.get(allocation.service_id);
    if (!service) {
      addIssue(hardFailures, {
        level: "hard",
        code: "ORPHAN_BUS_ALLOCATION",
        message: `Allocazione bus riferita a service_id non presente: ${allocation.service_id}.`,
        entityIds: [allocation.service_id],
      });
      continue;
    }

    const bus = busById.get(allocation.bus_unit_id);
    if (!bus) {
      addIssue(hardFailures, {
        level: "hard",
        code: "UNKNOWN_BUS_UNIT",
        message: `Allocazione bus riferita a bus_unit_id non presente: ${allocation.bus_unit_id}.`,
        entityIds: [allocation.service_id],
      });
      continue;
    }

    if (bus.tenant_id !== snapshot.tenantId) {
      addIssue(hardFailures, {
        level: "hard",
        code: "BUS_UNIT_TENANT_LEAK",
        message: `Bus ${bus.id} appartiene a un tenant diverso.`,
        entityIds: [bus.id],
      });
    }

    const paxAssigned = Number(allocation.pax_assigned ?? 0);
    if (!Number.isFinite(paxAssigned) || paxAssigned <= 0) {
      addIssue(hardFailures, {
        level: "hard",
        code: "INVALID_ALLOCATION_PAX",
        message: `Allocazione bus con pax_assigned non valido per ${allocation.service_id}.`,
        entityIds: [allocation.service_id],
      });
      continue;
    }

    allocationPaxByService.set(
      allocation.service_id,
      (allocationPaxByService.get(allocation.service_id) ?? 0) + paxAssigned,
    );

    const direction = String(service.direction ?? "unknown");
    const key = `${allocation.bus_unit_id}::${direction}`;
    const bucket = capacityBuckets.get(key) ?? { busId: allocation.bus_unit_id, direction, pax: 0 };
    bucket.pax += paxAssigned;
    capacityBuckets.set(key, bucket);
  }

  for (const [serviceId, allocatedPax] of allocationPaxByService) {
    const service = serviceById.get(serviceId);
    const servicePax = Number(service?.pax ?? 0);
    if (allocatedPax > servicePax) {
      addIssue(hardFailures, {
        level: "hard",
        code: "SERVICE_OVERALLOCATED_PAX",
        message: `Servizio ${serviceId}: ${allocatedPax} pax allocati su bus, ma il servizio ha ${servicePax} pax.`,
        entityIds: [serviceId],
      });
    } else if (allocatedPax < servicePax) {
      addIssue(warnings, {
        level: "warning",
        code: "SERVICE_PARTIALLY_ALLOCATED_PAX",
        message: `Servizio ${serviceId}: ${allocatedPax}/${servicePax} pax allocati su bus.`,
        entityIds: [serviceId],
      });
    }
  }

  for (const bucket of capacityBuckets.values()) {
    const bus = busById.get(bucket.busId);
    const capacity = Number(bus?.capacity ?? 0);
    if (!Number.isFinite(capacity) || capacity <= 0) {
      addIssue(hardFailures, {
        level: "hard",
        code: "INVALID_BUS_CAPACITY",
        message: `Bus ${bucket.busId} ha capacità non valida.`,
        entityIds: [bucket.busId],
      });
      continue;
    }
    if (bucket.pax > capacity) {
      addIssue(hardFailures, {
        level: "hard",
        code: "BUS_OVER_CAPACITY",
        message: `Bus ${bus?.label ?? bucket.busId} ${bucket.direction}: ${bucket.pax}/${capacity} pax.`,
        entityIds: [bucket.busId],
      });
    }
  }

  const totalPax = snapshot.services.reduce((sum, service) => sum + (finitePositive(service.pax) ? Number(service.pax) : 0), 0);

  return {
    passed: hardFailures.length === 0,
    hardFailures,
    warnings,
    stats: {
      services: snapshot.services.length,
      pax: totalPax,
      assignments: snapshot.assignments.length,
      busAllocations: snapshot.busAllocations.length,
      busUnits: snapshot.busUnits.length,
      arrivalServices: snapshot.services.filter((service) => service.direction === "arrival").length,
      departureServices: snapshot.services.filter((service) => service.direction === "departure").length,
    },
  };
}
