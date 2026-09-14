import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  recordServiceAuditEvent,
  recordServiceAuditEventsBatch,
  resolveOperatorNameByUserId,
  sanitizeAuditData,
  SERVICE_AUDIT_EVENT_TYPES,
  SERVICE_AUDIT_SOURCES,
} from "@/lib/server/service-audit-events";

/**
 * Write helper (gap A-F) + sanitizer + migration 0278 source-contract
 * (append-only, service_id sopravvive all'hard-delete — sezioni 2/7/11/14).
 */

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

describe("sanitizeAuditData — no secret leakage (Fase 8/11)", () => {
  it("rimuove chiavi che matchano il deny-pattern (token/secret/password/signed_url/payload/...)", () => {
    const out = sanitizeAuditData({
      token: "abc",
      access_token: "def",
      api_key: "ghi",
      password: "jkl",
      authorization: "Bearer xyz",
      signed_url: "https://...",
      signature: "sig",
      payload: { raw: true },
      file_content: "base64...",
      document_content: "text",
      status: "new", // campo lecito, deve sopravvivere
    });
    expect(out).toEqual({ status: "new" });
  });

  it("ritorna null se l'input è null/undefined o se resta vuoto dopo la sanitizzazione", () => {
    expect(sanitizeAuditData(null)).toBeNull();
    expect(sanitizeAuditData(undefined)).toBeNull();
    expect(sanitizeAuditData({ token: "x" })).toBeNull();
  });

  it("preserva campi legittimi intatti (valori, non solo chiavi)", () => {
    expect(sanitizeAuditData({ driver_user_id: "u1", pax: 4 })).toEqual({ driver_user_id: "u1", pax: 4 });
  });
});

function fakeAdmin(insertResult: { error: { message: string } | null } = { error: null }) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    admin: {
      from(table: string) {
        if (table !== "service_audit_events") throw new Error(`tabella inattesa: ${table}`);
        return {
          insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
            calls.push(...(Array.isArray(rows) ? rows : [rows]));
            return Promise.resolve(insertResult);
          },
        };
      },
    },
  };
}

describe("recordServiceAuditEvent — scrittura best-effort", () => {
  it("scrive tutti i campi attesi con i default corretti", async () => {
    const { admin, calls } = fakeAdmin();
    await recordServiceAuditEvent(admin as never, {
      tenantId: "t1",
      serviceId: "s1",
      eventType: SERVICE_AUDIT_EVENT_TYPES.SERVICE_RESTORED,
      source: SERVICE_AUDIT_SOURCES.MANUAL,
      actorUserId: "u1",
      actorName: "Mario Rossi",
      reason: "test",
      newData: { status: "new" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tenant_id: "t1",
      service_id: "s1",
      booking_id: null,
      event_type: "service_restored",
      source: "manual",
      actor_user_id: "u1",
      actor_name: "Mario Rossi",
      reason: "test",
      new_data: { status: "new" },
      old_data: null,
      metadata: null,
    });
  });

  it("un errore DB nell'insert non lancia mai un'eccezione (best-effort)", async () => {
    const { admin } = fakeAdmin({ error: { message: "insert rifiutato" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      recordServiceAuditEvent(admin as never, {
        tenantId: "t1",
        serviceId: "s1",
        eventType: SERVICE_AUDIT_EVENT_TYPES.DRIVER_REMOVED,
        source: SERVICE_AUDIT_SOURCES.MANUAL,
      })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("un client che lancia sincronicamente non fa mai fallire il chiamante", async () => {
    const brokenAdmin = { from: () => { throw new Error("client rotto"); } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      recordServiceAuditEvent(brokenAdmin as never, {
        tenantId: "t1",
        serviceId: "s1",
        eventType: SERVICE_AUDIT_EVENT_TYPES.VEHICLE_REMOVED,
        source: SERVICE_AUDIT_SOURCES.MANUAL,
      })
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("old_data/new_data/metadata passano dal sanitizer (mai un secret salvato)", async () => {
    const { admin, calls } = fakeAdmin();
    await recordServiceAuditEvent(admin as never, {
      tenantId: "t1",
      serviceId: "s1",
      eventType: SERVICE_AUDIT_EVENT_TYPES.AGENCY_APPROVED,
      source: SERVICE_AUDIT_SOURCES.AGENCY_PORTAL,
      newData: { pax: 4, token: "should-be-stripped" },
    });
    expect(calls[0]!.new_data).toEqual({ pax: 4 });
  });
});

describe("recordServiceAuditEventsBatch — variante batch (import bulk)", () => {
  it("un solo insert per N righe, ognuna sanitizzata", async () => {
    const { admin, calls } = fakeAdmin();
    await recordServiceAuditEventsBatch(admin as never, [
      { tenantId: "t1", serviceId: "s1", eventType: SERVICE_AUDIT_EVENT_TYPES.SERVICE_IMPORTED, source: SERVICE_AUDIT_SOURCES.IMPORT_EXCEL, newData: { token: "x" } },
      { tenantId: "t1", serviceId: "s2", eventType: SERVICE_AUDIT_EVENT_TYPES.SERVICE_IMPORTED, source: SERVICE_AUDIT_SOURCES.IMPORT_EXCEL, newData: { row_index: 2 } },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.new_data).toBeNull();
    expect(calls[1]!.new_data).toEqual({ row_index: 2 });
  });

  it("nessun insert per un array vuoto (evita una query inutile)", async () => {
    const { admin, calls } = fakeAdmin();
    await recordServiceAuditEventsBatch(admin as never, []);
    expect(calls).toHaveLength(0);
  });
});

describe("resolveOperatorNameByUserId", () => {
  it("ritorna il nome se trovato in memberships", async () => {
    const admin = {
      from(table: string) {
        expect(table).toBe("memberships");
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { full_name: "Mario Rossi" } }),
              }),
            }),
          }),
        };
      },
    };
    const name = await resolveOperatorNameByUserId(admin as never, "t1", "u1");
    expect(name).toBe("Mario Rossi");
  });

  it("ritorna null se non trovato o il nome è vuoto (mai inventare un actor)", async () => {
    const admin = {
      from() {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
      },
    };
    const name = await resolveOperatorNameByUserId(admin as never, "t1", "u1");
    expect(name).toBeNull();
  });
});

describe("supabase/migrations/0278_service_audit_events.sql — source contract", () => {
  const sql = read("supabase/migrations/0278_service_audit_events.sql");

  it("service_id è NOT NULL e SENZA foreign key / ON DELETE CASCADE verso services (deve sopravvivere all'hard-delete)", () => {
    expect(sql).toMatch(/service_id uuid not null,/);
    expect(sql).not.toMatch(/service_id uuid not null references public\.services/);
    expect(sql).not.toMatch(/service_id[\s\S]{0,60}on delete cascade/);
  });

  it("tenant_id è NOT NULL e senza foreign key verso tenants (stesso pattern conservativo di service_deletion_log)", () => {
    expect(sql).toMatch(/tenant_id uuid not null,/);
    expect(sql).not.toMatch(/tenant_id uuid not null references/);
  });

  it("indice primario (tenant_id, service_id, created_at desc, id desc) per la keyset pagination", () => {
    expect(sql).toMatch(/tenant_id, service_id, created_at desc, id desc/);
  });

  it("RLS abilitata con SOLO policy SELECT scoped a tenant — nessuna policy INSERT/UPDATE/DELETE (scrittura solo service-role, append-only reale)", () => {
    expect(sql).toMatch(/alter table public\.service_audit_events enable row level security/);
    expect(sql).toMatch(/create policy service_audit_events_select/);
    expect(sql).not.toMatch(/create policy service_audit_events_insert/);
    expect(sql).not.toMatch(/create policy service_audit_events_update/);
    expect(sql).not.toMatch(/create policy service_audit_events_delete/);
    expect(sql).not.toMatch(/for insert/);
    expect(sql).not.toMatch(/for update/);
    expect(sql).not.toMatch(/for delete/);
  });

  it("SELECT ristretto ad admin/operator/supervisor del tenant corrente (stesso perimetro di service_change_logs)", () => {
    expect(sql).toMatch(/current_user_role\(\) in \('admin', 'operator', 'supervisor'\)/);
  });
});
