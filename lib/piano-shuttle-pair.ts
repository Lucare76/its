import type { SameStopMacroCategory } from "@/lib/piano-same-stop-merge";

export type ShuttlePairType = "SHUTTLE_PAIR" | "SINGLE_STOP";

export interface ShuttlePairStop {
  stop_id: string;
  macro_category: SameStopMacroCategory;
  operational_time: string;
  pickup_label: string | null;
  destination_labels: string[];
  total_pax: number;
  services: Array<{
    assignable?: boolean | null;
    needs_review?: boolean | null;
    customer_name?: string | null;
    pickup_label?: string | null;
    destination_label?: string | null;
    pax?: number | null;
  }>;
  is_merged?: boolean;
  warnings?: string[];
}

export interface ShuttlePairGroup {
  pair_id: string;
  type: "SHUTTLE_PAIR";
  outbound: ShuttlePairStop;
  inbound: ShuttlePairStop;
  start_time: string;
  end_time: string;
  loop_label: string;
  total_pax: number;
  explanation: string[];
}

export interface ShuttlePairResult {
  shuttle_pairs: ShuttlePairGroup[];
  remaining_stops: ShuttlePairStop[];
}

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
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
}

function displayLabel(value?: string | null) {
  const label = clean(value);
  if (!label) return null;
  const text = normalize(label);
  if (text.includes("caffe del direttore") || text.includes("piazzale trieste")) return "Caffe del Direttore";
  return label;
}

function compatiblePlace(left?: string | null, right?: string | null) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const directorCafe = ["caffe del direttore", "piazzale trieste"];
  return directorCafe.some((token) => a.includes(token)) && directorCafe.some((token) => b.includes(token));
}

function minutes(value?: string | null) {
  const match = clean(value)?.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function serviceCustomerKeys(stop: ShuttlePairStop) {
  return stop.services
    .map((service) => normalize(service.customer_name))
    .filter(Boolean);
}

function stopIsAssignable(stop: ShuttlePairStop) {
  return stop.services.length > 0
    && stop.services.every((service) => service.assignable !== false && service.needs_review !== true);
}

function primaryDestination(stop: ShuttlePairStop) {
  return stop.destination_labels.map(clean).find(Boolean) ?? null;
}

function sameOperationalCustomer(left: ShuttlePairStop, right: ShuttlePairStop) {
  const leftKeys = serviceCustomerKeys(left);
  const rightKeys = serviceCustomerKeys(right);
  if (leftKeys.length === 0 || rightKeys.length === 0) return false;
  return leftKeys.some((key) => rightKeys.includes(key));
}

function matchesEnabledHotel(stop: ShuttlePairStop, enabledHotelNames?: string[]) {
  if (!enabledHotelNames?.length) return true;
  const allowed = enabledHotelNames.map(normalize).filter(Boolean);
  if (allowed.length === 0) return true;
  const values = [
    stop.pickup_label,
    ...stop.destination_labels,
    ...stop.services.flatMap((service) => [service.customer_name, service.pickup_label, service.destination_label]),
  ].map(normalize);
  return values.some((value) => allowed.some((hotel) => value.includes(hotel) || hotel.includes(value)));
}

function canPair(
  outbound: ShuttlePairStop,
  inbound: ShuttlePairStop,
  options: { maxDeltaMinutes: number; enabledHotelNames?: string[] }
) {
  if (outbound.macro_category !== "NAVETTA" || inbound.macro_category !== "NAVETTA") return false;
  if (!stopIsAssignable(outbound) || !stopIsAssignable(inbound)) return false;
  if (!matchesEnabledHotel(outbound, options.enabledHotelNames) || !matchesEnabledHotel(inbound, options.enabledHotelNames)) return false;

  const outboundDestination = primaryDestination(outbound);
  const inboundDestination = primaryDestination(inbound);
  if (!outbound.pickup_label || !outboundDestination || !inbound.pickup_label || !inboundDestination) return false;
  if (!compatiblePlace(outbound.pickup_label, inboundDestination)) return false;
  if (!compatiblePlace(outboundDestination, inbound.pickup_label)) return false;
  if (!sameOperationalCustomer(outbound, inbound)) return false;

  const outboundMinutes = minutes(outbound.operational_time);
  const inboundMinutes = minutes(inbound.operational_time);
  if (outboundMinutes == null || inboundMinutes == null) return false;
  const delta = inboundMinutes - outboundMinutes;
  return delta >= 0 && delta <= options.maxDeltaMinutes;
}

function makePair(outbound: ShuttlePairStop, inbound: ShuttlePairStop, index: number): ShuttlePairGroup {
  const hotel = displayLabel(outbound.pickup_label) ?? displayLabel(primaryDestination(inbound)) ?? "Hotel";
  const externalPoint = displayLabel(primaryDestination(outbound)) ?? displayLabel(inbound.pickup_label) ?? "Punto esterno";
  return {
    pair_id: `shuttle-pair-${String(index).padStart(4, "0")}`,
    type: "SHUTTLE_PAIR",
    outbound,
    inbound,
    start_time: outbound.operational_time,
    end_time: inbound.operational_time,
    loop_label: `NAVETTA CICLO - ${hotel} ↔ ${externalPoint} - ore ${outbound.operational_time.slice(0, 5)}`,
    total_pax: outbound.total_pax + inbound.total_pax,
    explanation: [
      "Navette inverse nello stesso gruppo operativo",
      "Stesso hotel/gruppo cliente",
      "Delta orario compatibile con ciclo navetta",
    ],
  };
}

export function detectShuttlePairs(
  stops: ShuttlePairStop[],
  options?: {
    maxDeltaMinutes?: number;
    enabledHotelNames?: string[];
  }
): ShuttlePairResult {
  const maxDeltaMinutes = options?.maxDeltaMinutes ?? 10;
  const ordered = [...stops].sort((a, b) => a.operational_time.localeCompare(b.operational_time));
  const used = new Set<string>();
  const shuttlePairs: ShuttlePairGroup[] = [];

  for (const stop of ordered) {
    if (used.has(stop.stop_id)) continue;
    const match = ordered.find((candidate) =>
      candidate.stop_id !== stop.stop_id
      && !used.has(candidate.stop_id)
      && canPair(stop, candidate, { maxDeltaMinutes, enabledHotelNames: options?.enabledHotelNames })
    );
    if (!match) continue;
    used.add(stop.stop_id);
    used.add(match.stop_id);
    shuttlePairs.push(makePair(stop, match, shuttlePairs.length + 1));
  }

  return {
    shuttle_pairs: shuttlePairs.sort((a, b) => a.start_time.localeCompare(b.start_time)),
    remaining_stops: ordered.filter((stop) => !used.has(stop.stop_id)),
  };
}
