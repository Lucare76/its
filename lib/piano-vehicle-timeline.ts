export type VehicleTimelineIdentity = {
  id?: string | null;
  label?: string | null;
};

export type VehicleTimelineInterval = {
  start_min: number;
  end_min: number;
};

export type VehicleTimelineEntry = VehicleTimelineInterval & {
  group_id?: string | null;
  driver_id?: string | null;
  driver_name?: string | null;
  vehicle_id?: string | null;
  vehicle_label?: string | null;
  warning?: string | null;
};

export type VehicleResourceKey = {
  key: string | null;
  warning: string | null;
};

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export function vehicleResourceKey(vehicle: VehicleTimelineIdentity): VehicleResourceKey {
  const id = clean(vehicle.id);
  if (id) return { key: `id:${id}`, warning: null };

  const label = clean(vehicle.label);
  if (!label) return { key: null, warning: "Mezzo senza vehicle_id e senza vehicle_label: impossibile validare l'esclusivita." };

  return {
    key: `label:${label.toLowerCase()}`,
    warning: `Mezzo "${label}" senza vehicle_id: validazione esclusivita basata su vehicle_label.`,
  };
}

export function vehicleIntervalsOverlap(
  left: VehicleTimelineInterval,
  right: VehicleTimelineInterval,
  bufferMin = 0
) {
  return left.start_min < right.end_min + bufferMin && right.start_min < left.end_min + bufferMin;
}

export function findVehicleTimelineConflict(
  timeline: VehicleTimelineEntry[],
  candidate: VehicleTimelineInterval,
  bufferMin: number
) {
  return timeline.find((entry) => vehicleIntervalsOverlap(entry, candidate, bufferMin)) ?? null;
}

export function vehicleUsageCount(timeline: Map<string, VehicleTimelineEntry[]>, vehicle: VehicleTimelineIdentity) {
  const key = vehicleResourceKey(vehicle).key;
  return key ? timeline.get(key)?.length ?? 0 : Number.POSITIVE_INFINITY;
}
