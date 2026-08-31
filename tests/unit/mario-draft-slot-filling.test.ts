/**
 * FASE A.3 §11–§15 — slot filling conversazionale: il draft operativo tiene
 * intento e campi già raccolti attraverso una richiesta incompleta.
 * Orchestrator reale, router + runTool mockati, session store = fake Upstash.
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
const NOW = new Date("2026-09-01T09:00:00Z");

const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const clarification = (question: string, operation?: unknown) => ({
  decision: { action: "clarification" as const, clarification_question: question, confidence: 0.9, ...(operation ? { operation } : {}) },
  usage: { inputTokens: 1000, outputTokens: 60 },
  fallbackUsed: false,
  latencyMs: 10,
});
const toolCall = (tool_name: string, args: Record<string, unknown>) => ({
  decision: { action: "tool_call" as const, tool_name, arguments: args, confidence: 0.95 },
  usage: { inputTokens: 1100, outputTokens: 80 },
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
function lastRouteSummary() {
  const call = mockRoute.mock.calls.at(-1);
  return (call?.[0] as { sessionSummary: { draftOperation?: { collected: Record<string, unknown> } } }).sessionSummary;
}

describe("§11 TEST A — La Marra: chiede solo la data, poi crea", () => {
  it("turno 2 '13 settembre' completa il draft deterministicamente (no LLM) e preview con nome+pax+data", async () => {
    mockRoute.mockResolvedValueOnce(
      clarification("Per il bus di Lucia La Marra: qual è la data del servizio?", {
        type: "create_booking_group",
        collected: { name: "Lucia La Marra", expectedPax: 50, origin: "Rimini" },
        missing: ["serviceDate"],
      }),
    );
    const r1 = await run("Puoi crearmi un bus esclusivo di 50 persone per Lucia La Marra con partenza da Rimini?");
    expect(r1.intent).toBe("mario_llm_clarification");
    const d1 = await readDraft();
    expect(d1?.collected).toMatchObject({ name: "Lucia La Marra", expectedPax: 50, origin: "Rimini" });
    expect(d1?.missing).toEqual(["serviceDate"]);

    mockRunTool.mockResolvedValueOnce(
      ok({ name: "Lucia La Marra", expected_pax: 50, service_date: "2026-09-13", service_date_label: "13/09/2026", confirmationToken: "TOKD", expiresAt: "2026-09-01T09:03:00Z" }),
    );
    const r2 = await run("13 settembre");

    expect(mockRoute).toHaveBeenCalledTimes(1); // solo il turno 1
    expect(r2.intent).toBe("mario_llm_pending_confirmation");
    expect(r2.answer).toMatch(/Lucia La Marra/);
    expect(r2.answer).toMatch(/50 pax/);
    // FIX A.4.4 §10/§15 — DD-MM-YYYY, mai lo slash del formatter ITS condiviso.
    expect(r2.answer).toMatch(/13-09-2026/);
    expect(r2.answer).not.toMatch(/13\/09\/2026/);
    expect(r2.answer).toMatch(/Confermi\?$/);
    expect(r2.llm).toBeUndefined(); // §17 — nessun costo LLM per il completamento

    const args = mockRunTool.mock.calls[0]![2] as Record<string, unknown>;
    // §28 — tool argument builder: name+pax+data, kind forzato "bus_exclusive"
    // ("bus esclusivo" nel testo), MAI `origin` (§6/§33).
    expect(args).toMatchObject({ name: "Lucia La Marra", expectedPax: 50, serviceDate: "2026-09-13", kind: "bus_exclusive" });
    expect(args).not.toHaveProperty("origin");
  });
});

describe("§12 TEST correzione — 40 → 45", () => {
  it("'anzi 45' dopo la preview ri-preview con 45, stessa operazione", async () => {
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "Roma", expectedPax: 40, serviceDate: "2026-09-20" }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "Roma", expected_pax: 40, service_date_label: "20/09/2026", confirmationToken: "TOK40", expiresAt: "2026-09-01T09:03:00Z" }));
    const r1 = await run("Creami gruppo Roma da 40 persone per il 20 settembre");
    expect(r1.intent).toBe("mario_llm_pending_confirmation");
    expect((await readDraft())?.collected).toMatchObject({ name: "Roma", expectedPax: 40, serviceDate: "2026-09-20" });

    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "Roma", expectedPax: 45, serviceDate: "2026-09-20" }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "Roma", expected_pax: 45, service_date_label: "20/09/2026", confirmationToken: "TOK45", expiresAt: "2026-09-01T09:06:00Z" }));
    const r2 = await run("anzi 45");

    expect(lastRouteSummary().draftOperation?.collected).toMatchObject({ name: "Roma", expectedPax: 40 });
    expect(r2.answer).toMatch(/45 pax/);
    expect(r2.answer).not.toMatch(/40 pax/);
    expect(mockRunTool.mock.calls.every((c) => (c[1] as { name?: string })?.name !== "its.find_booking_group")).toBe(true);
  });
});

describe("§13 TEST campo parziale", () => {
  it("'Creami un gruppo' → nome → pax → preview", async () => {
    mockRoute.mockResolvedValueOnce(
      clarification("Come si chiama il gruppo e quante persone?", { type: "create_booking_group", collected: {}, missing: ["name", "expectedPax"] }),
    );
    await run("Creami un gruppo");
    expect((await readDraft())?.missing).toEqual(["name", "expectedPax"]);

    mockRoute.mockResolvedValueOnce(
      clarification("Quante persone?", { type: "create_booking_group", collected: { name: "La Marra" }, missing: ["expectedPax"] }),
    );
    const r2 = await run("La Marra");
    expect(r2.intent).toBe("mario_llm_clarification");
    expect((await readDraft())?.collected).toMatchObject({ name: "La Marra" });

    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 50 }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "La Marra", expected_pax: 50, confirmationToken: "TOKP", expiresAt: "2026-09-01T09:03:00Z" }));
    const r3 = await run("50");
    expect(r3.intent).toBe("mario_llm_pending_confirmation");
    expect(r3.answer).toMatch(/La Marra/);
    expect(r3.answer).toMatch(/50 pax/);
    expect(lastRouteSummary().draftOperation?.collected).toMatchObject({ name: "La Marra" });
  });
});

describe("§14 TEST no misrouting", () => {
  it("con draft attivo, 'NOME GRUPPO LA MARRA PAX 50' completa il draft, NON find_booking_group", async () => {
    mockRoute.mockResolvedValueOnce(
      clarification("Come si chiama e quante persone?", { type: "create_booking_group", collected: {}, missing: ["name", "expectedPax"] }),
    );
    await run("Creami un gruppo");

    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 50 }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "La Marra", expected_pax: 50, confirmationToken: "TOKN", expiresAt: "2026-09-01T09:03:00Z" }));
    const r = await run("NOME GRUPPO LA MARRA PAX 50");

    expect(r.intent).toBe("mario_llm_pending_confirmation");
    expect(mockRunTool.mock.calls.every((c) => (c[1] as { name?: string })?.name !== "its.find_booking_group")).toBe(true);
    expect(lastRouteSummary().draftOperation).toBeTruthy();
  });
});

describe("§8 reset draft", () => {
  it("'lascia stare' cancella l'operazione in corso", async () => {
    mockRoute.mockResolvedValueOnce(
      clarification("Quante persone?", { type: "create_booking_group", collected: { name: "La Marra" }, missing: ["expectedPax"] }),
    );
    await run("Creami un gruppo La Marra");
    expect(await readDraft()).not.toBeNull();

    const r = await run("lascia stare");
    expect(r.intent).toBe("operation_cancelled");
    expect(await readDraft()).toBeNull();
    expect(mockRoute).toHaveBeenCalledTimes(1);
  });
});

describe("FIX A.4.2/A.4.3 §10/§3 — clarification SENZA operation su un messaggio operativo (bug live)", () => {
  it("'Possiamo caricare un bus di 50 persone con partenza da Rimini gruppo La Marra?' -> draft con name+expectedPax+origin, turno 2 preview diretta senza LLM", async () => {
    mockRoute.mockResolvedValueOnce(clarification("Per quale data?")); // nessun `operation`, come nel bug live
    const r1 = await run("Possiamo caricare un bus di 50 persone con partenza da Rimini gruppo La Marra?");
    expect(r1.intent).toBe("mario_llm_clarification");

    const d1 = await readDraft();
    expect(d1).not.toBeNull();
    expect(d1?.type).toBe("create_bus_group");
    // FIX A.4.3 — pax/origin evidenti recuperati deterministicamente, non solo il nome.
    expect(d1?.collected).toMatchObject({ name: expect.stringMatching(/la marra/i), expectedPax: 50, origin: "Rimini" });
    expect(d1?.missing).toEqual(["serviceDate"]);

    // turno 2: solo la data manca -> tryDeterministicDraftFill completa il
    // draft SENZA una seconda chiamata LLM, preview diretta (§3 spec A.4.3).
    mockRunTool.mockResolvedValueOnce(
      ok({ name: "La Marra", expected_pax: 50, service_date: "2026-09-13", service_date_label: "13/09/2026", confirmationToken: "TOKR", expiresAt: "2026-09-01T09:03:00Z" }),
    );
    const r2 = await run("13 settembre");
    expect(mockRoute).toHaveBeenCalledTimes(1); // nessuna seconda chiamata LLM
    expect(r2.intent).toBe("mario_llm_pending_confirmation");
    expect(r2.answer).toMatch(/La Marra/);
    expect(r2.answer).toMatch(/50 pax/);
    // FIX A.4.4 §10 — DD-MM-YYYY, mai lo slash del formatter ITS condiviso.
    expect(r2.answer).toMatch(/13-09-2026/);
    expect(r2.answer).not.toMatch(/13\/09\/2026/);
    expect(r2.answer).toMatch(/Confermi\?$/);
    expect(r2.llm).toBeUndefined();
  });
});

describe("FIX A.4.2 §11 — clarification CON operation: draft salvato, turno 2 senza LLM", () => {
  it("operation strutturata nel primo turno -> preview diretta al turno 2, zero chiamate LLM", async () => {
    mockRoute.mockResolvedValueOnce(
      clarification("Per quale data?", {
        type: "create_bus_group",
        collected: { name: "La Marra", expectedPax: 50, origin: "Rimini" },
        missing: ["serviceDate"],
      }),
    );
    const r1 = await run("Possiamo caricare un bus di 50 persone con partenza da Rimini gruppo La Marra?");
    expect(r1.intent).toBe("mario_llm_clarification");
    const d1 = await readDraft();
    expect(d1?.collected).toMatchObject({ name: "La Marra", expectedPax: 50, origin: "Rimini" });
    expect(d1?.missing).toEqual(["serviceDate"]);

    mockRunTool.mockResolvedValueOnce(
      ok({ name: "La Marra", expected_pax: 50, service_date_label: "13/09/2026", confirmationToken: "TOKE", expiresAt: "2026-09-01T09:03:00Z" }),
    );
    const r2 = await run("13 settembre");
    expect(mockRoute).toHaveBeenCalledTimes(1); // nessuna seconda chiamata LLM
    expect(r2.intent).toBe("mario_llm_pending_confirmation");
    expect(r2.llm).toBeUndefined();
  });
});

describe("FIX A.4.4 §5/§6/§16 — data ESPLICITA nel messaggio vince su un serviceDate allucinato dall'LLM", () => {
  it("il router propone accidentalmente 2025-01-15 ma il messaggio contiene '13/09/2026' esplicito: vince la data esplicita", async () => {
    mockRoute.mockResolvedValueOnce(
      toolCall("its.preview_create_booking_group", {
        name: "La Marra",
        expectedPax: 50,
        serviceDate: "2025-01-15", // allucinazione simulata del router
      }),
    );
    mockRunTool.mockResolvedValueOnce(
      ok({ name: "La Marra", expected_pax: 50, service_date: "2026-09-13", service_date_label: "13/09/2026", confirmationToken: "TOKX", expiresAt: "2026-09-01T09:03:00Z" }),
    );
    const r = await run("Creami un bus La Marra da 50 persone per il 13/09/2026");
    expect(r.intent).toBe("mario_llm_pending_confirmation");

    const args = mockRunTool.mock.calls[0]![2] as Record<string, unknown>;
    expect(args.serviceDate).toBe("2026-09-13"); // MAI 2025-01-15
    expect(r.answer).toMatch(/13-09-2026/);
    expect(r.answer).not.toMatch(/2025-01-15|15-01-2025/);
  });
});

describe("FIX A.4.4 §17 — sessione stale: una nuova data esplicita sostituisce SEMPRE quella vecchia nel draft", () => {
  it("draft con serviceDate stale (2025-01-15), nuovo messaggio '13/09/2026' esplicito → completamento deterministico con 2026-09-13, mai lo stale", async () => {
    // Draft già completo salvo la data, ma con una data STALE da una sessione
    // precedente: simula esattamente §17 dello spec (mai riuso di una data vecchia).
    const { setMarioDraftOperation } = await import("@/lib/server/mario-assistant/session-context");
    await setMarioDraftOperation("tenant-a", "user-1", {
      type: "create_bus_group",
      collected: { name: "La Marra", expectedPax: 50, serviceDate: "2025-01-15" },
      missing: [],
    });

    mockRunTool.mockResolvedValueOnce(
      ok({ name: "La Marra", expected_pax: 50, service_date: "2026-09-13", service_date_label: "13/09/2026", confirmationToken: "TOKS", expiresAt: "2026-09-01T09:03:00Z" }),
    );
    const r1 = await run("13/09/2026");

    expect(mockRoute).not.toHaveBeenCalled(); // fast-path deterministico, zero LLM
    expect(r1.intent).toBe("mario_llm_pending_confirmation");
    const args = mockRunTool.mock.calls[0]![2] as Record<string, unknown>;
    expect(args.serviceDate).toBe("2026-09-13"); // MAI 2025-01-15 (lo stale)
    expect(r1.answer).toMatch(/13-09-2026/);
    expect(r1.answer).not.toMatch(/2025-01-15|15-01-2025/);
  });
});

describe("§15 TEST continuità Redis (due istanze)", () => {
  it("istanza A salva il draft, istanza B (modulo ricreato) lo recupera e completa", async () => {
    mockRoute.mockResolvedValueOnce(
      clarification("Qual è la data?", { type: "create_booking_group", collected: { name: "La Marra", expectedPax: 50 }, missing: ["serviceDate"] }),
    );
    await run("Creami un bus La Marra da 50 persone");

    vi.resetModules();
    const freshRedis = await import("@/lib/server/redis");
    freshRedis.__setSharedRedisForTests(fake as unknown as Redis);
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");

    mockRunTool.mockResolvedValueOnce(
      ok({ name: "La Marra", expected_pax: 50, service_date: "2026-09-13", service_date_label: "13/09/2026", confirmationToken: "TOKB", expiresAt: "2026-09-01T09:03:00Z" }),
    );
    const r = await runMarioAssistant(CTX, "13 settembre", NOW);
    expect(r.intent).toBe("mario_llm_pending_confirmation");
    expect(r.answer).toMatch(/La Marra/);
    expect(r.answer).toMatch(/13-09-2026/);
  });
});
