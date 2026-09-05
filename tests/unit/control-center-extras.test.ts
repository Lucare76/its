import { describe, it, expect } from "vitest";
import {
  computeAssignableUnassigned,
  computeWhatsAppFailedForServices,
  evaluatePendingAgencyApprovals,
  evaluatePendingCancellationRequests,
  WHATSAPP_CONTROL_CENTER_KIND,
} from "@/lib/server/control-center-extras";

describe("control-center-extras — funzioni pure", () => {
  describe("computeAssignableUnassigned", () => {
    it("sottrae dal set assignable i service_id che hanno già un driver_user_id in assignments", () => {
      const stops = [
        {
          services: [
            { service_id: "s1", customer_name: "Rossi", operational_time: "09:00", pax: 2 },
            { service_id: "s2", customer_name: "Bianchi", operational_time: "09:30", pax: 4 },
          ],
        },
        { services: [{ service_id: "s3", customer_name: "Verdi", operational_time: "10:00", pax: 1 }] },
      ] as never;

      const result = computeAssignableUnassigned(stops, new Set(["s2"]));

      expect(result.assignable_count).toBe(3);
      expect(result.assignable_unassigned_count).toBe(2);
      expect(result.assignable_unassigned.map((s) => s.service_id).sort()).toEqual(["s1", "s3"]);
    });

    it("se tutti i servizi assegnabili hanno già un autista, il conteggio è zero (non tutto il pool)", () => {
      const stops = [{ services: [{ service_id: "s1", customer_name: null, operational_time: null, pax: null }] }] as never;
      const result = computeAssignableUnassigned(stops, new Set(["s1"]));
      expect(result.assignable_count).toBe(1);
      expect(result.assignable_unassigned_count).toBe(0);
      expect(result.assignable_unassigned).toEqual([]);
    });

    it("stops vuoti → tutto zero", () => {
      const result = computeAssignableUnassigned([], new Set());
      expect(result).toEqual({ assignable_count: 0, assignable_unassigned_count: 0, assignable_unassigned: [] });
    });
  });

  describe("evaluatePendingAgencyApprovals", () => {
    it("conta solo approval_status='pending_operator', ignora confirmed/rejected", () => {
      const services = [
        { id: "a", customer_name: "Agenzia A", date: "2026-09-10", created_at: "2026-09-05T08:00:00Z", approval_status: "pending_operator" },
        { id: "b", customer_name: "Agenzia B", date: "2026-09-11", created_at: "2026-09-05T09:00:00Z", approval_status: "confirmed" },
        { id: "c", customer_name: "Agenzia C", date: "2026-09-12", created_at: "2026-09-05T10:00:00Z", approval_status: "rejected" },
      ];
      const result = evaluatePendingAgencyApprovals(services, new Map([["a", "2026-09-07T08:00:00Z"]]));
      expect(result.count).toBe(1);
      expect(result.items).toEqual([
        { service_id: "a", customer_name: "Agenzia A", date: "2026-09-10", created_at: "2026-09-05T08:00:00Z", token_expires_at: "2026-09-07T08:00:00Z" },
      ]);
    });

    it("service_id senza token noto → token_expires_at null (non esplode)", () => {
      const services = [{ id: "x", customer_name: null, date: null, created_at: null, approval_status: "pending_operator" }];
      const result = evaluatePendingAgencyApprovals(services, new Map());
      expect(result.items[0]?.token_expires_at).toBeNull();
    });
  });

  describe("evaluatePendingCancellationRequests", () => {
    it("conta solo pending_review e pending_agency_approval", () => {
      const rows = [
        { id: "r1", service_id: "s1", status: "pending_review", created_at: "2026-09-05T08:00:00Z" },
        { id: "r2", service_id: "s2", status: "pending_agency_approval", created_at: "2026-09-05T08:00:00Z" },
        { id: "r3", service_id: "s3", status: "approved", created_at: "2026-09-05T08:00:00Z" },
        { id: "r4", service_id: "s4", status: "closed", created_at: "2026-09-05T08:00:00Z" },
      ];
      const result = evaluatePendingCancellationRequests(rows);
      expect(result.count).toBe(2);
      expect(result.items.map((i) => i.id).sort()).toEqual(["r1", "r2"]);
    });

    it("nessuna richiesta pendente → count 0, items vuoto", () => {
      const result = evaluatePendingCancellationRequests([{ id: "r1", service_id: "s1", status: "approved", created_at: null }]);
      expect(result).toEqual({ count: 0, items: [] });
    });
  });

  describe("computeWhatsAppFailedForServices — solo failed/error, mai sent/queued/pending", () => {
    it("status 'failed' esplicito → contato come fallito", () => {
      const events = [{ service_id: "s1", status: "failed", happened_at: "2026-09-05T09:00:00Z", to_phone: "+390000000", template: "info_3d_it" }];
      const result = computeWhatsAppFailedForServices(events);
      expect(result.count).toBe(1);
      expect(result.items[0]?.service_id).toBe("s1");
    });

    it("status 'error' (alias di failed) → contato come fallito", () => {
      const events = [{ service_id: "s1", status: "error", happened_at: "2026-09-05T09:00:00Z", to_phone: null, template: null }];
      expect(computeWhatsAppFailedForServices(events).count).toBe(1);
    });

    it.each(["sent", "queued", "pending"])("status '%s' NON è mai contato come fallito", (status) => {
      const events = [{ service_id: "s1", status, happened_at: "2026-09-05T09:00:00Z", to_phone: null, template: null }];
      const result = computeWhatsAppFailedForServices(events);
      expect(result.count).toBe(0);
      expect(result.items).toEqual([]);
    });

    it("l'assenza di un evento 'delivered' non genera un fallimento implicito (nessun evento → nessun fallito)", () => {
      expect(computeWhatsAppFailedForServices([]).count).toBe(0);
    });

    it("tiene solo lo stato più recente per servizio: un 'failed' seguito da un 'delivered' più recente NON conta come fallito", () => {
      const events = [
        { service_id: "s1", status: "failed", happened_at: "2026-09-05T09:00:00Z", to_phone: null, template: null },
        { service_id: "s1", status: "delivered", happened_at: "2026-09-05T09:05:00Z", to_phone: null, template: null },
      ];
      expect(computeWhatsAppFailedForServices(events).count).toBe(0);
    });

    it("un 'sent' seguito da un 'failed' più recente per lo stesso servizio conta come fallito", () => {
      const events = [
        { service_id: "s1", status: "sent", happened_at: "2026-09-05T09:00:00Z", to_phone: null, template: null },
        { service_id: "s1", status: "failed", happened_at: "2026-09-05T09:05:00Z", to_phone: null, template: null },
      ];
      expect(computeWhatsAppFailedForServices(events).count).toBe(1);
    });

    it("eventi senza service_id vengono ignorati (mai un fallimento non attribuibile)", () => {
      const events = [{ service_id: null, status: "failed", happened_at: "2026-09-05T09:00:00Z", to_phone: null, template: null }];
      expect(computeWhatsAppFailedForServices(events).count).toBe(0);
    });

    it("WHATSAPP_CONTROL_CENTER_KIND è 'info_3d' (unico kind attivo/joinabile verificato in audit)", () => {
      expect(WHATSAPP_CONTROL_CENTER_KIND).toBe("info_3d");
    });
  });
});
