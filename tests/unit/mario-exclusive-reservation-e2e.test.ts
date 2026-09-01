/**
 * FASE A.5.2 §7–§11 — flusso di prenotazione bus ESCLUSIVO guidato da Mario.
 *
 * Test A (orchestrator, runTool mockato): quando `inspectOperationalBusGroupState`
 * porterebbe a `nextStep === "reserve_bus"`, la catena elenca i bus
 * compatibili, NON sceglie da sola se sono più di uno (§7.3/§7.4), risolve la
 * scelta esplicita dell'utente ("usa Bus 54"), copre andata+ritorno con lo
 * stesso bus quando disponibile su entrambe le date (§8), e ogni singola
 * prenotazione resta dietro "Confermi?" (mai un bypass, §7.6).
 *
 * Test B (service layer reale, nessun mock): `operationalizeBookingGroup` +
 * `allocateReservedBookingGroupBusService` + il vero `loadBusNetwork`
 * (read-model condiviso di Linea Bus) sullo STESSO fake DB, per verificare
 * che l'allocazione sul bus riservato sia realmente visibile in Linea Bus
 * per entrambe le date — mai un bus condiviso (§9).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import type { McpContext } from "@/lib/mcp/context";
import { FakeUpstashRedis } from "./mario-fake-redis";

const mockGetTool = vi.fn();
const mockRunTool = vi.fn();
const mockRoute = vi.fn();

vi.mock("@/lib/mcp/registry", () => ({ getTool: (...a: unknown[]) => mockGetTool(...a), listTools: () => [] }));
vi.mock("@/lib/mcp/server", () => ({ runTool: (...a: unknown[]) => mockRunTool(...a) }));
vi.mock("@/lib/server/mario-assistant/llm-router", () => ({ routeMarioWithLlm: (...a: unknown[]) => mockRoute(...a) }));

const TENANT = "tenant-a";
const NOW = new Date("2026-08-31T09:00:00Z");
const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const toolCall = (tool_name: string, args: Record<string, unknown>) => ({
  decision: { action: "tool_call" as const, tool_name, arguments: args, confidence: 0.95 },
  usage: { inputTokens: 1000, outputTokens: 60 },
  fallbackUsed: false,
  latencyMs: 10,
});

type Row = Record<string, unknown>;
function makeBusAdmin(seed: Record<string, Row[]>): McpContext["admin"] {
  function builder(table: string) {
    const filters: Row = {};
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: (seed[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)), error: null }).then(resolve);
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as McpContext["admin"];
}

let fake: FakeUpstashRedis;

beforeEach(async () => {
  vi.stubEnv("MARIO_LLM_ENABLED", "true");
  vi.spyOn(console, "info").mockImplementation(() => {});
  fake = new FakeUpstashRedis();
  const { __setSharedRedisForTests } = await import("@/lib/server/redis");
  __setSharedRedisForTests(fake as unknown as Redis);
  mockGetTool.mockReset().mockImplementation((name: string) => ({ name }));
  mockRunTool.mockReset();
  mockRoute.mockReset();
});
afterEach(async () => {
  const { __setSharedRedisForTests } = await import("@/lib/server/redis");
  __setSharedRedisForTests(undefined);
  const { __resetMarioSessionsForTests } = await import("@/lib/server/mario-assistant/session-context");
  __resetMarioSessionsForTests();
  vi.unstubAllEnvs();
});

async function run(ctx: McpContext, message: string) {
  const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
  return runMarioAssistant(ctx, message, NOW);
}

describe("FASE A.5.2 §7/§8 — Mario guida la prenotazione bus esclusivo (più candidati -> chiede, poi conferma per data)", () => {
  it("2 bus compatibili su entrambe le date -> Mario chiede, 'usa Bus 54' -> reservation andata+ritorno confermate separatamente -> operationalize", async () => {
    const admin = makeBusAdmin({
      tenant_bus_units: [
        { id: "BUS-54", tenant_id: TENANT, label: "Bus 54", capacity: 54, status: "open", manual_close: false, active: true, tag: null },
        { id: "BUS-60", tenant_id: TENANT, label: "Bus 60", capacity: 60, status: "open", manual_close: false, active: true, tag: null },
      ],
      booking_group_bus_reservations: [],
    });
    const ctx: McpContext = { requestId: "req-1", userId: "user-1", userEmail: "op@example.com", tenantId: TENANT, role: "operator", admin };

    // Seme: catena già al punto in cui la fermata+servizio di RITORNO sono
    // stati appena confermati (stessa cosa provata da mario-operational-chain-e2e),
    // pendingConfirmation ancora da eseguire su "sì".
    const { setMarioDraftOperation, updateMarioSession } = await import("@/lib/server/mario-assistant/session-context");
    await setMarioDraftOperation(TENANT, "user-1", {
      type: "operational_bus_group_chain",
      collected: {
        name: "Test Exclusive", expectedPax: 50, serviceDate: "2026-09-13", returnDate: "2026-09-20", origin: "Rimini", kind: "bus_exclusive",
        bookingGroupId: "BG1", outboundStopIds: ["STOP-ARR"], returnStopIds: ["STOP-DEP"],
        _chainStage: "passengers:departure:0",
        _chainRemaining: ["reserve_bus:0", "reserve_bus:1", "operationalize"],
      },
      missing: [],
    });
    await updateMarioSession(TENANT, "user-1", {
      pendingConfirmation: { toolName: "its.add_booking_group_passengers", confirmationToken: "TOK-PAX-RET", op: "its.preview_add_booking_group_passengers", createdAt: Date.now() },
    });

    // 1) conferma servizio ritorno -> la catena elenca i bus per l'andata,
    // trova un'intersezione di 2 candidati validi anche per il ritorno (§8) e
    // chiede quale usare (§7.3/§7.4) — NESSUNA preview/token ancora.
    mockRunTool.mockResolvedValueOnce(ok({
      bookingGroupId: "BG1", bookingGroupStopId: "STOP-DEP",
      created: [{ id: "SVC-DEP", customer_name: "Gruppo Test Exclusive", pax: 50 }], failed: [], created_count: 1, failed_count: 0, outcome: "created",
    }));
    const r1 = await run(ctx, "sì");
    expect(r1.intent).toBe("mario_operational_chain_pending_selection");
    expect(r1.answer).toMatch(/Bus 54/);
    expect(r1.answer).toMatch(/Bus 60/);
    expect(r1.answer).toMatch(/quale/i);
    expect(mockRunTool).toHaveBeenCalledTimes(1); // solo il write della passengers, nessuna preview ancora

    // 2) l'utente sceglie esplicitamente -> preview della reservation andata
    // (bus già individuato, copre anche il ritorno per costruzione, §8)
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "Test Exclusive", bus_unit_id: "BUS-54", bus_unit_label: "Bus 54",
      service_date: "2026-09-13", reserved_pax: 50, exclusive: true,
      confirmationToken: "TOK-RESBUS-OUT", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r2 = await run(ctx, "usa Bus 54");
    expect(r2.intent).toBe("mario_operational_chain_pending");
    expect(r2.answer).toMatch(/Bus 54/);
    expect(r2.answer).toMatch(/Confermi/i);

    // 3) conferma reservation andata -> avanza DIRETTAMENTE alla preview del
    // ritorno (stesso bus, nessuna nuova domanda "quale bus")
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", busUnitId: "BUS-54", serviceDate: "2026-09-13" }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "Test Exclusive", bus_unit_id: "BUS-54", bus_unit_label: "Bus 54",
      service_date: "2026-09-20", reserved_pax: 50, exclusive: true,
      confirmationToken: "TOK-RESBUS-RET", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r3 = await run(ctx, "sì");
    expect(r3.intent).toBe("mario_operational_chain_pending");
    expect(r3.answer).toMatch(/Bus 54/);

    // 4) conferma reservation ritorno -> avanza all'operativizzazione
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", busUnitId: "BUS-54", serviceDate: "2026-09-20" }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "Test Exclusive", expected_pax: 50, planned_pax: 100, service_pax: 100,
      services_total: 2, services_ready: 2, services_blocked: 0, services_already_operational: 0, warnings: [],
      bus_reservation: { bus_unit_label: "Bus 54" }, ferry: { outbound: {}, return: {} }, services: [],
      confirmationToken: "TOK-OPZ", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r4 = await run(ctx, "sì");
    expect(r4.intent).toBe("mario_operational_chain_pending");
    expect(r4.answer).toMatch(/Confermi/i);

    // 5) conferma operativizzazione -> riepilogo finale, draft chiuso
    mockRunTool.mockResolvedValueOnce(ok({
      bookingGroupId: "BG1", outcome: "operationalized",
      operationalized: [{ service_id: "SVC-ARR", warnings: [] }, { service_id: "SVC-DEP", warnings: [] }],
      blocked: [], already_operational: [], group_status: "operational",
    }));
    const r5 = await run(ctx, "sì");
    expect(r5.intent).toBe("mario_operational_chain_completed");

    const { readMarioDraftOperation } = await import("@/lib/server/mario-assistant/session-context");
    expect(await readMarioDraftOperation(TENANT, "user-1")).toBeNull();
  });
});

describe("FASE A.5.2 §9 — allocazione sul bus riservato visibile in Linea Bus per ENTRAMBE le date (service layer reale)", () => {
  it("operationalizeBookingGroup alloca su Bus 54 andata+ritorno -> loadBusNetwork vede 50 pax su ciascuna direzione, mai un bus condiviso", async () => {
    vi.doMock("@/lib/server/bus-auto-allocation", () => ({ autoAllocateBusService: vi.fn() }));
    const { autoAllocateBusService } = await import("@/lib/server/bus-auto-allocation");
    const { operationalizeBookingGroup } = await import("@/lib/server/booking-groups-service");
    const { loadBusNetwork } = await import("@/lib/server/bus-network-loader");

    const GROUP_ID = "BG1";
    const CANONICAL_ARR = "canon-rimini-arr";
    const CANONICAL_DEP = "canon-rimini-dep";
    const BUS_UNIT_ID = "BUS-54";

    const tables: Record<string, Row[]> = {
      booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "Test Exclusive", kind: "bus_exclusive", service_date: "2026-09-13", expected_pax: 50, status: "passengers_defined", outbound_ferry_company: "x", outbound_ferry_time: "x", return_ferry_company: "x", return_ferry_time: "x" }],
      booking_group_stops: [
        { id: "STOP-ARR", tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", pickup_point: null, stop_id: CANONICAL_ARR, expected_pax: 50 },
        { id: "STOP-DEP", tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Rimini", pickup_point: null, stop_id: CANONICAL_DEP, expected_pax: 50 },
      ],
      services: [
        { id: "SVC-ARR", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "STOP-ARR", is_draft: true, status: "needs_review", pax: 50, customer_name: "Gruppo Test Exclusive", date: "2026-09-13", time: "05:10", direction: "arrival", bus_city_origin: "Rimini", meeting_point: null, hotel_id: null, booking_service_kind: "bus_city_hotel" },
        { id: "SVC-DEP", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "STOP-DEP", is_draft: true, status: "needs_review", pax: 50, customer_name: "Gruppo Test Exclusive", date: "2026-09-20", time: "18:00", direction: "departure", bus_city_origin: "Rimini", meeting_point: null, hotel_id: null, booking_service_kind: "bus_city_hotel" },
      ],
      booking_group_bus_reservations: [
        { id: "r1", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_UNIT_ID, service_date: "2026-09-13", reserved_pax: 50, exclusive: true },
        { id: "r2", tenant_id: TENANT, booking_group_id: GROUP_ID, bus_unit_id: BUS_UNIT_ID, service_date: "2026-09-20", reserved_pax: 50, exclusive: true },
      ],
      tenant_bus_units: [{ id: BUS_UNIT_ID, tenant_id: TENANT, bus_line_id: "line-adriatica", label: "Bus Esclusivo", capacity: 54, low_seat_threshold: 5, status: "open", manual_close: false, sort_order: 0, active: true }],
      tenant_bus_lines: [{ id: "line-adriatica", tenant_id: TENANT, family_code: "ADRIATICA", name: "Adriatica" }],
      tenant_bus_line_stops: [
        { id: CANONICAL_ARR, tenant_id: TENANT, bus_line_id: "line-adriatica", city: "Rimini", stop_name: "RIMINI", direction: "arrival", active: true, pickup_time: "05:10", stop_order: 0 },
        { id: CANONICAL_DEP, tenant_id: TENANT, bus_line_id: "line-adriatica", city: "Rimini", stop_name: "RIMINI", direction: "departure", active: true, pickup_time: "18:00", stop_order: 0 },
      ],
      tenant_bus_allocations: [],
      ops_bus_allocation_details: [], tenant_bus_allocation_moves: [], hotels: [], bus_import_pending: [],
      bus_unit_driver_dates: [], bus_ischia_dist_buses: [], bus_ischia_dist_allocations: [], vehicles: [], driver_profiles: [], bus_line_ferry_config: [],
    };

    let allocSeq = 0;
    function builder(table: string) {
      const filters: Row = {};
      const inFilters: Array<{ col: string; vals: unknown[] }> = [];
      let pending: { kind: "insert" | "update"; payload?: Row } | null = null;
      const rowsForFilters = () =>
        (tables[table] ?? []).filter(
          (r) => Object.entries(filters).every(([k, v]) => r[k] === v) && inFilters.every(({ col, vals }) => vals.includes(r[col])),
        );
      const finish = () => {
        if (pending?.kind === "insert") {
          const row = { id: `${table}-${Date.now()}-${Math.random()}`, ...(pending.payload ?? {}) };
          tables[table] = [...(tables[table] ?? []), row];
          return { data: row, error: null };
        }
        if (pending?.kind === "update") {
          const match = rowsForFilters()[0];
          if (match) Object.assign(match, pending.payload ?? {});
          return { data: match ?? null, error: null };
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
      b.maybeSingle = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
      b.single = async () => (pending ? finish() : { data: rowsForFilters()[0] ?? null, error: null });
      b.insert = (payload: Row) => { pending = { kind: "insert", payload }; return b; };
      b.update = (payload: Row) => { pending = { kind: "update", payload }; return b; };
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (pending) return Promise.resolve(finish()).then(resolve, reject);
        return Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve, reject);
      };
      return b;
    }
    const admin = {
      from: (t: string) => builder(t),
      rpc: async (fn: string, params: Row) => {
        if (fn === "allocate_bus_service") {
          const row: Row = {
            id: `alloc-${++allocSeq}`,
            tenant_id: params.p_tenant_id, service_id: params.p_service_id, bus_line_id: params.p_bus_line_id,
            bus_unit_id: params.p_bus_unit_id, stop_id: params.p_stop_id, stop_name: params.p_stop_name,
            direction: params.p_direction, pax_assigned: params.p_pax_assigned, notes: params.p_notes ?? null,
          };
          tables.tenant_bus_allocations = [...tables.tenant_bus_allocations, row];
          return { data: { id: row.id }, error: null };
        }
        return { data: null, error: null };
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const actor = { tenantId: TENANT, userId: "u1", role: "operator" as const };
    const res = await operationalizeBookingGroup(admin, actor, { bookingGroupId: GROUP_ID });

    expect(autoAllocateBusService).not.toHaveBeenCalled();
    expect(tables.tenant_bus_allocations).toHaveLength(2);
    expect(tables.tenant_bus_allocations.every((a) => a.bus_unit_id === BUS_UNIT_ID)).toBe(true);
    const opWarnings = res.data && "operationalized" in res.data ? res.data.operationalized.flatMap((o) => o.warnings) : ["MISSING"];
    expect(opWarnings).not.toContain("allocation_pending");

    const auth = { admin, membership: { tenant_id: TENANT, role: "operator", suspended: false }, user: { id: "u1", email: "op@example.com" } } as unknown as import("@/lib/server/pricing-auth").PricingAuthContext;
    const network = await loadBusNetwork(auth);

    const arrivalStop = network.stop_loads.find((s: Row) => s.direction === "arrival" && s.stop_name === "RIMINI");
    const departureStop = network.stop_loads.find((s: Row) => s.direction === "departure" && s.stop_name === "RIMINI");
    expect(arrivalStop?.pax_assigned).toBe(50); // 13-09
    expect(departureStop?.pax_assigned).toBe(50); // 20-09

    const busLoad = network.unit_loads.find((u: Row) => u.id === BUS_UNIT_ID);
    expect(busLoad?.pax_assigned).toBe(100);
  });
});

describe("FASE A.5.2 §10 — resume dopo Redis scaduto con nextStep reserve_bus: riprende dalla prenotazione, MAI dalla creazione", () => {
  it("'Completa La Marra' (sessione nuova, gruppo bus_exclusive già completo tranne la reservation) -> propone direttamente il bus, its.create_booking_group MAI chiamato", async () => {
    function makeAdmin(seed: Record<string, Row[]>): McpContext["admin"] {
      function builder(table: string) {
        const filters: Row = {};
        const inFilters: Array<{ col: string; vals: unknown[] }> = [];
        const rowsForFilters = () =>
          (seed[table] ?? []).filter(
            (r) => Object.entries(filters).every(([k, v]) => r[k] === v) && inFilters.every(({ col, vals }) => vals.includes(r[col])),
          );
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.order = () => b;
        b.limit = () => b;
        b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
        b.in = (col: string, vals: unknown[]) => { inFilters.push({ col, vals }); return b; };
        b.maybeSingle = async () => ({ data: rowsForFilters()[0] ?? null, error: null });
        b.single = async () => ({ data: rowsForFilters()[0] ?? null, error: null });
        b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve);
        return b;
      }
      return { from: (t: string) => builder(t) } as unknown as McpContext["admin"];
    }

    const admin = makeAdmin({
      booking_groups: [{ id: "BG1", tenant_id: TENANT, name: "La Marra", status: "draft", kind: "bus_exclusive", service_date: "2026-09-13", expected_pax: 50 }],
      booking_group_stops: [
        { id: "s-out", tenant_id: TENANT, booking_group_id: "BG1", direction: "arrival", expected_pax: 50 },
        { id: "s-ret", tenant_id: TENANT, booking_group_id: "BG1", direction: "departure", expected_pax: 50 },
      ],
      services: [
        { id: "SVC-OUT", tenant_id: TENANT, booking_group_id: "BG1", booking_group_stop_id: "s-out", pax: 50, direction: "arrival" },
        { id: "SVC-RET", tenant_id: TENANT, booking_group_id: "BG1", booking_group_stop_id: "s-ret", pax: 50, direction: "departure" },
      ],
      booking_group_bus_reservations: [], // nessuna reservation ancora -> nextStep "reserve_bus"
      tenant_bus_units: [{ id: "BUS-54", tenant_id: TENANT, label: "Bus 54", capacity: 54, status: "open", manual_close: false, active: true, tag: null }],
    });
    const ctx: McpContext = { requestId: "req-1", userId: "user-1", userEmail: "op@example.com", tenantId: TENANT, role: "operator", admin };
    // Sessione (Redis) vuota per costruzione: nessun draft/pendingConfirmation seminato.
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13", kind: "bus_exclusive" }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "La Marra", bus_unit_id: "BUS-54", bus_unit_label: "Bus 54",
      service_date: "2026-09-13", reserved_pax: 50, exclusive: true,
      confirmationToken: "TOK-RESBUS", expiresAt: "2026-09-01T09:03:00Z",
    }));

    const r = await run(ctx, "Completa La Marra");

    expect(r.intent).toBe("mario_operational_chain_pending");
    expect(r.answer).toMatch(/Bus 54/);
    expect(r.answer).toMatch(/Confermi/i);
    expect(mockRunTool).toHaveBeenCalledTimes(1);
    expect(mockRunTool.mock.calls[0]![1]).toMatchObject({ name: "its.preview_reserve_booking_group_bus" });
  });
});
