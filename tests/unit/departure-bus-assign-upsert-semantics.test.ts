import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X1 = "a1111111-1111-4111-8111-111111111111";
const SERVICE_X2 = "a2222222-2222-4222-8222-222222222222";
const SERVICE_B1 = "b1111111-1111-4111-8111-111111111111";
const OLD_DRIVER = "d0000000-0000-4000-8000-000000000000";
const NEW_DRIVER = "d1111111-1111-4111-8111-111111111111";
const OLD_PROFILE = "p0000000-0000-4000-8000-000000000000";
const OLD_GROUP = "g0000000-0000-4000-8000-000000000000";
const OLD_OPERATOR = "u0000000-0000-4000-8000-000000000000";
const CURRENT_OPERATOR = "user-1";
const DATE_1 = "2026-08-10";
const OLD_TIMESTAMP = "2026-01-01T00:00:00.000Z";

type Row = Record<string, unknown>;

/**
 * Fake Supabase in-memory, tenant-aware, per il micro-fix di semantica upsert
 * di departure-bus-assign (post RACE-01). L'upsert simula davvero la
 * semantica ON CONFLICT (service_id, tenant_id) DO UPDATE di PostgREST: sulla
 * riga esistente vengono sovrascritte SOLO le chiavi effettivamente presenti
 * nel payload (anche se il valore è null) — le chiavi omesse restano quelle
 * della riga precedente. Questo è indispensabile perché il test rilevi
 * davvero la regressione (e la sua correzione), non un fake "full replace".
 */
function createOperationalSupabase(
  seed: Partial<Record<"services" | "daily_availability_confirmations" | "assignments", Row[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    assignments: [...(seed.assignments ?? [])],
  };

  const calls = {
    assignmentsDeleteCalls: 0,
    assignmentsUpsertCalls: 0,
    upsertedRows: [] as Row[],
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
        filtered = filtered.filter((r) => (r[field] ?? null) !== value);
        return builder;
      },
      maybeSingle() {
        const row = filtered[0] ?? null;
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        // validateDriverGeographicBatch fa `.select("group_id, services!inner(...)")` su assignments.
        const data =
          table === "assignments"
            ? filtered.map((r) => ({ ...r, services: tables.services.find((s) => s.id === r.service_id) ?? null }))
            : filtered;
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

  const tableErrors: Record<string, { message: string } | null> = {};

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
    user: { id: CURRENT_OPERATOR, email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function assignBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "assign_driver",
    service_ids: [SERVICE_X1],
    driver_user_id: NEW_DRIVER,
    vehicle_label: "DEP_BUS:1",
    ...overrides,
  };
}

// Riga "stale" completa, come l'avrebbe lasciata assign-service (manualAssignmentLock)
// o auto-assign/trips: tutti i campi di metadato valorizzati con il vecchio driver.
function staleAssignmentRow(overrides: Row = {}): Row {
  return {
    id: "asg-existing",
    tenant_id: TENANT_A,
    service_id: SERVICE_X1,
    driver_user_id: OLD_DRIVER,
    vehicle_label: "Vecchio Bus",
    driver_profile_id: OLD_PROFILE,
    group_id: OLD_GROUP,
    assignment_source: "manual_assign_service",
    locked_by_operator: true,
    assigned_by: OLD_OPERATOR,
    assigned_at: OLD_TIMESTAMP,
    lock_reason: "manual_assignment_from_assign_service",
    ...overrides,
  };
}

describe("Semantica upsert — departure-bus-assign API (fix regressione post RACE-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. nuova assegnazione senza riga preesistente: campi corretti, default storici rispettati", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });

    const row = fake.tables.assignments.find((a) => a.service_id === SERVICE_X1);
    expect(row).toMatchObject({
      driver_user_id: NEW_DRIVER,
      vehicle_label: "DEP_BUS:1",
      driver_profile_id: null,
      group_id: null,
      assignment_source: null,
      locked_by_operator: false,
      assigned_by: CURRENT_OPERATOR,
      lock_reason: null,
    });
    expect(typeof row?.assigned_at).toBe("string");
  });

  it("2. riga preesistente creata da assign-service (locked, profilata): tutti i metadati stale vengono azzerati/aggiornati", async () => {
    const fake = baseSeed({ assignments: [staleAssignmentRow()] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });

    const row = fake.tables.assignments.find((a) => a.service_id === SERVICE_X1);
    expect(row?.driver_user_id).toBe(NEW_DRIVER);
    expect(row?.vehicle_label).toBe("DEP_BUS:1");
    expect(row?.driver_profile_id).toBeNull();
    expect(row?.group_id).toBeNull();
    expect(row?.assignment_source).toBeNull();
    expect(row?.locked_by_operator).toBe(false);
    expect(row?.assigned_by).toBe(CURRENT_OPERATOR);
    expect(row?.assigned_by).not.toBe(OLD_OPERATOR);
    expect(row?.assigned_at).not.toBe(OLD_TIMESTAMP);
    expect(row?.lock_reason).toBeNull();
  });

  it("3. assignment creato da auto-assign: nessun metadato automatico sopravvive", async () => {
    const fake = baseSeed({
      assignments: [
        staleAssignmentRow({
          assignment_source: "auto_assign",
          locked_by_operator: false,
          lock_reason: null,
        }),
      ],
    });
    authorizeAs(fake);

    await callPost(assignBody());

    const row = fake.tables.assignments.find((a) => a.service_id === SERVICE_X1);
    expect(row?.assignment_source).toBeNull();
    expect(row?.driver_profile_id).toBeNull();
    expect(row?.group_id).toBeNull();
  });

  it("4. assignment creato da piano-giorno/trips: il vecchio group_id non sopravvive", async () => {
    const fake = baseSeed({
      assignments: [staleAssignmentRow({ assignment_source: "manual_piano_giorno", group_id: OLD_GROUP })],
    });
    authorizeAs(fake);

    await callPost(assignBody());

    const row = fake.tables.assignments.find((a) => a.service_id === SERVICE_X1);
    expect(row?.group_id).toBeNull();
    expect(row?.group_id).not.toBe(OLD_GROUP);
  });

  it("5. driver_profile_id del vecchio driver non sopravvive alla riassegnazione", async () => {
    const fake = baseSeed({ assignments: [staleAssignmentRow()] });
    authorizeAs(fake);

    await callPost(assignBody());

    const row = fake.tables.assignments.find((a) => a.service_id === SERVICE_X1);
    expect(row?.driver_profile_id).not.toBe(OLD_PROFILE);
    expect(row?.driver_profile_id).toBeNull();
  });

  it("6. vehicle_label viene sempre aggiornato al nuovo valore", async () => {
    const fake = baseSeed({ assignments: [staleAssignmentRow({ vehicle_label: "Vecchio Bus" })] });
    authorizeAs(fake);

    await callPost(assignBody({ vehicle_label: "DEP_BUS:NUOVO" }));

    const row = fake.tables.assignments.find((a) => a.service_id === SERVICE_X1);
    expect(row?.vehicle_label).toBe("DEP_BUS:NUOVO");
  });

  it("7. assignments non ha colonna vehicle_id: la route scrive solo vehicle_label, nessuna colonna vehicle_id fantasma", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost(assignBody());

    expect(fake.calls.upsertedRows[0]).not.toHaveProperty("vehicle_id");
    const row = fake.tables.assignments.find((a) => a.service_id === SERVICE_X1);
    expect(row).not.toHaveProperty("vehicle_id");
  });

  it("8. RACE-01 invariata: upsert atomico, nessun DELETE, nessuna duplicazione sotto race", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const [resA, resB] = await Promise.all([
      callPost(assignBody({ driver_user_id: NEW_DRIVER, vehicle_label: "Bus A" })),
      callPost(assignBody({ driver_user_id: OLD_DRIVER, vehicle_label: "Bus B" })),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(fake.calls.assignmentsDeleteCalls).toBe(0);
    expect(fake.tables.assignments.filter((a) => a.service_id === SERVICE_X1)).toHaveLength(1);
  });

  it("9. SEC-01 invariato: service_id di un altro tenant -> 404, zero scritture", async () => {
    const fake = baseSeed({
      services: [{ id: SERVICE_B1, tenant_id: TENANT_B, date: DATE_1, time: "10:00:00", pickup_hotel: null, direction: "departure", hotel_id: null, meeting_point: null }],
    });
    authorizeAs(fake);

    const res = await callPost(assignBody({ service_ids: [SERVICE_B1] }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "Uno o più servizi non trovati." });
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("10. FUNC-01 invariato: disponibilità non confermata blocca prima dell'upsert", async () => {
    const fake = baseSeed({ daily_availability_confirmations: [] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("DAILY_AVAILABILITY_NOT_CONFIRMED");
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
  });

  it("11. errore DB sull'upsert: 500 fail-closed, comportamento invariato", async () => {
    const fake = baseSeed();
    fake.setUpsertError({ message: "duplicate key value violates unique constraint" });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("12. remove_driver invariata: continua a usare DELETE, non upsert", async () => {
    const fake = baseSeed({ assignments: [staleAssignmentRow()] });
    authorizeAs(fake);

    const res = await callPost({ action: "remove_driver", service_ids: [SERVICE_X1] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDeleteCalls).toBe(1);
    expect(fake.calls.assignmentsUpsertCalls).toBe(0);
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("13. create_driver_account invariata: nessun guard/upsert coinvolto", async () => {
    mocks.authorizePricingRequest.mockResolvedValue({
      admin: {
        from(table: string) {
          throw new Error(`create_driver_account non deve toccare la tabella ${table}`);
        },
      },
      user: { id: CURRENT_OPERATOR, email: "op@test.dev" },
      membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
    });

    const res = await callPost({ action: "create_driver_account", driver_profile_id: "", email: "" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ ok: false, error: "driver_profile_id e email richiesti" });
  });

  it("14. privacy: la risposta 200 non espone alcuna colonna grezza della riga assignments", async () => {
    const fake = baseSeed({ assignments: [staleAssignmentRow()] });
    authorizeAs(fake);

    const res = await callPost(assignBody());
    const body = await res.json();

    expect(body).toEqual({ ok: true });
    const bodyKeys = Object.keys(body);
    for (const forbidden of ["driver_profile_id", "group_id", "assignment_source", "locked_by_operator", "assigned_by", "assigned_at", "lock_reason", "tenant_id"]) {
      expect(bodyKeys).not.toContain(forbidden);
    }
  });
});
