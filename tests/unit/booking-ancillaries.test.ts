import { describe, expect, it } from "vitest";
import { agencyBookingCreateSchema } from "@/lib/validation";
import { buildBookingAncillaryDetails } from "@/lib/booking-ancillaries";

describe("booking ancillaries", () => {
  it("il breakdown infant/medmar/animali resta solo nei campi strutturati, mai in notes", () => {
    const details = buildBookingAncillaryDetails({
      infant_count: 2,
      medmar_infant_count: 1,
      medmar_child_count: 0,
      medmar_adult_count: 3,
      pet_count: 1,
      pet_notes: "cane 6 kg nel trasportino"
    });

    expect(details).toMatchObject({
      infant_count: 2,
      medmar_infant_count: 1,
      medmar_child_count: 0,
      medmar_adult_count: 3,
      pet_count: 1,
      pet_notes: "cane 6 kg nel trasportino"
    });
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
