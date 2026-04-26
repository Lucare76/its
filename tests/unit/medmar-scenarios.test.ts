import { describe, it, expect } from "vitest";
import { buildDecisionScenarios, DEFAULT_PRICES_CENTS } from "@/lib/medmar-ar/types";

const P = DEFAULT_PRICES_CENTS;
// P.round_trip_per_leg     = 1025
// P.single_trip_under_12   = 1370
// P.single_trip_12_or_more = 1025

describe("buildDecisionScenarios — pax ≥ 12", () => {
  it("restituisce un solo scenario con tariffa scontata gruppo", () => {
    const scenarios = buildDecisionScenarios(12, P, 0.5, false, 12);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]!.mode).toBe("single_outbound");
    expect(scenarios[0]!.recommended).toBe(true);
  });

  it("totalCents = single_trip_12_or_more × pax", () => {
    const scenarios = buildDecisionScenarios(15, P, 0.5, false, 12);
    expect(scenarios[0]!.totalCents).toBe(P.single_trip_12_or_more * 15);
  });

  it("pax esattamente 12 → scenario unico, non A/R", () => {
    const scenarios = buildDecisionScenarios(12, P, 0.9, false, 12);
    expect(scenarios.every(s => s.mode !== "round_trip")).toBe(true);
  });
});

describe("buildDecisionScenarios — pax < 12, alta probabilità ritorno", () => {
  // Con prezzi default round_trip_per_leg=1025 → A/R=2050 > singola=1370, quindi
  // l'A/R è sempre più costoso. Usiamo prezzi con A/R favorevole (leg=400 → 800<1370).
  const cheapAR = { ...P, round_trip_per_leg: 400 };

  it("probabilità 0.8 → A/R raccomandato con A/R più economico del singolo", () => {
    const scenarios = buildDecisionScenarios(5, cheapAR, 0.8, false, 12);
    const ar = scenarios.find(s => s.mode === "round_trip");
    expect(ar).toBeDefined();
    expect(ar!.recommended).toBe(true);
    expect(ar!.riskLevel).toBe("low");
    expect(ar!.badge).toBe("Conveniente");
  });

  it("totalCents A/R = round_trip_per_leg × 2 × pax", () => {
    const scenarios = buildDecisionScenarios(4, cheapAR, 0.8, false, 12);
    const ar = scenarios.find(s => s.mode === "round_trip")!;
    expect(ar.totalCents).toBe(cheapAR.round_trip_per_leg * 2 * 4);
    expect(ar.perPaxCents).toBe(cheapAR.round_trip_per_leg * 2);
  });
});

describe("buildDecisionScenarios — pax < 12, bassa probabilità ritorno", () => {
  it("probabilità 0.2 → singola andata raccomandato", () => {
    const scenarios = buildDecisionScenarios(5, P, 0.2, false, 12);
    const single = scenarios.find(s => s.mode === "single_outbound");
    expect(single).toBeDefined();
    expect(single!.recommended).toBe(true);
  });

  it("probabilità 0.2 → A/R ha riskLevel high", () => {
    const scenarios = buildDecisionScenarios(5, P, 0.2, false, 12);
    const ar = scenarios.find(s => s.mode === "round_trip")!;
    expect(ar.riskLevel).toBe("high");
    expect(ar.badge).toBe("Alto rischio spreco");
  });

  it("probabilità 0.5 → A/R ha riskLevel medium", () => {
    const scenarios = buildDecisionScenarios(3, P, 0.5, false, 12);
    const ar = scenarios.find(s => s.mode === "round_trip")!;
    expect(ar.riskLevel).toBe("medium");
  });
});

describe("buildDecisionScenarios — raggruppamento pending", () => {
  it("canGroup=true aggiunge lo scenario pending_group", () => {
    const scenarios = buildDecisionScenarios(9, P, 0.5, true, 12);
    const pg = scenarios.find(s => s.mode === "pending_group");
    expect(pg).toBeDefined();
    expect(pg!.perPaxCents).toBe(P.single_trip_12_or_more);
  });

  it("canGroup=false non aggiunge pending_group", () => {
    const scenarios = buildDecisionScenarios(9, P, 0.5, false, 12);
    expect(scenarios.find(s => s.mode === "pending_group")).toBeUndefined();
  });
});

describe("buildDecisionScenarios — matematica costo atteso A/R", () => {
  it("costo atteso A/R < singola con prezzi A/R favorevoli → A/R raccomandato", () => {
    const pax = 3;
    const prob = 0.9;
    // Prezzi con A/R conveniente: leg=400 → A/R=800/pax < singola=1370/pax
    const cheapPrices = { ...P, round_trip_per_leg: 400 };
    const arPerLeg = cheapPrices.round_trip_per_leg;
    const arTotal = arPerLeg * 2 * pax;
    const singleTotal = cheapPrices.single_trip_under_12 * pax;
    // arExpectedCost = arTotal * prob + (arLeg * pax + singlePrice * pax) * (1-prob)
    const arExpected = arTotal * prob + (arPerLeg * pax + cheapPrices.single_trip_under_12 * pax) * (1 - prob);
    expect(arExpected).toBeLessThan(singleTotal);

    const scenarios = buildDecisionScenarios(pax, cheapPrices, prob, false, 12);
    expect(scenarios.find(s => s.mode === "round_trip")!.recommended).toBe(true);
  });

  it("un solo scenario è raccomandato per volta", () => {
    const scenarios = buildDecisionScenarios(4, P, 0.5, true, 12);
    const recommended = scenarios.filter(s => s.recommended);
    expect(recommended).toHaveLength(1);
  });

  it("prezzi personalizzati vengono usati correttamente", () => {
    const customPrices = { ...P, round_trip_per_leg: 900, single_trip_under_12: 1500 };
    const scenarios = buildDecisionScenarios(4, customPrices, 0.8, false, 12);
    const ar = scenarios.find(s => s.mode === "round_trip")!;
    expect(ar.totalCents).toBe(900 * 2 * 4);
  });
});

describe("buildDecisionScenarios — edge case pax = 1", () => {
  it("funziona correttamente con un solo passeggero", () => {
    const scenarios = buildDecisionScenarios(1, P, 0.5, false, 12);
    expect(scenarios.length).toBeGreaterThanOrEqual(2);
    expect(scenarios.find(s => s.mode === "single_outbound")!.totalCents).toBe(P.single_trip_under_12);
  });
});
