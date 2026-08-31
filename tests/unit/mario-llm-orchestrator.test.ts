import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpContext } from "@/lib/mcp/context";

const mockGetTool = vi.fn();
const mockRunTool = vi.fn();
const mockRouteMarioWithLlm = vi.fn();

vi.mock("@/lib/mcp/registry", () => ({
  getTool: (...args: unknown[]) => mockGetTool(...args),
  // buildMarioToolCatalog (tool-catalog.ts) chiama listTools(): il contenuto
  // esatto non conta per questi test (il tool_name arriva gia' deciso dal
  // routeMarioWithLlm mockato sotto), basta non far esplodere l'introspezione.
  listTools: () => [],
}));
vi.mock("@/lib/mcp/server", () => ({
  runTool: (...args: unknown[]) => mockRunTool(...args),
}));
vi.mock("@/lib/server/mario-assistant/llm-router", () => ({
  routeMarioWithLlm: (...args: unknown[]) => mockRouteMarioWithLlm(...args),
}));

function makeContext(overrides: Partial<McpContext> = {}): McpContext {
  return {
    requestId: "req-1",
    userId: "user-1",
    userEmail: "test@example.com",
    tenantId: "tenant-a",
    role: "operator",
    admin: {} as McpContext["admin"],
    ...overrides,
  };
}

function successResult(output: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
}

function errorResult(code: string, message: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code, message }) }] };
}

function fallback() {
  return { decision: { action: "fallback" as const }, usage: null, fallbackUsed: true, fallbackReason: "invalid_json" as const, latencyMs: 5 };
}

describe("runMarioAssistant — FASE A LLM router integration", () => {
  beforeEach(async () => {
    mockGetTool.mockReset();
    mockRunTool.mockReset();
    mockRouteMarioWithLlm.mockReset();
    // FASE A.1 — forza il fallback in-memory (nessun Redis) in modo
    // deterministico, indipendente dalle env dell'ambiente di test.
    const { __setSharedRedisForTests } = await import("@/lib/server/redis");
    __setSharedRedisForTests(null);
    const { __resetMarioSessionsForTests } = await import("@/lib/server/mario-assistant/session-context");
    __resetMarioSessionsForTests();
  });

  afterEach(async () => {
    const { __setSharedRedisForTests } = await import("@/lib/server/redis");
    __setSharedRedisForTests(undefined);
    // vi.stubEnv/unstubAllEnvs (non process.env diretto): garantisce che una
    // mutazione env di questo file non sopravviva ne' contamini altri file di
    // test eseguiti nello stesso worker/thread di vitest.
    vi.unstubAllEnvs();
  });

  it("§27 feature flag OFF (default): il router LLM non viene MAI chiamato per un messaggio non supportato", async () => {
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "fammi il pullman del CRAL Poste per 46 persone", new Date());
    expect(mockRouteMarioWithLlm).not.toHaveBeenCalled();
    expect(result.intent).toBe("unsupported");
  });

  it("§28 shadow mode: chiama il router per loggare, ma la risposta resta quella statica invariata", async () => {
    vi.stubEnv("MARIO_LLM_SHADOW_MODE", "true");
    mockRouteMarioWithLlm.mockResolvedValue(fallback());
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "che tempo fa domani?", new Date());
    expect(mockRouteMarioWithLlm).toHaveBeenCalledTimes(1);
    expect(result.intent).toBe("unsupported");
    expect(mockRunTool).not.toHaveBeenCalled();
  });

  it("§14 fallback: se il router restituisce fallback, l'orchestratore ricade sul messaggio statico esistente (write_unsupported)", async () => {
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
    mockRouteMarioWithLlm.mockResolvedValue(fallback());
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "Assegna Mario Rossi al servizio X", new Date());
    expect(result.intent).toBe("write_unsupported");
    expect(mockRunTool).not.toHaveBeenCalled();
  });

  it("§9 clarification: il router chiede il pax mancante, la risposta la inoltra senza chiamare alcun tool WRITE", async () => {
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
    mockRouteMarioWithLlm.mockResolvedValue({
      decision: { action: "clarification", clarification_question: "Quanti passeggeri devo prevedere per il gruppo Natività?" },
      usage: { inputTokens: 20, outputTokens: 10 },
      fallbackUsed: false,
      latencyMs: 100,
    });
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "Creami un bus Natività", new Date());
    expect(result.answer).toBe("Quanti passeggeri devo prevedere per il gruppo Natività?");
    expect(mockRunTool).not.toHaveBeenCalled();
  });

  it("§7/§11 tool_call su preview_create_booking_group: esegue SOLO la preview, la risposta finisce con 'Confermi?' senza il token", async () => {
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
    mockRouteMarioWithLlm.mockResolvedValue({
      decision: { action: "tool_call", tool_name: "its.preview_create_booking_group", arguments: { name: "Natività", expectedPax: 50 }, confidence: 0.9 },
      usage: { inputTokens: 30, outputTokens: 15 },
      fallbackUsed: false,
      latencyMs: 120,
    });
    mockGetTool.mockReturnValue({ name: "its.preview_create_booking_group" });
    mockRunTool.mockResolvedValue(
      successResult({ name: "Natività", expected_pax: 50, kind: "bus_group", service_date: null, service_date_label: null, ferry: null, confirmationToken: "SEGRETO.abc", expiresAt: "2026-09-12T00:00:00Z" }),
    );

    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    // FASE A.4: "gruppo" generico (non "bus") → nessuna data richiesta, la
    // preview procede. Per un bus senza data la policy chiederebbe la data (§30).
    const result = await runMarioAssistant(makeContext(), "creami un gruppo Natività con 50 persone", new Date());

    expect(mockRunTool).toHaveBeenCalledTimes(1);
    expect(mockRunTool.mock.calls[0]?.[2]).toEqual({ name: "Natività", expectedPax: 50 });
    expect(result.answer).toMatch(/Confermi\?$/);
    expect(result.answer).not.toContain("SEGRETO");

    const { getMarioSession } = await import("@/lib/server/mario-assistant/session-context");
    const session = await getMarioSession("tenant-a", "user-1");
    expect(session.pendingConfirmation?.toolName).toBe("its.create_booking_group");
    expect(session.pendingConfirmation?.confirmationToken).toBe("SEGRETO.abc");
  });

  it("§11 conferma 'sì': esegue its.create_booking_group con SOLO { confirmationToken }, mai ricostruendo il payload", async () => {
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
    const { updateMarioSession } = await import("@/lib/server/mario-assistant/session-context");
    await updateMarioSession("tenant-a", "user-1", {
      pendingConfirmation: { toolName: "its.create_booking_group", confirmationToken: "SEGRETO.abc", op: "its.preview_create_booking_group", createdAt: Date.now() },
    });
    mockGetTool.mockReturnValue({ name: "its.create_booking_group" });
    mockRunTool.mockResolvedValue(successResult({ bookingGroupId: "g-new-1", name: "Natività", status: "to_complete" }));

    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "sì, confermo", new Date());

    expect(mockRunTool).toHaveBeenCalledWith(expect.anything(), { name: "its.create_booking_group" }, { confirmationToken: "SEGRETO.abc" });
    expect(result.intent).toBe("mario_llm_confirmed");
    expect(mockRouteMarioWithLlm).not.toHaveBeenCalled();

    const { getMarioSession } = await import("@/lib/server/mario-assistant/session-context");
    const session = await getMarioSession("tenant-a", "user-1");
    expect(session.pendingConfirmation).toBeUndefined();
    expect(session.lastBookingGroupId).toBe("g-new-1");
  });

  it("§12 conferma 'no': annulla, nessuna scrittura, pendingConfirmation svuotato", async () => {
    const { updateMarioSession, getMarioSession } = await import("@/lib/server/mario-assistant/session-context");
    await updateMarioSession("tenant-a", "user-1", {
      pendingConfirmation: { toolName: "its.create_booking_group", confirmationToken: "SEGRETO.abc", op: "its.preview_create_booking_group", createdAt: Date.now() },
    });
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "no, lascia perdere", new Date());
    expect(mockRunTool).not.toHaveBeenCalled();
    expect(result.intent).toBe("confirmation_cancelled");
    expect((await getMarioSession("tenant-a", "user-1")).pendingConfirmation).toBeUndefined();
  });

  it("una risposta non riconosciuta con conferma in sospeso NON esegue la scrittura e scarta la conferma", async () => {
    const { updateMarioSession, getMarioSession } = await import("@/lib/server/mario-assistant/session-context");
    await updateMarioSession("tenant-a", "user-1", {
      pendingConfirmation: { toolName: "its.create_booking_group", confirmationToken: "SEGRETO.abc", op: "its.preview_create_booking_group", createdAt: Date.now() },
    });
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    await runMarioAssistant(makeContext(), "che tempo fa domani?", new Date());
    expect(mockRunTool).not.toHaveBeenCalled();
    expect((await getMarioSession("tenant-a", "user-1")).pendingConfirmation).toBeUndefined();
  });

  it("§8 multi-step: find_booking_group univoco prosegue nello stesso turno fino a preview_add_booking_group_stop", async () => {
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
    mockRouteMarioWithLlm
      .mockResolvedValueOnce({
        decision: { action: "tool_call", tool_name: "its.find_booking_group", arguments: { query: "Natività" }, confidence: 0.9 },
        usage: null, fallbackUsed: false, latencyMs: 50,
      })
      .mockResolvedValueOnce({
        decision: { action: "tool_call", tool_name: "its.preview_add_booking_group_stop", arguments: { bookingGroupId: "g1", city: "Tivoli", pickupPoint: "Villa d'Este", expectedPax: 20, direction: "arrival" }, confidence: 0.85 },
        usage: null, fallbackUsed: false, latencyMs: 50,
      });
    mockGetTool.mockImplementation((name: string) => ({ name }));
    mockRunTool.mockImplementation((_ctx: unknown, tool: { name: string }) => {
      if (tool.name === "its.find_booking_group") {
        return Promise.resolve(successResult({ strategy: "exact", ambiguous: false, count: 1, matches: [{ id: "g1", name: "Parrocchia Natività", expected_pax: 50, kind: "bus_exclusive", status: "stops_defined", service_date: "2026-09-12", service_date_label: "12/09/2026" }] }));
      }
      if (tool.name === "its.preview_add_booking_group_stop") {
        return Promise.resolve(successResult({ booking_group_id: "g1", group_name: "Parrocchia Natività", city: "Tivoli", pickup_point: "Villa d'Este", expected_pax: 20, direction: "arrival", planned_pax_before: 0, planned_pax_after: 20, group_expected_pax: 50, warnings: [], confirmationToken: "TOKEN2.xyz", expiresAt: "2026-09-12T00:00:00Z" }));
      }
      return Promise.resolve(errorResult("MCP_NOT_FOUND", "n/a"));
    });

    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "nel bus Natività metti 20 persone a Tivoli, punto di carico Villa d'Este", new Date());

    expect(mockRouteMarioWithLlm).toHaveBeenCalledTimes(2);
    expect(mockRunTool).toHaveBeenCalledTimes(2);
    expect(result.answer).toMatch(/Tivoli/);
    expect(result.answer).toMatch(/Confermi\?$/);
    expect(result.answer).not.toContain("TOKEN2");
  });

  it("§7 find_booking_group ambiguo interrompe il loop con una clarification (mai una scelta arbitraria)", async () => {
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
    mockRouteMarioWithLlm.mockResolvedValue({
      decision: { action: "tool_call", tool_name: "its.find_booking_group", arguments: { query: "Natività" }, confidence: 0.9 },
      usage: null, fallbackUsed: false, latencyMs: 50,
    });
    mockGetTool.mockReturnValue({ name: "its.find_booking_group" });
    mockRunTool.mockResolvedValue(
      successResult({ strategy: "exact", ambiguous: true, count: 2, matches: [
        { id: "gA", name: "Parrocchia Natività", expected_pax: 50, status: "to_complete", service_date_label: "12/09/2026" },
        { id: "gB", name: "Parrocchia Natività", expected_pax: 40, status: "draft", service_date_label: "05/10/2026" },
      ] }),
    );
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "nel bus Natività metti 20 persone a Tivoli", new Date());
    expect(result.answer).toMatch(/Quale intendi/i);
    expect(mockRunTool).toHaveBeenCalledTimes(1); // niente secondo step: l'ambiguità blocca la catena
  });

  it("§16 il loop si arresta dopo il numero massimo di step e ricade sul fallback statico", async () => {
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
    vi.stubEnv("MARIO_LLM_MAX_STEPS", "2");
    mockRouteMarioWithLlm.mockResolvedValue({
      decision: { action: "tool_call", tool_name: "its.find_booking_group", arguments: { query: "Natività" }, confidence: 0.9 },
      usage: null, fallbackUsed: false, latencyMs: 50,
    });
    mockGetTool.mockReturnValue({ name: "its.find_booking_group" });
    mockRunTool.mockResolvedValue(
      successResult({ strategy: "exact", ambiguous: false, count: 1, matches: [{ id: "g1", name: "Natività", expected_pax: 50, kind: "bus_group", status: "stops_defined", service_date: null }] }),
    );
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "nel bus Natività fai qualcosa di generico", new Date());
    expect(mockRouteMarioWithLlm).toHaveBeenCalledTimes(2);
    expect(result.intent).toBe("unsupported");
  });

  it("§19 difesa: un confirmationToken 'suggerito' dal modello negli argomenti viene sempre ignorato prima di chiamare runTool", async () => {
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
    mockRouteMarioWithLlm.mockResolvedValue({
      decision: { action: "tool_call", tool_name: "its.find_booking_group", arguments: { query: "Natività", confirmationToken: "FORGIATO.xyz" }, confidence: 0.9 },
      usage: null, fallbackUsed: false, latencyMs: 50,
    });
    mockGetTool.mockReturnValue({ name: "its.find_booking_group" });
    mockRunTool.mockResolvedValue(successResult({ strategy: "exact", ambiguous: false, count: 0, matches: [] }));
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    await runMarioAssistant(makeContext(), "trova Natività", new Date());
    expect(mockRunTool.mock.calls[0]?.[2]).toEqual({ query: "Natività" });
  });

  it("§17 il tool eseguito fallisce (es. permessi negati da runTool) -> risposta leggibile, mai l'errore grezzo", async () => {
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
    mockRouteMarioWithLlm.mockResolvedValue({
      decision: { action: "tool_call", tool_name: "its.find_booking_group", arguments: { query: "Natività" }, confidence: 0.9 },
      usage: null, fallbackUsed: false, latencyMs: 50,
    });
    mockGetTool.mockReturnValue({ name: "its.find_booking_group" });
    mockRunTool.mockResolvedValue(errorResult("MCP_FORBIDDEN", "Ruolo non autorizzato"));
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "trova Natività", new Date());
    expect(result.answer).not.toContain("MCP_FORBIDDEN");
  });
});
