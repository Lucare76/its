import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test Regola 1 (navette hotel) — auto-assign.
 *
 * Sostituisce tests/unit/piano-san-nicola-shift.test.ts (testava
 * isSanNicolaShuttle, rimossa nel commit 94c50c4 e sostituita da
 * isHotelShuttle/buildHotelShiftDrafts). Copre la business rule reale:
 *
 *  - continuità: un autista che copre tutta la fascia la fa tutta lui;
 *  - autisti diversi ammessi tra fascia mattina e fascia sera;
 *  - San Nicola è ESCLUSIVO durante la fascia (nessun altro servizio nei
 *    "buchi" tra una corsa e l'altra);
 *  - President/Cristallo NON sono esclusivi (i buchi restano liberi per
 *    altri servizi compatibili).
 *
 * assignGlobalPlanner (lib/piano-global-planner.ts) ha una propria suite
 * dedicata (piano-operational-duration-and-global-planner.test.ts) e viene
 * qui mockato come "spy": cattura gli unit realmente costruiti da
 * buildHotelShiftDrafts (il codice sotto test) senza rieseguire la logica
 * del planner stesso — la garanzia che un unit "locked" con
 * current_driver_key riservi l'autista per quella finestra è responsabilità
 * del planner, già verificata altrove.
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOTEL_SAN_NICOLA = "h1111111-1111-4111-8111-111111111111";
const HOTEL_PRESIDENT = "h2222222-2222-4222-8222-222222222222";
const HOTEL_CRISTALLO = "h3333333-3333-4333-8333-333333333333";
const DRIVER_A_PROFILE = "d1111111-1111-4111-8111-111111111111";
const DRIVER_A_USER = "u1111111-1111-4111-8111-111111111111";
const DRIVER_B_PROFILE = "d2222222-2222-4222-8222-222222222222";
const DRIVER_B_USER = "u2222222-2222-4222-8222-222222222222";
const VEHICLE_ID = "v1111111-1111-4111-8111-111111111111";
const VEHICLE_LABEL = "Van 8";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;
type SelectResult = { data: Row[] | null; error: { message: string } | null };

function createAutoAssignSupabase(
  seed: Partial<Record<
    | "services" | "hotels" | "vehicles" | "assignments" | "trip_groups"
    | "hotel_vehicle_limits" | "driver_daily_availability" | "vehicle_daily_availability"
    | "vehicle_time_blocks" | "daily_availability_confirmations" | "status_events",
    Row[]
  >> = {}
) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    hotels: [...(seed.hotels ?? [])],
    vehicles: [...(seed.vehicles ?? [])],
    assignments: [...(seed.assignments ?? [])],
    trip_groups: [...(seed.trip_groups ?? [])],
    hotel_vehicle_limits: [...(seed.hotel_vehicle_limits ?? [])],
    driver_daily_availability: [...(seed.driver_daily_availability ?? [])],
    vehicle_daily_availability: [...(seed.vehicle_daily_availability ?? [])],
    vehicle_time_blocks: [...(seed.vehicle_time_blocks ?? [])],
    daily_availability_confirmations: [...(seed.daily_availability_confirmations ?? [])],
    status_events: [...(seed.status_events ?? [])],
  };

  const calls = {
    tripGroupsInserted: [] as Row[],
    assignmentsUpserted: [] as Row[],
  };

  function makeChain(table: string, op: "select" | "update" | "delete", payload?: Row) {
    if (!(table in tables)) throw new Error(`[fake supabase] tabella non definita: ${table}`);
    let filtered = tables[table]!;

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
      order() {
        return builder;
      },
      limit(n: number) {
        filtered = filtered.slice(0, n);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: (v: SelectResult) => unknown, reject?: (e: unknown) => unknown) {
        if (op === "update") {
          for (const row of filtered) Object.assign(row, payload);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        if (op === "delete") {
          const toRemove = new Set(filtered);
          for (let i = tables[table]!.length - 1; i >= 0; i--) {
            if (toRemove.has(tables[table]![i])) tables[table]!.splice(i, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select(_cols?: string) {
          return makeChain(table, "select");
        },
        update(payload: Row) {
          return makeChain(table, "update", payload);
        },
        delete() {
          return makeChain(table, "delete");
        },
        insert(rows: Row | Row[]) {
          const rowsArr = Array.isArray(rows) ? rows : [rows];
          if (table === "trip_groups") {
            const inserted = rowsArr.map((r, idx) => ({
              id: `grp-${tables.trip_groups!.length + idx + 1}`,
              status: "active",
              ...r,
            }));
            tables.trip_groups!.push(...inserted);
            calls.tripGroupsInserted.push(...inserted);
            return { select: () => Promise.resolve({ data: inserted, error: null }) };
          }
          tables[table]!.push(...rowsArr);
          return Promise.resolve({ data: rowsArr, error: null });
        },
        upsert(rows: Row | Row[], _opts?: unknown) {
          const rowsArr = Array.isArray(rows) ? rows : [rows];
          if (table === "assignments") {
            calls.assignmentsUpserted.push(...rowsArr);
            tables.assignments!.push(...rowsArr);
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { admin, tables, calls };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  listDriverRegistry: vi.fn(),
  loadVehicleCommitmentsForDate: vi.fn(),
  loadLearnedPatterns: vi.fn(),
  updateLearnedPatterns: vi.fn(),
  extractFeatures: vi.fn(),
  logAssignmentChange: vi.fn(),
  assignGlobalPlanner: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/driver-registry", () => ({
  listDriverRegistry: mocks.listDriverRegistry,
}));
vi.mock("@/lib/server/vehicle-commitments", () => ({
  loadVehicleCommitmentsForDate: mocks.loadVehicleCommitmentsForDate,
}));
vi.mock("@/lib/server/learned-patterns", () => ({
  loadLearnedPatterns: mocks.loadLearnedPatterns,
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));
vi.mock("@/lib/server/assignment-history", () => ({
  extractFeatures: mocks.extractFeatures,
  logAssignmentChange: mocks.logAssignmentChange,
}));
vi.mock("@/lib/piano-global-planner", () => ({
  assignGlobalPlanner: mocks.assignGlobalPlanner,
}));

import { POST } from "@/app/api/ops/piano-giorno/auto-assign/route";

function driverRow(overrides: Row = {}) {
  return {
    id: DRIVER_A_PROFILE,
    user_id: DRIVER_A_USER,
    full_name: "Mario Rossi",
    phone: null,
    username: null,
    active: true,
    has_access: true,
    access_suspended: false,
    role: "driver",
    max_vehicle_capacity: null,
    ...overrides,
  };
}

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_A,
    date: TEST_DATE,
    time: "09:00:00",
    direction: "arrival",
    vessel: null,
    hotel_id: HOTEL_SAN_NICOLA,
    pax: 2,
    status: "new",
    is_draft: false,
    meeting_point: null,
    pickup_hotel: null,
    customer_name: "Cliente Test",
    booking_service_kind: "navetta",
    service_type_code: null,
    arrival_time: null,
    orario_barca: null,
    porto_bruno: null,
    barca_compagnia: null,
    ferry_details: null,
    ...overrides,
  };
}

function baseSeed(overrides: Parameters<typeof createAutoAssignSupabase>[0] = {}) {
  return createAutoAssignSupabase({
    hotels: [
      { id: HOTEL_SAN_NICOLA, tenant_id: TENANT_A, name: "Hotel San Nicola Terme", zone: "Forio" },
      { id: HOTEL_PRESIDENT, tenant_id: TENANT_A, name: "Hotel President", zone: "Ischia Porto" },
      { id: HOTEL_CRISTALLO, tenant_id: TENANT_A, name: "Hotel Cristallo", zone: "Ischia Porto" },
    ],
    vehicles: [{ id: VEHICLE_ID, tenant_id: TENANT_A, label: VEHICLE_LABEL, capacity: 8, active: true }],
    daily_availability_confirmations: [{ tenant_id: TENANT_A, date: TEST_DATE, confirmed: true }],
    ...overrides,
  });
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:3010/api/ops/piano-giorno/auto-assign", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}
function callPost(body: Record<string, unknown> = { date: TEST_DATE, mode: "unassigned_only" }) {
  return POST(makeRequest(body));
}

function authorizeAs(fake: ReturnType<typeof createAutoAssignSupabase>) {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: "user-1", email: "op@test.dev" },
    membership: { tenant_id: TENANT_A, role: "operator", suspended: false },
  });
}

/** Recupera gli unit "hotel_shift_*" passati alla (mockata) assignGlobalPlanner. */
function capturedHotelShiftUnits(): Array<Record<string, unknown>> {
  const call = mocks.assignGlobalPlanner.mock.calls[0]?.[0] as { units: Array<Record<string, unknown>> } | undefined;
  return (call?.units ?? []).filter((u) => String(u.id).startsWith("hotel_shift_"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDriverRegistry.mockResolvedValue([
    driverRow(),
    driverRow({ id: DRIVER_B_PROFILE, user_id: DRIVER_B_USER, full_name: "Luca Bianchi" }),
  ]);
  mocks.loadVehicleCommitmentsForDate.mockResolvedValue({ rows: [], byVehicleId: new Map() });
  mocks.loadLearnedPatterns.mockResolvedValue([]);
  mocks.updateLearnedPatterns.mockResolvedValue(undefined);
  mocks.extractFeatures.mockReturnValue({});
  mocks.logAssignmentChange.mockResolvedValue(undefined);
  mocks.assignGlobalPlanner.mockReturnValue([]);
});

describe("Regola 1 — San Nicola: continuità + esclusività sull'intera fascia", () => {
  it("1. continuità: un solo autista copre tutta la fascia mattina (4 corse)", async () => {
    const fake = baseSeed({
      services: [
        serviceRow("svc-1", { time: "08:30:00" }),
        serviceRow("svc-2", { time: "09:30:00" }),
        serviceRow("svc-3", { time: "10:30:00" }),
        serviceRow("svc-4", { time: "11:30:00" }),
      ],
    });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Le 4 corse San Nicola sono assegnate direttamente (draftAssignments),
    // non tramite il global planner: 4 trip_groups/assignments, stesso autista.
    expect(fake.calls.assignmentsUpserted).toHaveLength(4);
    const drivers = new Set(fake.calls.assignmentsUpserted.map((a) => a.driver_profile_id));
    expect(drivers.size).toBe(1);
    expect([...drivers][0]).toBe(DRIVER_A_PROFILE);
  });

  it("2. esclusività: il blocco copre l'INTERA fascia (dal primo al 25min dopo l'ultimo), non solo le singole corse", async () => {
    const fake = baseSeed({
      services: [
        serviceRow("svc-1", { time: "08:30:00" }),
        serviceRow("svc-2", { time: "09:30:00" }),
        serviceRow("svc-3", { time: "10:30:00" }),
      ],
    });
    authorizeAs(fake);

    await callPost();

    const units = capturedHotelShiftUnits();
    // Un solo blocco per la fascia (non uno per corsa).
    expect(units).toHaveLength(1);
    expect(units[0]!.start).toBe("08:30");
    expect(units[0]!.end).toBe("10:55"); // ultima corsa 10:30 + 25 min
    expect(units[0]!.current_driver_key).toBe(DRIVER_A_PROFILE);
    expect(units[0]!.locked).toBe(true);
  });

  it("3. driver diversi tra fascia mattina e fascia sera sono ammessi (gap > 60 min)", async () => {
    const fake = baseSeed({
      services: [
        serviceRow("svc-am1", { time: "08:30:00" }),
        serviceRow("svc-am2", { time: "09:30:00" }),
        serviceRow("svc-pm1", { time: "16:00:00" }),
        serviceRow("svc-pm2", { time: "17:00:00" }),
      ],
      // L'anchor "assegnato" per la fascia serale è forzato su Driver B
      // tramite un assignment preesistente, cosi il planner mattina/sera
      // puo scegliere anchor differenti in modo deterministico.
      assignments: [
        { id: "asg-pm", tenant_id: TENANT_A, service_id: "svc-pm1", driver_profile_id: DRIVER_B_PROFILE, driver_user_id: DRIVER_B_USER, group_id: null, vehicle_label: null, locked_by_operator: false },
      ],
    });
    authorizeAs(fake);

    await callPost();

    const units = capturedHotelShiftUnits();
    // Due fasce distinte, con autisti diversi.
    expect(units).toHaveLength(2);
    const drivers = units.map((u) => u.current_driver_key).sort();
    expect(drivers).toEqual([DRIVER_A_PROFILE, DRIVER_B_PROFILE].sort());
    // Il blocco mattina non si estende fino alla sera.
    const morning = units.find((u) => u.start === "08:30")!;
    expect(morning.end).toBe("09:55");
  });

  it("4. la fascia mattina non blocca automaticamente quella sera (finestre non contigue)", async () => {
    const fake = baseSeed({
      services: [
        serviceRow("svc-am1", { time: "08:30:00" }),
        serviceRow("svc-pm1", { time: "19:00:00" }),
      ],
    });
    authorizeAs(fake);

    await callPost();

    const units = capturedHotelShiftUnits();
    expect(units).toHaveLength(2);
    expect(units.some((u) => u.start === "08:30" && u.end === "08:55")).toBe(true);
    expect(units.some((u) => u.start === "19:00" && u.end === "19:25")).toBe(true);
  });

  it("5. ultima navetta con orario di inizio pari alla fine turno dell'autista resta assegnabile", async () => {
    const fake = baseSeed({
      services: [serviceRow("svc-1", { time: "19:00:00" })],
      driver_daily_availability: [
        { tenant_id: TENANT_A, date: TEST_DATE, driver_profile_id: DRIVER_A_PROFILE, available: true, available_from: "12:00", available_to: "19:00" },
      ],
    });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(fake.calls.assignmentsUpserted).toHaveLength(1);
    expect(fake.calls.assignmentsUpserted[0]!.driver_profile_id).toBe(DRIVER_A_PROFILE);
    expect(body.ok).toBe(true);
  });
});

describe("Regola 1 — President: continuità senza esclusività", () => {
  it("6. continuità: un solo autista copre la fascia President", async () => {
    const fake = baseSeed({
      services: [
        serviceRow("svc-1", { time: "09:30:00", hotel_id: HOTEL_PRESIDENT }),
        serviceRow("svc-2", { time: "10:00:00", hotel_id: HOTEL_PRESIDENT }),
      ],
    });
    authorizeAs(fake);

    await callPost();

    const drivers = new Set(fake.calls.assignmentsUpserted.map((a) => a.driver_profile_id));
    expect(drivers.size).toBe(1);
  });

  it("7. non esclusività: nessun blocco copre l'intera fascia President, solo le singole corse (±25 min)", async () => {
    // 09:30 e 10:15 (gap 45 min): stesso sotto-gruppo di fascia (il gap
    // supera i 60 min solo tra sotto-gruppi diversi), cosi il test isola
    // davvero l'assenza di esclusivita e non una semplice separazione in
    // fasce distinte.
    const fake = baseSeed({
      services: [
        serviceRow("svc-1", { time: "09:30:00", hotel_id: HOTEL_PRESIDENT }),
        serviceRow("svc-2", { time: "10:15:00", hotel_id: HOTEL_PRESIDENT }),
      ],
    });
    authorizeAs(fake);

    await callPost();

    const units = capturedHotelShiftUnits();
    // Un blocco per corsa (non uno unico per l'intera fascia): il "buco"
    // 09:55-10:15 non è coperto da nessun unit bloccante.
    expect(units).toHaveLength(2);
    expect(units.some((u) => u.start === "09:30" && u.end === "09:55")).toBe(true);
    expect(units.some((u) => u.start === "10:15" && u.end === "10:40")).toBe(true);
    const coversGap = units.some((u) => {
      const [sh, sm] = String(u.start).split(":").map(Number);
      const [eh, em] = String(u.end).split(":").map(Number);
      const startMin = sh! * 60 + sm!;
      const endMin = eh! * 60 + em!;
      return startMin <= 10 * 60 && endMin >= 10 * 60; // 10:00 nel buco
    });
    expect(coversGap).toBe(false);
  });

  it("8. ultima navetta President con orario == fine turno resta assegnabile", async () => {
    const fake = baseSeed({
      services: [serviceRow("svc-1", { time: "19:00:00", hotel_id: HOTEL_PRESIDENT })],
      driver_daily_availability: [
        { tenant_id: TENANT_A, date: TEST_DATE, driver_profile_id: DRIVER_A_PROFILE, available: true, available_from: "12:00", available_to: "19:00" },
      ],
    });
    authorizeAs(fake);

    await callPost();

    expect(fake.calls.assignmentsUpserted).toHaveLength(1);
  });
});

describe("Regola 1 — Cristallo: continuità senza esclusività", () => {
  it("9. continuità: un solo autista copre la fascia Cristallo", async () => {
    const fake = baseSeed({
      services: [
        serviceRow("svc-1", { time: "11:00:00", hotel_id: HOTEL_CRISTALLO }),
        serviceRow("svc-2", { time: "11:30:00", hotel_id: HOTEL_CRISTALLO }),
      ],
    });
    authorizeAs(fake);

    await callPost();

    const drivers = new Set(fake.calls.assignmentsUpserted.map((a) => a.driver_profile_id));
    expect(drivers.size).toBe(1);
  });

  it("10. non esclusività: blocco solo per singola corsa, non per l'intera fascia", async () => {
    const fake = baseSeed({
      services: [
        serviceRow("svc-1", { time: "11:00:00", hotel_id: HOTEL_CRISTALLO }),
        serviceRow("svc-2", { time: "11:45:00", hotel_id: HOTEL_CRISTALLO }),
      ],
    });
    authorizeAs(fake);

    await callPost();

    const units = capturedHotelShiftUnits();
    expect(units).toHaveLength(2);
  });

  it("11. ultima corsa Cristallo con orario == fine turno resta assegnabile", async () => {
    const fake = baseSeed({
      services: [serviceRow("svc-1", { time: "19:00:00", hotel_id: HOTEL_CRISTALLO })],
      driver_daily_availability: [
        { tenant_id: TENANT_A, date: TEST_DATE, driver_profile_id: DRIVER_A_PROFILE, available: true, available_from: "12:00", available_to: "19:00" },
      ],
    });
    authorizeAs(fake);

    await callPost();

    expect(fake.calls.assignmentsUpserted).toHaveLength(1);
  });
});

describe("Regola 1 — generici", () => {
  it("12. servizio non-navetta (transfer) non entra nella Regola 1", async () => {
    const fake = baseSeed({
      services: [serviceRow("svc-1", { time: "10:00:00", booking_service_kind: "transfer" })],
    });
    authorizeAs(fake);

    await callPost();

    // Nessun unit hotel_shift_* generato: il servizio non è passato da
    // buildHotelShiftDrafts, ma dal flusso generico (draft "draft_0").
    expect(capturedHotelShiftUnits()).toHaveLength(0);
  });

  it("13. un hotel generico (non San Nicola) non riceve mai il blocco esclusivo sull'intera fascia", async () => {
    const OTHER_HOTEL = "h9999999-9999-4999-8999-999999999999";
    const fake = baseSeed({
      hotels: [
        { id: HOTEL_SAN_NICOLA, tenant_id: TENANT_A, name: "Hotel San Nicola Terme", zone: "Forio" },
        { id: OTHER_HOTEL, tenant_id: TENANT_A, name: "Hotel Qualunque", zone: "Ischia Porto" },
      ],
      services: [
        serviceRow("svc-1", { time: "09:00:00", hotel_id: OTHER_HOTEL }),
        serviceRow("svc-2", { time: "09:30:00", hotel_id: OTHER_HOTEL }),
      ],
    });
    authorizeAs(fake);

    await callPost();

    const units = capturedHotelShiftUnits();
    expect(units).toHaveLength(2); // per-corsa, non un blocco unico di fascia
  });
});
