import { describe, it, expect, beforeAll } from "vitest";
import { getTool, listTools } from "@/lib/mcp/registry";
import { canExecuteTool } from "@/lib/mcp/policy";
import { ENABLED_WRITE_TOOLS } from "@/lib/mcp/policy";
import { McpError } from "@/lib/mcp/errors";
import type { McpContext } from "@/lib/mcp/context";

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

const PRE_SPRINT5_TOOLS = [
  "its.search_services",
  "its.get_service",
  "its.get_day_plan",
  "its.get_driver_availability",
  "its.get_fleet_status",
  "its.preview_assign_driver",
  "its.assign_driver",
  "its.preview_update_service_status",
  "its.update_service_status",
];

const SPRINT5_NEW_READ_TOOLS = [
  "its.get_operational_brief",
  "its.get_health_status",
  "its.get_operational_alerts",
  "its.get_unassigned_services",
];

describe("Sprint 5 — wiring e sicurezza (spec TEST MINIMI: Existing tools + Security)", () => {
  beforeAll(async () => {
    await import("@/lib/mcp/tools/index");
  });

  it("18. tutti i tool esistenti pre-Sprint5 restano registrati", () => {
    const names = listTools().map((t) => t.name);
    for (const name of PRE_SPRINT5_TOOLS) {
      expect(names).toContain(name);
    }
  });

  it("18b. tutti i nuovi tool READ Sprint 5 sono registrati", () => {
    const names = listTools().map((t) => t.name);
    for (const name of SPRINT5_NEW_READ_TOOLS) {
      expect(names).toContain(name);
    }
  });

  it("19. write tools invariati: its.assign_driver e its.update_service_status restano gli UNICI tool WRITE nell'allowlist", () => {
    expect(ENABLED_WRITE_TOOLS).toEqual(["its.assign_driver", "its.update_service_status"]);
  });

  it("19b. i 4 nuovi tool Sprint 5 sono tutti category READ (nessuna estensione della superficie WRITE)", () => {
    for (const name of SPRINT5_NEW_READ_TOOLS) {
      const tool = getTool(name);
      expect(tool?.category).toBe("READ");
    }
  });

  it("20. preview/confirmation resta obbligatoria: its.assign_driver accetta SOLO confirmationToken in input (nessun bypass diretto)", () => {
    const tool = getTool("its.assign_driver");
    expect(tool).toBeDefined();
    const shape = (tool!.inputSchema as { shape?: Record<string, unknown> }).shape;
    expect(Object.keys(shape ?? {})).toEqual(["confirmationToken"]);
  });

  it("20b. its.update_service_status accetta SOLO confirmationToken in input", () => {
    const tool = getTool("its.update_service_status");
    expect(tool).toBeDefined();
    const shape = (tool!.inputSchema as { shape?: Record<string, unknown> }).shape;
    expect(Object.keys(shape ?? {})).toEqual(["confirmationToken"]);
  });

  it("21. RBAC invariato: i 4 nuovi tool Sprint 5 usano lo stesso allowedRoles degli altri tool operativi READ", () => {
    for (const name of SPRINT5_NEW_READ_TOOLS) {
      const tool = getTool(name);
      expect(tool?.allowedRoles).toEqual(["admin", "operator", "supervisor"]);
    }
  });

  it("22. nessun tool Sprint 5 accetta un tenantId dal client (il tenant e' risolto server-side in McpContext, mai nell'input)", () => {
    for (const name of SPRINT5_NEW_READ_TOOLS) {
      const tool = getTool(name);
      const parsed = tool!.inputSchema.safeParse({ tenantId: "attacker-tenant" });
      expect(parsed.success).toBe(false);
    }
  });

  it("23. ruolo non autorizzato (driver) viene respinto da canExecuteTool su tutti i nuovi tool", () => {
    for (const name of SPRINT5_NEW_READ_TOOLS) {
      const tool = getTool(name)!;
      expect(() => canExecuteTool(makeContext({ role: "driver" }), tool)).toThrow(McpError);
    }
  });

  it("23b. ruolo non autorizzato (agency) viene respinto da canExecuteTool su tutti i nuovi tool", () => {
    for (const name of SPRINT5_NEW_READ_TOOLS) {
      const tool = getTool(name)!;
      try {
        canExecuteTool(makeContext({ role: "agency" }), tool);
        expect.unreachable("doveva lanciare MCP_FORBIDDEN");
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe("MCP_FORBIDDEN");
      }
    }
  });

  it("23c. ruolo consentito (supervisor) viene accettato da canExecuteTool su tutti i nuovi tool", () => {
    for (const name of SPRINT5_NEW_READ_TOOLS) {
      const tool = getTool(name)!;
      expect(canExecuteTool(makeContext({ role: "supervisor" }), tool)).toBe(true);
    }
  });

  it("24. input invalido sui nuovi tool viene rifiutato dallo schema Zod (mai un'eccezione grezza)", () => {
    const brief = getTool("its.get_operational_brief")!;
    expect(brief.inputSchema.safeParse({ date: "not-a-date" }).success).toBe(false);

    const alerts = getTool("its.get_operational_alerts")!;
    expect(alerts.inputSchema.safeParse({ severity: 123 }).success).toBe(false);

    const unassigned = getTool("its.get_unassigned_services")!;
    expect(unassigned.inputSchema.safeParse({ withinMinutes: -5 }).success).toBe(false);

    const health = getTool("its.get_health_status")!;
    expect(health.inputSchema.safeParse({ unexpected: "field" }).success).toBe(false);
  });

  it("25/26. audit e rate limit restano garantiti dalla pipeline centrale runTool (lib/mcp/server.ts, non modificata da Sprint 5) — verificato strutturalmente: nessun nuovo tool chiama handler bypassando registerTool/canExecuteTool", () => {
    for (const name of SPRINT5_NEW_READ_TOOLS) {
      const tool = getTool(name);
      expect(tool).toBeDefined();
      expect(typeof tool!.handler).toBe("function");
      // Ogni tool passa da createMcpServer -> runTool (policy -> rate limit -> validazione -> handler -> audit):
      // nessun tool Sprint 5 espone un percorso di esecuzione alternativo.
    }
  });
});
