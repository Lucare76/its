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
  | "bus_city_origin";

type MappingSuggestion = {
  target: MappingTarget;
  source: string | null;
  confidence: "high" | "medium" | "low";
};

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
  };
  errors: Array<{ row_index: number; message: string }>;
};

type PresetKey = "generic_transfer" | "formula_snav" | "formula_medmar" | "transfer_airport" | "transfer_station" | "linea_bus";
type SheetTemplate = "lista_operativa" | "dispatch_cliente" | "prenotazioni" | "linea_bus_arrivi_cliente" | "linea_bus_partenze_cliente" | "non_riconosciuto";
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
  { target: "bus_city_origin", label: "Origine linea bus", patterns: ["origine", "citta", "partenza bus"] }
];

const presets: Array<{
  key: PresetKey;
  label: string;
  description: string;
}> = [
  { key: "generic_transfer", label: "Transfer generico", description: "Import base senza formula dedicata." },
  { key: "formula_snav", label: "Formula SNAV", description: "Pacchetti porto/hotel associati a SNAV." },
  { key: "formula_medmar", label: "Formula MEDMAR", description: "Pacchetti porto/hotel associati a Medmar." },
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
  if (firstRow.includes("arrivi") && headerText.includes("orario") && headerText.includes("punto di carico") && headerText.includes("hotel destinazione")) {
    return "linea_bus_arrivi_cliente";
  }
  if (firstRow.includes("partenze") && headerText.includes("hotel partenza") && headerText.includes("destinazione")) {
    return "linea_bus_partenze_cliente";
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
  const [mappings, setMappings] = useState<Record<MappingTarget, string>>({} as Record<MappingTarget, string>);
  const [presetKey, setPresetKey] = useState<PresetKey>("generic_transfer");
  const [defaultDirection, setDefaultDirection] = useState<"arrival" | "departure">("arrival");
  const [defaultBillingPartyName, setDefaultBillingPartyName] = useState("");
  const [defaultHotelId, setDefaultHotelId] = useState("");
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [inferredFileDate, setInferredFileDate] = useState("");

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
    const headerIndexes = new Map(selectedSheet.header.map((item, index) => [item, index]));
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
  }, [defaultHotelId, inferredFileDate, mappings, selectedSheet, templateType]);

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

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);

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

  const runImport = async (dryRun: boolean) => {
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato.");
      return;
    }
    if (candidateRows.length === 0) {
      setMessage("Nessuna riga disponibile da importare.");
      return;
    }

    setSubmitting(true);
    setResult(null);
    try {
      const session = await supabase.auth.getSession();
      if (session.error || !session.data.session?.access_token) {
        setMessage("Sessione non valida. Rifai login.");
        setSubmitting(false);
        return;
      }

      const response = await fetch("/api/excel/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.data.session.access_token}`
        },
        body: JSON.stringify({
          dry_run: dryRun,
          preset_key: presetKey,
          default_direction: defaultDirection,
          default_billing_party_name: defaultBillingPartyName,
          default_hotel_id: defaultHotelId || null,
          rows: candidateRows.map(({ localIssues, ...row }) => row)
        })
      });

      const body = (await response.json().catch(() => null)) as ImportResponse | { error?: string } | null;
      if (!response.ok) {
        setMessage((body as { error?: string } | null)?.error ?? "Import Excel non riuscito.");
        setSubmitting(false);
        return;
      }

      setResult(body as ImportResponse);
      setMessage(dryRun ? "Dry run completato." : "Import servizi completato.");
    } catch {
      setMessage("Errore rete durante import Excel.");
    } finally {
      setSubmitting(false);
    }
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
          <p className="text-3xl font-semibold text-text">{candidateRows.length}</p>
          <p className="mt-1 text-xs text-muted">
            {candidateStats.valid} valide / {candidateStats.invalid} con warning
          </p>
        </SectionCard>
      </div>

      <SectionCard title="Upload file Excel" subtitle="Il file viene letto nel browser. L'import server parte solo dopo il dry run.">
        <input type="file" accept=".xlsx,.xls,.csv" className="input-saas" onChange={(event) => void handleFile(event)} />
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
              Direzione di default
              <select className="input-saas mt-1" value={defaultDirection} onChange={(event) => setDefaultDirection(event.target.value as "arrival" | "departure")}>
                <option value="arrival">arrival</option>
                <option value="departure">departure</option>
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
                  {selectedSheet.header.map((header) => (
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

      <SectionCard title="Azioni import" subtitle="Prima dry run server, poi import delle sole righe valide.">
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-secondary" disabled={submitting || candidateRows.length === 0} onClick={() => void runImport(true)}>
            {submitting ? "Elaborazione..." : "Dry run server"}
          </button>
          <button type="button" className="btn-primary" disabled={submitting || candidateRows.length === 0} onClick={() => void runImport(false)}>
            {submitting ? "Import in corso..." : "Importa righe valide"}
          </button>
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

      <SectionCard title="Righe candidate" subtitle="Anteprima normalizzata delle prime righe che il sistema prova a trasformare in servizi.">
        {candidateRows.length === 0 ? (
          <EmptyState title="Nessuna riga candidata" description="Carica un file e completa il mapping per generare una preview importabile." compact />
        ) : (
          <div className="space-y-3">
            {candidateRows.slice(0, 12).map((row) => (
              <article key={row.row_index} className="rounded-2xl border border-border bg-surface/80 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-text">
                      Riga {row.row_index} - {row.customer_name || "cliente non letto"}
                    </p>
                    <p className="text-xs text-muted">
                      {row.date || "data?"} {row.time || "ora?"} - {row.destination || "hotel?"}
                    </p>
                  </div>
                  <span className={row.localIssues.length === 0 ? "rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-emerald-700" : "rounded-full bg-amber-50 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-amber-700"}>
                    {row.localIssues.length === 0 ? "pronta" : "da verificare"}
                  </span>
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
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Errori server" subtitle="Il dry run o l'import reale restituiscono qui le righe che non passano la validazione finale.">
        {!result || result.errors.length === 0 ? (
          <EmptyState title="Nessun errore server" description="Esegui un dry run per vedere la validazione finale lato server." compact />
        ) : (
          <div className="space-y-2">
            {result.errors.map((item) => (
              <article key={`${item.row_index}-${item.message}`} className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
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
