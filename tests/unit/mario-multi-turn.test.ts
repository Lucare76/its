/**
 * FASE A.2 §23/§24 — chat multi-turno end-to-end (orchestrator reale, router e
 * runTool mockati, session store = fake Upstash condiviso) + cost tracking
 * per-turno (`result.llm`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import type { McpContext } from "@/lib/mcp/context";
import { FakeUpstashRedis } from "./mario-fake-redis";

const mockGetTool = vi.fn();
const mockRunTool = vi.fn();
const mockRoute = vi.fn();

vi.mock("@/lib/mcp/registry", () => ({
  getTool: (...a: unknown[]) => mockGetTool(...a),
  listTools: () => [],
}));
vi.mock("@/lib/mcp/server", () => ({ runTool: (...a: unknown[]) => mockRunTool(...a) }));
vi.mock("@/lib/server/mario-assistant/llm-router", () => ({
  routeMarioWithLlm: (...a: unknown[]) => mockRoute(...a),
}));

const CTX: McpContext = {
  requestId: "req-1",
  userId: "user-1",
  userEmail: "op@example.com",
  tenantId: "tenant-a",
  role: "operator",
  admin: {} as McpContext["admin"],
};

const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const toolCall = (tool_name: string, args: Record<string, unknown>, usage = { inputTokens: 1200, outputTokens: 120 }) => ({
  decision: { action: "tool_call" as const, tool_name, arguments: args, confidence: 0.95 },
  usage,
  fallbackUsed: false,
  latencyMs: 10,
});

let fake: FakeUpstashRedis;

beforeEach(async () => {
  vi.stubEnv("MARIO_LLM_ENABLED", "true");
  vi.stubEnv("MARIO_LLM_INPUT_USD_PER_MILLION", "1");
  vi.stubEnv("MARIO_LLM_OUTPUT_USD_PER_MILLION", "5");
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
  return runMarioAssistant(CTX, message, new Date("2026-09-01T09:00:00Z"));
}

function createCalls() {
  return mockRunTool.mock.calls.filter((c) => (c[1] as { name?: string })?.name === "its.create_booking_group");
}

describe("§23 TEST 1 — Juventus 50: preview → Sì → creato (un solo write)", () => {
  it("passa dallo stesso gruppo, un solo its.create_booking_group, nessun duplicato", async () => {
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "Juventus", expectedPax: 50 }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "Juventus", expected_pax: 50, confirmationToken: "TOK1", expiresAt: "2026-09-01T09:03:00Z" }));
    const r1 = await run("Fammi un gruppo Juventus da 50 persone"); // "Fammi" → booking_group_write (FASE A.2 parser)
    expect(r1.intent).toBe("mario_llm_pending_confirmation");
    expect(r1.answer).toMatch(/Confermi\?$/);
    expect(r1.answer).not.toContain("TOK1");
    // §24: turno con chiamata LLM → costo tracciato
    expect(r1.llm?.llmCalled).toBe(true);
    expect(r1.llm?.inputTokens).toBe(1200);
    expect(typeof r1.llm?.costUsd).toBe("number");
    expect(r1.llm!.costUsd!).toBeGreaterThan(0);

    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG-JUVE", name: "Juventus", status: "to_complete" }));
    const r2 = await run("Sì");
    expect(r2.intent).toBe("mario_llm_confirmed");
    expect(mockRoute).toHaveBeenCalledTimes(1); // la conferma NON chiama il router
    // §24 Caso B: conferma = fast-path deterministico → nessuna "chiamata AI"
    expect(r2.llm).toBeUndefined();

    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0]![2]).toEqual({ confirmationToken: "TOK1" });
  });
});

describe("§23 TEST 2 — La Marra: preview → No annulla → niente gruppo", () => {
  it("nessun its.create_booking_group eseguito", async () => {
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 50 }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "La Marra", expected_pax: 50, confirmationToken: "TOK2", expiresAt: "2026-09-01T09:03:00Z" }));
    // "gruppo" generico → preview immediata (per un "bus" senza data la policy
    // FASE A.4 chiederebbe prima la data — coperto da mario-operation-policy).
    const r1 = await run("Creami un gruppo La Marra con 50 persone");
    expect(r1.intent).toBe("mario_llm_pending_confirmation");

    const r2 = await run("No annulla");
    expect(r2.intent).toBe("confirmation_cancelled");
    expect(r2.answer).toMatch(/annullat/i);
    expect(r2.llm).toBeUndefined();

    expect(createCalls()).toHaveLength(0);
    expect(mockRunTool.mock.calls.every((c) => (c[1] as { name?: string })?.name !== "its.add_booking_group_stop")).toBe(true);
  });
});

describe("§23 TEST 3 — Roma → Confermo → aggiungi 20 a Tivoli (stesso gruppo dal contesto Redis)", () => {
  it("la preview della fermata usa il booking group appena creato", async () => {
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "Roma", expectedPax: 40 }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "Roma", expected_pax: 40, confirmationToken: "TOK3", expiresAt: "2026-09-01T09:03:00Z" }));
    await run("Creami un gruppo Roma da 40 persone");

    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG-ROMA", name: "Roma", status: "to_complete" }));
    const r2 = await run("Confermo");
    expect(r2.intent).toBe("mario_llm_confirmed");

    mockRoute.mockResolvedValueOnce(
      toolCall("its.preview_add_booking_group_stop", { bookingGroupId: "BG-ROMA", city: "Tivoli", expectedPax: 20, direction: "arrival" }),
    );
    mockRunTool.mockResolvedValueOnce(
      ok({ booking_group_id: "BG-ROMA", group_name: "Roma", city: "Tivoli", expected_pax: 20, confirmationToken: "TOK4", expiresAt: "2026-09-01T09:06:00Z" }),
    );
    const r3 = await run("Aggiungi 20 persone che salgono a Tivoli");

    // il router ha ricevuto il gruppo dal contesto condiviso
    const lastRouteArg = mockRoute.mock.calls.at(-1)![0] as { sessionSummary: { lastBookingGroupId?: string } };
    expect(lastRouteArg.sessionSummary.lastBookingGroupId).toBe("BG-ROMA");
    expect(r3.answer).toMatch(/Tivoli/);
    expect(r3.answer).toMatch(/Confermi\?$/);
    expect(r3.llm?.llmCalled).toBe(true);
  });
});

describe("§24 Caso B — fast-path deterministico non è una chiamata AI", () => {
  it("intent supportato dal parser → nessun router, result.llm assente", async () => {
    mockRunTool.mockResolvedValue(
      ok({
        date: "2026-09-01",
        summary: { total_services: 0, upcoming_services: 0, unassigned_services: 0, active_services: 0 },
        critical_items: [],
        warnings: [],
        health: { available: true, overall: "healthy" },
      }),
    );
    const r = await run("Come siamo messi oggi?");
    expect(r.intent).toBe("operational_brief");
    expect(mockRoute).not.toHaveBeenCalled();
    expect(r.llm).toBeUndefined();
  });
});
