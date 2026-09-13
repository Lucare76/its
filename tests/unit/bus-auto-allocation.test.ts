import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * FIX MIRATO — AUTO ASSEGNAZIONE BUS: PREFILTRO EXCLUSIVE + RETRY.
 *
 * autoAllocateBusService (path singolo) non deve mai fermarsi al primo bus
 * candidato che fallisce: deve (1) escludere a monte i bus con reservation
 * exclusive=true per un booking_group diverso da quello del service (o per
 * un service senza booking_group_id), e (2) ritentare sul bus successivo se
 * la RPC allocate_bus_service rifiuta comunque il candidato scelto — mai uno
 * skip immediato. Ritorna allocated:false solo se TUTTI i candidati
 * falliscono. La RPC resta sempre l'ultima barriera, mai bypassata.
 *
 * Città "Rimini" / family_code "ADRIATICA" riusano lo stesso identikit già
 * verificato in tests/unit/mario-exclusive-reservation-e2e.test.ts: senza
 * transport_code, deriveServiceBusIdentity risolve la linea tramite il
 * catalogo reale (findNearestBusStop), che per "Rimini" restituisce la
 * famiglia ADRIATICA — nessun mock del catalogo, stesso pattern già in uso.
 */

const TENANT = "tenant-a";
const LINE_ID = "line-adriatica";
const STOP_ID = "canon-rimini-arr";
const SERVICE_ID = "svc-1";
const BUS_1 = "bus-1";
const BUS_2 = "bus-2";
const BUS_3 = "bus-3";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]>, opts: { failRpcForBusIds?: Set<string> } = {}) {
  const rpcCalls: Array<{ bus_unit_id: string }> = [];
  function builder(table: string) {
    const filters: Row = {};
    const b: Record<string, unknown> = {};
    const rowsForFilters = () => (seed[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.maybeSingle = async () => ({ data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => ({ data: rowsForFilters()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve, reject);
    return b;
  }
  const admin = {
    from: (t: string) => builder(t),
    rpc: async (name: string, params: Row) => {
      if (name !== "allocate_bus_service") return { data: null, error: { message: `RPC ${name} non gestita nel fake test` } };
      const busUnitId = String(params.p_bus_unit_id);
      rpcCalls.push({ bus_unit_id: busUnitId });
      if (opts.failRpcForBusIds?.has(busUnitId)) {
        return { data: null, error: { message: `Rifiutato dalla RPC per ${busUnitId}` } };
      }
      return { data: { allocation_id: `alloc-${busUnitId}` }, error: null };
    },
  } as unknown as SupabaseClient;
  return { admin, rpcCalls };
}

function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    services: [
      { id: SERVICE_ID, tenant_id: TENANT, date: "2026-09-13", time: "18:00", outbound_time: null, direction: "arrival", pax: 1, customer_name: "Cliente Test", bus_city_origin: "Rimini", transport_code: null, service_type_code: "bus_line", booking_service_kind: null, booking_group_id: null },
    ],
    tenant_bus_lines: [{ id: LINE_ID, tenant_id: TENANT, code: "ADRIATICA", name: "Adriatica", family_code: "ADRIATICA", active: true }],
    tenant_bus_line_stops: [{ id: STOP_ID, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "arrival", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true }],
    tenant_bus_units: [
      { id: BUS_1, tenant_id: TENANT, bus_line_id: LINE_ID, label: "Bus 1", capacity: 54, status: "open", sort_order: 1, active: true },
      { id: BUS_2, tenant_id: TENANT, bus_line_id: LINE_ID, label: "Bus 2", capacity: 54, status: "open", sort_order: 2, active: true },
      { id: BUS_3, tenant_id: TENANT, bus_line_id: LINE_ID, label: "Bus 3", capacity: 54, status: "open", sort_order: 3, active: true },
    ],
    tenant_bus_allocations: [],
    booking_group_bus_reservations: [],
    ...overrides,
  };
}

async function callAutoAllocate(admin: SupabaseClient) {
  const { autoAllocateBusService } = await import("@/lib/server/bus-auto-allocation");
  return autoAllocateBusService({ admin, tenantId: TENANT, serviceId: SERVICE_ID, userId: "u1" });
}

describe("autoAllocateBusService — prefiltro exclusive + retry (FIX MIRATO)", () => {
  it("bus 1 riservato in esclusiva a un ALTRO gruppo -> escluso a monte, il service (senza gruppo) va sul bus 2 senza mai chiamare la RPC su bus 1", async () => {
    const { admin, rpcCalls } = makeAdmin(baseSeed({
      booking_group_bus_reservations: [
        { tenant_id: TENANT, bus_unit_id: BUS_1, service_date: "2026-09-13", exclusive: true, booking_group_id: "OTHER-GROUP" },
      ],
    }));
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_2);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_2]);
  });

  it("service senza booking_group_id + bus riservato in esclusiva -> escluso dai candidati", async () => {
    const { admin, rpcCalls } = makeAdmin(baseSeed({
      services: [{ id: SERVICE_ID, tenant_id: TENANT, date: "2026-09-13", time: "18:00", outbound_time: null, direction: "arrival", pax: 1, customer_name: "Cliente Test", bus_city_origin: "Rimini", transport_code: null, service_type_code: "bus_line", booking_service_kind: null, booking_group_id: null }],
      booking_group_bus_reservations: [
        { tenant_id: TENANT, bus_unit_id: BUS_1, service_date: "2026-09-13", exclusive: true, booking_group_id: "SOME-GROUP" },
      ],
    }));
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).not.toBe(BUS_1);
    expect(rpcCalls.some((c) => c.bus_unit_id === BUS_1)).toBe(false);
  });

  it("bus riservato in esclusiva allo STESSO booking_group del service -> non escluso, allocazione consentita su bus 1", async () => {
    const { admin, rpcCalls } = makeAdmin(baseSeed({
      services: [{ id: SERVICE_ID, tenant_id: TENANT, date: "2026-09-13", time: "18:00", outbound_time: null, direction: "arrival", pax: 1, customer_name: "Cliente Test", bus_city_origin: "Rimini", transport_code: null, service_type_code: "bus_line", booking_service_kind: null, booking_group_id: "MY-GROUP" }],
      booking_group_bus_reservations: [
        { tenant_id: TENANT, bus_unit_id: BUS_1, service_date: "2026-09-13", exclusive: true, booking_group_id: "MY-GROUP" },
      ],
    }));
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_1);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_1]);
  });

  it("bus 1 passa il prefiltro ma la RPC lo rifiuta comunque -> ritenta sul bus 2 e riesce", async () => {
    const { admin, rpcCalls } = makeAdmin(baseSeed(), { failRpcForBusIds: new Set([BUS_1]) });
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_2);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_1, BUS_2]);
  });

  it("bus 1 e bus 2 rifiutati dalla RPC -> ritenta fino al bus 3 e riesce", async () => {
    const { admin, rpcCalls } = makeAdmin(baseSeed(), { failRpcForBusIds: new Set([BUS_1, BUS_2]) });
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_3);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_1, BUS_2, BUS_3]);
  });

  it("tutti i candidati rifiutati dalla RPC -> allocated:false con reason che elenca i tentativi", async () => {
    const { admin, rpcCalls } = makeAdmin(baseSeed(), { failRpcForBusIds: new Set([BUS_1, BUS_2, BUS_3]) });
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(false);
    if (!res.allocated) {
      expect(res.reason).toMatch(/Bus 1/);
      expect(res.reason).toMatch(/Bus 2/);
      expect(res.reason).toMatch(/Bus 3/);
    }
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_1, BUS_2, BUS_3]);
  });

  it("direzione arrival: il retry non rompe l'assegnazione normale quando nessun bus e' bloccato", async () => {
    const { admin, rpcCalls } = makeAdmin(baseSeed());
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_1);
    expect(rpcCalls).toHaveLength(1);
  });
});

/**
 * FIX MIRATO — BOOKING GROUPS: PRIMO BUS UTILIZZABILE IN ORDINE (bug reale
 * gruppo con ARRIVO 6/09/2026 - PARTENZA 13/09/2026: la PARTENZA partiva dal
 * BUS 3 anche con BUS 1/2 liberi). Root cause: la preferenza "stessa
 * fermata" in pickBusCandidates sceglieva il bus gia' usato per quella
 * fermata anche quando un bus precedente in sort_order aveva ancora posto
 * libero e non era mai stato usato per quella fermata.
 */
describe("autoAllocateBusService — primo bus utilizzabile in ordine per direzione (FIX MIRATO booking groups)", () => {
  it("scenario minimo 1: BUS1=0/54, BUS2=0/54, BUS3=0/54 -> la prima prenotazione va sul BUS1", async () => {
    const stopDeparture = { id: "canon-rimini-dep", tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true };
    const { admin, rpcCalls } = makeAdmin(baseSeed({
      services: [{ ...baseSeed().services[0], direction: "departure" }],
      tenant_bus_line_stops: [stopDeparture],
    }));
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_1);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_1]);
  });

  it("scenario minimo 2: BUS1=54/54 (pieno), BUS2=20/54, BUS3=0/54 -> la nuova prenotazione va sul BUS2, mai sul BUS3", async () => {
    const stopDeparture = { id: "canon-rimini-dep", tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true };
    const { admin, rpcCalls } = makeAdmin(baseSeed({
      services: [{ ...baseSeed().services[0], direction: "departure" }],
      tenant_bus_line_stops: [stopDeparture],
      tenant_bus_allocations: [
        { service_id: "other-1", tenant_id: TENANT, bus_unit_id: BUS_1, bus_line_id: LINE_ID, stop_id: stopDeparture.id, pax_assigned: 54, "services.date": "2026-09-13", "services.direction": "departure" },
        { service_id: "other-2", tenant_id: TENANT, bus_unit_id: BUS_2, bus_line_id: LINE_ID, stop_id: stopDeparture.id, pax_assigned: 20, "services.date": "2026-09-13", "services.direction": "departure" },
      ],
    }));
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_2);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_2]);
  });

  it("BUG REALE: fermata gia' servita dal BUS3 (con posto) ma BUS1/BUS2 mai usati per quella fermata e liberi -> sceglie BUS1, non eredita il BUS3", async () => {
    const stopDeparture = { id: "canon-rimini-dep", tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true };
    const { admin, rpcCalls } = makeAdmin(baseSeed({
      services: [{ ...baseSeed().services[0], direction: "departure" }],
      tenant_bus_line_stops: [stopDeparture],
      tenant_bus_allocations: [
        // Un'altra prenotazione per la STESSA fermata era finita sul BUS3
        // (es. perche' in un momento precedente BUS1/2 erano pieni). BUS1 e
        // BUS2 non hanno mai servito questa fermata ma hanno posto libero.
        { service_id: "other-svc", tenant_id: TENANT, bus_unit_id: BUS_3, bus_line_id: LINE_ID, stop_id: stopDeparture.id, pax_assigned: 5, "services.date": "2026-09-13", "services.direction": "departure" },
      ],
    }));
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_1);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_1]);
  });

  it("BUG REALE variante: BUS1 pieno, fermata gia' servita dal BUS3 (con posto), BUS2 mai usato per quella fermata ma libero -> sceglie BUS2, non BUS3", async () => {
    const stopDeparture = { id: "canon-rimini-dep", tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true };
    const { admin, rpcCalls } = makeAdmin(baseSeed({
      services: [{ ...baseSeed().services[0], direction: "departure" }],
      tenant_bus_line_stops: [stopDeparture],
      tenant_bus_allocations: [
        { service_id: "other-full", tenant_id: TENANT, bus_unit_id: BUS_1, bus_line_id: LINE_ID, stop_id: "altra-fermata", pax_assigned: 54, "services.date": "2026-09-13", "services.direction": "departure" },
        { service_id: "other-svc", tenant_id: TENANT, bus_unit_id: BUS_3, bus_line_id: LINE_ID, stop_id: stopDeparture.id, pax_assigned: 5, "services.date": "2026-09-13", "services.direction": "departure" },
      ],
    }));
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_2);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_2]);
  });

  it("bus chiuso: BUS1 status=closed, BUS2/BUS3 liberi -> salta BUS1 e sceglie BUS2 (mai un bus chiuso)", async () => {
    const stopDeparture = { id: "canon-rimini-dep", tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true };
    const { admin, rpcCalls } = makeAdmin(baseSeed({
      services: [{ ...baseSeed().services[0], direction: "departure" }],
      tenant_bus_line_stops: [stopDeparture],
      tenant_bus_units: [
        { id: BUS_1, tenant_id: TENANT, bus_line_id: LINE_ID, label: "Bus 1", capacity: 54, status: "closed", sort_order: 1, active: true },
        { id: BUS_2, tenant_id: TENANT, bus_line_id: LINE_ID, label: "Bus 2", capacity: 54, status: "open", sort_order: 2, active: true },
        { id: BUS_3, tenant_id: TENANT, bus_line_id: LINE_ID, label: "Bus 3", capacity: 54, status: "open", sort_order: 3, active: true },
      ],
    }));
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_2);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_2]);
  });

  it("scenario 3: ARRIVO allocato sul BUS3 (altra data) non deve mai influenzare la scelta della PARTENZA -> PARTENZA sceglie BUS1", async () => {
    const stopArrival = { id: "canon-rimini-arr-2", tenant_id: TENANT, bus_line_id: LINE_ID, direction: "arrival", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true };
    const stopDeparture = { id: "canon-rimini-dep", tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "RIMINI", city: "Rimini", stop_order: 0, active: true };
    const { admin, rpcCalls } = makeAdmin(baseSeed({
      services: [{ ...baseSeed().services[0], id: SERVICE_ID, date: "2026-09-13", direction: "departure" }],
      tenant_bus_line_stops: [stopArrival, stopDeparture],
      tenant_bus_allocations: [
        // Allocazione dell'ARRIVO (6/09) sul BUS3, stessa fermata/citta' ma
        // data e direzione diverse: non deve mai comparire nel calcolo della
        // PARTENZA (13/09).
        { service_id: "arrival-svc", tenant_id: TENANT, bus_unit_id: BUS_3, bus_line_id: LINE_ID, stop_id: stopArrival.id, pax_assigned: 30, "services.date": "2026-09-06", "services.direction": "arrival" },
      ],
    }));
    const res = await callAutoAllocate(admin);
    expect(res.allocated).toBe(true);
    if (res.allocated) expect(res.busUnitId).toBe(BUS_1);
    expect(rpcCalls.map((c) => c.bus_unit_id)).toEqual([BUS_1]);
  });
});
