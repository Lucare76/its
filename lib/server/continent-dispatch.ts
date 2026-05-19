import type { PricingAuthContext } from "@/lib/server/pricing-auth";
import { getPickupRule, getPickupRuleByIslandPickup, getPickupRuleByRange } from "@/lib/departure-pickup-rules";

export type ContinentDispatchTarget = "bruno" | "continent_dispatch";
export type ContinentDispatchSource = "rule" | "manual";
export type ContinentPlaceType = "station" | "airport";

export type ContinentDispatchService = {
  id: string;
  direction: "arrival" | "departure";
  customer_name: string;
  pax: number;
  time: string;
  vessel: string;
  boat_t: string | null;
  place_type: ContinentPlaceType;
  meeting_point: string | null;
  phone: string;
  notes: string;
  hotel_name: string | null;
  hotel_zone: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  connection_time: string | null;
  arrival_at_porto: string | null;
  arrival_at_ischia: string | null;
  porto_bruno: string | null;
  continent_hub: "napoli" | "pozzuoli" | null;
  train_arrival_number: string | null;
  train_departure_number: string | null;
  suggested_target: ContinentDispatchTarget;
  effective_target: ContinentDispatchTarget;
  target_source: ContinentDispatchSource;
  vendor_name: string | null;
  override_reason: string | null;
};

export type BrunoArrival = {
  id: string;
  customer_name: string;
  pax: number;
  time: string;
  vessel: string;
  arrival_at_ischia: string | null;
  connection_time: string | null;
  place_type: ContinentPlaceType;
  meeting_point: string | null;
  phone: string;
  hotel_name: string | null;
  notes: string;
  flight_number: string | null;
  dispatch_source: ContinentDispatchSource;
};

export type BrunoDeparture = {
  id: string;
  customer_name: string;
  pax: number;
  time: string;
  vessel: string;
  boat_t: string | null;
  arrival_at_porto: string | null;
  connection_time: string | null;
  place_type: ContinentPlaceType;
  meeting_point: string | null;
  phone: string;
  porto_bruno: string | null;
  hotel_name: string | null;
  notes: string;
  flight_number: string | null;
  dispatch_source: ContinentDispatchSource;
};

export type NormalizedContinentDispatchService = {
  service_id: string;
  customer_name: string;
  phone: string;
  phone_display: string;
  pax: number;
  date: string | null;
  direction: "arrival" | "departure";
  booking_service_kind: string | null;
  service_type_code: string | null;
  effective_target: ContinentDispatchTarget;
  suggested_target: ContinentDispatchTarget;
  target_source: ContinentDispatchSource;
  continent_dispatch_vendor: string | null;
  place_type: ContinentPlaceType;
  meeting_point: string | null;
  continent_hub: "napoli" | "pozzuoli" | null;
  vessel: string;
  boat_t: string | null;
  connection_time: string | null;
  arrival_at_porto: string | null;
  arrival_at_ischia: string | null;
  porto_bruno: string | null;
  hotel_name: string | null;
  hotel_zone: string | null;
  time: string;
  notes: string;
  warnings: string[];
};

export type BrunoContinentDispatchBucket = {
  label: "Bruno";
  target: "bruno";
  services: NormalizedContinentDispatchService[];
};

export type VendorContinentDispatchBucket = {
  label: string;
  target: "continent_dispatch";
  vendor: string;
  source: "manual";
  services: NormalizedContinentDispatchService[];
};

export type UnassignedContinentDispatchBucket = {
  label: "Da smistare";
  target: "continent_dispatch";
  services: NormalizedContinentDispatchService[];
};

export type ContinentDispatchBuckets = {
  bruno: BrunoContinentDispatchBucket;
  vendors: VendorContinentDispatchBucket[];
  unassigned: UnassignedContinentDispatchBucket;
};

type ServiceRow = {
  id: string;
  customer_name: string;
  pax: number;
  time: string;
  direction?: "arrival" | "departure" | null;
  arrival_time?: string | null;
  departure_time?: string | null;
  transport_code?: string | null;
  train_arrival_time?: string | null;
  vessel: string;
  place_type: string | null;
  meeting_point: string | null;
  phone: string;
  notes: string | null;
  porto_bruno?: string | null;
  service_type_code?: string | null;
  booking_service_kind?: string | null;
  origin_place_type?: string | null;
  destination_place_type?: string | null;
  origin_label_raw?: string | null;
  destination_label_raw?: string | null;
  train_arrival_number?: string | null;
  train_departure_number?: string | null;
  continent_dispatch_target?: string | null;
  continent_dispatch_source?: string | null;
  continent_dispatch_vendor?: string | null;
  continent_dispatch_override_reason?: string | null;
  hotels: { name: string; zone?: string | null } | null;
};

const AIRPORT_TRANSFER_KINDS = [
  "transfer_airport_hotel",
  "transfer_airport_hotel_exclusive",
  "transfer_airport_hotel_aliscafo",
] as const;

const STATION_TRANSFER_KINDS = [
  "transfer_train_hotel",
  "transfer_train_hotel_exclusive",
  "transfer_train_hotel_aliscafo",
] as const;

const CONTINENT_TRANSFER_KINDS = [...AIRPORT_TRANSFER_KINDS, ...STATION_TRANSFER_KINDS] as const;

export const DISPATCH_TARGET_LABELS: Record<ContinentDispatchTarget, string> = {
  bruno: "Bruno",
  continent_dispatch: "Smistamento continente",
};

function normalizeZona(raw: string): string {
  const z = raw.toLowerCase().trim();
  if (z.includes("forio")) return "forio";
  if (z.includes("lacco")) return "lacco";
  if (z.includes("casamicciola")) return "casamicciola";
  if (z.includes("barano")) return "barano";
  return "ischia";
}

function ferryTravelMinutes(boatCo: string, porto: string): number {
  const co = boatCo.toLowerCase();
  const p = porto.toLowerCase();
  if (co.includes("alilauro")) return 50;
  if (co.includes("snav")) return 65;
  if (co.includes("medmar") || p.includes("pozzuoli")) return 60;
  return 95;
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.trim().split(":").map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function computeArrivalAtPorto(boatT: string, boatCo: string, porto: string): string {
  return addMinutes(boatT, ferryTravelMinutes(boatCo, porto));
}

export function computeArrivalAtIschia(vesselField: string): string | null {
  const timeMatch = vesselField.match(/(\d{2}:\d{2})/);
  if (!timeMatch) return null;
  const departureTime = timeMatch[1];
  const v = vesselField.toLowerCase();
  const co = v.includes("alilauro") ? "alilauro" : v.includes("snav") ? "snav" : v.includes("medmar") ? "medmar" : "";
  const porto = v.includes("pozzuoli") ? "pozzuoli" : v.includes("napoli") ? "napoli" : "";
  return addMinutes(departureTime, ferryTravelMinutes(co, porto));
}

function normalizeContinentPlaceType(value: string | null | undefined): ContinentPlaceType | null {
  return value === "airport" || value === "station" ? value : null;
}

function inferPlaceTypeFromText(value: string | null | undefined): ContinentPlaceType | null {
  const text = value?.toLowerCase() ?? "";
  if (!text) return null;
  if (
    text.includes("stazione")
    || text.includes("napoli centrale")
    || text.includes("centrale napoli")
    || text.includes("trenitalia")
    || text.includes("italo")
    || text.includes("frecciarossa")
    || text.includes("flixbus")
    || text.includes("treno")
    || text.includes("bus")
  ) {
    return "station";
  }
  if (
    text.includes("aeroporto")
    || text.includes("airport")
    || text.includes("capodichino")
    || text.includes("nap t")
    || text.includes("napoli international")
  ) {
    return "airport";
  }
  return null;
}

export function resolvePlaceType(
  row: Pick<ServiceRow, "place_type" | "service_type_code" | "booking_service_kind">
    & Partial<Pick<
      ServiceRow,
      | "direction"
      | "origin_place_type"
      | "destination_place_type"
      | "origin_label_raw"
      | "destination_label_raw"
      | "meeting_point"
      | "vessel"
      | "porto_bruno"
    >>
): ContinentPlaceType {
  const directionalType = row.direction === "departure"
    ? normalizeContinentPlaceType(row.destination_place_type)
    : normalizeContinentPlaceType(row.origin_place_type);
  if (directionalType) return directionalType;

  const directionalText = row.direction === "departure" ? row.destination_label_raw : row.origin_label_raw;
  const textType = [
    directionalText,
    row.meeting_point,
    row.vessel,
    row.porto_bruno,
  ].map(inferPlaceTypeFromText).find(Boolean);
  if (textType) return textType;

  if (row.place_type === "airport" || row.place_type === "station") return row.place_type;

  const kind = row.booking_service_kind ?? row.service_type_code ?? "";
  if (AIRPORT_TRANSFER_KINDS.includes(kind as (typeof AIRPORT_TRANSFER_KINDS)[number]) || row.service_type_code === "transfer_airport_hotel") {
    return "airport";
  }
  return "station";
}

function isHydrofoilKind(kind: string | null | undefined) {
  return Boolean(kind && kind.includes("aliscafo"));
}

function hasHydrofoilFormula(row: Pick<ServiceRow, "booking_service_kind" | "service_type_code">) {
  return isHydrofoilKind(row.booking_service_kind) || isHydrofoilKind(row.service_type_code);
}

function isIslandOnlyFormulaKind(kind: string | null | undefined) {
  return kind === "formula_snav"
    || kind === "formula_medmar_napoli"
    || kind === "formula_medmar_pozzuoli";
}

export function isContinentDispatchCandidate(row: Pick<ServiceRow, "booking_service_kind" | "service_type_code">) {
  return !isIslandOnlyFormulaKind(row.booking_service_kind) && !isIslandOnlyFormulaKind(row.service_type_code);
}

function cleanNotes(raw: string | null): string {
  if (!raw) return "";
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("[pdf_import]") && !/^Import operational_v2 riga\s+\d+/i.test(line))
    .join(" ");
}

function normalizeHubFromText(value: string | null | undefined): "napoli" | "pozzuoli" | null {
  const normalized = value?.toLowerCase() ?? "";
  if (!normalized) return null;
  if (normalized.includes("pozzuoli")) return "pozzuoli";
  if (
    normalized.includes("napoli")
    || normalized.includes("beverello")
    || normalized.includes("calata")
    || normalized.includes("snav")
    || normalized.includes("alilauro")
  ) {
    return "napoli";
  }
  return null;
}

function computeDepartureRouting(row: ServiceRow, placeType: ContinentPlaceType) {
  const kind = row.booking_service_kind ?? row.service_type_code ?? "";
  const zona = normalizeZona(row.hotels?.zone ?? "");
  const agencyForLookup = "";
  const tFromCandidates = [row.departure_time?.slice(0, 5), row.time?.slice(0, 5)].filter((value): value is string => Boolean(value));

  const transportTypes: string[] = [];
  if (kind === "transfer_train_hotel") transportTypes.push("treno_traghetto", "treno_aliscafo");
  else if (kind === "transfer_train_hotel_exclusive") transportTypes.push("treno_traghetto");
  else if (kind === "transfer_train_hotel_aliscafo") transportTypes.push("treno_aliscafo");
  else if (kind === "transfer_airport_hotel") transportTypes.push("volo_traghetto", "volo_aliscafo");
  else if (kind === "transfer_airport_hotel_exclusive") transportTypes.push("volo_traghetto");
  else if (kind === "transfer_airport_hotel_aliscafo") transportTypes.push("volo_aliscafo");
  if (transportTypes.length === 0) {
    transportTypes.push(placeType === "airport" ? "volo_traghetto" : "treno_traghetto");
    transportTypes.push(placeType === "airport" ? "volo_aliscafo" : "treno_aliscafo");
  }

  let computedVessel: string | null = null;
  let computedPorto: string | null = null;
  let computedBoatT: string | null = null;
  let matchedConnectionTime: string | null = null;
  let ruleFound = false;

  for (const tFrom of tFromCandidates) {
    if (ruleFound) break;
    for (const transportType of transportTypes) {
      const rule = getPickupRule(agencyForLookup, transportType, tFrom, zona)
        ?? getPickupRuleByRange(agencyForLookup, transportType, tFrom, zona);
      if (!rule) continue;
      computedVessel = `${rule.boat_co} ${rule.boat_t}`;
      computedBoatT = rule.boat_t;
      computedPorto = rule.porto_p;
      matchedConnectionTime = tFrom;
      ruleFound = true;
      break;
    }
  }

  if (!ruleFound) {
    for (const tFrom of tFromCandidates) {
      if (ruleFound) break;
      for (const transportType of transportTypes) {
        const rule = getPickupRuleByIslandPickup(transportType, tFrom, zona);
        if (!rule) continue;
        computedVessel = `${rule.boat_co} ${rule.boat_t}`;
        computedBoatT = rule.boat_t;
        computedPorto = rule.porto_p;
        matchedConnectionTime = rule.t_to ? `${rule.t_from}–${rule.t_to}` : rule.t_from;
        ruleFound = true;
        break;
      }
    }
  }

  return {
    vessel: computedVessel ?? row.vessel,
    porto: row.porto_bruno ?? computedPorto ?? null,
    boat_t: computedBoatT,
    connection_time: matchedConnectionTime ?? row.departure_time?.slice(0, 5) ?? row.time?.slice(0, 5) ?? null,
  };
}

export function resolveSuggestedTarget(
  row: Pick<ServiceRow, "direction" | "booking_service_kind" | "service_type_code">,
  placeType: ContinentPlaceType,
  _continentHub: "napoli" | "pozzuoli" | null
): ContinentDispatchTarget {
  if (row.direction === "arrival" && placeType === "airport") {
    return "bruno";
  }

  if (row.direction === "arrival" && placeType === "station" && hasHydrofoilFormula(row)) {
    return "bruno";
  }

  if (row.direction === "departure" && (placeType === "airport" || placeType === "station") && hasHydrofoilFormula(row)) {
    return "bruno";
  }

  return "continent_dispatch";
}

function normalizeTarget(value: string | null | undefined): ContinentDispatchTarget | null {
  if (value === "bruno" || value === "continent_dispatch") return value;
  return null;
}

function normalizeSource(value: string | null | undefined): ContinentDispatchSource | null {
  if (value === "rule" || value === "manual") return value;
  return null;
}

export function mapContinentDispatchRow(row: ServiceRow & { direction: "arrival" | "departure" }): ContinentDispatchService {
  const placeType = resolvePlaceType(row);
  const departureRouting = row.direction === "departure" ? computeDepartureRouting(row, placeType) : null;
  const continentHub = normalizeHubFromText(
    row.direction === "departure"
      ? departureRouting?.porto ?? row.porto_bruno ?? row.meeting_point ?? row.vessel
      : row.porto_bruno ?? row.meeting_point ?? row.vessel
  );
  const suggestedTarget = resolveSuggestedTarget(row, placeType, continentHub);
  const manualSource = normalizeSource(row.continent_dispatch_source) === "manual";
  const manualTarget = normalizeTarget(row.continent_dispatch_target);
  const effectiveTarget = manualSource && manualTarget ? manualTarget : suggestedTarget;

  return {
    id: row.id,
    direction: row.direction,
    customer_name: row.customer_name,
    pax: row.pax,
    time: row.direction === "departure"
      ? row.departure_time ?? row.time
      : row.arrival_time ?? row.train_arrival_time ?? row.time,
    vessel: row.direction === "departure" ? departureRouting?.vessel ?? row.vessel : row.vessel,
    boat_t: row.direction === "departure" ? departureRouting?.boat_t ?? null : null,
    place_type: placeType,
    meeting_point: row.meeting_point,
    phone: row.phone,
    notes: cleanNotes(row.notes),
    hotel_name: row.hotels?.name ?? null,
    hotel_zone: row.hotels?.zone ?? null,
    booking_service_kind: row.booking_service_kind ?? null,
    service_type_code: row.service_type_code ?? null,
    connection_time: row.direction === "departure"
      ? departureRouting?.connection_time ?? null
      : row.arrival_time?.slice(0, 5) ?? row.train_arrival_time?.slice(0, 5) ?? null,
    arrival_at_porto: row.direction === "departure" && departureRouting?.boat_t
      ? computeArrivalAtPorto(departureRouting.boat_t, departureRouting.vessel, departureRouting.porto ?? "")
      : null,
    arrival_at_ischia: row.direction === "arrival" ? computeArrivalAtIschia(row.vessel ?? "") : null,
    porto_bruno: row.direction === "departure" ? departureRouting?.porto ?? row.porto_bruno ?? null : row.porto_bruno ?? null,
    continent_hub: continentHub,
    train_arrival_number: row.train_arrival_number ?? row.transport_code ?? null,
    train_departure_number: row.train_departure_number ?? null,
    suggested_target: suggestedTarget,
    effective_target: effectiveTarget,
    target_source: manualSource && manualTarget ? "manual" : "rule",
    vendor_name: row.continent_dispatch_vendor?.trim() || null,
    override_reason: row.continent_dispatch_override_reason?.trim() || null,
  };
}

export function isBrunoTarget(service: Pick<ContinentDispatchService, "effective_target">) {
  return service.effective_target === "bruno";
}

function normalizePhoneDisplay(phone: string | null | undefined): string {
  const cleaned = phone?.trim();
  return cleaned || "0000";
}

function normalizeBucketService(service: ContinentDispatchService, date: string | null): NormalizedContinentDispatchService {
  return {
    service_id: service.id,
    customer_name: service.customer_name,
    phone: service.phone,
    phone_display: normalizePhoneDisplay(service.phone),
    pax: service.pax,
    date,
    direction: service.direction,
    booking_service_kind: service.booking_service_kind,
    service_type_code: service.service_type_code,
    effective_target: service.effective_target,
    suggested_target: service.suggested_target,
    target_source: service.target_source,
    continent_dispatch_vendor: service.vendor_name,
    place_type: service.place_type,
    meeting_point: service.meeting_point,
    continent_hub: service.continent_hub,
    vessel: service.vessel,
    boat_t: service.boat_t,
    connection_time: service.connection_time,
    arrival_at_porto: service.arrival_at_porto,
    arrival_at_ischia: service.arrival_at_ischia,
    porto_bruno: service.porto_bruno,
    hotel_name: service.hotel_name,
    hotel_zone: service.hotel_zone,
    time: service.time,
    notes: service.notes,
    warnings: [],
  };
}

function compareBucketServices(a: NormalizedContinentDispatchService, b: NormalizedContinentDispatchService) {
  return (a.date ?? "").localeCompare(b.date ?? "")
    || a.time.localeCompare(b.time)
    || a.customer_name.localeCompare(b.customer_name)
    || (a.hotel_name ?? "").localeCompare(b.hotel_name ?? "");
}

export function buildContinentDispatchBuckets(
  services: ContinentDispatchService[],
  options: { date?: string | null } = {}
): ContinentDispatchBuckets {
  const bruno: NormalizedContinentDispatchService[] = [];
  const unassigned: NormalizedContinentDispatchService[] = [];
  const vendorsByName = new Map<string, NormalizedContinentDispatchService[]>();

  for (const service of services) {
    if (!isContinentDispatchCandidate(service)) continue;

    const normalized = normalizeBucketService(service, options.date ?? null);

    if (service.effective_target === "bruno") {
      bruno.push(normalized);
      continue;
    }

    const vendor = service.target_source === "manual" ? service.vendor_name?.trim() : "";
    if (vendor) {
      const vendorServices = vendorsByName.get(vendor) ?? [];
      vendorServices.push(normalized);
      vendorsByName.set(vendor, vendorServices);
      continue;
    }

    unassigned.push(normalized);
  }

  const sortServices = (bucketServices: NormalizedContinentDispatchService[]) => [...bucketServices].sort(compareBucketServices);
  const vendors = [...vendorsByName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vendor, vendorServices]) => ({
      label: vendor,
      target: "continent_dispatch" as const,
      vendor,
      source: "manual" as const,
      services: sortServices(vendorServices),
    }));

  return {
    bruno: {
      label: "Bruno",
      target: "bruno",
      services: sortServices(bruno),
    },
    vendors,
    unassigned: {
      label: "Da smistare",
      target: "continent_dispatch",
      services: sortServices(unassigned),
    },
  };
}

export function toBrunoArrival(service: ContinentDispatchService): BrunoArrival {
  return {
    id: service.id,
    customer_name: service.customer_name,
    pax: service.pax,
    time: service.connection_time ?? service.time,
    vessel: service.vessel,
    arrival_at_ischia: service.arrival_at_ischia,
    connection_time: service.connection_time,
    place_type: service.place_type,
    meeting_point: service.meeting_point,
    phone: service.phone,
    hotel_name: service.hotel_name,
    notes: service.notes,
    flight_number: service.train_arrival_number,
    dispatch_source: service.target_source,
  };
}

export function toBrunoDeparture(service: ContinentDispatchService): BrunoDeparture {
  return {
    id: service.id,
    customer_name: service.customer_name,
    pax: service.pax,
    time: service.time,
    vessel: service.vessel,
    boat_t: service.boat_t,
    arrival_at_porto: service.arrival_at_porto,
    connection_time: service.connection_time,
    place_type: service.place_type,
    meeting_point: service.meeting_point,
    phone: service.phone,
    porto_bruno: service.porto_bruno,
    hotel_name: service.hotel_name,
    notes: service.notes,
    flight_number: service.train_departure_number,
    dispatch_source: service.target_source,
  };
}

export async function loadContinentDispatchServices(auth: PricingAuthContext, date: string) {
  const tenantId = auth.membership.tenant_id;
  const kindList = CONTINENT_TRANSFER_KINDS.join(",");
  const sharedSelect = [
    "id",
    "customer_name",
    "pax",
    "time",
    "arrival_time",
    "departure_time",
    "transport_code",
    "train_arrival_time",
    "vessel",
    "place_type",
    "meeting_point",
    "phone",
    "notes",
    "porto_bruno",
    "service_type_code",
    "booking_service_kind",
    "origin_place_type",
    "destination_place_type",
    "origin_label_raw",
    "destination_label_raw",
    "train_arrival_number",
    "train_departure_number",
    "continent_dispatch_target",
    "continent_dispatch_source",
    "continent_dispatch_vendor",
    "continent_dispatch_override_reason",
    "hotels(name, zone)",
  ].join(", ");

  const [arrivalsRes, departuresRes, settingsRes] = await Promise.all([
    auth.admin
      .from("services")
      .select(sharedSelect)
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .eq("direction", "arrival")
      .eq("is_draft", false)
      .neq("status", "cancelled")
      .or(`place_type.eq.airport,place_type.eq.station,service_type_code.eq.transfer_airport_hotel,service_type_code.eq.transfer_station_hotel,booking_service_kind.in.(${kindList})`)
      .order("time"),
    auth.admin
      .from("services")
      .select(sharedSelect)
      .eq("tenant_id", tenantId)
      .eq("is_draft", false)
      .neq("status", "cancelled")
      .or(`departure_date.eq.${date},and(date.eq.${date},direction.eq.departure,departure_date.is.null)`)
      .or(`place_type.eq.airport,place_type.eq.station,service_type_code.eq.transfer_airport_hotel,service_type_code.eq.transfer_station_hotel,booking_service_kind.in.(${kindList})`)
      .order("departure_time")
      .order("time"),
    auth.admin
      .from("tenant_operational_settings")
      .select("bruno_email")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
  ]);

  if (arrivalsRes.error) throw new Error(arrivalsRes.error.message);
  if (departuresRes.error) throw new Error(departuresRes.error.message);

  const arrivals = ((arrivalsRes.data ?? []) as unknown as ServiceRow[])
    .filter(isContinentDispatchCandidate)
    .map((row) => mapContinentDispatchRow({ ...row, direction: "arrival" }));
  const departures = ((departuresRes.data ?? []) as unknown as ServiceRow[])
    .filter(isContinentDispatchCandidate)
    .map((row) => mapContinentDispatchRow({ ...row, direction: "departure" }));

  return {
    arrivals,
    departures,
    services: [...arrivals, ...departures],
    brunoEmail: settingsRes.data?.bruno_email ?? null,
  };
}

export async function setContinentDispatchTarget(
  auth: PricingAuthContext,
  input: {
    serviceId: string;
    target: ContinentDispatchTarget;
    reason?: string | null;
  }
) {
  const patch: Record<string, unknown> = {
    continent_dispatch_target: input.target,
    continent_dispatch_source: "manual",
    continent_dispatch_override_reason: input.reason?.trim() || null,
    continent_dispatch_updated_at: new Date().toISOString(),
    continent_dispatch_updated_by: auth.user.id,
  };

  if (input.target === "bruno") {
    patch.continent_dispatch_vendor = null;
  }

  const { error } = await auth.admin
    .from("services")
    .update(patch)
    .eq("id", input.serviceId)
    .eq("tenant_id", auth.membership.tenant_id);

  if (error) throw new Error(error.message);
}

export async function resetContinentDispatchTarget(auth: PricingAuthContext, serviceId: string) {
  const { error } = await auth.admin
    .from("services")
    .update({
      continent_dispatch_target: null,
      continent_dispatch_source: null,
      continent_dispatch_override_reason: null,
      continent_dispatch_updated_at: new Date().toISOString(),
      continent_dispatch_updated_by: auth.user.id,
    })
    .eq("id", serviceId)
    .eq("tenant_id", auth.membership.tenant_id);

  if (error) throw new Error(error.message);
}

export async function setContinentDispatchVendor(auth: PricingAuthContext, serviceId: string, vendorName: string | null) {
  const { error } = await auth.admin
    .from("services")
    .update({
      continent_dispatch_vendor: vendorName?.trim() || null,
      continent_dispatch_updated_at: new Date().toISOString(),
      continent_dispatch_updated_by: auth.user.id,
    })
    .eq("id", serviceId)
    .eq("tenant_id", auth.membership.tenant_id);

  if (error) throw new Error(error.message);
}
