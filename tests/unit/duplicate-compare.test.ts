import { describe, it, expect } from "vitest";
import { computeDuplicateDiff, type DuplicateIncomingSummary } from "@/lib/duplicate-compare";

/**
 * Confronto CAMPO | ESISTENTE | NUOVI DATI del pannello duplicati Inbox.
 * Requisiti coperti: CASO 1 (identico → nessuna evidenza), CASO 7 (valori
 * identici non evidenziati, valori diversi evidenziati correttamente).
 */

function incoming(overrides: Partial<DuplicateIncomingSummary> = {}): DuplicateIncomingSummary {
  return {
    customer_name: "MARIOTTI SERENA",
    date: "2026-09-06",
    hotel: "ISOLA VERDE HOTEL & THERMAL SPA",
    pax: "2",
    phone: "3289126048",
    agency: "Aleste Viaggi",
    practice_number: "26/011405",
    arrival_time: "12:48",
    return_time: "13:25",
    transport_code: "ITA 8903 / ITA 8918",
    ...overrides,
  };
}

describe("computeDuplicateDiff", () => {
  it("CASO 1: nuova comunicazione identica → identical:true, nessuna riga changed", () => {
    const existing = {
      practice_number: "26/011405",
      arrival_time: "12:48",
      return_time: "13:25",
      transport_code: "ITA 8903 / ITA 8918",
      pax: 2,
      phone: "3289126048",
      hotel_name: "ISOLA VERDE HOTEL & THERMAL SPA",
      customer_name: "MARIOTTI SERENA",
      date: "2026-09-06",
    };
    const diff = computeDuplicateDiff(existing, incoming());
    expect(diff.identical).toBe(true);
    expect(diff.changedLabels).toEqual([]);
    expect(diff.rows.every((r) => r.changed === false)).toBe(true);
  });

  it("CASO 2/7: solo i campi realmente diversi sono changed, gli identici no", () => {
    const existing = {
      practice_number: "26/011405",
      arrival_time: "12:53",
      return_time: "13:20",
      transport_code: null,
      pax: 2,
      phone: "3289126048",
      hotel_name: "PARCO HOTEL TERME VILLA TERESA",
      customer_name: "MARIOTTI SERENA",
      date: "2026-09-06",
    };
    const diff = computeDuplicateDiff(existing, incoming({ hotel: "VILLA TERESA" }));
    expect(diff.identical).toBe(false);
    expect(new Set(diff.changedLabels)).toEqual(new Set(["Arrivo", "Ritorno", "Mezzo", "Hotel"]));
    const byLabel = Object.fromEntries(diff.rows.map((r) => [r.label, r]));
    expect(byLabel["Pratica"].changed).toBe(false);
    expect(byLabel["Pax"].changed).toBe(false);
    expect(byLabel["Telefono"].changed).toBe(false);
    expect(byLabel["Cliente"].changed).toBe(false);
    expect(byLabel["Mezzo"].existing).toBe("");
    expect(byLabel["Mezzo"].incoming).toBe("ITA 8903 / ITA 8918");
  });

  it("un campo vuoto nel nuovo import NON conta come modifica", () => {
    const existing = { transport_code: "ITA 8903", pax: 2, customer_name: "X", date: "2026-09-06" };
    const diff = computeDuplicateDiff(
      existing,
      incoming({ transport_code: "", customer_name: "X", pax: "2", date: "2026-09-06" })
    );
    const mezzo = diff.rows.find((r) => r.label === "Mezzo");
    expect(mezzo?.changed).toBe(false);
    expect(mezzo?.existing).toBe("ITA 8903");
  });

  it("orari equivalenti (12:5 vs 12:05) non sono una modifica", () => {
    const existing = { arrival_time: "12:5", customer_name: "X", date: "2026-09-06", pax: 2 };
    const diff = computeDuplicateDiff(
      existing,
      incoming({ arrival_time: "12:05", customer_name: "X", date: "2026-09-06", pax: "2" })
    );
    expect(diff.rows.find((r) => r.label === "Arrivo")?.changed).toBe(false);
  });

  it("fallback outbound_time quando arrival_time è assente", () => {
    const existing = { outbound_time: "12:53", customer_name: "X", date: "2026-09-06", pax: 2 };
    const diff = computeDuplicateDiff(
      existing,
      incoming({ arrival_time: "12:48", customer_name: "X", date: "2026-09-06", pax: "2" })
    );
    const arrivo = diff.rows.find((r) => r.label === "Arrivo");
    expect(arrivo?.existing).toBe("12:53");
    expect(arrivo?.changed).toBe(true);
  });
});
