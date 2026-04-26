import { describe, it, expect } from "vitest";
import {
  aggregateYTD,
  computeReturnUsageProbability,
  computeRecoveryRate,
  buildMonthlyActuals,
  computeAvgMonthlyTickets,
  classifyReturnProbability,
  type SimTicket,
  type SimLeg,
} from "@/lib/medmar-ar/simulator-calc";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const T = (id: string, mode: SimTicket["ticket_mode"], pax: number, price: number, date = "2026-04-10"): SimTicket => ({
  id,
  travel_date: date,
  pax_count: pax,
  ticket_mode: mode,
  total_price_cents: price,
  unit_price_cents: Math.round(price / pax),
});

const L = (ticket_id: string, type: "outbound" | "return", status: string, ppp = 1025): SimLeg => ({
  ticket_id,
  leg_type: type,
  price_per_pax_cents: ppp,
  status,
});

// ─── aggregateYTD ──────────────────────────────────────────────────────────

describe("aggregateYTD — conteggi base", () => {
  it("restituisce zero su input vuoti", () => {
    const r = aggregateYTD([], []);
    expect(r.totalTickets).toBe(0);
    expect(r.totalPax).toBe(0);
    expect(r.totalValue).toBe(0);
    expect(r.returnLegsTotal).toBe(0);
    expect(r.totalLost).toBe(0);
    expect(r.totalRecovered).toBe(0);
  });

  it("conta correttamente round_trip, single_outbound, single_return", () => {
    const tickets = [
      T("a", "round_trip", 2, 2050),
      T("b", "round_trip", 3, 3075),
      T("c", "single_outbound", 1, 1370),
      T("d", "single_return", 2, 2740),
    ];
    const r = aggregateYTD(tickets, []);
    expect(r.roundTripCount).toBe(2);
    expect(r.singleOutCount).toBe(1);
    expect(r.singleRetCount).toBe(1);
    expect(r.totalTickets).toBe(4);
  });

  it("somma pax e valore totale correttamente", () => {
    const tickets = [
      T("a", "round_trip", 2, 2050),
      T("b", "single_outbound", 3, 4110),
    ];
    const r = aggregateYTD(tickets, []);
    expect(r.totalPax).toBe(5);
    expect(r.totalValue).toBe(6160);
  });

  it("conta legs ritorno usati e non usati", () => {
    const tickets = [T("a", "round_trip", 2, 2050)];
    const legs = [
      L("a", "return", "used"),
      L("a", "return", "available_for_reassignment"),
      L("a", "outbound", "used"),
    ];
    const r = aggregateYTD(tickets, legs);
    expect(r.returnLegsTotal).toBe(2);
    expect(r.returnLegsUsed).toBe(1);
  });

  it("legs reassigned contano come usati per la probabilità", () => {
    const tickets = [T("a", "round_trip", 2, 2050)];
    const legs = [
      L("a", "return", "reassigned"),
      L("a", "return", "lost"),
    ];
    const r = aggregateYTD(tickets, legs);
    expect(r.returnLegsUsed).toBe(1); // reassigned conta come usato
    expect(r.returnLegsTotal).toBe(2);
  });

  it("calcola totalLost con pax × price_per_pax_cents", () => {
    const tickets = [T("a", "round_trip", 3, 6150)];
    const legs = [L("a", "return", "lost", 1025)]; // lost: 1025 × 3 = 3075
    const r = aggregateYTD(tickets, legs);
    expect(r.totalLost).toBe(3075);
    expect(r.totalRecovered).toBe(0);
  });

  it("calcola totalRecovered con pax × price_per_pax_cents", () => {
    const tickets = [T("a", "round_trip", 2, 4100)];
    const legs = [L("a", "return", "reassigned", 1025)]; // recovered: 1025 × 2 = 2050
    const r = aggregateYTD(tickets, legs);
    expect(r.totalRecovered).toBe(2050);
  });

  it("ignora legs con ticket_id non trovato (orfani)", () => {
    const tickets = [T("a", "round_trip", 2, 2050)];
    const legs = [L("nonexistent", "return", "lost", 1025)];
    const r = aggregateYTD(tickets, legs);
    expect(r.totalLost).toBe(0); // leg ignorata
  });
});

// ─── computeReturnUsageProbability ────────────────────────────────────────

describe("computeReturnUsageProbability", () => {
  it("ritorna 0.5 quando returnLegsTotal=0 (nessuno storico)", () => {
    expect(computeReturnUsageProbability(0, 0)).toBe(0.5);
  });

  it("ritorna 1.0 quando tutti i ritorni sono stati usati", () => {
    expect(computeReturnUsageProbability(10, 10)).toBe(1.0);
  });

  it("ritorna 0.0 quando nessun ritorno è stato usato", () => {
    expect(computeReturnUsageProbability(0, 10)).toBe(0.0);
  });

  it("calcola frazione corretta", () => {
    expect(computeReturnUsageProbability(3, 4)).toBeCloseTo(0.75);
  });

  it("non dipende da valori assoluti, solo dalla proporzione", () => {
    expect(computeReturnUsageProbability(1, 2)).toBe(computeReturnUsageProbability(50, 100));
  });
});

// ─── computeRecoveryRate ──────────────────────────────────────────────────

describe("computeRecoveryRate", () => {
  it("ritorna 0 quando non ci sono lost né recovered", () => {
    expect(computeRecoveryRate(0, 0)).toBe(0);
  });

  it("ritorna 1.0 quando tutto il perso è stato recuperato", () => {
    expect(computeRecoveryRate(5000, 0)).toBe(1.0);
  });

  it("ritorna 0.0 quando nulla è stato recuperato", () => {
    expect(computeRecoveryRate(0, 5000)).toBe(0.0);
  });

  it("calcola tasso di recupero parziale", () => {
    expect(computeRecoveryRate(3000, 7000)).toBeCloseTo(0.3); // 3000 / (3000+7000)
  });

  it("è simmetrico rispetto alla somma lost+recovered", () => {
    const r1 = computeRecoveryRate(2000, 8000);
    const r2 = computeRecoveryRate(200, 800);
    expect(r1).toBeCloseTo(r2);
  });
});

// ─── buildMonthlyActuals ──────────────────────────────────────────────────

describe("buildMonthlyActuals — raggruppamento per mese", () => {
  it("ritorna array vuoto con input vuoti", () => {
    expect(buildMonthlyActuals([], [])).toEqual([]);
  });

  it("raggruppa biglietti dello stesso mese", () => {
    const tickets = [
      T("a", "round_trip", 2, 2050, "2026-04-01"),
      T("b", "single_outbound", 1, 1370, "2026-04-15"),
    ];
    const result = buildMonthlyActuals(tickets, []);
    expect(result).toHaveLength(1);
    expect(result[0].month).toBe("2026-04");
    expect(result[0].tickets).toBe(2);
    expect(result[0].pax).toBe(3);
    expect(result[0].value_cents).toBe(3420);
  });

  it("separa biglietti di mesi diversi e li ordina cronologicamente", () => {
    const tickets = [
      T("a", "round_trip", 2, 2050, "2026-06-01"),
      T("b", "single_outbound", 1, 1370, "2026-04-15"),
      T("c", "round_trip", 3, 3075, "2026-05-10"),
    ];
    const result = buildMonthlyActuals(tickets, []);
    expect(result).toHaveLength(3);
    expect(result[0].month).toBe("2026-04");
    expect(result[1].month).toBe("2026-05");
    expect(result[2].month).toBe("2026-06");
  });

  it("somma lost_cents con pax_count × price_per_pax_cents per lost legs", () => {
    const tickets = [T("a", "round_trip", 3, 3075, "2026-04-10")];
    const legs = [L("a", "return", "lost", 1025)]; // 1025 × 3 = 3075
    const result = buildMonthlyActuals(tickets, legs);
    expect(result[0].lost_cents).toBe(3075);
    expect(result[0].recovered_cents).toBe(0);
  });

  it("somma recovered_cents per reassigned legs", () => {
    const tickets = [T("a", "round_trip", 2, 2050, "2026-04-10")];
    const legs = [L("a", "return", "reassigned", 1025)]; // 1025 × 2 = 2050
    const result = buildMonthlyActuals(tickets, legs);
    expect(result[0].recovered_cents).toBe(2050);
  });

  it("conta round_trip_count correttamente", () => {
    const tickets = [
      T("a", "round_trip", 2, 2050, "2026-04-01"),
      T("b", "single_outbound", 1, 1370, "2026-04-05"),
      T("c", "round_trip", 3, 3075, "2026-04-20"),
    ];
    const result = buildMonthlyActuals(tickets, []);
    expect(result[0].round_trip_count).toBe(2);
  });
});

// ─── computeAvgMonthlyTickets ─────────────────────────────────────────────

describe("computeAvgMonthlyTickets", () => {
  it("ritorna totalTickets come fallback se nessun mese è completato", () => {
    const actuals = [{ month: "2026-04", tickets: 50, pax: 0, value_cents: 0, lost_cents: 0, recovered_cents: 0, round_trip_count: 0 }];
    expect(computeAvgMonthlyTickets(actuals, "2026-04", 50)).toBe(50);
  });

  it("calcola media sui mesi completati (prima del mese corrente)", () => {
    const actuals = [
      { month: "2026-02", tickets: 40, pax: 0, value_cents: 0, lost_cents: 0, recovered_cents: 0, round_trip_count: 0 },
      { month: "2026-03", tickets: 60, pax: 0, value_cents: 0, lost_cents: 0, recovered_cents: 0, round_trip_count: 0 },
      { month: "2026-04", tickets: 50, pax: 0, value_cents: 0, lost_cents: 0, recovered_cents: 0, round_trip_count: 0 }, // mese corrente
    ];
    // Media su feb + mar = (40+60) / 2 = 50
    expect(computeAvgMonthlyTickets(actuals, "2026-04", 150)).toBe(50);
  });

  it("esclude il mese corrente e i mesi futuri dal calcolo", () => {
    const actuals = [
      { month: "2026-01", tickets: 30, pax: 0, value_cents: 0, lost_cents: 0, recovered_cents: 0, round_trip_count: 0 },
      { month: "2026-04", tickets: 100, pax: 0, value_cents: 0, lost_cents: 0, recovered_cents: 0, round_trip_count: 0 },
      { month: "2026-05", tickets: 200, pax: 0, value_cents: 0, lost_cents: 0, recovered_cents: 0, round_trip_count: 0 },
    ];
    // Solo gennaio è "completato" rispetto ad aprile
    expect(computeAvgMonthlyTickets(actuals, "2026-04", 330)).toBe(30);
  });
});

// ─── classifyReturnProbability ────────────────────────────────────────────

describe("classifyReturnProbability — semafori", () => {
  it("ritorna 'medium' quando il campione è troppo piccolo", () => {
    expect(classifyReturnProbability(0.9, 2, 3)).toBe("medium");
    expect(classifyReturnProbability(0.1, 1, 3)).toBe("medium");
  });

  it("restituisce 'high' per probabilità > 0.7 con campione sufficiente", () => {
    expect(classifyReturnProbability(0.71, 10)).toBe("high");
    expect(classifyReturnProbability(1.0, 10)).toBe("high");
  });

  it("restituisce 'medium' per probabilità tra 0.4 e 0.7", () => {
    expect(classifyReturnProbability(0.5, 10)).toBe("medium");
    expect(classifyReturnProbability(0.4, 10)).toBe("medium");
    expect(classifyReturnProbability(0.7, 10)).toBe("medium");
  });

  it("restituisce 'low' per probabilità < 0.4 con campione sufficiente", () => {
    expect(classifyReturnProbability(0.39, 10)).toBe("low");
    expect(classifyReturnProbability(0.0, 10)).toBe("low");
  });

  it("minSampleSize=0 significa che qualsiasi campione è accettabile", () => {
    expect(classifyReturnProbability(0.8, 1, 0)).toBe("high");
    expect(classifyReturnProbability(0.0, 0, 0)).toBe("low");
  });
});
