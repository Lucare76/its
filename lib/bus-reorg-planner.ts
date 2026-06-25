export type ReorgBus = {
  id: string;
  label: string;
  capacity: number;
  lineId: string;
};

export type ReorgAllocation = {
  id: string;
  busId: string;
  stopName: string;
  pax: number;
  serviceId: string;
};

export type ReorgNewPassenger = {
  stopName: string;
  pax: number;
};

export type ReorgMove = {
  allocationIds: string[];
  stopName: string;
  pax: number;
  fromBusId: string;
  toBusId: string;
};

export type ReorgAssignment = {
  stopName: string;
  pax: number;
  busId: string;
};

export type ReorgResult = {
  moves: ReorgMove[];
  assignments: ReorgAssignment[];
  skipped: Array<{ stopName: string; pax: number; reason: string }>;
};

export function planBusReorganization(
  buses: ReorgBus[],
  existingAllocations: ReorgAllocation[],
  newPassengers: ReorgNewPassenger[]
): ReorgResult {
  const busLoad = new Map<string, number>();
  const busAllocsByStop = new Map<string, Map<string, ReorgAllocation[]>>();

  for (const bus of buses) {
    busLoad.set(bus.id, 0);
    busAllocsByStop.set(bus.id, new Map());
  }
  for (const alloc of existingAllocations) {
    busLoad.set(alloc.busId, (busLoad.get(alloc.busId) ?? 0) + alloc.pax);
    const stopMap = busAllocsByStop.get(alloc.busId) ?? new Map();
    const list = stopMap.get(alloc.stopName) ?? [];
    list.push(alloc);
    stopMap.set(alloc.stopName, list);
    busAllocsByStop.set(alloc.busId, stopMap);
  }

  function busRemaining(busId: string) {
    const bus = buses.find(b => b.id === busId);
    return bus ? bus.capacity - (busLoad.get(busId) ?? 0) : 0;
  }

  function findBusWithStop(stopName: string): string | null {
    for (const [busId, stopMap] of busAllocsByStop) {
      if (stopMap.has(stopName)) return busId;
    }
    return null;
  }

  const moves: ReorgMove[] = [];
  const assignments: ReorgAssignment[] = [];
  const skipped: Array<{ stopName: string; pax: number; reason: string }> = [];

  for (const passenger of newPassengers) {
    const existingBusId = findBusWithStop(passenger.stopName);

    if (existingBusId && busRemaining(existingBusId) >= passenger.pax) {
      assignments.push({ stopName: passenger.stopName, pax: passenger.pax, busId: existingBusId });
      busLoad.set(existingBusId, (busLoad.get(existingBusId) ?? 0) + passenger.pax);
      continue;
    }

    if (existingBusId && busRemaining(existingBusId) < passenger.pax) {
      const needed = passenger.pax - busRemaining(existingBusId);
      const stopMap = busAllocsByStop.get(existingBusId)!;
      const otherStopGroups: Array<{ stopName: string; pax: number; allocs: ReorgAllocation[] }> = [];
      for (const [sn, allocs] of stopMap) {
        if (sn === passenger.stopName) continue;
        const totalPax = allocs.reduce((s, a) => s + a.pax, 0);
        otherStopGroups.push({ stopName: sn, pax: totalPax, allocs });
      }
      otherStopGroups.sort((a, b) => a.pax - b.pax);

      let freed = 0;
      const plannedMoves: ReorgMove[] = [];

      for (const group of otherStopGroups) {
        if (freed >= needed) break;
        const destBus = buses.find(b => b.id !== existingBusId && busRemaining(b.id) >= group.pax);
        if (!destBus) continue;

        plannedMoves.push({
          allocationIds: group.allocs.map(a => a.id),
          stopName: group.stopName,
          pax: group.pax,
          fromBusId: existingBusId,
          toBusId: destBus.id,
        });
        freed += group.pax;

        busLoad.set(existingBusId, (busLoad.get(existingBusId) ?? 0) - group.pax);
        busLoad.set(destBus.id, (busLoad.get(destBus.id) ?? 0) + group.pax);
      }

      if (freed >= needed) {
        moves.push(...plannedMoves);
        assignments.push({ stopName: passenger.stopName, pax: passenger.pax, busId: existingBusId });
        busLoad.set(existingBusId, (busLoad.get(existingBusId) ?? 0) + passenger.pax);
        continue;
      } else {
        for (const m of plannedMoves) {
          busLoad.set(m.fromBusId, (busLoad.get(m.fromBusId) ?? 0) + m.pax);
          busLoad.set(m.toBusId, (busLoad.get(m.toBusId) ?? 0) - m.pax);
        }
      }
    }

    const freeBus = buses.find(b => busRemaining(b.id) >= passenger.pax);
    if (freeBus) {
      assignments.push({ stopName: passenger.stopName, pax: passenger.pax, busId: freeBus.id });
      busLoad.set(freeBus.id, (busLoad.get(freeBus.id) ?? 0) + passenger.pax);
    } else {
      skipped.push({ stopName: passenger.stopName, pax: passenger.pax, reason: "Nessun bus con capienza sufficiente" });
    }
  }

  return { moves, assignments, skipped };
}
