import { describe, it, expect, beforeAll, vi } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import type { McpContext } from "@/lib/mcp/context";
import type { ItsHealthSnapshot } from "@/lib/mcp/health-snapshot";

const mockCompute = vi.fn<[], Promise<ItsHealthSnapshot>>();
vi.mock("@/lib/mcp/health-snapshot", () => ({
  computeItsHealthSnapshot: (...args: unknown[]) => mockCompute(...(args as [])),
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

describe("its.get_health_status", () => {
  let tool: NonNullable<ReturnType<typeof getTool>>;

  beforeAll(async () => {
    await import("@/lib/mcp/tools/get-health-status");
    const found = getTool("its.get_health_status");
    if (!found) throw new Error("its.get_health_status non registrato");
    tool = found;
  });

  it("healthy: overall healthy, nessun job/segnale in anomalia", async () => {
    mockCompute.mockResolvedValueOnce({
      available: true,
      generatedAt: "2026-08-23T10:00:00.000Z",
      overall: "healthy",
      jobHealth: {
        summary: { healthy: 3, info: 0, warning: 0, critical: 0, disabled: 0, unknown: 0 },
        evaluations: [
          {
            jobKey: "backup",
            jobName: "Backup automatico",
            enabled: true,
            healthStatus: "healthy",
            reason: "Ultimo run ok.",
            technicalDetail: null,
            lastRun: null,
            lastSuccess: null,
            lastFailure: null,
            consecutiveFailures: 0,
            recentWarningCount: 0,
            stale: false,
            stuck: false,
            notes: [],
          },
        ],
      },
      operationalHealth: {
        generated_at: "2026-08-23T10:00:00.000Z",
        summary: { info: 0, warning: 0, critical: 0 },
        areas: [{ area: "backup", available: true, signals: [] }],
        signals: [],
      },
    });

    const result = (await tool.handler(makeContext(), {})) as Record<string, unknown>;
    expect(result.available).toBe(true);
    expect(result.overall).toBe("healthy");
  });

  it("warning: overall attention quando un job e' in warning", async () => {
    mockCompute.mockResolvedValueOnce({
      available: true,
      generatedAt: "2026-08-23T10:00:00.000Z",
      overall: "attention",
      jobHealth: {
        summary: { healthy: 2, info: 0, warning: 1, critical: 0, disabled: 0, unknown: 0 },
        evaluations: [],
      },
      operationalHealth: {
        generated_at: "2026-08-23T10:00:00.000Z",
        summary: { info: 0, warning: 0, critical: 0 },
        areas: [],
        signals: [],
      },
    });
    const result = (await tool.handler(makeContext(), {})) as Record<string, unknown>;
    expect(result.overall).toBe("attention");
  });

  it("critical: overall critical quando un segnale Operational Health e' critical", async () => {
    mockCompute.mockResolvedValueOnce({
      available: true,
      generatedAt: "2026-08-23T10:00:00.000Z",
      overall: "critical",
      jobHealth: { summary: { healthy: 3, info: 0, warning: 0, critical: 0, disabled: 0, unknown: 0 }, evaluations: [] },
      operationalHealth: {
        generated_at: "2026-08-23T10:00:00.000Z",
        summary: { info: 0, warning: 0, critical: 1 },
        areas: [{ area: "operations", available: true, signals: [] }],
        signals: [
          {
            key: "operations:unassigned:svc-1",
            area: "operations",
            severity: "critical",
            title: "Servizio imminente senza autista assegnato",
            message: "Arrivo ITS-2026-1 delle 18:30 parte fra 40 minuti senza autista assegnato.",
            detectedAt: "2026-08-23T10:00:00.000Z",
            entityId: "ITS-2026-1",
            action: { label: "Apri servizio", href: "/services/svc-1/edit" },
          },
        ],
      },
    });
    const result = (await tool.handler(makeContext(), {})) as { overall: string; operational_health: { signals: unknown[] } };
    expect(result.overall).toBe("critical");
    expect(result.operational_health.signals).toHaveLength(1);
  });

  it("job disabled: rimane nel job_health con health='disabled', nessun impatto su overall", async () => {
    mockCompute.mockResolvedValueOnce({
      available: true,
      generatedAt: "2026-08-23T10:00:00.000Z",
      overall: "healthy",
      jobHealth: {
        summary: { healthy: 2, info: 0, warning: 0, critical: 0, disabled: 1, unknown: 0 },
        evaluations: [
          {
            jobKey: "whatsapp-reminders",
            jobName: "Promemoria WhatsApp",
            enabled: false,
            healthStatus: "disabled",
            reason: "Job non in uso operativamente.",
            technicalDetail: null,
            lastRun: null,
            lastSuccess: null,
            lastFailure: null,
            consecutiveFailures: 0,
            recentWarningCount: 0,
            stale: false,
            stuck: false,
            notes: [],
          },
        ],
      },
      operationalHealth: { generated_at: "2026-08-23T10:00:00.000Z", summary: { info: 0, warning: 0, critical: 0 }, areas: [], signals: [] },
    });
    const result = (await tool.handler(makeContext(), {})) as { overall: string; job_health: { jobs: Array<{ health: string }> } };
    expect(result.overall).toBe("healthy");
    expect(result.job_health.jobs[0]!.health).toBe("disabled");
  });

  it("Operational Health incluso nell'output (summary + aree)", async () => {
    mockCompute.mockResolvedValueOnce({
      available: true,
      generatedAt: "2026-08-23T10:00:00.000Z",
      overall: "healthy",
      jobHealth: { summary: { healthy: 3, info: 0, warning: 0, critical: 0, disabled: 0, unknown: 0 }, evaluations: [] },
      operationalHealth: {
        generated_at: "2026-08-23T10:00:00.000Z",
        summary: { info: 1, warning: 0, critical: 0 },
        areas: [{ area: "email", available: true, signals: [] }],
        signals: [],
      },
    });
    const result = (await tool.handler(makeContext(), {})) as { operational_health: { summary: { info: number }; areas: unknown[] } };
    expect(result.operational_health.summary.info).toBe(1);
    expect(result.operational_health.areas).toHaveLength(1);
  });

  it("failure isolation: snapshot non disponibile -> available=false, nessun crash", async () => {
    mockCompute.mockResolvedValueOnce({ available: false });
    const result = (await tool.handler(makeContext(), {})) as { available: boolean; overall: unknown; job_health: unknown };
    expect(result.available).toBe(false);
    expect(result.overall).toBeNull();
    expect(result.job_health).toBeNull();
  });

  it("RBAC: allowedRoles limitato ad admin/operator/supervisor", () => {
    expect(tool.allowedRoles).toEqual(["admin", "operator", "supervisor"]);
  });

  it("nessun dato sensibile nell'output (nessun campo token/secret nel nome campo)", async () => {
    mockCompute.mockResolvedValueOnce({ available: false });
    const result = (await tool.handler(makeContext(), {})) as Record<string, unknown>;
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("secret");
  });
});
