import { getPianoServiceDisplay, type PianoDisplayService, type PianoMacroCategory } from "@/lib/piano-service-display";
import type { Hotel, Service } from "@/lib/types";

export type PrintService = Service & PianoDisplayService & {
  agency_id?: string | null;
  billing_party_name?: string | null;
};

export type PrintAssignment = {
  service_id: string;
  driver_user_id?: string | null;
  vehicle_label?: string | null;
  group_id?: string | null;
};

export type PrintTripGroup = {
  id: string;
  driver_user_id?: string | null;
  vehicle_label?: string | null;
};

export type PrintMember = {
  user_id: string;
  full_name?: string | null;
};

export type PrintAgency = {
  id: string;
  name?: string | null;
};

export type PrintHotel = Hotel | { name?: string | null; zone?: string | null };

export type PrintRow = {
  serviceId: string;
  category: PianoMacroCategory;
  time: string;
  customer: string;
  phone: string;
  pax: string;
  hotel: string;
  hotelZone: string;
  portOrOrigin: string;
  departurePort: string;
  companyOrVehicle: string;
  ferryOrTransportTime: string;
  reference: string;
  destination: string;
  agency: string;
  driver: string;
  vehicle: string;
  notes: string;
  pickup: string;
  pickupSource: "pickup_hotel" | "pickup_time" | "missing" | "not_applicable";
  pickupOutcome: "OK" | "CALCOLABILE" | "DA VERIFICARE";
};

export type PrintSections = Record<PianoMacroCategory, PrintRow[]>;

export type ShuttleStructureKey = "PRESIDENT" | "CRISTALLO" | "SAN NICOLA" | "ALTRE";

export type ShuttleRow = {
  serviceId: string;
  time: string;
  origin: string;
  destination: string;
  pax: string;
  driver: string;
  vehicle: string;
  notes: string;
};

export type ShuttlePrintGroup = {
  key: ShuttleStructureKey;
  label: string;
  rows: ShuttleRow[];
};

// ---------------------------------------------------------------------------
// Helper generici
// ---------------------------------------------------------------------------

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

export function fmtTime(value?: string | null) {
  const raw = clean(value);
  const match = raw?.match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

function normalizeText(value?: string | null) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") ?? "";
}

export function readablePort(value?: string | null) {
  const raw = clean(value);
  if (!raw) return null;
  const text = normalizeText(raw).replace(/[_-]+/g, " ");
  if (text.includes("casamicciola")) return "Casamicciola";
  if (text.includes("pozzuoli")) return "Pozzuoli";
  if (text.includes("beverello") || text.includes("napoli")) return "Napoli Beverello";
  if (text.includes("ischia")) return "Ischia Porto";
  return raw.replace(/[_-]+/g, " ");
}

function customerName(service: PrintService) {
  return [clean(service.customer_first_name), clean(service.customer_last_name)].filter(Boolean).join(" ")
    || clean(service.customer_name)
    || "Cliente da verificare";
}

export function cleanPrintNote(value?: string | null) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Import operational_v2 riga\s+\d+/i.test(line))
    .filter((line) => !/^\[(pdf_import|auto|system|op_|medmar|linked)[^\]]*\]/i.test(line))
    .filter((line) => !/^linked:/i.test(line))
    // Protezione legacy: testo autogenerato pax breakdown (record precedenti al fix dei writer di `notes`).
    // Non deve più essere generato da alcun writer — vedi lib/booking-ancillaries.ts.
    .filter((line) => !/^Formula\s+\S+.*-\s*Infant\s+0-4/i.test(line))
    .filter((line) => !/^Infant\s+0-1,99\s+anni/i.test(line))
    .filter((line) => !/^Animali piccola taglia max \d+\s*kg/i.test(line))
    .join(" | ");
}

export function resolveOperationalPickup(service: PrintService) {
  const pickupHotel = fmtTime(service.pickup_hotel);
  if (pickupHotel) return { value: pickupHotel, source: "pickup_hotel" as const, outcome: "OK" as const };
  const pickupTime = fmtTime(service.pickup_time);
  if (pickupTime) return { value: pickupTime, source: "pickup_time" as const, outcome: "OK" as const };
  return { value: "⚠ PICKUP DA VERIFICARE", source: "missing" as const, outcome: "DA VERIFICARE" as const };
}

// ---------------------------------------------------------------------------
// Compagnia — MAI da barca_compagnia (storicamente contiene un porto, non una
// compagnia: "Ischia Porto" / "Casamicciola"). Fonte affidabile:
// booking_service_kind, con fallback su regex controllata su `vessel`.
// ---------------------------------------------------------------------------
function companyFromKind(kind?: string | null): string | null {
  if (kind === "formula_medmar_napoli" || kind === "formula_medmar_pozzuoli") return "MEDMAR";
  if (kind === "formula_snav") return "SNAV";
  return null;
}

const FERRY_COMPANY_PATTERN = /(medmar|snav|alilauro|caremar)/i;
function companyFromVesselText(vessel?: string | null): string | null {
  const raw = clean(vessel);
  if (!raw) return null;
  const match = raw.match(FERRY_COMPANY_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

export function resolveCompany(service: PrintService): string | null {
  return companyFromKind(service.booking_service_kind) ?? companyFromVesselText(service.vessel);
}

// ---------------------------------------------------------------------------
// ORA NAVE (arrivo) — parsing controllato del testo `vessel`. Il formato
// atteso è "COMPAGNIA Città HH:MM" (es. "MEDMAR Napoli 08:40", "SNAV 12:30"):
// quell'orario è quello di partenza dal continente, che per gli arrivi è
// l'unico riferimento nave affidabile presente in `vessel` — MAI orario_barca
// (appartiene sempre alla gamba di ritorno, anche quando valorizzato su una
// riga di arrivo: vedi audit A/R MEROLA/DI BERNARDO).
// ---------------------------------------------------------------------------
export function parseVesselTime(vessel?: string | null): string | null {
  const raw = clean(vessel);
  if (!raw || !FERRY_COMPANY_PATTERN.test(raw)) return null;
  const match = raw.match(/(\d{1,2}:\d{2})\s*$/);
  return match ? fmtTime(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Destinazione ferry (partenze) — dal booking_service_kind (canonico), mai
// dal testo grezzo del vessel ("MEDMAR Napoli 17:00" non deve comparire in
// stampa: solo "Napoli").
// ---------------------------------------------------------------------------
function ferryDestinationFromKind(kind?: string | null): string | null {
  if (kind === "formula_medmar_napoli") return "Napoli";
  if (kind === "formula_medmar_pozzuoli") return "Pozzuoli";
  if (kind === "formula_snav") return "Napoli";
  return null;
}

function mainlandPortFromVesselText(vessel?: string | null): string | null {
  const text = normalizeText(vessel);
  if (text.includes("pozzuoli")) return "Pozzuoli";
  if (text.includes("napoli")) return "Napoli";
  return null;
}

// ---------------------------------------------------------------------------
// Mezzo (treno/volo) — usato SOLO come fallback esplicito e onesto quando non
// c'è una compagnia ferry applicabile: mai il generico display.serviceLabel
// (che per ARRIVO/PARTENZA vale letteralmente "ARRIVO"/"PARTENZA" e finirebbe
// per leakare la macro-categoria nella colonna COMPAGNIA), mai il testo
// grezzo di `vessel` (es. "TRENO") nella colonna DESTINAZIONE.
// ---------------------------------------------------------------------------
function mezzoLabelFromKind(kind?: string | null): string | null {
  if (!kind) return null;
  if (kind.startsWith("transfer_train_hotel")) return "Treno";
  if (kind.startsWith("transfer_airport_hotel")) return "Volo";
  return null;
}

function mezzoDestinationFallback(kind?: string | null): string | null {
  if (!kind) return null;
  if (kind.startsWith("transfer_train_hotel")) return "Stazione";
  if (kind.startsWith("transfer_airport_hotel")) return "Aeroporto";
  return null;
}

// ---------------------------------------------------------------------------
// RIF. TRENO/VOLO — solo per transfer treno/aeroporto, mai fallback su
// vessel/ferry/compagnia/porto. "TRENO"/"VOLO" senza numero non sono
// riferimenti reali (placeholder inseriti manualmente): in quel caso "-".
// ---------------------------------------------------------------------------
const TRAIN_OR_FLIGHT_KINDS = new Set([
  "transfer_train_hotel",
  "transfer_train_hotel_exclusive",
  "transfer_train_hotel_aliscafo",
  "transfer_airport_hotel",
  "transfer_airport_hotel_exclusive",
  "transfer_airport_hotel_aliscafo",
]);

export function transportReference(service: PrintService): string {
  if (!TRAIN_OR_FLIGHT_KINDS.has(service.booking_service_kind ?? "")) return "-";
  const code = clean(service.transport_code)
    ?? clean(service.train_arrival_number)
    ?? clean(service.train_departure_number);
  if (!code || !/\d/.test(code)) return "-";
  return code;
}

// ---------------------------------------------------------------------------
// Contesto condiviso (autista/mezzo/agenzia/hotel) risolto una volta per
// servizio e passato ai formatter di categoria.
// ---------------------------------------------------------------------------
type RowContext = {
  hotel?: PrintHotel;
  agency: string;
  driver: string;
  vehicle: string;
  notes: string;
};

function resolveRowContext(args: {
  service: PrintService;
  hotels: Map<string, PrintHotel>;
  agencies: Map<string, PrintAgency>;
  assignments: PrintAssignment[];
  tripGroups: Map<string, PrintTripGroup>;
  members: Map<string, PrintMember>;
}): RowContext {
  const { service, hotels, agencies, assignments, tripGroups, members } = args;
  const hotel = service.hotel_id ? hotels.get(service.hotel_id) : undefined;
  const assignment = assignments.find((item) => item.service_id === service.id);
  const group = assignment?.group_id ? tripGroups.get(assignment.group_id) : undefined;
  const driverId = assignment?.driver_user_id ?? group?.driver_user_id ?? null;
  const driver = driverId ? clean(members.get(driverId)?.full_name) : null;
  const vehicle = clean(assignment?.vehicle_label) ?? clean(group?.vehicle_label);
  const agency = clean(service.billing_party_name)
    ?? (service.agency_id ? clean(agencies.get(service.agency_id)?.name) : null)
    ?? "-";
  const display = getPianoServiceDisplay(service, hotel);
  const notes = cleanPrintNote(display.noteLabel ?? service.notes) || "-";
  return { hotel, agency, driver: driver ?? "-", vehicle: vehicle ?? "-", notes };
}

// ---------------------------------------------------------------------------
// FORMATTER CANONICI — unica fonte di verità per l'interpretazione dei campi
// grezzi. La route di stampa deve solo renderizzare gli oggetti restituiti
// da queste funzioni, senza reinterpretare campi diversi per colonna.
// ---------------------------------------------------------------------------

/**
 * ARRIVO — usa esclusivamente dati della gamba arrivo. NON legge mai
 * `orario_barca`, `barca_compagnia`, `departure_time`: su una riga A/R
 * possono appartenere al rientro (anche futuro), mai all'arrivo stampato.
 */
export function buildArrivalPrintRow(service: PrintService, ctx: RowContext): PrintRow {
  const hotelName = clean(ctx.hotel?.name) ?? clean(service.meeting_point) ?? "-";
  const hotelZone = clean(ctx.hotel?.zone) ?? "-";
  const display = getPianoServiceDisplay(service, ctx.hotel);
  const company = resolveCompany(service);
  const isAirport = (service.booking_service_kind ?? "").startsWith("transfer_airport_hotel");
  const shipTime = parseVesselTime(service.vessel) ?? (isAirport ? fmtTime(service.arrival_time) : null) ?? "-";

  return {
    serviceId: service.id,
    category: "ARRIVO",
    time: fmtTime(service.arrival_time) ?? display.primaryTime ?? "-",
    customer: customerName(service),
    phone: clean(service.phone) ?? "-",
    pax: String(Number(service.pax ?? 0) || 0),
    hotel: hotelName,
    hotelZone,
    portOrOrigin: clean(service.meeting_point) ?? "-",
    departurePort: "-",
    companyOrVehicle: company ?? mezzoLabelFromKind(service.booking_service_kind) ?? "-",
    ferryOrTransportTime: shipTime,
    reference: transportReference(service),
    destination: hotelName,
    agency: ctx.agency,
    driver: ctx.driver,
    vehicle: ctx.vehicle,
    notes: ctx.notes,
    pickup: "-",
    pickupSource: "not_applicable",
    pickupOutcome: "OK",
  };
}

/**
 * PARTENZA — usa esclusivamente dati della gamba partenza. `orario_barca` è
 * affidabile qui (è sempre la gamba di rientro/partenza, indipendentemente
 * da come la riga è stata popolata). `barca_compagnia`, storicamente, non è
 * mai una compagnia: reinterpretato solo concettualmente come porto isolano
 * di imbarco quando presente (senza rinominare ancora la colonna DB).
 */
export function buildDeparturePrintRow(service: PrintService, ctx: RowContext): PrintRow {
  const hotelName = clean(ctx.hotel?.name) ?? clean(service.meeting_point) ?? "-";
  const hotelZone = clean(ctx.hotel?.zone) ?? "-";
  const pickup = resolveOperationalPickup(service);
  const company = resolveCompany(service);
  const departurePortValue = readablePort(service.barca_compagnia)
    ?? readablePort(service.meeting_point)
    ?? "-";
  const destination = ferryDestinationFromKind(service.booking_service_kind)
    ?? mainlandPortFromVesselText(service.vessel)
    ?? mezzoDestinationFallback(service.booking_service_kind)
    ?? "-";

  return {
    serviceId: service.id,
    category: "PARTENZA",
    time: pickup.value,
    customer: customerName(service),
    phone: clean(service.phone) ?? "-",
    pax: String(Number(service.pax ?? 0) || 0),
    hotel: hotelName,
    hotelZone,
    portOrOrigin: "-",
    departurePort: departurePortValue,
    companyOrVehicle: company ?? mezzoLabelFromKind(service.booking_service_kind) ?? "-",
    ferryOrTransportTime: fmtTime(service.orario_barca) ?? "-",
    reference: transportReference(service),
    destination,
    agency: ctx.agency,
    driver: ctx.driver,
    vehicle: ctx.vehicle,
    notes: ctx.notes,
    pickup: pickup.value,
    pickupSource: pickup.source,
    pickupOutcome: pickup.outcome,
  };
}

/** ESCURSIONE — sezione separata, mostrata solo se ci sono corse. */
export function buildExcursionPrintRow(service: PrintService, ctx: RowContext): PrintRow {
  const hotelName = clean(ctx.hotel?.name) ?? clean(service.meeting_point) ?? "-";
  const hotelZone = clean(ctx.hotel?.zone) ?? "-";
  const display = getPianoServiceDisplay(service, ctx.hotel);

  return {
    serviceId: service.id,
    category: "ESCURSIONE",
    time: display.primaryTime ?? fmtTime(service.time) ?? "-",
    customer: customerName(service),
    phone: clean(service.phone) ?? "-",
    pax: String(Number(service.pax ?? 0) || 0),
    hotel: hotelName,
    hotelZone,
    portOrOrigin: display.pickupLabel ?? "-",
    departurePort: "-",
    companyOrVehicle: display.serviceLabel ?? "-",
    ferryOrTransportTime: "-",
    reference: transportReference(service),
    destination: display.destinationLabel ?? "-",
    agency: ctx.agency,
    driver: ctx.driver,
    vehicle: ctx.vehicle,
    notes: ctx.notes,
    pickup: "-",
    pickupSource: "not_applicable",
    pickupOutcome: "OK",
  };
}

// ---------------------------------------------------------------------------
// NAVETTE — raggruppate per struttura via hotel_id (non customer_name, che
// per CITARA sarebbe fuorviante: CITARA è una fermata di HOTEL SAN NICOLA,
// non una struttura a sé). Ordine fisso PRESIDENT → CRISTALLO → SAN NICOLA;
// eventuali navette di hotel non riconosciuti finiscono in "ALTRE" (mai
// scartate silenziosamente) ma non alterano l'ordine delle 3 strutture note.
// ---------------------------------------------------------------------------
const SHUTTLE_STRUCTURES: { key: Exclude<ShuttleStructureKey, "ALTRE">; match: (hotelNameNormalized: string) => boolean }[] = [
  { key: "PRESIDENT", match: (n) => n.includes("president") },
  { key: "CRISTALLO", match: (n) => n.includes("cristallo") },
  { key: "SAN NICOLA", match: (n) => n.includes("san nicola") },
];

export function buildShuttlePrintGroups(args: {
  services: PrintService[];
  hotels: Map<string, PrintHotel>;
  assignments: PrintAssignment[];
  tripGroups: Map<string, PrintTripGroup>;
  members: Map<string, PrintMember>;
}): ShuttlePrintGroup[] {
  const buckets = new Map<ShuttleStructureKey, ShuttleRow[]>([
    ["PRESIDENT", []],
    ["CRISTALLO", []],
    ["SAN NICOLA", []],
    ["ALTRE", []],
  ]);

  for (const service of args.services) {
    const ctx = resolveRowContext({
      service,
      hotels: args.hotels,
      agencies: new Map(),
      assignments: args.assignments,
      tripGroups: args.tripGroups,
      members: args.members,
    });
    const hotelNameNormalized = normalizeText(ctx.hotel?.name);
    const structure = SHUTTLE_STRUCTURES.find((s) => s.match(hotelNameNormalized))?.key ?? "ALTRE";
    const display = getPianoServiceDisplay(service, ctx.hotel);

    buckets.get(structure)!.push({
      serviceId: service.id,
      time: fmtTime(service.time) ?? "-",
      origin: display.pickupLabel ?? "-",
      destination: display.destinationLabel ?? "-",
      pax: String(Number(service.pax ?? 0) || 0),
      driver: ctx.driver,
      vehicle: ctx.vehicle,
      notes: ctx.notes,
    });
  }

  const order: ShuttleStructureKey[] = ["PRESIDENT", "CRISTALLO", "SAN NICOLA", "ALTRE"];
  return order
    .map((key) => ({
      key,
      label: key,
      rows: (buckets.get(key) ?? []).sort((a, b) => a.time.localeCompare(b.time)),
    }))
    .filter((group) => group.rows.length > 0 || group.key !== "ALTRE");
}

// ---------------------------------------------------------------------------
// Orchestratore — classificazione invariata (getPianoServiceDisplay /
// macroCategory), delega ai formatter di categoria per il contenuto delle
// colonne. NAVETTA resta disponibile qui come lista piatta (conteggio/uso
// legacy) ma la stampa raggruppata usa buildShuttlePrintGroups.
// ---------------------------------------------------------------------------
export function buildPrintSections(args: {
  services: PrintService[];
  date: string;
  hotels: Map<string, PrintHotel>;
  agencies: Map<string, PrintAgency>;
  assignments: PrintAssignment[];
  tripGroups: PrintTripGroup[];
  members: Map<string, PrintMember>;
}): PrintSections {
  const tripGroupMap = new Map(args.tripGroups.map((group) => [group.id, group]));
  const sections: PrintSections = { ARRIVO: [], PARTENZA: [], NAVETTA: [], ESCURSIONE: [] };
  const seen = new Set<string>();

  for (const service of args.services.filter((item) => item.date === args.date && !item.is_draft && item.status !== "cancelled")) {
    const hotel = service.hotel_id ? args.hotels.get(service.hotel_id) : undefined;
    const display = getPianoServiceDisplay(service, hotel);
    const category = display.macroCategory;
    if (seen.has(service.id)) continue;
    seen.add(service.id);

    const ctx = resolveRowContext({
      service,
      hotels: args.hotels,
      agencies: args.agencies,
      assignments: args.assignments,
      tripGroups: tripGroupMap,
      members: args.members,
    });

    if (category === "ARRIVO") {
      sections.ARRIVO.push(buildArrivalPrintRow(service, ctx));
    } else if (category === "PARTENZA") {
      sections.PARTENZA.push(buildDeparturePrintRow(service, ctx));
    } else if (category === "ESCURSIONE") {
      sections.ESCURSIONE.push(buildExcursionPrintRow(service, ctx));
    } else {
      // NAVETTA: mantenuta come riga semplice per conteggi/compatibilità;
      // la stampa raggruppata per struttura usa buildShuttlePrintGroups.
      const hotelName = clean(hotel?.name) ?? clean(service.meeting_point) ?? "-";
      sections.NAVETTA.push({
        serviceId: service.id,
        category: "NAVETTA",
        time: fmtTime(service.time) ?? "-",
        customer: customerName(service),
        phone: clean(service.phone) ?? "-",
        pax: String(Number(service.pax ?? 0) || 0),
        hotel: hotelName,
        hotelZone: clean(hotel?.zone) ?? "-",
        portOrOrigin: display.pickupLabel ?? "-",
        departurePort: "-",
        companyOrVehicle: display.serviceLabel ?? "-",
        ferryOrTransportTime: "-",
        reference: "-",
        destination: display.destinationLabel ?? "-",
        agency: ctx.agency,
        driver: ctx.driver,
        vehicle: ctx.vehicle,
        notes: ctx.notes,
        pickup: "-",
        pickupSource: "not_applicable",
        pickupOutcome: "OK",
      });
    }
  }

  for (const rows of Object.values(sections)) {
    rows.sort((a, b) => {
      if (a.time !== b.time) return a.time.localeCompare(b.time);
      return a.customer.localeCompare(b.customer);
    });
  }
  return sections;
}
