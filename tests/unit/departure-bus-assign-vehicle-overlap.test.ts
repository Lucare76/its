import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_X2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_OTHER = "a3333333-3333-4333-8333-333333333333";
const SERVICE_OTHER_TENANT_B = "a4444444-4444-4444-8444-444444444444";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, dedicato ai test CONC-03 residuo
 * (overlap mezzo) in departure-bus-assign. Applica realmente eq/in/not/
 * maybeSingle sulle tabelle coinvolte, inclusa la query diretta su
 * assignments (questa route non usa trip_groups). RADIUS/vehicle_time_blocks
 * non entrano in gioco.
 */
function createOperationalSupabase(
  seed: {
    services?: Row[];
    assignments?: Row[];
    dailyAvailabilityConfirmations?: Row[];
    hotels?: Row[];
    memberships?: Row[];
  } = {}
) {
  const services: Row[] = [...(seed.services ?? [])];
  const assignments: Row[] = [...(seed.assignments ?? [])];
  const dailyAvailabilityConfirmations: Row[] = [...(seed.dailyAvailabilityConfirmations ?? [])];
  const hotels: Row[] = [...(seed.hotels ?? [])];
  const memberships: Row[] = seed.memberships ?? [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver" }];

  const calls = {
    assignmentsDelete: 0,
    assignmentsInsert: 0,
    insertedRows: [] as Row[],
    vehicleOverlapQueried: 0,
  };

  const tableErrors: Record<string, { message: string } | null> = {};

  function makeServicesSelectBuilder() {
    let filtered = services;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        const err = tableErrors["services"] ?? null;
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeDailyAvailabilityBuilder() {
    let filtered = dailyAvailabilityConfirmations;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  // Query di geo-validazione FUNC-01 (assignments per "altri giri" del driver):
  // nessuna riga seed ha group_id/driver_user_id impostati in modo da
  // generare conflitto geografico in questi scenari (fuori scope di questo file).
  function makeGeoAssignmentsSelectBuilder() {
    const builder = {
      eq(_field: string, _value: unknown) {
        return builder;
      },
      not(_field: string, _op: string, _value: unknown) {
        return builder;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  // Query CONC-03 residuo: assignments per tenant_id + vehicle_label, con
  // join services!inner. Distinta dalla query geo sopra: la query di overlap
  // mezzo applica sempre .eq("vehicle_label", ...), quella geo mai.
  function makeVehicleOverlapSelectBuilder() {
    let filtered = assignments;
    let sawVehicleLabelFilter = false;
    const builder = {
      eq(field: string, value: unknown) {
        if (field === "vehicle_label") sawVehicleLabelFilter = true;
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      not(field: string, op: string, value: unknown) {
        return makeGeoAssignmentsSelectBuilder().not(field, op, value);
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        if (!sawVehicleLabelFilter) {
          return makeGeoAssignmentsSelectBuilder().then(resolve, reject);
        }
        calls.vehicleOverlapQueried++;
        const err = tableErrors["assignments_vehicle_overlap"] ?? null;
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        const withJoin = filtered.map((row) => ({
          ...row,
          services: services.find((s) => s.id === row.service_id) ?? null,
        }));
        return Promise.resolve({ data: withJoin, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeAssignmentsDeleteBuilder() {
    let filtered = assignments;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        calls.assignmentsDelete++;
        const toRemove = new Set(filtered);
        for (let i = assignments.length - 1; i >= 0; i--) {
          if (toRemove.has(assignments[i])) assignments.splice(i, 1);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeHotelsSelectBuilder() {
    let filtered = hotels;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(row[field]));
        return builder;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeMembershipsSelectBuilder() {
    let filtered = memberships;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((row) => row[field] === value);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      if (table === "services") {
        return { select: () => makeServicesSelectBuilder() };
      }
      if (table === "daily_availability_confirmations") {
        return { select: () => makeDailyAvailabilityBuilder() };
      }
      if (table === "assignments") {
        return {
          select: () => makeVehicleOverlapSelectBuilder(),
          delete: () => makeAssignmentsDeleteBuilder(),
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
        };
      }
      if (table === "hotels") {
        return { select: () => makeHotelsSelectBuilder() };
      }
      if (table === "memberships") {
        return { select: () => makeMembershipsSelectBuilder() };
      }
      throw new Error(`Unexpected table in test fake: ${table}`);
    },
  };

  return {
    admin,
    assignments,
    calls,
    setVehicleOverlapError(err: { message: string } | null) {
      tableErrors["assignments_vehicle_overlap"] = err;
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
    date: TEST_DATE,
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
    arrival_time: null,
    orario_barca: null,
    porto_bruno: null,
    barca_compagnia: null,
    booking_service_kind: null,
    service_type_code: null,
    vessel: null,
    ferry_details: null,
    ...overrides,
  };
}

function confirmedDate(date: string, tenantId: string = TENANT_A): Row {
  return { tenant_id: tenantId, date, confirmed: true };
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

describe("CONC-03 residuo — vehicle overlap guard in departure-bus-assign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. batch singolo valido (un solo service): successo", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsInsert).toBe(1);
  });

  it("2. batch multi-servizio stesso giro (orari diversi, stesso mezzo): nessun falso conflitto interno", async () => {
    const fake = createOperationalSupabase({
      services: [
        serviceRow(SERVICE_X1, { time: "09:00:00" }),
        serviceRow(SERVICE_X2, { time: "09:02:00" }),
      ],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("5. overlap con assignment esterno same-tenant: 409 VEHICLE_OVERLAP (sensibile alla rimozione del guard)", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1, { time: "10:00:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, vehicle_label: "DEP_BUS:1", group_id: null }],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "VEHICLE_OVERLAP",
      message: "Il mezzo è già impegnato in un altro servizio nello stesso orario.",
    });
  });

  it("6. zero scritture su overlap esterno rilevato", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1, { time: "10:00:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, vehicle_label: "DEP_BUS:1", group_id: null }],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    await callPost(assignBody({ service_ids: [SERVICE_X1] }));

    expect(fake.calls.assignmentsInsert).toBe(0);
  });

  it("7. stesso vehicle_label impegnato nel tenant B: nessun blocco (sensibile alla rimozione del filtro tenant)", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1, { time: "10:00:00" }), serviceRow(SERVICE_OTHER_TENANT_B, { tenant_id: TENANT_B, time: "10:00:00" })],
      assignments: [{ id: "asg-tenantB", tenant_id: TENANT_B, service_id: SERVICE_OTHER_TENANT_B, vehicle_label: "DEP_BUS:1", group_id: null }],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("8. batch corrente escluso dal confronto esterno (riassegnazione dello stesso batch allo stesso mezzo)", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1, { time: "10:00:00" }), serviceRow(SERVICE_X2, { time: "10:00:00" })],
      assignments: [
        { id: "asg-x1", tenant_id: TENANT_A, service_id: SERVICE_X1, vehicle_label: "DEP_BUS:1", group_id: null },
        { id: "asg-x2", tenant_id: TENANT_A, service_id: SERVICE_X2, vehicle_label: "DEP_BUS:1", group_id: null },
      ],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("9a. confine temporale: il batch inizia esattamente quando l'esterno termina → nessun overlap, 200", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1, { time: "10:30:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, vehicle_label: "DEP_BUS:1", group_id: null }],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    expect(res.status).toBe(200);
  });

  it("9b. sovrapposizione parziale con esterno: 409", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1, { time: "10:15:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, vehicle_label: "DEP_BUS:1", group_id: null }],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    expect(res.status).toBe(409);
  });

  it("10. vehicle_label assente: 400 body-validation invariato (già richiesto a monte)", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "assign_driver", service_ids: [SERVICE_X1], driver_user_id: DRIVER_A });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "service_ids, driver_user_id e vehicle_label richiesti" });
  });

  it("11. errore query overlap mezzo: 500 VEHICLE_CHECK_FAILED, fail-closed, zero scritture", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    fake.setVehicleOverlapError(RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "VEHICLE_CHECK_FAILED",
      message: "Errore durante la verifica della disponibilità del mezzo.",
    });
    expect(fake.calls.assignmentsInsert).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "departure_bus_assign_vehicle_check_failed", level: "error" })
    );
  });

  it("12. risposta sanificata: nessun service_id/tenant/dettaglio DB esposto", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1, { time: "10:00:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, vehicle_label: "DEP_BUS:1", group_id: null }],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toMatch(new RegExp(SERVICE_OTHER));
    expect(raw).not.toMatch(new RegExp(TENANT_A));
    expect(raw.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);
  });

  it("13. SEC-01 invariato: service_id di tenant B blocca prima del guard mezzo", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_OTHER_TENANT_B, { tenant_id: TENANT_B })],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_OTHER_TENANT_B] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.vehicleOverlapQueried).toBe(0);
  });

  it("14. SEC-05 invariato: driver inesistente blocca prima del guard mezzo", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
      memberships: [],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    expect(fake.calls.vehicleOverlapQueried).toBe(0);
  });

  it("15. FUNC-01 invariato: disponibilità non confermata blocca prima del guard mezzo", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      dailyAvailabilityConfirmations: [],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DAILY_AVAILABILITY_NOT_CONFIRMED");
    expect(fake.calls.vehicleOverlapQueried).toBe(0);
  });

  it("16. RACE-01 invariato: mezzo libero produce upsert (mai delete) anche con il nuovo guard attivo", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    await callPost(assignBody({ service_ids: [SERVICE_X1] }));

    expect(fake.calls.assignmentsDelete).toBe(0);
    expect(fake.calls.assignmentsInsert).toBe(1);
  });

  it("17. semantica upsert invariata: reset esplicito dei metadati stale sulla riga scritta", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      dailyAvailabilityConfirmations: [confirmedDate(TEST_DATE)],
    });
    authorizeAs(fake);

    await callPost(assignBody({ service_ids: [SERVICE_X1] }));

    expect(fake.calls.insertedRows[0]).toMatchObject({
      driver_profile_id: null,
      group_id: null,
      assignment_source: null,
      locked_by_operator: false,
      lock_reason: null,
    });
  });

  it("18. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = createOperationalSupabase({ services: [serviceRow(SERVICE_X1)] });

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));

    expect(res.status).toBe(401);
    expect(fake.calls.vehicleOverlapQueried).toBe(0);
  });

  it("19. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = createOperationalSupabase({ services: [serviceRow(SERVICE_X1)] });

    const res = await callPost(assignBody({ service_ids: [SERVICE_X1] }));

    expect(res.status).toBe(403);
    expect(fake.calls.vehicleOverlapQueried).toBe(0);
  });

  it("20. remove_driver invariata: nessuna interrogazione del guard overlap mezzo", async () => {
    const fake = createOperationalSupabase({
      services: [serviceRow(SERVICE_X1)],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X1, vehicle_label: "DEP_BUS:1", group_id: null }],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "remove_driver", service_ids: [SERVICE_X1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDelete).toBe(1);
    expect(fake.calls.vehicleOverlapQueried).toBe(0);
  });
});
