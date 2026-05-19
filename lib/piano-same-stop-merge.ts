export type SameStopMacroCategory = "NAVETTA" | "ARRIVO" | "PARTENZA" | "ESCURSIONE" | "DA_VERIFICARE";

export interface ResolvedServiceForSameStop {
  service_id: string;
  customer_name?: string | null;
  macro_category: SameStopMacroCategory;
  assignable: boolean;
  needs_review: boolean;
  review_reasons: string[];
  operational_time: string | null;
  pickup_label: string | null;
  pickup_zone?: string | null;
  destination_label: string | null;
  destination_zone?: string | null;
  pax: number | null;
  ferry_company?: string | null;
  ferry_departure_time?: string | null;
  ferry_arrival_time?: string | null;
  port_departure?: string | null;
  port_arrival?: string | null;
  booking_service_kind?: string | null;
  service_type_code?: string | null;
}

export interface MergedStop {
  stop_id: string;
  services: ResolvedServiceForSameStop[];
  total_pax: number;
  operational_time: string;
  pickup_label: string | null;
  destination_labels: string[];
  macro_category: SameStopMacroCategory;
  ferry_company?: string | null;
  ferry_departure_time?: string | null;
  ferry_arrival_time?: string | null;
  port_departure?: string | null;
  port_arrival?: string | null;
  is_merged: boolean;
  merge_reason: string | null;
  warnings: string[];
}

type MergeBucket = {
  services: ResolvedServiceForSameStop[];
  anchor: ResolvedServiceForSameStop;
};

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalize(value?: string | null) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
}

function minutes(value?: string | null) {
  const match = clean(value)?.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinutes(value: number) {
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function roundedTime(value?: string | null, windowMinutes = 15) {
  const valueMinutes = minutes(value);
  if (valueMinutes == null) return "no-time";
  return formatMinutes(Math.floor(valueMinutes / windowMinutes) * windowMinutes);
}

function sameText(left?: string | null, right?: string | null) {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function sameRequiredField(left?: string | null, right?: string | null) {
  return Boolean(clean(left) && clean(right) && sameText(left, right));
}

function timeCompatible(left: ResolvedServiceForSameStop, right: ResolvedServiceForSameStop, tolerance: number) {
  const leftMinutes = minutes(left.operational_time);
  const rightMinutes = minutes(right.operational_time);
  return leftMinutes != null && rightMinutes != null && Math.abs(leftMinutes - rightMinutes) <= tolerance;
}

function destinationCompatibleForArrival(left: ResolvedServiceForSameStop, right: ResolvedServiceForSameStop) {
  if (sameText(left.destination_label, right.destination_label)) return true;
  return Boolean(
    clean(left.destination_zone)
      && clean(right.destination_zone)
      && sameText(left.destination_zone, right.destination_zone)
  );
}

function shouldStaySingle(service: ResolvedServiceForSameStop) {
  return !service.assignable
    || service.needs_review
    || service.macro_category === "NAVETTA"
    || service.macro_category === "DA_VERIFICARE";
}

function canMerge(
  left: ResolvedServiceForSameStop,
  right: ResolvedServiceForSameStop,
  tolerance: number
) {
  if (shouldStaySingle(left) || shouldStaySingle(right)) return false;
  if (left.macro_category !== right.macro_category) return false;
  if (!timeCompatible(left, right, tolerance)) return false;

  if (left.macro_category === "ARRIVO") {
    return sameRequiredField(left.ferry_company, right.ferry_company)
      && sameRequiredField(left.ferry_departure_time, right.ferry_departure_time)
      && sameRequiredField(left.port_arrival, right.port_arrival)
      && destinationCompatibleForArrival(left, right);
  }

  if (left.macro_category === "PARTENZA") {
    return sameRequiredField(left.pickup_label, right.pickup_label)
      && sameRequiredField(left.ferry_company, right.ferry_company)
      && sameRequiredField(left.ferry_departure_time, right.ferry_departure_time)
      && sameRequiredField(left.port_departure, right.port_departure);
  }

  if (left.macro_category === "ESCURSIONE") {
    return sameRequiredField(left.pickup_label, right.pickup_label)
      && sameRequiredField(left.destination_label, right.destination_label);
  }

  return false;
}

export function buildSameStopMergeKey(service: ResolvedServiceForSameStop): string {
  const rounded = roundedTime(service.operational_time);

  if (service.needs_review || !service.assignable || service.macro_category === "DA_VERIFICARE") {
    return `review|${service.service_id}`;
  }

  if (service.macro_category === "NAVETTA") {
    return `shuttle|${service.service_id}`;
  }

  if (service.macro_category === "ARRIVO") {
    const destinationStrategy = clean(service.destination_zone)
      ? `zone:${normalize(service.destination_zone)}`
      : `destination:${normalize(service.destination_label)}`;
    return [
      "arrival",
      normalize(service.ferry_company),
      normalize(service.ferry_departure_time),
      normalize(service.ferry_arrival_time),
      normalize(service.port_arrival),
      rounded,
      destinationStrategy,
    ].join("|");
  }

  if (service.macro_category === "PARTENZA") {
    return [
      "departure",
      normalize(service.pickup_label),
      normalize(service.ferry_company),
      normalize(service.ferry_departure_time),
      normalize(service.port_departure),
      rounded,
    ].join("|");
  }

  return [
    "excursion",
    normalize(service.pickup_label),
    normalize(service.destination_label),
    rounded,
  ].join("|");
}

function mergeReasonFor(services: ResolvedServiceForSameStop[]) {
  if (services.length <= 1) return null;
  const macro = services[0]?.macro_category;
  if (macro === "ARRIVO") {
    const destinations = new Set(services.map((service) => normalize(service.destination_label)).filter(Boolean));
    return destinations.size > 1
      ? "Stessa corsa, stesso porto e stessa macro-area"
      : "Stessa corsa, stesso porto, stesso orario e stessa destinazione";
  }
  if (macro === "PARTENZA") return "Stesso pickup, stessa nave, stesso porto e stesso orario";
  if (macro === "ESCURSIONE") return "Stesso pickup, stessa destinazione escursione e stesso orario";
  return null;
}

function uniqueLabels(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const value of values) {
    const label = clean(value);
    const key = normalize(label);
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

function makeStop(
  index: number,
  services: ResolvedServiceForSameStop[],
  warnings: string[] = []
): MergedStop {
  const sorted = [...services].sort((a, b) => String(a.operational_time ?? "").localeCompare(String(b.operational_time ?? "")));
  const first = sorted[0]!;
  return {
    stop_id: `same-stop-${String(index).padStart(4, "0")}`,
    services: sorted,
    total_pax: sorted.reduce((sum, service) => sum + (service.pax ?? 0), 0),
    operational_time: first.operational_time ?? "00:00",
    pickup_label: first.pickup_label,
    destination_labels: uniqueLabels(sorted.map((service) => service.destination_label)),
    macro_category: first.macro_category,
    ferry_company: first.ferry_company ?? null,
    ferry_departure_time: first.ferry_departure_time ?? null,
    ferry_arrival_time: first.ferry_arrival_time ?? null,
    port_departure: first.port_departure ?? null,
    port_arrival: first.port_arrival ?? null,
    is_merged: sorted.length > 1,
    merge_reason: mergeReasonFor(sorted),
    warnings,
  };
}

function splitByCapacity(services: ResolvedServiceForSameStop[], maxVehicleCapacity?: number) {
  if (!maxVehicleCapacity || maxVehicleCapacity <= 0) return [{ services, warnings: [] as string[] }];
  const totalPax = services.reduce((sum, service) => sum + (service.pax ?? 0), 0);
  if (totalPax <= maxVehicleCapacity) return [{ services, warnings: [] as string[] }];

  const buckets: ResolvedServiceForSameStop[][] = [];
  const sorted = [...services].sort((a, b) => (b.pax ?? 0) - (a.pax ?? 0));
  for (const service of sorted) {
    const pax = service.pax ?? 0;
    const bucket = buckets.find((candidate) =>
      candidate.reduce((sum, item) => sum + (item.pax ?? 0), 0) + pax <= maxVehicleCapacity
    );
    if (bucket) bucket.push(service);
    else buckets.push([service]);
  }

  return buckets.map((bucket) => ({
    services: bucket,
    warnings: ["Gruppo same-stop splittato per capienza"],
  }));
}

export function mergeSameStops(
  services: ResolvedServiceForSameStop[],
  options?: {
    maxVehicleCapacity?: number;
    timeToleranceMinutes?: number;
  }
): MergedStop[] {
  const tolerance = options?.timeToleranceMinutes ?? 15;
  const ordered = [...services].sort((a, b) =>
    String(a.operational_time ?? "").localeCompare(String(b.operational_time ?? ""))
      || a.macro_category.localeCompare(b.macro_category)
  );

  const buckets: MergeBucket[] = [];
  for (const service of ordered) {
    if (shouldStaySingle(service)) {
      buckets.push({ anchor: service, services: [service] });
      continue;
    }

    const bucket = buckets.find((candidate) => canMerge(candidate.anchor, service, tolerance));
    if (bucket) {
      bucket.services.push(service);
      continue;
    }

    buckets.push({ anchor: service, services: [service] });
  }

  let stopIndex = 1;
  const stops: MergedStop[] = [];
  for (const bucket of buckets) {
    for (const split of splitByCapacity(bucket.services, options?.maxVehicleCapacity)) {
      stops.push(makeStop(stopIndex, split.services, split.warnings));
      stopIndex += 1;
    }
  }

  return stops.sort((a, b) =>
    a.operational_time.localeCompare(b.operational_time)
      || a.macro_category.localeCompare(b.macro_category)
      || String(a.pickup_label ?? "").localeCompare(String(b.pickup_label ?? ""))
  );
}
