import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { vi } from "vitest";

/**
 * FIX MIRATO #2 — planner BUS-CENTRICO per le PARTENZE.
 *
 * Il primo fix (pickBusesForDepartureStopGroup, vedi
 * tests/unit/bus-network-departure-stop-group-strategy.test.ts) restava
 * FERMATA-CENTRICO: per ogni fermata, presa da sola, cercava "il primo bus
 * con capienza per l'intero gruppo" — indipendentemente dalle altre fermate
 * dello stesso import. Con PIÙ fermate nello stesso import questo poteva far
 * ripartire l'assegnazione da un bus più avanti (es. CENTRO 3) lasciando
 * CENTRO 1/2 con posti liberi che altri gruppi più piccoli avrebbero potuto
 * occupare — comportamento operativo non desiderato.
 *
 * planDepartureBusAssignments (route.ts) è BUS-CENTRICO: elabora l'INTERA
 * linea (tutte le fermate insieme) un bus alla volta, in sort_order,
 * riempiendo ogni bus con gruppi fermata COMPLETI prima di passare al
 * successivo. Questo file copre gli scenari multi-fermata (Esempi A/B della
 * richiesta) e i 9 test obbligatori; gli scenari mono-fermata (Esempi C/D/E)
 * restano coperti da bus-network-departure-stop-group-strategy.test.ts.
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/bus-network-loader", () => ({ loadBusNetwork: vi.fn(async () => ({})) }));

import { POST } from "@/app/api/ops/bus-network/route";

const TENANT = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const LINE_ID = "75523299-187a-4775-a1d1-2402d7e11e15";
const OTHER_STOP_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const BUS_IDS = ["bus-centro-1", "bus-centro-2", "bus-centro-3", "bus-centro-4"];
const DATE = "2026-09-06";
const CAPACITY = 54;

const STOP_IDS: Record<string, string> = {
  TERNI: "e49a8739-d6ab-4f27-9837-9de0cbdb7872",
  PERUGIA: "bbbbbbbb-2222-4222-8222-222222222222",
  ORTE: "cccccccc-3333-4333-8333-333333333333",
  VITERBO: "dddddddd-4444-4444-8444-444444444444",
};

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
  const stops: Row[] = [
    { id: OTHER_STOP_ID, tenant_id: TENANT, bus_line_id: LINE_ID, stop_name: "ALTRA FERMATA", city: "ALTRA FERMATA", direction, stop_order: 0, active: true },
    ...Object.entries(STOP_IDS).map(([city, id], i) => ({ id, tenant_id: TENANT, bus_line_id: LINE_ID, stop_name: city, city, direction, stop_order: i + 1, active: true })),
  ];
  const seed: Record<string, Row[]> = {
    tenant_bus_line_stops: stops,
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

/** Righe per una fermata: un elenco di pax (mai spezzati al loro interno). */
function rowsFor(city: string, paxList: number[]) {
  return paxList.map((pax, i) => ({ name: `${city}-${i}`, phone: String(i), city, pax, hotel: null, agency: null }));
}

function importPayload(rows: Array<{ name: string; phone: string; city: string; pax: number; hotel: null; agency: null }>, direction: "arrival" | "departure" = "departure") {
  return { action: "import_excel_auto", direction, travel_date: DATE, rows };
}

function paxByBusForStop(seed: Record<string, Row[]>, stopId: string) {
  const byBus: Record<string, number> = {};
  for (const a of seed.tenant_bus_allocations) {
    if (a.stop_id !== stopId) continue;
    byBus[a.bus_unit_id as string] = (byBus[a.bus_unit_id as string] ?? 0) + Number(a.pax_assigned);
  }
  return byBus;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("import_excel_auto (departure) — planner BUS-CENTRICO, multi-fermata", () => {
  it("1) bus tutti vuoti -> si parte da BUS 1 (mai da un bus più avanti)", async () => {
    const seed = baseSeed([0, 0, 0]);
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const rows = rowsFor("TERNI", [2, 3, 2, 3, 2, 2, 2, 2]); // 18 pax
    await POST(post(importPayload(rows)));

    const byBus = paxByBusForStop(seed, STOP_IDS.TERNI);
    expect(byBus[BUS_IDS[0]]).toBe(18);
    expect(byBus[BUS_IDS[1]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[2]] ?? 0).toBe(0);
  });

  it("2) BUS 1 con spazio sufficiente per Terni -> Terni resta tutta su BUS 1", async () => {
    const seed = baseSeed([36, 0, 0]); // 18 posti liberi su BUS 1
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const rows = rowsFor("TERNI", [10, 8]); // 18 pax
    await POST(post(importPayload(rows)));

    const byBus = paxByBusForStop(seed, STOP_IDS.TERNI);
    expect(byBus[BUS_IDS[0]]).toBe(18);
    expect(byBus[BUS_IDS[1]] ?? 0).toBe(0);
  });

  it("3) BUS 1 con 8 posti, Terni 18 + Orte 4 + Viterbo 2 -> Orte+Viterbo su BUS 1, Terni su BUS 2 (Esempio B)", async () => {
    const seed = baseSeed([46, 0, 0]); // 8 posti liberi su BUS 1
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const rows = [
      ...rowsFor("TERNI", [10, 8]),      // 18 pax
      ...rowsFor("ORTE", [4]),           // 4 pax
      ...rowsFor("VITERBO", [2]),        // 2 pax
    ];
    const res = await POST(post(importPayload(rows)));
    const body = await res.json();
    expect(body.imported_rows).toBe(4);
    expect(body.pending_rows).toBe(0);

    const terni = paxByBusForStop(seed, STOP_IDS.TERNI);
    const orte = paxByBusForStop(seed, STOP_IDS.ORTE);
    const viterbo = paxByBusForStop(seed, STOP_IDS.VITERBO);

    // Terni NON deve essere sul BUS 1 (non ci sta interamente) né spezzata.
    expect(terni[BUS_IDS[0]] ?? 0).toBe(0);
    expect(terni[BUS_IDS[1]]).toBe(18);
    // Orte e Viterbo occupano i posti residui di BUS 1 (fermata unita mantenuta).
    expect(orte[BUS_IDS[0]]).toBe(4);
    expect(viterbo[BUS_IDS[0]]).toBe(2);
  });

  it("4) BUS 1 con 4 posti (inutilizzabili per il gruppo), BUS 2 pieno, BUS 3 vuoto -> gruppo grande su BUS 3", async () => {
    const seed = baseSeed([50, 54, 0]);
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const rows = rowsFor("TERNI", [10, 8]); // 18 pax, non entra né in BUS1(4) né in BUS2(0)
    await POST(post(importPayload(rows)));

    const byBus = paxByBusForStop(seed, STOP_IDS.TERNI);
    expect(byBus[BUS_IDS[0]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[1]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[2]]).toBe(18);
  });

  it("5) nessun bus vuoto viene saltato se può accogliere almeno un gruppo completo (Esempio A: Perugia+Terni+Orte tutti su BUS 1)", async () => {
    const seed = baseSeed([0, 0, 0]);
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const rows = [
      ...rowsFor("TERNI", [10, 8]),      // 18 pax
      ...rowsFor("PERUGIA", [10, 10]),   // 20 pax
      ...rowsFor("ORTE", [4]),           // 4 pax
    ];
    const res = await POST(post(importPayload(rows)));
    const body = await res.json();
    expect(body.imported_rows).toBe(5);
    expect(body.pending_rows).toBe(0);

    const terni = paxByBusForStop(seed, STOP_IDS.TERNI);
    const perugia = paxByBusForStop(seed, STOP_IDS.PERUGIA);
    const orte = paxByBusForStop(seed, STOP_IDS.ORTE);

    // Tutte e tre le fermate (42 pax totali) stanno su BUS 1: nessun bus
    // vuoto (BUS 2/3) viene toccato mentre BUS 1 aveva ancora posto.
    expect(terni[BUS_IDS[0]]).toBe(18);
    expect(perugia[BUS_IDS[0]]).toBe(20);
    expect(orte[BUS_IDS[0]]).toBe(4);
    expect(Object.keys(terni)).not.toContain(BUS_IDS[1]);
    expect(Object.keys(perugia)).not.toContain(BUS_IDS[1]);
    expect(Object.keys(orte)).not.toContain(BUS_IDS[1]);
  });

  it("6) stessa fermata non spezzata quando un bus successivo può contenerla interamente", async () => {
    const seed = baseSeed([46, 0]); // 8 posti liberi su BUS 1
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const rows = rowsFor("TERNI", [2, 3, 2, 3, 2, 2, 2, 2]); // 18 pax, 8 righe
    const res = await POST(post(importPayload(rows)));
    const body = await res.json();
    expect(body.imported_rows).toBe(8);

    const byBus = paxByBusForStop(seed, STOP_IDS.TERNI);
    // MAI spezzata 8+10 tra BUS1 e BUS2: tutta su BUS2 (l'unico che la contiene intera).
    expect(byBus[BUS_IDS[0]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[1]]).toBe(18);
  });

  it("7) split inevitabile SOLO quando nessun piano senza split è possibile (gruppo 70 pax > capacità di ogni bus)", async () => {
    const seed = baseSeed([0, 0]);
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const rows = rowsFor("TERNI", Array.from({ length: 10 }, () => 7)); // 70 pax, 10 righe da 7
    const res = await POST(post(importPayload(rows)));
    const body = await res.json();
    expect(body.imported_rows).toBe(10);
    expect(body.pending_rows).toBe(0);

    const byBus = paxByBusForStop(seed, STOP_IDS.TERNI);
    expect(byBus[BUS_IDS[0]]).toBe(49); // 7 righe da 7
    expect(byBus[BUS_IDS[1]]).toBe(21); // 3 righe da 7
    expect((byBus[BUS_IDS[0]] ?? 0) + (byBus[BUS_IDS[1]] ?? 0)).toBe(70);
  });

  it("8) bus exclusive/locked possono essere saltati (mai proposti dal planner)", async () => {
    const seed = baseSeed([50, 0, 0], { lockedBusIndex: 1 }); // BUS 1: 4 posti, BUS 2: locked, BUS 3: vuoto
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const rows = rowsFor("TERNI", [10, 8]); // 18 pax
    const res = await POST(post(importPayload(rows)));
    const body = await res.json();
    expect(body.imported_rows).toBe(2);
    expect(body.pending_rows).toBe(0);

    const byBus = paxByBusForStop(seed, STOP_IDS.TERNI);
    expect(byBus[BUS_IDS[0]] ?? 0).toBe(0);
    expect(byBus[BUS_IDS[1]] ?? 0).toBe(0); // locked, mai usato
    expect(byBus[BUS_IDS[2]]).toBe(18);
  });

  it("9) ARRIVAL invariato: stessa situazione multi-fermata dell'Esempio B resta riga-per-riga (comportamento preesistente)", async () => {
    const seed = baseSeed([46, 0], { direction: "arrival" });
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const rows = rowsFor("TERNI", [2, 3, 2, 3, 2, 2, 2, 2]); // 18 pax, 8 righe
    const res = await POST(post(importPayload(rows, "arrival")));
    const body = await res.json();
    expect(body.imported_rows).toBe(8);
    expect(body.pending_rows).toBe(0);

    const byBus = paxByBusForStop(seed, STOP_IDS.TERNI);
    // Logica riga-per-riga preesistente (mai toccata da questo fix): riempie
    // gli 8 posti liberi di BUS 1 riga per riga (2+3+2=7, la riga da 3
    // successiva non ci sta più con 1 solo posto residuo) e trabocca su BUS 2.
    expect(byBus[BUS_IDS[0]]).toBe(7);
    expect(byBus[BUS_IDS[1]]).toBe(11);
  });
});
