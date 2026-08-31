/**
 * FASE A.5.2 §1–§6 — workflow operativo bus MULTI-STOP end-to-end: un
 * messaggio con più fermate ("20 Tivoli e 30 Guidonia") viene parsato
 * deterministicamente (§2), validato contro il totale pax del gruppo (§3), e
 * la catena crea UNA fermata + UN service aggregato PER fermata PER
 * direzione (andata e ritorno, stessa distribuzione, §5) — mai un service
 * con il pax totale del gruppo su una singola fermata (§4).
 *
 * Router LLM/runTool mockati come nelle altre suite mario-*-e2e.
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

const CTX: McpContext = {
  requestId: "req-1",
  userId: "user-1",
  userEmail: "op@example.com",
  tenantId: "tenant-a",
  role: "operator",
  admin: {} as McpContext["admin"],
};
const NOW = new Date("2026-08-31T09:00:00Z");
const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const toolCall = (tool_name: string, args: Record<string, unknown>) => ({
  decision: { action: "tool_call" as const, tool_name, arguments: args, confidence: 0.95 },
  usage: { inputTokens: 1000, outputTokens: 60 },
  fallbackUsed: false,
  latencyMs: 10,
});

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

function stopPreviewOutput(city: string, pax: number, direction: "arrival" | "departure", token: string) {
  return ok({
    booking_group_id: "BG1", group_name: "Test Multi", city, pickup_point: null, expected_pax: pax, direction,
    planned_pax_before: 0, planned_pax_after: pax, group_expected_pax: 50, warnings: [],
    confirmationToken: token, expiresAt: "2026-09-01T09:03:00Z",
  });
}
function passengersPreviewOutput(city: string, pax: number, serviceDate: string, token: string, stopId: string) {
  return ok({
    booking_group_id: "BG1", booking_group_stop_id: stopId, group_name: "Test Multi", stop_city: city,
    service_date: serviceDate, service_date_label: serviceDate, passenger_count: 1, total_pax: pax,
    stop_expected_pax: pax, stop_remaining_after: 0, warnings: [],
    confirmationToken: token, expiresAt: "2026-09-01T09:03:00Z",
  });
}

describe("FASE A.5.2 — multi-stop end-to-end (Test Multi, 20 Tivoli + 30 Guidonia, 13->20 settembre)", () => {
  it("parsing -> somma pax -> 2 fermate andata + 2 fermate ritorno, pax per fermata mai il totale del gruppo", async () => {
    mockRoute.mockResolvedValueOnce(
      toolCall("its.preview_create_booking_group", { name: "Test Multi", expectedPax: 50, serviceDate: "2026-09-13", kind: "bus_group" }),
    );
    mockRunTool.mockResolvedValueOnce(ok({ name: "Test Multi", expected_pax: 50, service_date: "2026-09-13", confirmationToken: "TOK-CREATE", expiresAt: "2026-09-01T09:03:00Z" }));

    const r0 = await run("Caricami gruppo Test Multi, 50 persone, 20 Tivoli e 30 Guidonia, 13-20 settembre");
    expect(r0.intent).toBe("mario_llm_pending_confirmation");

    // conferma creazione gruppo -> avanza da sola alla PRIMA fermata (Tivoli, andata)
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", name: "Test Multi", status: "draft" }));
    mockRunTool.mockResolvedValueOnce(stopPreviewOutput("Tivoli", 20, "arrival", "TOK-STOP-TIVOLI-ARR"));
    const r1 = await run("sì");
    expect(r1.intent).toBe("mario_operational_chain_pending");
    expect((mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>)).toMatchObject({ city: "Tivoli", expectedPax: 20, direction: "arrival" });

    // conferma fermata Tivoli andata -> passeggeri Tivoli andata (pax 20, MAI 50)
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupStopId: "STOP-TIV-ARR", bookingGroupId: "BG1", city: "Tivoli" }));
    mockRunTool.mockResolvedValueOnce(passengersPreviewOutput("Tivoli", 20, "2026-09-13", "TOK-PAX-TIVOLI-ARR", "STOP-TIV-ARR"));
    const r2 = await run("sì");
    expect(r2.intent).toBe("mario_operational_chain_pending");
    const paxTivoliArr = mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(paxTivoliArr.bookingGroupStopId).toBe("STOP-TIV-ARR");
    expect(paxTivoliArr.passengers).toEqual([{ customerName: "Gruppo Test Multi", pax: 20 }]);

    // conferma pax Tivoli andata -> fermata Guidonia andata
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", created: [{ id: "SVC-TIV-ARR", customer_name: "Gruppo Test Multi", pax: 20 }], failed: [], created_count: 1, failed_count: 0, outcome: "created" }));
    mockRunTool.mockResolvedValueOnce(stopPreviewOutput("Guidonia", 30, "arrival", "TOK-STOP-GUI-ARR"));
    const r3 = await run("sì");
    expect(r3.intent).toBe("mario_operational_chain_pending");
    expect((mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>)).toMatchObject({ city: "Guidonia", expectedPax: 30, direction: "arrival" });

    // conferma fermata Guidonia andata -> passeggeri Guidonia andata (pax 30)
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupStopId: "STOP-GUI-ARR", bookingGroupId: "BG1", city: "Guidonia" }));
    mockRunTool.mockResolvedValueOnce(passengersPreviewOutput("Guidonia", 30, "2026-09-13", "TOK-PAX-GUI-ARR", "STOP-GUI-ARR"));
    const r4 = await run("sì");
    expect(r4.intent).toBe("mario_operational_chain_pending");
    const paxGuidoniaArr = mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(paxGuidoniaArr.passengers).toEqual([{ customerName: "Gruppo Test Multi", pax: 30 }]);

    // conferma pax Guidonia andata -> fermata Tivoli RITORNO (§5: stessa distribuzione)
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", created: [{ id: "SVC-GUI-ARR", customer_name: "Gruppo Test Multi", pax: 30 }], failed: [], created_count: 1, failed_count: 0, outcome: "created" }));
    mockRunTool.mockResolvedValueOnce(stopPreviewOutput("Tivoli", 20, "departure", "TOK-STOP-TIV-DEP"));
    const r5 = await run("sì");
    expect(r5.intent).toBe("mario_operational_chain_pending");
    expect((mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>)).toMatchObject({ city: "Tivoli", expectedPax: 20, direction: "departure" });

    // conferma fermata Tivoli ritorno -> passeggeri Tivoli ritorno (serviceDate = returnDate)
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupStopId: "STOP-TIV-DEP", bookingGroupId: "BG1", city: "Tivoli" }));
    mockRunTool.mockResolvedValueOnce(passengersPreviewOutput("Tivoli", 20, "2026-09-20", "TOK-PAX-TIV-DEP", "STOP-TIV-DEP"));
    const r6 = await run("sì");
    expect(r6.intent).toBe("mario_operational_chain_pending");
    const paxTivoliDep = mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(paxTivoliDep.serviceDate).toBe("2026-09-20");
    expect(paxTivoliDep.passengers).toEqual([{ customerName: "Gruppo Test Multi", pax: 20 }]);

    // conferma pax Tivoli ritorno -> fermata Guidonia ritorno
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", created: [{ id: "SVC-TIV-DEP", customer_name: "Gruppo Test Multi", pax: 20 }], failed: [], created_count: 1, failed_count: 0, outcome: "created" }));
    mockRunTool.mockResolvedValueOnce(stopPreviewOutput("Guidonia", 30, "departure", "TOK-STOP-GUI-DEP"));
    const r7 = await run("sì");
    expect(r7.intent).toBe("mario_operational_chain_pending");
    expect((mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>)).toMatchObject({ city: "Guidonia", expectedPax: 30, direction: "departure" });

    // conferma fermata Guidonia ritorno -> passeggeri Guidonia ritorno (pax 30)
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupStopId: "STOP-GUI-DEP", bookingGroupId: "BG1", city: "Guidonia" }));
    mockRunTool.mockResolvedValueOnce(passengersPreviewOutput("Guidonia", 30, "2026-09-20", "TOK-PAX-GUI-DEP", "STOP-GUI-DEP"));
    const r8 = await run("sì");
    expect(r8.intent).toBe("mario_operational_chain_pending");
    const paxGuidoniaDep = mockRunTool.mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(paxGuidoniaDep.serviceDate).toBe("2026-09-20");
    expect(paxGuidoniaDep.passengers).toEqual([{ customerName: "Gruppo Test Multi", pax: 30 }]);

    // conferma pax Guidonia ritorno -> operativizzazione (50+50 = 100 totale su 2 direzioni, mai 100 su una fermata sola)
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG1", created: [{ id: "SVC-GUI-DEP", customer_name: "Gruppo Test Multi", pax: 30 }], failed: [], created_count: 1, failed_count: 0, outcome: "created" }));
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", group_name: "Test Multi", expected_pax: 50, planned_pax: 100, service_pax: 100,
      services_total: 4, services_ready: 4, services_blocked: 0, services_already_operational: 0, warnings: [],
      bus_reservation: null, ferry: { outbound: {}, return: {} }, services: [],
      confirmationToken: "TOK-OPZ", expiresAt: "2026-09-01T09:03:00Z",
    }));
    const r9 = await run("sì");
    expect(r9.intent).toBe("mario_operational_chain_pending");

    // conferma operativizzazione -> riepilogo finale
    mockRunTool.mockResolvedValueOnce(ok({
      bookingGroupId: "BG1", outcome: "operationalized",
      operationalized: [{ service_id: "SVC-TIV-ARR", warnings: [] }, { service_id: "SVC-GUI-ARR", warnings: [] }, { service_id: "SVC-TIV-DEP", warnings: [] }, { service_id: "SVC-GUI-DEP", warnings: [] }],
      blocked: [], already_operational: [], group_status: "operational",
    }));
    const r10 = await run("sì");
    expect(r10.intent).toBe("mario_operational_chain_completed");
    expect(r10.answer).toMatch(/Test Multi/);
    expect(r10.answer).toMatch(/Tivoli 20/);
    expect(r10.answer).toMatch(/Guidonia 30/);

    const { readMarioDraftOperation } = await import("@/lib/server/mario-assistant/session-context");
    expect(await readMarioDraftOperation("tenant-a", "user-1")).toBeNull();
  });
});

describe("FASE A.5.2 §3 — overbooking multi-stop: somma pax > totale gruppo blocca PRIMA di creare", () => {
  it("20 Tivoli + 40 Guidonia (60) su un gruppo da 50 -> clarification, nessun tool eseguito", async () => {
    mockRoute.mockResolvedValueOnce(
      toolCall("its.preview_create_booking_group", { name: "Test Overbook", expectedPax: 50, serviceDate: "2026-09-13", kind: "bus_group" }),
    );

    const r = await run("Caricami gruppo Test Overbook, 50 persone, 20 Tivoli e 40 Guidonia, 13-20 settembre");

    expect(mockRunTool).not.toHaveBeenCalled();
    expect(r.intent).toBe("mario_llm_clarification");
    expect(r.answer).toMatch(/60 pax/);
    expect(r.answer).toMatch(/50/);
  });
});

describe("FASE A.5.2 §3 — sotto il totale: chiede dove salgono i pax mancanti", () => {
  it("20 Tivoli + 20 Guidonia (40) su un gruppo da 50 -> clarification sui 10 mancanti", async () => {
    mockRoute.mockResolvedValueOnce(
      toolCall("its.preview_create_booking_group", { name: "Test Parziale", expectedPax: 50, serviceDate: "2026-09-13", kind: "bus_group" }),
    );

    const r = await run("Caricami gruppo Test Parziale, 50 persone, 20 Tivoli e 20 Guidonia, 13-20 settembre");

    expect(mockRunTool).not.toHaveBeenCalled();
    expect(r.intent).toBe("mario_llm_clarification");
    expect(r.answer).toMatch(/40 pax/);
    expect(r.answer).toMatch(/10 pax/);
  });
});
