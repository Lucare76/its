import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { vi } from "vitest";

/**
 * OBIETTIVO A — dispersione pax stessa fermata nelle PARTENZE.
 *
 * Dopo il fix "solo 4 pax Terni" (idempotenza/capienza), è emerso un secondo
 * problema: l'algoritmo riga-per-riga poteva spezzare una fermata su più bus
 * anche quando UN SOLO bus della linea aveva capienza sufficiente per
 * l'intero gruppo, solo perché il primo bus in sort_order aveva QUALCHE
 * posto libero (es. 4 su 18 richiesti). Questo produceva anche bus
 * "vuoti in mezzo" tra bus già in uso.
 *
 * Questo file verifica pickBusesForDepartureStopGroup (route.ts) tramite
 * l'azione POST import_excel_auto in direzione departure, coi 6 casi
 * richiesti, e verifica che la direzione arrival resti INVARIATA (logica
 * riga-per-riga preesistente, mai toccata da questo fix).
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/bus-network-loader", () => ({ loadBusNetwork: vi.fn(async () => ({})) }));

import { POST } from "@/app/api/ops/bus-network/route";

const TENANT = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const LINE_ID = "75523299-187a-4775-a1d1-2402d7e11e15";
const TERNI_STOP_ID = "e49a8739-d6ab-4f27-9837-9de0cbdb7872";
const OTHER_STOP_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const BUS_IDS = ["bus-centro-1", "bus-centro-2", "bus-centro-3", "bus-centro-4"];
const DATE = "2026-09-06";
const CAPACITY = 54;

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]>) {
  let idCounter = 0;
  const nextId = (table: string) => `gen-${table}-${++idCounter}`;

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;

    const rowsForFilters = () => (seed[table] ?? []).filter((r) => filters.every((f) => f(r)));

    const finishInsert = () => {
      const rows = Array.isArray(payload) ? payload : [payload as Row];
      const withIds = rows.map((r) => ({ id: nextId(table), ...r }));
      seed[table] = [...(seed[table] ?? []), ...withIds];
      return withIds;
    };
    const finishUpdate = () => {
      const matched = rowsForFilters();
      const ids = new Set(matched.map((r) => r.id));
      seed[table] = (seed[table] ?? []).map((r) => (ids.has(r.id) ? { ...r, ...(payload as Row) } : r));
      return matched.map((r) => ({ ...r, ...(payload as Row) }));
    };
    const finishDelete = () => {
      const matched = rowsForFilters();
      const ids = new Set(matched.map((r) => r.id));
      seed[table] = (seed[table] ?? []).filter((r) => !ids.has(r.id));
      return matched;
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.not = () => b;
    b.eq = (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; };
    b.is = (col: string, val: null) => { filters.push((r) => (r[col] ?? null) === val); return b; };
    b.ilike = (col: string, val: string) => {
      const needle = String(val).trim().toLowerCase();
      filters.push((r) => String(r[col] ?? "").trim().toLowerCase() === needle);
      return b;
    };
    b.in = (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; };
    b.insert = (p: Row | Row[]) => { mode = "insert"; payload = p; return b; };
    b.update = (p: Row) => { mode = "update"; payload = p; return b; };
    b.delete = () => { mode = "delete"; return b; };
    b.maybeSingle = async () => {
      if (mode === "insert") { const rows = finishInsert(); return { data: rows[0] ?? null, error: null }; }
      if (mode === "update") { const rows = finishUpdate(); return { data: rows[0] ?? null, error: null }; }
      return { data: rowsForFilters()[0] ?? null, error: null };
    };
    b.single = async () => {
      if (mode === "insert") { const rows = finishInsert(); return { data: rows[0] ?? null, error: null }; }
      if (mode === "update") { const rows = finishUpdate(); return { data: rows[0] ?? null, error: null }; }
      return { data: rowsForFilters()[0] ?? null, error: null };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: null };
      if (mode === "insert") result = { data: finishInsert(), error: null };
      else if (mode === "update") result = { data: finishUpdate(), error: null };
      else if (mode === "delete") result = { data: finishDelete(), error: null };
      else result = { data: rowsForFilters(), error: null };
      return Promise.resolve(result).then(resolve, reject);
    };
    return b;
  }

  const admin = {
    from: (t: string) => builder(t),
    rpc: async (name: string, params: Row) => {
      if (name !== "allocate_bus_service") return { data: null, error: { message: `RPC ${name} non gestita nel fake test` } };
      const unit = (seed.tenant_bus_units ?? []).find((u) => u.id === params.p_bus_unit_id);
      if (!unit) return { data: null, error: { message: "Bus non trovato." } };
      // Riproduce il blocco esclusivo della RPC reale (allocate_bus_service,
      // 0270_bus_exclusive_reservation_lock.sql): un bus con reservation
      // esclusiva per un altro booking_group rifiuta il service.
      const exclusive = (seed.booking_group_bus_reservations ?? []).find(
        (r) => r.bus_unit_id === params.p_bus_unit_id && r.service_date === DATE && r.exclusive === true
      );
      if (exclusive) return { data: null, error: { message: "Bus riservato in esclusiva per un altro gruppo in questa data." } };
      const already = (seed.tenant_bus_allocations ?? []).some((a) => a.service_id === params.p_service_id);
      if (already) return { data: null, error: { message: "Il servizio e' gia allocato a un bus." } };
      const svc = (seed.services ?? []).find((s) => s.id === params.p_service_id);
      const existingPax = (seed.tenant_bus_allocations ?? [])
        .filter((a) => a.bus_unit_id === params.p_bus_unit_id)
        .reduce((sum, a) => {
          const s = (seed.services ?? []).find((x) => x.id === a.service_id);
          return s && svc && s.date === svc.date ? sum + Number(a.pax_assigned) : sum;
        }, 0);
      const capacity = Number(unit.capacity);
      const paxAssigned = Number(params.p_pax_assigned);
      if (existingPax + paxAssigned > capacity) {
        return { data: null, error: { message: "Capienza bus superata per questa data." } };
      }
      const allocId = nextId("tenant_bus_allocations");
      seed.tenant_bus_allocations = [...(seed.tenant_bus_allocations ?? []), {
        id: allocId, tenant_id: params.p_tenant_id, service_id: params.p_service_id,
        bus_line_id: params.p_bus_line_id, bus_unit_id: params.p_bus_unit_id,
        stop_id: params.p_stop_id, stop_name: params.p_stop_name, pax_assigned: paxAssigned,
      }];
      return { data: { allocation_id: allocId }, error: null };
    },
  };
  return { admin, seed };
}

function authCtx(admin: unknown, role = "operator") {
  return { admin, user: { id: "u1", email: "op@test.it" }, membership: { tenant_id: TENANT, role, suspended: false } };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/ops/bus-network", { method: "POST", body: JSON.stringify(body) });
}

/**
 * `busLoads[i]` = pax già assegnati al bus i (0-based) su UN'ALTRA fermata
 * (mai su Terni), esattamente come nell'incidente reale dove i bus erano già
 * parzialmente occupati da altre città prima dell'import.
 */
function baseSeed(busLoads: number[], opts: { direction?: "arrival" | "departure"; lockedBusIndex?: number } = {}): Record<string, Row[]> {
  const direction = opts.direction ?? "departure";
  const units: Row[] = busLoads.map((_, i) => ({
    id: BUS_IDS[i], tenant_id: TENANT, bus_line_id: LINE_ID, label: `CENTRO ${i + 1}`, capacity: CAPACITY, status: "open", sort_order: i + 1,
  }));
  const services: Row[] = [];
  const allocations: Row[] = [];
  busLoads.forEach((load, i) => {
    if (load > 0) {
      const svcId = `svc-pre-${i}`;
      services.push({ id: svcId, tenant_id: TENANT, date: DATE, direction, pax: load, customer_name: `Preesistente ${i}`, bus_city_origin: "ALTRA FERMATA", booking_service_kind: "bus_city_hotel", hotel_id: null });
      allocations.push({ id: `alloc-pre-${i}`, tenant_id: TENANT, service_id: svcId, bus_line_id: LINE_ID, bus_unit_id: BUS_IDS[i], stop_id: OTHER_STOP_ID, stop_name: "ALTRA FERMATA", pax_assigned: load });
    }
  });
  const seed: Record<string, Row[]> = {
    tenant_bus_line_stops: [
      { id: TERNI_STOP_ID, tenant_id: TENANT, bus_line_id: LINE_ID, stop_name: "TERNI", city: "TERNI", direction, stop_order: 1, active: true },
      { id: OTHER_STOP_ID, tenant_id: TENANT, bus_line_id: LINE_ID, stop_name: "ALTRA FERMATA", city: "ALTRA FERMATA", direction, stop_order: 2, active: true },
    ],
    tenant_bus_units: units,
    tenant_bus_lines: [{ id: LINE_ID, tenant_id: TENANT, family_code: "CENTRO" }],
    hotels: [],
    hotel_pickup_times: [],
    services,
    tenant_bus_allocations: allocations,
    bus_import_pending: [],
    booking_group_bus_reservations: [],
  };
  if (opts.lockedBusIndex !== undefined) {
    seed.booking_group_bus_reservations = [
      { tenant_id: TENANT, bus_unit_id: BUS_IDS[opts.lockedBusIndex], service_date: DATE, exclusive: true, booking_group_id: "OTHER-GROUP" },
    ];
  }
  return seed;
}

// Gruppo Terni da 18 pax su 8 righe (2+3+2+3+2+2+2+2), MAI spezzate al loro interno.
const ROWS_18 = [
  { name: "A", phone: "1", city: "TERNI", pax: 2, hotel: null, agency: null },
  { name: "B", phone: "2", city: "TERNI", pax: 3, hotel: null, agency: null },
  { name: "C", phone: "3", city: "TERNI", pax: 2, hotel: null, agency: null },
  { name: "D", phone: "4", city: "TERNI", pax: 3, hotel: null, agency: null },
  { name: "E", phone: "5", city: "TERNI", pax: 2, hotel: null, agency: null },
  { name: "F", phone: "6", city: "TERNI", pax: 2, hotel: null, agency: null },
  { name: "G", phone: "7", city: "TERNI", pax: 2, hotel: null, agency: null },
  { name: "H", phone: "8", city: "TERNI", pax: 2, hotel: null, agency: null },
];

// Gruppo da 70 pax (10 righe da 7 pax) — supera la capacità di un bus (54): split inevitabile.
const ROWS_70 = Array.from({ length: 10 }, (_, i) => ({
  name: `R${i}`, phone: String(i), city: "TERNI", pax: 7, hotel: null, agency: null,
}));

function importPayload(rows: typeof ROWS_18, direction: "arrival" | "departure" = "departure") {
  return { action: "import_excel_auto", direction, travel_date: DATE, rows };
}

function terniPaxByBus(seed: Record<string, Row[]>) {
  const byBus: Record<string, number> = {};
  for (const a of seed.tenant_bus_allocations) {
    if (a.stop_id !== TERNI_STOP_ID) continue;
    byBus[a.bus_unit_id as string] = (byBus[a.bus_unit_id as string] ?? 0) + Number(a.pax_assigned);
  }
  return byBus;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("import_excel_auto (departure) — strategia gruppo-fermata OBIETTIVO A", () => {
  it("CASO 1: loads=[50,20,0], Terni=18 -> tutto sul secondo bus (non 4+14)", async () => {
    const seed = baseSeed([50, 20, 0]);
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post(importPayload(ROWS_18)));
    const body = await res.json();
    expect(body.imported_rows).toBe(8);
    expect(body.pending_rows).toBe(0);

    const byBus = terniPaxByBus(seed);
    expect(byBus[BUS_IDS[0]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[1]]).toBe(18);
    expect(byBus[BUS_IDS[2]] ?? 0).toBe(0);
  });

  it("CASO 2: loads=[30,0,0], Terni=18 -> tutto sul primo bus", async () => {
    const seed = baseSeed([30, 0, 0]);
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post(importPayload(ROWS_18)));

    const byBus = terniPaxByBus(seed);
    expect(byBus[BUS_IDS[0]]).toBe(18);
    expect(byBus[BUS_IDS[1]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[2]] ?? 0).toBe(0);
  });

  it("CASO 3: loads=[50,45,0], Terni=18 -> tutto sul terzo bus (non spezzati 4+9+5)", async () => {
    const seed = baseSeed([50, 45, 0]);
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post(importPayload(ROWS_18)));

    const byBus = terniPaxByBus(seed);
    expect(byBus[BUS_IDS[0]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[1]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[2]]).toBe(18);
  });

  it("CASO 4: loads=[54,0,0] (primo bus pieno), Terni=18 -> tutto sul secondo bus", async () => {
    const seed = baseSeed([54, 0, 0]);
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post(importPayload(ROWS_18)));

    const byBus = terniPaxByBus(seed);
    expect(byBus[BUS_IDS[0]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[1]]).toBe(18);
  });

  it("CASO 5: gruppo di 70 pax (> capacità di un bus) -> split minimo, blocchi contigui, nessuna riga spezzata", async () => {
    const seed = baseSeed([0, 0]);
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post(importPayload(ROWS_70)));
    const body = await res.json();
    expect(body.imported_rows).toBe(10);
    expect(body.pending_rows).toBe(0);

    const byBus = terniPaxByBus(seed);
    // 7 righe da 7 pax = 49 sul primo bus (54 di capienza), le 3 restanti (21) sul secondo.
    expect(byBus[BUS_IDS[0]]).toBe(49);
    expect(byBus[BUS_IDS[1]]).toBe(21);
    expect((byBus[BUS_IDS[0]] ?? 0) + (byBus[BUS_IDS[1]] ?? 0)).toBe(70);
  });

  it("CASO 6: bus intermedio esclusivo/locked -> viene saltato, si usa il successivo", async () => {
    // BUS_1 ha solo 4 posti liberi (non basta per 18), BUS_2 è riservato in
    // esclusiva per un altro gruppo -> deve essere BUS_3 a ricevere il gruppo.
    const seed = baseSeed([50, 0, 0], { lockedBusIndex: 1 });
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post(importPayload(ROWS_18)));
    const body = await res.json();
    expect(body.imported_rows).toBe(8);
    expect(body.pending_rows).toBe(0);

    const byBus = terniPaxByBus(seed);
    expect(byBus[BUS_IDS[0]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[1]] ?? 0).toBe(0); // locked, mai usato
    expect(byBus[BUS_IDS[2]]).toBe(18);
  });

  it("ARRIVAL invariato: stessa situazione di CASO 1 in direzione arrival resta riga-per-riga (4+14, non 18 su un bus)", async () => {
    const seed = baseSeed([50, 20, 0], { direction: "arrival" });
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post(importPayload(ROWS_18, "arrival")));
    const body = await res.json();
    expect(body.imported_rows).toBe(8);
    expect(body.pending_rows).toBe(0);

    const byBus = terniPaxByBus(seed);
    // Comportamento preesistente (mai toccato da OBIETTIVO A): riga per riga,
    // "stessa fermata se c'è posto" -> si spezza 4 + 14 come prima del fix.
    expect(byBus[BUS_IDS[0]]).toBe(4);
    expect(byBus[BUS_IDS[1]]).toBe(14);
    expect(byBus[BUS_IDS[2]] ?? 0).toBe(0);
  });
});
