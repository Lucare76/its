import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Test CONC-07 — storico strutturato (driver_assignment_history) sull'action
 * move_pax_between_buses (executeMovePax) di /api/ops/suggestions.
 *
 * executeMovePax sposta servizi da un bus/mezzo sorgente a un mezzo
 * destinazione aggiornando assignments.vehicle_label (update se
 * l'assignment esiste già, insert altrimenti con driver_user_id: null), ma
 * non registrava la variazione tramite logAssignmentChange. Il fix riusa
 * esattamente lo stesso contratto già validato in
 * move_services/swap_vehicle/assign-service/departure-bus-assign:
 * changeType "vehicle_binding". A differenza di swap_driver, questa action
 * non tocca mai driver_profile_id/driver_user_id (mai valorizzato in modo
 * diverso da null/invariato), quindi non genera mai "driver_swap": gli
 * scenari 3/5/6/7/8/20/21/22 dello spec CONC-07 sono N/A per questa action
 * e vengono dichiarati esplicitamente sotto.
 *
 * logAssignmentChange e updateLearnedPatterns sono mockati come spy: permette
 * di asserire con precisione gli argomenti (previous/new, actor, tenant,
 * changeType) senza dipendere dai dettagli interni della loro implementazione
 * reale (già testata altrove).
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_3 = "a3333333-3333-4333-8333-333333333333";
const SERVICE_TENANT_B = "a9999999-9999-4999-8999-999999999999";
const GROUP_1 = "c1111111-1111-4111-8111-111111111111";
const DRIVER_1 = "d0000000-0000-4000-8000-000000000000";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const VEHICLE_FROM = "Van 8";
const VEHICLE_TO = "Van 9";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/** Fake Supabase in-memory, tenant-aware — schema minimo per le tabelle usate da executeMovePax. */
function createTenantAwareSupabase(
  seed: Partial<Record<"services" | "assignments" | "hotels" | "bus_lot_configs" | "operations_suggestions" | "memberships", Row[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    assignments: [...(seed.assignments ?? [])],
    hotels: [...(seed.hotels ?? [])],
    bus_lot_configs: [...(seed.bus_lot_configs ?? [])],
    operations_suggestions: [...(seed.operations_suggestions ?? [])],
    // HARDENING SPRINT 1: markResolved() -> getOperatorName() queries
    // "memberships" (full_name lookup) on every successful executeMovePax
    // call. This table was never seeded, so any test reaching that code
    // path crashed on `.eq()` reading `undefined.filter` — a test-infra gap,
    // not a production bug (getOperatorName() already falls back to
    // auth.user.email when no row matches, exercised by leaving this empty
    // unless a test explicitly seeds it).
    memberships: [...(seed.memberships ?? [])],
  };

  const tableErrors: Record<string, { message: string } | undefined> = {};
  const tableUpdateErrors: Record<string, { message: string } | undefined> = {};
  let failForServiceId: { table: string; serviceId: string; err: { message: string } } | null = null;

  function makeQueryBuilder(table: string, op: "select" | "update", updatePayload?: Row) {
    const rows = tables[table];
    let filtered = rows;

    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      // Sprint Performance 14F: GET's fetchActiveServicesForSuggestions()
      // chains .not()/.order()/.range() on the services select. This test
      // exercises executeMovePax (POST), which reads services via the plain
      // loadState() Promise.all — no filter-semantics assertions here (those
      // are covered by tests/unit/operations-suggestions-parity.test.ts and
      // tests/unit/operations-suggestions-cache.test.ts), so these are inert
      // chain no-ops that just keep the builder callable end-to-end.
      not() {
        return builder;
      },
      order() {
        return builder;
      },
      range() {
        return builder;
      },
      // getOperatorName() calls .maybeSingle() on the memberships lookup.
      maybeSingle() {
        if (tableErrors[table]) return Promise.resolve({ data: null, error: tableErrors[table] });
        return Promise.resolve({ data: filtered[0] ? { ...filtered[0] } : null, error: null });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        if (
          op === "update"
          && failForServiceId
          && table === failForServiceId.table
          && filtered.some((r) => r.service_id === failForServiceId!.serviceId)
        ) {
          return Promise.resolve({ data: null, error: failForServiceId.err }).then(resolve, reject);
        }
        if (op === "update" && tableUpdateErrors[table]) {
          return Promise.resolve({ data: null, error: tableUpdateErrors[table] }).then(resolve, reject);
        }
        if (tableErrors[table]) {
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
        insert(rowsOrRow: Row | Row[]) {
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          return {
            then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              if (
                failForServiceId
                && table === failForServiceId.table
                && rowsArr.some((r) => r.service_id === failForServiceId!.serviceId)
              ) {
                return Promise.resolve({ data: null, error: failForServiceId.err }).then(resolve, reject);
              }
              if (tableErrors[table]) return Promise.resolve({ data: null, error: tableErrors[table] }).then(resolve, reject);
              // insert riuscito: persiste solo ora, mai in caso di errore sopra —
              // altrimenti un service "fallito" comparirebbe comunque nella tabella.
              const inserted = rowsArr.map((r) => ({ id: r.id ?? `assignments-${Math.random().toString(36).slice(2)}`, ...r }));
              tables[table].push(...inserted);
              return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
            },
          };
        },
        upsert(rowsOrRow: Row | Row[], opts: { onConflict?: string } = {}) {
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const conflictFields = (opts.onConflict ?? "id").split(",");
          const arr = tables[table];
          for (const row of rowsArr) {
            const existingIdx = arr.findIndex((r) => conflictFields.every((f) => r[f] === row[f]));
            if (existingIdx >= 0) Object.assign(arr[existingIdx], row);
            else arr.push({ id: row.id ?? `${table}-${Math.random().toString(36).slice(2)}`, ...row });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return {
    admin,
    tables,
    setError(table: string, err: { message: string } | null) {
      tableErrors[table] = err ?? undefined;
    },
    setUpdateError(table: string, err: { message: string } | null) {
      tableUpdateErrors[table] = err ?? undefined;
    },
    setFailForService(table: string, serviceId: string, err: { message: string }) {
      failForServiceId = { table, serviceId, err };
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  logAssignmentChange: vi.fn(),
  updateLearnedPatterns: vi.fn(),
  fetchAllServices: vi.fn(),
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
vi.mock("@/lib/server/fetch-all-services", () => ({
  fetchAllServices: mocks.fetchAllServices,
}));

import { POST } from "@/app/api/ops/suggestions/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: TEST_DATE,
    time: "10:00:00",
    direction: "departure",
    pax: 2,
    hotel_id: null,
    meeting_point: null,
    arrival_time: null,
    orario_barca: null,
    barca_compagnia: null,
    booking_service_kind: "transfer",
    service_type_code: null,
    vessel: null,
    ferry_details: null,
    status: "new",
    is_draft: false,
    billing_party_name: null,
    bus_city_origin: null,
    transport_code: null,
    ...overrides,
  };
}

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(SERVICE_1)],
    assignments: [
      { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
    ],
    hotels: [],
    bus_lot_configs: [],
    operations_suggestions: [],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/suggestions", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, userId: string = OPERATOR_1, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: `${userId}@test.dev` },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function movePaxBody(overrides: Record<string, unknown> = {}) {
  return {
    suggestion_id: "sugg-overcapacity-1",
    suggestion_type: "overcapacity",
    action_payload: {
      action: "move_pax_between_buses",
      from_bus_label: VEHICLE_FROM,
      to_bus_label: VEHICLE_TO,
      pax: 2,
      date: TEST_DATE,
      ...overrides,
    },
  };
}

function lastHistoryEntries(): Row[] {
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Row[];
}

function seedFetchAllServices(fake: ReturnType<typeof createTenantAwareSupabase>) {
  mocks.fetchAllServices.mockImplementation(async (_admin: unknown, tenantId: string) => ({
    data: fake.tables.services.filter((s) => s.tenant_id === tenantId).map((s) => ({ ...s })),
    error: null,
  }));
}

describe("CONC-07 — storico strutturato (driver_assignment_history) su move_pax_between_buses (executeMovePax)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. singolo servizio spostato: history scritto, changeType vehicle_binding", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("vehicle_binding");
    expect(entries[0].serviceId).toBe(SERVICE_1);
  });

  it("2. più servizi spostati (pax supera il primo servizio): un entry per ciascun service_id", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { pax: 2 }), serviceRow(SERVICE_2, { pax: 3, time: "14:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
      ],
    });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: 4 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2].sort());
  });

  it("3. cambio driver -> driver_swap: N/A, executeMovePax non modifica mai driver_user_id/driver_profile_id", () => {
    expect(true).toBe(true);
  });

  it("4. cambio mezzo -> vehicle_binding (copre anche lo scenario 5: driver+mezzo, qui il driver non cambia mai)", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody());

    const entries = lastHistoryEntries();
    expect(entries[0].changeType).toBe("vehicle_binding");
  });

  it("5. driver+mezzo -> un solo driver_swap: N/A, driver mai toccato da questa action", () => {
    expect(true).toBe(true);
  });

  it("6. solo group cambiato: N/A, executeMovePax non modifica mai group_id (nessun evento inventato)", () => {
    expect(true).toBe(true);
  });

  it("7. previous driver corretto / 8. new driver corretto: N/A, nessun campo driver nell'entry", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody());

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBeUndefined();
    expect(entries[0].toDriverProfileId).toBeUndefined();
    const updated = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(updated?.driver_user_id).toBe(DRIVER_1);
  });

  it("9. previous vehicle corretto", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody());

    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBe(VEHICLE_FROM);
  });

  it("9b. previous vehicle null (nessun assignment esistente, insert): evento comunque generato", async () => {
    const fake = baseSeed({ assignments: [] });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ from_bus_id: SERVICE_1 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBeNull();
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_TO);
    const inserted = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(inserted?.driver_user_id).toBeNull();
  });

  it("10. new vehicle corretto", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody());

    const entries = lastHistoryEntries();
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_TO);
  });

  it("11. groupId corretto nell'entry (preso dallo snapshot dell'assignment esistente)", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody());

    const entries = lastHistoryEntries();
    expect(entries[0].groupId).toBe(GROUP_1);
  });

  it("12. actor corretto: operatorId coincide con l'utente autenticato", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake, "operator-xyz");

    await callPost(movePaxBody());

    const entries = lastHistoryEntries();
    expect(entries[0].operatorId).toBe("operator-xyz");
  });

  it("13. tenant corretto: tenantId coincide con quello della sessione", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody());

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
  });

  it("14. tenant_id malevolo nel body viene ignorato: history usa il tenant di sessione", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost({ ...movePaxBody(), tenant_id: TENANT_B });

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
    expect(entries[0].tenantId).not.toBe(TENANT_B);
  });

  it("15. servizio di tenant B escluso: loadState filtra per tenant_id di sessione, nessuna entry lo riguarda", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_TENANT_B, { tenant_id: TENANT_B })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
        { id: "asg-b", tenant_id: TENANT_B, service_id: SERVICE_TENANT_B, group_id: null, driver_user_id: null, vehicle_label: VEHICLE_FROM },
      ],
    });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody());

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.serviceId !== SERVICE_TENANT_B)).toBe(true);
    const tenantBAssignment = fake.tables.assignments.find((a) => a.service_id === SERVICE_TENANT_B);
    expect(tenantBAssignment?.vehicle_label).toBe(VEHICLE_FROM);
  });

  it("16. service duplicato: N/A, i candidati sono derivati da services (id univoco), la selezione non può duplicare un service_id", () => {
    expect(true).toBe(true);
  });

  it("17. no-op (nessun candidato compatibile trovato): zero history, errore 500 gestito", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_TO },
      ],
    });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("18. nessun history su 401 (sessione non valida)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));

    const res = await callPost(movePaxBody());

    expect(res.status).toBe(401);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("19. nessun history su 403 (ruolo non autorizzato)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));

    const res = await callPost(movePaxBody());

    expect(res.status).toBe(403);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("20. SEC guard: N/A, executeMovePax non ha guard di sicurezza dedicate oltre auth/tenant scoping già coperti (14/15)", () => {
    expect(true).toBe(true);
  });

  it("21. FUNC guard / 22. availability/timeline/overlap: N/A, executeMovePax non esegue validazioni di business/timeline/overlap (a differenza di create_trip/update_trip/move_services/swap_driver)", () => {
    expect(true).toBe(true);
  });

  it("23. nessun history su body invalido (400, action non riconosciuta dallo schema Zod)", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ action: "not_a_valid_action" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("23b. nessun history su payload incompleto (pax mancante): errore gestito 500, come da comportamento preesistente", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: undefined }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("24. mutazione DB fallita (update assignments): zero history, errore propagato", async () => {
    const fake = baseSeed();
    fake.setUpdateError("assignments", { message: "update failed" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("25. snapshot fallito (errore lettura assignments in loadState): mutazione non eseguita, zero history", async () => {
    const fake = baseSeed();
    fake.setError("assignments", RAW_DB_ERROR);
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    const unchanged = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(unchanged?.vehicle_label).toBe(VEHICLE_FROM);
  });

  it("26. logAssignmentChange rigetta: risposta di successo invariata (fire-and-forget), nessun unhandled rejection", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost(movePaxBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
  });

  it("27. zero unhandled rejection: già verificato implicitamente dal test 26 (vitest fallisce su rejection non gestite)", () => {
    expect(true).toBe(true);
  });

  it("28. risposta HTTP invariata: stessa forma { ok, resolved, moved_services, moved_pax }", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["moved_pax", "moved_services", "ok", "resolved"].sort());
    expect(body.moved_services).toBe(1);
  });

  it("29. nessun doppio history: logAssignmentChange chiamato una sola volta per richiesta", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { pax: 2 }), serviceRow(SERVICE_2, { pax: 3, time: "14:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
      ],
    });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody({ pax: 4 }));

    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    const serviceIds = entries.map((e) => e.serviceId);
    expect(new Set(serviceIds).size).toBe(serviceIds.length);
  });

  it("30. learned patterns raggiunti tramite helper reale/mocked dopo il successo dello storico", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody());
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.updateLearnedPatterns).toHaveBeenCalledWith(fake.admin, TENANT_A);
  });

  it("30b. resolved: mark_resolved viene comunque eseguito dopo executeMovePax (comportamento preesistente invariato)", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody());

    const resolved = fake.tables.operations_suggestions.find((s) => s.suggestion_id === "sugg-overcapacity-1");
    expect(resolved?.resolved).toBe(true);
  });

  // ── PARTIAL SUCCESS + HISTORY FLUSH ─────────────────────────────────────
  // executeMovePax processa più service in sequenza in un unico loop. Se il
  // service N fallisce dopo che i service 1..N-1 sono già stati mutati con
  // successo in DB, il throw usciva dalla funzione PRIMA del flush unico di
  // fine loop, perdendo la history delle mutazioni già persistite. Il fix
  // avvolge il loop in un try/catch: il catch flusha le entry già raccolte
  // (mutazioni già committed) con lo stesso helper best-effort, poi ripropaga
  // l'errore originale invariato. Un solo punto di flush esegue per
  // invocazione (quello di fine try in caso di successo pieno, quello nel
  // catch in caso di fallimento parziale) — mai entrambi.
  function threeServiceSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
    return baseSeed({
      services: [
        serviceRow(SERVICE_1, { pax: 2 }),
        serviceRow(SERVICE_2, { pax: 2, time: "14:00:00" }),
        serviceRow(SERVICE_3, { pax: 2, time: "18:00:00" }),
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
        { id: "asg-3", tenant_id: TENANT_A, service_id: SERVICE_3, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
      ],
      ...overrides,
    });
  }

  it("31. A+B riusciti (nessun fallimento): history A+B in un'unica chiamata, comportamento di successo pieno invariato", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { pax: 2 }), serviceRow(SERVICE_2, { pax: 2, time: "14:00:00" })],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
      ],
    });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: 4 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries.map((e) => e.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2].sort());
  });

  it("32. A fallisce (primo service del batch): zero history, nessuna mutazione precedente da preservare", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_1, { message: "update failed on A" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: 6 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("update failed on A");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    const unchangedB = fake.tables.assignments.find((a) => a.service_id === SERVICE_2);
    expect(unchangedB?.vehicle_label).toBe(VEHICLE_FROM);
  });

  it("33. A riesce, B fallisce: history contiene solo A, B è escluso", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_2, { message: "update failed on B" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: 6 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("update failed on B");
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].serviceId).toBe(SERVICE_1);
    expect(entries.some((e) => e.serviceId === SERVICE_2)).toBe(false);
    // A mutato con successo in DB, B no (l'update per B è fallito prima di applicare il payload).
    const mutatedA = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    const untouchedB = fake.tables.assignments.find((a) => a.service_id === SERVICE_2);
    expect(mutatedA?.vehicle_label).toBe(VEHICLE_TO);
    expect(untouchedB?.vehicle_label).toBe(VEHICLE_FROM);
  });

  it("34. A+B riescono, C fallisce: history contiene A+B in un'unica chiamata, C escluso", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_3, { message: "update failed on C" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: 6 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("update failed on C");
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries.map((e) => e.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2].sort());
    expect(entries.some((e) => e.serviceId === SERVICE_3)).toBe(false);
  });

  it("35. errore originale della mutazione preservato esattamente (non mascherato dal flush)", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_2, { message: "vincolo univoco violato su assignments" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: 6 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("vincolo univoco violato su assignments");
  });

  it("36. logAssignmentChange rigetta durante il flush di partial-success: errore DB originale preservato, nessun dettaglio history esposto, nessun unhandled rejection", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_2, { message: "update failed on B" });
    seedFetchAllServices(fake);
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost(movePaxBody({ pax: 6 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("update failed on B");
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
  });

  it("37. nessun doppio flush: logAssignmentChange chiamato una sola volta anche in partial-success", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_3, { message: "update failed on C" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody({ pax: 6 }));

    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });

  it("38. previous/new corretti nelle entry del flush parziale", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_3, { message: "update failed on C" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody({ pax: 6 }));

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.fromVehicleLabel === VEHICLE_FROM)).toBe(true);
    expect(entries.every((e) => e.toVehicleLabel === VEHICLE_TO)).toBe(true);
  });

  it("39. actor corretto nel flush parziale", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_3, { message: "update failed on C" });
    seedFetchAllServices(fake);
    authorizeAs(fake, "operator-partial");

    await callPost(movePaxBody({ pax: 6 }));

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.operatorId === "operator-partial")).toBe(true);
  });

  it("40. tenant corretto nel flush parziale", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_3, { message: "update failed on C" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody({ pax: 6 }));

    const entries = lastHistoryEntries();
    expect(entries.every((e) => e.tenantId === TENANT_A)).toBe(true);
  });

  it("41. insert e update entrambi coperti nel flush parziale: A via insert (nessun assignment esistente, targeted via from_bus_id) riesce, B via update fallisce", async () => {
    // SERVICE_1 non ha alcun assignment esistente: diventa candidato solo se
    // targettato esplicitamente via from_bus_id (unico modo per selezionare
    // un service senza assignment — il matching per from_bus_label richiede
    // un vehicle_label esistente). SERVICE_2 ha un assignment esistente sul
    // mezzo sorgente: percorso update.
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { pax: 2 }), serviceRow(SERVICE_2, { pax: 2, time: "14:00:00" })],
      assignments: [
        { id: "asg-2", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: GROUP_1, driver_user_id: DRIVER_1, driver_profile_id: null, vehicle_label: VEHICLE_FROM },
      ],
    });
    fake.setFailForService("assignments", SERVICE_2, { message: "update failed on B" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: 4, from_bus_id: SERVICE_1 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("update failed on B");
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].serviceId).toBe(SERVICE_1);
    expect(entries[0].fromVehicleLabel).toBeNull();
    const insertedA = fake.tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(insertedA?.vehicle_label).toBe(VEHICLE_TO);
    expect(insertedA?.driver_user_id).toBeNull();
    const untouchedB = fake.tables.assignments.find((a) => a.service_id === SERVICE_2);
    expect(untouchedB?.vehicle_label).toBe(VEHICLE_FROM);
  });

  it("42. batch multi-service reale (3 service): A+B riusciti, C fallisce, risposta e history coerenti insieme", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_3, { message: "update failed on C" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: 6 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.serviceId)).size).toBe(2);
  });

  it("43. risposta di successo pieno invariata (regressione): stessa forma, nessun campo aggiunto dal fix", async () => {
    const fake = baseSeed();
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["moved_pax", "moved_services", "ok", "resolved"].sort());
  });

  it("44. risposta di errore invariata (partial failure): stessa forma { ok: false, error }", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_2, { message: "update failed on B" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    const res = await callPost(movePaxBody({ pax: 6 }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(Object.keys(body).sort()).toEqual(["error", "ok"].sort());
  });

  it("45. learned patterns non duplicati: updateLearnedPatterns chiamato una sola volta dopo il flush parziale", async () => {
    const fake = threeServiceSeed();
    fake.setFailForService("assignments", SERVICE_3, { message: "update failed on C" });
    seedFetchAllServices(fake);
    authorizeAs(fake);

    await callPost(movePaxBody({ pax: 6 }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.updateLearnedPatterns).toHaveBeenCalledTimes(1);
    expect(mocks.updateLearnedPatterns).toHaveBeenCalledWith(fake.admin, TENANT_A);
  });
});
