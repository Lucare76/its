import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMedmarDeliveryConfig } from "@/lib/server/medmar-booking/delivery-config";
import {
  resolveFinalTicketRecipient,
  resolveMedmarDelivery,
  resolveMedmarTechnicalRecipient,
} from "@/lib/server/medmar-booking/recipient-resolver";

const ORIGINAL = process.env.MEDMAR_DELIVERY_EMAIL;

beforeEach(() => {
  delete process.env.MEDMAR_DELIVERY_EMAIL;
});
afterEach(() => {
  process.env.MEDMAR_DELIVERY_EMAIL = ORIGINAL;
});

describe("delivery-config — email tecnica Medmar (Fase 2B.6)", () => {
  it("legge MEDMAR_DELIVERY_EMAIL configurata", () => {
    process.env.MEDMAR_DELIVERY_EMAIL = "info@ischiatransferservice.it";
    expect(getMedmarDeliveryConfig()).toEqual({ technicalEmail: "info@ischiatransferservice.it" });
  });

  it("5. env mancante -> technicalEmail null (fail-closed a valle)", () => {
    expect(getMedmarDeliveryConfig()).toEqual({ technicalEmail: null });
  });

  it("env con solo spazi -> trattata come non configurata", () => {
    process.env.MEDMAR_DELIVERY_EMAIL = "   ";
    expect(getMedmarDeliveryConfig()).toEqual({ technicalEmail: null });
  });
});

describe("resolveMedmarTechnicalRecipient", () => {
  it("configurata -> ok con email tecnica", () => {
    process.env.MEDMAR_DELIVERY_EMAIL = "info@ischiatransferservice.it";
    const result = resolveMedmarTechnicalRecipient();
    expect(result).toEqual({ ok: true, recipient: { type: "technical", email: "info@ischiatransferservice.it" } });
  });

  it("5. mancante -> fail-closed, codice medmar_delivery_email_not_configured", () => {
    const result = resolveMedmarTechnicalRecipient();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("medmar_delivery_email_not_configured");
  });
});

describe("resolveFinalTicketRecipient — destinatario finale ITS", () => {
  it("6. agency + email agenzia presente -> agency vince", () => {
    const result = resolveFinalTicketRecipient({
      agency: { name: "ALESTE VIAGGI", email: "booking@alesteviaggi.test" },
      customerName: "Gerardo D'Addio",
      customerEmail: "gerardo@example.test",
    });
    expect(result).toEqual({ ok: true, recipient: { type: "agency", name: "ALESTE VIAGGI", email: "booking@alesteviaggi.test" } });
  });

  it("7. agency presente ma email agenzia mancante -> fail-closed, agency_recipient_email_missing", () => {
    const result = resolveFinalTicketRecipient({
      agency: { name: "ALESTE VIAGGI", email: null },
      customerName: "Gerardo D'Addio",
      customerEmail: "gerardo@example.test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("agency_recipient_email_missing");
  });

  it("8. agency + email cliente presente -> NESSUN fallback al cliente (agency vince comunque)", () => {
    const result = resolveFinalTicketRecipient({
      agency: { name: "ALESTE VIAGGI", email: "booking@alesteviaggi.test" },
      customerName: "Gerardo D'Addio",
      customerEmail: "gerardo@example.test",
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.recipient.type).toBe("agency");
    expect(result.recipient.email).not.toBe("gerardo@example.test");
  });

  it("9. nessuna agency + email cliente presente -> cliente", () => {
    const result = resolveFinalTicketRecipient({
      agency: null,
      customerName: "Mario Rossi",
      customerEmail: "mario@example.test",
    });
    expect(result).toEqual({ ok: true, recipient: { type: "customer", name: "Mario Rossi", email: "mario@example.test" } });
  });

  it("10. nessuna agency + email cliente mancante -> fail-closed, customer_recipient_email_missing", () => {
    const result = resolveFinalTicketRecipient({ agency: null, customerName: "Mario Rossi", customerEmail: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("customer_recipient_email_missing");
  });
});

describe("resolveMedmarDelivery — caso D'ADDIO / ALESTE VIAGGI (11/12/13)", () => {
  beforeEach(() => {
    process.env.MEDMAR_DELIVERY_EMAIL = "info@ischiatransferservice.it";
  });

  it("11/12/13. ALESTE VIAGGI presente -> final recipient = agency, medmar recipient = email tecnica, final != cliente", () => {
    const result = resolveMedmarDelivery({
      agency: { name: "ALESTE VIAGGI", email: "booking@alesteviaggi.test" },
      customerName: "Gerardo D'Addio",
      customerEmail: "gerardo.daddio@example.test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.medmar_recipient).toEqual({ type: "technical", email: "info@ischiatransferservice.it" });
    expect(result.final_recipient).toEqual({ type: "agency", name: "ALESTE VIAGGI", email: "booking@alesteviaggi.test" });
    expect(result.final_recipient.email).not.toBe("gerardo.daddio@example.test");
  });

  it("1/2/3. customer email diversa e agency email diversa non cambiano MAI il medmar_recipient (email tecnica fissa)", () => {
    const result = resolveMedmarDelivery({
      agency: { name: "ALESTE VIAGGI", email: "booking@alesteviaggi.test" },
      customerName: "Gerardo D'Addio",
      customerEmail: "gerardo.daddio@example.test",
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.medmar_recipient.email).toBe("info@ischiatransferservice.it");
    expect(result.medmar_recipient.email).not.toBe("booking@alesteviaggi.test");
    expect(result.medmar_recipient.email).not.toBe("gerardo.daddio@example.test");
  });
});
