/**
 * FASE A.1 §12 — flusso 5 turni end-to-end con session store CONDIVISO, dove
 * OGNI turno è servito da un'"istanza" diversa (vi.resetModules tra un turno e
 * l'altro: il modulo orchestrator / session-context viene ricreato da zero,
 * solo il fake redis in scope di test sopravvive).
 *
 * Verifica che:
 *  - dopo la conferma di creazione il booking_group_id finisce nello store;
 *  - i turni 3 e 5 ("20 a Tivoli", "gli altri 30 a Guidonia") vedono ANCORA lo
 *    stesso booking_group_id nel contesto passato al router;
 *  - nessun nuovo gruppo viene creato dopo il primo.
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
  requestId: "req",
  userId: "user-1",
  userEmail: "op@example.com",
  tenantId: "tenant-a",
  role: "operator",
  admin: {} as McpContext["admin"],
};

const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });

let fake: FakeUpstashRedis;

beforeEach(() => {
  vi.stubEnv("MARIO_LLM_ENABLED", "true");
  fake = new FakeUpstashRedis();
  mockGetTool.mockReset();
  mockRunTool.mockReset();
  mockRoute.mockReset();
  mockGetTool.mockImplementation((name: string) => ({ name }));
  // Default: fallback statico (nessun tool). I turni "utili" usano
  // mockResolvedValueOnce; i turni di sola conferma non chiamano il router.
  mockRoute.mockResolvedValue({
    decision: { action: "fallback" as const },
    usage: null,
    fallbackUsed: true,
    fallbackReason: "invalid_json" as const,
    latencyMs: 1,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Un turno. Lo stato NON vive in variabili di modulo: tra un turno e l'altro
 *  passa solo per il fake redis condiviso (come tra due istanze serverless).
 *  La prova "nessuna dipendenza da stato module-level" è in
 *  mario-session-context.test.ts §11 (lì si fa vi.resetModules per turno). */
async function turn(message: string) {
  const redisMod = await import("@/lib/server/redis");
  redisMod.__setSharedRedisForTests(fake as unknown as Redis);
  const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
  return runMarioAssistant(CTX, message, new Date("2026-09-01T09:00:00Z"));
}

function routeToolCall(tool_name: string, args: Record<string, unknown>) {
  return {
    decision: { action: "tool_call" as const, tool_name, arguments: args, confidence: 0.9 },
    usage: null,
    fallbackUsed: false,
    latencyMs: 10,
  };
}

/** L'ultimo `sessionSummary` ricevuto dal router. */
function lastSummary() {
  const call = mockRoute.mock.calls.at(-1);
  return (call?.[0] as { sessionSummary: Record<string, unknown> }).sessionSummary;
}

describe("FASE A.1 §12 — 5 turni, store condiviso, istanze diverse", () => {
  it("crea Natività 50 → Tivoli 20 → Guidonia 30 sullo stesso booking_group_id", async () => {
    // ── Turno 1: "creami Natività da 50 pax" → preview create ────────────────
    mockRoute.mockResolvedValueOnce(routeToolCall("its.preview_create_booking_group", { name: "Natività", expectedPax: 50 }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "Natività", expected_pax: 50, confirmationToken: "TOK1", expiresAt: "2026-09-01T09:03:00Z" }));
    const r1 = await turn("creami Natività da 50 pax");
    expect(r1.answer).toMatch(/Confermi\?$/);
    expect(r1.answer).not.toContain("TOK1");

    // ── Turno 2: "confermo" → create_booking_group, id nello store ───────────
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG-1", name: "Natività", status: "to_complete" }));
    const r2 = await turn("confermo");
    expect(r2.intent).toBe("mario_llm_confirmed");
    expect(mockRunTool).toHaveBeenLastCalledWith(expect.anything(), { name: "its.create_booking_group" }, { confirmationToken: "TOK1" });

    // ── Turno 3: "20 a Tivoli" → il router vede lastBookingGroupId = BG-1 ────
    mockRoute.mockResolvedValueOnce(routeToolCall("its.preview_add_booking_group_stop", { bookingGroupId: "BG-1", city: "Tivoli", pickupPoint: "Villa d'Este", expectedPax: 20, direction: "arrival" }));
    mockRunTool.mockResolvedValueOnce(ok({ booking_group_id: "BG-1", group_name: "Natività", city: "Tivoli", pickup_point: "Villa d'Este", expected_pax: 20, confirmationToken: "TOK2", expiresAt: "2026-09-01T09:06:00Z" }));
    const r3 = await turn("20 salgono a Tivoli, punto di carico Villa d'Este");
    expect(lastSummary().lastBookingGroupId).toBe("BG-1");
    expect(r3.answer).toMatch(/Tivoli/);
    expect(r3.answer).toMatch(/Confermi\?$/);

    // ── Turno 4: "confermo" → add_booking_group_stop TOK2 ───────────────────
    mockRunTool.mockResolvedValueOnce(ok({ bookingGroupId: "BG-1", city: "Tivoli" }));
    const r4 = await turn("confermo");
    expect(r4.intent).toBe("mario_llm_confirmed");
    expect(mockRunTool).toHaveBeenLastCalledWith(expect.anything(), { name: "its.add_booking_group_stop" }, { confirmationToken: "TOK2" });

    // ── Turno 5: "gli altri 30 a Guidonia" → ANCORA BG-1 nel contesto ───────
    mockRoute.mockResolvedValueOnce(routeToolCall("its.preview_add_booking_group_stop", { bookingGroupId: "BG-1", city: "Guidonia", expectedPax: 30, direction: "arrival" }));
    mockRunTool.mockResolvedValueOnce(ok({ booking_group_id: "BG-1", group_name: "Natività", city: "Guidonia", expected_pax: 30, confirmationToken: "TOK3", expiresAt: "2026-09-01T09:09:00Z" }));
    const r5 = await turn("gli altri 30 a Guidonia");
    expect(lastSummary().lastBookingGroupId).toBe("BG-1");
    expect(r5.answer).toMatch(/Guidonia/);
    expect(r5.answer).toMatch(/Confermi\?$/);

    // ── Nessun secondo gruppo creato: create_booking_group chiamato 1 volta ─
    const createCalls = mockRunTool.mock.calls.filter((c) => (c[1] as { name?: string })?.name === "its.create_booking_group");
    expect(createCalls).toHaveLength(1);
    // Il router è stato interrogato solo per i 3 turni non-conferma.
    expect(mockRoute.mock.calls).toHaveLength(3);
  });

  it("§13 conferma scaduta: >180s dopo la preview, 'confermo' non esegue nulla", async () => {
    let clock = new Date("2026-09-01T09:00:00Z").getTime();
    fake = new FakeUpstashRedis({ now: () => clock });
    vi.useFakeTimers();
    vi.setSystemTime(clock);

    mockRoute.mockResolvedValueOnce(routeToolCall("its.preview_create_booking_group", { name: "Natività", expectedPax: 50 }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "Natività", expected_pax: 50, confirmationToken: "TOKX", expiresAt: "2026-09-01T09:03:00Z" }));
    await turn("creami Natività da 50 pax");

    clock += 185_000; // oltre il TTL di 180s
    vi.setSystemTime(clock);

    const rr = await turn("confermo");
    expect(mockRunTool).toHaveBeenCalledTimes(1); // solo la preview del primo turno, nessun WRITE
    expect(rr.intent).toBe("confirmation_expired");
    expect(rr.answer).toMatch(/scaduta/i);
    vi.useRealTimers();
  });
});
