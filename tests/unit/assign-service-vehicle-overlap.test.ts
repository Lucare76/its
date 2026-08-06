import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVICE_X = "a1111111-1111-4111-8111-111111111111";
const SERVICE_OTHER = "a1111111-1111-4111-8111-111111111112";
const SERVICE_OTHER_TENANT_B = "a1111111-1111-4111-8111-111111111113";
const DRIVER_A = "d1111111-1111-4111-8111-111111111111";
const DRIVER_B = "d2222222-2222-4222-8222-222222222222";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

const RAW_DB_ERROR = { message: 'connection to server "internal-db-host.example" failed: SQLSTATE[08006]' };

/**
 * Fake Supabase in-memory, tenant-aware, dedicato ai test CONC-03 (overlap
 * mezzo) su assign-service. Applica realmente eq/neq/in/not/maybeSingle sulle
 * tabelle coinvolte (services, memberships, driver_profiles, assignments,
 * trip_groups, daily_availability_confirmations, status_events). Non definisce
 * affatto la tabella vehicle_time_blocks: se il codice sotto test la
 * interrogasse, il fake fallirebbe con errore esplicito (prova che
 * CONC-03 non la consulta, coerente con piano-giorno/trips che non la usa
 * per questo tipo di blocco).
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
    // CONC-07: destinazione dello storico strutturato fire-and-forget scritto
    // dopo l'assegnazione riuscita — deve esistere perché l'insert non crashi.
    driver_assignment_history: [],
  };

  const tableErrors: Record<string, { message: string } | null> = {};

  const calls = {
    tripGroupsQueried: 0,
    assignmentsQueried: 0,
    assignmentsInserted: [] as Row[],
    assignmentsUpdated: 0,
    assignmentsDeleted: 0,
    tripGroupsInserted: [] as Row[],
    tripGroupsUpdated: 0,
    tripGroupsDeleted: 0,
    servicesUpdated: 0,
    statusEventsUpserted: 0,
  };

  function augmentAssignmentRow(row: Row): Row {
    return { ...row, services: tables.services.find((s) => s.id === row.service_id) ?? null };
  }

  function makeSelectBuilder(table: string) {
    if (!(table in tables)) {
      throw new Error(`[fake supabase] tabella non definita: ${table}`);
    }
    let filtered = tables[table];
    if (table === "trip_groups") calls.tripGroupsQueried++;
    if (table === "assignments") calls.assignmentsQueried++;
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
            // Il DB applica uno status di default ('active') non impostato
            // esplicitamente da assign-service: replicato qui per fedeltà.
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

describe("CONC-03 — vehicle overlap guard in assign-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. mezzo libero: assegnazione riuscita, 200", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.assignmentsInserted).toHaveLength(1);
  });

  it("2. overlap reale stesso tenant/mezzo/orario: 409 VEHICLE_OVERLAP (sensibile alla rimozione del guard)", async () => {
    // Se il guard checkVehicleOverlap venisse rimosso o bypassato, questo test
    // fallirebbe: la risposta tornerebbe 200 invece di 409.
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "VEHICLE_OVERLAP",
      message: "Il mezzo è già impegnato in un altro servizio nello stesso orario.",
    });
  });

  it("3. zero scritture su overlap rilevato", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });

    expect(fake.calls.tripGroupsInserted).toHaveLength(0);
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
    expect(fake.calls.tripGroupsUpdated).toBe(0);
    expect(fake.calls.assignmentsUpdated).toBe(0);
    expect(fake.calls.servicesUpdated).toBe(0);
    expect(fake.calls.statusEventsUpserted).toBe(0);
  });

  it("4. stesso vehicle_label impegnato nel tenant B: nessun blocco (sensibile alla rimozione del filtro tenant)", async () => {
    // Se il filtro tenant_id venisse rimosso dalla query trip_groups/assignments
    // di checkVehicleOverlap, questo test fallirebbe: la richiesta del tenant A
    // verrebbe bloccata da un impegno che appartiene al tenant B.
    const fake = baseSeed({
      trip_groups: [{ id: "grp-tenantB", tenant_id: TENANT_B, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-tenantB", tenant_id: TENANT_B, service_id: SERVICE_OTHER_TENANT_B, group_id: "grp-tenantB", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER_TENANT_B, { tenant_id: TENANT_B, time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("4b. gruppo del tenant corretto ma assignment con tenant_id anomalo (altro tenant): non deve contare come overlap (sensibile alla rimozione del filtro tenant sulla query assignments)", async () => {
    // Scenario di isolamento profondo: il trip_group appartiene correttamente
    // al tenant A (altrimenti non verrebbe nemmeno trovato), ma la riga
    // assignments al suo interno ha tenant_id di un altro tenant (anomalia
    // dati). Il filtro .eq("tenant_id", tenantId) sulla query assignments deve
    // escluderla comunque: se rimosso, il test fallirebbe (200 atteso, 409 se rimosso).
    const fake = baseSeed({
      trip_groups: [{ id: "grp-mixed", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-mixed", tenant_id: TENANT_B, service_id: SERVICE_OTHER_TENANT_B, group_id: "grp-mixed", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER_TENANT_B, { tenant_id: TENANT_B, time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("5. servizio corrente escluso dal confronto anche se referenziato da un altro gruppo attivo con lo stesso mezzo/orario", async () => {
    // Scenario difensivo: un'assegnazione residua per lo STESSO service_id in
    // un gruppo diverso da quello riusato non deve auto-generare un conflitto.
    // Prova l'esclusione esplicita per service_id (indipendente da excludeGroupId).
    const fake = baseSeed({
      trip_groups: [{ id: "grp-stray", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-stray", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: "grp-stray", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("6. update della stessa assegnazione (stesso gruppo riusato): nessun falso conflitto", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-existing", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-existing", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: "grp-existing", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fake.calls.tripGroupsUpdated).toBe(1);
  });

  it("7. vehicle_label assente: comportamento invariato, nessuna query trip_groups/assignments per l'overlap", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Un solo insert su assignments (quello finale della route), nessuna query aggiuntiva di overlap.
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });

  it('7b. vehicle_label vuoto/whitespace: comportamento invariato', async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "   " });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("8. errore query trip_groups: 500 VEHICLE_CHECK_FAILED, fail-closed, zero scritture", async () => {
    const fake = baseSeed();
    fake.setTableError("trip_groups", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      error: "VEHICLE_CHECK_FAILED",
      message: "Errore durante la verifica della disponibilità del mezzo.",
    });
    expect(fake.calls.assignmentsInserted).toHaveLength(0);
    expect(fake.calls.tripGroupsInserted).toHaveLength(0);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "assign_service_vehicle_check_failed", level: "error" })
    );
  });

  it("8b. errore query assignments (secondo stadio): 500 VEHICLE_CHECK_FAILED, fail-closed", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
    });
    fake.setTableError("assignments", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("VEHICLE_CHECK_FAILED");
  });

  it("9. risposta 409 sanificata: nessun service_id/hotel/tenant/dettaglio DB esposto", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toMatch(new RegExp(SERVICE_OTHER));
    expect(raw).not.toMatch(new RegExp(TENANT_A));
    expect(raw.toLowerCase()).not.toMatch(/sqlstate|stack|supabase|postgres/);
  });

  it("9b. risposta 500 sanificata: nessun dettaglio DB esposto", async () => {
    const fake = baseSeed();
    fake.setTableError("trip_groups", RAW_DB_ERROR);
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toMatch(/internal-db-host/);
    expect(raw.toLowerCase()).not.toMatch(/sqlstate/);
  });

  it("10. CONC-01 invariato: assegnazione senza group_id viene sostituita correttamente, nessuna interferenza da CONC-03", async () => {
    const fake = baseSeed({
      assignments: [{ id: "asg-conflict", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: null, vehicle_label: "" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("11. SEC-05 invariato: driver di tenant B produce ancora 404 prima del controllo mezzo", async () => {
    const fake = baseSeed({
      memberships: [{ user_id: DRIVER_B, tenant_id: TENANT_B, role: "driver" }],
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_B, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ ok: false, error: "DRIVER_NOT_FOUND", message: "Autista non trovato." });
    // Il controllo mezzo non deve nemmeno essere raggiunto: SEC-05 blocca prima.
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });

  it("11b. driver_user_id valido (SEC-05 ok) + mezzo libero: successo end-to-end", async () => {
    const fake = baseSeed({
      memberships: [{ user_id: DRIVER_A, tenant_id: TENANT_A, role: "driver" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, driver_user_id: DRIVER_A, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("12. utente non autenticato: 401, nessuna query di overlap eseguita", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Sessione non valida." }, { status: 401 }));
    const fake = baseSeed();

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });

    expect(res.status).toBe(401);
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });

  it("13. ruolo non autorizzato: 403, nessuna query di overlap eseguita", async () => {
    mocks.authorizePricingRequest.mockResolvedValue(NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 }));
    const fake = baseSeed();

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });

    expect(res.status).toBe(403);
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });

  it("16a. confine temporale: il candidato inizia esattamente quando l'altro termina → nessun overlap, 200", async () => {
    // other: 10:00-10:30 (finestra fissa 30 min). candidate: 10:30 → [10:30,11:00).
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X, { time: "10:30:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("16b. sovrapposizione parziale: 409", async () => {
    // other: 10:00-10:30. candidate: 10:15 → [10:15,10:45) - overlap reale.
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X, { time: "10:15:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    expect(res.status).toBe(409);
  });

  it("16c. sovrapposizione totale (stesso orario esatto): 409", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X, { time: "10:00:00" }), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    expect(res.status).toBe(409);
  });

  it("16d. servizio precedente con gap ampio (nessun buffer bloccante): 200", async () => {
    // other: 08:00-08:30. candidate: 10:00 → distanza ampia, nessun blocco
    // (CONC-03 replica solo il blocco reale di trips, non i warning da buffer).
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X, { time: "10:00:00" }), serviceRow(SERVICE_OTHER, { time: "08:00:00" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    expect(res.status).toBe(200);
  });

  it("14. servizio annullato coinvolto nell'overlap: blocca comunque (nessun filtro per status, logica invariata da trips)", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00", status: "cancelled" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    expect(res.status).toBe(409);
  });

  it("14b. servizio completato coinvolto nell'overlap: blocca comunque", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00", status: "completato" })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    expect(res.status).toBe(409);
  });

  it("15. servizio candidato senza orario: nessun crash, controllo saltato per quel servizio, 200", async () => {
    const fake = baseSeed({
      services: [serviceRow(SERVICE_X, { time: null })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("15b. gruppo attivo con altro servizio senza orario: quel servizio viene ignorato nel confronto, nessun crash", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X, { time: "10:00:00" }), serviceRow(SERVICE_OTHER, { time: null })],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("17. vehicle_time_blocks non è consultato dal guard CONC-03 (tabella assente dal fake: se interrogata il test fallirebbe con errore)", async () => {
    const fake = baseSeed({
      trip_groups: [{ id: "grp-other", tenant_id: TENANT_A, date: TEST_DATE, status: "active", vehicle_label: "Bus 1" }],
      assignments: [{ id: "asg-other", tenant_id: TENANT_A, service_id: SERVICE_OTHER, group_id: "grp-other", vehicle_label: "Bus 1" }],
      services: [serviceRow(SERVICE_X), serviceRow(SERVICE_OTHER, { time: "10:00:00" })],
    });
    authorizeAs(fake);

    // Nessuna tabella "vehicle_time_blocks" definita nel fake: se il codice la
    // interrogasse, il fake lancerebbe "tabella non definita" e il test fallirebbe.
    const res = await callPost({ service_id: SERVICE_X, vehicle_label: "Bus 1" });
    expect(res.status).toBe(409);
  });

  it("18. action remove invariata: nessuna interrogazione del guard overlap mezzo", async () => {
    const fake = baseSeed({
      assignments: [{ id: "asg-1", tenant_id: TENANT_A, service_id: SERVICE_X, group_id: null, vehicle_label: "Bus 1" }],
    });
    authorizeAs(fake);

    const res = await callPost({ service_id: SERVICE_X, action: "remove", vehicle_label: "Bus 1" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(fake.calls.assignmentsDeleted).toBe(1);
    expect(fake.calls.tripGroupsQueried).toBe(0);
  });
});
