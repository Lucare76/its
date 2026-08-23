import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpContext } from "@/lib/mcp/context";

const mockGetTool = vi.fn();
const mockRunTool = vi.fn();

vi.mock("@/lib/mcp/registry", () => ({
  getTool: (...args: unknown[]) => mockGetTool(...args),
}));
vi.mock("@/lib/mcp/server", () => ({
  runTool: (...args: unknown[]) => mockRunTool(...args),
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

describe("runMarioAssistant", () => {
  beforeEach(() => {
    mockGetTool.mockReset();
    mockRunTool.mockReset();
  });

  it("16. il client NON può selezionare il tool: l'intent 'operational_brief' chiama SEMPRE its.get_operational_brief, mai un nome arbitrario", async () => {
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    mockGetTool.mockReturnValue({ name: "its.get_operational_brief" });
    mockRunTool.mockResolvedValue(
      successResult({
        date: "2026-08-23",
        summary: { total_services: 1, upcoming_services: 1, unassigned_services: 0, active_services: 0 },
        critical_items: [],
        warnings: [],
        health: { available: true, overall: "healthy" },
      })
    );

    await runMarioAssistant(makeContext(), "come siamo messi oggi", new Date("2026-08-23T10:00:00.000Z"));

    expect(mockGetTool).toHaveBeenCalledWith("its.get_operational_brief");
  });

  it("unsupported: non chiama alcun tool, restituisce il messaggio fisso", async () => {
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "che tempo fa domani?", new Date());
    expect(result.intent).toBe("unsupported");
    expect(mockRunTool).not.toHaveBeenCalled();
  });

  it("write_unsupported: non chiama alcun tool, restituisce il messaggio di rifiuto WRITE", async () => {
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    const result = await runMarioAssistant(makeContext(), "Assegna Mario Rossi al servizio X", new Date());
    expect(result.intent).toBe("write_unsupported");
    expect(result.answer).toContain("flusso di conferma MCP");
    expect(mockRunTool).not.toHaveBeenCalled();
  });

  it("17. tool fallito -> risposta leggibile, mai il codice/messaggio McpError grezzo", async () => {
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    mockGetTool.mockReturnValue({ name: "its.get_health_status" });
    mockRunTool.mockResolvedValue(errorResult("MCP_INTERNAL_ERROR", "Errore interno del server MCP."));

    const result = await runMarioAssistant(makeContext(), "ITS sta funzionando bene?", new Date());
    expect(result.answer).not.toContain("MCP_INTERNAL_ERROR");
    expect(result.answer).toContain("non riesco a leggere");
  });

  it("passa il McpContext (tenant/ruolo risolti server-side) invariato a runTool", async () => {
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    mockGetTool.mockReturnValue({ name: "its.get_health_status" });
    mockRunTool.mockResolvedValue(
      successResult({ available: true, overall: "healthy", job_health: { jobs: [] }, operational_health: { summary: { info: 0, warning: 0, critical: 0 } } })
    );

    const context = makeContext({ tenantId: "tenant-b", role: "supervisor" });
    await runMarioAssistant(context, "come sta il sistema?", new Date());

    expect(mockRunTool).toHaveBeenCalledWith(context, { name: "its.get_health_status" }, {});
  });

  it("driver_availability: passa sempre una date (default oggi se non specificata dal parser)", async () => {
    const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
    mockGetTool.mockReturnValue({ name: "its.get_driver_availability" });
    mockRunTool.mockResolvedValue(successResult({ date: "2026-08-23", drivers: [] }));

    await runMarioAssistant(makeContext(), "chi è disponibile?", new Date("2026-08-23T10:00:00.000Z"));

    const callInput = mockRunTool.mock.calls[0]?.[2] as { date?: string };
    expect(callInput.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
