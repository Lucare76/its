export type AssignableMacroCategory = "NAVETTA" | "ARRIVO" | "PARTENZA" | "ESCURSIONE" | "DA_VERIFICARE";

export type AssignablePlaceType =
  | "hotel"
  | "porto"
  | "luogo"
  | "aeroporto"
  | "stazione"
  | "zona"
  | "unknown";

export type AssignableHotel = {
  name?: string | null;
  zone?: string | null;
  lat?: number | null;
  lng?: number | null;
} | null;

export type AssignableService = {
  id: string;
  time?: string | null;
  time_from?: string | null;
  time_to?: string | null;
  direction?: "arrival" | "departure" | string | null;
  customer_name?: string | null;
  pax?: number | null;
  hotel_id?: string | null;
  vessel?: string | null;
  notes?: string | null;
  meeting_point?: string | null;
  place_type?: string | null;
  pickup_hotel?: string | null;
  pickup_time?: string | null;
  booking_service_kind?: string | null;
  service_type?: string | null;
  service_type_code?: string | null;
  transport_code?: string | null;
  arrival_time?: string | null;
  departure_time?: string | null;
  orario_barca?: string | null;
  barca_compagnia?: string | null;
  porto_bruno?: string | null;
  ferry_details?: Record<string, unknown> | null;
  excursion_details?: Record<string, unknown> | null;
  tour_name?: string | null;
  origin_place_type?: string | null;
  destination_place_type?: string | null;
};

export type ResolveAssignableContext = {
  hotel?: AssignableHotel;
  is_locked_assignment?: boolean;
};

export type AssignableServiceResolution = {
  service_id: string;
  macro_category: AssignableMacroCategory;
  assignable: boolean;
  needs_review: boolean;
  review_reasons: string[];
  operational_time: string | null;
  operational_time_to: string | null;
  pickup_label: string | null;
  pickup_type: AssignablePlaceType | null;
  pickup_zone: string | null;
  destination_label: string | null;
  destination_type: AssignablePlaceType | null;
  destination_zone: string | null;
  pax: number | null;
  capacity_required: number;
  connection_label: string | null;
  ferry_company: string | null;
  ferry_departure_time: string | null;
  ferry_arrival_time: string | null;
  port_departure: string | null;
  port_arrival: string | null;
  source_kind: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  hard_constraints: string[];
  soft_preferences: string[];
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

function normalizeLocation(value?: string | null) {
  return normalize(value);
}

function isValidIslandPort(value?: string | null) {
  const text = normalizeLocation(value);
  if (!text) return false;
  return text === "ischia"
    || text.includes("ischia porto")
    || text.includes("porto ischia")
    || text.includes("casamicciola")
    || text.includes("piazza marina casamicciola")
    || text === "forio"
    || text.includes("porto di forio")
    || text.includes("forio porto");
}

function isContinentLocation(value?: string | null) {
  const text = normalizeLocation(value);
  if (!text) return false;
  return text.includes("pozzuoli")
    || text.includes("napoli")
    || text.includes("beverello")
    || text.includes("molo beverello")
    || text.includes("aeroporto")
    || text.includes("capodichino")
    || text.includes("stazione")
    || text.includes("napoli centrale")
    || text.includes("metropark")
    || text.includes("afragola");
}

function sameOperationalPlace(a?: string | null, b?: string | null) {
  const left = normalizeLocation(a);
  const right = normalizeLocation(b);
  return Boolean(left && right && left === right);
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function time(value?: string | null) {
  const raw = clean(value);
  const match = raw?.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function detailValue(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" || typeof value === "number" ? clean(value) : null;
}

function nestedDetailValue(record: Record<string, unknown> | null | undefined, objectKey: string, key: string) {
  const value = record?.[objectKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return detailValue(value as Record<string, unknown>, key);
}

function isAirportLike(value?: string | null) {
  const text = normalize(value);
  return text.includes("aeroporto") || text.includes("airport") || text.includes("capodichino");
}

function isStationLike(value?: string | null) {
  const text = normalize(value);
  return text.includes("stazione") || text.includes("station") || text.includes("napoli centrale") || text.includes("treno");
}

export function isAssignablePortLike(value?: string | null) {
  const text = normalize(value);
  if (!text) return false;
  if (text === "ischia") return true;
  return /\b(porto|casamicciola|pozzuoli|beverello|molo|aliscafo|traghetto)\b/.test(text)
    || text.includes("ischia porto")
    || text.includes("porto ischia");
}

function placeType(label?: string | null, explicit?: string | null): AssignablePlaceType | null {
  const explicitType = normalize(explicit);
  if (explicitType === "hotel") return "hotel";
  if (explicitType === "airport") return "aeroporto";
  if (explicitType === "station") return "stazione";
  if (explicitType === "port" || explicitType === "porto") return "porto";
  if (isAirportLike(label)) return "aeroporto";
  if (isStationLike(label)) return "stazione";
  if (isAssignablePortLike(label)) return "porto";
  return label ? "luogo" : null;
}

function portLabel(value?: string | null) {
  const raw = clean(value);
  if (!raw) return null;
  if (isContinentLocation(raw)) return raw;
  if (!isAssignablePortLike(raw)) return null;
  const text = normalize(raw);
  if (text.includes("casamicciola")) return "Casamicciola";
  if (text.includes("pozzuoli")) return "Pozzuoli";
  if (text.includes("beverello") || text.includes("napoli")) return "Napoli Beverello";
  if (text.includes("ischia")) return "Ischia Porto";
  return raw;
}

function islandPortLabel(value?: string | null) {
  const raw = clean(value);
  if (!raw || !isValidIslandPort(raw)) return null;
  const text = normalize(raw);
  if (text.includes("casamicciola") || text.includes("piazza marina")) return "Casamicciola";
  if (text.includes("forio")) return "Forio";
  if (text.includes("ischia")) return "Ischia Porto";
  return raw;
}

function islandPortFromRoute(value?: string | null) {
  const raw = clean(value);
  if (!raw) return null;
  const parts = raw
    .split(/\s+-\s+|->|→/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts.slice().reverse()) {
    const port = islandPortLabel(part);
    if (port) return port;
  }
  return islandPortLabel(raw);
}

function companyLabel(service: AssignableService) {
  const raw = clean(service.barca_compagnia)
    ?? detailValue(service.ferry_details, "ferry_company")
    ?? detailValue(service.ferry_details, "company")
    ?? clean(service.vessel);
  const text = normalize(raw);
  if (text.includes("snav")) return "SNAV";
  if (text.includes("medmar")) return "Medmar";
  if (text.includes("alilauro")) return "Alilauro";
  if (text.includes("caremar")) return "Caremar";
  return raw;
}

function ferryDepartureTime(service: AssignableService) {
  return time(service.orario_barca)
    ?? time(detailValue(service.ferry_details, "source_ferry_time"))
    ?? time(detailValue(service.ferry_details, "ferry_time"))
    ?? time(detailValue(service.ferry_details, "departureTime"))
    ?? time(detailValue(service.ferry_details, "departure_time"));
}

function ferryDepartureTimeForArrival(service: AssignableService) {
  return time(detailValue(service.ferry_details, "source_ferry_time"))
    ?? time(detailValue(service.ferry_details, "ferry_time"))
    ?? time(detailValue(service.ferry_details, "departureTime"))
    ?? time(detailValue(service.ferry_details, "departure_time"))
    ?? time(service.orario_barca);
}

function ferryArrivalTime(service: AssignableService) {
  return time(nestedDetailValue(service.ferry_details, "db_computed", "arrival_at_ischia"))
    ?? time(detailValue(service.ferry_details, "arrival_at_ischia"))
    ?? time(detailValue(service.ferry_details, "arrivalTime"))
    ?? time(detailValue(service.ferry_details, "arrival_time"));
}

function minutesFromTime(value?: string | null) {
  const match = clean(value)?.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatTimeFromMinutes(value: number) {
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function ferryDurationMinutes(company?: string | null) {
  const text = normalize(company);
  if (text.includes("medmar")) return 60;
  if (text.includes("caremar")) return 90;
  if (text.includes("snav")) return 50;
  if (text.includes("alilauro")) return 50;
  return null;
}

function computedIslandArrivalTime(company?: string | null, departure?: string | null) {
  const departureMinutes = minutesFromTime(departure);
  const duration = ferryDurationMinutes(company);
  if (departureMinutes == null || duration == null) return null;
  return formatTimeFromMinutes(departureMinutes + duration);
}

function ferryArrivalPort(service: AssignableService) {
  return islandPortLabel(detailValue(service.ferry_details, "arrival_port"))
    ?? islandPortLabel(detailValue(service.ferry_details, "arrivalPort"))
    ?? islandPortLabel(nestedDetailValue(service.ferry_details, "db_computed", "port_arrival"))
    ?? islandPortLabel(nestedDetailValue(service.ferry_details, "db_computed", "porto_bruno"))
    ?? islandPortFromRoute(nestedDetailValue(service.ferry_details, "db_computed", "nave_db"))
    ?? islandPortFromRoute(clean(service.vessel))
    ?? islandPortLabel(service.porto_bruno)
    ?? islandPortLabel(service.meeting_point);
}

function ferryDeparturePort(service: AssignableService) {
  return islandPortLabel(detailValue(service.ferry_details, "departure_port"))
    ?? islandPortLabel(detailValue(service.ferry_details, "departurePort"))
    ?? islandPortLabel(nestedDetailValue(service.ferry_details, "db_computed", "port_departure"))
    ?? islandPortLabel(detailValue(service.ferry_details, "porto_imbarco_isola"))
    ?? islandPortLabel(detailValue(service.ferry_details, "to"))
    ?? islandPortFromRoute(nestedDetailValue(service.ferry_details, "db_computed", "nave_db"))
    ?? islandPortFromRoute(clean(service.vessel))
    ?? islandPortLabel(service.porto_bruno)
    ?? islandPortLabel(service.meeting_point);
}

function sourceLocation(service: AssignableService) {
  return detailValue(service.excursion_details, "from")
    ?? detailValue(service.ferry_details, "from")
    ?? clean(service.meeting_point);
}

function destinationLocation(service: AssignableService) {
  return detailValue(service.excursion_details, "to")
    ?? detailValue(service.ferry_details, "to")
    ?? clean(service.tour_name)
    ?? null;
}

function isNavetta(service: AssignableService) {
  const kind = normalize(service.booking_service_kind);
  const code = normalize(service.service_type_code);
  return kind === "navetta" || kind === "shuttle hotel" || kind === "bus city hotel" || code === "bus line";
}

function isExcursion(service: AssignableService) {
  const kind = normalize(service.booking_service_kind);
  const code = normalize(service.service_type_code);
  const type = normalize(service.service_type);
  return kind === "excursion" || code === "excursion" || type === "bus tour";
}

function isFormulaOrFerry(service: AssignableService) {
  const kind = normalize(service.booking_service_kind);
  const code = normalize(service.service_type_code);
  return kind.startsWith("formula ") || code === "ferry transfer";
}

function inferMacroCategory(service: AssignableService): AssignableMacroCategory {
  if (isNavetta(service)) return "NAVETTA";
  if (isExcursion(service)) return "ESCURSIONE";
  if (service.direction === "arrival") return "ARRIVO";
  if (service.direction === "departure") return "PARTENZA";
  return "DA_VERIFICARE";
}

function hotelName(context?: ResolveAssignableContext) {
  return clean(context?.hotel?.name);
}

function hotelZone(context?: ResolveAssignableContext) {
  return clean(context?.hotel?.zone);
}

function cameraReferenceSoftPreference(customerName?: string | null) {
  const text = normalize(customerName);
  if (/^cam(?:era)?\s+\d/.test(text)) return "Nome cliente non disponibile: riferimento camera";
  return null;
}

function addMissingBaseReasons(reasons: string[], resolution: Pick<AssignableServiceResolution, "macro_category" | "operational_time" | "pickup_label" | "destination_label" | "pax">) {
  if (resolution.macro_category === "DA_VERIFICARE") reasons.push("Macro categoria non determinata");
  if (!resolution.operational_time) reasons.push("Orario operativo non determinato");
  if (!resolution.pickup_label) reasons.push("Pickup mancante");
  if (!resolution.destination_label) reasons.push("Destinazione mancante");
  if (!resolution.pickup_label && !resolution.destination_label) reasons.push("Pickup e destinazione entrambi mancanti");
  if (!resolution.pax || resolution.pax <= 0) reasons.push("Pax mancante/non valido");
}

function applyOperationalHardConstraints(
  reasons: string[],
  hardConstraints: string[],
  resolution: Pick<
    AssignableServiceResolution,
    "macro_category" | "operational_time" | "pickup_label" | "destination_label" | "port_arrival" | "port_departure"
  >
) {
  if (!resolution.operational_time) {
    addUnique(reasons, "Orario operativo non determinato");
    addUnique(hardConstraints, "operational_time_required");
  }

  if (!resolution.pickup_label && !resolution.destination_label) {
    addUnique(reasons, "Pickup e destinazione entrambi mancanti");
    addUnique(hardConstraints, "pickup_destination_required");
  }

  if (resolution.macro_category === "ARRIVO") {
    const pickup = resolution.pickup_label ?? resolution.port_arrival;
    if (isContinentLocation(pickup)) {
      addUnique(reasons, "Luogo continente usato come punto presa isola");
      addUnique(hardConstraints, "island_arrival_pickup_required");
    } else if (!isValidIslandPort(pickup)) {
      addUnique(reasons, "Porto arrivo isola non determinato");
      addUnique(hardConstraints, "island_arrival_pickup_required");
    }
  }

  if (resolution.macro_category === "PARTENZA") {
    const destination = resolution.destination_label ?? resolution.port_departure;
    if (isContinentLocation(destination)) {
      addUnique(reasons, "Destinazione continente usata come destinazione operativa isola");
      addUnique(hardConstraints, "island_departure_port_required");
    } else if (!isValidIslandPort(destination)) {
      addUnique(reasons, "Porto imbarco isola non determinato");
      addUnique(hardConstraints, "island_departure_port_required");
    }
  }

  if (resolution.destination_label && isContinentLocation(resolution.destination_label)) {
    addUnique(reasons, "Destinazione continente usata come destinazione operativa isola");
    addUnique(hardConstraints, "continent_destination_blocked");
  }

  if (
    resolution.macro_category === "NAVETTA"
    && sameOperationalPlace(resolution.pickup_label, resolution.destination_label)
  ) {
    addUnique(reasons, "Pickup navetta uguale a destinazione");
    addUnique(hardConstraints, "navetta_pickup_equals_destination");
  }
}

function makeResolution(
  service: AssignableService,
  context: ResolveAssignableContext | undefined,
  partial: Omit<AssignableServiceResolution, "service_id" | "assignable" | "needs_review" | "review_reasons" | "capacity_required" | "source_kind" | "booking_service_kind" | "service_type_code" | "hard_constraints" | "soft_preferences"> & {
    review_reasons?: string[];
    hard_constraints?: string[];
    soft_preferences?: string[];
  }
): AssignableServiceResolution {
  const reviewReasons = [...(partial.review_reasons ?? [])];
  addMissingBaseReasons(reviewReasons, {
    macro_category: partial.macro_category,
    operational_time: partial.operational_time,
    pickup_label: partial.pickup_label,
    destination_label: partial.destination_label,
    pax: partial.pax,
  });

  const hardConstraints = [...(partial.hard_constraints ?? [])];
  if (context?.is_locked_assignment) {
    hardConstraints.push("locked_assignment");
    reviewReasons.push("Assignment manuale locked");
  }

  applyOperationalHardConstraints(reviewReasons, hardConstraints, {
    macro_category: partial.macro_category,
    operational_time: partial.operational_time,
    pickup_label: partial.pickup_label,
    destination_label: partial.destination_label,
    port_arrival: partial.port_arrival,
    port_departure: partial.port_departure,
  });

  const softPreferences = [...(partial.soft_preferences ?? [])];
  const cameraPreference = cameraReferenceSoftPreference(service.customer_name);
  if (cameraPreference) softPreferences.push(cameraPreference);

  const uniqueReasons = Array.from(new Set(reviewReasons));
  const needsReview = uniqueReasons.length > 0 || hardConstraints.includes("locked_assignment");

  return {
    ...partial,
    service_id: service.id,
    assignable: !needsReview,
    needs_review: needsReview,
    review_reasons: uniqueReasons,
    capacity_required: Math.max(0, Number(partial.pax ?? 0) || 0),
    source_kind: clean(service.service_type),
    booking_service_kind: clean(service.booking_service_kind),
    service_type_code: clean(service.service_type_code),
    hard_constraints: Array.from(new Set(hardConstraints)),
    soft_preferences: Array.from(new Set(softPreferences)),
  };
}

export function resolveAssignableService(
  service: AssignableService,
  context?: ResolveAssignableContext
): AssignableServiceResolution {
  const macro = inferMacroCategory(service);
  const pax = Number.isFinite(service.pax) ? service.pax ?? null : null;
  const ferryCompany = companyLabel(service);
  const ferryDepTime = macro === "ARRIVO" ? ferryDepartureTimeForArrival(service) : ferryDepartureTime(service);
  const explicitFerryArrTime = ferryArrivalTime(service);
  const ferryArrTime = explicitFerryArrTime ?? (macro === "ARRIVO" ? computedIslandArrivalTime(ferryCompany, ferryDepTime) : null);
  const portDeparture = ferryDeparturePort(service);
  const portArrival = ferryArrivalPort(service);
  const hotel = hotelName(context);
  const zone = hotelZone(context);

  if (macro === "NAVETTA") {
    const meetingPoint = clean(service.meeting_point);
    const pickup = service.direction === "departure" ? hotel : meetingPoint;
    const destination = service.direction === "departure" ? meetingPoint : hotel;
    const reviewReasons: string[] = [];
    if (!meetingPoint || !hotel) reviewReasons.push("Pickup navetta non abbastanza specifico");
    return makeResolution(service, context, {
      macro_category: "NAVETTA",
      operational_time: time(service.pickup_time) ?? time(service.pickup_hotel) ?? time(service.time),
      operational_time_to: time(service.time_to),
      pickup_label: pickup,
      pickup_type: placeType(pickup, service.direction === "departure" ? "hotel" : service.place_type),
      pickup_zone: service.direction === "departure" ? zone : portLabel(meetingPoint) ?? null,
      destination_label: destination,
      destination_type: placeType(destination, service.direction === "departure" ? service.place_type : "hotel"),
      destination_zone: service.direction === "departure" ? portLabel(meetingPoint) ?? null : zone,
      pax,
      connection_label: null,
      ferry_company: null,
      ferry_departure_time: null,
      ferry_arrival_time: null,
      port_departure: null,
      port_arrival: null,
      review_reasons: reviewReasons,
      hard_constraints: [],
      soft_preferences: [],
    });
  }

  if (macro === "ESCURSIONE") {
    const pickup = sourceLocation(service);
    const destination = destinationLocation(service);
    const reviewReasons = [
      pickup ? null : "Punto partenza escursione mancante",
      destination ? null : "Destinazione escursione mancante",
    ].filter(Boolean) as string[];
    return makeResolution(service, context, {
      macro_category: "ESCURSIONE",
      operational_time: time(service.departure_time) ?? time(service.time),
      operational_time_to: time(service.time_to),
      pickup_label: pickup,
      pickup_type: placeType(pickup),
      pickup_zone: null,
      destination_label: destination,
      destination_type: placeType(destination),
      destination_zone: null,
      pax,
      connection_label: null,
      ferry_company: null,
      ferry_departure_time: null,
      ferry_arrival_time: null,
      port_departure: null,
      port_arrival: null,
      review_reasons: reviewReasons,
      hard_constraints: [],
      soft_preferences: [],
    });
  }

  if (macro === "ARRIVO") {
    const isConnectionFromContinent =
      isAirportLike(service.meeting_point)
      || isStationLike(service.meeting_point)
      || service.place_type === "airport"
      || service.place_type === "station"
      || service.origin_place_type === "airport"
      || service.origin_place_type === "station";
    const operationalTime = ferryArrTime ?? (!isConnectionFromContinent ? time(service.arrival_time) ?? time(service.time) : null);
    const pickup = portArrival ?? (!isConnectionFromContinent ? portLabel(service.meeting_point) : null);
    const destination = hotel;
    const connectionParts = [
      clean(service.transport_code),
      ferryCompany && ferryDepTime ? `${ferryCompany} ${ferryDepTime}` : null,
    ].filter(Boolean);
    const reviewReasons = [
      operationalTime ? null : "Arrivo isola non determinato",
      pickup ? null : "Porto arrivo isola non determinato",
    ].filter(Boolean) as string[];
    return makeResolution(service, context, {
      macro_category: "ARRIVO",
      operational_time: operationalTime,
      operational_time_to: time(service.time_to),
      pickup_label: pickup,
      pickup_type: pickup ? "porto" : null,
      pickup_zone: pickup,
      destination_label: destination,
      destination_type: destination ? "hotel" : null,
      destination_zone: zone,
      pax,
      connection_label: connectionParts.join(" | ") || null,
      ferry_company: ferryCompany,
      ferry_departure_time: ferryDepTime,
      ferry_arrival_time: ferryArrTime,
      port_departure: portDeparture,
      port_arrival: portArrival,
      review_reasons: reviewReasons,
      hard_constraints: [],
      soft_preferences: [],
    });
  }

  if (macro === "PARTENZA") {
    const pickup = hotel ?? clean(service.meeting_point);
    const destination = portDeparture;
    const reviewReasons = [
      destination ? null : "Porto imbarco non determinato",
    ].filter(Boolean) as string[];
    return makeResolution(service, context, {
      macro_category: "PARTENZA",
      operational_time: time(service.pickup_hotel) ?? time(service.pickup_time),
      operational_time_to: time(service.time_to),
      pickup_label: pickup,
      pickup_type: pickup === hotel ? "hotel" : placeType(pickup),
      pickup_zone: zone,
      destination_label: destination ?? "Porto da verificare",
      destination_type: destination ? "porto" : "unknown",
      destination_zone: destination,
      pax,
      connection_label: ferryCompany && ferryDepTime ? `${ferryCompany} ${ferryDepTime}` : null,
      ferry_company: ferryCompany,
      ferry_departure_time: ferryDepTime,
      ferry_arrival_time: ferryArrTime,
      port_departure: portDeparture,
      port_arrival: portArrival,
      review_reasons: reviewReasons,
      hard_constraints: isFormulaOrFerry(service) ? ["island_ferry_detail"] : [],
      soft_preferences: [],
    });
  }

  return makeResolution(service, context, {
    macro_category: "DA_VERIFICARE",
    operational_time: time(service.time),
    operational_time_to: time(service.time_to),
    pickup_label: null,
    pickup_type: null,
    pickup_zone: null,
    destination_label: null,
    destination_type: null,
    destination_zone: null,
    pax,
    connection_label: null,
    ferry_company: ferryCompany,
    ferry_departure_time: ferryDepTime,
    ferry_arrival_time: ferryArrTime,
    port_departure: portDeparture,
    port_arrival: portArrival,
    review_reasons: ["Macro categoria non determinata"],
    hard_constraints: [],
    soft_preferences: [],
  });
}
