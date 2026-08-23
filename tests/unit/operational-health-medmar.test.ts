import { describe, expect, it } from "vitest";
import {
  evaluateMedmarDeliveryRows,
  MEDMAR_PENDING_WARNING_MS,
  type MedmarDeliveryHealthRow,
} from "@/lib/server/operational-health/medmar-health";

const NOW = new Date("2026-08-22T10:00:00.000Z");

function row(overrides: Partial<MedmarDeliveryHealthRow>): MedmarDeliveryHealthRow {
  return {
    id: "row-1",
    status: "awaiting_pdf",
    created_at: "2026-08-22T09:55:00.000Z",
    updated_at: "2026-08-22T09:55:00.000Z",
    medmar_numero: null,
    last_error_code: null,
    ...overrides,
  };
}

describe("evaluateMedmarDeliveryRows", () => {
  it("5. delivery sana ('delivered') -> nessun segnale", () => {
    const signals = evaluateMedmarDeliveryRows([row({ status: "delivered" })], NOW);
    expect(signals).toEqual([]);
  });

  it("6. delivery pending normale (dentro la finestra di retry) -> info", () => {
    const recentCreatedAt = new Date(NOW.getTime() - 2 * 60_000).toISOString(); // 2 min fa, ben dentro MEDMAR_PENDING_WARNING_MS
    const signals = evaluateMedmarDeliveryRows([row({ id: "p1", status: "awaiting_pdf", created_at: recentCreatedAt })], NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe("info");
    expect(signals[0]!.key).toBe("medmar:delivery_in_progress:p1");
  });

  it("7. delivery problematica (pending oltre la soglia derivata da MAX_ATTEMPTS*MIN_INTERVAL) -> warning", () => {
    const staleCreatedAt = new Date(NOW.getTime() - (MEDMAR_PENDING_WARNING_MS + 60_000)).toISOString();
    const signals = evaluateMedmarDeliveryRows([row({ id: "p2", status: "pdf_not_found", created_at: staleCreatedAt })], NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe("warning");
    expect(signals[0]!.key).toBe("medmar:delivery_pending:p2");
  });

  it("8. failure definitivo (stato non piu' ritentato automaticamente) -> critical", () => {
    const signals = evaluateMedmarDeliveryRows([row({ id: "f1", status: "delivery_failed", medmar_numero: "MED-1" })], NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.severity).toBe("critical");
    expect(signals[0]!.key).toBe("medmar:delivery_failed:f1");
    expect(signals[0]!.entityId).toBe("MED-1");
  });

  it("manual_review (revisione manuale) -> critical, stessa categoria dei fallimenti definitivi", () => {
    const signals = evaluateMedmarDeliveryRows([row({ id: "m1", status: "manual_review" })], NOW);
    expect(signals[0]!.severity).toBe("critical");
  });

  it("delivery_started (sincrono, in corso da poco) -> info, non critical", () => {
    const signals = evaluateMedmarDeliveryRows([row({ id: "d1", status: "delivery_started" })], NOW);
    expect(signals[0]!.severity).toBe("info");
  });

  describe("action (Sprint 4 — collegamento contestuale)", () => {
    it("delivery_failed (critical) -> action verso /biglietti-medmar", () => {
      const signals = evaluateMedmarDeliveryRows([row({ id: "f1", status: "delivery_failed" })], NOW);
      expect(signals[0]!.action).toEqual({ label: "Apri Medmar", href: "/biglietti-medmar" });
    });

    it("delivery_pending (warning) -> action verso /biglietti-medmar", () => {
      const staleCreatedAt = new Date(NOW.getTime() - (MEDMAR_PENDING_WARNING_MS + 60_000)).toISOString();
      const signals = evaluateMedmarDeliveryRows([row({ id: "p2", status: "pdf_not_found", created_at: staleCreatedAt })], NOW);
      expect(signals[0]!.action).toEqual({ label: "Apri Medmar", href: "/biglietti-medmar" });
    });

    it("href e' sempre una route interna (nessun URL esterno, nessun token/secret)", () => {
      const signals = evaluateMedmarDeliveryRows([row({ id: "f2", status: "delivery_failed", medmar_numero: "MED-9" })], NOW);
      const href = signals[0]!.action!.href;
      expect(href.startsWith("/")).toBe(true);
      expect(href).not.toMatch(/^https?:\/\//);
      expect(href).not.toContain("token");
      expect(href).not.toContain("?");
    });
  });
});
