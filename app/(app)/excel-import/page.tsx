"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { findBusStopsByCity, findNearestBusStop } from "@/lib/bus-lines-catalog";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { Hotel } from "@/lib/types";

type SheetPreview = {
  name: string;
  rows: number;
  cols: number;
  header: string[];
  sample: string[][];
  allRows: string[][];
};

type MappingTarget =
  | "customer_name"
  | "date"
  | "time"
  | "pickup"
  | "destination"
  | "pax"
  | "transport_code"
  | "phone"
  | "notes"
  | "departure_date"
  | "departure_time"
  | "direction"
  | "billing_party_name"
  | "bus_city_origin"
  | "route_kind"
  | "origin_place_type"
  | "destination_place_type"
  | "company_name"
  | "embark_time"
  | "pickup_time"
  | "service_name"
  | "practice_reference";

type MappingSuggestion = {
  target: MappingTarget;
  source: string | null;
  confidence: "high" | "medium" | "low";
};

type TemplateServiceCategory = "arrival" | "departure" | "transfer" | "excursion" | "territorial" | "round_trip" | "bus_line";
type TemplatePlaceType = "hotel" | "locality" | "poi" | "attraction" | "port" | "airport" | "station" | "address" | "bus_stop" | "other";
type TemplateRouteKind =
  | "porto_hotel"
  | "hotel_porto"
  | "aeroporto_hotel"
  | "hotel_aeroporto"
  | "stazione_hotel"
  | "hotel_stazione"
  | "hotel_luogo"
  | "luogo_hotel"
  | "luogo_luogo"
  | "hotel_attrazione"
  | "attrazione_hotel"
  | "escursione"
  | "territoriale"
  | "linea_bus_arrivo_ritorno"
  | "linea_bus_solo_arrivo"
  | "linea_bus_solo_ritorno";

type CandidateRow = {
  row_index: number;
  customer_name: string;
  date: string;
  time: string;
  pickup: string;
  destination: string;
  pax: number;
  transport_code: string;
  phone: string;
  notes: string;
  departure_date: string;
  departure_time: string;
  direction: "arrival" | "departure" | null;
  billing_party_name: string;
  bus_city_origin: string;
  service_category?: TemplateServiceCategory | null;
  route_kind?: TemplateRouteKind | null;
  origin_place_type?: TemplatePlaceType | null;
  destination_place_type?: TemplatePlaceType | null;
  company_name?: string;
  practice_reference?: string;
  pickup_time?: string;
  service_name?: string;
  hotel_name?: string;
  external_destination?: string;
  embark_time?: string;
  driver_time?: string;
  localIssues: string[];
};

type ImportResponse = {
  ok: boolean;
  dry_run: boolean;
  summary: {
    total_rows: number;
    valid_rows: number;
    invalid_rows: number;
    imported_rows?: number;
    skipped_rows?: number;
    pending_rows?: number;
    allocated_bus_rows?: number;
  };
  errors: Array<{ row_index: number; message: string }>;
  error?: string;
};

const IMPORT_TIMEOUT_MS = 45_000;
const SESSION_TIMEOUT_MS = 10_000;

type PresetKey = "generic_transfer" | "formula_snav" | "formula_medmar_napoli" | "formula_medmar_pozzuoli" | "transfer_airport" | "transfer_station" | "linea_bus";
type SheetTemplate = "lista_operativa" | "dispatch_cliente" | "prenotazioni" | "linea_bus_arrivi_cliente" | "linea_bus_partenze_cliente" | "foglio_servizio" | "ischia_transfer_service" | "non_riconosciuto";
type SimulatedBusLoad = {
  label: string;
  pax: number;
  remaining: number;
  rows: number;
};
type SimulatedFamilyLoad = {
  key: string;
  direction: "arrival" | "departure";
  familyLabel: string;
  totalPax: number;
  totalRows: number;
  buses: SimulatedBusLoad[];
  unassignedPax: number;
};

const mappingTargetMeta: Array<{ target: MappingTarget; label: string; patterns: string[] }> = [
  { target: "customer_name", label: "Cliente", patterns: ["cliente", "beneficiario", "nominativo"] },
  { target: "date", label: "Data andata", patterns: ["data", "dal", "arrivo"] },
  { target: "time", label: "Ora andata", patterns: ["ora", "hh:mm", "inizio", "alle"] },
  { target: "pickup", label: "Meeting point", patterns: ["da", "pickup", "meeting", "imbarco"] },
  { target: "destination", label: "Hotel / destinazione", patterns: ["a", "hotel", "destinazione"] },
  { target: "pax", label: "Passeggeri", patterns: ["pax", "posti"] },
  { target: "transport_code", label: "Riferimento mezzo", patterns: ["flight", "treno", "compagnia", "num", "mezzo"] },
  { target: "phone", label: "Telefono", patterns: ["telefono", "cell", "tel"] },
  { target: "notes", label: "Note", patterns: ["note", "osservazioni"] },
  { target: "departure_date", label: "Data ritorno", patterns: ["al", "ritorno"] },
  { target: "departure_time", label: "Ora ritorno", patterns: ["ora ritorno", "alle ritorno"] },
  { target: "direction", label: "Direzione", patterns: ["direzione", "tipo servizio"] },
  { target: "billing_party_name", label: "Agenzia fatturazione", patterns: ["agenzia", "to", "fatturazione"] },
  { target: "bus_city_origin", label: "Origine linea bus", patterns: ["origine", "citta", "partenza bus"] },
  { target: "route_kind", label: "Tipo tratta", patterns: ["tipo tratta", "tratta"] },
  { target: "origin_place_type", label: "Tipo origine", patterns: ["tipo origine"] },
  { target: "destination_place_type", label: "Tipo destinazione", patterns: ["tipo destinazione"] },
  { target: "company_name", label: "Compagnia / mezzo", patterns: ["compagnia", "mezzo"] },
  { target: "embark_time", label: "Ora imbarco", patterns: ["ora imbarco", "imbarco"] },
  { target: "pickup_time", label: "Ora pickup", patterns: ["ora pickup", "pickup"] },
  { target: "service_name", label: "Nome escursione", patterns: ["nome escursione", "escursione"] },
  { target: "practice_reference", label: "Pratica", patterns: ["pratica"] }
];

const presets: Array<{
  key: PresetKey;
  label: string;
  description: string;
}> = [
  { key: "generic_transfer", label: "Transfer generico", description: "Import base senza formula dedicata." },
  { key: "formula_snav", label: "Formula SNAV", description: "Pacchetti porto/hotel associati a SNAV." },
  { key: "formula_medmar_napoli", label: "Formula MEDMAR — Napoli", description: "Pacchetti MEDMAR da Napoli Beverello." },
  { key: "formula_medmar_pozzuoli", label: "Formula MEDMAR — Pozzuoli", description: "Pacchetti MEDMAR da Pozzuoli." },
  { key: "transfer_airport", label: "Transfer aeroporto", description: "Airport/hotel o hotel/airport." },
  { key: "transfer_station", label: "Transfer stazione", description: "Stazione/hotel o hotel/stazione." },
  { key: "linea_bus", label: "Linea bus", description: "Servizi linea bus / citta-hotel." }
];

const monthMap: Record<string, string> = {
  gen: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  mag: "05",
  giu: "06",
  lug: "07",
  ago: "08",
  set: "09",
  ott: "10",
  nov: "11",
  dic: "12",
  jan: "01",
  apri: "04"
};
const clientBusFamilyConfig = {
  ITALIA: { buses: 5, capacity: 54, label: "Linea Italia" },
  CENTRO: { buses: 3, capacity: 54, label: "Linea Centro" },
  ADRIATICA: { buses: 1, capacity: 54, label: "Linea Adriatica" }
} as const;

function normalize(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function detectTemplate(sheet: SheetPreview): SheetTemplate {
  const header = sheet.header.map(normalize);
  const headerText = header.join(" | ");
  const firstRow = sheet.sample[0]?.map(normalize).join(" | ") ?? "";
  if (header.includes("data servizio") && header.includes("ora servizio") && header.includes("categoria servizio") && header.includes("origine") && header.includes("destinazione")) {
    return "ischia_transfer_service";
  }
  if (firstRow.includes("arrivi") && headerText.includes("orario") && headerText.includes("punto di carico") && headerText.includes("hotel destinazione")) {
    return "linea_bus_arrivi_cliente";
  }
  if (firstRow.includes("partenze") && headerText.includes("hotel partenza") && headerText.includes("destinazione")) {
    return "linea_bus_partenze_cliente";
  }
  // Foglio Servizio: colonne gg / mm / flight / pax / cliente / da
  if (header.includes("gg") && header.includes("mm") && header.includes("flight") && (header.includes("cliente") || header.includes("da"))) {
    return "foglio_servizio";
  }
  // Foglio Servizio con variante header su riga 1 (riga 0 è titolo)
  const altHeader = sheet.sample[1]?.map(normalize) ?? [];
  if (altHeader.includes("gg") && altHeader.includes("mm") && altHeader.includes("flight") && (altHeader.includes("cliente") || altHeader.includes("da"))) {
    return "foglio_servizio";
  }
  if (headerText.includes("autista") && headerText.includes("cliente") && headerText.includes("mezzo")) {
    return "lista_operativa";
  }
  if (headerText.includes("cliente") && headerText.includes("da") && headerText.includes("a")) {
    return "dispatch_cliente";
  }
  if (headerText.includes("beneficiario") || headerText.includes("pax")) {
    return "prenotazioni";
  }
  return "non_riconosciuto";
}

type FoglioTransportInfo = {
  transportCode: string;
  ferryTime: string;
  pickupHint: "porto" | "aeroporto" | "stazione" | null;
};

function parseFoglioFlightCell(raw: string): FoglioTransportInfo {
  const original = raw.trim();
  if (!original) return { transportCode: "", ferryTime: "", pickupHint: null };

  const timeMatch = original.match(/(\d{1,2}[:.]\d{2})/);
  const ferryTime = timeMatch ? parseTimeCell(timeMatch[1]) : "";

  if (/medmar/i.test(original)) return { transportCode: "medmar", ferryTime, pickupHint: "porto" };
  if (/snav/i.test(original)) return { transportCode: "snav", ferryTime, pickupHint: "porto" };
  if (/alilauro/i.test(original)) return { transportCode: "alilauro", ferryTime, pickupHint: "porto" };
  if (/gestour/i.test(original)) return { transportCode: "gestour", ferryTime, pickupHint: "porto" };
  if (/caremar/i.test(original)) return { transportCode: "caremar", ferryTime, pickupHint: "porto" };

  if (/\bvolo\b/i.test(original) || /\bapt\b/i.test(original) || /\bfr\b\s*\d/i.test(original)) {
    return { transportCode: "volo", ferryTime: "", pickupHint: "aeroporto" };
  }

  if (/\bitalo\b/i.test(original) || /\bic\b\s*\d/i.test(original) || /\bitalobus\b/i.test(original)) {
    return { transportCode: "treno", ferryTime: "", pickupHint: "stazione" };
  }

  return { transportCode: original, ferryTime: "", pickupHint: null };
}

function extractTimeFromTravelReference(value: string) {
  const compact = value.trim();
  if (!compact) return "";
  const match = compact.match(/(\d{1,2}[:.]\d{2})/);
  return match ? parseTimeCell(match[1]) : "";
}

function resolveTemplateServiceTime(
  category: TemplateServiceCategory | null,
  explicitTime: string,
  travelReference: string,
  embarkTime: string,
  driverTime: string
) {
  if (explicitTime) return explicitTime;

  const referenceTime = extractTimeFromTravelReference(travelReference);
  if (category === "excursion") {
    return driverTime || embarkTime || referenceTime;
  }
  return referenceTime || embarkTime || driverTime;
}

function resolveTemplateDepartureTime(
  category: TemplateServiceCategory | null,
  explicitTime: string,
  embarkTime: string,
  driverTime: string
) {
  if (category !== "departure") return "";
  return driverTime || embarkTime || explicitTime;
}

function suggestMappings(sheet: SheetPreview): Record<MappingTarget, string> {
  const header = sheet.header;
  const findHeader = (patterns: string[]) => header.find((item) => patterns.some((pattern) => normalize(item).includes(pattern))) ?? "";
  return mappingTargetMeta.reduce(
    (acc, item) => {
      acc[item.target] = findHeader(item.patterns);
      return acc;
    },
    {} as Record<MappingTarget, string>
  );
}

function buildMappingSuggestions(sheet: SheetPreview): MappingSuggestion[] {
  const mappings = suggestMappings(sheet);
  return mappingTargetMeta.map((item) => ({
    target: item.target,
    source: mappings[item.target] || null,
    confidence: mappings[item.target] ? (normalize(mappings[item.target]) === item.patterns[0] ? "high" : "medium") : "low"
  }));
}

function parseDateCell(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const day = slash[1].padStart(2, "0");
    const month = slash[2].padStart(2, "0");
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${month}-${day}`;
  }

  const monthMatch = normalizeText(raw).match(/^(\d{1,2}) ([a-z]{3,4}) (\d{2,4})$/);
  if (monthMatch) {
    const day = monthMatch[1].padStart(2, "0");
    const month = monthMap[monthMatch[2]] ?? "";
    const year = monthMatch[3].length === 2 ? `20${monthMatch[3]}` : monthMatch[3];
    if (month) return `${year}-${month}-${day}`;
  }

  return "";
}

function parseTimeCell(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  const compact = raw.replace(".", ":");
  const hhmmss = compact.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hhmmss) {
    return `${hhmmss[1].padStart(2, "0")}:${hhmmss[2]}`;
  }
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  if (digits.length === 3) return `0${digits[0]}:${digits.slice(1, 3)}`;
  return "";
}

function parsePaxCell(value: string) {
  const digits = value.replace(/[^\d]/g, "");
  return digits ? Number(digits) : 0;
}

function parseDirectionCell(value: string): "arrival" | "departure" | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized.includes("arrivo") || normalized.includes("andata")) return "arrival";
  if (normalized.includes("partenza") || normalized.includes("ritorno")) return "departure";
  return null;
}

function parseTemplateServiceCategory(value: string): TemplateServiceCategory | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized === "arrivo") return "arrival";
  if (normalized === "partenza") return "departure";
  if (normalized === "transfer") return "transfer";
  if (normalized === "escursione") return "excursion";
  if (normalized === "territoriale") return "territorial";
  if (normalized === "linea bus" || normalized === "lineabus" || normalized === "bus") return "bus_line";
  if (normalized === "a r" || normalized === "ar" || normalized === "a-r") return "round_trip";
  return null;
}

function parseTemplatePlaceType(value: string): TemplatePlaceType | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized === "hotel" || normalized === "albergo" || normalized === "struttura") return "hotel";
  if (normalized === "localita" || normalized === "luogo" || normalized === "comune") return "locality";
  if (normalized === "attrazione") return "attraction";
  if (normalized === "poi") return "poi";
  if (normalized === "porto") return "port";
  if (normalized === "aeroporto") return "airport";
  if (normalized === "stazione") return "station";
  if (normalized === "indirizzo") return "address";
  if (normalized === "fermata bus" || normalized === "fermata_bus") return "bus_stop";
  if (normalized === "altro") return "other";
  return null;
}

function parseTemplateRouteKind(value: string): TemplateRouteKind | null {
  const normalized = normalizeText(value).replace(/\s+/g, "_");
  const values: TemplateRouteKind[] = [
    "porto_hotel",
    "hotel_porto",
    "aeroporto_hotel",
    "hotel_aeroporto",
    "stazione_hotel",
    "hotel_stazione",
    "hotel_luogo",
    "luogo_hotel",
    "luogo_luogo",
    "hotel_attrazione",
    "attrazione_hotel",
    "escursione",
    "territoriale",
    "linea_bus_arrivo_ritorno",
    "linea_bus_solo_arrivo",
    "linea_bus_solo_ritorno"
  ];
  return values.includes(normalized as TemplateRouteKind) ? normalized as TemplateRouteKind : null;
}

function normalizeBillingPartyName(value: string) {
  const raw = value.trim();
  const normalized = normalizeText(raw);
  if (normalized === "ischia enjoy" || normalized === "ischia enoy") {
    return "Aleste Viaggi";
  }
  return raw;
}

function inferDateFromFilename(fileName: string | null) {
  const normalized = String(fileName ?? "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalizeText(normalized).match(/^(\d{1,2}) ([a-z]{3,9}) (\d{4})$/);
  if (!match) return "";
  const day = match[1].padStart(2, "0");
  const monthKey = match[2].slice(0, 3);
  const month = monthMap[monthKey] ?? "";
  return month ? `${match[3]}-${month}-${day}` : "";
}

function parseTimeAndCity(raw: string) {
  const compact = String(raw ?? "").replace(/\s+/g, " ").trim();
  const match = compact.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
  return {
    time: match ? parseTimeCell(match[1]) : "",
    city: match ? match[2].trim() : compact
  };
}

function extractDestinationCity(raw: string) {
  const compact = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.split(" - ")[0]?.split(",")[0]?.trim() ?? compact;
}

function deriveBusFamilyFromLineCode(lineCode?: string | null) {
  const normalized = normalizeText(lineCode ?? "");
  if (normalized.includes("11") || normalized.includes("adriatica")) return "ADRIATICA" as const;
  if (normalized.includes("7") || normalized.includes("8") || normalized.includes("centro")) return "CENTRO" as const;
  return "ITALIA" as const;
}

function buildHeaderPicker(header: string[]) {
  const indexes = new Map<string, number>();
  header.forEach((item, index) => {
    const normalized = normalizeText(item);
    if (normalized && !indexes.has(normalized)) indexes.set(normalized, index);
  });

  const findIndex = (aliases: string[]) => {
    for (const alias of aliases) {
      const index = indexes.get(normalizeText(alias));
      if (index !== undefined) return index;
    }
    return -1;
  };

  return {
    get(row: string[], aliases: string[]) {
      const index = findIndex(aliases);
      return index >= 0 ? String(row[index] ?? "").trim() : "";
    },
    missing(required: Array<{ label: string; aliases: string[] }>) {
      return required.filter((item) => findIndex(item.aliases) < 0).map((item) => item.label);
    }
  };
}

function localRowIssues(row: Omit<CandidateRow, "localIssues">, defaultHotelId: string) {
  const issues: string[] = [];
  if (!row.customer_name) issues.push("cliente mancante");
  if (!row.date) issues.push("data andata mancante");
  if (!row.time) issues.push("ora andata mancante");
  if (!row.phone) issues.push("telefono mancante");
  if (!row.pax || row.pax < 1) issues.push("pax non valido");
  if (!row.destination && !defaultHotelId) issues.push("hotel/destinazione mancante");
  return issues;
}

export default function ExcelImportPage() {
  const [message, setMessage] = useState("Carica un Excel cliente o operativo per leggerlo e importare solo le righe valide.");
  const [sheets, setSheets] = useState<SheetPreview[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [selectedSheetName, setSelectedSheetName] = useState("");
  const [mappings, setMappings] = useState<Partial<Record<MappingTarget, string>>>({});
  const [presetKey, setPresetKey] = useState<PresetKey>("generic_transfer");
  const [defaultDirection, setDefaultDirection] = useState<"arrival" | "departure">("arrival");
  const [defaultBillingPartyName, setDefaultBillingPartyName] = useState("");
  const [defaultHotelId, setDefaultHotelId] = useState("");
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [processedRowIndexes, setProcessedRowIndexes] = useState<Set<number>>(new Set());
  const [inferredFileDate, setInferredFileDate] = useState("");
  const [rowDecisions, setRowDecisions] = useState<Map<number, "approved" | "skipped" | "pending">>(new Map());

  useEffect(() => {
    let active = true;
    const loadHotels = async () => {
      if (!hasSupabaseEnv || !supabase) return;
      const session = await supabase.auth.getSession();
      if (!active || session.error || !session.data.session?.user?.id) return;
      const { data, error } = await supabase.from("hotels").select("*").order("name", { ascending: true });
      if (!active || error) return;
      setHotels((data ?? []) as Hotel[]);
    };
    void loadHotels();
    return () => {
      active = false;
    };
  }, []);

  const selectedSheet = useMemo(
    () => sheets.find((sheet) => sheet.name === selectedSheetName) ?? sheets[0] ?? null,
    [selectedSheetName, sheets]
  );

  useEffect(() => {
    if (!selectedSheet) return;
    const nextTemplate = detectTemplate(selectedSheet);
    if (nextTemplate === "linea_bus_arrivi_cliente") {
      setMappings({
        customer_name: "nominativo ",
        date: "",
        time: "orario ",
        pickup: "punto di carico ",
        destination: "hotel destinazione ",
        pax: "n° pax ",
        transport_code: "",
        phone: "cell ",
        notes: "note ",
        departure_date: "",
        departure_time: "",
        direction: "",
        billing_party_name: "agenzia ",
        bus_city_origin: ""
      });
      setPresetKey("linea_bus");
      setDefaultDirection("arrival");
      return;
    }
    if (nextTemplate === "linea_bus_partenze_cliente") {
      setMappings({
        customer_name: "nominativo ",
        date: "",
        time: "",
        pickup: "hotel partenza ",
        destination: "hotel partenza ",
        pax: "n° pax ",
        transport_code: "",
        phone: "cell ",
        notes: "note ",
        departure_date: "",
        departure_time: "",
        direction: "",
        billing_party_name: "agenzia ",
        bus_city_origin: ""
      });
      setPresetKey("linea_bus");
      setDefaultDirection("departure");
      return;
    }
    if (nextTemplate === "foglio_servizio") {
      setMappings({
        customer_name: "",
        date: "gg",
        time: "inizio",
        pickup: "da",
        destination: "da",
        pax: "pax",
        transport_code: "flight",
        phone: "",
        notes: "flight",
        departure_date: "",
        departure_time: "",
        direction: "flight",
        billing_party_name: "cliente",
        bus_city_origin: ""
      });
      setPresetKey("generic_transfer");
      // Auto-detect direzione: se la colonna "a" contiene prevalentemente stazione/aeroporto → partenze
      if (selectedSheet) {
        const allRows = selectedSheet.allRows;
        const headerRow = allRows[0]?.map((c) => normalize(c)) ?? [];
        const aIdx = headerRow.findIndex((h) => h === "a");
        if (aIdx >= 0) {
          const dataRows = allRows.slice(1).filter((r) => String(r[aIdx] ?? "").trim());
          const departureKeywords = /\bstz\b|stazione|aeroporto|airport|naples|napoli\b/i;
          const departureCount = dataRows.filter((r) => departureKeywords.test(String(r[aIdx] ?? ""))).length;
          if (dataRows.length > 0 && departureCount / dataRows.length > 0.5) {
            setDefaultDirection("departure");
          }
        }
      }
      return;
    }
    if (nextTemplate === "ischia_transfer_service") {
      setMappings({
        customer_name: "Nome cliente",
        date: "Data servizio",
        time: "Ora servizio",
        pickup: "Origine",
        destination: "Destinazione",
        pax: "Pax",
        transport_code: "Riferimento viaggio",
        phone: "Telefono",
        notes: "Note operative",
        departure_date: "",
        departure_time: "",
        direction: "Categoria servizio",
        billing_party_name: "Cliente / Agenzia",
        bus_city_origin: "",
        route_kind: "Tipo tratta",
        origin_place_type: "Tipo origine",
        destination_place_type: "Tipo destinazione",
        company_name: "Compagnia / mezzo",
        embark_time: "Ora imbarco",
        pickup_time: "Ora pickup",
        service_name: "Nome escursione",
        practice_reference: "Pratica"
      });
      setPresetKey("generic_transfer");
      setDefaultDirection("arrival");
      return;
    }
    setMappings(suggestMappings(selectedSheet));
  }, [selectedSheet]);

  const totals = useMemo(
    () => ({
      sheets: sheets.length,
      rows: sheets.reduce((sum, sheet) => sum + sheet.rows, 0)
    }),
    [sheets]
  );

  const templateType = selectedSheet ? detectTemplate(selectedSheet) : null;
  const mappingSuggestions = selectedSheet ? buildMappingSuggestions(selectedSheet) : [];

  const candidateRows = useMemo<CandidateRow[]>(() => {
    if (!selectedSheet) return [];
    const headerIndexes = new Map<string, number>();
    selectedSheet.header.forEach((item, index) => { if (item) headerIndexes.set(item, index); });
    const pick = (row: string[], target: MappingTarget) => {
      const source = mappings[target];
      const index = source ? headerIndexes.get(source) : undefined;
      return index === undefined ? "" : String(row[index] ?? "").trim();
    };

    if (templateType === "linea_bus_arrivi_cliente") {
      return selectedSheet.allRows
        .slice(2)
        .map((row, index) => {
          const { time, city } = parseTimeAndCity(String(row[0] ?? ""));
          const matched = findNearestBusStop(city, time) ?? findBusStopsByCity(city)[0] ?? null;
          const base = {
            row_index: index + 3,
            customer_name: String(row[3] ?? "").trim(),
            date: inferredFileDate,
            time: time || matched?.stop.time || "",
            pickup: String(row[1] ?? "").trim(),
            destination: String(row[5] ?? "").trim(),
            pax: parsePaxCell(String(row[2] ?? "")),
            transport_code: matched?.lineCode ?? "",
            phone: String(row[4] ?? "").trim(),
            notes: [String(row[7] ?? "").trim(), String(row[6] ?? "").trim()].filter(Boolean).join(" | "),
            departure_date: "",
            departure_time: "",
            direction: "arrival" as const,
            billing_party_name: String(row[9] ?? "").trim(),
            bus_city_origin: matched?.stop.city ?? city
          };
          return { ...base, localIssues: localRowIssues(base, defaultHotelId) };
        })
        .filter((row) => row.customer_name || row.destination || row.bus_city_origin || row.pax > 0);
    }

    if (templateType === "linea_bus_partenze_cliente") {
      return selectedSheet.allRows
        .slice(2)
        .map((row, index) => {
          const mainlandDestination = String(row[4] ?? "").trim();
          const mainlandCity = extractDestinationCity(mainlandDestination);
          const matched = findNearestBusStop(mainlandCity) ?? findBusStopsByCity(mainlandCity)[0] ?? null;
          const base = {
            row_index: index + 3,
            customer_name: String(row[2] ?? "").trim(),
            date: inferredFileDate,
            time: matched?.stop.time ?? "",
            pickup: String(row[0] ?? "").trim(),
            destination: String(row[0] ?? "").trim(),
            pax: parsePaxCell(String(row[1] ?? "")),
            transport_code: matched?.lineCode ?? "",
            phone: String(row[3] ?? "").trim(),
            notes: [String(row[7] ?? "").trim(), mainlandDestination].filter(Boolean).join(" | "),
            departure_date: "",
            departure_time: "",
            direction: "departure" as const,
            billing_party_name: String(row[6] ?? "").trim(),
            bus_city_origin: matched?.stop.city ?? mainlandCity
          };
          return { ...base, localIssues: localRowIssues(base, defaultHotelId) };
        })
        .filter((row) => row.customer_name || row.destination || row.bus_city_origin || row.pax > 0);
    }

    if (templateType === "foglio_servizio") {
      // Trova la riga header cercando "gg" e "flight" (potrebbe essere riga 0 o 1 se c'è un titolo)
      const allRows = selectedSheet.allRows;
      let headerRowIdx = 0;
      for (let r = 0; r < Math.min(3, allRows.length); r++) {
        const cells = allRows[r].map(normalize);
        if (cells.includes("gg") && cells.includes("flight")) { headerRowIdx = r; break; }
      }
      const headerRow = allRows[headerRowIdx].map((c) => normalize(c));
      const col = (name: string) => {
        const exact = headerRow.findIndex((h) => h === name);
        return exact >= 0 ? exact : headerRow.findIndex((h) => h.startsWith(name));
      };
      const ggIdx = col("gg");
      const mmIdx = col("mm");
      const aaIdx = col("aa");
      const inizioIdx = col("inizio");
      const flightIdx = col("flight");
      const paxIdx = col("pax");
      const clienteIdx = col("cliente");
      const daIdx = col("da");
      const aIdx = col("a");
      const autiIdx = col("auti");
      const nominativoIdx = col("nominativo");

      // Ricava anno di default: prima cerca nella colonna aa, poi dal nome file, poi anno corrente
      let defaultYear = new Date().getFullYear().toString();
      if (inferredFileDate.length >= 4) {
        defaultYear = inferredFileDate.slice(0, 4);
      } else if (aaIdx >= 0) {
        for (let r = headerRowIdx + 1; r < allRows.length; r++) {
          const aaVal = String(allRows[r][aaIdx] ?? "").trim().replace(/\D/g, "");
          if (aaVal.length === 4) { defaultYear = aaVal; break; }
          if (aaVal.length === 2) { defaultYear = `20${aaVal}`; break; }
        }
      }

      let currentDirection: "arrival" | "departure" = defaultDirection;
      const results: CandidateRow[] = [];

      for (let i = headerRowIdx + 1; i < allRows.length; i++) {
        const row = allRows[i];
        const flightRaw = String(row[flightIdx] ?? "").trim();
        const flightNorm = normalizeText(flightRaw);
        const rowText = row.map(normalizeText).join(" ");
        const paxRaw = paxIdx >= 0 ? String(row[paxIdx] ?? "").trim() : "";
        const clienteRaw = clienteIdx >= 0 ? String(row[clienteIdx] ?? "") : "";
        const daRaw = daIdx >= 0 ? String(row[daIdx] ?? "") : "";
        const aRaw = aIdx >= 0 ? String(row[aIdx] ?? "") : "";
        const nominativoCell = nominativoIdx >= 0 ? String(row[nominativoIdx] ?? "") : "";
        const isHeaderLike = normalizeText(String(row[ggIdx] ?? "")) === "gg" && normalizeText(String(row[mmIdx] ?? "")) === "mm";
        const isDirectionSeparator =
          !paxRaw &&
          !clienteRaw.trim() &&
          !daRaw.trim() &&
          !aRaw.trim() &&
          !nominativoCell.trim() &&
          (
            flightNorm === "arrivo" ||
            flightNorm === "arrivi" ||
            flightNorm === "partenza" ||
            flightNorm === "partenze" ||
            /\barrivi\b/.test(rowText) ||
            /\bpartenze\b/.test(rowText)
          );

        if (isHeaderLike) continue;
        if (isDirectionSeparator) {
          if (flightNorm === "arrivo" || flightNorm === "arrivi" || /\barrivi\b/.test(rowText)) currentDirection = "arrival";
          if (flightNorm === "partenza" || flightNorm === "partenze" || /\bpartenze\b/.test(rowText)) currentDirection = "departure";
          continue;
        }
        if (/\bescursioni\b/.test(rowText)) continue;

        const gg = ggIdx >= 0 ? String(row[ggIdx] ?? "").trim() : "";
        const mm = mmIdx >= 0 ? String(row[mmIdx] ?? "").trim() : "";
        const aa = aaIdx >= 0 ? String(row[aaIdx] ?? "").trim() : "";
        const pax = parsePaxCell(paxRaw);
        const cliente = clienteIdx >= 0 ? normalizeBillingPartyName(String(row[clienteIdx] ?? "")) : "";
        const da = daIdx >= 0 ? String(row[daIdx] ?? "").trim() : "";
        const a = aIdx >= 0 ? String(row[aIdx] ?? "").trim() : "";
        const inizio = inizioIdx >= 0 ? parseTimeCell(String(row[inizioIdx] ?? "").trim()) : "";
        const auti = autiIdx >= 0 ? parseTimeCell(String(row[autiIdx] ?? "").trim()) : "";

        // Leggi nominativo-note: "COGNOME NOME 3401234567 TRF TRAGHETTO"
        const nominativoRaw = nominativoIdx >= 0 ? String(row[nominativoIdx] ?? "").trim() : "";
        const phoneMatch = nominativoRaw.match(/(\d{8,13})/);
        const customerName = phoneMatch
          ? nominativoRaw.slice(0, phoneMatch.index).trim()
          : nominativoRaw.replace(/\s*(TRF|TRAGHETTO|trf|traghetto)\b.*/i, "").trim();
        const extractedPhone = phoneMatch ? phoneMatch[1] : "";
        const extractedNotes = phoneMatch
          ? nominativoRaw.slice((phoneMatch.index ?? 0) + phoneMatch[1].length).trim()
          : "";

        // Salta righe vuote
        if (!gg && !flightRaw && !paxRaw && !cliente && !da && !a) continue;

        // Costruisci data da gg/mm/aa
        let date = inferredFileDate;
        if (gg && mm) {
          const year = aa.length === 4 ? aa : aa.length === 2 ? `20${aa}` : defaultYear;
          const dayNum = gg.replace(/\D/g, "");
          const monNum = mm.replace(/\D/g, "");
          if (dayNum && monNum) date = `${year}-${monNum.padStart(2, "0")}-${dayNum.padStart(2, "0")}`;
        }

        const explicitDirection =
          flightNorm === "arrivo" || flightNorm === "arrivi"
            ? "arrival"
            : flightNorm === "partenza" || flightNorm === "partenze"
              ? "departure"
              : null;
        const rowDirection = explicitDirection ?? currentDirection;
        const transport = parseFoglioFlightCell(explicitDirection ? da : flightRaw);

        // Etichetta terminale in base al mezzo di trasporto
        const terminalLabel =
          transport.pickupHint === "porto" ? "Porto Ischia"
          : transport.pickupHint === "aeroporto" ? "Aeroporto Napoli"
          : transport.pickupHint === "stazione" ? "Stazione Napoli"
          : "";

        // Per hotel matching (campo `destination` usato dall'API):
        //   - arrivo: l'hotel e nella colonna "a" (es. apt/stz -> hotel)
        //   - partenza: l'hotel e nella colonna "da" (es. hotel -> apt/stz)
        // Il terminale/meeting point viene derivato dal tipo trasporto.
        const hotelField = rowDirection === "arrival" ? a : da;
        const pickup = rowDirection === "arrival"
          ? (terminalLabel || transport.transportCode)   // da terminale → hotel
          : (hotelField || "");                          // da hotel → terminale
        const destination = hotelField;                  // hotel = sempre "da"

        // Per le partenze: imposta departure_date così appaiono nella pagina Partenze
        const departureDate = rowDirection === "departure" ? date : "";
        const arrivalDate = rowDirection === "arrival" ? date : "";

        const base: Omit<CandidateRow, "localIssues"> = {
          row_index: i + 1,
          customer_name: customerName,
          date,
          time: inizio || auti,
          pickup,
          destination,
          pax,
          transport_code: transport.transportCode,
          phone: extractedPhone,
          notes: [extractedNotes, terminalLabel].filter(Boolean).join(" · "),
          departure_date: departureDate,
          departure_time: rowDirection === "departure" ? (inizio || auti || transport.ferryTime) : transport.ferryTime,
          direction: rowDirection,
          billing_party_name: cliente,
          bus_city_origin: ""
        };
        void arrivalDate; // usato implicitamente tramite date + direction nell'API

        results.push({ ...base, localIssues: localRowIssues(base, defaultHotelId).filter(
          // Per questo template, cliente e telefono mancanti sono attesi — non bloccare
          (issue) => issue !== "cliente mancante" && issue !== "telefono mancante"
        ) });
      }

      return results;
    }

    if (templateType === "ischia_transfer_service") {
      const picker = buildHeaderPicker(selectedSheet.header);
      const missingHeaders = picker.missing([
        { label: "Data servizio", aliases: ["Data servizio"] },
        { label: "Ora servizio", aliases: ["Ora servizio"] },
        { label: "Categoria servizio", aliases: ["Categoria servizio"] },
        { label: "Tipo tratta", aliases: ["Tipo tratta"] },
        { label: "Origine", aliases: ["Origine"] },
        { label: "Tipo origine", aliases: ["Tipo origine"] },
        { label: "Destinazione", aliases: ["Destinazione"] },
        { label: "Tipo destinazione", aliases: ["Tipo destinazione"] },
        { label: "Nome cliente", aliases: ["Nome cliente", "Nominativo", "Cliente"] },
        { label: "Pax", aliases: ["Pax", "Passeggeri"] }
      ]);

      return selectedSheet.allRows
        .slice(1)
        .flatMap((row, index) => {
          const categoryRaw = picker.get(row, ["Categoria servizio"]);
          const routeKindRaw = picker.get(row, ["Tipo tratta"]);
          const origin = picker.get(row, ["Origine"]);
          const destinationLabel = picker.get(row, ["Destinazione"]);
          const originPlaceType = parseTemplatePlaceType(picker.get(row, ["Tipo origine"]));
          const destinationPlaceType = parseTemplatePlaceType(picker.get(row, ["Tipo destinazione"]));
          const serviceName = picker.get(row, ["Nome escursione", "Escursione"]);
          const travelReference = picker.get(row, ["Riferimento viaggio", "Riferimento mezzo"]);
          const practiceReference = picker.get(row, ["Pratica", "Numero pratica"]);
          const embarkTime = parseTimeCell(picker.get(row, ["Ora imbarco", "Imbarco"]));
          const pickupTime = parseTimeCell(picker.get(row, ["Ora pickup", "Ora prelievo", "Pickup"]));
          const companyName = picker.get(row, ["Compagnia / mezzo", "Compagnia", "Mezzo"]);
          const category = parseTemplateServiceCategory(categoryRaw);
          const routeKind = parseTemplateRouteKind(routeKindRaw);

          if (category === "bus_line") {
            const busLine = picker.get(row, ["Linea bus", "Linea"]);
            const busStop = picker.get(row, ["Fermata / città partenza", "Fermata / citta partenza", "Fermata", "Città partenza", "Citta partenza"]);
            const busStopCode = picker.get(row, ["Codice fermata"]);
            const busHotel = picker.get(row, ["Hotel destinazione bus", "Hotel destinazione", "Hotel"]);
            const busArrivalDate = parseDateCell(picker.get(row, ["Data arrivo bus"]));
            const busArrivalTime = parseTimeCell(picker.get(row, ["Ora arrivo bus"]));
            const busReturnDate = parseDateCell(picker.get(row, ["Data ritorno bus"]));
            const busReturnTime = parseTimeCell(picker.get(row, ["Ora ritorno bus"]));
            const pickupReturn = picker.get(row, ["Pickup ritorno"]);
            const phone = picker.get(row, ["Telefono", "Tel", "Cellulare"]);
            const customerName = picker.get(row, ["Nome cliente", "Nominativo", "Cliente"]);
            const pax = parsePaxCell(picker.get(row, ["Pax", "Passeggeri"]));
            const billingPartyName = picker.get(row, ["Agenzia", "Cliente / Agenzia", "Cliente fatturazione"]);
            const notes = [
              practiceReference ? `Pratica: ${practiceReference}` : "",
              pickupReturn ? `Pickup ritorno: ${pickupReturn}` : "",
              picker.get(row, ["Note operative", "Note"])
            ].filter(Boolean).join(" | ");
            const routeIssue = routeKind && routeKind.startsWith("linea_bus_") ? "" : "tipo tratta Linea Bus non riconosciuto";
            const lineIssue = ["italia", "centro", "adriatica"].includes(normalizeText(busLine)) ? "" : "linea bus non riconosciuta";
            const commonIssues = [
              routeIssue,
              lineIssue,
              !busLine ? "Linea bus mancante" : "",
              !busStop ? "Fermata / città partenza mancante" : "",
              !busHotel ? "Hotel destinazione bus mancante" : "",
              !customerName ? "Nome cliente mancante" : "",
              !pax || pax < 1 ? "Pax non valido" : ""
            ].filter(Boolean);

            const makeBusRow = (direction: "arrival" | "departure", date: string, time: string, suffix: number) => {
              const dateIssue = !date
                ? direction === "arrival" ? "Data arrivo bus mancante" : "Data ritorno bus mancante"
                : "";
              const base: Omit<CandidateRow, "localIssues"> = {
                row_index: routeKind === "linea_bus_arrivo_ritorno" ? ((index + 2) * 10) + suffix : index + 2,
                customer_name: customerName,
                date,
                time: time || "00:00",
                pickup: busStop,
                destination: busHotel,
                pax,
                transport_code: busLine,
                phone,
                notes,
                departure_date: "",
                departure_time: "",
                direction,
                billing_party_name: billingPartyName,
                bus_city_origin: busStopCode || busStop,
                service_category: "bus_line",
                route_kind: routeKind,
                origin_place_type: "bus_stop",
                destination_place_type: "hotel",
                company_name: "Linea bus",
                practice_reference: practiceReference,
                pickup_time: direction === "departure" ? pickupReturn : "",
                service_name: "Linea Bus",
                hotel_name: busHotel,
                external_destination: busHotel,
                embark_time: "",
                driver_time: direction === "departure" ? pickupReturn : ""
              };
              return { ...base, localIssues: Array.from(new Set([...commonIssues, dateIssue].filter(Boolean))) };
            };

            if (routeKind === "linea_bus_arrivo_ritorno") {
              return [
                makeBusRow("arrival", busArrivalDate, busArrivalTime, 1),
                makeBusRow("departure", busReturnDate, busReturnTime, 2)
              ];
            }
            if (routeKind === "linea_bus_solo_ritorno") {
              return [makeBusRow("departure", busReturnDate, busReturnTime, 0)];
            }
            return [makeBusRow("arrival", busArrivalDate, busArrivalTime, 0)];
          }

          const serviceTime = resolveTemplateServiceTime(
            category,
            parseTimeCell(picker.get(row, ["Ora servizio"])),
            travelReference,
            embarkTime,
            pickupTime
          );
          const departureTime = resolveTemplateDepartureTime(
            category,
            serviceTime,
            embarkTime,
            pickupTime
          );
          const billingPartyName = picker.get(row, ["Agenzia", "Cliente / Agenzia", "Cliente fatturazione"]);
          const hotelColumn = picker.get(row, ["Hotel"]);
          const notes = [
            serviceName ? `Servizio: ${serviceName}` : "",
            practiceReference ? `Pratica: ${practiceReference}` : "",
            embarkTime ? `Imbarco: ${embarkTime}` : "",
            pickupTime ? `Pickup: ${pickupTime}` : "",
            companyName ? `Mezzo: ${companyName}` : "",
            picker.get(row, ["Note operative", "Note"])
          ].filter(Boolean).join(" | ");

          const base: Omit<CandidateRow, "localIssues"> = {
            row_index: index + 2,
            customer_name: picker.get(row, ["Nome cliente", "Nominativo", "Cliente"]),
            date: parseDateCell(picker.get(row, ["Data servizio"])),
            time: serviceTime,
            pickup: origin,
            destination: destinationLabel,
            pax: parsePaxCell(picker.get(row, ["Pax", "Passeggeri"])),
            transport_code: travelReference,
            phone: picker.get(row, ["Telefono", "Tel", "Cellulare"]),
            notes,
            departure_date: "",
            departure_time: departureTime,
            direction: category === "departure" ? "departure" : "arrival",
            billing_party_name: billingPartyName,
            bus_city_origin: "",
            service_category: category,
            route_kind: routeKind,
            origin_place_type: originPlaceType,
            destination_place_type: destinationPlaceType,
            company_name: companyName,
            practice_reference: practiceReference,
            pickup_time: pickupTime,
            service_name: serviceName,
            hotel_name: hotelColumn || (originPlaceType === "hotel" ? origin : destinationPlaceType === "hotel" ? destinationLabel : ""),
            external_destination: destinationLabel,
            embark_time: embarkTime,
            driver_time: pickupTime
          };

          const issues = localRowIssues(base, defaultHotelId).filter(
            (issue) => issue !== "telefono mancante" && issue !== "hotel/destinazione mancante"
          );
          for (const missing of missingHeaders) issues.push(`colonna obbligatoria mancante: ${missing}`);
          if (!category) issues.push("categoria servizio non riconosciuta");
          if (!routeKind) issues.push("tipo tratta non riconosciuto");
          if (!originPlaceType) issues.push("tipo origine non riconosciuto");
          if (!destinationPlaceType) issues.push("tipo destinazione non riconosciuto");
          if (category === "round_trip") issues.push("categoria A-R da gestire manualmente");
          if (category === "excursion" && !serviceName.trim()) issues.push("nome escursione mancante");
          if (!origin.trim()) issues.push("origine mancante");
          if (!destinationLabel.trim()) issues.push("destinazione mancante");

          return [{
            ...base,
            localIssues: Array.from(new Set(issues))
          }];
        })
        .filter((row) =>
          [
            row.customer_name,
            row.date,
            row.time,
            row.pickup,
            row.destination,
            row.transport_code,
            row.phone,
            row.notes,
            row.billing_party_name,
            row.service_name ?? "",
            row.external_destination ?? "",
            row.route_kind ?? "",
            row.origin_place_type ?? "",
            row.destination_place_type ?? ""
          ].some((value) => value.trim().length > 0) || row.pax > 0
        );
    }

    return selectedSheet.allRows
      .slice(1)
      .map((row, index) => {
        const base = {
          row_index: index + 2,
          customer_name: pick(row, "customer_name"),
          date: parseDateCell(pick(row, "date")),
          time: parseTimeCell(pick(row, "time")),
          pickup: pick(row, "pickup"),
          destination: pick(row, "destination"),
          pax: parsePaxCell(pick(row, "pax")),
          transport_code: pick(row, "transport_code"),
          phone: pick(row, "phone"),
          notes: pick(row, "notes"),
          departure_date: parseDateCell(pick(row, "departure_date")),
          departure_time: parseTimeCell(pick(row, "departure_time")),
          direction: parseDirectionCell(pick(row, "direction")),
          billing_party_name: pick(row, "billing_party_name"),
          bus_city_origin: pick(row, "bus_city_origin")
        };

        return {
          ...base,
          localIssues: localRowIssues(base, defaultHotelId)
        };
      })
      .filter((row) =>
        [
          row.customer_name,
          row.date,
          row.time,
          row.pickup,
          row.destination,
          row.transport_code,
          row.phone,
          row.notes,
          row.departure_date,
          row.departure_time,
          row.billing_party_name,
          row.bus_city_origin
        ].some((value) => value.trim().length > 0) || row.pax > 0
      );
  }, [defaultDirection, defaultHotelId, inferredFileDate, mappings, selectedSheet, templateType]);

  const busSimulation = useMemo<SimulatedFamilyLoad[]>(() => {
    const grouped = new Map<string, CandidateRow[]>();
    for (const row of candidateRows) {
      if (!row.direction || row.pax <= 0) continue;
      const family = deriveBusFamilyFromLineCode(row.transport_code || row.bus_city_origin);
      const key = `${row.direction}|${family}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }

    return Array.from(grouped.entries()).map(([key, rows]) => {
      const [direction, familyCode] = key.split("|") as ["arrival" | "departure", keyof typeof clientBusFamilyConfig];
      const config = clientBusFamilyConfig[familyCode];
      const buses = Array.from({ length: config.buses }, (_, index) => ({
        label: `${familyCode} ${index + 1}`,
        pax: 0,
        remaining: config.capacity,
        rows: 0
      }));
      let unassignedPax = 0;

      for (const row of [...rows].sort((left, right) => right.pax - left.pax)) {
        const target = buses.find((bus) => bus.remaining >= row.pax);
        if (!target) {
          unassignedPax += row.pax;
          continue;
        }
        target.pax += row.pax;
        target.remaining -= row.pax;
        target.rows += 1;
      }

      return {
        key,
        direction,
        familyLabel: config.label,
        totalPax: rows.reduce((sum, row) => sum + row.pax, 0),
        totalRows: rows.length,
        buses,
        unassignedPax
      };
    });
  }, [candidateRows]);

  const candidateStats = useMemo(
    () => ({
      valid: candidateRows.filter((row) => row.localIssues.length === 0).length,
      invalid: candidateRows.filter((row) => row.localIssues.length > 0).length
    }),
    [candidateRows]
  );

  // Ogni volta che cambiano le righe candidate, reset delle decisioni:
  // righe senza warning → auto-approvate, righe con warning → pending
  useEffect(() => {
    setRowDecisions((prev) => {
      if (candidateRows.length === 0) return new Map();
      const next = new Map<number, "approved" | "skipped" | "pending">();
      for (const row of candidateRows) {
        const existing = prev.get(row.row_index);
        next.set(row.row_index, existing ?? (row.localIssues.length === 0 ? "approved" : "pending"));
      }
      return next;
    });
  }, [candidateRows]);

  const approvedCandidates = useMemo(
    () => candidateRows.filter((row) => !processedRowIndexes.has(row.row_index) && rowDecisions.get(row.row_index) === "approved"),
    [candidateRows, processedRowIndexes, rowDecisions]
  );

  const decisionCounts = useMemo(
    () => ({
      approved: candidateRows.filter((row) => !processedRowIndexes.has(row.row_index) && rowDecisions.get(row.row_index) === "approved").length,
      skipped: candidateRows.filter((row) => !processedRowIndexes.has(row.row_index) && rowDecisions.get(row.row_index) === "skipped").length,
      pending: candidateRows.filter((row) => !processedRowIndexes.has(row.row_index) && rowDecisions.get(row.row_index) === "pending").length
    }),
    [candidateRows, processedRowIndexes, rowDecisions]
  );

  const pendingValidCount = useMemo(
    () => candidateRows.filter((row) => !processedRowIndexes.has(row.row_index) && row.localIssues.length === 0 && rowDecisions.get(row.row_index) !== "approved").length,
    [candidateRows, processedRowIndexes, rowDecisions]
  );

  const visibleCandidateRows = useMemo(
    () => candidateRows.filter((row) => !processedRowIndexes.has(row.row_index)),
    [candidateRows, processedRowIndexes]
  );

  const setDecision = (rowIndex: number, decision: "approved" | "skipped" | "pending") => {
    setRowDecisions((prev) => new Map(prev).set(rowIndex, decision));
  };

  const approveAllValid = () => {
    setRowDecisions((prev) => {
      const next = new Map(prev);
      for (const row of visibleCandidateRows) {
        if (row.localIssues.length === 0) next.set(row.row_index, "approved");
      }
      return next;
    });
  };

  const skipAll = () => {
    setRowDecisions((prev) => {
      const next = new Map(prev);
      for (const row of visibleCandidateRows) next.set(row.row_index, "skipped");
      return next;
    });
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setImportProgress("");
    setProcessedRowIndexes(new Set());

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const nextSheets = workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false }) as string[][];
        const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
        return {
          name: sheetName,
          rows: Math.max(0, rows.length - 1),
          cols: maxCols,
          header: rows[0]?.map((item) => String(item ?? "").trim()) ?? [],
          sample: rows.slice(0, 8).map((row) => row.map((item) => String(item ?? ""))),
          allRows: rows.map((row) => row.map((item) => String(item ?? "")))
        } satisfies SheetPreview;
      });

      setSheets(nextSheets);
      setSelectedSheetName(nextSheets[0]?.name ?? "");
      setInferredFileDate(inferDateFromFilename(file.name));
      setMessage(`File letto correttamente: ${file.name}`);
    } catch (error) {
      setSheets([]);
      setInferredFileDate("");
      setMessage(error instanceof Error ? error.message : "Impossibile leggere il file Excel.");
    }
  };

  const approveAll = () => {
    setRowDecisions((prev) => {
      const next = new Map(prev);
      for (const row of visibleCandidateRows) next.set(row.row_index, "approved");
      return next;
    });
  };

  const importResponseMessage = (body: ImportResponse, fallbackError?: string) => {
    const imported = body.summary.imported_rows ?? 0;
    const pending = body.summary.pending_rows ?? 0;
    const invalid = body.summary.invalid_rows ?? body.errors.length;
    const allocated = body.summary.allocated_bus_rows ?? 0;
    if (fallbackError || body.error) {
      return [
        fallbackError ?? body.error,
        invalid > 0 ? `${invalid} righe con errore` : "",
        pending > 0 ? `${pending} righe in pending bus` : ""
      ].filter(Boolean).join(" - ");
    }
    if (body.dry_run) {
      return `Dry run completato: ${body.summary.valid_rows} importabili, ${invalid} errori, ${pending} pending.`;
    }
    if (imported === 0 && pending === 0) {
      return "Import completato ma nessun servizio creato: controlla errori, righe saltate e pending.";
    }
    return `Import completato: ${imported} servizi creati, ${allocated} allocazioni bus, ${pending} pending, ${invalid} errori.`;
  };

  const runImport = async (dryRun: boolean, rowsOverride?: CandidateRow[]) => {
    const updateProgress = (text: string) => {
      setImportProgress(text);
      setMessage(text);
    };

    if (!hasSupabaseEnv || !supabase) {
      updateProgress("Supabase non configurato.");
      return;
    }
    const rowsToImport = rowsOverride ?? (dryRun ? candidateRows : approvedCandidates);
    if (rowsToImport.length === 0) {
      updateProgress(dryRun ? "Nessuna riga disponibile da importare." : "Nessuna riga approvata da importare.");
      return;
    }

    setSubmitting(true);
    setResult(null);
    updateProgress(dryRun ? `Dry run in corso su ${rowsToImport.length} righe...` : `Import in corso su ${rowsToImport.length} righe approvate...`);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
    try {
      updateProgress("Verifica sessione in corso...");
      const session = await Promise.race([
        supabase.auth.getSession(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("Timeout verifica sessione Supabase.")), SESSION_TIMEOUT_MS);
        })
      ]);
      if (session.error || !session.data.session?.access_token) {
        updateProgress("Sessione non valida. Rifai login.");
        setSubmitting(false);
        return;
      }

      updateProgress(`Chiamata API /api/excel/import in corso (${rowsToImport.length} righe)...`);
      const response = await fetch("/api/excel/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.data.session.access_token}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          dry_run: dryRun,
          preset_key: presetKey,
          default_direction: defaultDirection,
          default_billing_party_name: defaultBillingPartyName,
          default_hotel_id: defaultHotelId || null,
          rows: rowsToImport.map(({ localIssues, ...row }) => row)
        })
      });

      updateProgress(`Risposta API ricevuta: HTTP ${response.status}. Elaborazione risultato...`);
      const body = (await response.json().catch(() => null)) as ImportResponse | { error?: string } | null;
      if (!response.ok) {
        if (body && "summary" in body && "errors" in body) {
          setResult(body as ImportResponse);
          updateProgress(importResponseMessage(body as ImportResponse, (body as ImportResponse).error ?? "Import Excel non riuscito."));
        } else {
          updateProgress((body as { error?: string } | null)?.error ?? "Import Excel non riuscito.");
        }
        setSubmitting(false);
        return;
      }

      const importBody = body as ImportResponse;
      setResult(importBody);
      updateProgress(importResponseMessage(importBody));
      if (!dryRun) {
        const errorRowIndexes = new Set(importBody.errors.map((item) => item.row_index));
        const processedRows = rowsToImport.filter((row) => !errorRowIndexes.has(row.row_index)).map((row) => row.row_index);
        if (processedRows.length > 0) {
          setProcessedRowIndexes((current) => {
            const next = new Set(current);
            for (const rowIndex of processedRows) next.add(rowIndex);
            return next;
          });
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        updateProgress(`Timeout import Excel dopo ${Math.round(IMPORT_TIMEOUT_MS / 1000)} secondi: la API non ha risposto.`);
      } else {
        updateProgress(error instanceof Error ? `Errore rete durante import Excel: ${error.message}` : "Errore rete durante import Excel.");
      }
    } finally {
      window.clearTimeout(timeoutId);
      setSubmitting(false);
    }
  };

  const approveAllAndImport = () => {
    if (visibleCandidateRows.length === 0) {
      setMessage("Nessuna riga candidata da approvare.");
      setImportProgress("Nessuna riga candidata da approvare.");
      return;
    }
    approveAll();
    setImportProgress(`Approva tutte intercettato: invio ${visibleCandidateRows.length} righe all'API...`);
    setMessage(`Approva tutte intercettato: invio ${visibleCandidateRows.length} righe all'API...`);
    void runImport(false, visibleCandidateRows);
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Import Excel Guidato"
        subtitle="Parsing locale del file, mapping controllato, dry run server e import dei servizi validi."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Import Excel" }]}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <SectionCard title="File caricato">
          <p className="text-sm font-semibold text-text">{fileName ?? "Nessun file"}</p>
          <p className="mt-1 text-xs text-muted">{message}</p>
        </SectionCard>
        <SectionCard title="Fogli trovati">
          <p className="text-3xl font-semibold text-text">{totals.sheets}</p>
        </SectionCard>
        <SectionCard title="Righe lette">
          <p className="text-3xl font-semibold text-text">{totals.rows}</p>
        </SectionCard>
        <SectionCard title="Righe candidate">
          <p className="text-3xl font-semibold text-text">{visibleCandidateRows.length}</p>
          <p className="mt-1 text-xs text-muted">
            {decisionCounts.approved} approvate / {decisionCounts.pending} da decidere
          </p>
        </SectionCard>
      </div>

      <SectionCard title="Upload file Excel" subtitle="Il file viene letto nel browser. L'import server parte solo dopo il dry run.">
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept=".xlsx,.xls,.csv" className="input-saas" onChange={(event) => void handleFile(event)} />
          <a
            href="/templates/import-servizi-place-based.xlsx"
            download
            className="btn-secondary"
          >
            Scarica template
          </a>
        </div>
        {inferredFileDate ? (
          <p className="mt-3 text-xs text-muted">Data inferita dal nome file: <span className="font-semibold text-text">{inferredFileDate}</span></p>
        ) : null}
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <SectionCard title="Configurazione import" subtitle="Scegli preset operativo, foglio e fallback da usare sulle righe.">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              Foglio
              <select className="input-saas mt-1" value={selectedSheetName} onChange={(event) => setSelectedSheetName(event.target.value)}>
                {sheets.map((sheet) => (
                  <option key={sheet.name} value={sheet.name}>
                    {sheet.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Preset operativo
              <select className="input-saas mt-1" value={presetKey} onChange={(event) => setPresetKey(event.target.value as PresetKey)}>
                {presets.map((preset) => (
                  <option key={preset.key} value={preset.key}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Direzione</span>
              <select className="input-saas mt-1" value={defaultDirection} onChange={(event) => setDefaultDirection(event.target.value as "arrival" | "departure")}>
                <option value="arrival">📥 Arrivi</option>
                <option value="departure">📤 Partenze</option>
              </select>
            </label>
            <label className="text-sm">
              Hotel di fallback
              <select className="input-saas mt-1" value={defaultHotelId} onChange={(event) => setDefaultHotelId(event.target.value)}>
                <option value="">nessuno</option>
                {hotels.map((hotel) => (
                  <option key={hotel.id} value={hotel.id}>
                    {hotel.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm md:col-span-2">
              Agenzia di fatturazione di default
              <input className="input-saas mt-1" value={defaultBillingPartyName} onChange={(event) => setDefaultBillingPartyName(event.target.value)} />
            </label>
          </div>
          {selectedSheet ? (
            <article className="mt-3 rounded-2xl border border-border bg-surface/80 p-3 text-sm text-muted">
              Template rilevato: <span className="font-semibold text-text">{templateType}</span>. Il preset scelto ha priorita sul template.
            </article>
          ) : null}
        </SectionCard>

        <SectionCard title="Checklist import reale" subtitle="Il sistema non importa alla cieca: prima validazione, poi inserimento.">
          <div className="grid gap-2">
            {[
              "Mappa le colonne una sola volta e controlla le prime 10 righe.",
              "Usa hotel di fallback solo se il file non porta una destinazione pulita.",
              "Fai sempre dry run prima del click finale di import.",
              "Importa solo quando errori e righe deboli sono sotto controllo."
            ].map((item) => (
              <article key={item} className="rounded-2xl border border-border bg-surface/80 p-3 text-sm text-text">
                {item}
              </article>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Mapping colonne" subtitle="Puoi correggere il mapping suggerito prima di generare le righe candidate.">
        {!selectedSheet ? (
          <EmptyState title="Nessun foglio selezionato" description="Carica un file Excel per vedere le colonne." compact />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {mappingTargetMeta.map((item) => (
              <label key={item.target} className="text-sm">
                {item.label}
                <select
                  className="input-saas mt-1"
                  value={mappings[item.target] ?? ""}
                  onChange={(event) => setMappings((current) => ({ ...current, [item.target]: event.target.value }))}
                >
                  <option value="">non mappato</option>
                  {[...new Set(selectedSheet.header.filter(Boolean))].map((header) => (
                    <option key={`${item.target}-${header}`} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Suggerimenti parser Excel" subtitle="Prime corrispondenze individuate sulle intestazioni del foglio principale.">
        {mappingSuggestions.length === 0 ? (
          <EmptyState title="Nessun suggerimento disponibile" description="Carica un file per attivare il riconoscimento colonne." compact />
        ) : (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {mappingSuggestions.map((item) => (
              <article key={item.target} className="rounded-2xl border border-border bg-surface/80 p-3">
                <p className="text-sm font-semibold text-text">{item.target}</p>
                <p className="mt-1 text-xs text-muted">{item.source ?? "non trovato"}</p>
                <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-slate-600">{item.confidence}</p>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Azioni import" subtitle="Approva le righe nella sezione sotto, poi importa quelle approvate.">
        <div className="flex flex-wrap gap-3 items-center">
          <button type="button" className="btn-secondary" disabled={submitting || candidateRows.length === 0} onClick={() => void runImport(true)}>
            {submitting ? "Elaborazione..." : "Dry run server (tutte)"}
          </button>
          <button type="button" className="btn-primary" disabled={submitting || approvedCandidates.length === 0} onClick={() => void runImport(false)}>
            {submitting ? "Import in corso..." : `Importa approvate (${approvedCandidates.length})`}
          </button>
          {decisionCounts.pending > 0 ? (
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-700">
              {decisionCounts.pending} righe da decidere
            </span>
          ) : null}
        </div>
        {result ? (
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <article className="rounded-2xl border border-border bg-surface/80 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-muted">Righe totali</p>
              <p className="mt-2 text-2xl font-semibold text-text">{result.summary.total_rows}</p>
            </article>
            <article className="rounded-2xl border border-border bg-surface/80 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-muted">Righe valide</p>
              <p className="mt-2 text-2xl font-semibold text-text">{result.summary.valid_rows}</p>
            </article>
            <article className="rounded-2xl border border-border bg-surface/80 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-muted">Importate / errate</p>
              <p className="mt-2 text-2xl font-semibold text-text">
                {result.summary.imported_rows ?? 0} / {result.summary.invalid_rows}
              </p>
            </article>
            <article className="rounded-2xl border border-border bg-surface/80 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-muted">Pending bus / allocazioni</p>
              <p className="mt-2 text-2xl font-semibold text-text">
                {result.summary.pending_rows ?? 0} / {result.summary.allocated_bus_rows ?? 0}
              </p>
            </article>
            {result.error ? (
              <article className="rounded-2xl border border-rose-200 bg-rose-50 p-3 md:col-span-3">
                <p className="text-xs uppercase tracking-[0.14em] text-rose-700">Errore API</p>
                <p className="mt-2 text-sm font-semibold text-rose-900">{result.error}</p>
              </article>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Simulazione sistemazione bus" subtitle="Proposta locale di riempimento bus basata sulle linee del catalogo e sulle capienze operative del modulo.">
        {busSimulation.length === 0 ? (
          <EmptyState title="Nessuna simulazione disponibile" description="Carica un Excel linea bus o completa il mapping per ottenere una proposta di sistemazione." compact />
        ) : (
          <div className="space-y-3">
            {busSimulation.map((group) => (
              <article key={group.key} className="rounded-2xl border border-border bg-surface/80 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-text">{group.familyLabel} - {group.direction}</p>
                    <p className="text-xs text-muted">{group.totalRows} prenotazioni - {group.totalPax} pax</p>
                  </div>
                  <span className={group.unassignedPax > 0 ? "rounded-full bg-amber-50 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-amber-700" : "rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-emerald-700"}>
                    {group.unassignedPax > 0 ? `${group.unassignedPax} pax da gestire` : "capienza sufficiente"}
                  </span>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {group.buses.map((bus) => (
                    <article key={bus.label} className="rounded-2xl border border-slate-200 bg-white/80 p-3 text-sm">
                      <p className="font-semibold text-text">{bus.label}</p>
                      <p className="mt-1 text-muted">{bus.pax} pax assegnati</p>
                      <p className="text-muted">{bus.remaining} posti residui</p>
                      <p className="text-muted">{bus.rows} prenotazioni</p>
                    </article>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Righe candidate" subtitle="Approva o salta ogni riga. Solo le approvate verranno importate.">
        {visibleCandidateRows.length === 0 ? (
          <EmptyState title="Nessuna riga candidata" description="Carica un file e completa il mapping per generare una preview importabile." compact />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface/80 p-3">
              <div className="flex gap-4 text-sm">
                <span className="text-emerald-700 font-semibold">{decisionCounts.approved} approvate</span>
                <span className="text-slate-500">{decisionCounts.skipped} saltate</span>
                {decisionCounts.pending > 0 ? (
                  <span className="text-amber-700 font-semibold">{decisionCounts.pending} da decidere</span>
                ) : null}
              </div>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs py-1 px-3 disabled:opacity-50"
                  onClick={approveAllValid}
                  disabled={pendingValidCount === 0}
                  title={pendingValidCount === 0 ? "Le righe valide sono gia approvate." : `Approva ${pendingValidCount} righe valide.`}
                >
                  {pendingValidCount === 0 ? "Valide gia approvate" : `Approva valide (${pendingValidCount})`}
                </button>
                <button type="button" className="btn-primary text-xs py-1 px-3" onClick={approveAllAndImport} disabled={submitting || visibleCandidateRows.length === 0}>
                  {submitting ? "Invio in corso..." : "Approva tutte"}
                </button>
                <button type="button" className="btn-secondary text-xs py-1 px-3" onClick={skipAll}>
                  Salta tutte
                </button>
              </div>
              {importProgress ? (
                <p className="basis-full text-xs font-semibold text-slate-600">{importProgress}</p>
              ) : null}
            </div>
            <div className="space-y-3">
              {visibleCandidateRows.map((row) => {
                const decision = rowDecisions.get(row.row_index) ?? "pending";
                return (
                  <article
                    key={row.row_index}
                    className={
                      decision === "approved"
                        ? "rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4"
                        : decision === "skipped"
                          ? "rounded-2xl border border-slate-200 bg-slate-50/60 p-4 opacity-50"
                          : "rounded-2xl border border-amber-200 bg-amber-50/30 p-4"
                    }
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-text">
                          Riga {row.row_index} — {row.customer_name || "cliente non letto"}
                        </p>
                        <p className="text-xs text-muted">
                          {row.date || "data?"} {row.time || "ora?"} — {row.destination || "hotel?"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={
                            row.localIssues.length === 0
                              ? "rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-emerald-700"
                              : "rounded-full bg-amber-50 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-amber-700"
                          }
                        >
                          {row.localIssues.length === 0 ? "ok" : "warning"}
                        </span>
                        <button
                          type="button"
                          onClick={() => setDecision(row.row_index, decision === "approved" ? "pending" : "approved")}
                          className={
                            decision === "approved"
                              ? "rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white"
                              : "rounded-full border border-emerald-300 bg-white px-3 py-1 text-xs text-emerald-700 hover:bg-emerald-50"
                          }
                        >
                          Approva
                        </button>
                        <button
                          type="button"
                          onClick={() => setDecision(row.row_index, decision === "skipped" ? "pending" : "skipped")}
                          className={
                            decision === "skipped"
                              ? "rounded-full bg-slate-500 px-3 py-1 text-xs font-semibold text-white"
                              : "rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                          }
                        >
                          Salta
                        </button>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 text-sm text-text md:grid-cols-2 xl:grid-cols-4">
                      <p><span className="text-muted">Pickup:</span> {row.pickup || "vuoto"}</p>
                      <p><span className="text-muted">Pax:</span> {row.pax || 0}</p>
                      <p><span className="text-muted">Rif. mezzo:</span> {row.transport_code || "vuoto"}</p>
                      <p><span className="text-muted">Telefono:</span> {row.phone || "vuoto"}</p>
                    </div>
                    {row.localIssues.length > 0 ? (
                      <p className="mt-3 text-xs text-amber-700">Warning: {row.localIssues.join(", ")}</p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard title="Errori server" subtitle="Il dry run o l'import reale restituiscono qui le righe che non passano la validazione finale.">
        {!result || result.errors.length === 0 ? (
          <EmptyState title="Nessun errore server" description="Esegui un dry run per vedere la validazione finale lato server." compact />
        ) : (
          <div className="space-y-2">
            {result.errors.map((item, index) => (
              <article key={`${item.row_index}-${item.message}-${index}`} className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Riga {item.row_index}: {item.message}
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Anteprima fogli" subtitle="Prime righe originali del file per controllare intestazioni e struttura.">
        {sheets.length === 0 ? (
          <EmptyState title="Nessun foglio disponibile" description="Carica un file Excel per vedere l'anteprima completa." compact />
        ) : (
          <div className="space-y-4">
            {sheets.map((sheet) => (
              <article key={sheet.name} className="rounded-2xl border border-border bg-surface/80 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-text">{sheet.name}</p>
                    <p className="text-xs text-muted">
                      {sheet.rows} righe - {sheet.cols} colonne
                    </p>
                  </div>
                </div>
                <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                  <table className="min-w-full text-sm">
                    <tbody>
                      {sheet.sample.map((row, index) => (
                        <tr key={`${sheet.name}-${index}`} className="border-t border-slate-100 first:border-t-0">
                          {row.map((cell, cellIndex) => (
                            <td key={`${sheet.name}-${index}-${cellIndex}`} className="px-3 py-2">
                              {cell || <span className="text-slate-300">vuoto</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
