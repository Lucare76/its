import { expect, it } from "vitest";
import { medmarPassengerSummary } from "@/lib/medmar-passenger-summary";
import { agencyBookingCreateSchema } from "@/lib/validation";
import { buildBookingAncillaryDetails } from "@/lib/booking-ancillaries";
import { resolvePassengerComposition } from "@/lib/server/medmar-booking/passenger-composition";
it("preserves 5 adults and 4 children from agency validation through stored details to Medmar", () => {
 const booking = agencyBookingCreateSchema.parse({booking_service_kind:"formula_medmar_pozzuoli",customer_first_name:"Test",customer_last_name:"Composizione",customer_phone:"3331234567",hotel_id:"11111111-1111-4111-8111-111111111111",arrival_date:"2026-12-31",arrival_time:"09:40",departure_date:"2027-01-03",departure_time:"11:10",pax:9,medmar_adult_count:5,medmar_child_count:4,medmar_infant_count:0});
 const ferry_details=buildBookingAncillaryDetails(booking);
 expect(resolvePassengerComposition([{pax:booking.pax,ferry_details}])).toEqual({adults:5,children:4,infants:0,source:"medmar_counts"});
 expect(medmarPassengerSummary(ferry_details,9)).toBe("5 adulti (12+) · 4 bambini (4–11 anni) · 0 bambini (0–3 anni)");
});
it.each([undefined,{}, {medmar_adult_count:9}, {medmar_adult_count:5,medmar_child_count:3,medmar_infant_count:0}, {medmar_adult_count:5,medmar_child_count:"4",medmar_infant_count:0}])("does not invent age categories for absent or invalid details",details=>{expect(medmarPassengerSummary(details,9)).toContain("da verificare");});
