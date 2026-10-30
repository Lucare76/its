import { beforeEach, expect, it, vi } from "vitest";
import { sendAgencyBookingConfirmationEmail } from "@/lib/server/agency-booking-email";
import { sendOperatorNotifyEmail, sendAgencyConfirmedEmail } from "@/lib/server/agency-approval-email";
import { agencyArrivalLabel, agencyReturnLabel } from "@/lib/agency-booking-time-labels";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/server/send-email", () => ({ sendEmail: send }));
beforeEach(() => { send.mockReset().mockResolvedValue({ok:true}); });
const base = {to:"agency@example.com", customerName:"GIUSEPPINA D'ALESSANDRO", recipientName:"ISCHIA STARS", serviceKindLabel:"Formula MEDMAR Pozzuoli", bookingKind:"formula_medmar_pozzuoli", arrivalDate:"2026-12-31", arrivalTime:"10:40", ferryDepartureTime:"09:40", departureDate:"2027-01-03", departureTime:"11:10", hotelName:"HOTEL CASTIGLIONE VILLAGE", pax:9, notes:"", pendingConfirmation:true};
it("distinguishes receipt from approval and shows both ferry times, passenger and hotel", async () => {
 await sendAgencyBookingConfirmationEmail(base);
 const mail=send.mock.calls[0][0];
 expect(mail.subject).toContain("Richiesta ricevuta");
 expect(mail.subject).not.toContain("Conferma prenotazione");
 for (const body of [mail.html,mail.text]) {
  for (const value of ["ISCHIA STARS", "GIUSEPPINA D'ALESSANDRO", "HOTEL CASTIGLIONE VILLAGE", "Formula MEDMAR Pozzuoli", "Partenza nave da Pozzuoli", "09:40", "Arrivo stimato a Ischia", "10:40", "Partenza nave da Ischia", "11:10"]) expect(body).toContain(value);
 }
 expect(mail.html).not.toContain('color:#ffffff');
 expect(mail.html).not.toContain('Prenotazione confermata');
});
it("keeps ordinary transfer labels without inventing a ferry departure", async () => {
 await sendAgencyBookingConfirmationEmail({...base,bookingKind:"transfer_port_hotel",ferryDepartureTime:null});
 expect(send.mock.calls[0][0].text).not.toContain("Partenza nave");
 expect(agencyArrivalLabel("transfer_port_hotel")).toBe("Arrivo");
 expect(agencyReturnLabel(null)).toBe("Rientro");
});
it("shows the same meaning of arrival in the operator notification and approved email", async () => {
 vi.stubEnv("OPS_NOTIFY_EMAIL", "info@ischiatransferservice.it");
 const details={...base,serviceCtx:{kind:"formula_medmar_pozzuoli" as const},agencyName:"ISCHIA STARS",customerPhone:"",customerEmail:null,serviceId:"test",approvalUrl:"https://example.com/approve"};
 await sendOperatorNotifyEmail(details);
 await sendAgencyConfirmedEmail({...details,priceCents:26200});
 for(const [mail] of send.mock.calls){expect(mail.html).toContain("Arrivo stimato a Ischia");expect(mail.text).toContain("10:40");expect(mail.html).not.toContain("background:linear-gradient(135deg,#0f2744,#1e3a5f)");}
 vi.unstubAllEnvs();
});
