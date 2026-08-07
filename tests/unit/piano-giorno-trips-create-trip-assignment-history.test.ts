import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Test CONC-07 — storico strutturato (driver_assignment_history) sull'action
 * create_trip di piano-giorno/trips.
 *
 * create_trip crea un nuovo trip_group e assegna i service_ids tramite
 * _assignServicesToGroup (helper condiviso con move_services, upsert su
 * assignments), ma non registrava la nuova assegnazione tramite
 * logAssignmentChange. Il fix riusa esattamente lo stesso contratto già
 * validato in move_services/assign-service/departure-bus-assign/swap_driver/
 * swap_vehicle (changeType "driver_swap" se il driver è cambiato, altrimenti
 * "vehicle_binding" se è cambiato solo il mezzo), con uno snapshot "prima"
 * tenant-scoped letto subito prima dell'upsert — _assignServicesToGroup fa
 * un upsert su (service_id, tenant_id), quindi un servizio può già avere un
 * assignment preesistente (es. da auto-assign) che l'upsert sovrascrive:
 * "previous" non è mai assunto null per default. Poiché
 * _assignServicesToGroup non propaga errori, la "conferma successo" arriva
 * da una rilettura tenant-scoped degli assignments realmente scritti con
 * group_id = groupId.
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
const DRIVER_1 = "d0000000-0000-4000-8000-000000000000";
const DRIVER_SUSPENDED = "d1111111-1111-4111-8111-111111111112";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const PROFILE_1 = "p0000000-0000-4000-8000-000000000000";
const OPERATOR_1 = "u1111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";
const VEHICLE_LABEL = "Van 8";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware — stesso schema riusato dai file
 * piano-giorno-trips-{move-services,swap-driver,swap-vehicle}-assignment-history.test.ts,
 * esteso per supportare l'upsert su "assignments" (usato da
 * _assignServicesToGroup con onConflict "service_id,tenant_id").
 */
function createTenantAwareSupabase(
  seed: Partial<
    Record<
      | "services"
      | "assignments"
      | "trip_groups"
      | "driver_daily_availability"
      | "driver_profiles"
      | "memberships"
      | "hotels"
      | "daily_availability_confirmations"
      | "vehicles"
      | "status_events",
      Row[]
    >
  > = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    driver_daily_availability: [...(seed.driver_daily_availability ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    memberships: [...(seed.memberships ?? [])],
    hotels: [...(seed.hotels ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    vehicles: [...(seed.vehicles ?? [])],
    status_events: [...(seed.status_events ?? [])],
  };

  const tableErrors: Record<string, { message: string } | undefined> = {};
  const tableErrorFromCall: Record<string, number> = {};
  const selectCallCounts: Record<string, number> = {};
  const tableInsertErrors: Record<string, { message: string } | undefined> = {};

  const calls = {
    tripGroupsInserts: 0,
    assignmentsUpserts: 0,
  };

  function makeQueryBuilder(table: string, op: "select" | "delete" | "update", updatePayload?: Row) {
    const rows = tables[table];
    let filtered = rows;
    let limitN: number | null = null;
    let thisCallIndex = 0;

    function cloneRow(row: Row): Row {
      if (table !== "assignments") return { ...row };
      return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
    }

    if (op === "select") {
      selectCallCounts[table] = (selectCallCounts[table] ?? 0) + 1;
      thisCallIndex = selectCallCounts[table];
    }

    function shouldError(): boolean {
      if (!tableErrors[table]) return false;
      const fromCall = tableErrorFromCall[table] ?? 1;
      return op === "select" ? thisCallIndex >= fromCall : true;
    }

    function resolveScope() {
      if (limitN !== null) filtered = filtered.slice(0, limitN);
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
      order(field: string, opts?: { ascending?: boolean }) {
        const ascending = opts?.ascending !== false;
        filtered = [...filtered].sort((a, b) => {
          const av = a[field] as string;
          const bv = b[field] as string;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      select() {
        return builder;
      },
      maybeSingle() {
        resolveScope();
        if (shouldError()) {
          return Promise.resolve({ data: null, error: tableErrors[table] });
        }
        return Promise.resolve({ data: filtered[0] ? cloneRow(filtered[0]) : null, error: null });
      },
      single() {
        resolveScope();
        if (shouldError()) {
          return Promise.resolve({ data: null, error: tableErrors[table] });
        }
        return Promise.resolve({ data: filtered[0] ? cloneRow(filtered[0]) : null, error: filtered[0] ? null : { message: "not found" } });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        resolveScope();
        if (shouldError()) {
          return Promise.resolve({ data: null, error: tableErrors[table] }).then(resolve, reject);
        }
        if (op === "delete") {
          const toRemove = new Set(filtered);
          for (let i = rows.length - 1; i >= 0; i--) {
            if (toRemove.has(rows[i])) rows.splice(i, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        if (op === "update" && updatePayload) {
          for (const row of filtered) Object.assign(row, updatePayload);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        // select: restituisce copie, non i riferimenti live alle righe della
        // tabella — altrimenti una mutazione successiva (upsert) sulla stessa
        // riga altererebbe retroattivamente uno snapshot "prima" già letto e
        // conservato altrove.
        return Promise.resolve({ data: filtered.map((r) => cloneRow(r)), error: null }).then(resolve, reject);
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
        delete() {
          return makeQueryBuilder(table, "delete");
        },
        update(payload: Row) {
          return makeQueryBuilder(table, "update", payload);
        },
        insert(rowsOrRow: Row | Row[]) {
          if (tableInsertErrors[table]) {
            return {
              select() {
                return {
                  single: () => Promise.resolve({ data: null, error: tableInsertErrors[table] }),
                  maybeSingle: () => Promise.resolve({ data: null, error: tableInsertErrors[table] }),
                };
              },
              then(resolve: (v: { data: null; error: { message: string } }) => unknown, reject?: (e: unknown) => unknown) {
                return Promise.resolve({ data: null, error: tableInsertErrors[table] }).then(resolve, reject);
              },
            };
          }
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const inserted = rowsArr.map((r) => ({ id: r.id ?? `${table}-${Math.random().toString(36).slice(2)}`, status: "active", ...r }));
          tables[table].push(...inserted);
          if (table === "trip_groups") calls.tripGroupsInserts += inserted.length;
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({ data: inserted[0] ?? null, error: null });
                },
                maybeSingle() {
                  return Promise.resolve({ data: inserted[0] ?? null, error: null });
                },
              };
            },
            then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
              return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
            },
          };
        },
        upsert(rowsOrRow: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
          if (table === "assignments") calls.assignmentsUpserts++;
          if (tableInsertErrors[table]) {
            return Promise.resolve({ data: null, error: tableInsertErrors[table] });
          }
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const conflictFields = (opts.onConflict ?? "id").split(",");
          const arr = tables[table];
          for (const row of rowsArr) {
            const existingIdx = arr.findIndex((r) => conflictFields.every((f) => r[f] === row[f]));
            if (existingIdx >= 0) {
              if (!opts.ignoreDuplicates) Object.assign(arr[existingIdx], row);
            } else {
              arr.push({ id: row.id ?? `${table}-${Math.random().toString(36).slice(2)}`, ...row });
            }
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return {
    admin,
    tables,
    calls,
    setError(table: string, err: { message: string } | null, fromCallIndex = 1) {
      tableErrors[table] = err ?? undefined;
      tableErrorFromCall[table] = fromCallIndex;
    },
    setInsertError(table: string, err: { message: string } | null) {
      tableInsertErrors[table] = err ?? undefined;
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  auditLog: vi.fn(),
  sendPushToUser: vi.fn(),
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
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
}));
vi.mock("@/lib/server/learned-patterns", () => ({
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));
vi.mock("@/lib/server/vehicle-commitments", () => ({
  loadVehicleCommitmentsForDate: vi.fn().mockResolvedValue({ byVehicleId: new Map() }),
}));
vi.mock("@/lib/server/vehicle-availability", () => ({
  isVehicleManuallyBlockedOnDate: vi.fn().mockReturnValue(false),
  manualVehicleBlockMessage: vi.fn().mockReturnValue(""),
}));

import { POST } from "@/app/api/ops/piano-giorno/trips/route";

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    pax: 2,
    hotel_id: null,
    meeting_point: null,
    arrival_time: null,
    orario_barca: null,
    porto_bruno: null,
    barca_compagnia: null,
    booking_service_kind: "transfer",
    service_type_code: null,
    vessel: null,
    ferry_details: null,
    status: "new",
    is_draft: false,
    customer_name: "Mario Rossi",
    ...overrides,
  };
}

function membershipRow(userId: string, tenantId: string, overrides: Row = {}): Row {
  return { user_id: userId, tenant_id: tenantId, role: "driver", suspended: false, ...overrides };
}

function driverProfileRow(id: string, tenantId: string, userId: string | null, overrides: Row = {}): Row {
  return { id, tenant_id: tenantId, user_id: userId, active: true, ...overrides };
}

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "14:00:00" })],
    trip_groups: [],
    assignments: [],
    memberships: [
      membershipRow(DRIVER_1, TENANT_A),
      membershipRow(DRIVER_SUSPENDED, TENANT_A, { suspended: true }),
      membershipRow(DRIVER_B, TENANT_B),
    ],
    driver_profiles: [
      driverProfileRow(PROFILE_1, TENANT_A, DRIVER_1),
    ],
    driver_daily_availability: [
      { tenant_id: TENANT_A, driver_user_id: DRIVER_1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      { tenant_id: TENANT_A, driver_profile_id: PROFILE_1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
    ],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    vehicles: [],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/piano-giorno/trips", {
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

function createTripBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "create_trip",
    date: TEST_DATE,
    service_ids: [SERVICE_1],
    driver_user_id: DRIVER_1,
    ...overrides,
  };
}

function lastHistoryEntries(): Row[] {
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Row[];
}

describe("CONC-07 — storico strutturato (driver_assignment_history) su create_trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractFeatures.mockReturnValue({ mocked_features: true });
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. nuova assegnazione con driver: history scritto, changeType driver_swap", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].serviceId).toBe(SERVICE_1);
  });

  it("2. nuova assegnazione con driver+mezzo: entry con vehicle valorizzato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(createTripBody({ vehicle_label: VEHICLE_LABEL }));

    const entries = lastHistoryEntries();
    expect(entries[0].changeType).toBe("driver_swap");
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_LABEL);
  });

  it("3. più servizi: un entry per servizio", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ service_ids: [SERVICE_1, SERVICE_2] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.serviceId).sort()).toEqual([SERVICE_1, SERVICE_2].sort());
  });

  it("4. driver_profile corretto: toDriverProfileId coincide col profilo reale", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(createTripBody({ driver_profile_id: PROFILE_1 }));

    const entries = lastHistoryEntries();
    expect(entries[0].toDriverProfileId).toBe(PROFILE_1);
    expect(entries[0].fromDriverProfileId).toBeNull();
  });

  it("5. vehicle corretto: toVehicleLabel coincide col valore reale", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(createTripBody({ vehicle_label: VEHICLE_LABEL }));

    const entries = lastHistoryEntries();
    expect(entries[0].toVehicleLabel).toBe(VEHICLE_LABEL);
  });

  it("6. groupId nuovo corretto: coincide col group_id realmente creato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    const entries = lastHistoryEntries();
    expect(entries[0].groupId).toBe(body.group_id);
  });

  it("7. actor corretto: operatorId coincide con l'utente autenticato", async () => {
    const fake = baseSeed();
    authorizeAs(fake, "operator-xyz");

    await callPost(createTripBody());

    const entries = lastHistoryEntries();
    expect(entries[0].operatorId).toBe("operator-xyz");
  });

  it("8. tenant corretto: tenantId coincide con quello della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(createTripBody());

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
  });

  it("9. tenant_id malevolo nel body viene ignorato: history usa il tenant di sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(createTripBody({ tenant_id: TENANT_B }));

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
    expect(entries[0].tenantId).not.toBe(TENANT_B);
  });

  it("10. service_ids duplicati nel body: nessun doppio history", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ service_ids: [SERVICE_1, SERVICE_1, SERVICE_1] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    expect(lastHistoryEntries()).toHaveLength(1);
  });

  it("11. previous assignment assente: driver_swap da null", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(createTripBody());

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBeNull();
  });

  it("12. previous assignment presente (upsert sovrascrive un assignment esistente, es. da auto-assign): previous reale, non null inventato", async () => {
    const fake = baseSeed({
      assignments: [
        { id: "asg-preexisting", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: null, driver_user_id: null, driver_profile_id: "profile-auto-assign", vehicle_label: "Van 3", assignment_source: "auto_assign_dispatch" },
      ],
    });
    authorizeAs(fake);

    await callPost(createTripBody({ driver_profile_id: PROFILE_1 }));

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBe("profile-auto-assign");
    expect(entries[0].toDriverProfileId).toBe(PROFILE_1);
  });

  it("13. nessun history su 401 (sessione non valida)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));

    const res = await callPost(createTripBody());

    expect(res.status).toBe(401);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("14. nessun history su 403 (ruolo non autorizzato)", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));

    const res = await callPost(createTripBody());

    expect(res.status).toBe(403);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("15. nessun history su SEC-02/ownership servizi (service_id di altro tenant)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { tenant_id: TENANT_B })],
    });
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).not.toBe(200);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("16. nessun history su SEC-05 (driver cross-tenant)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_B }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("DRIVER_NOT_FOUND");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("17. nessun history su FUNC-02 (servizio non operativo)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1, { status: "cancelled" })],
    });
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("SERVICE_NOT_ASSIGNABLE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("18. nessun history su FUNC-03 (driver sospeso)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody({ driver_user_id: DRIVER_SUSPENDED }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DRIVER_NOT_ACTIVE");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("19. nessun history su availability (giornata non confermata)", async () => {
    const fake = baseSeed({ daily_availability_confirmations: [] });
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("20. nessun history su timeline (conflitto orario stesso driver)", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_1), serviceRow(SERVICE_2, { time: "10:00:00" })],
      trip_groups: [
        { id: "grp-existing", tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1", status: "active" },
      ],
      assignments: [
        { id: "asg-existing", tenant_id: TENANT_A, service_id: SERVICE_2, group_id: "grp-existing", driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1" },
      ],
    });
    authorizeAs(fake);

    // SERVICE_1 e SERVICE_2 sono entrambi alle 10:00 (override sopra):
    // stesso driver su due gruppi con orari sovrapposti → conflitto timeline.
    const res = await callPost(createTripBody({ service_ids: [SERVICE_1] }));
    const body = await res.json();

    expect(res.status).not.toBe(200);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("21. nessun history su errore insert trip_group (500)", async () => {
    const fake = baseSeed();
    fake.setInsertError("trip_groups", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("22. nessun history su errore assignments (upsert fallito)", async () => {
    const fake = baseSeed();
    fake.setInsertError("assignments", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    // La mutazione principale resta best-effort (comportamento preesistente
    // di _assignServicesToGroup, non toccato): la risposta HTTP resta 200.
    // La "conferma successo" del blocco history non trova però alcuna riga
    // con group_id = groupId (upsert fallito), quindi zero eventi.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("23. logAssignmentChange rigetta: risposta di successo invariata (fire-and-forget)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
  });

  it("24. snapshot previous fallisce: creazione riuscita, zero history", async () => {
    const fake = baseSeed();
    // 1a select assignments: validateTripPayload (otherAssignments, guard
    // preesistente, deve continuare a funzionare); 2a: lo snapshot CONC-07
    // sotto test.
    fake.setError("assignments", RAW_DB_ERROR, 2);
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("25. push invariato su successo: sendPushToUser chiamato una volta verso driver_user_id", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(createTripBody());

    expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1);
    expect(mocks.sendPushToUser).toHaveBeenCalledWith(TENANT_A, DRIVER_1, expect.any(Object));
  });

  it("26. risposta HTTP invariata: stessa forma { ok, group_id, warnings }", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(createTripBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["group_id", "ok", "warnings"]);
  });

  it("27. update_trip invariata: la modifica a create_trip non lo tocca", async () => {
    const fake = baseSeed({
      trip_groups: [
        { id: "grp-1", tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1", status: "active" },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "update_trip", group_id: "grp-1", driver_user_id: DRIVER_1, service_ids: [SERVICE_1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("28. move_services invariata: la modifica a create_trip non lo tocca", async () => {
    const DRIVER_2 = "d9999999-9999-4999-8999-999999999997";
    const fake = baseSeed({
      trip_groups: [
        { id: "grp-1", tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1", status: "active" },
        { id: "grp-2", tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_2, driver_profile_id: null, vehicle_label: "Van 2", status: "active" },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1" },
      ],
      memberships: [
        membershipRow(DRIVER_1, TENANT_A),
        membershipRow(DRIVER_2, TENANT_A),
      ],
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
        { tenant_id: TENANT_A, driver_user_id: DRIVER_2, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({
      action: "move_services",
      service_ids: [SERVICE_1],
      group_id: "grp-1",
      target_group_id: "grp-2",
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("29. swap_driver invariata: la modifica a create_trip non lo tocca", async () => {
    const DRIVER_2 = "d9999999-9999-4999-8999-999999999996";
    const fake = baseSeed({
      trip_groups: [
        { id: "grp-1", tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1", status: "active" },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1" },
      ],
      memberships: [
        membershipRow(DRIVER_1, TENANT_A),
        membershipRow(DRIVER_2, TENANT_A),
      ],
      driver_daily_availability: [
        { tenant_id: TENANT_A, driver_user_id: DRIVER_1, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
        { tenant_id: TENANT_A, driver_user_id: DRIVER_2, date: TEST_DATE, available: true, available_from: "00:00", available_to: "23:59" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "swap_driver", date: TEST_DATE, from_driver_id: DRIVER_1, to_driver_id: DRIVER_2 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("30. swap_vehicle invariata: la modifica a create_trip non lo tocca", async () => {
    const fake = baseSeed({
      trip_groups: [
        { id: "grp-1", tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1", status: "active" },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "swap_vehicle", date: TEST_DATE, from_vehicle_label: "Van 1", to_vehicle_label: "Van 2" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("31. delete_trip invariata: la modifica a create_trip non lo tocca", async () => {
    const fake = baseSeed({
      trip_groups: [
        { id: "grp-1", tenant_id: TENANT_A, date: TEST_DATE, driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1", status: "active" },
      ],
      assignments: [
        { id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_1, group_id: "grp-1", driver_user_id: DRIVER_1, driver_profile_id: PROFILE_1, vehicle_label: "Van 1" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost({ action: "delete_trip", group_id: "grp-1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
