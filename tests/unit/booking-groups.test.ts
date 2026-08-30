import { describe, it, expect } from "vitest";
import {
  summarizeBookingGroupPax,
  computeBookingGroupStatusSummary,
  summarizeStopPax,
  BOOKING_GROUP_KINDS,
  BOOKING_GROUP_STATUSES,
} from "@/lib/booking-groups";

/**
 * FASE 1 — domain helpers gruppi prenotazione.
 * Scenario di riferimento: PARROCCHIA NATIVITÀ, expected_pax = 50.
 */

describe("summarizeBookingGroupPax — gap pax derivato, mai corretto automaticamente", () => {
  it("nessuna fermata: plannedPax=0, unplannedPax=expected", () => {
    const s = summarizeBookingGroupPax({ expectedPax: 50, stopExpectedPax: [], servicePax: [] });
    expect(s).toMatchObject({ expectedPax: 50, plannedPax: 0, unplannedPax: 50, servicePax: 0, remainingServicePax: 50, overbooked: false });
  });

  it("Tivoli 20 + Guidonia 20 → plannedPax=40, unplannedPax=10", () => {
    const s = summarizeBookingGroupPax({ expectedPax: 50, stopExpectedPax: [20, 20], servicePax: [] });
    expect(s.plannedPax).toBe(40);
    expect(s.unplannedPax).toBe(10);
    expect(s.overbooked).toBe(false);
  });

  it("+ Castel Madama 10 → plannedPax=50, unplannedPax=0", () => {
    const s = summarizeBookingGroupPax({ expectedPax: 50, stopExpectedPax: [20, 20, 10], servicePax: [] });
    expect(s.plannedPax).toBe(50);
    expect(s.unplannedPax).toBe(0);
    expect(s.overbooked).toBe(false);
  });

  it("overbooking fermate: +5 → plannedPax=55, overbooked=true, NON corretto", () => {
    const s = summarizeBookingGroupPax({ expectedPax: 50, stopExpectedPax: [20, 20, 10, 5], servicePax: [] });
    expect(s.plannedPax).toBe(55);
    expect(s.unplannedPax).toBe(-5); // negativo, non azzerato
    expect(s.overbooked).toBe(true);
  });

  it("services parziali: 26 pax su 50 → servicePax=26, remainingServicePax=24", () => {
    const s = summarizeBookingGroupPax({ expectedPax: 50, stopExpectedPax: [20, 20, 10], servicePax: [10, 16] });
    expect(s.servicePax).toBe(26);
    expect(s.remainingServicePax).toBe(24);
    expect(s.overbooked).toBe(false);
  });

  it("overbooking services: servicePax > expected → overbooked=true", () => {
    const s = summarizeBookingGroupPax({ expectedPax: 50, stopExpectedPax: [], servicePax: [30, 25] });
    expect(s.servicePax).toBe(55);
    expect(s.remainingServicePax).toBe(-5);
    expect(s.overbooked).toBe(true);
  });

  it("valori non numerici sono trattati come 0 (fail-safe)", () => {
    const s = summarizeBookingGroupPax({ expectedPax: 50, stopExpectedPax: [20, NaN as unknown as number], servicePax: [] });
    expect(s.plannedPax).toBe(20);
  });
});

describe("computeBookingGroupStatusSummary — suggerimento NON vincolante", () => {
  it("gruppo incompleto (nessuna fermata, nessun service): suggestedStatus resta draft/to_complete", () => {
    const draft = computeBookingGroupStatusSummary({ status: "draft", expectedPax: 50, stopExpectedPax: [], servicePax: [], busReservationCount: 0 });
    expect(draft.suggestedStatus).toBe("draft");
    expect(draft.hasStops).toBe(false);
    expect(draft.hasServices).toBe(false);

    const toComplete = computeBookingGroupStatusSummary({ status: "to_complete", expectedPax: 50, stopExpectedPax: [], servicePax: [], busReservationCount: 0 });
    expect(toComplete.suggestedStatus).toBe("to_complete");
  });

  it("con fermate ma senza nominativi → suggestedStatus = stops_defined", () => {
    const r = computeBookingGroupStatusSummary({ status: "to_complete", expectedPax: 50, stopExpectedPax: [20, 20], servicePax: [], busReservationCount: 1 });
    expect(r.suggestedStatus).toBe("stops_defined");
    expect(r.hasBusReservation).toBe(true);
    expect(r.pax.unplannedPax).toBe(10);
  });

  it("con nominativi → suggestedStatus = passengers_defined", () => {
    const r = computeBookingGroupStatusSummary({ status: "stops_defined", expectedPax: 50, stopExpectedPax: [20, 20, 10], servicePax: [4, 10], busReservationCount: 1 });
    expect(r.suggestedStatus).toBe("passengers_defined");
  });

  it("cancelled non viene mai promosso", () => {
    const r = computeBookingGroupStatusSummary({ status: "cancelled", expectedPax: 50, stopExpectedPax: [20], servicePax: [10], busReservationCount: 1 });
    expect(r.suggestedStatus).toBe("cancelled");
  });
});

describe("summarizeStopPax — pax service per fermata (FASE 2)", () => {
  it("G: fermata Guidonia 20 previsti, solo 10 creati → 10/20, 10 mancanti", () => {
    const s = summarizeStopPax({ stopId: "guidonia", expectedPax: 20, servicePax: [5, 5] });
    expect(s.expectedPax).toBe(20);
    expect(s.servicePax).toBe(10);
    expect(s.remainingServicePax).toBe(10);
    expect(s.serviceCount).toBe(2);
    expect(s.overbooked).toBe(false);
  });

  it("Tivoli 20/20 completa (Rossi 4 + Verdi 10 + Pinco 2 + Gennaro 4)", () => {
    const s = summarizeStopPax({ stopId: "tivoli", expectedPax: 20, servicePax: [4, 10, 2, 4] });
    expect(s.servicePax).toBe(20);
    expect(s.remainingServicePax).toBe(0);
    expect(s.serviceCount).toBe(4);
    expect(s.overbooked).toBe(false);
  });

  it("H: over-service — expected 20, services 22 → overbooked=true, non corretto", () => {
    const s = summarizeStopPax({ stopId: "x", expectedPax: 20, servicePax: [12, 10] });
    expect(s.servicePax).toBe(22);
    expect(s.remainingServicePax).toBe(-2);
    expect(s.overbooked).toBe(true);
  });
});

describe("costanti dominio distinte da TripGroup", () => {
  it("kind e status espliciti", () => {
    expect(BOOKING_GROUP_KINDS).toEqual(["bus_exclusive", "bus_group", "multi_service", "other"]);
    expect(BOOKING_GROUP_STATUSES).toContain("to_complete");
    expect(BOOKING_GROUP_STATUSES).toContain("operational");
  });
});
