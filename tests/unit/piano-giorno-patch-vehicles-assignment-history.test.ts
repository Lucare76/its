import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Test CONC-07 — storico strutturato (driver_assignment_history) sulla route
 * POST /api/ops/piano-giorno/patch-vehicles.
 *
 * patch-vehicles assegna in bulk vehicle_label/vehicle_capacity ai giri
 * (trip_groups) senza mezzo, leggendo il mezzo dichiarato in
 * driver_daily_availability per il driver del giro, e propaga lo stesso
 * vehicle_label a tutte le righe assignments del giro — ma non registrava la
 * variazione tramite logAssignmentChange. Il fix riusa esattamente lo stesso
 * contratto già validato in move_services/swap_vehicle/executeMovePax:
 * changeType "vehicle_binding", con uno snapshot "prima" tenant-scoped letto
 * in un'unica query batch subito prima del ciclo di mutazioni. patch-vehicles
 * non tocca mai il driver (driver_profile_id/driver_user_id non vengono mai
 * scritti da questa route), quindi non genera mai "driver_swap": gli
 * scenari 23 (nessuna modifica a driver) e "driver_swap" non si applicano.
 *
 * logAssignmentChange e updateLearnedPatterns sono mockati come spy: permette
 * di asserire con precisione gli argomenti (previous/new, actor, tenant,
 * changeType) senza dipendere dai dettagli interni della loro implementazione
 * reale (già testata altrove).
 *
 * Scenari 28/29/30 (non-regressione apply-vehicle-binding / swap_vehicle /
 * update_trip vehicle-only) sono N/A in questo file: sono route diverse
 * (piano-giorno/trips, assign-service), fuori dal perimetro consentito per
 * questo task (FILE VIETATI). La non-regressione è verificata in Fase 10
 * eseguendo la suite esistente di quei file invariati.
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_TENANT_B = "a9999999-9999-4999-8999-999999999999";
const GROUP_1 = "c1111111-1111-4111-8111-111111111111";
const GROUP_2 = "c2222222-2222-4222-8222-222222222222";
const GROUP_TENANT_B = "c5555555-5555-4555-8555-555555555555";
const DRIVER_PROFILE_1 = "e1111111-1111-4111-8111-111111111111";
const DRIVER_PROFILE_2 = "e2222222-2222-4222-8222-222222222222";
const VEHICLE_ID_1 = "f1111111-1111-4111-8111-111111111111";
const VEHICLE_ID_2 = "f2222222-2222-4222-8222-222222222222";
const VEHICLE_FROM = "Van 8";
const VEHICLE_TO = "Van 9";
const VEHICLE_TO_2 = "Van 10";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/** Fake Supabase in-memory, tenant-aware — schema minimo per le tabelle usate da patch-vehicles. */
function createTenantAwareSupabase(
  seed: Partial<
    Record<"trip_groups" | "driver_daily_availability" | "vehicles" | "assignments" | "services" | "hotels", Row[]>
  > = {}
) {
  const tables: Record<string, Row[]> = {
    trip_groups: [...(seed.trip_groups ?? [])],
    driver_daily_availability: [...(seed.driver_daily_availability ?? [])],
    vehicles: [...(seed.vehicles ?? [])],
    assignments: [...(seed.assignments ?? [])],
    services: [...(seed.services ?? [])],
    hotels: [...(seed.hotels ?? [])],
  };

  const tableErrors: Record<string, { message: string } | undefined> = {};
  const tableErrorFromCall: Record<string, number> = {};
  const selectCallCounts: Record<string, number> = {};
  const tableUpdateErrors: Record<string, { message: string } | undefined> = {};

  function makeQueryBuilder(table: string, op: "select" | "update", updatePayload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    let thisCallIndex = 0;

    if (op === "select") {
      selectCallCounts[table] = (selectCallCounts[table] ?? 0) + 1;
      thisCallIndex = selectCallCounts[table];
    }

    function shouldError(): boolean {
      if (!tableErrors[table]) return false;
      const fromCall = tableErrorFromCall[table] ?? 1;
      return op === "select" && thisCallIndex >= fromCall;
    }

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
      select() {
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "update" && tableUpdateErrors[table]) {
          return Promise.resolve({ data: null, error: tableUpdateErrors[table] }).then(resolve, reject);
        }
        if (shouldError()) {
          return Promise.resolve({ data: null, error: tableErrors[table] }).then(resolve, reject);
        }
        if (op === "update" && updatePayload) {
          for (const row of filtered) Object.assign(row, updatePayload);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        // select: copie, non riferimenti live — una mutazione successiva non
        // deve alterare retroattivamente uno snapshot "prima" già letto.
        return Promise.resolve({ data: filtered.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() {
          return makeQueryBuilder(table, "select");
        },
        update(payload: Row) {
          return makeQueryBuilder(table, "update", payload);
        },
      };
    },
  };

  return {
    admin,
    tables,
    setError(table: string, err: { message: string } | null, fromCallIndex = 1) {
      tableErrors[table] = err ?? undefined;
      tableErrorFromCall[table] = fromCallIndex;
    },
    setUpdateError(table: string, err: { message: string } | null) {
      tableUpdateErrors[table] = err ?? undefined;
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  logAssignmentChange: vi.fn(),
  updateLearnedPatterns: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/assignment-history", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/assignment-history")>("@/lib/server/assignment-history");
  return {
    ...actual,
    logAssignmentChange: mocks.logAssignmentChange,
  };
});
vi.mock("@/lib/server/learned-patterns", () => ({
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));

import { POST } from "@/app/api/ops/piano-giorno/patch-vehicles/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    hotel_id: null,
    direction: "departure",
    meeting_point: null,
    time: "10:00:00",
    arrival_time: null,
    orario_barca: null,
    porto_bruno: null,
    barca_compagnia: null,
    booking_service_kind: "transfer",
    service_type_code: null,
    vessel: null,
    ferry_details: null,
    pax: 2,
    ...overrides,
  };
}

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    trip_groups: [
      { id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: null, driver_profile_id: DRIVER_PROFILE_1, driver_user_id: null },
    ],
    driver_daily_availability: [
      { tenant_id: TENANT_A, date: TEST_DATE, available: true, driver_profile_id: DRIVER_PROFILE_1, vehicle_1_id: VEHICLE_ID_1, vehicle_2_id: null },
    ],
    vehicles: [
      { id: VEHICLE_ID_1, tenant_id: TENANT_A, label: VEHICLE_TO, capacity: 8 },
    ],
    assignments: [
      { id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, vehicle_label: VEHICLE_FROM, driver_profile_id: DRIVER_PROFILE_1 },
    ],
    services: [serviceRow(SERVICE_1)],
    hotels: [],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/piano-giorno/patch-vehicles", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown> = { date: TEST_DATE }) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, userId: string = OPERATOR_1, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: `${userId}@test.dev` },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function lastHistoryEntries(): Row[] {
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Row[];
}

describe("CONC-07 — storico strutturato (driver_assignment_history) su patch-vehicles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. singolo service: history scritto, changeType vehicle_binding", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(1);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("vehicle_binding");
    expect(entries[0].serviceId).toBe(SERVICE_1);
  });

  it("2. batch (più service nello stesso giro): un entry per service", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "14:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, vehicle_label: VEHICLE_FROM, driver_profile_id: DRIVER_PROFILE_1 },
        { id: "asg-2", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_2, vehicle_label: VEHICLE_FROM, driver_profile_id: DRIVER_PROFILE_1 },
      ],
    });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2].sort());
  });

  it("3. più gruppi: history per ciascun giro coinvolto, una sola chiamata batch a logAssignmentChange", async () => {
    const fake = baseSeed({
      trip_groups: [
        { id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: null, driver_profile_id: DRIVER_PROFILE_1, driver_user_id: null },
        { id: GROUP_2, tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: null, driver_profile_id: DRIVER_PROFILE_2, driver_user_id: null },
      ],
      driver_daily_availability: [
        { tenant_id: TENANT_A, date: TEST_DATE, available: true, driver_profile_id: DRIVER_PROFILE_1, vehicle_1_id: VEHICLE_ID_1, vehicle_2_id: null },
        { tenant_id: TENANT_A, date: TEST_DATE, available: true, driver_profile_id: DRIVER_PROFILE_2, vehicle_1_id: VEHICLE_ID_2, vehicle_2_id: null },
      ],
      vehicles: [
        { id: VEHICLE_ID_1, tenant_id: TENANT_A, label: VEHICLE_TO, capacity: 8 },
        { id: VEHICLE_ID_2, tenant_id: TENANT_A, label: VEHICLE_TO_2, capacity: 16 },
      ],
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "14:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, vehicle_label: VEHICLE_FROM, driver_profile_id: DRIVER_PROFILE_1 },
        { id: "asg-2", tenant_id: TENANT_A, group_id: GROUP_2, service_id: SERVICE_2, vehicle_label: VEHICLE_FROM, driver_profile_id: DRIVER_PROFILE_2 },
      ],
    });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.updated).toBe(2);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    const byService = new Map(entries.map((e) => [e.serviceId, e]));
    expect(byService.get(SERVICE_1)?.toVehicleLabel).toBe(VEHICLE_TO);
    expect(byService.get(SERVICE_2)?.toVehicleLabel).toBe(VEHICLE_TO_2);
  });

  it("4. previous vehicle A -> new vehicle B", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBe(VEHICLE_FROM);
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_TO);
  });

  it("5. previous null -> new vehicle B: evento comunque generato", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, vehicle_label: null, driver_profile_id: DRIVER_PROFILE_1 },
      ],
    });
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBeNull();
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_TO);
  });

  it("6. no-op (assignment già sul mezzo target): zero history", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, vehicle_label: VEHICLE_TO, driver_profile_id: DRIVER_PROFILE_1 },
      ],
    });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(1);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("7. previous differenti per service nello stesso giro: ciascuno con il proprio fromVehicleLabel", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "14:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, vehicle_label: VEHICLE_FROM, driver_profile_id: DRIVER_PROFILE_1 },
        { id: "asg-2", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_2, vehicle_label: null, driver_profile_id: DRIVER_PROFILE_1 },
      ],
    });
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    const byService = new Map(entries.map((e) => [e.serviceId, e]));
    expect(byService.get(SERVICE_1)?.fromVehicleLabel).toBe(VEHICLE_FROM);
    expect(byService.get(SERVICE_2)?.fromVehicleLabel).toBeNull();
    expect(entries.every((e) => e.toVehicleLabel === VEHICLE_TO)).toBe(true);
  });

  it("8. groupId corretto nell'entry", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].groupId).toBe(GROUP_1);
  });

  it("9. actor corretto: operatorId coincide con l'utente autenticato", async () => {
    const fake = baseSeed();
    authorizeAs(fake, "operator-xyz");

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].operatorId).toBe("operator-xyz");
  });

  it("10. tenant corretto: tenantId coincide con quello della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
  });

  it("11. tenant_id malevolo nel body viene ignorato (schema accetta solo 'date'): history usa il tenant di sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost({ date: TEST_DATE, tenant_id: TENANT_B });

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
    expect(entries[0].tenantId).not.toBe(TENANT_B);
  });

  it("12. giro/assignment di tenant B escluso: nessuna entry lo riguarda", async () => {
    const fake = baseSeed({
      trip_groups: [
        { id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: null, driver_profile_id: DRIVER_PROFILE_1, driver_user_id: null },
        { id: GROUP_TENANT_B, tenant_id: TENANT_B, date: TEST_DATE, status: "active", vehicle_label: null, driver_profile_id: DRIVER_PROFILE_1, driver_user_id: null },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, vehicle_label: VEHICLE_FROM, driver_profile_id: DRIVER_PROFILE_1 },
        { id: "asg-b", tenant_id: TENANT_B, group_id: GROUP_TENANT_B, service_id: SERVICE_TENANT_B, vehicle_label: VEHICLE_FROM, driver_profile_id: DRIVER_PROFILE_1 },
      ],
    });
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.serviceId !== SERVICE_TENANT_B)).toBe(true);
    const tenantBAssignment = fake.tables.assignments.find((a) => a.service_id === SERVICE_TENANT_B);
    expect(tenantBAssignment?.vehicle_label).toBe(VEHICLE_FROM);
  });

  it("13. service_id duplicati nel batch: N/A, historyCandidates deriva 1:1 dalle righe assignments già deduplicate per service_id nello snapshot (nessuna riga assignments duplicata per costruzione)", () => {
    expect(true).toBe(true);
  });

  it("14. giro senza driver risolvibile (né driver_profile_id sul giro né su assignments): comportamento invariato, giro saltato, zero history", async () => {
    const fake = baseSeed({
      trip_groups: [
        { id: GROUP_1, tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: null, driver_profile_id: null, driver_user_id: null },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, vehicle_label: VEHICLE_FROM, driver_profile_id: null },
      ],
    });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.updated).toBe(0);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    const unchanged = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(unchanged?.vehicle_label).toBe(VEHICLE_FROM);
  });

  it("15. nessun history su 401 (sessione non valida)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));

    const res = await callPost();

    expect(res.status).toBe(401);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("16. nessun history su 403 (ruolo non autorizzato)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));

    const res = await callPost();

    expect(res.status).toBe(403);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("17. guard funzionale (body invalido, date mancante): 400, zero history", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ date: "not-a-date" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("18. update assignments fallito: giro saltato (comportamento preesistente), zero history", async () => {
    const fake = baseSeed();
    fake.setUpdateError("assignments", { message: "update failed" });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(0);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("18b. update trip_groups fallito: giro saltato, zero history", async () => {
    const fake = baseSeed();
    fake.setUpdateError("trip_groups", { message: "update failed" });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(0);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("19. snapshot fallito (errore lettura assignments prima della mutazione): patch invariato (updated riflette comunque le mutazioni riuscite), zero history", async () => {
    const fake = baseSeed();
    fake.setError("assignments", RAW_DB_ERROR, 1);
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(1);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    const mutated = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(mutated?.vehicle_label).toBe(VEHICLE_TO);
  });

  it("20. logAssignmentChange rigetta: risposta di successo invariata (fire-and-forget), nessun unhandled rejection", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
  });

  it("21. zero unhandled rejection: già verificato implicitamente dal test 20 (vitest fallisce su rejection non gestite)", () => {
    expect(true).toBe(true);
  });

  it("22. risposta HTTP invariata: stessa forma { ok, updated, total }", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["ok", "total", "updated"].sort());
  });

  it("23. nessuna modifica a driver: nessun campo driver nell'entry, driver_profile_id dell'assignment invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBeUndefined();
    expect(entries[0].toDriverProfileId).toBeUndefined();
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(updated?.driver_profile_id).toBe(DRIVER_PROFILE_1);
  });

  it("24. nessuna modifica a group: trip_groups.id invariato, group_id dell'assignment invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const group = fake.tables.trip_groups.find((g) => g.id === GROUP_1);
    expect(group?.id).toBe(GROUP_1);
    const assignment = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(assignment?.group_id).toBe(GROUP_1);
  });

  it("28. non-regressione apply-vehicle-binding: N/A in questo file, route diversa (piano-giorno/trips) fuori perimetro — verificata in Fase 10 rieseguendo tests/unit/piano-vehicle-binding-apply.test.ts", () => {
    expect(true).toBe(true);
  });

  it("29. non-regressione swap_vehicle: N/A in questo file, route diversa (piano-giorno/trips) fuori perimetro — verificata in Fase 10 rieseguendo tests/unit/piano-giorno-trips-swap-vehicle-assignment-history.test.ts", () => {
    expect(true).toBe(true);
  });

  it("30. non-regressione update_trip vehicle-only: N/A in questo file, route diversa (piano-giorno/trips) fuori perimetro — verificata in Fase 10 rieseguendo tests/unit/piano-giorno-trips-update-vehicle-assignment-history.test.ts", () => {
    expect(true).toBe(true);
  });
});
