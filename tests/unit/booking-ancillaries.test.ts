import { describe, expect, it } from "vitest";
import { agencyBookingCreateSchema } from "@/lib/validation";
import { appendBookingAncillaryNotes, buildBookingAncillaryDetails } from "@/lib/booking-ancillaries";

describe("booking ancillaries", () => {
  it("appende infant e animali alle note operative", () => {
    const notes = appendBookingAncillaryNotes("Nota base", {
      infant_count: 2,
      pet_count: 1,
      pet_notes: "cane 6 kg nel trasportino"
    });

    expect(notes).toContain("Nota base");
    expect(notes).toContain("Infant 0-1,99 anni: 2");
    expect(notes).toContain("EUR 2.50 cad.");
    expect(notes).toContain("Animali piccola taglia max 10 kg: 1");
    expect(notes).toContain("Biglietto animale a cura del cliente in biglietteria");
  });

  it("calcola quota infant fissa a 2,50 euro", () => {
    expect(buildBookingAncillaryDetails({ infant_count: 3 })).toMatchObject({
      infant_count: 3,
      infant_unit_price_cents: 250,
      infant_total_price_cents: 750
    });
  });

  it("richiede note animali se pet_count e maggiore di zero", () => {
    const result = agencyBookingCreateSchema.safeParse({
      customer_first_name: "Mario",
      customer_last_name: "Rossi",
      customer_phone: "3331234567",
      pax: 2,
      infant_count: 0,
      pet_count: 1,
      pet_notes: "",
      hotel_id: "11111111-1111-4111-8111-111111111111",
      booking_service_kind: "transfer_port_hotel",
      arrival_date: "2026-06-01",
      arrival_time: "12:00",
      departure_date: "2026-06-02",
      departure_time: "12:00",
      notes: ""
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "pet_notes")).toBe(true);
    }
  });
});
