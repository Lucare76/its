/**
 * FASE A.4 §30–§40 — policy conversazionale operativa end-to-end.
 * Orchestrator reale, router + runTool mockati, session store = fake Upstash.
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
const NOW = new Date("2026-09-01T09:00:00Z");

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
async function readDraft() {
  const { readMarioDraftOperation } = await import("@/lib/server/mario-assistant/session-context");
  return readMarioDraftOperation("tenant-a", "user-1");
}

describe("§30 TEST BUS SENZA DATA", () => {
  it("chiede SOLO la data, NON esegue la preview", async () => {
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "Lucia La Marra", expectedPax: 50 }));
    const r = await run("Puoi creare un bus per un gruppo di 50 persone a nome Lucia La Marra?");
    expect(r.intent).toBe("mario_llm_clarification");
    expect(r.answer).toMatch(/data/i);
    expect(mockRunTool).not.toHaveBeenCalled();
    const d = await readDraft();
    expect(d?.type).toBe("create_bus_group");
    expect(d?.missing).toEqual(["serviceDate"]);
    expect(d?.collected).toMatchObject({ name: "Lucia La Marra", expectedPax: 50 });
  });
});

describe("§31 TEST BUS CON DATA", () => {
  it("preview immediata con nome, pax, data", async () => {
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "Lucia La Marra", expectedPax: 50, serviceDate: "2026-09-13" }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "Lucia La Marra", expected_pax: 50, service_date_label: "13/09/2026", confirmationToken: "T1", expiresAt: "2026-09-01T09:03:00Z" }));
    const r = await run("Puoi creare un bus per Lucia La Marra, 50 persone, il 13 settembre?");
    expect(r.intent).toBe("mario_llm_pending_confirmation");
    expect(r.answer).toMatch(/Lucia La Marra/);
    expect(r.answer).toMatch(/50 pax/);
    expect(r.answer).toMatch(/13\/09\/2026/);
    expect(mockRunTool.mock.calls[0]![2]).toMatchObject({ name: "Lucia La Marra", expectedPax: 50, serviceDate: "2026-09-13", kind: "bus_group" });
  });
});

describe("§32 TEST GRUPPO GENERICO SENZA DATA", () => {
  it("preview immediata, nessuna data richiesta", async () => {
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "Juventus", expectedPax: 50 }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "Juventus", expected_pax: 50, confirmationToken: "T2", expiresAt: "2026-09-01T09:03:00Z" }));
    const r = await run("Fammi un gruppo Juventus da 50 persone");
    expect(r.intent).toBe("mario_llm_pending_confirmation");
    expect(mockRunTool.mock.calls[0]![2]).toEqual({ name: "Juventus", expectedPax: 50 });
  });
});

describe("§33 TEST ORIGINE", () => {
  it("origin preservato nel draft, MAI negli arguments del create tool", async () => {
    mockRoute.mockResolvedValueOnce(
      toolCall("its.preview_create_booking_group", { name: "Lucia La Marra", expectedPax: 50, serviceDate: "2026-09-13", origin: "Rimini" }),
    );
    mockRunTool.mockResolvedValueOnce(ok({ name: "Lucia La Marra", expected_pax: 50, service_date_label: "13/09/2026", confirmationToken: "T3", expiresAt: "2026-09-01T09:03:00Z" }));
    const r = await run("Bus Lucia La Marra 50 persone, 13 settembre, partenza da Rimini");
    expect(r.intent).toBe("mario_llm_pending_confirmation");

    const args = mockRunTool.mock.calls[0]![2] as Record<string, unknown>;
    expect(args).not.toHaveProperty("origin");
    const d = await readDraft();
    expect(d?.collected).toMatchObject({ origin: "Rimini" });
  });
});

describe("§36 TEST PAX > TOTAL", () => {
  it("warning pax fermate > totale gruppo → clarification, nessuna conferma silenziosa", async () => {
    mockRoute.mockResolvedValueOnce(
      toolCall("its.preview_add_booking_group_stop", { bookingGroupId: "BG1", city: "Guidonia", expectedPax: 40, direction: "arrival" }),
    );
    mockRunTool.mockResolvedValueOnce(
      ok({
        booking_group_id: "BG1",
        group_name: "La Marra",
        city: "Guidonia",
        expected_pax: 40,
        planned_pax_after: 60,
        group_expected_pax: 50,
        warnings: ["planned_pax_exceeds_group_expected"],
        confirmationToken: "TW",
        expiresAt: "2026-09-01T09:06:00Z",
      }),
    );
    const r = await run("Aggiungi 40 a Guidonia sul gruppo");
    expect(r.intent).toBe("mario_llm_clarification");
    expect(r.answer).toMatch(/superano|oltre|60|50/);

    const { readPendingConfirmation } = await import("@/lib/server/mario-assistant/session-context");
    expect((await readPendingConfirmation("tenant-a", "user-1")).status).toBe("none");
  });
});

describe("§37 TEST AMBIGUITÀ BUS", () => {
  it("'bus da 54 posti' → clarification, NON crea automaticamente un gruppo da 54 pax", async () => {
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 54 }));
    const r = await run("Prenotami un bus da 54 posti per La Marra");
    expect(r.intent).toBe("mario_llm_clarification");
    expect(r.answer).toMatch(/mezzo fisico|gruppo bus/i);
    expect(mockRunTool).not.toHaveBeenCalled();
  });
});

describe("§40 TEST READ CON DRAFT", () => {
  it("read giornata non perde il draft; poi il draft riprende", async () => {
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 50 }));
    await run("Creami un bus La Marra da 50 persone");
    expect(await readDraft()).not.toBeNull();

    mockRunTool.mockResolvedValueOnce(
      ok({ date: "2026-09-01", summary: { total_services: 0, upcoming_services: 0, unassigned_services: 0, active_services: 0 }, critical_items: [], warnings: [], health: { available: true, overall: "healthy" } }),
    );
    const rRead = await run("Come siamo messi oggi?");
    expect(rRead.intent).toBe("operational_brief");
    expect(await readDraft()).not.toBeNull();

    mockRunTool.mockResolvedValueOnce(ok({ name: "La Marra", expected_pax: 50, service_date_label: "13/09/2026", confirmationToken: "TR", expiresAt: "2026-09-01T09:09:00Z" }));
    const rResume = await run("13 settembre");
    expect(rResume.intent).toBe("mario_llm_pending_confirmation");
    expect(rResume.answer).toMatch(/13\/09\/2026/);
  });
});
