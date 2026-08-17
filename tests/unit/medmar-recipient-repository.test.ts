import { describe, expect, it } from "vitest";
import { loadAgencyRecipient } from "@/lib/server/medmar-booking/recipient-repository";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENCY_ID = "30000000-0000-0000-0000-000000000001";

function fakeAdmin(row: Record<string, unknown> | null) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return this;
            },
            async maybeSingle() {
              return { data: row, error: null };
            },
          };
        },
      };
    },
  } as never;
}

describe("loadAgencyRecipient — priorità email agenzia (Fase 2B.6)", () => {
  it("booking_email presente vince su contact_email e invoice_email diversi (caso ALESTE VIAGGI)", async () => {
    const admin = fakeAdmin({
      name: "ALESTE VIAGGI",
      invoice_email: "fatture@altro.test",
      contact_email: "contatto@altro.test",
      booking_email: "biglietteria@alesteviaggi.it",
      contact_emails: [],
      booking_emails: [],
    });
    const result = await loadAgencyRecipient(admin, TENANT, AGENCY_ID);
    expect(result).toEqual({ name: "ALESTE VIAGGI", email: "biglietteria@alesteviaggi.it" });
  });

  it("booking_email vuoto ma booking_emails[0] presente -> usa l'array booking", async () => {
    const admin = fakeAdmin({
      name: "AGENZIA X",
      invoice_email: "fatture@altro.test",
      contact_email: "contatto@altro.test",
      booking_email: null,
      contact_emails: [],
      booking_emails: ["prenotazioni-array@altro.test"],
    });
    const result = await loadAgencyRecipient(admin, TENANT, AGENCY_ID);
    expect(result?.email).toBe("prenotazioni-array@altro.test");
  });

  it("nessun campo booking -> fallback contact_email", async () => {
    const admin = fakeAdmin({
      name: "AGENZIA Y",
      invoice_email: "fatture@altro.test",
      contact_email: "contatto@altro.test",
      booking_email: null,
      contact_emails: [],
      booking_emails: [],
    });
    const result = await loadAgencyRecipient(admin, TENANT, AGENCY_ID);
    expect(result?.email).toBe("contatto@altro.test");
  });

  it("solo invoice_email presente -> ultimo fallback", async () => {
    const admin = fakeAdmin({
      name: "AGENZIA Z",
      invoice_email: "fatture@altro.test",
      contact_email: null,
      booking_email: null,
      contact_emails: [],
      booking_emails: [],
    });
    const result = await loadAgencyRecipient(admin, TENANT, AGENCY_ID);
    expect(result?.email).toBe("fatture@altro.test");
  });

  it("D'ADDIO/ALESTE reale: invoice_email null, contact_email==booking_email -> risultato invariato ma per il motivo corretto (booking, non invoice)", async () => {
    const admin = fakeAdmin({
      name: "ALESTE VIAGGI",
      invoice_email: null,
      contact_email: "biglietteria@alesteviaggi.it",
      booking_email: "biglietteria@alesteviaggi.it",
      contact_emails: ["prenotazioni@alesteviaggi.it"],
      booking_emails: ["biglietteria@alesteviaggi.it"],
    });
    const result = await loadAgencyRecipient(admin, TENANT, AGENCY_ID);
    expect(result).toEqual({ name: "ALESTE VIAGGI", email: "biglietteria@alesteviaggi.it" });
  });
});
