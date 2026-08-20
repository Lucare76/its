import { describe, expect, it } from "vitest";
import {
  resolveMedmarCardCompact,
  isMedmarDeliveryRetryButtonVisible,
  MEDMAR_DELIVERY_AUTO_RETRY_STATUSES,
  MEDMAR_DELIVERY_LIST_NON_ACTIONABLE_STATUSES,
} from "@/lib/medmar-delivery-card";

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

describe("costanti esportate coerenti con l'engine server-side", () => {
  it("MEDMAR_DELIVERY_AUTO_RETRY_STATUSES contiene esattamente awaiting_pdf e pdf_not_found", () => {
    expect([...MEDMAR_DELIVERY_AUTO_RETRY_STATUSES].sort()).toEqual(["awaiting_pdf", "pdf_not_found"]);
  });

  it("MEDMAR_DELIVERY_LIST_NON_ACTIONABLE_STATUSES non include mai gli stati ritentabili", () => {
    for (const s of MEDMAR_DELIVERY_AUTO_RETRY_STATUSES) {
      expect(MEDMAR_DELIVERY_LIST_NON_ACTIONABLE_STATUSES.has(s)).toBe(false);
    }
  });
});
