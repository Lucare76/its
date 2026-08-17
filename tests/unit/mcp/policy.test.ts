import { describe, it, expect } from "vitest";
import { z } from "zod";
import { canExecuteTool } from "@/lib/mcp/policy";
import type { McpToolDefinition } from "@/lib/mcp/registry";
import type { McpContext } from "@/lib/mcp/context";
import { McpError } from "@/lib/mcp/errors";

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

function makeTool(overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
  return {
    name: "its.__policy_test_tool",
    description: "test",
    category: "READ",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    allowedRoles: ["admin", "operator", "supervisor"],
    handler: async () => ({}),
    ...overrides,
  };
}

describe("mcp policy canExecuteTool", () => {
  it("permette l'esecuzione a un ruolo consentito", () => {
    expect(canExecuteTool(makeContext({ role: "operator" }), makeTool())).toBe(true);
  });

  it("nega l'esecuzione a un ruolo driver su un tool riservato ad admin/operator/supervisor", () => {
    expect(() => canExecuteTool(makeContext({ role: "driver" }), makeTool())).toThrow(McpError);
  });

  it("nega l'esecuzione a un ruolo agency su un tool non nella sua allowedRoles", () => {
    try {
      canExecuteTool(makeContext({ role: "agency" }), makeTool());
      expect.unreachable("doveva lanciare MCP_FORBIDDEN");
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe("MCP_FORBIDDEN");
    }
  });

  it("nega l'esecuzione di un tool WRITE non nell'allowlist esplicita, anche se il ruolo sarebbe consentito", () => {
    const writeTool = makeTool({ name: "its.__not_allowlisted_write_tool", category: "WRITE", allowedRoles: ["admin"] });
    try {
      canExecuteTool(makeContext({ role: "admin" }), writeTool);
      expect.unreachable("doveva lanciare MCP_FORBIDDEN");
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe("MCP_FORBIDDEN");
    }
  });

  it("Sprint 2: consente its.assign_driver (WRITE esplicitamente allowlisted) a un ruolo consentito", () => {
    const assignDriverTool = makeTool({ name: "its.assign_driver", category: "WRITE", allowedRoles: ["admin", "operator", "supervisor"] });
    expect(canExecuteTool(makeContext({ role: "operator" }), assignDriverTool)).toBe(true);
  });

  it("its.assign_driver resta negato per ruoli non autorizzati anche se WRITE e' allowlisted per nome", () => {
    const assignDriverTool = makeTool({ name: "its.assign_driver", category: "WRITE", allowedRoles: ["admin", "operator", "supervisor"] });
    try {
      canExecuteTool(makeContext({ role: "driver" }), assignDriverTool);
      expect.unreachable("doveva lanciare MCP_FORBIDDEN");
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe("MCP_FORBIDDEN");
    }
  });
});
