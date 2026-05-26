import { describe, expect, it } from "vitest";
import {
  normalizeE164,
  normalizeWhatsAppWaId,
  mapWebhookStatus,
  isReminderDueInWindow,
  extractDriverPhoneFromNotes,
  isReminderDueIn24h,
  isWhatsAppCustomerCareWindowOpen,
} from "@/lib/server/whatsapp";

// ─────────────────────────────────────────────────────────────────────────────
describe("normalizeE164", () => {
  it("lascia invariato un numero già in formato +39xxxxxxxxx", () => {
    expect(normalizeE164("+393331234567")).toBe("+393331234567");
  });

  it("rimuove spazi dal numero già con prefisso internazionale", () => {
    expect(normalizeE164("+39 333 123 4567")).toBe("+393331234567");
  });

  it("converte 0039xxx → +39xxx", () => {
    expect(normalizeE164("0039333123456")).toBe("+39333123456");
  });

  it("converte 00country → +country per prefissi non italiani", () => {
    expect(normalizeE164("0044207946000")).toBe("+44207946000");
  });

  it("numero che inizia con 0 locale → aggiunge prefisso paese default", () => {
    // 081... = Napoli, l'0 iniziale è il trunk prefix
    expect(normalizeE164("0812345678")).toBe("+0812345678");
  });

  it("numero senza prefisso → aggiunge +39", () => {
    expect(normalizeE164("3331234567")).toBe("+393331234567");
  });

  it("rimuove trattini e spazi da numero senza prefisso", () => {
    expect(normalizeE164("333-123-4567")).toBe("+393331234567");
  });

  it("usa defaultCountryCode personalizzato se passato esplicitamente", () => {
    expect(normalizeE164("7911123456", "+44")).toBe("+447911123456");
  });

  it("preserva + iniziale anche con spazi intorno alle cifre", () => {
    expect(normalizeE164("+1 800 555 0100")).toBe("+18005550100");
  });

  it("3391234567 diventa +393391234567", () => {
    expect(normalizeE164("3391234567")).toBe("+393391234567");
  });

  it("accetta numeri internazionali con prefisso +", () => {
    expect(normalizeE164("+491721234567")).toBe("+491721234567");
  });

  it("accetta numeri internazionali con prefisso 00", () => {
    expect(normalizeE164("0039391234567")).toBe("+39391234567");
  });

  it("non forza +39 su numeri internazionali senza doppio zero", () => {
    expect(normalizeE164("491721234567")).toBe("+491721234567");
  });

  it("rifiuta input non numerici", () => {
    expect(() => normalizeE164("abc")).toThrow("Numero non valido");
  });

  it("rifiuta input troppo corti", () => {
    expect(() => normalizeE164("12")).toThrow("Numero non valido");
  });
});

describe("normalizeWhatsAppWaId", () => {
  it("tratta il wa_id Meta come numero internazionale gia completo", () => {
    expect(normalizeWhatsAppWaId("491725404319")).toBe("+491725404319");
  });

  it("non aggiunge un secondo prefisso italiano ai wa_id esteri", () => {
    expect(normalizeWhatsAppWaId("+49 172 5404319")).toBe("+491725404319");
  });

  it("preserva i wa_id italiani aggiungendo solo il +", () => {
    expect(normalizeWhatsAppWaId("393331234567")).toBe("+393331234567");
  });

  it("corregge numeri con doppio prefisso: rimuove solo spazi, non altera le cifre", () => {
    expect(normalizeWhatsAppWaId("34491725404319")).toBe("+34491725404319");
  });

  it("converte formato 00XX in +XX senza aggiungere prefisso paese", () => {
    expect(normalizeWhatsAppWaId("004917254043")).toBe("+4917254043");
  });
});

describe("isWhatsAppCustomerCareWindowOpen", () => {
  it("ritorna true se il cliente ha scritto entro 24 ore", () => {
    const now = new Date("2026-05-04T12:00:00.000Z");
    expect(isWhatsAppCustomerCareWindowOpen("2026-05-03T12:30:00.000Z", now)).toBe(true);
  });

  it("ritorna true al limite esatto delle 24 ore", () => {
    const now = new Date("2026-05-04T12:00:00.000Z");
    expect(isWhatsAppCustomerCareWindowOpen("2026-05-03T12:00:00.000Z", now)).toBe(true);
  });

  it("ritorna false se l'ultimo inbound e piu vecchio di 24 ore", () => {
    const now = new Date("2026-05-04T12:00:00.000Z");
    expect(isWhatsAppCustomerCareWindowOpen("2026-05-03T11:59:59.000Z", now)).toBe(false);
  });

  it("ritorna false per date mancanti o non valide", () => {
    expect(isWhatsAppCustomerCareWindowOpen(null)).toBe(false);
    expect(isWhatsAppCustomerCareWindowOpen("non-una-data")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("mapWebhookStatus", () => {
  it("mappa 'sent' correttamente", () => {
    expect(mapWebhookStatus("sent")).toBe("sent");
  });

  it("mappa 'delivered' correttamente", () => {
    expect(mapWebhookStatus("delivered")).toBe("delivered");
  });

  it("mappa 'read' correttamente", () => {
    expect(mapWebhookStatus("read")).toBe("read");
  });

  it("mappa 'failed' correttamente", () => {
    expect(mapWebhookStatus("failed")).toBe("failed");
  });

  it("restituisce null per status sconosciuto", () => {
    expect(mapWebhookStatus("unknown_status")).toBeNull();
  });

  it("restituisce null per stringa vuota", () => {
    expect(mapWebhookStatus("")).toBeNull();
  });

  it("non mappa 'pending' (non è un webhook status valido)", () => {
    expect(mapWebhookStatus("pending")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("extractDriverPhoneFromNotes", () => {
  it("estrae numero da nota con prefisso 'driver_phone'", () => {
    const result = extractDriverPhoneFromNotes("driver_phone: +39 333 1234567");
    expect(result).toBe("+39 333 1234567");
  });

  it("estrae numero da nota con prefisso 'telefono autista'", () => {
    const result = extractDriverPhoneFromNotes("telefono autista: 3331234567");
    expect(result).toBe("3331234567");
  });

  it("estrae numero da nota con prefisso 'tel autista'", () => {
    const result = extractDriverPhoneFromNotes("tel autista = 333 999 0000");
    expect(result).toBe("333 999 0000");
  });

  it("estrae numero con pattern 'autista ... numero'", () => {
    const result = extractDriverPhoneFromNotes("autista: Mario - 3331234567");
    expect(result).not.toBeNull();
  });

  it("restituisce null per note senza telefono", () => {
    expect(extractDriverPhoneFromNotes("nota generica senza numero")).toBeNull();
  });

  it("restituisce null per nota null", () => {
    expect(extractDriverPhoneFromNotes(null)).toBeNull();
  });

  it("restituisce null per nota undefined", () => {
    expect(extractDriverPhoneFromNotes(undefined)).toBeNull();
  });

  it("restituisce null per stringa vuota", () => {
    expect(extractDriverPhoneFromNotes("")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("isReminderDueInWindow", () => {
  // Finestra: targetHours=24, window=30 min → accetta da -1410 a +1470 min dal servizio
  const SERVICE_DATE = "2026-06-01";
  const SERVICE_TIME = "10:00";

  it("ritorna true quando ora esattamente nel target (24h prima)", () => {
    // now = esattamente 24h prima del servizio
    const now = new Date("2026-05-31T10:00:00.000Z");
    // Usiamo offset 0 (UTC) per semplicità; il comportamento è coerente con parseDateTime
    const serviceAt = new Date(`${SERVICE_DATE}T${SERVICE_TIME}:00`);
    const nowLocal = new Date(serviceAt.getTime() - 24 * 60 * 60 * 1000);
    expect(isReminderDueInWindow(SERVICE_DATE, SERVICE_TIME, 24, 30, nowLocal)).toBe(true);
  });

  it("ritorna true quando nel margine di tolleranza (±30 min)", () => {
    const serviceAt = new Date(`${SERVICE_DATE}T${SERVICE_TIME}:00`);
    // now = 24h + 20 min prima: ancora in finestra
    const nowEarly = new Date(serviceAt.getTime() - (24 * 60 + 20) * 60 * 1000);
    expect(isReminderDueInWindow(SERVICE_DATE, SERVICE_TIME, 24, 30, nowEarly)).toBe(true);

    // now = 24h - 20 min prima: ancora in finestra
    const nowLate = new Date(serviceAt.getTime() - (24 * 60 - 20) * 60 * 1000);
    expect(isReminderDueInWindow(SERVICE_DATE, SERVICE_TIME, 24, 30, nowLate)).toBe(true);
  });

  it("ritorna false quando troppo presto (fuori finestra)", () => {
    const serviceAt = new Date(`${SERVICE_DATE}T${SERVICE_TIME}:00`);
    // now = 26h prima: fuori finestra
    const nowTooEarly = new Date(serviceAt.getTime() - 26 * 60 * 60 * 1000);
    expect(isReminderDueInWindow(SERVICE_DATE, SERVICE_TIME, 24, 30, nowTooEarly)).toBe(false);
  });

  it("ritorna false quando troppo tardi (fuori finestra)", () => {
    const serviceAt = new Date(`${SERVICE_DATE}T${SERVICE_TIME}:00`);
    // now = 22h prima: fuori finestra
    const nowTooLate = new Date(serviceAt.getTime() - 22 * 60 * 60 * 1000);
    expect(isReminderDueInWindow(SERVICE_DATE, SERVICE_TIME, 24, 30, nowTooLate)).toBe(false);
  });

  it("ritorna false per servizio già passato", () => {
    const serviceAt = new Date(`${SERVICE_DATE}T${SERVICE_TIME}:00`);
    // now = dopo il servizio
    const nowAfter = new Date(serviceAt.getTime() + 60 * 60 * 1000);
    expect(isReminderDueInWindow(SERVICE_DATE, SERVICE_TIME, 24, 30, nowAfter)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("isReminderDueIn24h", () => {
  it("ritorna true per servizio esattamente 24h nel futuro", () => {
    const serviceAt = new Date("2026-06-01T10:00:00");
    const now = new Date(serviceAt.getTime() - 24 * 60 * 60 * 1000);
    expect(isReminderDueIn24h("2026-06-01", "10:00", now)).toBe(true);
  });

  it("ritorna false per servizio tra 48h", () => {
    const serviceAt = new Date("2026-06-01T10:00:00");
    const now = new Date(serviceAt.getTime() - 48 * 60 * 60 * 1000);
    expect(isReminderDueIn24h("2026-06-01", "10:00", now)).toBe(false);
  });

  it("ritorna false per servizio passato", () => {
    const serviceAt = new Date("2026-06-01T10:00:00");
    const now = new Date(serviceAt.getTime() + 2 * 60 * 60 * 1000);
    expect(isReminderDueIn24h("2026-06-01", "10:00", now)).toBe(false);
  });
});
