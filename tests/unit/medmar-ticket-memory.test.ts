import { describe, expect, it } from "vitest";
import { parseMedmarTicketText } from "@/lib/medmar-ticket-memory";

describe("parseMedmarTicketText", () => {
  it("preferisce la data viaggio alla data emissione sul formato Medmar fotografato", () => {
    const text = `
      BIGLIETTO Me26IS020029542
      DATA EMISSIONE 27/04/2026
      POZZUOLI - CASAMICCIOLA
      03/05/26
      18:30
      ADULTO - TARIFFA SPECIALE AR
      Booking IS0201026B000152707
      Voucher|054175|
      Totale Biglietto EUR 10.25
      Qnt 1
    `;

    const parsed = parseMedmarTicketText(text);

    expect(parsed.route_code).toBe("pozzuoli_casamicciola");
    expect(parsed.travel_date).toBe("2026-05-03");
    expect(parsed.issue_date).toBe("2026-04-27");
    expect(parsed.departure_time).toBe("18:30");
    expect(parsed.ticket_number).toBe("Me26IS020029542");
    expect(parsed.booking_code).toBe("IS0201026B000152707");
    expect(parsed.voucher_label).toBe("54175");
    expect(parsed.price_cents).toBe(1025);
    expect(parsed.quantity).toBe(1);
  });
});
