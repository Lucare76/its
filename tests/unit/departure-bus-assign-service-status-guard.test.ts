import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_X2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const DRIVER_ACTIVE = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d3333333-3333-4333-8333-333333333333";
const DATE_1 = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, dedicato al guard FUNC-02 (stato
 * operativo servizi) in departure-bus-assign. Stesso schema dei fake usati
 * negli altri test di questa route (es. driver-status-guard.test.ts), con
 * queryCountByTable generico per colpire selettivamente l'N-esima query su
 * una tabella (qui: la 2a query su "services", quella del guard FUNC-02 —
 * la 1a è SEC-01/verifyServicesBelongToTenant, la 3a è il caricamento batch
 * FUNC-01).
 */
function createTenantAwareSupabase(
  seed: Partial<Record<"services" | "memberships" | "assignments" | "daily_availability_confirmations", Row[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    memberships: [...(seed.memberships ?? [])],
    assignments: [...(seed.assignments ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
  };

  const tableErrors: Record<string, { message: string } | null> = {};
  const queryCountByTable: Record<string, number> = {};
  const errorOnNthQuery: Record<string, { n: number; err: { message: string } } | null> = {};

  const calls = {
    servicesQueried: 0,
    membershipsQueried: 0,
    assignmentsUpsertCalls: 0,
    assignmentsDeleteCalls: 0,
    upsertedRows: [] as Row[],
    pushCalls: [] as Array<{ tenantId: string; userId: string }>,
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table];
    if (table === "services") calls.servicesQueried++;
    if (table === "memberships") calls.membershipsQueried++;
    queryCountByTable[table] = (queryCountByTable[table] ?? 0) + 1;
    const thisQueryN = queryCountByTable[table];
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
        const forcedNth = errorOnNthQuery[table];
        if (forcedNth && forcedNth.n === thisQueryN) {
          return Promise.resolve({ data: null, error: forcedNth.err });
        }
        const err = tableErrors[table] ?? null;
        if (err) return Promise.resolve({ data: null, error: err });
        const row = filtered[0] ?? null;
        return Promise.resolve({ data: row ? (augment ? augment(row) : row) : null, error: null });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        const forcedNth = errorOnNthQuery[table];
        if (forcedNth && forcedNth.n === thisQueryN) {
          return Promise.resolve({ data: null, error: forcedNth.err }).then(resolve, reject);
        }
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
        upsert(rows: Row[], _options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          return {
            then(resolve: (v: { data: null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              const err = tableErrors["assignments_upsert"] ?? null;
              if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
              calls.assignmentsUpsertCalls++;
              for (const row of rows) {
                calls.upsertedRows.push(row);
                const idx = tables.assignments.findIndex((a) => a.service_id === row.service_id && a.tenant_id === row.tenant_id);
                if (idx >= 0) tables.assignments[idx] = { ...tables.assignments[idx], ...row };
                else tables.assignments.push({ id: `asg-${tables.assignments.length + 1}`, ...row });
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
    setErrorOnNthQuery(table: string, n: number, err: { message: string } | null) {
      errorOnNthQuery[table] = err ? { n, err } : null;
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
    status: "assigned",
    is_draft: false,
    ...overrides,
  };
}

function confirmedDate(date: string, tenantId: string = TENANT_A): Row {
  return { tenant_id: tenantId, date, confirmed: true };
}

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(SERVICE_X1), serviceRow(SERVICE_X2)],
    daily_availability_confirmations: [confirmedDate(DATE_1)],
    memberships: [
      { tenant_id: TENANT_A, user_id: DRIVER_ACTIVE, role: "driver", suspended: false },
      { tenant_id: TENANT_B, user_id: DRIVER_B, role: "driver", suspended: false },
    ],
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

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, role: string = "operator") {
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
    driver_user_id: DRIVER_ACTIVE,
    vehicle_label: "DEP_BUS:1",
    ...overrides,
  };
}

const NOT_ASSIGNABLE_BODY = {
  ok: false,
  error: "SERVICE_NOT_ASSIGNABLE",
  message: "Uno o più servizi non possono essere assegnati nello stato attuale.",
};

describe("FUNC-02 residuo — service operational status guard in departure-bus-assign (assign_driver)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. servizi tutti operativi (status assegnabile, is_draft=false): successo, upsert eseguito", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsUpsertCalls).toBe(1);
  });

  it("2. status completato: 409 SERVICE_NOT_ASSIGNABLE, zero scritture", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "completato" }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(NOT_ASSIGNABLE_BODY);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("3. status cancelled: 409 SERVICE_NOT_ASSIGNABLE, zero scritture", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "cancelled" }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(NOT_ASSIGNABLE_BODY);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("4. status needs_review: 409 SERVICE_NOT_ASSIGNABLE, zero scritture", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "needs_review" }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(NOT_ASSIGNABLE_BODY);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("5. status pending_cancellation: 409 SERVICE_NOT_ASSIGNABLE, zero scritture", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "pending_cancellation" }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(NOT_ASSIGNABLE_BODY);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("6. is_draft=true (status assignabile): 409 SERVICE_NOT_ASSIGNABLE, zero scritture", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { is_draft: true }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(NOT_ASSIGNABLE_BODY);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("7. array misto (un servizio operativo, uno cancelled): 409, batch intero bloccato", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1), serviceRow(SERVICE_X2, { status: "cancelled" })],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(NOT_ASSIGNABLE_BODY);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    // Nessuna riga scritta nemmeno per il servizio operativo del batch (SERVICE_X1).
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("8. service_ids duplicati con un servizio non operativo: 409, deduplicazione non aggira il guard", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "cancelled" }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1, SERVICE_X1, SERVICE_X2] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(NOT_ASSIGNABLE_BODY);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("9. batch atomico: successo scrive tutte le righe del batch in un solo upsert", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsUpsertCalls).toBe(1);
    expect(fake.tables.assignments).toHaveLength(2);
  });

  it("10. SEC-01 invariato: blocca prima del guard FUNC-02 (service_id di tenant B)", async () => {
    const fake = baseSeed({
      services: [{ id: SERVICE_B1, tenant_id: TENANT_B, date: DATE_1, time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: null, status: "assigned", is_draft: false }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_B1] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    // Una sola query "services" (SEC-01): FUNC-02 non è mai stato raggiunto.
    expect(fake.calls.servicesQueried).toBe(1);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("11. SEC-05 invariato: driver cross-tenant blocca prima del guard FUNC-02", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "cancelled" }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    // SEC-01 ha già interrogato "services" una volta; FUNC-02 non è stato raggiunto
    // (SEC-05 blocca prima), quindi nessuna seconda query.
    expect(fake.calls.servicesQueried).toBe(1);
  });

  it("12. FUNC-03 invariato: driver sospeso blocca prima del guard FUNC-02", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "cancelled" }), serviceRow(SERVICE_X2)],
      memberships: [
        { tenant_id: TENANT_A, user_id: DRIVER_ACTIVE, role: "driver", suspended: true },
        { tenant_id: TENANT_B, user_id: DRIVER_B, role: "driver", suspended: false },
      ],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "DRIVER_NOT_ACTIVE",
      message: "L'autista non è attualmente disponibile per nuove assegnazioni.",
    });
    // FUNC-02 non è stato raggiunto: solo la query "services" di SEC-01.
    expect(fake.calls.servicesQueried).toBe(1);
  });

  it("13. availability invariata: continua a bloccare con 409 dopo aver superato FUNC-02", async () => {
    const fake = baseSeed({ daily_availability_confirmations: [] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DAILY_AVAILABILITY_NOT_CONFIRMED");
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    // SEC-01 (1) + FUNC-02 (2) + FUNC-01 batch load (3): tutte e tre le query
    // "services" eseguite prima del blocco availability.
    expect(fake.calls.servicesQueried).toBe(3);
  });

  it("14. overlap driver invariato: conflitto esterno continua a bloccare con 409 dopo FUNC-02", async () => {
    // Gap di 20 minuti: fuori dalla soglia FUNC-01 (buffer geografico "zona
    // sconosciuta" 15 min, hotel_id/meeting_point null in questi seed) ma
    // ancora dentro la finestra fissa di 30 minuti di CONC-02: isola la
    // guardia CONC-02 specificamente, evitando che FUNC-01 (aggiunta
    // successivamente, valida anch'essa lo stesso autista/tenant) intercetti
    // per prima lo stesso conflitto con un errore diverso (comportamento
    // reale e corretto, ma non l'oggetto di questo test).
    const fake = baseSeed({
      assignments: [
        {
          id: "asg-ext",
          tenant_id: TENANT_A,
          service_id: "c9999999-9999-4999-8999-999999999999",
          driver_user_id: DRIVER_ACTIVE,
          vehicle_label: "OTHER_BUS",
        },
      ],
      services: [
        serviceRow(SERVICE_X1),
        serviceRow(SERVICE_X2),
        serviceRow("c9999999-9999-4999-8999-999999999999", { time: "10:20:00" }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_OVERLAP");
  });

  it("15. overlap mezzo invariato: conflitto esterno continua a bloccare con 409 dopo FUNC-02", async () => {
    const fake = baseSeed({
      assignments: [
        {
          id: "asg-ext",
          tenant_id: TENANT_A,
          service_id: "c9999999-9999-4999-8999-999999999999",
          driver_user_id: DRIVER_B,
          vehicle_label: "DEP_BUS:1",
        },
      ],
      services: [
        serviceRow(SERVICE_X1),
        serviceRow(SERVICE_X2),
        serviceRow("c9999999-9999-4999-8999-999999999999", { time: "10:05:00" }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("VEHICLE_OVERLAP");
  });

  it("16. zero scritture su blocco FUNC-02 (nessuna riga in assignments)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "needs_review" }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fake);

    await callPost(assignBody());

    expect(fake.tables.assignments).toHaveLength(0);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    expect(fake.calls.assignmentsDeleteCalls).toBe(0);
  });

  it("17. zero push su blocco FUNC-02", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "needs_review" }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fake);

    await callPost(assignBody());

    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it("18. tenant_id malevolo nel body viene ignorato: guard FUNC-02 resta contro il tenant della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody({ tenant_id: TENANT_B }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.upsertedRows[0].tenant_id).toBe(TENANT_A);
  });

  it("19. errore DB nella query di stato (2a query services): 500 SERVICE_STATUS_CHECK_FAILED, fail-closed, zero scritture, audit invocato", async () => {
    const fake = baseSeed();
    fake.setErrorOnNthQuery("services", 2, RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "SERVICE_STATUS_CHECK_FAILED",
      message: "Errore durante la verifica dello stato dei servizi.",
    });
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "departure_bus_assign_service_status_check_failed", level: "error" })
    );
  });

  it("20. risposta sanificata: nessun dettaglio DB, SQLSTATE, tenant o service id nel body", async () => {
    const fakeBlocked = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "cancelled" }), serviceRow(SERVICE_X2)],
    });
    authorizeAs(fakeBlocked);
    const resBlocked = await callPost(assignBody());
    const rawBlocked = JSON.stringify(await resBlocked.json());
    expect(rawBlocked).not.toMatch(new RegExp(SERVICE_X1));
    expect(rawBlocked).not.toMatch(new RegExp(TENANT_A));

    const fakeErr = baseSeed();
    fakeErr.setErrorOnNthQuery("services", 2, RAW_DB_ERROR);
    authorizeAs(fakeErr);
    const resErr = await callPost(assignBody());
    const rawErr = JSON.stringify(await resErr.json());
    expect(rawErr).not.toMatch(/internal-db-host/);
    expect(rawErr.toLowerCase()).not.toMatch(/sqlstate/);
  });

  it("21. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost(assignBody());

    expect(res.status).toBe(401);
    expect(fake.calls.servicesQueried).toBe(0);
  });

  it("22. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost(assignBody());

    expect(res.status).toBe(403);
    expect(fake.calls.servicesQueried).toBe(0);
  });

  it("23. remove_driver invariata: guard FUNC-02 non invocato per servizi non operativi", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X1, { status: "cancelled" }), serviceRow(SERVICE_X2)],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X1, driver_user_id: DRIVER_ACTIVE, vehicle_label: "DEP_BUS:1" }],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "remove_driver", service_ids: [SERVICE_X1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDeleteCalls).toBe(1);
  });
});
