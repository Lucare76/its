export type PianoBoatType = "traghetto" | "aliscafo";

export type EffectiveDisembarkTimeInput = {
  arrivalTime?: string | null;
  departureTime?: string | null;
  departurePort?: string | null;
  boatType?: PianoBoatType | string | null;
};

export type FerryArrivalServiceLike = {
  time?: string | null;
  arrival_time?: string | null;
  orario_barca?: string | null;
  porto_bruno?: string | null;
  barca_compagnia?: string | null;
  booking_service_kind?: string | null;
  service_type_code?: string | null;
  vessel?: string | null;
  ferry_details?: Record<string, unknown> | null;
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
    .trim() ?? "";
}

export function minutesFromHHMM(value?: string | null) {
  const match = clean(value)?.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function hhmmFromMinutes(value: number) {
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function isPozzuoliPort(value?: string | null) {
  return normalize(value).includes("pozzuoli");
}

function isNapoliPort(value?: string | null) {
  const text = normalize(value);
  return text.includes("napoli") || text.includes("beverello") || text.includes("molo beverello");
}

function isAliscafo(value?: string | null) {
  return normalize(value).includes("aliscafo");
}

export function effectiveDisembarkTime(input: EffectiveDisembarkTimeInput): string | null {
  const arrivalMinutes = minutesFromHHMM(input.arrivalTime);
  const departureMinutes = minutesFromHHMM(input.departureTime);
  const departurePort = input.departurePort;

  if (isAliscafo(input.boatType) && isNapoliPort(departurePort)) {
    return arrivalMinutes == null ? null : hhmmFromMinutes(arrivalMinutes + 15);
  }

  if (isPozzuoliPort(departurePort)) {
    return arrivalMinutes == null ? null : hhmmFromMinutes(arrivalMinutes + 15);
  }

  if (isNapoliPort(departurePort)) {
    if (arrivalMinutes != null) return hhmmFromMinutes(arrivalMinutes + 20);
    return departureMinutes == null ? null : hhmmFromMinutes(departureMinutes + 90 + 20);
  }

  return arrivalMinutes == null ? null : hhmmFromMinutes(arrivalMinutes);
}

function serviceDetailValue(service: FerryArrivalServiceLike, key: string) {
  const value = service.ferry_details?.[key];
  return typeof value === "string" || typeof value === "number" ? clean(value) : null;
}

function nestedServiceDetailValue(service: FerryArrivalServiceLike, objectKey: string, key: string) {
  const value = service.ferry_details?.[objectKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nestedValue = (value as Record<string, unknown>)[key];
  return typeof nestedValue === "string" || typeof nestedValue === "number" ? clean(nestedValue) : null;
}

export function serviceFerryArrivalTime(service: FerryArrivalServiceLike) {
  return nestedServiceDetailValue(service, "db_computed", "arrival_at_ischia")
    ?? serviceDetailValue(service, "arrival_at_ischia")
    ?? serviceDetailValue(service, "arrivalTime")
    ?? serviceDetailValue(service, "arrival_time")
    ?? clean(service.arrival_time)
    ?? clean(service.time);
}

export function serviceFerryDepartureTime(service: FerryArrivalServiceLike) {
  return serviceDetailValue(service, "source_ferry_time")
    ?? serviceDetailValue(service, "ferry_time")
    ?? serviceDetailValue(service, "departureTime")
    ?? serviceDetailValue(service, "departure_time")
    ?? clean(service.orario_barca);
}

export function serviceFerryDeparturePort(service: FerryArrivalServiceLike) {
  return serviceDetailValue(service, "departure_port")
    ?? serviceDetailValue(service, "departurePort")
    ?? serviceDetailValue(service, "source_departure_port")
    ?? serviceDetailValue(service, "from")
    ?? serviceDetailValue(service, "porto_bruno")
    ?? nestedServiceDetailValue(service, "db_computed", "port_departure")
    ?? clean(service.porto_bruno)
    ?? clean(service.booking_service_kind)
    ?? clean(service.vessel);
}

export function serviceBoatType(service: FerryArrivalServiceLike): PianoBoatType {
  const text = normalize([
    serviceDetailValue(service, "boat_type"),
    serviceDetailValue(service, "boatType"),
    serviceDetailValue(service, "transport_type"),
    service.booking_service_kind,
    service.service_type_code,
    service.vessel,
    service.barca_compagnia,
  ].filter(Boolean).join(" "));
  return text.includes("aliscafo") ? "aliscafo" : "traghetto";
}

export function effectiveServiceDisembarkTime(service: FerryArrivalServiceLike) {
  return effectiveDisembarkTime({
    arrivalTime: serviceFerryArrivalTime(service),
    departureTime: serviceFerryDepartureTime(service),
    departurePort: serviceFerryDeparturePort(service),
    boatType: serviceBoatType(service),
  });
}
