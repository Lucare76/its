import { describe, it, expect } from "vitest";
import { parseBusImportRows } from "@/app/(app)/bus-network/BusImportModal";

/**
 * Regressione "solo 4 pax Terni" — file reale del 6 settembre 2026
 * "PARTENZA BUS N. 2 - LINEA UMBRIA.xlsx" (audit DB del 2026-09-03/06).
 *
 * Il file contiene 37 prenotazioni / 76 pax su 13 fermate. Le 8 righe Terni
 * (18 pax) sono ricostruite esattamente dai record trovati in
 * bus_import_pending + services dopo i 3 tentativi di import di Mario.
 *
 * Questo test copre SOLO il parser client (BusImportModal.parseBusImportRows):
 * deve produrre tutte e 37 le righe, senza scartarne nessuna per telefono
 * mancante e senza includere righe di totale/piede foglio ("TOTALE").
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

const LINE: Line = { id: "L-CENTRO", code: "LINEA_UMBRIA_CENTRO", name: "Linea Umbria Centro", family_code: "CENTRO" };

const CITIES = [
  "TERNI", "PERUGIA", "ROMA TIBURTINA", "FOLIGNO", "VALMONTONE",
  "CITTA DI CASTELLO", "NARNI SCALO", "ORTE", "SPOLETO",
  "ROMA ANAGNINA", "VITERBO", "PONTE SAN GIOVANNI", "SANTA MARIA DEGLI ANGELI",
];

const STOPS: Stop[] = CITIES.map((city, i) => ({
  id: `stop-${i}`,
  bus_line_id: LINE.id,
  direction: "departure",
  stop_name: city,
  city,
  stop_order: i + 1,
}));

// Header: NOME | TELEFONO | HOTEL | PUNTO DI CARICO | PAX | AGENZIA
const HEADER = ["Cognome Nome", "Telefono", "Hotel", "Punto di carico", "Pax", "Agenzia"];

// Le 37 righe reali (nome, telefono, hotel, punto di carico, pax, agenzia),
// ricostruite dai record DB post-import del 2026-09-06.
const PASSENGER_ROWS: Array<[string, string, string, string, string, string]> = [
  // TERNI — 8 righe / 18 pax (ordine originale del file)
  ["FRANCA", "3801111111", "FELIX", "TERNI - TERMINAL BUS ATC", "2", "TIVA"],
  ["PALIY", "3803875690", "PRESIDENT", "TERNI - TERMINAL BUS ATC", "3", "TIVA"],
  ["ANGELUZZI", "3802222222", "SOLE MARE", "TERNI - TERMINAL BUS ATC", "2", "TIVA"],
  ["MASSARELLI", "3280548772", "RE FERDINANDO", "TERNI - TERMINAL BUS ATC", "3", "TIVA"],
  ["BATTISTELLI", "3351341527", "RE FERDINANDO", "TERNI - TERMINAL BUS ATC", "2", "TIVA"],
  ["SARUBBI MARA", "3406846508", "PUNTA DEL SOLE", "TERNI - TERMINAL BUS ATC", "2", "ANGELINO"],
  ["MOSCA ANGELO - VIRILI CARLA", "", "COLELLA", "TERNI - TERMINAL BUS ATC", "2", "CAMPANIA OVERLAND"],
  ["SILVERI MASSIMO", "3471079617", "PARK IMPERIAL", "TERNI - TERMINAL BUS ATC", "2", "ZIGOLO"],
  // PERUGIA — 5 righe / 9 pax
  ["COMPRENDI ALICE", "3457643882", "", "PERUGIA - PIAN DI MASSIANO", "2", ""],
  ["GENIPI MARIACRISTINA", "3288399608", "", "PERUGIA - PIAN DI MASSIANO", "2", ""],
  ["PEDETTA CELESTINO", "3409097577", "", "PERUGIA - PIAN DI MASSIANO", "2", ""],
  ["BISCARINI CARLO", "3296873288", "", "PERUGIA - PIAN DI MASSIANO", "2", ""],
  ["GRILLO PAOLA", "3791444004", "", "PERUGIA - PIAN DI MASSIANO", "1", ""],
  // ROMA TIBURTINA — 5 righe / 9 pax
  ["GALLO KIMBERLY", "3775391476", "", "ROMA TIBURTINA - LARGO MAZZONI", "2", ""],
  ["ZENGONI - FILIPPI", "3385466892", "", "ROMA TIBURTINA - LARGO MAZZONI", "2", ""],
  ["CHINDEMI ANTONIO", "347876081", "", "ROMA TIBURTINA - LARGO MAZZONI", "2", ""],
  ["CIMMINO ROSA", "3406259498", "", "ROMA TIBURTINA - LARGO MAZZONI", "2", ""],
  ["D'ACHILLE ROSANGELA", "3394206392", "", "ROMA TIBURTINA - LARGO MAZZONI", "1", ""],
  // FOLIGNO — 4 righe / 8 pax
  ["GRIGIONI GIORDANO", "3929416289", "", "FOLIGNO - CITY HOTEL", "2", ""],
  ["PELLEGRINI CARLO MARIA", "3286931086", "", "FOLIGNO - CITY HOTEL", "2", ""],
  ["LORENZINI ALESSIO", "3473681384", "", "FOLIGNO - CITY HOTEL", "2", ""],
  ["PERGOLARI RINALDO", "3483857471", "", "FOLIGNO - CITY HOTEL", "2", ""],
  // VALMONTONE — 3 righe / 6 pax
  ["PINCARELLI MARINO", "3397766938", "", "VALMONTONE - CASELLO", "2", ""],
  ["MASELLA SEBASTIANA", "3397766938", "", "VALMONTONE - CASELLO", "2", ""],
  ["MASELLA VALENTINA", "3397766938", "", "VALMONTONE - CASELLO", "2", ""],
  // CITTA DI CASTELLO — 2 righe / 6 pax
  ["BALDICCHI GIUSEPPE", "3384135733", "", "CITTA DI CASTELLO - PARCHEGGIO STADIO", "2", ""],
  ["MAGGINI - SEVERINI - MENINI", "3358010640", "", "CITTA DI CASTELLO - PARCHEGGIO STADIO", "4", ""],
  // NARNI SCALO — 2 righe / 4 pax
  ["PAGANI", "3383896647", "", "NARNI SCALO", "2", ""],
  ["CASCIOLI", "3273331951", "", "NARNI SCALO", "2", ""],
  // ORTE — 2 righe / 4 pax
  ["LUNEIA", "3299041308", "", "ORTE - HOTEL TEVERE", "2", ""],
  ["DOLANO MARIA", "3486153941", "", "ORTE - HOTEL TEVERE", "2", ""],
  // SPOLETO — 2 righe / 4 pax
  ["TUZI STEFANO", "3392831970", "", "SPOLETO - HOTEL ARCA", "2", ""],
  ["DE PALO PATRIZIA", "", "", "SPOLETO - HOTEL ARCA", "2", ""],
  // ROMA ANAGNINA — 1 riga / 2 pax
  ["MAIARI RITA", "3384861046", "", "ROMA ANAGNINA - FERMATA ATAC 502", "2", ""],
  // VITERBO — 1 riga / 2 pax
  ["PESCI ROMINA", "3297155164", "", "VITERBO - PIAZZALE ROMITI", "2", ""],
  // PONTE SAN GIOVANNI — 1 riga / 2 pax
  ["PIZZICHINI ORLANDO", "3381461761", "", "PONTE SAN GIOVANNI - PIAZZALE MERCEDES", "2", ""],
  // SANTA MARIA DEGLI ANGELI — 1 riga / 2 pax
  ["DUFI LUTEI", "3934522823", "", "SANTA MARIA DEGLI ANGELI - HOTEL ANTONELLI", "2", ""],
];

// Riga di piede foglio presente nel file reale (creava un fantasma "TOTALE"
// 76 pax nei primi 2 tentativi di import di Mario, vedi audit DB).
const FOOTER_ROW = ["TOTALE", "", "", "", "76", ""];

function buildRaw(): unknown[][] {
  return [HEADER, ...PASSENGER_ROWS, FOOTER_ROW];
}

describe("parseBusImportRows — file reale 'PARTENZA BUS N. 2 - LINEA UMBRIA.xlsx' (audit 2026-09-06)", () => {
  it("produce esattamente 37 righe / 76 pax, nessuna persa", () => {
    const { rows, error } = parseBusImportRows(buildRaw(), STOPS, [LINE], "departure", []);
    expect(error).toBeNull();
    expect(rows).toHaveLength(37);
    expect(rows.reduce((sum, r) => sum + r.pax, 0)).toBe(76);
  });

  it("scarta la riga di totale/piede foglio 'TOTALE' (non è un passeggero)", () => {
    const { rows } = parseBusImportRows(buildRaw(), STOPS, [LINE], "departure", []);
    expect(rows.some((r) => r.name.trim().toUpperCase() === "TOTALE")).toBe(false);
  });

  it("Terni: esattamente 8 righe e 18 pax, con destinazione 'TERNI - TERMINAL BUS ATC'", () => {
    const { rows } = parseBusImportRows(buildRaw(), STOPS, [LINE], "departure", []);
    const terniRows = rows.filter((r) => r.cityNorm === "TERNI");
    const terniPax = terniRows.reduce((sum, r) => sum + r.pax, 0);

    expect(terniRows).toHaveLength(8);
    expect(terniPax).toBe(18);
    // 2 + 3 + 2 + 3 + 2 + 2 + 2 + 2 = 18
    expect(terniRows.map((r) => r.pax)).toEqual([2, 3, 2, 3, 2, 2, 2, 2]);
    for (const r of terniRows) {
      expect(r.cityRaw).toBe("TERNI - TERMINAL BUS ATC");
      expect(r.status).not.toBe("pending");
    }
  });

  it("MOSCA ANGELO - VIRILI CARLA (telefono vuoto) non viene esclusa", () => {
    const { rows } = parseBusImportRows(buildRaw(), STOPS, [LINE], "departure", []);
    const mosca = rows.find((r) => r.name.includes("MOSCA ANGELO"));
    expect(mosca).toBeDefined();
    expect(mosca?.phone).toBe("");
    expect(mosca?.pax).toBe(2);
    expect(mosca?.cityNorm).toBe("TERNI");
    expect(mosca?.status).not.toBe("pending");
  });

  it("DE PALO PATRIZIA a Spoleto (telefono vuoto) non viene esclusa", () => {
    const { rows } = parseBusImportRows(buildRaw(), STOPS, [LINE], "departure", []);
    const row = rows.find((r) => r.name.includes("DE PALO"));
    expect(row).toBeDefined();
    expect(row?.phone).toBe("");
  });

  it("le altre 12 fermate sommano 29 righe / 58 pax (37-8 righe, 76-18 pax)", () => {
    const { rows } = parseBusImportRows(buildRaw(), STOPS, [LINE], "departure", []);
    const nonTerni = rows.filter((r) => r.cityNorm !== "TERNI");
    expect(nonTerni).toHaveLength(29);
    expect(nonTerni.reduce((sum, r) => sum + r.pax, 0)).toBe(58);
  });

  it("è deterministico: parsare lo stesso file più volte produce sempre lo stesso risultato", () => {
    const first = parseBusImportRows(buildRaw(), STOPS, [LINE], "departure", []);
    const second = parseBusImportRows(buildRaw(), STOPS, [LINE], "departure", []);
    const third = parseBusImportRows(buildRaw(), STOPS, [LINE], "departure", []);
    for (const result of [first, second, third]) {
      expect(result.rows).toHaveLength(37);
      expect(result.rows.reduce((s, r) => s + r.pax, 0)).toBe(76);
      expect(result.rows.filter((r) => r.cityNorm === "TERNI")).toHaveLength(8);
    }
  });
});
