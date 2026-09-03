import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * app/(app)/bus-network/page.tsx è "use client": nessun harness di render
 * component in questo progetto (vedi tests/unit/booking-groups-remove-passenger-ui.test.ts).
 * Verifica quindi il contratto a livello di sorgente.
 *
 * Bug: allocatedServiceIds era calcolato da allDateAllocations, filtrato su
 * selectedLine — un servizio derivato Linea Italia ma allocato su un bus
 * Linea Centro restava "da assegnare" su Italia. Fix: allocatedServiceIdsGlobal,
 * scoped solo su data+direzione (tutte le linee), usato sia da unassigned
 * (lista "Da assegnare — Linea X") sia da lineSummary (sidebar).
 */
const source = readFileSync(
  join(process.cwd(), "app/(app)/bus-network/page.tsx"),
  "utf8"
).replace(/\r\n/g, "\n");

function extractConstBlock(name: string): string {
  const start = source.indexOf(`const ${name} = useMemo(`);
  if (start === -1) throw new Error(`const ${name} non trovata nel sorgente`);
  const end = source.indexOf(");\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("bus-network page.tsx — conteggio 'da assegnare' globale per data/direzione", () => {
  it("allocatedServiceIdsGlobal è calcolato da payload.allocation_details senza filtro su selectedLine", () => {
    const block = extractConstBlock("allocatedServiceIdsGlobal");
    expect(block).toMatch(/payload\.allocation_details/);
    expect(block).toMatch(/a\.service_date === date/);
    expect(block).toMatch(/a\.direction === direction/);
    expect(block).not.toMatch(/selectedLine/);
    expect(block).not.toMatch(/bus_line_id === selectedLine/);
  });

  it("il vecchio set scoped allocatedServiceIds (da allDateAllocations) non esiste più", () => {
    expect(source).not.toMatch(/const allocatedServiceIds = useMemo/);
    expect(source).not.toMatch(/new Set\(allDateAllocations\.map/);
  });

  it("la lista 'Da assegnare — Linea X' (unassigned) usa allocatedServiceIdsGlobal", () => {
    const start = source.indexOf("const unassigned = useMemo(");
    const end = source.indexOf(");\n", start);
    const block = source.slice(start, end === -1 ? undefined : end);
    expect(block).toMatch(/allocatedServiceIdsGlobal\.has\(s\.id\)/);
  });

  it("il riepilogo sidebar lineSummary usa allocatedServiceIdsGlobal", () => {
    const start = source.indexOf("const lineSummary = useMemo(");
    const end = source.indexOf("]);", start);
    const block = source.slice(start, end === -1 ? undefined : end + 3);
    expect(block).toMatch(/allocatedServiceIdsGlobal\.has\(s\.id\)/);
    expect(block).toMatch(/allocatedServiceIdsGlobal/);
  });

  it("allDateAllocations resta scoped a selectedLine (invariato, usato per i bus della linea selezionata)", () => {
    const start = source.indexOf("const allDateAllocations = useMemo(");
    const end = source.indexOf(");\n", start);
    const block = source.slice(start, end === -1 ? undefined : end);
    expect(block).toMatch(/bus_line_id === selectedLine\?\.id/);
  });
});

/**
 * Test comportamentale (non source-text): riproduce la stessa logica del
 * fix — allocatedServiceIdsGlobal da TUTTE le allocazioni di data+direzione
 * (non filtrate su selectedLine) — su uno scenario dati che replica il caso
 * reale: servizio derivato Linea Italia, allocato su un bus Linea Centro.
 */
type Service = { id: string; date: string; direction: "arrival" | "departure"; derived_family_code: string; booking_group_kind?: string | null; booking_group_catalog_stop_id?: string | null };
type AllocationDetail = { service_id: string; bus_line_id: string; service_date: string; direction: "arrival" | "departure" };
type Line = { id: string; family_code: string; code?: string };

function serviceBelongsToLine(service: Service, line: Line) {
  if (service.booking_group_kind === "bus_exclusive") {
    return line.code === "GRUPPI_ESCLUSIVI";
  }
  return service.derived_family_code === line.family_code;
}

function computeUnassignedForLine(
  services: Service[],
  allocationDetails: AllocationDetail[],
  line: Line,
  date: string,
  direction: "arrival" | "departure"
) {
  const allocatedServiceIdsGlobal = new Set(
    allocationDetails
      .filter((a) => a.service_date === date && a.direction === direction)
      .map((a) => a.service_id)
  );
  return services.filter(
    (s) => s.date === date && s.direction === direction &&
      serviceBelongsToLine(s, line) &&
      !allocatedServiceIdsGlobal.has(s.id)
  );
}

describe("comportamento fix: servizio Italia allocato su bus Centro", () => {
  const date = "2026-09-03";
  const direction = "arrival" as const;
  const lineItalia: Line = { id: "line-italia", family_code: "ITALIA" };
  const lineCentro: Line = { id: "line-centro", family_code: "CENTRO" };
  const services: Service[] = [
    { id: "svc-1", date, direction, derived_family_code: "ITALIA" },
    { id: "svc-2", date, direction, derived_family_code: "ITALIA" },
    { id: "svc-3", date, direction, derived_family_code: "ITALIA" },
  ];
  // svc-1 e svc-2 allocati su un bus della Linea Centro; svc-3 non allocato.
  const allocationDetails: AllocationDetail[] = [
    { service_id: "svc-1", bus_line_id: "line-centro", service_date: date, direction },
    { service_id: "svc-2", bus_line_id: "line-centro", service_date: date, direction },
  ];

  it("i servizi allocati su Centro non compaiono più come 'da assegnare' su Italia", () => {
    const unassigned = computeUnassignedForLine(services, allocationDetails, lineItalia, date, direction);
    expect(unassigned.map((s) => s.id)).toEqual(["svc-3"]);
  });

  it("il conteggio 'da assegnare' su Italia è 1 (non 3), indipendentemente dalla linea selezionata in UI", () => {
    // Anche selezionando Centro in UI (selectedLine), il calcolo per la
    // sidebar di Italia deve restare corretto: allocatedServiceIdsGlobal non
    // dipende da quale linea è selezionata, solo da data+direzione.
    const unassignedWhileCentroSelected = computeUnassignedForLine(services, allocationDetails, lineItalia, date, direction);
    expect(unassignedWhileCentroSelected).toHaveLength(1);
  });
});
