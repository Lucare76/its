export type BusNetworkUnassignedService = {
  id: string;
  pax: number | null | undefined;
  booking_group_id?: string | null;
  booking_group_kind?: string | null;
  booking_group_stop_id?: string | null;
  booking_group_catalog_stop_id?: string | null;
  bus_city_origin?: string | null;
};

export type BusNetworkUnassignedSummary = {
  itemCount: number;
  pax: number;
  exclusiveGroupCount: number;
  stopBlockCount: number;
  individualCount: number;
};

function normalizeKeyPart(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return normalized || null;
}

export function summarizeBusNetworkUnassigned(
  services: BusNetworkUnassignedService[]
): BusNetworkUnassignedSummary {
  const exclusiveGroups = new Set<string>();
  const stopBlocks = new Set<string>();
  let individualCount = 0;
  let pax = 0;

  for (const service of services) {
    const servicePax = Number(service.pax ?? 0);
    if (Number.isFinite(servicePax)) pax += servicePax;

    const groupId = normalizeKeyPart(service.booking_group_id);
    if (service.booking_group_kind === "bus_exclusive" && groupId) {
      exclusiveGroups.add(groupId);
      continue;
    }

    if (groupId) {
      const stopKey =
        normalizeKeyPart(service.booking_group_stop_id) ??
        normalizeKeyPart(service.booking_group_catalog_stop_id) ??
        normalizeKeyPart(service.bus_city_origin);

      stopBlocks.add(stopKey ? `${groupId}:${stopKey}` : `${groupId}:service:${service.id}`);
      continue;
    }

    individualCount += 1;
  }

  const exclusiveGroupCount = exclusiveGroups.size;
  const stopBlockCount = stopBlocks.size;
  const itemCount = exclusiveGroupCount + stopBlockCount + individualCount;

  return { itemCount, pax, exclusiveGroupCount, stopBlockCount, individualCount };
}

export function formatBusNetworkUnassignedSummary(summary: BusNetworkUnassignedSummary): string {
  const paxLabel = `${summary.pax} pax`;
  if (summary.itemCount === 0) return `0 da assegnare · ${paxLabel}`;

  if (summary.exclusiveGroupCount > 0 && summary.stopBlockCount === 0 && summary.individualCount === 0) {
    const noun = summary.exclusiveGroupCount === 1 ? "gruppo" : "gruppi";
    return `${summary.exclusiveGroupCount} ${noun} da assegnare · ${paxLabel}`;
  }

  if (summary.stopBlockCount > 0 && summary.exclusiveGroupCount === 0 && summary.individualCount === 0) {
    const noun = summary.stopBlockCount === 1 ? "fermata" : "fermate";
    return `${summary.stopBlockCount} ${noun} da assegnare · ${paxLabel}`;
  }

  if (summary.individualCount > 0 && summary.exclusiveGroupCount === 0 && summary.stopBlockCount === 0) {
    const noun = summary.individualCount === 1 ? "servizio" : "servizi";
    return `${summary.individualCount} ${noun} da assegnare · ${paxLabel}`;
  }

  return `${summary.itemCount} blocchi da assegnare · ${paxLabel}`;
}
