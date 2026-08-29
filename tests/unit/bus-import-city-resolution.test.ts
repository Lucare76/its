import { describe, it, expect } from "vitest";
import {
  extractCity,
  resolveBusImportCity,
  matchAcrossLines,
  isBusImportHeaderRow,
} from "@/app/(app)/bus-network/BusImportModal";
import { resolveBusStop } from "@/lib/server/bus-lines-catalog";

/** Regex di split "HH:MM <città>" identica a BusImportModal.tsx::handleFile. */
function parseTimeAndCity(firstCell: string) {
  const m = firstCell.trim().match(/^(\d{1,2}:\d{2})(?::\d{2})?\s*(.*)$/);
  return { time: m ? m[1] : "", cityFromOrario: m?.[2]?.trim() ?? "" };
}

/**
 * Regressione bug import bus Excel — CITTÀ DI CASTELLO.
 * File reale: "ARRIVO BUS N. 2 - LINEA UMBRIA - EUROBUS 1.xlsx".
 * Prima del fix: punto di carico "PARCHEGGIO STADIO" → extractCity → "STADIO" →
 * city="STADIO" → nessun match esatto → pending.
 */

type Stop = {
  id: string;
  bus_line_id: string;
  direction: "arrival" | "departure";
  stop_name: string;
  city: string;
  pickup_note?: string | null;
  pickup_time?: string | null;
  stop_order: number;
};
type Line = { id: string; code: string; name: string; family_code: string };

const LINE_7: Line = { id: "L7", code: "LINEA_7_CENTRO", name: "Linea 7 Centro", family_code: "CENTRO" };
const L7_STOPS: Stop[] = [
  { id: "s-cdc", bus_line_id: "L7", direction: "arrival", stop_name: "CITTA DI CASTELLO", city: "CITTA DI CASTELLO", pickup_note: "Parcheggio Stadio", pickup_time: "04:00", stop_order: 1 },
  { id: "s-per", bus_line_id: "L7", direction: "arrival", stop_name: "PERUGIA", city: "PERUGIA", pickup_note: "Pian di Massiano, stazione Minimetrò", pickup_time: "04:30", stop_order: 3 },
  { id: "s-psg", bus_line_id: "L7", direction: "arrival", stop_name: "PONTE SAN GIOVANNI", city: "PONTE SAN GIOVANNI", pickup_note: "Piazzale Mercedes", pickup_time: "04:40", stop_order: 4 },
  { id: "s-sma", bus_line_id: "L7", direction: "arrival", stop_name: "SANTA MARIA DEGLI ANGELI", city: "SANTA MARIA DEGLI ANGELI", pickup_note: "Hotel Antonelli", pickup_time: "04:50", stop_order: 5 },
];

describe("resolveBusImportCity — priorità città esplicita sul punto di carico", () => {
  it("CITTÀ DI CASTELLO: '04:00 CITTA' DI CASTELLO' + punto di carico 'PARCHEGGIO STADIO'", () => {
    const { city, pickupPoint } = resolveBusImportCity("PARCHEGGIO STADIO", "CITTA' DI CASTELLO");
    expect(city).toBe("CITTA' DI CASTELLO");
    expect(city).not.toBe("STADIO");
    // punto di carico preservato, non trasformato in città
    expect(pickupPoint).toBe("PARCHEGGIO STADIO");

    // fermata / linea / famiglia risolte dal catalogo
    const cat = resolveBusStop(city);
    expect(cat?.lineCode).toBe("LINEA_7_CENTRO");
    expect(cat?.canonicalCity).toBe("CITTA DI CASTELLO");
    expect(cat?.familyCode).toBe("CENTRO");

    // match sulla fermata DB (direction arrival) → NON pending
    const m = matchAcrossLines(city, L7_STOPS as never, [LINE_7] as never, "arrival");
    expect(m.status).not.toBe("pending");
    expect(m.stop?.city).toBe("CITTA DI CASTELLO");
    expect(m.line?.code).toBe("LINEA_7_CENTRO");
    expect(m.line?.family_code).toBe("CENTRO");
  });

  it("PERUGIA: comportamento invariato", () => {
    const { city, pickupPoint } = resolveBusImportCity("", "PERUGIA");
    expect(city).toBe("PERUGIA");
    expect(pickupPoint).toBe("");
    expect(resolveBusStop(city)?.lineCode).toBe("LINEA_7_CENTRO");
    const m = matchAcrossLines(city, L7_STOPS as never, [LINE_7] as never, "arrival");
    expect(m.status).toBe("ok");
    expect(m.stop?.city).toBe("PERUGIA");
  });

  it("PONTE SAN GIOVANNI: comportamento invariato", () => {
    const { city } = resolveBusImportCity("", "PONTE SAN GIOVANNI");
    expect(city).toBe("PONTE SAN GIOVANNI");
    expect(resolveBusStop(city)?.lineCode).toBe("LINEA_7_CENTRO");
    const m = matchAcrossLines(city, L7_STOPS as never, [LINE_7] as never, "arrival");
    expect(m.status).toBe("ok");
    expect(m.stop?.city).toBe("PONTE SAN GIOVANNI");
  });

  it("SANTA MARIA DEGLI ANGELI: comportamento invariato", () => {
    const { city } = resolveBusImportCity("", "SANTA MARIA DEGLI ANGELI");
    expect(city).toBe("SANTA MARIA DEGLI ANGELI");
    expect(resolveBusStop(city)?.lineCode).toBe("LINEA_7_CENTRO");
    const m = matchAcrossLines(city, L7_STOPS as never, [LINE_7] as never, "arrival");
    expect(m.status).toBe("ok");
    expect(m.stop?.city).toBe("SANTA MARIA DEGLI ANGELI");
  });

  it("FALLBACK legacy: nessun cityFromOrario, città reale solo nella colonna punto di carico", () => {
    // File legacy con "BERGAMO - HOTEL DEI MILLE" in colonna carico.
    expect(resolveBusImportCity("BERGAMO - HOTEL DEI MILLE", "").city).toBe("BERGAMO");
    // Città pura in colonna carico.
    expect(resolveBusImportCity("PERUGIA", "").city).toBe("PERUGIA");
    // Punto di carico generico e nessuna città esplicita → "" (mai "STADIO"),
    // così può intervenire un fallback più affidabile a valle.
    const r = resolveBusImportCity("PARCHEGGIO STADIO", "");
    expect(r.city).toBe("");
    expect(r.city).not.toBe("STADIO");
  });
});

describe("extractCity — hardening residui generici", () => {
  it("residuo generico dopo strip prefisso → stringa vuota", () => {
    expect(extractCity("PARCHEGGIO STADIO")).toBe("");
    expect(extractCity("CASELLO NORD")).toBe("");
    expect(extractCity("STAZIONE CENTRO")).toBe("");
    expect(extractCity("PIAZZALE STADIO")).toBe("");
  });

  it("non rompe i nomi luogo legittimi (comportamento invariato)", () => {
    expect(extractCity("BERGAMO - HOTEL DEI MILLE")).toBe("BERGAMO");
    expect(extractCity("PIAN DI MASSIANO")).toBe("PIAN DI MASSIANO");
    expect(extractCity("PARCHEGGIO BENNET")).toBe("BENNET");
    expect(extractCity("STAZIONE CENTRALE")).toBe("CENTRALE");
    expect(extractCity("PERUGIA")).toBe("PERUGIA");
  });
});

describe("isBusImportHeaderRow — filtro anti-intestazione non scarta righe dati 'HH:MM <città>'", () => {
  it("CITTÀ DI CASTELLO: '04:00 CITTA' DI CASTELLO' NON è intestazione", () => {
    expect(isBusImportHeaderRow("04:00 CITTA' DI CASTELLO")).toBe(false);
  });

  it("CITTÀ DELLA PIEVE: '05:00 CITTA DELLA PIEVE' NON è intestazione", () => {
    expect(isBusImportHeaderRow("05:00 CITTA DELLA PIEVE")).toBe(false);
  });

  it("CITTÀ SANT'ANGELO: '06:00 CITTA SANT'ANGELO' NON è intestazione", () => {
    expect(isBusImportHeaderRow("06:00 CITTA SANT'ANGELO")).toBe(false);
  });

  it("PERUGIA / PONTE SAN GIOVANNI / SANTA MARIA DEGLI ANGELI: righe dati, NON intestazione", () => {
    expect(isBusImportHeaderRow("04:30 PERUGIA")).toBe(false);
    expect(isBusImportHeaderRow("04:40 PONTE SAN GIOVANNI")).toBe(false);
    expect(isBusImportHeaderRow("04:50 SANTA MARIA DEGLI ANGELI")).toBe(false);
  });

  it("riga dati con nominativo che contiene 'NOME' ma prima cella è orario valido: NON scartata", () => {
    // La prima cella è "04:00 ..."; il nominativo (altra colonna) può contenere "NOME".
    expect(isBusImportHeaderRow("04:00 CITTA' DI CASTELLO")).toBe(false);
  });

  it("VERA intestazione senza prefisso orario: continua a essere riconosciuta/scartata", () => {
    expect(isBusImportHeaderRow("CITTA")).toBe(true);
    expect(isBusImportHeaderRow("ORARIO/CITTÀ")).toBe(true);
    expect(isBusImportHeaderRow("PUNTO DI CARICO")).toBe(true);
    expect(isBusImportHeaderRow("NOMINATIVO")).toBe(true);
    expect(isBusImportHeaderRow("citta di castello")).toBe(true); // senza HH:MM = intestazione
  });

  it("riga vuota / non pertinente: non è intestazione", () => {
    expect(isBusImportHeaderRow("")).toBe(false);
    expect(isBusImportHeaderRow("BALDICCHI GIUSEPPE")).toBe(false);
  });
});

describe("E2E parser — righe reali di ARRIVO BUS N. 2 - LINEA UMBRIA - EUROBUS 1.xlsx", () => {
  const LINE_7 = { id: "L7", code: "LINEA_7_CENTRO", name: "Linea 7 Centro", family_code: "CENTRO" };
  const L7_STOPS = [
    { id: "s-cdc", bus_line_id: "L7", direction: "arrival", stop_name: "CITTA DI CASTELLO", city: "CITTA DI CASTELLO", pickup_note: "Parcheggio Stadio", pickup_time: "04:00", stop_order: 1 },
    { id: "s-per", bus_line_id: "L7", direction: "arrival", stop_name: "PERUGIA", city: "PERUGIA", pickup_note: "Pian di Massiano", pickup_time: "04:30", stop_order: 3 },
    { id: "s-psg", bus_line_id: "L7", direction: "arrival", stop_name: "PONTE SAN GIOVANNI", city: "PONTE SAN GIOVANNI", pickup_note: "Piazzale Mercedes", pickup_time: "04:40", stop_order: 4 },
    { id: "s-sma", bus_line_id: "L7", direction: "arrival", stop_name: "SANTA MARIA DEGLI ANGELI", city: "SANTA MARIA DEGLI ANGELI", pickup_note: "Hotel Antonelli", pickup_time: "04:50", stop_order: 5 },
  ];

  // Riga = [ colonna0 "HH:MM CITTÀ", colonna "punto di carico" ]
  const rows: Array<{ c0: string; pickup: string }> = [
    { c0: "04:00 CITTA' DI CASTELLO", pickup: "PARCHEGGIO STADIO" },
    { c0: "04:30 PERUGIA", pickup: "PIAN DI MASSIANO" },
    { c0: "04:40 PONTE SAN GIOVANNI", pickup: "PIAZZALE MERCEDES" },
    { c0: "04:50 SANTA MARIA DEGLI ANGELI", pickup: "HOTEL ANTONELLI" },
  ];

  it("tutte e quattro le righe entrano nel parsing (nessuna scartata come intestazione)", () => {
    const kept = rows.filter((r) => !isBusImportHeaderRow(r.c0));
    expect(kept).toHaveLength(4);
  });

  it("CITTÀ DI CASTELLO: city, pickupPoint, fermata, linea, famiglia; NON pending", () => {
    const r = rows[0]!;
    expect(isBusImportHeaderRow(r.c0)).toBe(false);
    const { time, cityFromOrario } = parseTimeAndCity(r.c0);
    expect(time).toBe("04:00");
    expect(cityFromOrario).toBe("CITTA' DI CASTELLO");

    const { city, pickupPoint } = resolveBusImportCity(r.pickup, cityFromOrario);
    expect(city).toBe("CITTA' DI CASTELLO");
    expect(pickupPoint).toBe("PARCHEGGIO STADIO");

    const cat = resolveBusStop(city);
    expect(cat?.canonicalCity).toBe("CITTA DI CASTELLO");
    expect(cat?.lineCode).toBe("LINEA_7_CENTRO");
    expect(cat?.familyCode).toBe("CENTRO");

    const m = matchAcrossLines(city, L7_STOPS as never, [LINE_7] as never, "arrival");
    expect(m.status).not.toBe("pending");
    expect(m.stop?.city).toBe("CITTA DI CASTELLO");
    expect(m.line?.family_code).toBe("CENTRO");
  });

  it("PERUGIA / PONTE SAN GIOVANNI / SANTA MARIA DEGLI ANGELI: match fermata invariato", () => {
    for (const r of rows.slice(1)) {
      const { cityFromOrario } = parseTimeAndCity(r.c0);
      const { city } = resolveBusImportCity(r.pickup, cityFromOrario);
      const m = matchAcrossLines(city, L7_STOPS as never, [LINE_7] as never, "arrival");
      expect(m.status).toBe("ok");
      expect(m.line?.family_code).toBe("CENTRO");
    }
  });
});
