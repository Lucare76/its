import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Test CONC-07 — storico strutturato (driver_assignment_history) su
 * assign-service, tramite logAssignmentChange.
 *
 * assign-service modifica assignments/trip_groups/services ma non registrava
 * la variazione tramite lo stesso storico strutturato già usato da
 * piano-giorno/trips (changeType "driver_swap") e apply-vehicle-binding
 * (changeType "vehicle_binding"). Il fix aggiunge una scrittura
 * fire-and-forget verso logAssignmentChange, dopo che assignment/service/
 * status_events sono già stati scritti con successo, riusando esattamente lo
 * stesso contratto (nessun campo/changeType inventato).
 *
 * logAssignmentChange e updateLearnedPatterns sono mockati come spy: questo
 * permette di asserire con precisione gli argomenti (previous/new, actor,
 * tenant, changeType) senza dipendere dai dettagli interni della loro
 * implementazione reale (già testata altrove).
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_2 = "a2222222-2222-4222-8222-222222222222";
const PROFILE_1 = "p1111111-1111-4111-8111-111111111111";
const PROFILE_2 = "p2222222-2222-4222-8222-222222222222";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware. Stesso schema dei fake già usati
 * dagli altri test assign-service (driver-overlap/vehicle-overlap): applica
 * realmente eq/neq/in/maybeSingle, e arricchisce le righe di "assignments"
 * con il join `services` richiesto dai controlli di overlap.
 */
function createSupabase(
  seed: Partial<Record<
    "services" | "memberships" | "driver_profiles" | "assignments" | "trip_groups" | "daily_availability_confirmations" | "status_events" | "driver_assignment_history",
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
    driver_assignment_history: [...(seed.driver_assignment_history ?? [])],
  };

  const tableErrors: Record<string, { message: string } | null> = {};

  const calls = {
    assignmentsInserted: [] as Row[],
    assignmentsUpdated: 0,
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
            if (toRemove.has(rows[i])) rows.splice(i, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        for (const row of filtered) Object.assign(row, payload);
        if (table === "assignments") calls.assignmentsUpdated += filtered.length;
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
            return {
              select() {
                return { single: () => Promise.resolve({ data: inserted, error: null }) };
              },
            };
          }
          if (table === "assignments") {
            const key = `${row.service_id}:${row.tenant_id}`;
            const conflict = tables.assignments.some((a) => `${a.service_id}:${a.tenant_id}` === key);
            if (conflict) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
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
  extractFeatures: vi.fn(),
  logAssignmentChange: vi.fn(),
  updateLearnedPatterns: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
  buildAssignmentDecisionFeatures: (base, decision = {}) => ({ ...base, ...Object.fromEntries(Object.entries(decision).filter(([, v]) => v !== undefined)) }),
}));
vi.mock("@/lib/server/learned-patterns", () => ({
  updateLearnedPatterns: mocks.updateLearnedPatterns,
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
    meeting_point: "Ischia Porto",
    booking_service_kind: null,
    service_type_code: null,
    vessel: "SNAV",
    barca_compagnia: null,
    pax: 2,
    ...overrides,
  };
}

function baseSeed(overrides: Parameters<typeof createSupabase>[0] = {}) {
  return createSupabase({
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    driver_profiles: [
      { id: PROFILE_1, tenant_id: TENANT_A, active: true },
      { id: PROFILE_2, tenant_id: TENANT_A, active: true },
    ],
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

function authorizeAs(fake: ReturnType<typeof createSupabase>, userId: string = OPERATOR_1, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: `${userId}@test.dev` },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function lastHistoryCall(): Row[] {
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Row[];
}

describe("CONC-07 — storico strutturato (driver_assignment_history) su assign-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractFeatures.mockReturnValue({ mocked_features: true });
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. nuova assegnazione: history scritto una volta, changeType driver_swap", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryCall();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("driver_swap");
  });

  it("2. riassegnazione driver: previous/new driver corretti", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      trip_groups: [{ id: "grp-1", tenant_id: TENANT_A, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
    });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_2, vehicle_label: "Van 8" });

    const entries = lastHistoryCall();
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_1);
    expect(entries[0].toDriverProfileId).toBe(PROFILE_2);
  });

  it("3. cambio mezzo (driver invariato): changeType vehicle_binding, previous/new vehicle corretti, nessun campo driver", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      trip_groups: [{ id: "grp-1", tenant_id: TENANT_A, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
    });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 9" });

    const entries = lastHistoryCall();
    expect(entries[0].changeType).toBe("vehicle_binding");
    expect(entries[0].fromVehicleLabel).toBe("Van 8");
    expect(entries[0].toVehicleLabel).toBe("Van 9");
    expect(entries[0].fromDriverProfileId).toBeUndefined();
    expect(entries[0].toDriverProfileId).toBeUndefined();
  });

  it("4. cambio driver e mezzo insieme: changeType driver_swap, entrambi i previous/new corretti", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      trip_groups: [{ id: "grp-1", tenant_id: TENANT_A, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
    });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_2, vehicle_label: "Van 9" });

    const entries = lastHistoryCall();
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_1);
    expect(entries[0].toDriverProfileId).toBe(PROFILE_2);
    expect(entries[0].fromVehicleLabel).toBe("Van 8");
    expect(entries[0].toVehicleLabel).toBe("Van 9");
  });

  it("5. group_id precedente/nuovo: riusa il group_id esistente sul ramo update", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      trip_groups: [{ id: "grp-1", tenant_id: TENANT_A, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_2, vehicle_label: "Van 8" });
    const body = await res.json();

    expect(body.group_id).toBe("grp-1");
    const entries = lastHistoryCall();
    expect(entries[0].groupId).toBe("grp-1");
  });

  it("6. group_id nuovo: sul ramo insert usa il group_id appena creato", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });
    const body = await res.json();

    const entries = lastHistoryCall();
    expect(entries[0].groupId).toBe(body.group_id);
    expect(body.group_id).toBeTruthy();
  });

  it("7. assignment_source: la riga assignments scritta riporta manual_assign_service (invariato, non nel history)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });

    const inserted = fake.calls.assignmentsInserted[0];
    expect(inserted.assignment_source).toBe("manual_assign_service");
  });

  it("8. actor corretto: operatorId dell'history coincide con l'utente autenticato", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake, "operator-xyz");

    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });

    const entries = lastHistoryCall();
    expect(entries[0].operatorId).toBe("operator-xyz");
  });

  it("9. tenant corretto: tenantId dell'history coincide col tenant della sessione", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });

    const entries = lastHistoryCall();
    expect(entries[0].tenantId).toBe(TENANT_A);
  });

  it("10. service_id corretto nell'entry di history", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_2)] });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_2, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });

    const entries = lastHistoryCall();
    expect(entries[0].serviceId).toBe(SERVICE_2);
  });

  it("11. nessun history su 401 (sessione non valida)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1 });

    expect(res.status).toBe(401);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("12. nessun history su 403 (ruolo non autorizzato)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1 });

    expect(res.status).toBe(403);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("13. nessun history su 404 (servizio non trovato / tenant errato)", async () => {
    const fake = baseSeed({ services: [] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1 });

    expect(res.status).toBe(404);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("14. nessun history su DRIVER_NOT_FOUND (SEC-05)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)], driver_profiles: [] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1 });
    const body = await res.json();

    expect(body.error).toBe("DRIVER_NOT_FOUND");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("15. nessun history su DRIVER_NOT_ACTIVE (FUNC-03)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1)],
      driver_profiles: [{ id: PROFILE_1, tenant_id: TENANT_A, active: false }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1 });
    const body = await res.json();

    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("16. nessun history su SERVICE_NOT_ASSIGNABLE (FUNC-02)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1 });
    const body = await res.json();

    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("17. nessun history su DRIVER_OVERLAP (CONC-02)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "10:15:00" })],
      trip_groups: [{ id: "grp-1", tenant_id: TENANT_A, date: TEST_DATE, status: "active", driver_profile_id: PROFILE_1 }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: "grp-1" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1 });
    const body = await res.json();

    expect(body.error).toBe("DRIVER_OVERLAP");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("18. nessun history su VEHICLE_OVERLAP (CONC-03)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "10:15:00" })],
      trip_groups: [{ id: "grp-1", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Van 8" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: "grp-1" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, vehicle_label: "Van 8" });
    const body = await res.json();

    expect(body.error).toBe("VEHICLE_OVERLAP");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("19. nessun history sul perdente CONC-01 (conflitto 23505 da race reale)", async () => {
    // Stesso schema di runRace in assign-service-concurrency.test.ts: due
    // richieste concorrenti leggono entrambe "nessun assignment esistente"
    // prima che l'altra scriva, cosicché la seconda insert generi un vero
    // conflitto 23505 (non simulabile con una singola richiesta sequenziale,
    // dato che il ramo insert cancella prima l'eventuale riga precedente).
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    const [resA, resB] = await Promise.all([
      callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van A" }),
      callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_2, vehicle_label: "Van B" }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    const loserRes = resA.status === 409 ? resA : resB;
    const loserBody = await loserRes.json();

    expect(statuses).toEqual([200, 409]);
    expect(loserBody.error).toBe("SERVICE_ALREADY_ASSIGNED");
    // Il vincitore genera un history event, il perdente no: una sola call totale.
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });

  it("20. nessun history su errore insert assignment (500)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    // Forza l'errore sull'insert assignments sovrascrivendo temporaneamente l'admin.
    const originalFrom = fake.admin.from.bind(fake.admin);
    fake.admin.from = ((table: string) => {
      const base = originalFrom(table);
      if (table === "assignments") {
        return {
          ...base,
          insert: () => Promise.resolve({ data: null, error: { code: "53300", message: "too many connections" } }),
        };
      }
      return base;
    }) as typeof fake.admin.from;
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("ASSIGNMENT_FAILED");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("21. action remove: invariata, nessun history generato (nessun changeType di rimozione nel contratto esistente)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: null, driver_profile_id: PROFILE_1 }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, action: "remove" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.tables.assignments).toHaveLength(0);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("22. tenant_id malevolo nel body viene ignorato: history usa il tenant della sessione", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8", tenant_id: TENANT_B });

    const entries = lastHistoryCall();
    expect(entries[0].tenantId).toBe(TENANT_A);
    expect(entries[0].tenantId).not.toBe(TENANT_B);
  });

  it("23. risposta HTTP invariata: stessa forma { ok, group_id } del comportamento pre-CONC-07", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["group_id", "ok"]);
    expect(body.ok).toBe(true);
  });

  it("24. nessun nuovo evento auditLog introdotto dal path di history riuscito", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });

    // Nessuna chiamata auditLog attesa sul percorso di successo (comportamento
    // preesistente: auditLog viene usato solo sui rami di errore/conflitto).
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it("25. errore in logAssignmentChange non altera la risposta HTTP (fire-and-forget, stessa policy di trips/auto-assign)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
  });

  it("26. nessun history quando né driver né mezzo cambiano (no-op)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      trip_groups: [{ id: "grp-1", tenant_id: TENANT_A, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_profile_id: PROFILE_1, vehicle_label: "Van 8" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8" });

    expect(res.status).toBe(200);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("27. errore DB generico durante il fetch servizio: nessun history, 404 sanificato", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    fake.setTableError("services", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_1, driver_profile_id: PROFILE_1 });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Servizio non trovato.");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });
});
