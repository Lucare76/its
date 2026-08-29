import { describe, it, expect } from "vitest";
import {
  extractCity,
  resolveBusImportCity,
  matchAcrossLines,
} from "@/app/(app)/bus-network/BusImportModal";
import { resolveBusStop } from "@/lib/server/bus-lines-catalog";

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
