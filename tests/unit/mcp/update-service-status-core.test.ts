import { describe, it, expect } from "vitest";
import {
  checkStatusTransitionAllowed,
  updateServiceStatusCore,
  MCP_SETTABLE_STATUSES,
  ALL_SERVICE_STATUSES,
  serviceLacksAssignmentWarningApplicable,
} from "@/lib/server/update-service-status-core";

/**
 * MCP Sprint 3 — FASE 23. State machine reale derivata dall'audit (nessuno
 * stato/transizione inventato): 8 stati impostabili tramite questo core
 * (new/assigned/partito/arrivato/caricato/scaricato/completato/problema),
 * 2 stati terminali (completato/cancelled — nessuna route trovata
 * nell'audit transiziona MAI fuori da questi due), 3 stati esclusi come
 * target diretto (pending_cancellation/cancelled: workflow di cancellazione
 * dedicato con side effect propri; needs_review: pipeline di import).
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

function makeFakeAdmin(seedServices: Row[], seedStatusEvents: Row[] = []) {
  const services: Row[] = [...seedServices];
  const statusEvents: Row[] = [...seedStatusEvents];
  const calls = { serviceUpdates: 0, statusEventUpserts: 0 };

  const admin = {
    from(table: string) {
      if (table === "services") {
        return {
          select() {
            let filtered = services;
            const builder = {
              eq(field: string, value: unknown) {
                filtered = filtered.filter((r) => r[field] === value);
                return builder;
              },
              maybeSingle() {
                return Promise.resolve({ data: filtered[0] ? { ...filtered[0] } : null, error: null });
              },
            };
            return builder;
          },
          update(payload: Row) {
            calls.serviceUpdates++;
            let filtered = services;
            const builder = {
              eq(field: string, value: unknown) {
                filtered = filtered.filter((r) => r[field] === value);
                return builder;
              },
              select(_cols?: string) {
                for (const row of filtered) Object.assign(row, payload);
                return Promise.resolve({ data: filtered.map((r) => ({ id: r.id })), error: null });
              },
            };
            return builder;
          },
        };
      }
      if (table === "status_events") {
        return {
          upsert(row: Row, _opts?: unknown) {
            calls.statusEventUpserts++;
            const key = `${row.tenant_id}:${row.service_id}:${row.status}`;
            const exists = statusEvents.some((e) => `${e.tenant_id}:${e.service_id}:${e.status}` === key);
            if (!exists) statusEvents.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return { admin, services, statusEvents, calls };
}

describe("checkStatusTransitionAllowed — state machine", () => {
  it("1. transizione valida (new -> assigned) consentita", () => {
    expect(checkStatusTransitionAllowed("new", "assigned")).toEqual({ allowed: true });
  });

  it("2/3. targetStatus non impostabile (pending_cancellation/cancelled/needs_review) -> TARGET_STATUS_NOT_SETTABLE", () => {
    for (const target of ["pending_cancellation", "cancelled", "needs_review"] as const) {
      const result = checkStatusTransitionAllowed("new", target);
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.code).toBe("TARGET_STATUS_NOT_SETTABLE");
    }
  });

  it("6. stato terminale (completato) come origine -> SERVICE_STATUS_TERMINAL", () => {
    const result = checkStatusTransitionAllowed("completato", "partito");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("SERVICE_STATUS_TERMINAL");
  });

  it("6. stato terminale (cancelled) come origine -> SERVICE_STATUS_TERMINAL", () => {
    const result = checkStatusTransitionAllowed("cancelled", "new");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("SERVICE_STATUS_TERMINAL");
  });

  it("4. stato uguale (self-transition) e' sempre consentito, anche su stato terminale (idempotenza)", () => {
    expect(checkStatusTransitionAllowed("assigned", "assigned")).toEqual({ allowed: true });
    expect(checkStatusTransitionAllowed("completato", "completato")).toEqual({ allowed: true });
  });

  it("nessuna restrizione di origine per gli 8 stati impostabili (comportamento reale osservato: driver-status/route.ts non verifica l'origine)", () => {
    for (const origin of MCP_SETTABLE_STATUSES) {
      for (const target of MCP_SETTABLE_STATUSES) {
        if (TERMINAL(origin) && origin !== target) continue;
        expect(checkStatusTransitionAllowed(origin, target)).toEqual({ allowed: true });
      }
    }
    function TERMINAL(s: string) {
      return s === "completato" || s === "cancelled";
    }
  });
});

describe("serviceLacksAssignmentWarningApplicable", () => {
  it("applicabile solo agli stati di percorso operativo", () => {
    expect(serviceLacksAssignmentWarningApplicable("partito")).toBe(true);
    expect(serviceLacksAssignmentWarningApplicable("arrivato")).toBe(true);
    expect(serviceLacksAssignmentWarningApplicable("caricato")).toBe(true);
    expect(serviceLacksAssignmentWarningApplicable("scaricato")).toBe(true);
    expect(serviceLacksAssignmentWarningApplicable("completato")).toBe(true);
    expect(serviceLacksAssignmentWarningApplicable("new")).toBe(false);
    expect(serviceLacksAssignmentWarningApplicable("assigned")).toBe(false);
    expect(serviceLacksAssignmentWarningApplicable("problema")).toBe(false);
  });
});

describe("ALL_SERVICE_STATUSES / MCP_SETTABLE_STATUSES contract", () => {
  it("MCP_SETTABLE_STATUSES e' un sottoinsieme di ALL_SERVICE_STATUSES", () => {
    for (const status of MCP_SETTABLE_STATUSES) {
      expect((ALL_SERVICE_STATUSES as readonly string[])).toContain(status);
    }
  });

  it("ALL_SERVICE_STATUSES ha esattamente gli 11 valori reali dell'enum (lib/types.ts)", () => {
    expect([...ALL_SERVICE_STATUSES].sort()).toEqual(
      [
        "needs_review", "new", "assigned", "partito", "arrivato", "caricato",
        "scaricato", "completato", "problema", "cancelled", "pending_cancellation",
      ].sort()
    );
  });

  it("'attesa' (valore bug di driver-status/route.ts) non e' un valore reale", () => {
    expect((ALL_SERVICE_STATUSES as readonly string[])).not.toContain("attesa");
  });
});

describe("updateServiceStatusCore — write path", () => {
  function baseService(overrides: Row = {}): Row {
    return { id: SERVICE_A, tenant_id: TENANT_A, status: "new", ...overrides };
  }

  it("1/2. update riuscito: services.status aggiornato, status_event scritto", async () => {
    const fake = makeFakeAdmin([baseService()]);
    const result = await updateServiceStatusCore(fake.admin as never, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_A,
      targetStatus: "assigned",
      expectedCurrentStatus: "new",
    });
    expect(result.status).toBe(200);
    expect(result.body.no_op).toBe(false);
    expect(fake.services[0].status).toBe("assigned");
    expect(fake.statusEvents).toHaveLength(1);
    expect(fake.statusEvents[0]).toMatchObject({ tenant_id: TENANT_A, service_id: SERVICE_A, status: "assigned", by_user_id: "user-1" });
  });

  it("3. no-op (stato gia' uguale): update comunque eseguito, status_event non duplicato se gia' presente", async () => {
    const fake = makeFakeAdmin(
      [baseService({ status: "assigned" })],
      [{ tenant_id: TENANT_A, service_id: SERVICE_A, status: "assigned" }]
    );
    const result = await updateServiceStatusCore(fake.admin as never, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_A,
      targetStatus: "assigned",
      expectedCurrentStatus: "assigned",
    });
    expect(result.status).toBe(200);
    expect(result.body.no_op).toBe(true);
    expect(fake.statusEvents).toHaveLength(1); // no duplicate
  });

  it("5. servizio non trovato -> 404 SERVICE_NOT_FOUND", async () => {
    const fake = makeFakeAdmin([]);
    const result = await updateServiceStatusCore(fake.admin as never, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_A,
      targetStatus: "assigned",
    });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe("SERVICE_NOT_FOUND");
  });

  it("5. servizio di un altro tenant -> 404 (tenant isolation)", async () => {
    const fake = makeFakeAdmin([baseService({ tenant_id: TENANT_B })]);
    const result = await updateServiceStatusCore(fake.admin as never, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_A,
      targetStatus: "assigned",
    });
    expect(result.status).toBe(404);
  });

  it("6. stato terminale -> 409 SERVICE_STATUS_TERMINAL, nessuna scrittura", async () => {
    const fake = makeFakeAdmin([baseService({ status: "completato" })]);
    const result = await updateServiceStatusCore(fake.admin as never, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_A,
      targetStatus: "partito",
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("SERVICE_STATUS_TERMINAL");
    expect(fake.calls.serviceUpdates).toBe(0);
    expect(fake.statusEvents).toHaveLength(0);
  });

  it("7. race/stale: expectedCurrentStatus diverso dallo stato live (ora terminale) -> 409 SERVICE_STATUS_TERMINAL, la rivalidazione usa sempre lo stato vero", async () => {
    // Due operatori concorrenti: A ha visto "assigned" in preview, ma nel
    // frattempo il servizio e' gia' passato a "cancelled".
    const fake = makeFakeAdmin([baseService({ status: "cancelled" })]);
    const result = await updateServiceStatusCore(fake.admin as never, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_A,
      targetStatus: "partito",
      expectedCurrentStatus: "assigned",
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("SERVICE_STATUS_TERMINAL");
  });

  it("7. race/stale con stato live NON terminale ma diverso dallo snapshot atteso -> STATUS_STALE, nessuna scrittura", async () => {
    const fake = makeFakeAdmin([baseService({ status: "problema" })]);
    const result = await updateServiceStatusCore(fake.admin as never, {
      tenantId: TENANT_A,
      userId: "user-1",
      serviceId: SERVICE_A,
      targetStatus: "partito",
      expectedCurrentStatus: "assigned",
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("STATUS_STALE");
    expect(fake.services[0].status).toBe("problema"); // unchanged
    expect(fake.statusEvents).toHaveLength(0);
  });
});
