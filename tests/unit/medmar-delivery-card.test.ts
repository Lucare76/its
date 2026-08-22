import { describe, expect, it } from "vitest";
import {
  resolveMedmarCardCompact,
  isMedmarDeliveryRetryButtonVisible,
  isMedmarManualFallbackVisible,
  buildDeliveryAttemptIndex,
  lookupDeliveryAttempt,
  resolveMedmarGroupDelivery,
  canResendMedmarTicket,
  MEDMAR_DELIVERY_AUTO_RETRY_STATUSES,
  MEDMAR_DELIVERY_LIST_NON_ACTIONABLE_STATUSES,
} from "@/lib/medmar-delivery-card";

type TestAttempt = { id: string; service_ids: string[]; status: string };

// Fixture ispirate ai casi reali del bug report (id tecnici reali, status/id sintetici).
const SENESE_SVC_1 = "954f789f-ff30-422f-babb-acca1302302d";
const SENESE_SVC_2 = "e4f9fcd3-42b4-476d-b541-fa7249a39163";
const PIETRO_SVC_1 = "20c2c611-d438-4988-acbd-c7f7c33db54f";
const PIETRO_SVC_2 = "f2191285-176d-474b-add4-c2e48b796b29";
const UNRELATED_SVC = "00000000-0000-4000-8000-000000000099";

const SENESE_ATTEMPT: TestAttempt = { id: "attempt-senese", service_ids: [SENESE_SVC_1, SENESE_SVC_2], status: "delivered" };
const PIETRO_ATTEMPT: TestAttempt = { id: "attempt-pietro", service_ids: [PIETRO_SVC_1, PIETRO_SVC_2], status: "delivered" };

describe("resolveMedmarCardCompact — regola card compatta (biglietti-medmar)", () => {
  it("1. attempt 'delivered' -> card compatta", () => {
    expect(resolveMedmarCardCompact({ attemptStatus: "delivered", sentAt: "2026-08-20T09:44:46.866Z" })).toBe(true);
  });

  it("6a. nessun attempt ma medmar_ticket_sent_at valorizzato -> fallback compatto (legacy pre-migrazione)", () => {
    expect(resolveMedmarCardCompact({ attemptStatus: null, sentAt: "2026-08-20T09:44:46.866Z" })).toBe(true);
  });

  it("6b. nessun attempt e nessun medmar_ticket_sent_at -> non compatta", () => {
    expect(resolveMedmarCardCompact({ attemptStatus: null, sentAt: null })).toBe(false);
  });

  it("7/8/9/10. attempt esiste con stato diverso da 'delivered' -> mai compatta, anche se sentAt fosse presente per errore", () => {
    for (const status of ["awaiting_pdf", "pdf_not_found", "delivery_started", "delivery_state_unknown", "pdf_ambiguous", "pdf_validation_failed", "recipient_missing", "delivery_failed", "manual_review"]) {
      expect(resolveMedmarCardCompact({ attemptStatus: status, sentAt: "2026-08-20T09:44:46.866Z" })).toBe(false);
      expect(resolveMedmarCardCompact({ attemptStatus: status, sentAt: null })).toBe(false);
    }
  });

  it("11. nessun attempt, nessun invio -> card normale (da emettere)", () => {
    expect(resolveMedmarCardCompact({ attemptStatus: undefined, sentAt: undefined })).toBe(false);
  });
});

describe("isMedmarDeliveryRetryButtonVisible — pulsante 'Riprova ora' in lista", () => {
  it("mai per 'delivered' (terminale, gia' compattata)", () => {
    expect(isMedmarDeliveryRetryButtonVisible("delivered")).toBe(false);
  });

  it("mai per 'delivery_started' (invio in corso)", () => {
    expect(isMedmarDeliveryRetryButtonVisible("delivery_started")).toBe(false);
  });

  it("mai per 'delivery_state_unknown' (nessun retry automatico su ambiguita')", () => {
    expect(isMedmarDeliveryRetryButtonVisible("delivery_state_unknown")).toBe(false);
  });

  it("mai per 'remote_state_unknown_blocked'", () => {
    expect(isMedmarDeliveryRetryButtonVisible("remote_state_unknown_blocked")).toBe(false);
  });

  it("7. mostrato per 'awaiting_pdf' (fallback manuale sicuro)", () => {
    expect(isMedmarDeliveryRetryButtonVisible("awaiting_pdf")).toBe(true);
  });

  it("8. mostrato per 'pdf_not_found'", () => {
    expect(isMedmarDeliveryRetryButtonVisible("pdf_not_found")).toBe(true);
  });

  it("mostrato per gli stati di revisione manuale/errore (fallback identico al pulsante del modal One Click)", () => {
    for (const status of ["pdf_ambiguous", "pdf_validation_failed", "recipient_missing", "delivery_failed", "manual_review"]) {
      expect(isMedmarDeliveryRetryButtonVisible(status)).toBe(true);
    }
  });
});

describe("isMedmarManualFallbackVisible — fallback 'Invio manuale PDF', mai nel flusso normale", () => {
  it("mai per 'awaiting_pdf'/'pdf_not_found' (auto-retry in corso, flusso normale)", () => {
    expect(isMedmarManualFallbackVisible("awaiting_pdf")).toBe(false);
    expect(isMedmarManualFallbackVisible("pdf_not_found")).toBe(false);
  });

  it("mai per 'delivered' (terminale) o 'delivery_started' (mid-flight)", () => {
    expect(isMedmarManualFallbackVisible("delivered")).toBe(false);
    expect(isMedmarManualFallbackVisible("delivery_started")).toBe(false);
  });

  it("visibile per gli stati di errore/revisione manuale", () => {
    for (const status of ["pdf_ambiguous", "pdf_validation_failed", "recipient_missing", "delivery_failed", "delivery_state_unknown", "manual_review", "remote_state_unknown_blocked"]) {
      expect(isMedmarManualFallbackVisible(status)).toBe(true);
    }
  });
});

describe("costanti esportate coerenti con l'engine server-side", () => {
  it("MEDMAR_DELIVERY_AUTO_RETRY_STATUSES contiene esattamente awaiting_pdf, pdf_found e pdf_not_found", () => {
    expect([...MEDMAR_DELIVERY_AUTO_RETRY_STATUSES].sort()).toEqual(["awaiting_pdf", "pdf_found", "pdf_not_found"]);
  });

  it("MEDMAR_DELIVERY_LIST_NON_ACTIONABLE_STATUSES non include mai gli stati ritentabili", () => {
    for (const s of MEDMAR_DELIVERY_AUTO_RETRY_STATUSES) {
      expect(MEDMAR_DELIVERY_LIST_NON_ACTIONABLE_STATUSES.has(s)).toBe(false);
    }
  });
});

describe("buildDeliveryAttemptIndex / lookupDeliveryAttempt — matching service_ids <-> attempt (bug FASE 2/3)", () => {
  it("indicizza ogni service_id di ogni attempt", () => {
    const index = buildDeliveryAttemptIndex([SENESE_ATTEMPT, PIETRO_ATTEMPT]);
    expect(index.get(SENESE_SVC_1)).toBe(SENESE_ATTEMPT);
    expect(index.get(SENESE_SVC_2)).toBe(SENESE_ATTEMPT);
    expect(index.get(PIETRO_SVC_1)).toBe(PIETRO_ATTEMPT);
    expect(index.get(PIETRO_SVC_2)).toBe(PIETRO_ATTEMPT);
  });

  it("service_id non collegato a nessun attempt -> lookup undefined", () => {
    const index = buildDeliveryAttemptIndex([SENESE_ATTEMPT]);
    expect(lookupDeliveryAttempt(index, [UNRELATED_SVC])).toBeUndefined();
  });

  it("lookup trova l'attempt anche se solo UNO dei service_ids del gruppo combacia", () => {
    const index = buildDeliveryAttemptIndex([SENESE_ATTEMPT]);
    expect(lookupDeliveryAttempt(index, [UNRELATED_SVC, SENESE_SVC_2])).toBe(SENESE_ATTEMPT);
  });

  it("a parita' di service_id vince il primo attempt nell'array in input (ordine deterministico, indipendente da Postgres)", () => {
    const stale: TestAttempt = { id: "attempt-stale", service_ids: [SENESE_SVC_1], status: "pdf_not_found" };
    const fresh: TestAttempt = { id: "attempt-fresh", service_ids: [SENESE_SVC_1], status: "delivered" };
    expect(buildDeliveryAttemptIndex([stale, fresh]).get(SENESE_SVC_1)).toBe(stale);
    expect(buildDeliveryAttemptIndex([fresh, stale]).get(SENESE_SVC_1)).toBe(fresh);
  });
});

describe("hasIssuedAttempt (card biglietti-medmar) — quale pulsante mostra la card, via resolveMedmarGroupDelivery", () => {
  // hasIssuedAttempt in app/(app)/biglietti-medmar/page.tsx e' letteralmente `!!result.attempt`:
  // repo senza jsdom/@testing-library/react (vitest.config.ts usa environment: "node"), quindi la
  // logica di visibilita' pulsanti si verifica sulla regola pura sottostante, stesso pattern del resto del file.

  it("1. nessun attempt, nessun invio -> hasIssuedAttempt=false: la card mostra 'Emetti biglietto Medmar'", () => {
    const result = resolveMedmarGroupDelivery([UNRELATED_SVC], [], null);
    expect(!!result.attempt).toBe(false);
  });

  it("5/6/7. attempt esiste (awaiting_pdf / pdf_not_found / delivery_started) -> hasIssuedAttempt=true: niente pulsanti di emissione, solo stato invio", () => {
    for (const status of ["awaiting_pdf", "pdf_not_found", "delivery_started"]) {
      const attempt: TestAttempt = { id: `attempt-${status}`, service_ids: [SENESE_SVC_1], status };
      const result = resolveMedmarGroupDelivery([SENESE_SVC_1], [attempt], null);
      expect(!!result.attempt).toBe(true);
      expect(result.isCompact).toBe(false); // non e' la card compatta 'delivered', ma comunque niente pulsante di emissione
    }
  });

  it("8. attempt delivered -> card compatta/chiusa, nessun pulsante di emissione (gia' coperto da isCompact ma verificato esplicitamente qui)", () => {
    const attempt: TestAttempt = { id: "attempt-delivered", service_ids: [SENESE_SVC_1], status: "delivered" };
    const result = resolveMedmarGroupDelivery([SENESE_SVC_1], [attempt], null);
    expect(result.isCompact).toBe(true);
  });
});

describe("resolveMedmarGroupDelivery — regola compatta end-to-end (matching + compact rule)", () => {
  it("2. LUCIANO SENESE (736987): attempt delivered con service_ids del gruppo -> compatta", () => {
    const result = resolveMedmarGroupDelivery([SENESE_SVC_1, SENESE_SVC_2], [SENESE_ATTEMPT, PIETRO_ATTEMPT], "2026-08-20T09:44:46.866Z");
    expect(result.isCompact).toBe(true);
    expect(result.attempt).toBe(SENESE_ATTEMPT);
  });

  it("2b. prenotazione 737817 (PIETRO VITO): attempt delivered con service_ids del gruppo -> compatta", () => {
    const result = resolveMedmarGroupDelivery([PIETRO_SVC_1, PIETRO_SVC_2], [SENESE_ATTEMPT, PIETRO_ATTEMPT], "2026-08-20T14:57:57.562Z");
    expect(result.isCompact).toBe(true);
    expect(result.attempt).toBe(PIETRO_ATTEMPT);
  });

  it("3. delivered esiste ma NON e' collegato ai service_ids del gruppo -> non compatta (nessun attempt trovato)", () => {
    const result = resolveMedmarGroupDelivery([UNRELATED_SVC], [SENESE_ATTEMPT, PIETRO_ATTEMPT], null);
    expect(result.isCompact).toBe(false);
    expect(result.attempt).toBeUndefined();
  });

  it("4. nessun attempt collegato ma medmar_ticket_sent_at valorizzato -> fallback compatto", () => {
    const result = resolveMedmarGroupDelivery([UNRELATED_SVC], [SENESE_ATTEMPT], "2026-08-20T09:44:46.866Z");
    expect(result.isCompact).toBe(true);
    expect(result.attempt).toBeUndefined();
  });

  it("5. attempt collegato ma NON delivered vince sempre sul fallback sentAt", () => {
    const pending: TestAttempt = { id: "attempt-pending", service_ids: [SENESE_SVC_1], status: "pdf_not_found" };
    const result = resolveMedmarGroupDelivery([SENESE_SVC_1], [pending], "2026-08-20T09:44:46.866Z");
    expect(result.isCompact).toBe(false);
    expect(result.attempt).toBe(pending);
  });

  it("6. awaiting_pdf -> non compatta", () => {
    const awaiting: TestAttempt = { id: "attempt-awaiting", service_ids: [SENESE_SVC_1], status: "awaiting_pdf" };
    const result = resolveMedmarGroupDelivery([SENESE_SVC_1], [awaiting], null);
    expect(result.isCompact).toBe(false);
  });
});

describe("canResendMedmarTicket — visibilita' pulsante 'Rimanda biglietto' (MVP sicuro)", () => {
  const VALID = {
    status: "delivered",
    recipient_email: "biglietteria@alesteviaggi.it",
    medmar_id_prenotazione: "736987",
    medmar_numero: "AG1908926B000438457",
    pdf_mailbox_message_uid: "uid-1",
  };

  it("1. tutte le precondizioni soddisfatte, status delivered -> true", () => {
    expect(canResendMedmarTicket(VALID)).toBe(true);
  });

  it("2. attempt assente/non emesso -> false", () => {
    expect(canResendMedmarTicket(null)).toBe(false);
    expect(canResendMedmarTicket(undefined)).toBe(false);
  });

  it("3. mai visibile su nessuno stato pending/errore, anche con tutti gli altri campi presenti", () => {
    const statuses = [
      "awaiting_pdf",
      "pdf_found",
      "pdf_cleaned",
      "delivery_started",
      "pdf_not_found",
      "pdf_validation_failed",
      "pdf_ambiguous",
      "recipient_missing",
      "delivery_failed",
      "delivery_state_unknown",
      "manual_review",
      "remote_state_unknown_blocked",
    ];
    for (const status of statuses) {
      expect(canResendMedmarTicket({ ...VALID, status })).toBe(false);
    }
  });

  it("4. recipient_email mancante -> false anche se status e' delivered", () => {
    expect(canResendMedmarTicket({ ...VALID, recipient_email: null })).toBe(false);
  });

  it("5. medmar_id_prenotazione mancante -> false", () => {
    expect(canResendMedmarTicket({ ...VALID, medmar_id_prenotazione: null })).toBe(false);
  });

  it("6. medmar_numero mancante -> false", () => {
    expect(canResendMedmarTicket({ ...VALID, medmar_numero: null })).toBe(false);
  });

  it("7. pdf_mailbox_message_uid mancante -> false", () => {
    expect(canResendMedmarTicket({ ...VALID, pdf_mailbox_message_uid: null })).toBe(false);
  });
});
