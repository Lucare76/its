import { describe, it, expect, beforeAll, vi } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import type { McpContext } from "@/lib/mcp/context";
import type { OperationalHealthReport } from "@/lib/server/operational-health";

const mockRead = vi.fn<[], Promise<OperationalHealthReport>>();
vi.mock("@/lib/server/operational-health", () => ({
  readOperationalHealth: (...args: unknown[]) => mockRead(...(args as [])),
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

const REPORT: OperationalHealthReport = {
  generated_at: "2026-08-23T10:00:00.000Z",
  summary: { info: 0, warning: 1, critical: 1 },
  areas: [
    { area: "operations", available: true, signals: [] },
    { area: "medmar", available: true, signals: [] },
  ],
  signals: [
    {
      key: "operations:unassigned:svc-1",
      area: "operations",
      severity: "critical",
      title: "Servizio imminente senza autista assegnato",
      message: "Arrivo ITS-1 delle 18:30 parte fra 20 minuti senza autista assegnato.",
      detectedAt: "2026-08-23T10:00:00.000Z",
      entityId: "ITS-1",
      action: { label: "Apri servizio", href: "/services/svc-1/edit" },
    },
    {
      key: "medmar:delivery_pending:d1",
      area: "medmar",
      severity: "warning",
      title: "Consegna biglietto in attesa",
      message: "Consegna in attesa da oltre la soglia.",
      detectedAt: "2026-08-23T09:00:00.000Z",
      entityId: "MED-9",
      action: { label: "Apri Medmar", href: "/biglietti-medmar" },
    },
  ],
};

describe("its.get_operational_alerts", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    await import("@/lib/mcp/tools/get-operational-alerts");
    const found = getTool("its.get_operational_alerts");
    if (!found) throw new Error("its.get_operational_alerts non registrato");
    tool = found;
  });

  it("filtro warning: restituisce solo i segnali warning", async () => {
    mockRead.mockResolvedValueOnce(REPORT);
    const result = (await tool.handler(makeContext(), { severity: "warning" })) as { alerts: Array<{ severity: string }> };
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.severity).toBe("warning");
  });

  it("filtro critical: restituisce solo i segnali critical", async () => {
    mockRead.mockResolvedValueOnce(REPORT);
    const result = (await tool.handler(makeContext(), { severity: "critical" })) as { alerts: Array<{ severity: string }> };
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.severity).toBe("critical");
  });

  it("all (default): restituisce tutti i segnali", async () => {
    mockRead.mockResolvedValueOnce(REPORT);
    const result = (await tool.handler(makeContext(), {})) as { alerts: unknown[]; severity_filter: string };
    expect(result.alerts).toHaveLength(2);
    expect(result.severity_filter).toBe("all");
  });

  it("action interna mantenuta nell'output", async () => {
    mockRead.mockResolvedValueOnce(REPORT);
    const result = (await tool.handler(makeContext(), { severity: "critical" })) as { alerts: Array<{ action: { href: string } | null }> };
    expect(result.alerts[0]!.action).toEqual({ label: "Apri servizio", href: "/services/svc-1/edit" });
  });

  it("nessun dato sensibile: nessun href esterno, nessun token/secret nei campi", async () => {
    mockRead.mockResolvedValueOnce(REPORT);
    const result = (await tool.handler(makeContext(), {})) as { alerts: Array<{ action: { href: string } | null }> };
    for (const alert of result.alerts) {
      if (alert.action) {
        expect(alert.action.href.startsWith("/")).toBe(true);
        expect(alert.action.href).not.toMatch(/^https?:\/\//);
      }
    }
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("secret");
  });

  it("input invalido (severity non ammessa) rifiutato dallo schema", () => {
    const parsed = tool.inputSchema.safeParse({ severity: "urgent" });
    expect(parsed.success).toBe(false);
  });

  it("RBAC: allowedRoles limitato ad admin/operator/supervisor", () => {
    expect(tool.allowedRoles).toEqual(["admin", "operator", "supervisor"]);
  });

  it("passa il tenantId del contesto a readOperationalHealth (isolamento tenant)", async () => {
    mockRead.mockResolvedValueOnce(REPORT);
    await tool.handler(makeContext({ tenantId: "tenant-b" }), {});
    expect(mockRead).toHaveBeenLastCalledWith(expect.anything(), "tenant-b", expect.any(Date));
  });
});
