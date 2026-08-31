/**
 * FASE A.5 — workflow operativo bus end-to-end: dopo la conferma di
 * creazione di un gruppo bus operativo (kind bus_exclusive/bus_group CON
 * un'origine nota), l'orchestratore avanza da solo per: fermata andata ->
 * servizio andata -> fermata ritorno -> servizio ritorno -> operativizzazione
 * -> riepilogo finale, SENZA mai chiedere di nuovo nome/pax/città/date
 * all'utente e SENZA bypassare la conferma ad ogni step (una sola "sì" per
 * step, mai un'esecuzione automatica del write).
 *
 * Router LLM/runTool mockati come in mario-operation-policy-e2e.test.ts; il
 * draft di partenza è seminato direttamente in sessione (il merge NLU che
 * porta a quello stato è già coperto da FASE A.4.x).
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

// FASE A.5.2 §7 — fake admin minimale per `findAvailableBusesForGroup`
// (letta direttamente dalla catena, non via tool MCP): un solo bus con
// capienza sufficiente e nessuna reservation preesistente, così il flusso di
// prenotazione bus esclusivo lo trova/propone senza ambiguità.
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

const CTX: McpContext = {
  requestId: "req-1",
  userId: "user-1",
  userEmail: "op@example.com",
  tenantId: "tenant-a",
  role: "operator",
  admin: makeBusAdmin({
    tenant_bus_units: [{ id: "BUS-54", tenant_id: "tenant-a", label: "Bus 54", capacity: 54, status: "open", manual_close: false, active: true, tag: null }],
    booking_group_bus_reservations: [],
  }),
};
const NOW = new Date("2026-08-31T09:00:00Z");
const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });

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

async function run(message: string) {
  const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
  return runMarioAssistant(CTX, message, NOW);
}

async function seedPendingCreate(type: string, collected: Record<string, unknown>) {
  const { setMarioDraftOperation, updateMarioSession } = await import("@/lib/server/mario-assistant/session-context");
  await setMarioDraftOperation("tenant-a", "user-1", { type, collected, missing: [] });
  await updateMarioSession("tenant-a", "user-1", {
    pendingConfirmation: { toolName: "its.create_booking_group", confirmationToken: "TOK-CREATE", op: "its.preview_create_booking_group", createdAt: Date.now() },
  });
}

describe("FASE A.5 — catena workflow operativo bus (La Marra, Rimini, 13->20 settembre, esclusivo)", () => {
  it("group -> outbound stop -> outbound service -> return stop -> return service -> operationalize -> riepilogo finale", async () => {
    await seedPendingCreate("create_exclusive_bus_group", {
      name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13", returnDate: "2026-09-20", origin: "Rimini", kind: "bus_exclusive",
    });

    // 1) conferma creazione gruppo -> avanza da sola alla fermata andata
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", name: "La Marra", status: "draft" }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "La Marra", city: "Rimini", pickup_point: null, expected_pax: 50, direction: "arrival",
      planned_pax_before: 0, planned_pax_after: 50, group_expected_pax: 50, warnings: [],
      confirmationToken: "TOK-STOP-OUT", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r1 = await run("sì");
    expect(r1.intent).toBe("mario_operational_chain_pending");
    expect(r1.answer).toMatch(/creato/i);
    expect(r1.answer).toMatch(/Rimini/);
    expect(mockRunTool).toHaveBeenCalledTimes(2);

    // 2) conferma fermata andata -> avanza al servizio andata (nominativo aggregato)
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupStopId: "STOP-OUT", bookingGroupId: "BG1", city: "Rimini" }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", booking_group_stop_id: "STOP-OUT", group_name: "La Marra", stop_city: "Rimini",
      service_date: "2026-09-13", service_date_label: "13/09/2026", passenger_count: 1, total_pax: 50,
      stop_expected_pax: 50, stop_remaining_after: 0, warnings: [],
      confirmationToken: "TOK-PAX-OUT", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r2 = await run("sì");
    expect(r2.intent).toBe("mario_operational_chain_pending");
    const passengersArgs = mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(passengersArgs).toMatchObject({ bookingGroupId: "BG1", bookingGroupStopId: "STOP-OUT" });
    expect(passengersArgs.passengers).toEqual([{ customerName: "Gruppo La Marra", pax: 50 }]);
    // andata: nessun override di data, resta il default group.service_date
    expect(passengersArgs.serviceDate).toBeUndefined();

    // 3) conferma servizio andata -> avanza alla fermata ritorno (direction=departure)
    mockRunTool.mockResolvedValueOnce(ok({
      bookingGroupId: "BG1", bookingGroupStopId: "STOP-OUT",
      created: [{ id: "SVC-OUT", customer_name: "Gruppo La Marra", pax: 50 }], failed: [], created_count: 1, failed_count: 0, outcome: "created",
    }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "La Marra", city: "Rimini", pickup_point: null, expected_pax: 50, direction: "departure",
      planned_pax_before: 50, planned_pax_after: 100, group_expected_pax: 50, warnings: [],
      confirmationToken: "TOK-STOP-RET", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r3 = await run("sì");
    expect(r3.intent).toBe("mario_operational_chain_pending");
    expect((mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>).direction).toBe("departure");

    // 4) conferma fermata ritorno -> avanza al servizio ritorno con serviceDate = returnDate
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupStopId: "STOP-RET", bookingGroupId: "BG1", city: "Rimini" }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", booking_group_stop_id: "STOP-RET", group_name: "La Marra", stop_city: "Rimini",
      service_date: "2026-09-20", service_date_label: "20/09/2026", passenger_count: 1, total_pax: 50,
      stop_expected_pax: 50, stop_remaining_after: 0, warnings: [],
      confirmationToken: "TOK-PAX-RET", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r4 = await run("sì");
    expect(r4.intent).toBe("mario_operational_chain_pending");
    const returnPassengersArgs = mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(returnPassengersArgs.serviceDate).toBe("2026-09-20");
    expect(returnPassengersArgs.bookingGroupStopId).toBe("STOP-RET");

    // 5) conferma servizio ritorno -> gruppo bus_exclusive: la catena elenca i
    // bus disponibili per l'andata (§7), trova UN solo candidato compatibile
    // su ENTRAMBE le date (§8) e lo propone direttamente in preview (ancora
    // "Confermi?", mai un bypass della conferma).
    mockRunTool.mockResolvedValueOnce(ok({
      bookingGroupId: "BG1", bookingGroupStopId: "STOP-RET",
      created: [{ id: "SVC-RET", customer_name: "Gruppo La Marra", pax: 50 }], failed: [], created_count: 1, failed_count: 0, outcome: "created",
    }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "La Marra", bus_unit_id: "BUS-54", bus_unit_label: "Bus 54",
      service_date: "2026-09-13", reserved_pax: 50, exclusive: true,
      confirmationToken: "TOK-RESBUS-OUT", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r5 = await run("sì");
    expect(r5.intent).toBe("mario_operational_chain_pending");
    expect(r5.answer).toMatch(/Confermi/i);
    expect(r5.answer).toMatch(/Bus 54/);
    expect(r5.answer).toMatch(/13-09-2026/);

    // 6) conferma reservation andata -> avanza DIRETTAMENTE alla preview della
    // reservation di ritorno (stesso bus già individuato al passo 5, §8:
    // nessuna nuova domanda "quale bus").
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", busUnitId: "BUS-54", serviceDate: "2026-09-13" }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "La Marra", bus_unit_id: "BUS-54", bus_unit_label: "Bus 54",
      service_date: "2026-09-20", reserved_pax: 50, exclusive: true,
      confirmationToken: "TOK-RESBUS-RET", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r6 = await run("sì");
    expect(r6.intent).toBe("mario_operational_chain_pending");
    expect(r6.answer).toMatch(/Bus 54/);
    expect(r6.answer).toMatch(/20-09-2026/);

    // 7) conferma reservation ritorno -> avanza alla readiness/operativizzazione
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", busUnitId: "BUS-54", serviceDate: "2026-09-20" }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "La Marra", expected_pax: 50, planned_pax: 100, service_pax: 100,
      services_total: 2, services_ready: 2, services_blocked: 0, services_already_operational: 0, warnings: [],
      bus_reservation: { bus_unit_label: "Bus 54" }, ferry: { outbound: {}, return: {} }, services: [],
      confirmationToken: "TOK-OPZ", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r7 = await run("sì");
    expect(r7.intent).toBe("mario_operational_chain_pending");
    expect(r7.answer).toMatch(/Confermi/i);

    // 8) conferma operativizzazione -> riepilogo finale, draft chiuso
    mockRunTool.mockResolvedValueOnce(ok({
      bookingGroupId: "BG1", outcome: "operationalized",
      operationalized: [{ service_id: "SVC-OUT", warnings: [] }, { service_id: "SVC-RET", warnings: [] }],
      blocked: [], already_operational: [], group_status: "operational",
    }));
    const r8 = await run("sì");
    expect(r8.intent).toBe("mario_operational_chain_completed");
    expect(r8.answer).toMatch(/La Marra/);
    expect(r8.answer).toMatch(/andata 13-09-2026/);
    expect(r8.answer).toMatch(/ritorno 20-09-2026/);
    expect(r8.answer).toMatch(/50 pax/);

    const { readMarioDraftOperation, readPendingConfirmation } = await import("@/lib/server/mario-assistant/session-context");
    expect(await readMarioDraftOperation("tenant-a", "user-1")).toBeNull();
    expect((await readPendingConfirmation("tenant-a", "user-1")).status).toBe("none");
  });
});

describe("FASE A.5 §31 — gruppo generico (nessuna origine) NON innesca la catena", () => {
  it("'Fammi un gruppo Juventus da 50' resta un contenitore: 'Fatto.' e stop, nessun add_stop", async () => {
    await seedPendingCreate("create_generic_booking_group", { name: "Juventus", expectedPax: 50 });
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG2", name: "Juventus", status: "draft" }));

    const r = await run("sì");
    expect(r.intent).toBe("mario_llm_confirmed");
    expect(r.answer).toBe("Fatto. Operazione completata.");
    expect(mockRunTool).toHaveBeenCalledTimes(1);

    const { readMarioDraftOperation } = await import("@/lib/server/mario-assistant/session-context");
    expect(await readMarioDraftOperation("tenant-a", "user-1")).toBeNull();
  });
});

describe("FASE A.5 §M — operationalize con 0 servizi pronti: nessun 'Confermi?' su un no-op", () => {
  it("readiness bloccata (es. missing_time) chiude la catena riportando cosa manca, mai una conferma vuota", async () => {
    await seedPendingCreate("operational_bus_group_chain", {
      name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13", origin: "Rimini", kind: "bus_exclusive",
      bookingGroupId: "BG1", _chainStage: "outbound_passengers", _chainRemaining: ["operationalize"],
    });
    // ultimo step della catena in questo test: passengers andata confermato,
    // ma la preview di operativizzazione torna 0 pronti (es. missing_time).
    const { updateMarioSession } = await import("@/lib/server/mario-assistant/session-context");
    await updateMarioSession("tenant-a", "user-1", {
      pendingConfirmation: { toolName: "its.add_booking_group_passengers", confirmationToken: "TOK-PAX-OUT", op: "its.preview_add_booking_group_passengers", createdAt: Date.now() },
    });

    mockRunTool.mockResolvedValueOnce(ok({
      bookingGroupId: "BG1", bookingGroupStopId: "STOP-OUT",
      created: [{ id: "SVC-OUT", customer_name: "Gruppo La Marra", pax: 50 }], failed: [], created_count: 1, failed_count: 0, outcome: "created",
    }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "La Marra", expected_pax: 50, planned_pax: 50, service_pax: 50,
      services_total: 1, services_ready: 0, services_blocked: 1, services_already_operational: 0, warnings: [],
      bus_reservation: null, ferry: { outbound: {}, return: {} },
      services: [{ service_id: "SVC-OUT", customer_name: "Gruppo La Marra", pax: 50, ready: false, already_operational: false, missing_fields: ["missing_time"], warnings: [] }],
      confirmationToken: "TOK-OPZ-BLOCKED", expiresAt: "2026-09-01T09:03:00Z",
    }));

    const r = await run("sì");
    expect(r.intent).toBe("mario_operational_chain_blocked");
    expect(r.answer).toMatch(/missing_time/);

    const { readMarioDraftOperation, readPendingConfirmation } = await import("@/lib/server/mario-assistant/session-context");
    expect(await readMarioDraftOperation("tenant-a", "user-1")).toBeNull();
    expect((await readPendingConfirmation("tenant-a", "user-1")).status).toBe("none");
  });
});
