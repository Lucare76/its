import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVICE_X = "a1111111-1111-4111-8111-111111111111";
const SERVICE_Y = "a2222222-2222-4222-8222-222222222222";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const UNIQUE_VIOLATION_ERROR = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "assignments_service_tenant_unique"',
};

/**
 * Fake Supabase in-memory che simula il vincolo unique reale
 * assignments_service_tenant_unique (service_id, tenant_id): il primo insert
 * per una data coppia riesce, ogni insert successivo per la stessa coppia
 * fallisce con l'errore Postgres 23505, esattamente come farebbe il DB reale
 * (supabase/migrations/0137_assignments_nullable_driver_unique.sql:8-9).
 * Non è un mock che restituisce sempre successo: applica realmente il
 * vincolo, quindi la seconda richiesta "concorrente" osserva un vero
 * conflitto, non un placeholder.
 */
function createConcurrencyAwareSupabase(
  seed: Partial<Record<"services" | "daily_availability_confirmations" | "assignments" | "trip_groups" | "hotels" | "status_events" | "memberships" | "driver_profiles", Row[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    hotels: [...(seed.hotels ?? [])],
    status_events: [...(seed.status_events ?? [])],
    // SEC-05: il guard driver ownership interroga anche queste due tabelle.
    memberships: [...(seed.memberships ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
  };

  let simulateUniqueConstraint = true;
  let forcedAssignmentInsertError: { code: string; message: string } | null = null;
  let forceCleanupError: { message: string } | null = null;

  const calls = {
    tripGroupsInserted: [] as Row[],
    tripGroupsDeleted: [] as string[],
    assignmentsInserted: [] as Row[],
    assignmentsUpdated: 0,
    servicesUpdated: 0,
    statusEventsUpserted: 0,
  };

  function makeSelectBuilder(table: string) {
    let filtered = tables[table];
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
        filtered = filtered.filter((r) => r[field] !== value);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
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
      then(resolve: (v: { data: null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "delete") {
          if (table === "trip_groups" && forceCleanupError) {
            return Promise.resolve({ data: null, error: forceCleanupError }).then(resolve, reject);
          }
          const toRemove = new Set(filtered);
          for (let i = rows.length - 1; i >= 0; i--) {
            if (toRemove.has(rows[i])) {
              if (table === "trip_groups") calls.tripGroupsDeleted.push(rows[i].id as string);
              rows.splice(i, 1);
            }
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        // update
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
            const inserted = { id: `grp-${tables.trip_groups.length + 1}`, ...row };
            tables.trip_groups.push(inserted);
            calls.tripGroupsInserted.push(inserted);
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: inserted, error: null });
                  },
                };
              },
            };
          }
          if (table === "assignments") {
            if (forcedAssignmentInsertError) {
              return Promise.resolve({ data: null, error: forcedAssignmentInsertError });
            }
            const key = `${row.service_id}:${row.tenant_id}`;
            const conflict = simulateUniqueConstraint && tables.assignments.some((a) => `${a.service_id}:${a.tenant_id}` === key);
            if (conflict) {
              return Promise.resolve({ data: null, error: UNIQUE_VIOLATION_ERROR });
            }
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
    disableUniqueConstraintSimulation() {
      simulateUniqueConstraint = false;
    },
    forceAssignmentInsertError(err: { code: string; message: string } | null) {
      forcedAssignmentInsertError = err;
    },
    forceCleanupError(err: { message: string } | null) {
      forceCleanupError = err;
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
    time: "10:00:00",
    pickup_hotel: null,
    direction: "departure",
    hotel_id: null,
    meeting_point: null,
    ...overrides,
  };
}

function baseSeed(overrides: Parameters<typeof createConcurrencyAwareSupabase>[0] = {}) {
  return createConcurrencyAwareSupabase({
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    // SEC-05: DRIVER_A/DRIVER_B devono risultare autisti validi del tenant A,
    // altrimenti il nuovo guard ownership li rifiuterebbe prima della race.
    memberships: [
      { user_id: DRIVER_A, tenant_id: TENANT_A, role: "driver" },
      { user_id: DRIVER_B, tenant_id: TENANT_A, role: "driver" },
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

function authorizeAs(fake: ReturnType<typeof createConcurrencyAwareSupabase>, userId: string, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: `${userId}@test.dev` },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

describe("Concorrenza — assign-service API (CONC-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. assegnazione singola valida: 200, assignment/group creati, status/lock corretti", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-1");

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsInserted).toHaveLength(1);
    expect(fake.calls.assignmentsInserted).toHaveLength(1);
    expect(fake.calls.servicesUpdated).toBe(1);
    expect(fake.calls.statusEventsUpserted).toBe(1);
    const created = fake.calls.assignmentsInserted[0];
    expect(created.locked_by_operator).toBe(true);
    expect(created.assignment_source).toBe("manual_assign_service");
  });

  async function runRace(fake: ReturnType<typeof createConcurrencyAwareSupabase>) {
    // Le due richieste partono "insieme": ciascuna legge existingAssignment
    // PRIMA che l'altra scriva (nessuna delle due vede ancora un group_id per
    // SERVICE_X), esattamente lo scenario reale di CONC-01 — a differenza di
    // due chiamate sequenziali complete, dove la seconda vedrebbe già la riga
    // scritta dalla prima e prenderebbe il ramo UPDATE legittimo.
    const [resA, resB] = await Promise.all([
      callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus A" }),
      callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B, vehicle_label: "Bus B" }),
    ]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
    const aWon = resA.status === 200;
    return {
      winner: aWon
        ? { res: resA, body: bodyA, driverId: DRIVER_A, vehicleLabel: "Bus A" }
        : { res: resB, body: bodyB, driverId: DRIVER_B, vehicleLabel: "Bus B" },
      loser: aWon
        ? { res: resB, body: bodyB, driverId: DRIVER_B, vehicleLabel: "Bus B" }
        : { res: resA, body: bodyA, driverId: DRIVER_A, vehicleLabel: "Bus A" },
    };
  }

  it("2. seconda assegnazione sullo stesso servizio (conflitto): 409, nessun falso successo", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    const { winner, loser } = await runRace(fake);

    expect(winner.res.status).toBe(200);
    expect(winner.body.ok).toBe(true);
    expect(loser.res.status).toBe(409);
    expect(loser.body.ok).toBe(false);
    expect(loser.body.error).toBe("SERVICE_ALREADY_ASSIGNED");
    expect(loser.body).not.toEqual(expect.objectContaining({ ok: true }));
  });

  it("3. assignment vincitore invariato dopo il tentativo fallito del secondo operatore", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    const { winner } = await runRace(fake);

    const row = fake.tables.assignments.find((a) => a.service_id === SERVICE_X);
    expect(row?.driver_user_id).toBe(winner.driverId);
    expect(row?.vehicle_label).toBe(winner.vehicleLabel);
    expect(row?.locked_by_operator).toBe(true);
  });

  it("4. nessun doppio assignment per lo stesso service_id dopo il conflitto", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    await runRace(fake);

    expect(fake.tables.assignments.filter((a) => a.service_id === SERVICE_X)).toHaveLength(1);
  });

  it("5. trip_group del perdente eliminato dal cleanup", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    await runRace(fake);

    expect(fake.calls.tripGroupsInserted).toHaveLength(2);
    expect(fake.calls.tripGroupsDeleted).toHaveLength(1);
    const survivingGroupId = fake.tables.assignments.find((a) => a.service_id === SERVICE_X)?.group_id as string;
    const deletedGroupId = fake.calls.tripGroupsInserted.map((g) => g.id as string).find((id) => id !== survivingGroupId);
    expect(fake.calls.tripGroupsDeleted).toEqual([deletedGroupId]);
  });

  it("6. nessun trip_group orfano residuo nello store dopo cleanup riuscito", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    await runRace(fake);

    // Solo il gruppo del vincitore resta; quello creato dal perdente è stato ripulito.
    expect(fake.tables.trip_groups).toHaveLength(1);
    const survivingGroupId = fake.tables.assignments.find((a) => a.service_id === SERVICE_X)?.group_id;
    expect(fake.tables.trip_groups[0].id).toBe(survivingGroupId);
  });

  it("7. nessun update aggiuntivo di services.status causato dalla richiesta perdente", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    await runRace(fake);

    // Un solo update di services.status: solo quello del vincitore.
    expect(fake.calls.servicesUpdated).toBe(1);
  });

  it("8. nessun status_event aggiuntivo scritto dalla richiesta perdente", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    await runRace(fake);

    expect(fake.calls.statusEventsUpserted).toBe(1);
  });

  it("9. nessun audit di successo scritto per la richiesta perdente", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    await runRace(fake);

    const events = mocks.auditLog.mock.calls.map((c) => c[0].event);
    expect(events).not.toContain("assignment_success");
    expect(events).toContain("assignment_conflict");
  });

  it("10. audit di conflitto scritto correttamente", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    await runRace(fake);

    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "assignment_conflict",
        level: "warn",
        tenantId: TENANT_A,
        details: expect.objectContaining({ serviceId: SERVICE_X, cleanupAttempted: true, cleanupSucceeded: true }),
      })
    );
  });

  it("11. errore DB non-unique: 500 sanificato, cleanup tentato, nessun side-effect successivo", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    fake.forceAssignmentInsertError({ code: "53300", message: "too many connections for role internal-db-user" });
    authorizeAs(fake, "operator-1");

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "ASSIGNMENT_FAILED", message: "Errore durante l'assegnazione. Riprova." });
    expect(fake.calls.tripGroupsDeleted).toHaveLength(1);
    expect(fake.calls.servicesUpdated).toBe(0);
    expect(fake.calls.statusEventsUpserted).toBe(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "assignment_insert_failed", level: "error" })
    );
  });

  it("12. errore nel cleanup non maschera l'errore principale di conflitto", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    fake.forceCleanupError({ message: "connection reset while deleting trip_groups" });
    authorizeAs(fake, "operator-race");

    const { loser } = await runRace(fake);

    expect(loser.res.status).toBe(409);
    expect(loser.body.error).toBe("SERVICE_ALREADY_ASSIGNED");
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({ event: "assignment_cleanup_failed", level: "error" }));
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "assignment_conflict", details: expect.objectContaining({ cleanupSucceeded: false }) })
    );
  });

  it("13. ramo UPDATE su assignment/gruppo esistente: comportamento invariato", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { status: "assigned" })],
      trip_groups: [{ id: "grp-1", tenant_id: TENANT_A, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X, driver_user_id: DRIVER_A, group_id: "grp-1", vehicle_label: "Bus 1" }],
    });
    authorizeAs(fake, "operator-1");

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B, vehicle_label: "Bus 2" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsUpdated).toBe(1);
    const updated = fake.tables.assignments.find((a) => a.id === "asg-1");
    expect(updated?.driver_user_id).toBe(DRIVER_B);
    // Il ramo update non passa mai per il controllo di conflitto insert.
    expect(fake.calls.tripGroupsInserted).toHaveLength(0);
  });

  it("14. action remove: comportamento invariato", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { status: "assigned" })],
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X, driver_user_id: DRIVER_A, group_id: null }],
    });
    authorizeAs(fake, "operator-1");

    const res = await callPost({ service_id: SERVICE_X, action: "remove" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("15. utente non autenticato: 401, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    expect(res.status).toBe(401);
    expect(fake.calls.tripGroupsInserted).toHaveLength(0);
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
  });

  it("16. ruolo non autorizzato: 403, zero query operative", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A });
    expect(res.status).toBe(403);
    expect(fake.calls.tripGroupsInserted).toHaveLength(0);
  });

  it("17. due richieste concorrenti simulate: una 200, una 409, un solo assignment/trip_group finale", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-1");

    // Entrambe le richieste leggono lo stato "non ancora assegnato" prima che
    // una delle due scriva: simuliamo questo con due chiamate concorrenti allo
    // stesso handler sullo stesso store condiviso (Promise.all).
    const [resA, resB] = await Promise.all([
      callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus A" }),
      callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B, vehicle_label: "Bus B" }),
    ]);
    const statuses = [resA.status, resB.status].sort();

    expect(statuses).toEqual([200, 409]);
    expect(fake.tables.assignments.filter((a) => a.service_id === SERVICE_X)).toHaveLength(1);
    expect(fake.tables.trip_groups).toHaveLength(1);
  });

  it("20. privacy: la risposta di conflitto non espone dettagli DB/constraint", async () => {
    const fake = baseSeed({ services: [serviceRow(SERVICE_X)] });
    authorizeAs(fake, "operator-race");

    const { loser } = await runRace(fake);
    const raw = JSON.stringify(loser.body);

    expect(raw).not.toMatch(/23505/);
    expect(raw.toLowerCase()).not.toMatch(/unique constraint/);
    expect(raw).not.toMatch(/assignments_service_tenant_unique/);
    expect(raw.toLowerCase()).not.toMatch(/\bstack\b/);
    expect(raw.toLowerCase()).not.toMatch(/\bdetails\b/);
    expect(raw.toLowerCase()).not.toMatch(/\bhint\b/);
  });
});
