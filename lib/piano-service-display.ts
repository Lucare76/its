export type PianoDisplayBadge =
  | "NAVETTA"
  | "FORMULA NAVE"
  | "ESCURSIONE"
  | "TRANSFER AEROPORTO"
  | "TRANSFER STAZIONE"
  | "DA VERIFICARE";

export type PianoMacroCategory = "NAVETTA" | "ARRIVO" | "PARTENZA" | "ESCURSIONE";
export type PianoDisplaySeverity = "normal" | "warning" | "review";

export type PianoDisplayHotel = {
  name?: string | null;
  zone?: string | null;
} | null | undefined;

export type PianoDisplayService = {
  id?: string;
  date?: string | null;
  time?: string | null;
  direction?: "arrival" | "departure" | string | null;
  customer_name?: string | null;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  pax?: number | null;
  phone?: string | null;
  notes?: string | null;
  vessel?: string | null;
  meeting_point?: string | null;
  place_type?: string | null;
  pickup_hotel?: string | null;
  pickup_time?: string | null;
  booking_service_kind?: string | null;
  service_type?: string | null;
  service_type_code?: string | null;
  transport_code?: string | null;
  train_arrival_number?: string | null;
  train_arrival_time?: string | null;
  train_departure_number?: string | null;
  train_departure_time?: string | null;
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

export type PianoServiceDisplay = {
  badge: PianoDisplayBadge;
  macroCategory: PianoMacroCategory;
  serviceLabel: string;
  primaryTime: string | null;
  actionLabel: string;
  pickupLabel: string | null;
  destinationLabel: string | null;
  connectionLabel: string | null;
  transportRef: string | null;
  ferryLabel: string | null;
  paxLabel: string;
  noteLabel: string | null;
  importTag: string | null;
  warnings: string[];
  title: string;
  detailLines: string[];
  clientLabel: string;
  placeLabel: string;
  phoneLabel: string;
  compactImportTag: string | null;
  operationalNote: string | null;
  severity: PianoDisplaySeverity;
};

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function fmtTime(value?: string | null) {
  const normalized = clean(value);
  return normalized ? normalized.slice(0, 5) : null;
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

function normalize(value?: string | null) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") ?? "";
}

export function isPianoPortLike(value?: string | null) {
  const text = normalize(value).replace(/[_-]+/g, " ");
  if (!text) return false;
  return /\b(porto|casamicciola|beverello|pozzuoli|aliscafo|traghetto|snav|medmar|alilauro|caremar)\b/.test(text)
    || text === "ischia";
}

function portLabel(value?: string | null) {
  const raw = clean(value);
  if (!raw || !isPianoPortLike(raw)) return null;
  const text = normalize(raw).replace(/[_-]+/g, " ");
  if (text.includes("casamicciola")) return "Casamicciola";
  if (text.includes("pozzuoli")) return "Pozzuoli";
  if (text.includes("beverello") || text.includes("napoli")) return "Napoli Beverello";
  if (text.includes("ischia")) return "Ischia Porto";
  return raw;
}

function readablePlaceLabel(value?: string | null) {
  const raw = clean(value);
  if (!raw) return null;
  const text = normalize(raw).replace(/[_-]+/g, " ");
  if (text === "station" || text === "stazione") return "Stazione";
  if (text === "airport" || text === "aeroporto") return "Aeroporto";
  if (text.includes("casamicciola")) return "Casamicciola";
  if (text === "forio") return "Forio";
  if (text.includes("napoli beverello")) return "Napoli Beverello";
  if (text === "napoli") return "Napoli";
  if (text.includes("pozzuoli")) return "Pozzuoli";
  if (text.includes("ischia porto") || text === "ischia") return "Ischia Porto";
  return raw.replace(/[_-]+/g, " ");
}

function companyLabel(service: PianoDisplayService) {
  const raw = clean(service.barca_compagnia) ?? clean(service.vessel) ?? detailValue(service.ferry_details, "ferry_company");
  if (!raw) return null;
  const text = normalize(raw);
  if (text.includes("snav")) return "SNAV";
  if (text.includes("medmar")) return "Medmar";
  if (text.includes("alilauro")) return "Alilauro";
  if (text.includes("caremar")) return "Caremar";
  return raw;
}

function clientLabel(service: PianoDisplayService) {
  const full = [clean(service.customer_first_name), clean(service.customer_last_name)].filter(Boolean).join(" ");
  const name = full || clean(service.customer_name) || "Cliente da verificare";
  return `${name}${service.pax ? ` · ${service.pax} pax` : ""}`;
}

function paxLabel(service: PianoDisplayService) {
  return `${Number(service.pax ?? 0) || 0} pax`;
}

function splitImportNote(notes?: string | null) {
  const raw = String(notes ?? "").trim();
  if (!raw) return { operationalNote: null, compactImportTag: null };
  const match = raw.match(/Import operational_v2 riga\s+(\d+)/i);
  const compactImportTag = match ? `op_v2 #${match[1]}` : null;
  const operationalNote = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Import operational_v2 riga\s+\d+/i.test(line))
    .join(" | ") || null;
  return { operationalNote, compactImportTag };
}

function serviceBadge(service: PianoDisplayService): PianoDisplayBadge {
  const kind = normalize(service.booking_service_kind);
  const code = normalize(service.service_type_code);
  const type = normalize(service.service_type);
  const placeType = normalize(service.place_type);
  const originType = normalize(service.origin_place_type);
  const destinationType = normalize(service.destination_place_type);

  if (kind === "navetta" || kind === "shuttle_hotel" || kind === "bus_city_hotel" || code === "bus_line") return "NAVETTA";
  if (kind.startsWith("formula_") || code === "ferry_transfer") return "FORMULA NAVE";
  if (kind === "excursion" || code === "excursion" || type === "bus_tour") return "ESCURSIONE";
  if (kind.includes("airport") || code.includes("airport") || placeType === "airport" || originType === "airport" || destinationType === "airport") return "TRANSFER AEROPORTO";
  if (kind.includes("train") || code.includes("station") || placeType === "station" || originType === "station" || destinationType === "station") return "TRANSFER STAZIONE";
  return "DA VERIFICARE";
}

function macroCategory(service: PianoDisplayService, badge: PianoDisplayBadge): PianoMacroCategory {
  if (badge === "NAVETTA") return "NAVETTA";
  if (badge === "ESCURSIONE") return "ESCURSIONE";
  return service.direction === "arrival" ? "ARRIVO" : "PARTENZA";
}

function hotelLabel(hotel: PianoDisplayHotel) {
  return clean(hotel?.name) ?? null;
}

function hotelWithZone(hotel: PianoDisplayHotel) {
  return [clean(hotel?.name), clean(hotel?.zone)].filter(Boolean).join(" · ") || null;
}

function ferryPort(service: PianoDisplayService) {
  return portLabel(service.porto_bruno)
    ?? portLabel(nestedDetailValue(service.ferry_details, "db_computed", "porto_bruno"))
    ?? portLabel(detailValue(service.ferry_details, "porto_bruno"))
    ?? portLabel(detailValue(service.ferry_details, "arrival_port"))
    ?? portLabel(detailValue(service.ferry_details, "arrivalPort"))
    ?? portLabel(service.meeting_point);
}

function connectionLabel(service: PianoDisplayService, badge: PianoDisplayBadge) {
  const kind = badge === "TRANSFER AEROPORTO" ? "volo" : "treno";
  const ref = clean(service.transport_code)
    ?? clean(service.train_arrival_number)
    ?? clean(service.train_departure_number)
    ?? clean(service.vessel);
  const time = fmtTime(service.direction === "arrival" ? service.arrival_time ?? service.train_arrival_time : service.departure_time ?? service.train_departure_time);
  return [kind, ref, time].filter(Boolean).join(" ");
}

function connectionTransportLabel(service: PianoDisplayService, badge: PianoDisplayBadge) {
  const isFlight = badge === "TRANSFER AEROPORTO";
  const kind = isFlight ? "Volo" : "Treno";
  const ref = clean(service.transport_code)
    ?? clean(service.train_arrival_number)
    ?? clean(service.train_departure_number);
  const time = fmtTime(isFlight ? service.arrival_time : service.train_arrival_time ?? service.arrival_time);
  if (!ref && !time) return null;
  return [kind, ref, time].filter(Boolean).join(" ");
}

function buildTransportRef(service: PianoDisplayService, badge: PianoDisplayBadge) {
  const isArrival = service.direction === "arrival";
  if (badge !== "TRANSFER AEROPORTO" && badge !== "TRANSFER STAZIONE") return null;

  const isFlight = badge === "TRANSFER AEROPORTO";
  const kind = isFlight ? "Volo" : "Treno";
  const suffix = isArrival ? "arr." : "par.";
  const ref = isArrival
    ? isFlight
      ? clean(service.transport_code) ?? clean(service.train_arrival_number)
      : clean(service.transport_code) ?? clean(service.train_arrival_number) ?? clean(service.train_departure_number)
    : isFlight
      ? clean(service.transport_code) ?? clean(service.train_departure_number)
      : clean(service.transport_code) ?? clean(service.train_departure_number) ?? clean(service.train_arrival_number);
  const time = isArrival
    ? isFlight
      ? fmtTime(service.arrival_time) ?? fmtTime(service.train_arrival_time)
      : fmtTime(service.train_arrival_time) ?? fmtTime(service.arrival_time)
    : isFlight
      ? fmtTime(service.departure_time) ?? fmtTime(service.train_departure_time)
      : fmtTime(service.train_departure_time) ?? fmtTime(service.departure_time);

  if (!ref && !time) return null;
  return [kind, ref, suffix, time].filter(Boolean).join(" ");
}

function ferryLabel(service: PianoDisplayService) {
  const company = companyLabel(service);
  const ferryTime = fmtTime(service.orario_barca)
    ?? detailValue(service.ferry_details, "source_ferry_time")
    ?? detailValue(service.ferry_details, "ferry_time");
  const label = [company, ferryTime].filter(Boolean).join(" ");
  if (!label) return null;
  return label;
}

function islandArrivalTime(service: PianoDisplayService) {
  return fmtTime(nestedDetailValue(service.ferry_details, "db_computed", "arrival_at_ischia"))
    ?? fmtTime(detailValue(service.ferry_details, "arrival_at_ischia"));
}

function ferryDeparturePort(service: PianoDisplayService) {
  return readablePlaceLabel(detailValue(service.ferry_details, "departure_port"))
    ?? readablePlaceLabel(detailValue(service.ferry_details, "departurePort"))
    ?? readablePlaceLabel(detailValue(service.ferry_details, "source_departure_port"))
    ?? readablePlaceLabel(detailValue(service.ferry_details, "from"))
    ?? readablePlaceLabel(detailValue(service.ferry_details, "porto_bruno"))
    ?? readablePlaceLabel(nestedDetailValue(service.ferry_details, "db_computed", "port_departure"))
    ?? readablePlaceLabel(service.porto_bruno);
}

function vesselRouteArrivalPort(service: PianoDisplayService) {
  const raw = nestedDetailValue(service.ferry_details, "db_computed", "nave_db")
    ?? detailValue(service.ferry_details, "nave_db")
    ?? clean(service.vessel);
  const parts = raw?.split(/\s+-\s+/).map((part) => clean(part)).filter(Boolean);
  return parts && parts.length >= 4 ? readablePlaceLabel(parts[parts.length - 1]) : null;
}

function departureEmbarkPort(service: PianoDisplayService) {
  return vesselRouteArrivalPort(service)
    ?? readablePlaceLabel(nestedDetailValue(service.ferry_details, "db_computed", "porto_bruno"))
    ?? readablePlaceLabel(detailValue(service.ferry_details, "departure_port"))
    ?? readablePlaceLabel(detailValue(service.ferry_details, "departurePort"))
    ?? readablePlaceLabel(detailValue(service.ferry_details, "porto_bruno"))
    ?? readablePlaceLabel(service.porto_bruno);
}

function arrivalConnectionLabel(args: {
  service: PianoDisplayService;
  badge: PianoDisplayBadge;
  pickup: string | null;
  origin: string | null;
  ferry: string | null;
  arrivalAtIsland: string | null;
}) {
  const origin = readablePlaceLabel(args.origin);
  const showOrigin = origin && !samePlace(origin, args.pickup) ? `Da ${origin}` : null;
  const transport = args.badge === "TRANSFER AEROPORTO" || args.badge === "TRANSFER STAZIONE"
    ? connectionTransportLabel(args.service, args.badge)
    : null;
  const ferryTime = fmtTime(args.service.orario_barca)
    ?? fmtTime(detailValue(args.service.ferry_details, "source_ferry_time"))
    ?? fmtTime(detailValue(args.service.ferry_details, "ferry_time"));
  const ferryPort = ferryDeparturePort(args.service);
  const ferryCompany = companyLabel(args.service) ?? (ferryTime ? args.ferry?.replace(ferryTime, "").trim() : args.ferry);
  const ferryPart = ferryCompany || ferryTime || ferryPort
    ? [`Traghetto`, ferryCompany, ferryTime, ferryPort ? `da ${ferryPort}` : null].filter(Boolean).join(" ")
    : null;
  const arrival = args.arrivalAtIsland ? `Arrivo Ischia ${args.arrivalAtIsland}` : null;
  const first = [showOrigin, transport].filter(Boolean).join(" · ") || null;
  return [first, ferryPart, arrival].filter(Boolean).join(" → ") || null;
}

function departureConnectionLabel(args: {
  service: PianoDisplayService;
  ferry: string | null;
}) {
  const ferryTime = fmtTime(args.service.orario_barca)
    ?? fmtTime(detailValue(args.service.ferry_details, "source_ferry_time"))
    ?? fmtTime(detailValue(args.service.ferry_details, "ferry_time"));
  const ferryCompany = companyLabel(args.service) ?? (ferryTime ? args.ferry?.replace(ferryTime, "").trim() : args.ferry);
  return ferryCompany || ferryTime
    ? [`Traghetto`, ferryCompany, ferryTime].filter(Boolean).join(" ")
    : null;
}

function samePlace(left?: string | null, right?: string | null) {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function sourceLocation(service: PianoDisplayService) {
  return detailValue(service.excursion_details, "from")
    ?? detailValue(service.ferry_details, "from")
    ?? clean(service.meeting_point);
}

function destinationLocation(service: PianoDisplayService) {
  return detailValue(service.excursion_details, "to")
    ?? detailValue(service.ferry_details, "to")
    ?? clean(service.tour_name)
    ?? clean(service.vessel);
}

function buildDisplay(args: {
  badge: PianoDisplayBadge;
  macroCategory: PianoMacroCategory;
  serviceLabel: string;
  primaryTime: string | null;
  actionLabel: string;
  pickupLabel: string | null;
  destinationLabel: string | null;
  connectionLabel: string | null;
  transportRef?: string | null;
  ferryLabel: string | null;
  clientLabel: string;
  paxLabel: string;
  phoneLabel: string;
  noteLabel: string | null;
  importTag: string | null;
  warnings: string[];
  title?: string;
  detailLines?: string[];
  placeLabel?: string;
  severity?: PianoDisplaySeverity;
}): PianoServiceDisplay {
  const detailLines = args.detailLines ?? [
    args.actionLabel,
    args.pickupLabel ? `Pickup: ${args.pickupLabel}` : null,
    args.destinationLabel ? `Destinazione: ${args.destinationLabel}` : null,
    args.connectionLabel ? `Connessione: ${args.connectionLabel}` : null,
    args.transportRef ?? null,
    args.ferryLabel ? `Nave: ${args.ferryLabel}` : null,
    ...args.warnings,
  ].filter(Boolean) as string[];

  return {
    badge: args.badge,
    macroCategory: args.macroCategory,
    serviceLabel: args.serviceLabel,
    primaryTime: args.primaryTime,
    actionLabel: args.actionLabel,
    pickupLabel: args.pickupLabel,
    destinationLabel: args.destinationLabel,
    connectionLabel: args.connectionLabel,
    transportRef: args.transportRef ?? null,
    ferryLabel: args.ferryLabel,
    clientLabel: args.clientLabel,
    paxLabel: args.paxLabel,
    phoneLabel: args.phoneLabel,
    noteLabel: args.noteLabel,
    importTag: args.importTag,
    warnings: args.warnings,
    title: args.title ?? args.serviceLabel,
    detailLines,
    placeLabel: args.placeLabel ?? args.destinationLabel ?? args.pickupLabel ?? "Luogo da verificare",
    compactImportTag: args.importTag,
    operationalNote: args.noteLabel,
    severity: args.severity ?? (args.warnings.length > 0 ? "warning" : "normal"),
  };
}

export function getPianoServiceDisplay(service: PianoDisplayService, hotel?: PianoDisplayHotel): PianoServiceDisplay {
  const badge = serviceBadge(service);
  const macro = macroCategory(service, badge);
  const { operationalNote, compactImportTag } = splitImportNote(service.notes);
  const phoneLabel = clean(service.phone) ?? "Telefono mancante";
  const hotelName = hotelLabel(hotel);
  const hotelZone = clean(hotel?.zone);
  const ferry = ferryLabel(service);
  const port = ferryPort(service);
  const basePrimaryTime = fmtTime(service.pickup_hotel) ?? fmtTime(service.pickup_time) ?? fmtTime(service.time);
  const sourceFrom = sourceLocation(service);
  const sourceTo = destinationLocation(service);
  const client = clientLabel(service);
  const pax = paxLabel(service);

  if (macro === "NAVETTA") {
    const meetingPoint = clean(service.meeting_point);
    const hotelPlace = hotelName ?? hotelWithZone(hotel);
    const pickup = service.direction === "departure"
      ? hotelPlace
      : meetingPoint ?? port;
    const destination = service.direction === "departure"
      ? meetingPoint ?? port
      : hotelPlace;
    const warnings = [
      pickup ? null : "Pickup da verificare",
      destination ? null : "Destinazione da verificare",
    ].filter(Boolean) as string[];
    return buildDisplay({
      badge,
      macroCategory: macro,
      serviceLabel: "NAVETTA",
      primaryTime: basePrimaryTime,
      actionLabel: service.direction === "arrival" ? "Porto → Hotel" : "Hotel → Porto",
      pickupLabel: pickup ?? "Pickup da verificare",
      destinationLabel: destination ?? "Destinazione da verificare",
      connectionLabel: null,
      transportRef: null,
      ferryLabel: null,
      clientLabel: client,
      paxLabel: pax,
      phoneLabel,
      noteLabel: operationalNote,
      importTag: compactImportTag,
      warnings,
      placeLabel: [pickup, destination].filter(Boolean).join(" -> ") || "Navetta da verificare",
    });
  }

  if (macro === "ESCURSIONE") {
    const outbound = service.direction !== "arrival";
    const pickup = sourceFrom ?? hotelName;
    const destination = sourceTo ?? hotelName;
    const warnings = [
      pickup ? null : "Pickup escursione da verificare",
      destination ? null : "Destinazione escursione da verificare",
    ].filter(Boolean) as string[];
    return buildDisplay({
      badge,
      macroCategory: macro,
      serviceLabel: outbound ? "ESCURSIONE ANDATA" : "ESCURSIONE RITORNO",
      primaryTime: fmtTime(service.departure_time) ?? fmtTime(service.time),
      actionLabel: outbound ? "Porta il cliente all'escursione" : "Riporta il cliente dall'escursione",
      pickupLabel: pickup ?? "Pickup escursione da verificare",
      destinationLabel: destination ?? "Destinazione escursione da verificare",
      connectionLabel: null,
      transportRef: null,
      ferryLabel: null,
      clientLabel: client,
      paxLabel: pax,
      phoneLabel,
      noteLabel: operationalNote,
      importTag: compactImportTag,
      warnings,
      placeLabel: [pickup, destination].filter(Boolean).join(" -> ") || "Escursione da verificare",
    });
  }

  if (macro === "ARRIVO") {
    const arrivalAtIsland = islandArrivalTime(service);
    const primaryTime = arrivalAtIsland ?? fmtTime(service.arrival_time) ?? fmtTime(service.time);
    const pickup = port ?? portLabel(service.meeting_point);
    const destination = hotelWithZone(hotel) ?? hotelName;
    const connection = arrivalConnectionLabel({ service, badge, pickup, origin: sourceFrom, ferry, arrivalAtIsland });
    const transportRef = buildTransportRef(service, badge);
    const warnings = [
      pickup ? null : "Prendere a: arrivo isola da verificare",
      destination ? null : "Destinazione da verificare",
      arrivalAtIsland ? null : "Orario operativo isola da verificare",
    ].filter(Boolean) as string[];
    return buildDisplay({
      badge,
      macroCategory: macro,
      serviceLabel: "ARRIVO",
      primaryTime,
      actionLabel: `Prendere a: ${pickup ?? "arrivo isola da verificare"}`,
      pickupLabel: null,
      destinationLabel: destination ?? "Destinazione da verificare",
      connectionLabel: connection,
      transportRef,
      ferryLabel: null,
      clientLabel: client,
      paxLabel: pax,
      phoneLabel,
      noteLabel: operationalNote,
      importTag: compactImportTag,
      warnings,
      placeLabel: [pickup, destination].filter(Boolean).join(" -> ") || "Arrivo da verificare",
    });
  }

  const pickup = hotelName ?? clean(service.meeting_point);
  const destination = departureEmbarkPort(service) ?? port ?? sourceTo;
  const connection = departureConnectionLabel({ service, ferry });
  const transportRef = buildTransportRef(service, badge);
  const warnings = [
    pickup ? null : "Pickup da verificare",
    destination ? null : "Porto/destinazione da verificare",
  ].filter(Boolean) as string[];
  return buildDisplay({
      badge,
      macroCategory: "PARTENZA",
      serviceLabel: "PARTENZA",
      primaryTime: basePrimaryTime,
      actionLabel: "",
      pickupLabel: pickup ?? "Pickup da verificare",
      destinationLabel: destination ?? "Porto/destinazione da verificare",
      connectionLabel: connection,
      transportRef,
      ferryLabel: connection ? null : ferry,
      clientLabel: client,
      paxLabel: pax,
      phoneLabel,
      noteLabel: operationalNote,
      importTag: compactImportTag,
      warnings,
      placeLabel: pickup ?? "Partenza da verificare",
    });
}
