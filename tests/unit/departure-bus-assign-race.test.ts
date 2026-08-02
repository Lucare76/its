import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_X2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B_DRIVER = "d2222222-2222-4222-8222-222222222222";
const DATE_1 = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'duplicate key value violates unique constraint "internal_x" SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, per il fix RACE-01 (upsert al posto di
 * DELETE+INSERT) in departure-bus-assign. L'upsert applica realmente la
 * semantica ON CONFLICT (service_id, tenant_id) DO UPDATE: se la riga esiste
 * viene aggiornata in place, altrimenti creata — mai una finestra in cui la
 * riga non esiste. Interamente sincrono, cosi Promise.all su due chiamate
 * concorrenti esercita davvero l'interleaving reale del codice della route.
 */
function createOperationalSupabase(
  seed: Partial<Record<"services" | "daily_availability_confirmations" | "assignments", Row[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    assignments: [...(seed.assignments ?? [])],
  };

  const tableErrors: Record<string, { message: string } | null> = {};

  const calls = {
    assignmentsDeleteCalls: 0,
    assignmentsUpsertCalls: 0,
    upsertedRows: [] as Row[],
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    let filtered = tables[table];
    const augment = table === "assignments" ? augmentAssignmentRow : undefined;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      not(field: string, _op: string, value: unknown) {
        filtered = filtered.filter((r) => (r[field] ?? null) !== value);
        return builder;
      },
      maybeSingle() {
        const err = tableErrors[table] ?? null;
        if (err) return Promise.resolve({ data: null, error: err });
        const row = filtered[0] ?? null;
        return Promise.resolve({ data: row ? (augment ? augment(row) : row) : null, error: null });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        const err = tableErrors[table] ?? null;
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        const data = augment ? filtered.map(augment) : filtered;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeDeleteBuilder(table: string) {
    const rows = tables[table];
    let filtered = rows;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if (table === "assignments") calls.assignmentsDeleteCalls++;
        const toRemove = new Set(filtered);
        for (let i = rows.length - 1; i >= 0; i--) {
          if (toRemove.has(rows[i])) rows.splice(i, 1);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() {
          return makeSelectBuilder(table);
        },
        delete() {
          return makeDeleteBuilder(table);
        },
        upsert(rows: Row[], _options: { onConflict: string; ignoreDuplicates: boolean }) {
          return {
            then(resolve: (v: { data: null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              const err = tableErrors["assignments_upsert"] ?? null;
              if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);

              calls.assignmentsUpsertCalls++;
              for (const row of rows) {
                calls.upsertedRows.push(row);
                const existingIdx = tables.assignments.findIndex(
                  (a) => a.service_id === row.service_id && a.tenant_id === row.tenant_id
                );
                if (existingIdx >= 0) {
                  tables.assignments[existingIdx] = { ...tables.assignments[existingIdx], ...row };
                } else {
                  tables.assignments.push({ id: `asg-${tables.assignments.length + 1}`, ...row });
                }
              }
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
        },
      };
    },
  };

  return {
    admin,
    tables,
    calls,
    setTableError(table: string, err: { message: string } | null) {
      tableErrors[table] = err;
    },
    setUpsertError(err: { message: string } | null) {
      tableErrors["assignments_upsert"] = err;
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

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: DATE_1,
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
    ...overrides,
  };
}

function confirmedDate(date: string, tenantId: string = TENANT_A): Row {
  return { tenant_id: tenantId, date, confirmed: true };
}

function baseSeed(overrides: Parameters<typeof createOperationalSupabase>[0] = {}) {
  return createOperationalSupabase({
    services: [serviceRow(SERVICE_X1), serviceRow(SERVICE_X2)],
    daily_availability_confirmations: [confirmedDate(DATE_1)],
    ...overrides,
  });
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

function authorizeAs(fake: ReturnType<typeof createOperationalSupabase>, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function assignBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "assign_driver",
    service_ids: [SERVICE_X1, SERVICE_X2],
    driver_user_id: DRIVER_A,
    vehicle_label: "DEP_BUS:1",
    ...overrides,
  };
}

describe("RACE-01 — upsert al posto di DELETE+INSERT in departure-bus-assign (assign_driver)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. assegnazione normale: 200, una riga per service_id, nessun DELETE", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.tables.assignments).toHaveLength(2);
    expect(fake.calls.assignmentsDeleteCalls).toBe(0);
  });

  it("2. doppia richiesta concorrente: entrambe rispondono 200, nessun falso fallimento", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const [resA, resB] = await Promise.all([
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_A, vehicle_label: "Bus A" })),
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_B_DRIVER, vehicle_label: "Bus B" })),
    ]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(bodyA).toEqual({ ok: true });
    expect(bodyB).toEqual({ ok: true });
  });

  it("3. nessuna perdita: dopo la race, la riga per il servizio esiste sempre con un driver valido", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await Promise.all([
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_A, vehicle_label: "Bus A" })),
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_B_DRIVER, vehicle_label: "Bus B" })),
    ]);

    const rows = fake.tables.assignments.filter((a) => a.service_id === SERVICE_X1);
    expect(rows).toHaveLength(1);
    expect([DRIVER_A, DRIVER_B_DRIVER]).toContain(rows[0].driver_user_id);
  });

  it("4. nessuna duplicazione: mai due righe per lo stesso service_id dopo la race", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await Promise.all([
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_A, vehicle_label: "Bus A" })),
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_B_DRIVER, vehicle_label: "Bus B" })),
    ]);

    expect(fake.tables.assignments.filter((a) => a.service_id === SERVICE_X1)).toHaveLength(1);
  });

  it("5. ultimo driver applicato secondo la logica prevista: lo stato finale coincide con l'ultimo upsert eseguito", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await Promise.all([
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_A, vehicle_label: "Bus A" })),
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_B_DRIVER, vehicle_label: "Bus B" })),
    ]);

    const lastUpsertForService = [...fake.calls.upsertedRows].reverse().find((r) => r.service_id === SERVICE_X1);
    const finalRow = fake.tables.assignments.find((a) => a.service_id === SERVICE_X1);
    expect(finalRow?.driver_user_id).toBe(lastUpsertForService?.driver_user_id);
    expect(finalRow?.vehicle_label).toBe(lastUpsertForService?.vehicle_label);
  });

  it("6. nessun DELETE non necessario, anche sotto race", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await Promise.all([
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_A, vehicle_label: "Bus A" })),
      callPost(assignBody({ service_ids: [SERVICE_X1], driver_user_id: DRIVER_B_DRIVER, vehicle_label: "Bus B" })),
    ]);

    expect(fake.calls.assignmentsDeleteCalls).toBe(0);
  });

  it("7. tenant isolation invariata (SEC-01): service_id di un altro tenant -> 404, zero scritture", async () => {
    const fake = baseSeed({
      services: [{ id: SERVICE_B1, tenant_id: TENANT_B, date: DATE_1, time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: null }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_B1] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    expect(fake.calls.assignmentsDeleteCalls).toBe(0);
  });

  it("8. SEC-01 invariato: service_id inesistente produce la stessa risposta del cross-tenant", async () => {
    const fake = baseSeed({ services: [] });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: ["99999999-9999-4999-8999-999999999999"] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
  });

  it("9. FUNC-01 invariato: disponibilità non confermata blocca ancora con upsert non eseguito", async () => {
    const fake = baseSeed({ daily_availability_confirmations: [] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DAILY_AVAILABILITY_NOT_CONFIRMED");
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("10. errore DB sull'upsert: 500 fail-closed, messaggio non sanificato dal throw esistente ma senza dettagli aggiuntivi esposti oltre al preesistente", async () => {
    const fake = baseSeed();
    fake.setUpsertError(RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("11. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(assignBody());

    expect(res.status).toBe(401);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("12. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(assignBody());

    expect(res.status).toBe(403);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });
});
