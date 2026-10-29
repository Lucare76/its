import { describe, expect, it } from "vitest";
import { agencyBookingCreateSchema } from "@/lib/validation";
import { buildBookingAncillaryDetails } from "@/lib/booking-ancillaries";
const base = { customer_first_name: "Mario", customer_last_name: "Rossi", customer_phone: "3331234567", pax: 6,
 hotel_id: "11111111-1111-4111-8111-111111111111", arrival_date: "2026-11-01", arrival_time: "12:00", departure_date: "2026-11-08", departure_time: "10:00", notes: "",
 medmar_infant_count: 1, medmar_child_count: 2, medmar_adult_count: 3 };
describe("fasce Medmar agenzia", () => {
 it.each(["formula_medmar_napoli", "formula_medmar_pozzuoli"])("salva conteggi coerenti per %s", booking_service_kind => {
  const parsed = agencyBookingCreateSchema.parse({ ...base, booking_service_kind });
  expect(buildBookingAncillaryDetails(parsed)).toMatchObject({ medmar_infant_count: 1, medmar_child_count: 2, medmar_adult_count: 3, infant_count: 0 });
 });
 it.each([{ pax: 5 }, { medmar_child_count: -1 }, { medmar_adult_count: 1.5 }, { medmar_adult_count: undefined }, { pax: 0, medmar_infant_count: 0, medmar_child_count: 0, medmar_adult_count: 0 }, { pax: 17, medmar_adult_count: 14 }])("rifiuta conteggi incompleti o incoerenti (%s)", change => {
  expect(agencyBookingCreateSchema.safeParse({ ...base, booking_service_kind: "formula_medmar_napoli", ...change }).success).toBe(false);
 });
 it("mantiene compatibili le prenotazioni precedenti senza composizione", () => {
  const { medmar_adult_count: _a, medmar_child_count: _c, medmar_infant_count: _i, ...legacy } = base;
  expect(agencyBookingCreateSchema.safeParse({ ...legacy, booking_service_kind: "formula_medmar_napoli" }).success).toBe(true);
 });
});
