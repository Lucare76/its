import { describe, expect, it } from "vitest";
import { agencyBookingCreateSchema, agencyBookingServiceKindSchema, requiresAgencyBookingNotes } from "@/lib/validation";

const base = {
  customer_first_name: "Mario", customer_last_name: "Rossi", customer_phone: "3331234567", pax: 2,
  hotel_id: "11111111-1111-4111-8111-111111111111",
  arrival_date: "2026-11-01", arrival_time: "12:00", departure_date: "2026-11-08", departure_time: "14:00",
  transport_code: "FR1234", transport_code_return: "FR5678", bus_city_origin: "Milano", excursion_title: "Giro isola", notes: ""
};
describe("agency booking operational notes", () => {
  it.each(["", "   ", "\n\t"])("rejects blank notes for a plain port/hotel transfer", notes => {
    const result = agencyBookingCreateSchema.safeParse({ ...base, booking_service_kind: "transfer_port_hotel", notes });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === "notes")).toBe(true);
  });
  it("accepts a plain transfer with an operational note", () => {
    expect(agencyBookingCreateSchema.safeParse({ ...base, booking_service_kind: "transfer_port_hotel", notes: "Prelievo in hotel per porto Ischia" }).success).toBe(true);
  });
  it.each(agencyBookingServiceKindSchema.options.filter(kind => kind !== "transfer_port_hotel"))("allows optional notes for %s", kind => {
    expect(requiresAgencyBookingNotes(kind)).toBe(false);
    expect(agencyBookingCreateSchema.safeParse({ ...base, booking_service_kind: kind }).success).toBe(true);
    expect(agencyBookingCreateSchema.safeParse({ ...base, booking_service_kind: kind, notes: undefined }).success).toBe(true);
  });
});
