import { describe, expect, it } from "vitest";
import {
  buildDuplicateSideBySideRows,
  ferryMetaLabel,
  ferrySingleLegLabel,
  type FormState,
  type FerryMeta,
} from "@/app/(app)/inbox/page";

/**
 * Audit pratica 26/010806 (MATTIOLI ALESSANDRA): la riga "Traghetto" della
 * modale duplicati deve confrontare due valori GIÀ risolti server-side
 * (ferry_meta / incoming_ferry_meta, via lib/server/ferry-connection-lookup.ts)
 * — questo file testa SOLO la formattazione/confronto client-side, mai una
 * regola di dominio (zona/traghetto-aliscafo/compagnia), che resta server-side.
 */

const MEDMAR_RETURN_LEG = {
  company: "MEDMAR",
  ferry_type: "traghetto" as const,
  departure_port: "Casamicciola",
  arrival_port: "Pozzuoli",
  departure_time: "10:10",
  arrival_time: null,
  pickup_time: "08:30",
};

const ALILAURO_RETURN_LEG = {
  company: "ALILAURO",
  ferry_type: "aliscafo" as const,
  departure_port: "Ischia Porto",
  arrival_port: "Napoli Beverello",
  departure_time: "13:20",
  arrival_time: "14:05",
  pickup_time: null,
};

function emptyForm(overrides: Partial<FormState> = {}): FormState {
  return {
    cliente_nome: "MATTIOLI ALESSANDRA",
    cliente_cellulare: "3475489819",
    n_pax: "3",
    hotel: "VILLA TERESA",
    data_arrivo: "2026-09-01",
    orario_arrivo: "12:53",
    data_partenza: "2026-09-06",
    orario_partenza: "13:20",
    tipo_servizio: "transfer_station_hotel",
    treno_andata: "ITA 9998",
    treno_ritorno: "ITA 9940",
    citta_partenza: "ROMA TERMINI",
    totale_pratica: "168",
    note: "",
    numero_pratica: "26/010806",
    agenzia: "Aleste Viaggi",
    pickup_hotel: "",
    ...overrides,
  };
}

const EXISTING_SERVICE = {
  customer_name: "MATTIOLI ALESSANDRA",
  booking_service_kind: "transfer_train_hotel",
  service_type_code: "transfer_station_hotel",
  arrival_date: "2026-09-01",
  arrival_time: "12:53",
  departure_date: "2026-09-06",
  departure_time: "13:20",
  pax: 3,
};

describe("buildDuplicateSideBySideRows — riga Traghetto (audit MATTIOLI 26/010806)", () => {
  it("6. esistente e nuova con la stessa connessione canonica (MEDMAR) -> riga Traghetto NON changed", () => {
    const meta: FerryMeta = { outbound: null, return: MEDMAR_RETURN_LEG };
    const rows = buildDuplicateSideBySideRows(EXISTING_SERVICE, "VILLA TERESA", "Aleste Viaggi", emptyForm(), meta, meta);
    const traghetto = rows.find((r) => r.label === "Traghetto");
    expect(traghetto).toBeDefined();
    expect(traghetto?.existing).toContain("MEDMAR");
    expect(traghetto?.incoming).toContain("MEDMAR");
    expect(traghetto?.changed).toBe(false);
  });

  it("7. il nuovo import comunica realmente una soluzione diversa (ALILAURO vs MEDMAR) -> riga Traghetto changed", () => {
    const existingMeta: FerryMeta = { outbound: null, return: MEDMAR_RETURN_LEG };
    const incomingMeta: FerryMeta = { outbound: null, return: ALILAURO_RETURN_LEG };
    const rows = buildDuplicateSideBySideRows(EXISTING_SERVICE, "VILLA TERESA", "Aleste Viaggi", emptyForm(), existingMeta, incomingMeta);
    const traghetto = rows.find((r) => r.label === "Traghetto");
    expect(traghetto?.existing).toContain("MEDMAR");
    expect(traghetto?.incoming).toContain("ALILAURO");
    expect(traghetto?.changed).toBe(true);
  });

  it("entrambi i lati non determinabili (undetermined) -> 'Da determinare' su entrambi, MAI '—', NON changed", () => {
    const meta: FerryMeta = { outbound: null, return: null };
    const rows = buildDuplicateSideBySideRows(EXISTING_SERVICE, "VILLA TERESA", "Aleste Viaggi", emptyForm(), meta, meta);
    const traghetto = rows.find((r) => r.label === "Traghetto");
    expect(traghetto?.existing).toBe("Da determinare");
    expect(traghetto?.incoming).toBe("Da determinare");
    expect(traghetto?.changed).toBe(false);
  });

  it("un solo lato determinato, l'altro 'Da determinare' -> NON changed (nessuna comunicazione reale da confrontare)", () => {
    const existingMeta: FerryMeta = { outbound: null, return: MEDMAR_RETURN_LEG };
    const incomingMeta: FerryMeta = { outbound: null, return: null };
    const rows = buildDuplicateSideBySideRows(EXISTING_SERVICE, "VILLA TERESA", "Aleste Viaggi", emptyForm(), existingMeta, incomingMeta);
    const traghetto = rows.find((r) => r.label === "Traghetto");
    expect(traghetto?.existing).toContain("MEDMAR");
    expect(traghetto?.incoming).toBe("Da determinare");
    expect(traghetto?.changed).toBe(false);
  });

  it("booking non treno/volo (bus) senza dati traghetto -> riga Traghetto omessa (non applicabile, non 'Da determinare')", () => {
    const busService = { ...EXISTING_SERVICE, booking_service_kind: "bus_city_hotel", service_type_code: "bus_line" };
    const busForm = emptyForm({ tipo_servizio: "bus_city_hotel" });
    const meta: FerryMeta = { outbound: null, return: null };
    const rows = buildDuplicateSideBySideRows(busService, "VILLA TERESA", "Aleste Viaggi", busForm, meta, meta);
    expect(rows.find((r) => r.label === "Traghetto")).toBeUndefined();
  });
});

describe("ferryMetaLabel / ferrySingleLegLabel — formattazione pura, nessuna regola di dominio", () => {
  it("combina andata + ritorno quando entrambe presenti", () => {
    const meta: FerryMeta = { outbound: MEDMAR_RETURN_LEG, return: ALILAURO_RETURN_LEG };
    const label = ferryMetaLabel(meta);
    expect(label).toContain("MEDMAR");
    expect(label).toContain("ALILAURO");
  });

  it("null/assente -> stringa vuota", () => {
    expect(ferryMetaLabel(null)).toBe("");
    expect(ferryMetaLabel({})).toBe("");
    expect(ferrySingleLegLabel(null)).toBeNull();
  });
});
