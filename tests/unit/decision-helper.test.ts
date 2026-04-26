import { describe, expect, it } from "vitest";
import { buildDecisionHelperSnapshot } from "@/lib/medmar-ar/decision-helper";
import { DEFAULT_PRICES_CENTS } from "@/lib/medmar-ar/types";

describe("buildDecisionHelperSnapshot", () => {
  it("usa la probabilità storica dello stesso outbound_time quando disponibile", () => {
    const snapshot = buildDecisionHelperSnapshot({
      pax: 5,
      route: "pozzuoli_ischia",
      outboundTime: "09:30",
      priceRows: [],
      pendingGroups: [],
      historicalReturnLegs: [
        { status: "used", medmar_ar_tickets: { outbound_time: "09:30" } },
        { status: "used", medmar_ar_tickets: { outbound_time: "09:30" } },
        { status: "lost", medmar_ar_tickets: { outbound_time: "09:30" } },
        { status: "lost", medmar_ar_tickets: { outbound_time: "07:00" } },
      ],
    });

    expect(snapshot.historicalSampleSize).toBe(3);
    expect(snapshot.returnUsageProbability).toBeCloseTo(2 / 3);
  });

  it("fa fallback allo storico della tratta se non ci sono righe per l'orario richiesto", () => {
    const snapshot = buildDecisionHelperSnapshot({
      pax: 5,
      route: "pozzuoli_ischia",
      outboundTime: "12:30",
      priceRows: [],
      pendingGroups: [],
      historicalReturnLegs: [
        { status: "used", medmar_ar_tickets: { outbound_time: "09:30" } },
        { status: "lost", medmar_ar_tickets: { outbound_time: "07:00" } },
      ],
    });

    expect(snapshot.historicalSampleSize).toBe(2);
    expect(snapshot.returnUsageProbability).toBe(0.5);
  });

  it("costruisce i semafori orari con campione minimo prima di promuovere high/low", () => {
    const snapshot = buildDecisionHelperSnapshot({
      pax: 4,
      route: "pozzuoli_ischia",
      outboundTime: "07:00",
      priceRows: [],
      pendingGroups: [],
      historicalReturnLegs: [
        { status: "used", medmar_ar_tickets: { outbound_time: "07:00" } },
        { status: "used", medmar_ar_tickets: { outbound_time: "07:00" } },
        { status: "used", medmar_ar_tickets: { outbound_time: "07:00" } },
        { status: "lost", medmar_ar_tickets: { outbound_time: "09:30" } },
        { status: "used", medmar_ar_tickets: { outbound_time: "09:30" } },
      ],
    });

    const seven = snapshot.timeSignals.find((item) => item.time === "07:00");
    const nineThirty = snapshot.timeSignals.find((item) => item.time === "09:30");

    expect(seven).toMatchObject({ probability: 1, signal: "high" });
    expect(nineThirty).toMatchObject({ probability: 0.5, signal: "medium" });
  });

  it("usa i prezzi attivi più recenti e abilita il pending_group solo sotto soglia", () => {
    const snapshot = buildDecisionHelperSnapshot({
      pax: 9,
      route: "pozzuoli_ischia",
      outboundTime: "09:30",
      priceRows: [
        { price_type: "single_trip_under_12", price_cents: 1500 },
        { price_type: "single_trip_under_12", price_cents: 9999 },
        { price_type: "round_trip_per_leg", price_cents: 950 },
      ],
      pendingGroups: [
        { id: "g1", current_pax_count: 2, target_threshold: 12, outbound_time: "09:30" },
      ],
      historicalReturnLegs: [],
    });

    expect(snapshot.prices.single_trip_under_12).toBe(1500);
    expect(snapshot.prices.single_trip_12_or_more).toBe(DEFAULT_PRICES_CENTS.single_trip_12_or_more);
    expect(snapshot.canGroup).toBe(true);
    expect(snapshot.scenarios.some((item) => item.mode === "pending_group")).toBe(true);
  });
});
