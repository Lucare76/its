import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_A1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_A2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const NONEXISTENT_SERVICE = "99999999-9999-4999-8999-999999999999";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

/**
 * Real in-memory, mutating, tenant-aware fake for public.services /
 * public.assignments. Filters (.eq/.in) are applied for real against seeded
 * rows shared by BOTH tenants, and delete()/insert() actually mutate the
 * shared arrays — so assertions can inspect the resulting store state, not
 * just which mock args were passed.
 *
 * Every select on "services" is checked for an .eq("tenant_id", ...) filter;
 * if one is never applied before the query resolves, the operation is
 * recorded in calls.unscopedQueries. This is what makes the guard tests
 * genuinely sensitive to a regression: if the tenant filter is ever dropped
 * from the ownership check, the cross-tenant/mixed-array tests below stop
 * getting a 404 and fail for real.
 */
function createTenantAwareSupabase(seed: { services?: Row[]; assignments?: Row[] } = {}) {
  const services: Row[] = [...(seed.services ?? [])];
  const assignments: Row[] = [...(seed.assignments ?? [])];
  const calls = {
    servicesSelect: 0,
    assignmentsDelete: 0,
    assignmentsInsert: 0,
    insertedRows: [] as Row[],
    unscopedQueries: [] as string[],
    lastServicesInIds: null as string[] | null,
  };
  let servicesError: { message: string } | null = null;

  function makeServicesSelectBuilder() {
    let filtered = services;
    let sawTenantFilter = false;
    const builder = {
      eq(field: string, value: unknown) {
        if (field === "tenant_id") sawTenantFilter = true;
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        if (field === "id") calls.lastServicesInIds = [...(values as string[])];
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(
        resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
        reject?: (e: unknown) => unknown
      ) {
        if (!sawTenantFilter) calls.unscopedQueries.push("services.select");
        if (servicesError) {
          return Promise.resolve({ data: null, error: servicesError }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeAssignmentsDeleteBuilder() {
    let filtered = assignments;
    let sawTenantFilter = false;
    const builder = {
      eq(field: string, value: unknown) {
        if (field === "tenant_id") sawTenantFilter = true;
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        calls.assignmentsDelete++;
        if (!sawTenantFilter) calls.unscopedQueries.push("assignments.delete");
        const toRemove = new Set(filtered);
        for (let i = assignments.length - 1; i >= 0; i--) {
          if (toRemove.has(assignments[i])) assignments.splice(i, 1);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  // FUNC-01: la geo-validazione del batch interroga assignments.select(...) per
  // gli "altri giri" del driver. Nessuna riga seed di questo file ha group_id
  // valorizzato, quindi il filtro .not("group_id","is",null) la esclude sempre
  // e la geo-validazione non trova mai conflitti in questi scenari SEC-01.
  function makeAssignmentsSelectBuilder() {
    let filtered = assignments;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      not(field: string, _op: string, value: unknown) {
        filtered = filtered.filter((row) => (row[field] ?? null) !== value);
        return builder;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  // FUNC-01: la disponibilità giornaliera è confermata di default per ogni
  // data richiesta, cosi gli scenari SEC-01 (non focalizzati su FUNC-01)
  // restano invariati. I casi di disponibilità non confermata sono coperti
  // dedicatamente in departure-bus-assign-operational-validation.test.ts.
  function makeDailyAvailabilityBuilder() {
    let requestedDates: string[] = [];
    const builder = {
      eq(_field: string, _value: unknown) {
        return builder;
      },
      in(field: string, values: unknown[]) {
        if (field === "date") requestedDates = values as string[];
        return builder;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: requestedDates.map((d) => ({ date: d, confirmed: true })), error: null }).then(
          resolve,
          reject
        );
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "services") {
        return {
          select() {
            calls.servicesSelect++;
            return makeServicesSelectBuilder();
          },
        };
      }
      if (table === "assignments") {
        return {
          delete() {
            return makeAssignmentsDeleteBuilder();
          },
          insert(rows: Row[]) {
            calls.assignmentsInsert++;
            calls.insertedRows.push(...rows);
            assignments.push(...rows);
            return Promise.resolve({ error: null });
          },
          // RACE-01: la route ora usa upsert al posto di delete+insert. Stessi
          // contatori di insert() cosi le asserzioni esistenti restano valide;
          // applica la semantica ON CONFLICT (service_id, tenant_id) reale.
          upsert(rows: Row[], _options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
            calls.assignmentsInsert++;
            calls.insertedRows.push(...rows);
            for (const row of rows) {
              const idx = assignments.findIndex((a) => a.service_id === row.service_id && a.tenant_id === row.tenant_id);
              if (idx >= 0) assignments[idx] = { ...assignments[idx], ...row };
              else assignments.push(row);
            }
            return Promise.resolve({ error: null });
          },
          select() {
            return makeAssignmentsSelectBuilder();
          },
        };
      }
      if (table === "daily_availability_confirmations") {
        return {
          select() {
            return makeDailyAvailabilityBuilder();
          },
        };
      }
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
  };

  return {
    admin,
    services,
    assignments,
    calls,
    setServicesError(err: { message: string } | null) {
      servicesError = err;
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  sendPushToUser: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));
vi.mock("@/lib/server/web-push", () => ({
  sendPushToUser: mocks.sendPushToUser,
}));

import { POST } from "@/app/api/ops/departure-bus-assign/route";

// FUNC-01: la route ora carica anche data/orario/geografia del batch. I
// default qui sotto (data confermata di default, hotel_id nullo → nessuna
// zona) mantengono i test SEC-01 concentrati solo sull'isolamento tenant.
function serviceRow(tenantId: string, id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: tenantId,
    date: "2026-08-10",
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/departure-bus-assign", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>) {
  return POST(makeRequest(body));
}

function authorizeAs(tenantId: string, fake: ReturnType<typeof createTenantAwareSupabase>, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: tenantId, role, suspended: false },
  });
}

describe("Tenant isolation — departure-bus-assign API (SEC-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. assign_driver same-tenant: tutti i service_ids del tenant A, flusso procede invariato", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A, SERVICE_A1), serviceRow(TENANT_A, SERVICE_A2)],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_A1, SERVICE_A2],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    // RACE-01: assign_driver ora scrive con upsert, mai più con delete+insert.
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(1);
    expect(fake.calls.insertedRows).toHaveLength(2);
    for (const row of fake.calls.insertedRows) {
      expect(row.tenant_id).toBe(TENANT_A);
    }
    expect(fake.calls.unscopedQueries).toEqual([]);
    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it("2. assign_driver con service_id di tenant B: 404 generico, zero scritture", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_B, SERVICE_B1)],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_B1],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("3. assign_driver con service_id inesistente: stesso 404 generico, zero scritture", async () => {
    const fake = createTenantAwareSupabase({ services: [] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "assign_driver",
      service_ids: [NONEXISTENT_SERVICE],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("4. risposta identica per service_id di altro tenant e service_id inesistente", async () => {
    const fakeCrossTenant = createTenantAwareSupabase({ services: [serviceRow(TENANT_B, SERVICE_B1)] });
    authorizeAs(TENANT_A, fakeCrossTenant);
    const resCrossTenant = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_B1],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });

    const fakeNonexistent = createTenantAwareSupabase({ services: [] });
    authorizeAs(TENANT_A, fakeNonexistent);
    const resNonexistent = await callPost({
      action: "assign_driver",
      service_ids: [NONEXISTENT_SERVICE],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });

    expect(resCrossTenant.status).toBe(resNonexistent.status);
    expect(await resCrossTenant.json()).toEqual(await resNonexistent.json());
  });

  it("5. array misto (un id tenant A + un id tenant B): intera operazione rifiutata, zero scritture", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A, SERVICE_A1), serviceRow(TENANT_B, SERVICE_B1)],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_A1, SERVICE_B1],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
    // Nessun comportamento parziale: il servizio valido (A1) non viene assegnato da solo.
    expect(fake.assignments).toHaveLength(0);
  });

  it("6. service_ids duplicati same-tenant: deduplicati per la verifica, nessun falso 404", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A, SERVICE_A1), serviceRow(TENANT_A, SERVICE_A2)],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_A1, SERVICE_A1, SERVICE_A2],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    // La verifica ownership interroga solo i 2 id unici, non i 3 originali.
    expect(fake.calls.lastServicesInIds).toHaveLength(2);
    expect(new Set(fake.calls.lastServicesInIds)).toEqual(new Set([SERVICE_A1, SERVICE_A2]));
    // Comportamento funzionale invariato: l'insert riceve l'array originale (3 elementi, con duplicato).
    expect(fake.calls.insertedRows).toHaveLength(3);
  });

  it("7. tenant_id malevolo nel body viene ignorato: ownership e insert usano sempre il tenant della sessione", async () => {
    const fake = createTenantAwareSupabase({ services: [serviceRow(TENANT_A, SERVICE_A1)] });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_A1],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
      tenant_id: TENANT_B,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.insertedRows).toHaveLength(1);
    expect(fake.calls.insertedRows[0].tenant_id).toBe(TENANT_A);
  });

  it("8. errore nella query di ownership: fail-closed, 500, nessuna scrittura, messaggio DB non esposto", async () => {
    const fake = createTenantAwareSupabase({ services: [serviceRow(TENANT_A, SERVICE_A1)] });
    fake.setServicesError({ message: "connection refused: internal db detail xyz" });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_A1],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).not.toMatch(/connection refused/i);
    expect(body.error).not.toMatch(/internal db detail/i);
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "departure_bus_assign_service_ownership_check_failed", level: "error" })
    );
  });

  it("9. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(
      NextResponse.json({ error: "Sessione non valida." }, { status: 401 })
    );
    const fake = createTenantAwareSupabase({ services: [serviceRow(TENANT_A, SERVICE_A1)] });

    const res = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_A1],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });

    expect(res.status).toBe(401);
    expect(fake.calls.servicesSelect).toBe(0);
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("10. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(
      NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 })
    );
    const fake = createTenantAwareSupabase({ services: [serviceRow(TENANT_A, SERVICE_A1)] });

    const res = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_A1],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });

    expect(res.status).toBe(403);
    expect(fake.calls.servicesSelect).toBe(0);
    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("11. remove_driver same-tenant: la DELETE procede e resta tenant-scoped", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A, SERVICE_A1)],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, driver_user_id: DRIVER_A, vehicle_label: "DEP_BUS:1" }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({ action: "remove_driver", service_ids: [SERVICE_A1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDelete).toBe(1);
    expect(fake.assignments).toHaveLength(0);
    expect(fake.calls.unscopedQueries).toEqual([]);
  });

  it("12. remove_driver con service_id di tenant B: 404, zero DELETE", async () => {
    const fake = createTenantAwareSupabase({
      services: [serviceRow(TENANT_B, SERVICE_B1)],
      assignments: [{ id: "asg-b", tenant_id: TENANT_B, service_id: SERVICE_B1, driver_user_id: "driver-b", vehicle_label: "DEP_BUS:1" }],
    });
    authorizeAs(TENANT_A, fake);

    const res = await callPost({ action: "remove_driver", service_ids: [SERVICE_B1] });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.assignmentsDelete).toBe(0);
    // La riga del tenant B non viene toccata.
    expect(fake.assignments).toHaveLength(1);
  });

  it("13. regressione: assign_driver e remove_driver same-tenant continuano a funzionare come prima del fix", async () => {
    const fakeAssign = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A, SERVICE_A1)],
    });
    authorizeAs(TENANT_A, fakeAssign);
    const resAssign = await callPost({
      action: "assign_driver",
      service_ids: [SERVICE_A1],
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });
    expect(await resAssign.json()).toEqual({ ok: true });
    expect(fakeAssign.calls.insertedRows[0]).toEqual({
      tenant_id: TENANT_A,
      service_id: SERVICE_A1,
      driver_user_id: DRIVER_A,
      vehicle_label: "DEP_BUS:1",
    });

    const fakeRemove = createTenantAwareSupabase({
      services: [serviceRow(TENANT_A, SERVICE_A1)],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_A1, driver_user_id: DRIVER_A, vehicle_label: "DEP_BUS:1" }],
    });
    authorizeAs(TENANT_A, fakeRemove);
    const resRemove = await callPost({ action: "remove_driver", service_ids: [SERVICE_A1] });
    expect(await resRemove.json()).toEqual({ ok: true });
    expect(fakeRemove.assignments).toHaveLength(0);
  });
});
