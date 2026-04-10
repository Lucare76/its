import * as path from "node:path";
import * as XLSX from "xlsx";
import { findBusStopsByCity, findNearestBusStop } from "@/lib/bus-lines-catalog";

type Direction = "arrival" | "departure";
type FamilyCode = "ITALIA" | "CENTRO" | "ADRIATICA";

type ParsedRow = {
  sourceFile: string;
  direction: Direction;
  customerName: string;
  phone: string;
  pax: number;
  hotel: string;
  agency: string;
  lineCode: string;
  familyCode: FamilyCode;
  mainlandCity: string;
  reference: string;
};

const FAMILY_CONFIG: Record<FamilyCode, { buses: number; capacity: number; label: string }> = {
  ITALIA: { buses: 5, capacity: 54, label: "Linea Italia" },
  CENTRO: { buses: 3, capacity: 54, label: "Linea Centro" },
  ADRIATICA: { buses: 1, capacity: 54, label: "Linea Adriatica" }
};

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function deriveFamilyCode(lineCode?: string | null): FamilyCode {
  const normalized = normalizeText(lineCode ?? "");
  if (normalized.includes("11") || normalized.includes("adriatica")) return "ADRIATICA";
  if (normalized.includes("7") || normalized.includes("8") || normalized.includes("centro")) return "CENTRO";
  return "ITALIA";
}

function parsePax(value: unknown) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : 0;
}

function parseTimeAndCity(raw: unknown) {
  const compact = String(raw ?? "").replace(/\s+/g, " ").trim();
  const match = compact.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
  return {
    time: match?.[1] ?? "",
    city: match?.[2]?.trim() ?? compact
  };
}

function extractDestinationCity(raw: unknown) {
  const compact = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.split(" - ")[0]?.split(",")[0]?.trim() ?? compact;
}

function readRows(filePath: string): ParsedRow[] {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0] ?? "Foglio1"];
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, raw: false }) as Array<Array<string | number>>;
  const firstTitle = normalizeText(String(rows[0]?.[2] ?? ""));
  const parsed: ParsedRow[] = [];

  if (firstTitle.includes("arrivi")) {
    for (const row of rows.slice(2)) {
      const pax = parsePax(row[2]);
      const customerName = String(row[3] ?? "").trim();
      if (!customerName && pax <= 0) continue;
      const { time, city } = parseTimeAndCity(row[0]);
      const match = findNearestBusStop(city, time) ?? findBusStopsByCity(city)[0] ?? null;
      parsed.push({
        sourceFile: path.basename(filePath),
        direction: "arrival",
        customerName,
        phone: String(row[4] ?? "").trim(),
        pax,
        hotel: String(row[5] ?? "").trim(),
        agency: String(row[9] ?? "").trim(),
        lineCode: match?.lineCode ?? "",
        familyCode: deriveFamilyCode(match?.lineCode),
        mainlandCity: match?.stop.city ?? city,
        reference: String(row[1] ?? "").trim()
      });
    }
    return parsed;
  }

  if (firstTitle.includes("partenze")) {
    for (const row of rows.slice(2)) {
      const pax = parsePax(row[1]);
      const customerName = String(row[2] ?? "").trim();
      if (!customerName && pax <= 0) continue;
      const mainlandCity = extractDestinationCity(row[4]);
      const match = findNearestBusStop(mainlandCity) ?? findBusStopsByCity(mainlandCity)[0] ?? null;
      parsed.push({
        sourceFile: path.basename(filePath),
        direction: "departure",
        customerName,
        phone: String(row[3] ?? "").trim(),
        pax,
        hotel: String(row[0] ?? "").trim(),
        agency: String(row[6] ?? "").trim(),
        lineCode: match?.lineCode ?? "",
        familyCode: deriveFamilyCode(match?.lineCode),
        mainlandCity: match?.stop.city ?? mainlandCity,
        reference: String(row[4] ?? "").trim()
      });
    }
  }

  return parsed;
}

function simulate(rows: ParsedRow[]) {
  const groups = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const key = `${row.direction}|${row.familyCode}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  for (const [key, items] of groups.entries()) {
    const [direction, familyCode] = key.split("|") as [Direction, FamilyCode];
    const config = FAMILY_CONFIG[familyCode];
    const buses = Array.from({ length: config.buses }, (_, index) => ({
      label: `${familyCode} ${index + 1}`,
      pax: 0,
      remaining: config.capacity,
      bookings: 0
    }));
    let overflow = 0;

    for (const item of [...items].sort((left, right) => right.pax - left.pax)) {
      const bus = buses.find((candidate) => candidate.remaining >= item.pax);
      if (!bus) {
        overflow += item.pax;
        continue;
      }
      bus.pax += item.pax;
      bus.remaining -= item.pax;
      bus.bookings += 1;
    }

    console.log(`\n${config.label} | ${direction.toUpperCase()} | ${items.length} prenotazioni | ${items.reduce((sum, item) => sum + item.pax, 0)} pax`);
    for (const bus of buses) {
      console.log(`  - ${bus.label}: ${bus.pax} pax, ${bus.remaining} posti residui, ${bus.bookings} prenotazioni`);
    }
    if (overflow > 0) {
      console.log(`  ! Overflow: ${overflow} pax non allocati`);
    }
  }
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Uso: pnpm exec tsx scripts/simulate-client-bus-excel.ts <file1.xlsx> <file2.xlsx>");
  process.exit(1);
}

const parsedRows = files.flatMap(readRows);
console.log(`Totale righe simulate: ${parsedRows.length}`);
console.log(`Totale pax: ${parsedRows.reduce((sum, row) => sum + row.pax, 0)}`);
simulate(parsedRows);
