import { describe, it, expect } from "vitest";
import { findRate, type RateRow } from "@/lib/server/rate-matcher";

const KIND = "transfer_port_hotel";
const AGENCY = "agency-uuid-001";

function makeRate(overrides: Partial<RateRow> = {}): RateRow {
  return {
    agency_id: AGENCY,
    booking_service_kind: KIND,
    price_cents: 5000,
    cost_cents: 3000,
    valid_from: "2026-01-01",
    valid_to: null,
    ...overrides,
  };
}

describe("findRate — match esatto", () => {
  it("trova la tariffa corretta per agenzia e tipo servizio", () => {
    const rates = [makeRate()];
    const result = findRate(rates, AGENCY, KIND, "2026-06-15");
    expect(result).not.toBeNull();
    expect(result!.price_cents).toBe(5000);
  });

  it("ritorna null se nessuna tariffa corrisponde all'agenzia", () => {
    const rates = [makeRate()];
    const result = findRate(rates, "altra-agenzia", KIND, "2026-06-15");
    expect(result).toBeNull();
  });

  it("ritorna null se nessuna tariffa corrisponde al tipo servizio", () => {
    const rates = [makeRate()];
    const result = findRate(rates, AGENCY, "formula_snav", "2026-06-15");
    expect(result).toBeNull();
  });
});

describe("findRate — filtro per data", () => {
  it("tariffa con valid_to=null è sempre attiva", () => {
    const rates = [makeRate({ valid_from: "2026-01-01", valid_to: null })];
    expect(findRate(rates, AGENCY, KIND, "2030-12-31")).not.toBeNull();
  });

  it("tariffa scaduta non viene restituita", () => {
    const rates = [makeRate({ valid_from: "2025-01-01", valid_to: "2025-12-31" })];
    expect(findRate(rates, AGENCY, KIND, "2026-06-15")).toBeNull();
  });

  it("tariffa non ancora iniziata non viene restituita", () => {
    const rates = [makeRate({ valid_from: "2027-01-01", valid_to: null })];
    expect(findRate(rates, AGENCY, KIND, "2026-06-15")).toBeNull();
  });

  it("tariffa valida esattamente per valid_from viene inclusa", () => {
    const rates = [makeRate({ valid_from: "2026-06-15", valid_to: null })];
    expect(findRate(rates, AGENCY, KIND, "2026-06-15")).not.toBeNull();
  });

  it("tariffa valida esattamente per valid_to viene inclusa", () => {
    const rates = [makeRate({ valid_from: "2026-01-01", valid_to: "2026-06-15" })];
    expect(findRate(rates, AGENCY, KIND, "2026-06-15")).not.toBeNull();
  });
});

describe("findRate — priorità tra più tariffe", () => {
  it("restituisce la tariffa con valid_from più recente", () => {
    const rates = [
      makeRate({ valid_from: "2026-01-01", price_cents: 4000 }),
      makeRate({ valid_from: "2026-04-01", price_cents: 5500 }),
      makeRate({ valid_from: "2026-03-01", price_cents: 5000 }),
    ];
    const result = findRate(rates, AGENCY, KIND, "2026-06-15");
    expect(result!.price_cents).toBe(5500);
  });

  it("ignora tariffe future anche se più recenti per valid_from", () => {
    const rates = [
      makeRate({ valid_from: "2026-01-01", price_cents: 4000, valid_to: null }),
      makeRate({ valid_from: "2027-01-01", price_cents: 9999, valid_to: null }),
    ];
    const result = findRate(rates, AGENCY, KIND, "2026-06-15");
    expect(result!.price_cents).toBe(4000);
  });
});

describe("findRate — lista tariffe vuota", () => {
  it("ritorna null con array vuoto", () => {
    expect(findRate([], AGENCY, KIND, "2026-06-15")).toBeNull();
  });
});

describe("findRate — calcolo margine", () => {
  it("margin = price - cost quando entrambi presenti", () => {
    const rate = findRate([makeRate({ price_cents: 8000, cost_cents: 5000 })], AGENCY, KIND, "2026-06-15")!;
    const margin = rate.price_cents! - rate.cost_cents!;
    expect(margin).toBe(3000);
  });

  it("cost_cents = null non causa errori", () => {
    const rate = findRate([makeRate({ cost_cents: null })], AGENCY, KIND, "2026-06-15")!;
    const margin = rate.price_cents != null && rate.cost_cents != null
      ? rate.price_cents - rate.cost_cents
      : null;
    expect(margin).toBeNull();
  });

  it("price_cents = 0 non causa divisione per zero nel calcolo percentuale", () => {
    const rate = findRate([makeRate({ price_cents: 0, cost_cents: 0 })], AGENCY, KIND, "2026-06-15")!;
    const pct = rate.price_cents !== 0
      ? ((rate.price_cents! - rate.cost_cents!) / rate.price_cents!) * 100
      : null;
    expect(pct).toBeNull();
  });
});
