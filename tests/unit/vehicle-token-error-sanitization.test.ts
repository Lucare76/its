import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test SEC-06 — sanitizzazione errori su GET/POST /api/vehicle/[token].
 *
 * Endpoint pubblico (nessuna autenticazione richiesta): pagina QR consultata
 * dagli autisti sul campo. Prima del fix, tre punti restituivano al client
 * il messaggio raw Postgres/Supabase:
 *   1. `err.message` sull'insert di `vehicle_km_logs` (azione "km_start");
 *   2. `err.message` sull'update di `vehicle_km_logs` (azione "km_end");
 *   3. `err.message` sull'insert di `vehicle_fuel` (azione "fuel").
 * Il fix sostituisce tutti e tre con un messaggio generico in italiano
 * specifico al contesto, loggando il dettaglio raw solo server-side via
 * `auditLog` (stesso pattern già validato in cancel-respond/shuttle-schedules
 * — nessun nuovo helper introdotto).
 *
 * A differenza di cancel-respond/shuttle-schedules, questa route non ha un
 * try/catch esterno generico: nessun quarto leak di tipo "catch" esiste da
 * sanitizzare (scenario 11 dichiarato N/A esplicitamente, non inventato).
 */

const VEHICLE_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "qr-token-abc123";
const LOG_ID = "22222222-2222-4222-8222-222222222222";

const DISTINCTIVE_RICH_ERROR =
  'duplicate key value violates unique constraint "vehicle_km_logs_vehicle_id_open_idx" on relation "vehicle_km_logs", column "vehicle_id" SQLSTATE=23505';
const DISTINCTIVE_KM_END_ERROR =
  'update or delete on table "vehicle_km_logs" violates foreign key constraint "fk_vehicle_km_logs_vehicle"';
const DISTINCTIVE_FUEL_ERROR =
  'column "submitted_via_qr_legacy" of relation "vehicle_fuel" does not exist';

type Row = Record<string, unknown>;

function createFakeAdmin(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    vehicles: [],
    vehicle_anomalies: [],
    vehicle_km_logs: [],
    vehicle_fuel: [],
    driver_profiles: [],
    vehicle_documents: [],
    vehicle_insurances: [],
    vehicle_inspections: [],
    vehicle_extinguishers: [],
    vehicle_tachographs: [],
    vehicle_qr_reports: [],
    ...seed,
  };
  const errors: Record<string, { message: string }> = {};
  const calls: Record<string, number> = {};
  let idCounter = 0;

  function bump(key: string) {
    calls[key] = (calls[key] ?? 0) + 1;
  }

  function makeSelectBuilder(table: string) {
    let filtered = tables[table];
    const errKey = `${table}:select`;
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      is(field: string, value: null) {
        filtered = filtered.filter((r) => (r[field] ?? null) === value);
        return builder;
      },
      not(field: string, _op: string, value: null) {
        filtered = filtered.filter((r) => (r[field] ?? null) !== value);
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return builder;
      },
      maybeSingle() {
        bump(errKey);
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] });
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        bump(errKey);
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] });
        return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        bump(errKey);
        if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
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
        insert(rowsOrRow: Row | Row[]) {
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const errKey = `${table}:insert`;
          const inserted = rowsArr.map((r) => ({ id: (r.id as string) ?? `${table}-${++idCounter}`, ...r }));
          return {
            select() {
              return {
                single() {
                  bump(errKey);
                  if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] });
                  tables[table].push(...inserted);
                  return Promise.resolve({ data: inserted[0] ?? null, error: null });
                },
              };
            },
            then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              bump(errKey);
              if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
              tables[table].push(...inserted);
              return Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
            },
          };
        },
        update(payload: Row) {
          let filtered = tables[table];
          const errKey = `${table}:update`;
          const builder = {
            eq(field: string, value: unknown) {
              filtered = filtered.filter((r) => r[field] === value);
              return builder;
            },
            then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
              bump(errKey);
              if (errors[errKey]) return Promise.resolve({ data: null, error: errors[errKey] }).then(resolve, reject);
              for (const row of filtered) Object.assign(row, payload);
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
    storage: {
      from(_bucket: string) {
        return {
          createSignedUrl(_path: string, _secs: number) {
            return Promise.resolve({ data: { signedUrl: "https://signed.example/x" }, error: null });
          },
        };
      },
    },
  };

  return {
    admin,
    tables,
    calls,
    setError(table: string, op: "select" | "insert" | "update", err: { message: string }) {
      errors[`${table}:${op}`] = err;
    },
  };
}

function baseVehicle(overrides: Row = {}) {
  return {
    id: VEHICLE_ID,
    tenant_id: TENANT_A,
    qr_token: TOKEN,
    label: "Van 8",
    plate: "AB123CD",
    capacity: 8,
    vehicle_size: "medium",
    notes: null,
    insurance_expiry: null,
    road_tax_expiry: null,
    inspection_expiry: null,
    km: 1000,
    telaio: null,
    active: true,
    radius_vehicle_id: null,
    blocked_until: null,
    blocked_reason: null,
    libretto_document_path: null,
    libretto_uploaded_at: null,
    libretto_document_path_back: null,
    libretto_uploaded_at_back: null,
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  checkRateLimit: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/server/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { GET, POST } from "@/app/api/vehicle/[token]/route";

function makeGetRequest() {
  return new NextRequest(`http://localhost:3010/api/vehicle/${TOKEN}`, { method: "GET" });
}
function callGet(token: string = TOKEN) {
  return GET(makeGetRequest(), { params: Promise.resolve({ token }) });
}

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3010/api/vehicle/${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown>, token: string = TOKEN) {
  return POST(makePostRequest(body), { params: Promise.resolve({ token }) });
}

function assertNoForbiddenFields(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("details");
  expect(body).not.toHaveProperty("hint");
  expect(body).not.toHaveProperty("code");
  expect(body).not.toHaveProperty("stack");
}

describe("SEC-06 — sanitizzazione errori su vehicle/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  });

  it("1. success GET invariato: veicolo trovato → 200 con tutte le sezioni attese", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.vehicle.id).toBe(VEHICLE_ID);
    expect(body.anomalies).toEqual([]);
    expect(body.openLog).toBeNull();
    expect(body.kmLogs).toEqual([]);
    expect(body.fuel).toEqual([]);
    expect(body.drivers).toEqual([]);
    expect(Array.isArray(body.compliance)).toBe(true);
    expect(body.documents).toEqual([]);
  });

  it("2. success POST invariato: km_start riuscito → 200 { ok: true, log_id }", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "km_start", driver_name: "Mario Rossi", start_km: 1200 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.log_id).toBe("string");
  });

  it("3. token invalido invariato (GET): 404 messaggio business invariato", async () => {
    const fake = createFakeAdmin({ vehicles: [] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet("token-inesistente");
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Veicolo non trovato." });
  });

  it("4. not-found business error invariato (POST): 404 messaggio business invariato", async () => {
    const fake = createFakeAdmin({ vehicles: [] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "km_start", driver_name: "Mario", start_km: 100 }, "token-inesistente");
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Veicolo non trovato." });
  });

  it("5. leak 1 (km_start insert): errore ricco (constraint+relation+column+SQLSTATE) → nessun frammento raw nella risposta", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    fake.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "km_start", driver_name: "Mario Rossi", start_km: 1200 });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("duplicate key");
    expect(rawText).not.toContain("unique constraint");
  });

  it("6. constraint name NON presente (leak 1)", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    fake.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "km_start", driver_name: "Mario Rossi", start_km: 1200 });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("vehicle_km_logs_vehicle_id_open_idx");
  });

  it("7. table/relation name NON presente (leak 1)", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    fake.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "km_start", driver_name: "Mario Rossi", start_km: 1200 });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("relation");
  });

  it("8. column name NON presente (leak 1)", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    fake.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "km_start", driver_name: "Mario Rossi", start_km: 1200 });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain('column "vehicle_id"');
    expect(rawText).not.toContain("SQLSTATE");
  });

  it("9. leak 2 (km_end update) sanitizzato: nessun frammento raw nella risposta", async () => {
    const fake = createFakeAdmin({
      vehicles: [baseVehicle()],
      vehicle_km_logs: [{ id: LOG_ID, vehicle_id: VEHICLE_ID, start_km: 1000, end_km: null }],
    });
    fake.setError("vehicle_km_logs", "update", { message: DISTINCTIVE_KM_END_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "km_end", log_id: LOG_ID, end_km: 1200 });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("fk_vehicle_km_logs_vehicle");
    expect(rawText).not.toContain("foreign key constraint");
  });

  it("10. leak 3 (fuel insert) sanitizzato: nessun frammento raw nella risposta", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    fake.setError("vehicle_fuel", "insert", { message: DISTINCTIVE_FUEL_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "fuel", liters: 40, cost: 60, station: "Agip" });
    const rawText = await res.clone().text();

    expect(rawText).not.toContain("submitted_via_qr_legacy");
    expect(rawText).not.toContain("does not exist");
  });

  it("11. catch generico: N/A, questa route non ha un try/catch esterno (a differenza di cancel-respond/shuttle-schedules) — nessun quarto leak esiste da sanitizzare", () => {
    expect(true).toBe(true);
  });

  it("12. status HTTP invariati per tutti e tre i rami DB-error: 500", async () => {
    const fakeStart = createFakeAdmin({ vehicles: [baseVehicle()] });
    fakeStart.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fakeStart.admin);
    expect((await callPost({ action: "km_start", driver_name: "Mario", start_km: 100 })).status).toBe(500);

    const fakeEnd = createFakeAdmin({
      vehicles: [baseVehicle()],
      vehicle_km_logs: [{ id: LOG_ID, vehicle_id: VEHICLE_ID, start_km: 1000, end_km: null }],
    });
    fakeEnd.setError("vehicle_km_logs", "update", { message: DISTINCTIVE_KM_END_ERROR });
    mocks.createClient.mockReturnValue(fakeEnd.admin);
    expect((await callPost({ action: "km_end", log_id: LOG_ID, end_km: 1200 })).status).toBe(500);

    const fakeFuel = createFakeAdmin({ vehicles: [baseVehicle()] });
    fakeFuel.setError("vehicle_fuel", "insert", { message: DISTINCTIVE_FUEL_ERROR });
    mocks.createClient.mockReturnValue(fakeFuel.admin);
    expect((await callPost({ action: "fuel", liters: 40 })).status).toBe(500);
  });

  it("13. fallback generico corretto per ciascun ramo", async () => {
    const fakeStart = createFakeAdmin({ vehicles: [baseVehicle()] });
    fakeStart.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fakeStart.admin);
    const bodyStart = await (await callPost({ action: "km_start", driver_name: "Mario", start_km: 100 })).json();
    expect(bodyStart).toEqual({ error: "Impossibile registrare l'inizio turno." });

    const fakeEnd = createFakeAdmin({
      vehicles: [baseVehicle()],
      vehicle_km_logs: [{ id: LOG_ID, vehicle_id: VEHICLE_ID, start_km: 1000, end_km: null }],
    });
    fakeEnd.setError("vehicle_km_logs", "update", { message: DISTINCTIVE_KM_END_ERROR });
    mocks.createClient.mockReturnValue(fakeEnd.admin);
    const bodyEnd = await (await callPost({ action: "km_end", log_id: LOG_ID, end_km: 1200 })).json();
    expect(bodyEnd).toEqual({ error: "Impossibile registrare la fine turno." });

    const fakeFuel = createFakeAdmin({ vehicles: [baseVehicle()] });
    fakeFuel.setError("vehicle_fuel", "insert", { message: DISTINCTIVE_FUEL_ERROR });
    mocks.createClient.mockReturnValue(fakeFuel.admin);
    const bodyFuel = await (await callPost({ action: "fuel", liters: 40 })).json();
    expect(bodyFuel).toEqual({ error: "Impossibile registrare il rifornimento." });
  });

  it("14. nessun details/hint/code nel body per tutti e tre i rami", async () => {
    const fakeStart = createFakeAdmin({ vehicles: [baseVehicle()] });
    fakeStart.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fakeStart.admin);
    assertNoForbiddenFields(await (await callPost({ action: "km_start", driver_name: "Mario", start_km: 100 })).json());

    const fakeEnd = createFakeAdmin({
      vehicles: [baseVehicle()],
      vehicle_km_logs: [{ id: LOG_ID, vehicle_id: VEHICLE_ID, start_km: 1000, end_km: null }],
    });
    fakeEnd.setError("vehicle_km_logs", "update", { message: DISTINCTIVE_KM_END_ERROR });
    mocks.createClient.mockReturnValue(fakeEnd.admin);
    assertNoForbiddenFields(await (await callPost({ action: "km_end", log_id: LOG_ID, end_km: 1200 })).json());

    const fakeFuel = createFakeAdmin({ vehicles: [baseVehicle()] });
    fakeFuel.setError("vehicle_fuel", "insert", { message: DISTINCTIVE_FUEL_ERROR });
    mocks.createClient.mockReturnValue(fakeFuel.admin);
    assertNoForbiddenFields(await (await callPost({ action: "fuel", liters: 40 })).json());
  });

  it("15. nessun oggetto error serializzato: body.error è sempre una stringa", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    fake.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    const body = await (await callPost({ action: "km_start", driver_name: "Mario", start_km: 100 })).json();

    expect(typeof body.error).toBe("string");
  });

  it("16. nessuna auth introdotta: richiesta senza header Authorization raggiunge comunque la business logic", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callGet();

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("17. endpoint resta pubblico: POST senza Authorization raggiunge comunque la business logic", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    mocks.createClient.mockReturnValue(fake.admin);

    const res = await callPost({ action: "km_start", driver_name: "Mario", start_km: 100 });

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("18. side effects invariati: km_start riuscito aggiorna comunque vehicles.km", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    mocks.createClient.mockReturnValue(fake.admin);

    await callPost({ action: "km_start", driver_name: "Mario", start_km: 1500 });

    const updatedVehicle = fake.tables.vehicles.find((v) => v.id === VEHICLE_ID);
    expect(updatedVehicle?.km).toBe(1500);
  });

  it("19. nessuna mutazione aggiuntiva quando l'insert km_start fallisce: vehicles.km resta invariato", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle({ km: 999 })] });
    fake.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    await callPost({ action: "km_start", driver_name: "Mario", start_km: 1500 });

    const vehicle = fake.tables.vehicles.find((v) => v.id === VEHICLE_ID);
    expect(vehicle?.km).toBe(999);
  });

  it("20. server-side logging avviene una sola volta per errore", async () => {
    const fake = createFakeAdmin({ vehicles: [baseVehicle()] });
    fake.setError("vehicle_km_logs", "insert", { message: DISTINCTIVE_RICH_ERROR });
    mocks.createClient.mockReturnValue(fake.admin);

    await callPost({ action: "km_start", driver_name: "Mario", start_km: 100 });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    const logged = mocks.auditLog.mock.calls[0][0];
    expect(logged.level).toBe("error");
    expect(logged.details.message).toBe(DISTINCTIVE_RICH_ERROR);
  });
});
