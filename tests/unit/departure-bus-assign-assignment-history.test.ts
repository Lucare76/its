import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Test CONC-07 — storico strutturato (driver_assignment_history) su
 * departure-bus-assign, azione assign_driver.
 *
 * assign_driver modifica assignments (upsert su un batch di service_ids) e
 * invia push, ma non registrava la variazione tramite logAssignmentChange,
 * a differenza di piano-giorno/trips, auto-assign e assign-service (già
 * corretto). Il fix aggiunge una scrittura fire-and-forget verso
 * logAssignmentChange, dopo che l'upsert è già riuscito, riusando lo stesso
 * contratto/precedenza già implementato in assign-service (driver_swap se il
 * driver cambia, vehicle_binding se cambia solo il mezzo). Differenza
 * obbligata: questa route conosce solo driver_user_id (mai
 * driver_profile_id dal client), quindi il "cambiamento" è rilevato via
 * driver_user_id; driver_profile_id viene comunque popolato nell'entry
 * quando disponibile (snapshot per il "prima", lookup tenant-scoped per il
 * "dopo"), restando compatibile con lo schema esistente.
 *
 * validateDriverGeographicBatch è mockato (comportamento reale già coperto
 * da altri file, incluso lo scenario di conflitto geografico) per costruire
 * deterministicamente lo scenario "nessun history su conflitto geografico"
 * senza dover replicare qui la logica di calcolo delle finestre geografiche.
 * logAssignmentChange/extractFeatures/updateLearnedPatterns sono mockati
 * come spy per asserire con precisione gli argomenti (previous/new, actor,
 * tenant, changeType, deduplica batch) senza dipendere dai dettagli interni
 * della loro implementazione reale (già testata altrove).
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_OTHER = "a3333333-3333-4333-8333-333333333333";
const DRIVER_1 = "d1111111-1111-4111-8111-111111111111";
const DRIVER_2 = "d2222222-2222-4222-8222-222222222222";
const PROFILE_1 = "p1111111-1111-4111-8111-111111111111";
const PROFILE_2 = "p2222222-2222-4222-8222-222222222222";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

/**
 * Fake Supabase in-memory, tenant-aware, generico (nessuna disambiguazione
 * per tabella): applica realmente eq/in/not/maybeSingle sulle tabelle
 * coinvolte, arricchisce le righe di "assignments" con il join `services`
 * richiesto da FUNC-01 (validazione geografica esclusa, mockata) e dai
 * controlli overlap CONC-02/CONC-03 residui.
 */
function createSupabase(
  seed: Partial<Record<
    "services" | "memberships" | "driver_profiles" | "assignments" | "daily_availability_confirmations" | "driver_assignment_history",
    Row[]
  >> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    memberships: [...(seed.memberships ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    assignments: [...(seed.assignments ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    driver_assignment_history: [...(seed.driver_assignment_history ?? [])],
  };

  const tableErrors: Record<string, { message: string } | null> = {};

  const calls = {
    assignmentsUpsertCalls: 0,
    upsertedRows: [] as Row[],
    assignmentsDeleteCalls: 0,
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
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      not(field: string, _op: string, value: unknown) {
        filtered = filtered.filter((r) => (r[field] ?? null) !== value);
        return builder;
      },
      order() {
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
        insert(rows: Row | Row[]) {
          const rowsArr = Array.isArray(rows) ? rows : [rows];
          tables[table].push(...rowsArr);
          return Promise.resolve({ data: rowsArr, error: null });
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
  validateDriverGeographicBatch: vi.fn(),
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
vi.mock("@/lib/server/web-push", () => ({
  sendPushToUser: mocks.sendPushToUser,
}));
vi.mock("@/lib/server/geo-assignment", () => ({
  validateDriverGeographicBatch: mocks.validateDriverGeographicBatch,
}));
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
  buildAssignmentDecisionFeatures: (base, decision = {}) => ({ ...base, ...Object.fromEntries(Object.entries(decision).filter(([, v]) => v !== undefined)) }),
}));
vi.mock("@/lib/server/learned-patterns", () => ({
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));

import { POST, GET } from "@/app/api/ops/departure-bus-assign/route";

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
    arrival_time: null,
    orario_barca: null,
    porto_bruno: null,
    barca_compagnia: null,
    booking_service_kind: null,
    service_type_code: null,
    vessel: "SNAV",
    ferry_details: null,
    ...overrides,
  };
}

function baseSeed(overrides: Parameters<typeof createSupabase>[0] = {}) {
  return createSupabase({
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    memberships: [
      { tenant_id: TENANT_A, user_id: DRIVER_1, role: "driver", suspended: false, full_name: "Autista Uno" },
      { tenant_id: TENANT_A, user_id: DRIVER_2, role: "driver", suspended: false, full_name: "Autista Due" },
    ],
    driver_profiles: [
      { id: PROFILE_1, tenant_id: TENANT_A, user_id: DRIVER_1, active: true, full_name: "Autista Uno", phone: null },
      { id: PROFILE_2, tenant_id: TENANT_A, user_id: DRIVER_2, active: true, full_name: "Autista Due", phone: null },
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
function callGet() {
  return GET(
    new NextRequest("http://localhost:3010/api/ops/departure-bus-assign", {
      method: "GET",
      headers: { authorization: "Bearer test-token" },
    })
  );
}

function authorizeAs(fake: ReturnType<typeof createSupabase>, userId: string = OPERATOR_1, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: `${userId}@test.dev` },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function assignBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "assign_driver",
    service_ids: [SERVICE_1],
    driver_user_id: DRIVER_1,
    vehicle_label: "DEP_BUS:1",
    ...overrides,
  };
}

function lastHistoryCall(): Row[] {
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Row[];
}

describe("CONC-07 — storico strutturato (driver_assignment_history) su departure-bus-assign (assign_driver)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateDriverGeographicBatch.mockResolvedValue({ ok: true });
    mocks.extractFeatures.mockReturnValue({ mocked_features: true });
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. nuova assegnazione singola: history scritto una volta, changeType driver_swap", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryCall();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("driver_swap");
  });

  it("2. nuova assegnazione batch: un entry per service_id", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "10:30:00" })] });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_1, SERVICE_2] }));
    expect(res.status).toBe(200);

    const entries = lastHistoryCall();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2].sort());
  });

  it("3. riassegnazione driver: previous/new driver_profile_id corretti", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "DEP_BUS:1", group_id: null }],
    });
    authorizeAs(fake);

    await callPost(assignBody({ driver_user_id: DRIVER_2 }));

    const entries = lastHistoryCall();
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_1);
    expect(entries[0].toDriverProfileId).toBe(PROFILE_2);
  });

  it("4. cambio mezzo (driver invariato): changeType vehicle_binding, previous/new vehicle corretti, nessun campo driver", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "DEP_BUS:OLD", group_id: null }],
    });
    authorizeAs(fake);

    await callPost(assignBody({ vehicle_label: "DEP_BUS:NEW" }));

    const entries = lastHistoryCall();
    expect(entries[0].changeType).toBe("vehicle_binding");
    expect(entries[0].fromVehicleLabel).toBe("DEP_BUS:OLD");
    expect(entries[0].toVehicleLabel).toBe("DEP_BUS:NEW");
    expect(entries[0].fromDriverProfileId).toBeUndefined();
    expect(entries[0].toDriverProfileId).toBeUndefined();
  });

  it("5. cambio driver e mezzo insieme: changeType driver_swap, entrambi i previous/new corretti", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "DEP_BUS:OLD", group_id: null }],
    });
    authorizeAs(fake);

    await callPost(assignBody({ driver_user_id: DRIVER_2, vehicle_label: "DEP_BUS:NEW" }));

    const entries = lastHistoryCall();
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_1);
    expect(entries[0].toDriverProfileId).toBe(PROFILE_2);
    expect(entries[0].fromVehicleLabel).toBe("DEP_BUS:OLD");
    expect(entries[0].toVehicleLabel).toBe("DEP_BUS:NEW");
  });

  it("6. group_id precedente valorizzato: new group sempre null per design (nessun trip_group in questa route)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "DEP_BUS:1", group_id: "grp-old" }],
    });
    authorizeAs(fake);

    await callPost(assignBody({ driver_user_id: DRIVER_2 }));

    const entries = lastHistoryCall();
    expect(entries[0].groupId).toBeNull();
  });

  it("7. assignment precedente da auto-assign: previous driver_profile_id letto dallo snapshot reale", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      assignments: [{
        id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1,
        driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 8",
        group_id: "grp-auto", assignment_source: "auto_assign", locked_by_operator: false,
      }],
    });
    authorizeAs(fake);

    await callPost(assignBody({ driver_user_id: DRIVER_2 }));

    const entries = lastHistoryCall();
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_1);
    expect(entries[0].fromVehicleLabel).toBe("Van 8");
  });

  it("8. assignment precedente da assign-service: previous driver_profile_id/vehicle letti dallo snapshot reale", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      assignments: [{
        id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1,
        driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 9",
        group_id: "grp-manual", assignment_source: "manual_assign_service", locked_by_operator: true,
      }],
    });
    authorizeAs(fake);

    await callPost(assignBody({ driver_user_id: DRIVER_2, vehicle_label: "DEP_BUS:NEW" }));

    const entries = lastHistoryCall();
    expect(entries[0].fromDriverProfileId).toBe(PROFILE_1);
    expect(entries[0].fromVehicleLabel).toBe("Van 9");
  });

  it("9. actor corretto: operatorId dell'history coincide con l'utente autenticato", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake, "operator-xyz");

    await callPost(assignBody());

    const entries = lastHistoryCall();
    expect(entries[0].operatorId).toBe("operator-xyz");
  });

  it("10. tenant corretto: tenantId dell'history coincide col tenant della sessione", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    await callPost(assignBody());

    const entries = lastHistoryCall();
    expect(entries[0].tenantId).toBe(TENANT_A);
  });

  it("11. service_id corretto per ogni entry del batch", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "10:30:00" })] });
    authorizeAs(fake);

    await callPost(assignBody({ service_ids: [SERVICE_1, SERVICE_2] }));

    const entries = lastHistoryCall();
    const byService = new Map(entries.map((e) => [e.serviceId, e]));
    expect(byService.get(SERVICE_1)).toBeTruthy();
    expect(byService.get(SERVICE_2)).toBeTruthy();
  });

  it("12. nessun history su 401 (sessione non valida)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const res = await callPost(assignBody());

    expect(res.status).toBe(401);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("13. nessun history su 403 (ruolo non autorizzato)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const res = await callPost(assignBody());

    expect(res.status).toBe(403);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("14. nessun history su SEC-01 (service_id di un altro tenant)", async () => {
    const fake = baseSeed({
      services: [{ id: SERVICE_OTHER, tenant_id: TENANT_B, date: TEST_DATE, status: "new", is_draft: false, time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: null }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_OTHER] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Uno o più servizi non trovati.");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("15. nessun history su DRIVER_NOT_FOUND (SEC-05)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)], memberships: [] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(body.error).toBe("DRIVER_NOT_FOUND");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("16. nessun history su DRIVER_NOT_ACTIVE (FUNC-03)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1)],
      memberships: [{ tenant_id: TENANT_A, user_id: DRIVER_1, role: "driver", suspended: true }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("17. nessun history su SERVICE_NOT_ASSIGNABLE (FUNC-02)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1, { status: "cancelled" })] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("18. nessun history su availability non confermata", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)], daily_availability_confirmations: [] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(body.error).toBe("DAILY_AVAILABILITY_NOT_CONFIRMED");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("19. nessun history su conflitto geografico", async () => {
    mocks.validateDriverGeographicBatch.mockResolvedValueOnce({ ok: false, kind: "block", error: "conflitto geografico" });
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_GEOGRAPHIC_CONFLICT");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("20. nessun history su DRIVER_OVERLAP (CONC-02 residuo)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_OTHER, { time: "10:15:00" })],
      assignments: [{ id: "asg-ext", tenant_id: TENANT_A, service_id: SERVICE_OTHER, driver_user_id: DRIVER_1, vehicle_label: "Altro Bus", group_id: null }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(body.error).toBe("DRIVER_OVERLAP");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("21. nessun history su VEHICLE_OVERLAP (CONC-03 residuo)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_OTHER, { time: "10:15:00" })],
      assignments: [{ id: "asg-ext", tenant_id: TENANT_A, service_id: SERVICE_OTHER, driver_user_id: DRIVER_2, vehicle_label: "DEP_BUS:1", group_id: null }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(body.error).toBe("VEHICLE_OVERLAP");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("22. nessun history su errore upsert (500)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    fake.setUpsertError({ message: "connection reset" });
    authorizeAs(fake);

    const res = await callPost(assignBody());

    expect(res.status).toBe(500);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("23. errore logAssignmentChange non altera la risposta di successo (fire-and-forget, best-effort)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("24. zero unhandled rejection: il fallimento di logAssignmentChange non genera eccezioni non gestite", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("boom"));

    const listener = vi.fn();
    process.on("unhandledRejection", listener);
    await callPost(assignBody());
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", listener);

    expect(listener).not.toHaveBeenCalled();
  });

  it("25. remove_driver invariata: nessun history generato", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, driver_user_id: DRIVER_1, group_id: null }],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "remove_driver", service_ids: [SERVICE_1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.tables.assignments).toHaveLength(0);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("26. create_driver_account invariata: nessun history, nessuna tabella assignments/driver_profiles toccata", async () => {
    mocks.authorizePricingRequest.mockResolvedValue({
      admin: { from: () => { throw new Error("create_driver_account non deve toccare il DB oltre driver_profiles/memberships (validato altrove)"); } },
      user: { id: OPERATOR_1, email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callPost({ action: "create_driver_account", driver_profile_id: "", email: "" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "driver_profile_id e email richiesti" });
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("27. GET invariata: nessun history coinvolto", async () => {
    const fake = baseSeed({ services: [] });
    authorizeAs(fake);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("28. tenant_id malevolo nel body viene ignorato: history usa il tenant della sessione", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    await callPost(assignBody({ tenant_id: TENANT_B }));

    const entries = lastHistoryCall();
    expect(entries[0].tenantId).toBe(TENANT_A);
    expect(entries[0].tenantId).not.toBe(TENANT_B);
  });

  it("29. batch con duplicati: nessun doppio history per lo stesso service_id", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    await callPost(assignBody({ service_ids: [SERVICE_1, SERVICE_1, SERVICE_1] }));

    const entries = lastHistoryCall();
    expect(entries).toHaveLength(1);
  });

  it("30. risposta assign_driver invariata: { ok: true }, nessun campo aggiuntivo", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(body).toEqual({ ok: true });
  });

  it("31. push invariato su successo: sendPushToUser chiamato con lo stesso contenuto di prima", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1)] });
    authorizeAs(fake);

    await callPost(assignBody());

    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(mocks.sendPushToUser).toHaveBeenCalledWith(
      TENANT_A,
      DRIVER_1,
      expect.objectContaining({ title: "Nuovo bus assegnato", tag: "dep-bus-assign" })
    );
  });

  it("32. zero push sui rifiuti (guard failure)", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_1, { status: "cancelled" })] });
    authorizeAs(fake);

    await callPost(assignBody());

    expect(mocks.sendPushToUser).not.toHaveBeenCalled();
  });

  it("33. nessun history quando né driver né mezzo cambiano (no-op)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "assigned" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "DEP_BUS:1", group_id: null }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody());

    expect(res.status).toBe(200);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("34. batch parzialmente idempotente: solo i service_id realmente cambiati producono entry", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "10:30:00" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "DEP_BUS:1", group_id: null }],
    });
    authorizeAs(fake);

    await callPost(assignBody({ service_ids: [SERVICE_1, SERVICE_2] }));

    const entries = lastHistoryCall();
    expect(entries).toHaveLength(1);
    expect(entries[0].serviceId).toBe(SERVICE_2);
  });

  it("35. isolamento tenant: un assignment su TENANT_B con lo stesso service_id non contamina lo snapshot 'prima' di TENANT_A", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1)],
      // Riga "gemella" su un altro tenant, stesso service_id, driver diverso:
      // la snapshot query CONC-07 filtra .eq("tenant_id", tenantId), quindi
      // non deve mai essere osservata dalla richiesta di TENANT_A.
      assignments: [{ id: "asg-tenant-b", tenant_id: TENANT_B, service_id: SERVICE_1, driver_user_id: DRIVER_2, driver_profile_id: PROFILE_2, vehicle_label: "Van Estraneo", group_id: null }],
    });
    authorizeAs(fake);

    await callPost(assignBody());

    const entries = lastHistoryCall();
    // Nessuna riga precedente per TENANT_A: previous è null (nuova
    // assegnazione), non i valori della riga di TENANT_B.
    expect(entries[0].fromDriverProfileId).toBeNull();
    expect(entries[0].fromVehicleLabel).toBeNull();
    expect(entries[0].toDriverProfileId).toBe(PROFILE_1);
  });
});
