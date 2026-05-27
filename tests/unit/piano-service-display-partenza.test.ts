import { describe, it, expect } from "vitest";
import { getPianoServiceDisplay } from "@/lib/piano-service-display";

function makePartenza(overrides: Record<string, unknown> = {}) {
  return {
    id: "svc-1",
    time: "08:30",
    direction: "departure" as const,
    hotel_id: "hotel-1",
    pax: 2,
    status: "new",
    meeting_point: "Ischia Porto",
    pickup_hotel: "08:15",
    customer_name: "Test",
    booking_service_kind: null,
    service_type_code: null,
    vessel: null,
    ...overrides,
  };
}

const hotelLaVilla = { id: "hotel-1", name: "La Villa", address: "Via Mortella", zone: "Forio", lat: 40.72, lng: 13.87, geo_status: null, geo_source: null, geo_accuracy: null, geo_verified_at: null };

describe("getPianoServiceDisplay — PARTENZA", () => {
  it("pickupLabel è null per evitare duplicati in PDF e UI", () => {
    const display = getPianoServiceDisplay(makePartenza(), hotelLaVilla);
    expect(display.pickupLabel).toBeNull();
  });

  it("actionLabel contiene il Pickup (unica occorrenza)", () => {
    const display = getPianoServiceDisplay(makePartenza(), hotelLaVilla);
    expect(display.actionLabel).toMatch(/^Pickup:/);
    // Non ci devono essere due "Pickup:" separati
    const occurrences = (display.actionLabel.match(/Pickup:/gi) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("placeLabel è il nome hotel (solo pickup, senza destinazione)", () => {
    const display = getPianoServiceDisplay(makePartenza(), hotelLaVilla);
    expect(display.placeLabel).toBe("La Villa");
  });

  it("destinationLabel è il porto di imbarco", () => {
    const display = getPianoServiceDisplay(makePartenza(), hotelLaVilla);
    expect(display.destinationLabel).toMatch(/ischia|porto/i);
  });

  it("macroCategory è PARTENZA", () => {
    const display = getPianoServiceDisplay(makePartenza(), hotelLaVilla);
    expect(display.macroCategory).toBe("PARTENZA");
  });

  it("detailLines non contiene 'Pickup:' due volte", () => {
    const display = getPianoServiceDisplay(makePartenza(), hotelLaVilla);
    const pickupLines = display.detailLines.filter((l) => l.toLowerCase().includes("pickup:"));
    // Al massimo una riga con "Pickup:" (quella dell'actionLabel se inclusa in detailLines)
    expect(pickupLines.length).toBeLessThanOrEqual(1);
  });

  it("senza hotel né meeting_point, placeLabel cade su 'Partenza da verificare'", () => {
    const svcNoHotel = makePartenza({ hotel_id: null, meeting_point: null });
    const display = getPianoServiceDisplay(svcNoHotel, undefined);
    expect(display.placeLabel).toBe("Partenza da verificare");
  });
});
