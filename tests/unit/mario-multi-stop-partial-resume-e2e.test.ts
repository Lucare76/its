/**
 * FASE A.5.3 — chiusura del limite residuo dichiarato in A.5.2: il resume di
 * un gruppo MULTI-STOP interrotto a metà (una fermata già creata/servita,
 * l'altra no) deve confrontare TUTTE le fermate attese con lo stato reale
 * del DB e calcolare l'elenco completo degli step mancanti — mai un solo
 * indice hardcoded.
 *
 * Scenario: gruppo "Test Multi" (50 pax, 20 Tivoli + 30 Guidonia, andata
 * 13-09 / ritorno 20-09). Nel DB esiste già SOLO la fermata+servizio di
 * andata di Tivoli. Redis è vuoto (nessun draft/pendingConfirmation). Il
 * messaggio ripete la distribuzione (§4 — Redis non conosce il ritorno,
 * mai persistito lato DB su `booking_groups`, quindi va ridetto).
 *
 * Il DB viene mutato manualmente in lockstep con ciascun runTool mockato
 * (stessa cosa che farebbe il vero handler MCP), cosi' la SECONDA esecuzione
 * dello stesso comando (§6) verifica l'idempotenza sullo stato realmente
 * risultante, non su un doppione.
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
const GROUP_ID = "BG1";
const NOW = new Date("2026-08-31T09:00:00Z");
const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const toolCall = (tool_name: string, args: Record<string, unknown>) => ({
  decision: { action: "tool_call" as const, tool_name, arguments: args, confidence: 0.95 },
  usage: { inputTokens: 1000, outputTokens: 60 },
  fallbackUsed: false,
  latencyMs: 10,
});
const MESSAGE = "Completa Test Multi, 20 Tivoli e 30 Guidonia, 13-20 settembre";

type Row = Record<string, unknown>;

function makeAdmin(tables: Record<string, Row[]>): McpContext["admin"] {
  function builder(table: string) {
    const filters: Row = {};
    const inFilters: Array<{ col: string; vals: unknown[] }> = [];
    const rowsForFilters = () =>
      (tables[table] ?? []).filter(
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

let fake: FakeUpstashRedis;
let tables: Record<string, Row[]>;
let ctx: McpContext;

beforeEach(async () => {
  vi.stubEnv("MARIO_LLM_ENABLED", "true");
  vi.spyOn(console, "info").mockImplementation(() => {});
  fake = new FakeUpstashRedis();
  const { __setSharedRedisForTests } = await import("@/lib/server/redis");
  __setSharedRedisForTests(fake as unknown as Redis);
  mockGetTool.mockReset().mockImplementation((name: string) => ({ name }));
  mockRunTool.mockReset();
  mockRoute.mockReset();

  // Stato DB iniziale: SOLO Tivoli andata creata+servita. Guidonia andata e
  // TUTTO il ritorno mancano ancora.
  tables = {
    booking_groups: [{ id: GROUP_ID, tenant_id: TENANT, name: "Test Multi", status: "draft", kind: "bus_group", service_date: "2026-09-13", expected_pax: 50 }],
    booking_group_stops: [{ id: "STOP-TIV-ARR", tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Tivoli", direction: "arrival", expected_pax: 20, stop_id: null, pickup_point: null }],
    services: [{ id: "SVC-TIV-ARR", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "STOP-TIV-ARR", date: "2026-09-13", direction: "arrival", customer_name: "Gruppo Test Multi", pax: 20, is_draft: true, status: "needs_review", time: "00:00", bus_city_origin: "Tivoli", meeting_point: null, hotel_id: null, booking_service_kind: "bus_city_hotel" }],
    booking_group_bus_reservations: [],
  };
  ctx = { requestId: "req-1", userId: "user-1", userEmail: "op@example.com", tenantId: TENANT, role: "operator", admin: makeAdmin(tables) };
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
  return runMarioAssistant(ctx, message, NOW);
}

function stopPreviewOutput(city: string, pax: number, direction: "arrival" | "departure", token: string) {
  return ok({
    booking_group_id: GROUP_ID, group_name: "Test Multi", city, pickup_point: null, expected_pax: pax, direction,
    planned_pax_before: 0, planned_pax_after: pax, group_expected_pax: 50, warnings: [],
    confirmationToken: token, expiresAt: "2026-09-01T09:03:00Z",
  });
}
function passengersPreviewOutput(city: string, pax: number, serviceDate: string, token: string, stopId: string) {
  return ok({
    booking_group_id: GROUP_ID, booking_group_stop_id: stopId, group_name: "Test Multi", stop_city: city,
    service_date: serviceDate, service_date_label: serviceDate, passenger_count: 1, total_pax: pax,
    stop_expected_pax: pax, stop_remaining_after: 0, warnings: [],
    confirmationToken: token, expiresAt: "2026-09-01T09:03:00Z",
  });
}

/** Esegue l'intero resume parziale (7 step) mutando `tables` in lockstep con
 *  ciascun write mockato — come farebbe il vero handler MCP. Ritorna l'ultimo
 *  risultato (riepilogo finale). */
async function runFullPartialResume() {
  // 1) messaggio iniziale -> idempotenza trova il gruppo -> resume multi-stop:
  // Guidonia andata è la PRIMA fermata mancante (Tivoli andata già ok).
  mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "Test Multi", expectedPax: 50, serviceDate: "2026-09-13", kind: "bus_group" }));
  mockRunTool.mockResolvedValueOnce(stopPreviewOutput("Guidonia", 30, "arrival", "TOK-STOP-GUI-ARR"));
  const r1 = await run(MESSAGE);
  expect(r1.intent).toBe("mario_operational_chain_pending");
  expect((mockRunTool.mock.calls.at(-1)![2] as Row)).toMatchObject({ city: "Guidonia", expectedPax: 30, direction: "arrival" });

  // 2) conferma fermata Guidonia andata -> scrive + passeggeri Guidonia andata
  mockRunTool.mockResolvedValueOnce(ok({ bookingGroupStopId: "STOP-GUI-ARR", bookingGroupId: GROUP_ID, city: "Guidonia" }));
  mockRunTool.mockResolvedValueOnce(passengersPreviewOutput("Guidonia", 30, "2026-09-13", "TOK-PAX-GUI-ARR", "STOP-GUI-ARR"));
  const r2 = await run("sì");
  expect(r2.intent).toBe("mario_operational_chain_pending");
  tables.booking_group_stops.push({ id: "STOP-GUI-ARR", tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Guidonia", direction: "arrival", expected_pax: 30, stop_id: null, pickup_point: null });

  // 3) conferma pax Guidonia andata -> fermata Tivoli RITORNO (prima fermata mancante lato ritorno)
  mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: GROUP_ID, created: [{ id: "SVC-GUI-ARR", customer_name: "Gruppo Test Multi", pax: 30 }], failed: [], created_count: 1, failed_count: 0, outcome: "created" }));
  mockRunTool.mockResolvedValueOnce(stopPreviewOutput("Tivoli", 20, "departure", "TOK-STOP-TIV-DEP"));
  const r3 = await run("sì");
  expect(r3.intent).toBe("mario_operational_chain_pending");
  tables.services.push({ id: "SVC-GUI-ARR", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "STOP-GUI-ARR", date: "2026-09-13", direction: "arrival", customer_name: "Gruppo Test Multi", pax: 30, is_draft: true, status: "needs_review", time: "00:00", bus_city_origin: "Guidonia", meeting_point: null, hotel_id: null, booking_service_kind: "bus_city_hotel" });
  expect((mockRunTool.mock.calls.at(-1)![2] as Row)).toMatchObject({ city: "Tivoli", expectedPax: 20, direction: "departure" });

  // 4) conferma fermata Tivoli ritorno -> passeggeri Tivoli ritorno
  mockRunTool.mockResolvedValueOnce(ok({ bookingGroupStopId: "STOP-TIV-DEP", bookingGroupId: GROUP_ID, city: "Tivoli" }));
  mockRunTool.mockResolvedValueOnce(passengersPreviewOutput("Tivoli", 20, "2026-09-20", "TOK-PAX-TIV-DEP", "STOP-TIV-DEP"));
  const r4 = await run("sì");
  expect(r4.intent).toBe("mario_operational_chain_pending");
  tables.booking_group_stops.push({ id: "STOP-TIV-DEP", tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Tivoli", direction: "departure", expected_pax: 20, stop_id: null, pickup_point: null });

  // 5) conferma pax Tivoli ritorno -> fermata Guidonia ritorno
  mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: GROUP_ID, created: [{ id: "SVC-TIV-DEP", customer_name: "Gruppo Test Multi", pax: 20 }], failed: [], created_count: 1, failed_count: 0, outcome: "created" }));
  mockRunTool.mockResolvedValueOnce(stopPreviewOutput("Guidonia", 30, "departure", "TOK-STOP-GUI-DEP"));
  const r5 = await run("sì");
  expect(r5.intent).toBe("mario_operational_chain_pending");
  tables.services.push({ id: "SVC-TIV-DEP", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "STOP-TIV-DEP", date: "2026-09-20", direction: "departure", customer_name: "Gruppo Test Multi", pax: 20, is_draft: true, status: "needs_review", time: "00:00", bus_city_origin: "Tivoli", meeting_point: null, hotel_id: null, booking_service_kind: "bus_city_hotel" });

  // 6) conferma fermata Guidonia ritorno -> passeggeri Guidonia ritorno
  mockRunTool.mockResolvedValueOnce(ok({ bookingGroupStopId: "STOP-GUI-DEP", bookingGroupId: GROUP_ID, city: "Guidonia" }));
  mockRunTool.mockResolvedValueOnce(passengersPreviewOutput("Guidonia", 30, "2026-09-20", "TOK-PAX-GUI-DEP", "STOP-GUI-DEP"));
  const r6 = await run("sì");
  expect(r6.intent).toBe("mario_operational_chain_pending");
  tables.booking_group_stops.push({ id: "STOP-GUI-DEP", tenant_id: TENANT, booking_group_id: GROUP_ID, city: "Guidonia", direction: "departure", expected_pax: 30, stop_id: null, pickup_point: null });

  // 7) conferma pax Guidonia ritorno -> operativizzazione (4 services totali, tutti pronti)
  mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: GROUP_ID, created: [{ id: "SVC-GUI-DEP", customer_name: "Gruppo Test Multi", pax: 30 }], failed: [], created_count: 1, failed_count: 0, outcome: "created" }));
  mockRunTool.mockResolvedValueOnce(ok({
    booking_group_id: GROUP_ID, group_name: "Test Multi", expected_pax: 50, planned_pax: 100, service_pax: 100,
    services_total: 4, services_ready: 4, services_blocked: 0, services_already_operational: 0, warnings: [],
    bus_reservation: null, ferry: { outbound: {}, return: {} }, services: [],
    confirmationToken: "TOK-OPZ", expiresAt: "2026-09-01T09:03:00Z",
  }));
  const r7 = await run("sì");
  expect(r7.intent).toBe("mario_operational_chain_pending");
  tables.services.push({ id: "SVC-GUI-DEP", tenant_id: TENANT, booking_group_id: GROUP_ID, booking_group_stop_id: "STOP-GUI-DEP", date: "2026-09-20", direction: "departure", customer_name: "Gruppo Test Multi", pax: 30, is_draft: true, status: "needs_review", time: "00:00", bus_city_origin: "Guidonia", meeting_point: null, hotel_id: null, booking_service_kind: "bus_city_hotel" });

  // 8) conferma operativizzazione -> riepilogo finale
  mockRunTool.mockResolvedValueOnce(ok({
    bookingGroupId: GROUP_ID, outcome: "operationalized",
    operationalized: [{ service_id: "SVC-TIV-ARR", warnings: [] }, { service_id: "SVC-GUI-ARR", warnings: [] }, { service_id: "SVC-TIV-DEP", warnings: [] }, { service_id: "SVC-GUI-DEP", warnings: [] }],
    blocked: [], already_operational: [], group_status: "operational",
  }));
  const r8 = await run("sì");
  expect(r8.intent).toBe("mario_operational_chain_completed");
  tables.booking_groups[0]!.status = "operational";
  for (const s of tables.services) s.is_draft = false;

  return r8;
}

describe("FASE A.5.3 §2/§3/§5 — resume multi-stop PARZIALE: crea solo ciò che manca, mai duplica ciò che c'è", () => {
  it("Tivoli andata già presente, Guidonia andata + tutto il ritorno mancanti -> resume completo e corretto", async () => {
    await runFullPartialResume();

    const arrivalRows = tables.services.filter((s) => s.direction === "arrival");
    const departureRows = tables.services.filter((s) => s.direction === "departure");
    expect(arrivalRows.map((s) => s.id).sort()).toEqual(["SVC-GUI-ARR", "SVC-TIV-ARR"]);
    expect(departureRows.map((s) => s.id).sort()).toEqual(["SVC-GUI-DEP", "SVC-TIV-DEP"]);
    expect(arrivalRows.reduce((sum, s) => sum + Number(s.pax), 0)).toBe(50);
    expect(departureRows.reduce((sum, s) => sum + Number(s.pax), 0)).toBe(50);
    // Tivoli andata: MAI un secondo stop/service (solo l'originale SVC-TIV-ARR/STOP-TIV-ARR).
    expect(tables.booking_group_stops.filter((s) => s.city === "Tivoli" && s.direction === "arrival")).toHaveLength(1);
    expect(tables.services.filter((s) => s.booking_group_stop_id === "STOP-TIV-ARR")).toHaveLength(1);

    const { readMarioDraftOperation } = await import("@/lib/server/mario-assistant/session-context");
    expect(await readMarioDraftOperation(TENANT, "user-1")).toBeNull();
  });
});

describe("FASE A.5.3 §6 — comando ripetuto DOPO il resume: nessun duplicato", () => {
  it("rieseguire lo stesso comando dopo il resume completo non crea nulla di nuovo", async () => {
    await runFullPartialResume();

    const groupsBefore = tables.booking_groups.length;
    const stopsBefore = tables.booking_group_stops.length;
    const servicesBefore = tables.services.length;
    const runToolCallsBefore = mockRunTool.mock.calls.length;

    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "Test Multi", expectedPax: 50, serviceDate: "2026-09-13", kind: "bus_group" }));
    const rRepeat = await run(MESSAGE);

    expect(mockRunTool.mock.calls.length).toBe(runToolCallsBefore); // nessuna NUOVA preview/write: il gruppo risulta già completo
    expect(rRepeat.intent).toBe("mario_operational_chain_reused");
    expect(tables.booking_groups).toHaveLength(groupsBefore);
    expect(tables.booking_group_stops).toHaveLength(stopsBefore);
    expect(tables.services).toHaveLength(servicesBefore);
  });
});
