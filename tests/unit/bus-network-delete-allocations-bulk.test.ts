import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * "Disalloca selezionati" — barra multi-select su Booking Groups / Linea Bus.
 * Copre `action: "delete_allocations_bulk"` in app/api/ops/bus-network/route.ts,
 * che riusa ESATTAMENTE il percorso già collaudato di "delete_allocation"
 * (semplice delete tenant-scoped su tenant_bus_allocations + audit via
 * recordBusAssignmentFeedback) applicato riga per riga, come
 * "move_allocations_bulk" fa per "move_allocation". Nessuna nuova RPC SQL.
 *
 * Verifica in particolare: la prenotazione/service, il booking group e le
 * fermate non vengono MAI toccati; solo l'allocazione bus sparisce; ARRIVO e
 * PARTENZA (e date diverse) restano completamente indipendenti; il servizio
 * torna eleggibile per l'auto-allocazione appena corretta
 * (autoAllocateBusService, lib/server/bus-auto-allocation.ts).
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { POST } from "@/app/api/ops/bus-network/route";
import { autoAllocateBusService } from "@/lib/server/bus-auto-allocation";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "u-op-1";
const LINE_ID = "11111111-1111-4111-8111-111111111111";
const UNIT_1 = "22222222-2222-4222-8222-222222222222";
const UNIT_2 = "22222222-2222-4222-8222-222222222223";
const UNIT_3 = "22222222-2222-4222-8222-222222222224";
const STOP_DEP = "33333333-3333-4333-8333-333333333333";
const STOP_ARR = "33333333-3333-4333-8333-333333333334";
const GROUP_ID = "44444444-4444-4444-8444-444444444444";
const SVC_DEP_1 = "55555555-5555-4555-8555-555555555555";
const SVC_DEP_2 = "55555555-5555-4555-8555-555555555556";
const SVC_ARR = "55555555-5555-4555-8555-555555555557";
const SVC_OTHER_DATE = "55555555-5555-4555-8555-555555555558";
const ALLOC_DEP_1 = "66666666-6666-4666-8666-666666666666";
const ALLOC_DEP_2 = "66666666-6666-4666-8666-666666666667";
const ALLOC_ARR = "66666666-6666-4666-8666-666666666668";
const ALLOC_OTHER_DATE = "66666666-6666-4666-8666-666666666669";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]>) {
  const writes = {
    inserts: [] as Array<{ table: string; payload: Row }>,
    rpcCalls: [] as Array<{ name: string; params: Row }>,
  };

  function builder(table: string) {
    const filters: Row = {};
    const inFilters: Array<{ col: string; vals: unknown[] }> = [];
    let pending: { kind: "insert"; payload: Row } | { kind: "delete" } | { kind: "update"; payload: Row } | null = null;
    const rowsForFilters = () =>
      (seed[table] ?? []).filter(
        (r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v) &&
          inFilters.every(({ col, vals }) => vals.includes(r[col]))
      );
    const finish = () => {
      if (pending?.kind === "insert") {
        writes.inserts.push({ table, payload: pending.payload });
        (seed[table] ??= []).push(pending.payload);
        return { data: pending.payload, error: null };
      }
      if (pending?.kind === "delete") {
        const toDelete = new Set(rowsForFilters());
        seed[table] = (seed[table] ?? []).filter((r) => !toDelete.has(r));
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.or = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.in = (col: string, vals: unknown[]) => { inFilters.push({ col, vals }); return b; };
    b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
    b.delete = () => { pending = { kind: "delete" }; return b; };
    b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
    b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(pending ? finish() : { data: rowsForFilters(), error: null }).then(resolve, reject);
    return b;
  }

  const admin = {
    from: (t: string) => builder(t),
    rpc: async (name: string, params: Row) => {
      writes.rpcCalls.push({ name, params });
      if (name === "allocate_bus_service" || name === "move_bus_allocation") {
        return { data: { allocation_id: `alloc-${writes.rpcCalls.length}` }, error: null };
      }
      return { data: null, error: { message: `RPC ${name} non gestita nel fake test` } };
    },
  };
  return { admin, writes, seed };
}

function authCtx(admin: unknown, role = "operator") {
  return { admin, user: { id: USER_ID, email: "op@test.it" }, membership: { tenant_id: TENANT, role, suspended: false } };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/ops/bus-network", { method: "POST", body: JSON.stringify(body) });
}

function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    tenant_bus_lines: [
      { id: LINE_ID, tenant_id: TENANT, code: "ADRIATICA", name: "Bus esclusivi gruppi", family_code: "ADRIATICA", family_name: "Gruppi esclusivi", active: true },
    ],
    tenant_bus_units: [
      { id: UNIT_1, tenant_id: TENANT, bus_line_id: LINE_ID, label: "GRUPPO GIACOMONI", capacity: 54, low_seat_threshold: 5, status: "open", active: true, sort_order: 1 },
      { id: UNIT_2, tenant_id: TENANT, bus_line_id: LINE_ID, label: "GRUPPO EX 2", capacity: 54, low_seat_threshold: 5, status: "open", active: true, sort_order: 2 },
      { id: UNIT_3, tenant_id: TENANT, bus_line_id: LINE_ID, label: "GRUPPO EX 3", capacity: 54, low_seat_threshold: 5, status: "open", active: true, sort_order: 3 },
    ],
    tenant_bus_line_stops: [
      { id: STOP_DEP, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "Rimini", city: "Rimini", active: true },
      { id: STOP_ARR, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "arrival", stop_name: "Rimini", city: "Rimini", active: true },
    ],
    tenant_bus_allocations: [
      { id: ALLOC_DEP_1, tenant_id: TENANT, service_id: SVC_DEP_1, bus_line_id: LINE_ID, bus_unit_id: UNIT_1, stop_id: STOP_DEP, stop_name: "Rimini", direction: "departure", pax_assigned: 20 },
      { id: ALLOC_DEP_2, tenant_id: TENANT, service_id: SVC_DEP_2, bus_line_id: LINE_ID, bus_unit_id: UNIT_1, stop_id: STOP_DEP, stop_name: "Rimini", direction: "departure", pax_assigned: 18 },
      // Stessa linea, direzione ARRIVO (data diversa) — non deve mai essere toccata.
      { id: ALLOC_ARR, tenant_id: TENANT, service_id: SVC_ARR, bus_line_id: LINE_ID, bus_unit_id: UNIT_2, stop_id: STOP_ARR, stop_name: "Rimini", direction: "arrival", pax_assigned: 30 },
      // Stessa direzione PARTENZA ma di un'altra data — non deve mai essere toccata.
      { id: ALLOC_OTHER_DATE, tenant_id: TENANT, service_id: SVC_OTHER_DATE, bus_line_id: LINE_ID, bus_unit_id: UNIT_3, stop_id: STOP_DEP, stop_name: "Rimini", direction: "departure", pax_assigned: 15 },
    ],
    ops_bus_allocation_details: [],
    tenant_bus_allocation_moves: [],
    bus_assignment_feedback: [],
    hotels: [],
    bus_import_pending: [],
    bus_unit_driver_dates: [],
    bus_ischia_dist_buses: [],
    bus_ischia_dist_allocations: [],
    vehicles: [],
    driver_profiles: [],
    bus_line_ferry_config: [],
    booking_groups: [
      { id: GROUP_ID, tenant_id: TENANT, name: "GRUPPO GIACOMONI", kind: "bus_exclusive", status: "operational", service_date: "2026-09-06", return_date: "2026-09-13", expected_pax: 38 },
    ],
    booking_group_stops: [
      { id: "bgs-dep", tenant_id: TENANT, booking_group_id: GROUP_ID, direction: "departure", city: "Rimini", stop_id: STOP_DEP, expected_pax: 38 },
    ],
    services: [
      { id: SVC_DEP_1, tenant_id: TENANT, booking_group_id: GROUP_ID, customer_name: "GIACOMONI A", direction: "departure", booking_service_kind: "bus_city_hotel", date: "2026-09-13", time: "09:00", pax: 20, hotel_id: null, bus_city_origin: "Rimini", transport_code: null, status: "new", is_draft: false },
      { id: SVC_DEP_2, tenant_id: TENANT, booking_group_id: GROUP_ID, customer_name: "GIACOMONI B", direction: "departure", booking_service_kind: "bus_city_hotel", date: "2026-09-13", time: "09:00", pax: 18, hotel_id: null, bus_city_origin: "Rimini", transport_code: null, status: "new", is_draft: false },
      { id: SVC_ARR, tenant_id: TENANT, booking_group_id: GROUP_ID, customer_name: "GIACOMONI C (arrivo)", direction: "arrival", booking_service_kind: "bus_city_hotel", date: "2026-09-06", time: "05:00", pax: 30, hotel_id: null, bus_city_origin: "Rimini", transport_code: null, status: "new", is_draft: false },
      { id: SVC_OTHER_DATE, tenant_id: TENANT, booking_group_id: "other-group", customer_name: "ALTRO GRUPPO", direction: "departure", booking_service_kind: "bus_city_hotel", date: "2026-09-20", time: "09:00", pax: 15, hotel_id: null, bus_city_origin: "Rimini", transport_code: null, status: "new", is_draft: false },
    ],
    ...overrides,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("delete_allocations_bulk — disalloca selezionati (riusa il percorso di delete_allocation)", () => {
  it("1. disallocazione di un singolo servizio: rimuove solo quell'allocazione", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.deleted_count).toBe(1);
    expect((seed.tenant_bus_allocations ?? []).some((a) => a.id === ALLOC_DEP_1)).toBe(false);
    expect((seed.tenant_bus_allocations ?? []).some((a) => a.id === ALLOC_DEP_2)).toBe(true);
  });

  it("2. disallocazione multipla: rimuove tutte le allocazioni selezionate in un colpo solo", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1, ALLOC_DEP_2] }));
    const json = await res.json();

    expect(json.ok).toBe(true);
    expect(json.deleted_count).toBe(2);
    expect((seed.tenant_bus_allocations ?? []).some((a) => a.id === ALLOC_DEP_1 || a.id === ALLOC_DEP_2)).toBe(false);
  });

  it("3. booking e service restano esistenti dopo la disallocazione", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1, ALLOC_DEP_2] }));

    const svc1 = (seed.services ?? []).find((s) => s.id === SVC_DEP_1);
    const svc2 = (seed.services ?? []).find((s) => s.id === SVC_DEP_2);
    expect(svc1).toBeTruthy();
    expect(svc2).toBeTruthy();
    // Fermata, data, direzione, pax e cliente invariati.
    expect(svc1?.date).toBe("2026-09-13");
    expect(svc1?.direction).toBe("departure");
    expect(svc1?.pax).toBe(20);
    expect(svc1?.customer_name).toBe("GIACOMONI A");
    expect(svc1?.status).toBe("new"); // mai cancellato/annullato
  });

  it("4. l'allocazione viene effettivamente rimossa dal DB", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1] }));

    expect((seed.tenant_bus_allocations ?? []).find((a) => a.id === ALLOC_DEP_1)).toBeUndefined();
  });

  it("5. il booking group e la sua membership restano invariati", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1, ALLOC_DEP_2] }));

    const group = (seed.booking_groups ?? []).find((g) => g.id === GROUP_ID);
    const stops = (seed.booking_group_stops ?? []).filter((s) => s.booking_group_id === GROUP_ID);
    const svc1 = (seed.services ?? []).find((s) => s.id === SVC_DEP_1);
    expect(group).toBeTruthy();
    expect(stops).toHaveLength(1);
    expect(svc1?.booking_group_id).toBe(GROUP_ID);
  });

  it("6. l'altra direzione (ARRIVO) non viene toccata", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1, ALLOC_DEP_2] }));

    expect((seed.tenant_bus_allocations ?? []).some((a) => a.id === ALLOC_ARR)).toBe(true);
  });

  it("7. un'altra data non viene toccata", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1, ALLOC_DEP_2] }));

    expect((seed.tenant_bus_allocations ?? []).some((a) => a.id === ALLOC_OTHER_DATE)).toBe(true);
  });

  it("8. la capienza del bus viene aggiornata correttamente (il bus torna libero per quei pax)", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1, ALLOC_DEP_2] }));
    const json = await res.json();

    expect(json.ok).toBe(true);
    // Nessuna allocazione residua su UNIT_1 per la direzione departure/data 13-09:
    // la capienza libera ricalcolata da loadBusNetwork deve risultare piena (54/54 liberi).
    const remainingOnUnit1 = (seed.tenant_bus_allocations ?? []).filter((a) => a.bus_unit_id === UNIT_1);
    expect(remainingOnUnit1).toHaveLength(0);
    const unitLoad = (json.unit_loads ?? []).find((u: { id: string }) => u.id === UNIT_1);
    if (unitLoad) {
      expect(unitLoad.assigned_pax ?? 0).toBe(0);
      expect(unitLoad.remaining_seats).toBe(54);
    }
  });

  it("9. il servizio disallocato torna eleggibile per l'auto-allocazione (Auto-assegna)", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1] }));

    // Stesso identico gate usato da autoAllocateBusService: nessuna riga in
    // tenant_bus_allocations per quel service_id -> "non allocato".
    const stillAllocated = (seed.tenant_bus_allocations ?? []).some((a) => a.service_id === SVC_DEP_1);
    expect(stillAllocated).toBe(false);

    const outcome = await autoAllocateBusService({ admin: admin as never, tenantId: TENANT, serviceId: SVC_DEP_1, userId: USER_ID });
    expect(outcome.allocated).not.toBe(false);
  });

  it("10. scrive un audit log per riga rimossa: action_type=delete_allocation, source=manual (nessun nuovo tipo)", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1, ALLOC_DEP_2] }));
    expect((await res.json()).ok).toBe(true);

    const feedbackWrites = writes.inserts.filter((w) => w.table === "bus_assignment_feedback");
    expect(feedbackWrites).toHaveLength(2);
    for (const w of feedbackWrites) {
      expect(w.payload.action_type).toBe("delete_allocation");
      expect(w.payload.source).toBe("manual");
      expect(w.payload.tenant_id).toBe(TENANT);
      expect(w.payload.created_by_user_id).toBe(USER_ID);
      expect(w.payload.new_bus_unit_id).toBeNull();
    }
    expect(feedbackWrites.map((w) => w.payload.service_id).sort()).toEqual([SVC_DEP_1, SVC_DEP_2].sort());
  });

  it("nessuna allocazione trovata per gli id indicati -> 404, nessun delete/log scritto", async () => {
    const { admin, writes } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "delete_allocations_bulk", allocation_ids: ["99999999-9999-4999-8999-999999999999"] }));
    expect(res.status).toBe(404);
    expect(writes.inserts.filter((w) => w.table === "bus_assignment_feedback")).toHaveLength(0);
  });

  it("stesso controllo permessi delle altre azioni di allocazione: ruolo non autorizzato -> risposta di authorizePricingRequest", async () => {
    const { NextResponse } = await import("next/server");
    const denied = NextResponse.json({ ok: false, error: "Non autorizzato." }, { status: 403 });
    mocks.authorizePricingRequest.mockResolvedValue(denied);

    const res = await POST(post({ action: "delete_allocations_bulk", allocation_ids: [ALLOC_DEP_1] }));
    expect(res.status).toBe(403);
  });
});
