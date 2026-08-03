import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X = "a1111111-1111-4111-8111-111111111111";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const NONEXISTENT_SERVICE = "99999999-9999-4999-8999-999999999999";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

/**
 * Fake Supabase in-memory, tenant-aware, dedicato ai test FUNC-02 (guard
 * stato servizio) in assign-service. Applica realmente eq/neq/in/maybeSingle
 * sulle tabelle coinvolte (services, memberships, driver_profiles,
 * assignments, trip_groups, daily_availability_confirmations, status_events).
 * Non definisce vehicle_time_blocks: non consultata da CONC-03/FUNC-02.
 */
function createTenantAwareSupabase(
  seed: Partial<Record<
    "services" | "memberships" | "driver_profiles" | "assignments" | "trip_groups" | "daily_availability_confirmations" | "status_events",
    Row[]
  >> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    memberships: [...(seed.memberships ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    status_events: [...(seed.status_events ?? [])],
  };

  const tableErrors: Record<string, { message: string } | null> = {};

  const calls = {
    tripGroupsInserted: [] as Row[],
    tripGroupsUpdated: 0,
    tripGroupsDeleted: 0,
    assignmentsInserted: [] as Row[],
    assignmentsUpdated: 0,
    assignmentsDeleted: 0,
    servicesUpdated: 0,
    statusEventsUpserted: 0,
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table];
    const augment = table === "assignments" ? augmentAssignmentRow : undefined;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      neq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] !== value);
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

  function makeMutationBuilder(table: string, op: "delete" | "update", payload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "delete") {
          const toRemove = new Set(filtered);
          for (let i = rows.length - 1; i >= 0; i--) {
            if (toRemove.has(rows[i])) {
              if (table === "assignments") calls.assignmentsDeleted++;
              if (table === "trip_groups") calls.tripGroupsDeleted++;
              rows.splice(i, 1);
            }
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        for (const row of filtered) Object.assign(row, payload);
        if (table === "assignments") calls.assignmentsUpdated += filtered.length;
        if (table === "trip_groups") calls.tripGroupsUpdated += filtered.length;
        if (table === "services") calls.servicesUpdated += filtered.length;
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
          return makeMutationBuilder(table, "delete");
        },
        update(payload: Row) {
          return makeMutationBuilder(table, "update", payload);
        },
        insert(row: Row) {
          if (table === "trip_groups") {
            const inserted = { id: `grp-${tables.trip_groups.length + 1}`, status: "active", ...row };
            tables.trip_groups.push(inserted);
            calls.tripGroupsInserted.push(inserted);
            return {
              select() {
                return { single: () => Promise.resolve({ data: inserted, error: null }) };
              },
            };
          }
          if (table === "assignments") {
            const key = `${row.service_id}:${row.tenant_id}`;
            const conflict = tables.assignments.some((a) => `${a.service_id}:${a.tenant_id}` === key);
            if (conflict) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
            const inserted = { id: `asg-${tables.assignments.length + 1}`, ...row };
            tables.assignments.push(inserted);
            calls.assignmentsInserted.push(inserted);
            return Promise.resolve({ data: inserted, error: null });
          }
          tables[table].push(row);
          return Promise.resolve({ data: row, error: null });
        },
        upsert(row: Row) {
          if (table === "status_events") calls.statusEventsUpserted += 1;
          tables[table].push(row);
          return Promise.resolve({ data: null, error: null });
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
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { POST } from "@/app/api/ops/assign-service/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: TEST_DATE,
    status: "new",
    is_draft: false,
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

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(SERVICE_X)],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    memberships: [{ tenant_id: TENANT_A, user_id: DRIVER_A, role: "driver" }],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/assign-service", {
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

function assertZeroWrites(fake: ReturnType<typeof createTenantAwareSupabase>) {
  expect(fake.calls.tripGroupsInserted).toHaveLength(0);
  expect(fake.calls.assignmentsInserted).toHaveLength(0);
  expect(fake.calls.tripGroupsUpdated).toBe(0);
  expect(fake.calls.assignmentsUpdated).toBe(0);
  expect(fake.calls.servicesUpdated).toBe(0);
  expect(fake.calls.statusEventsUpserted).toBe(0);
}

describe("FUNC-02 — service status guard in assign-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. stato new: assegnazione riuscita, 200", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "new" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted).toHaveLength(1);
  });

  it("2. stato assigned: aggiornamento (riassegnazione driver/mezzo) resta consentito, 200", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { status: "assigned" })],
      trip_groups: [{ id: "grp-existing", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus old" }],
      assignments: [{ id: "asg-existing", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: "grp-existing", driver_user_id: DRIVER_A, vehicle_label: "Bus old" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus new" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsUpdated).toBe(1);
    expect(fake.calls.assignmentsUpdated).toBe(1);
  });

  it("3. stato partito: riassegnazione (correzione operativa) resta consentita, 200", async () => {
    // "partito" non è terminale (driver/page.tsx tratta come storico solo
    // completato/cancelled): riassegnare un autista indisponibile a metà
    // corsa è un correttivo legittimo, non deve essere bloccato.
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "partito" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("3b. stato problema: riassegnazione (correzione operativa) resta consentita, 200", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "problema" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("3c. stati caricato/scaricato/arrivato: nessuno di questi blocca l'assegnazione", async () => {
    for (const status of ["caricato", "scaricato", "arrivato"]) {
      const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status })] });
      authorizeAs(fake);

      const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
      expect(res.status, `status=${status}`).toBe(200);
    }
  });

  it("4. stato completato: 409 SERVICE_NOT_ASSIGNABLE, zero scritture (sensibile alla rimozione del guard)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "completato" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "SERVICE_NOT_ASSIGNABLE",
      message: "Il servizio non può essere assegnato nello stato attuale.",
    });
    assertZeroWrites(fake);
  });

  it("5. stato cancelled: 409, zero scritture (sensibile alla rimozione del guard)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    assertZeroWrites(fake);
  });

  it("6. stato needs_review: 409, zero scritture (dati non ancora verificati)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "needs_review" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    assertZeroWrites(fake);
  });

  it("7. is_draft=true: 409, zero scritture (stesso segnale usato da auto-assign)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "new", is_draft: true })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    assertZeroWrites(fake);
  });

  it("8. stato pending_cancellation: 409, zero scritture (cancellazione in decisione)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "pending_cancellation" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    assertZeroWrites(fake);
  });

  it("9. servizio inesistente: comportamento 404 invariato (non trasformato in 409)", async () => {
    const fake = baseSeed({ services: [] });
    authorizeAs(fake);

    const res = await callPost({ service_id: NONEXISTENT_SERVICE, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Servizio non trovato." });
  });

  it("10. servizio di tenant B: stesso 404 invariato, non 409", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_B1, { tenant_id: TENANT_B })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_B1, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Servizio non trovato." });
  });

  it("11. stato completato: nessun trip_group creato", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "completato" })] });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });

    expect(fake.calls.tripGroupsInserted).toHaveLength(0);
  });

  it("12. stato cancelled: nessun assignment scritto", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "cancelled" })] });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });

    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("13. stato completato: nessun status_event di successo", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "completato" })] });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });

    expect(fake.calls.statusEventsUpserted).toBe(0);
  });

  it("14. stato cancelled: nessun audit di successo (nessuna chiamata auditLog con esito positivo)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "cancelled" })] });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });

    for (const call of mocks.auditLog.mock.calls) {
      expect(call[0].level).not.toBe("info");
    }
  });

  it("16. ramo update su stato consentito (assigned) invariato: driver/mezzo aggiornati", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { status: "assigned" })],
      trip_groups: [{ id: "grp-existing", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus old" }],
      assignments: [{ id: "asg-existing", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: "grp-existing", driver_user_id: "old-driver", vehicle_label: "Bus old" }],
    });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus new" });

    const updated = fake.tables.assignments.find((a) => a.id === "asg-existing");
    expect(updated?.driver_user_id).toBe(DRIVER_A);
    expect(updated?.vehicle_label).toBe("Bus new");
  });

  it("17. action remove invariata: consentita anche su servizio completato/cancellato (pulizia residua)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { status: "cancelled" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: null, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, action: "remove" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDeleted).toBe(1);
  });

  it("18. SEC-05 invariato: driver di altro tenant su servizio in stato assegnabile resta 404 driver", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "new" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: "driver-tenant-b-ghost", vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("DRIVER_NOT_FOUND");
  });

  it("19. CONC-01 invariato: comportamento normale sullo stato assegnabile non alterato dal nuovo guard", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { status: "new" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("20. CONC-03 invariato: overlap mezzo su stato assegnabile continua a produrre 409 VEHICLE_OVERLAP", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { status: "new", time: "10:00:00" })],
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: "other-service", group_id: "grp-other", vehicle_label: "Bus 1" }],
    });
    fake.tables.services.push(serviceRow("other-service", { time: "10:00:00" }));
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("VEHICLE_OVERLAP");
  });

  it("21. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "completato" })] });

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });

    expect(res.status).toBe(401);
    assertZeroWrites(fake);
  });

  it("22. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed({ services: [serviceRow(SERVICE_X, { status: "completato" })] });

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });

    expect(res.status).toBe(403);
    assertZeroWrites(fake);
  });

  it("23. risposta 409 sanificata: nessun dato cliente/tenant/query esposto", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { status: "cancelled", pickup_hotel: "Hotel Segreto" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toMatch(/Hotel Segreto/);
    expect(raw).not.toMatch(new RegExp(TENANT_A));
    expect(raw.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres|cancelled/);
  });
});
