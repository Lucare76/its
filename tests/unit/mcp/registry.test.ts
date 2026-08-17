import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { registerTool, listTools, getTool, __resetRegistryForTests } from "@/lib/mcp/registry";

/**
 * Fase 21 — Test tool registry. Verifica che il registry MCP applichi le
 * invarianti richieste dallo sprint: nomi unici, namespace its.*, categoria
 * dichiarata, allowedRoles dichiarati, e (Fase 21/27) nessun tool WRITE
 * registrato nello Sprint 1.
 */
describe("mcp registry", () => {
  beforeAll(() => {
    __resetRegistryForTests();
    registerTool({
      name: "its.__test_tool",
      description: "tool di test",
      category: "READ",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      allowedRoles: ["admin"],
      handler: async () => ({}),
    });
  });

  it("rifiuta un nome duplicato", () => {
    expect(() =>
      registerTool({
        name: "its.__test_tool",
        description: "duplicato",
        category: "READ",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        allowedRoles: ["admin"],
        handler: async () => ({}),
      })
    ).toThrow();
  });

  it("rifiuta un nome non namespaced its.*", () => {
    expect(() =>
      registerTool({
        name: "search_services",
        description: "senza namespace",
        category: "READ",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        allowedRoles: ["admin"],
        handler: async () => ({}),
      })
    ).toThrow();
  });

  it("getTool/listTools restituiscono il tool registrato", () => {
    expect(getTool("its.__test_tool")).toBeDefined();
    expect(listTools().some((tool) => tool.name === "its.__test_tool")).toBe(true);
  });
});

describe("mcp production tool registry (its.* reali)", () => {
  beforeAll(async () => {
    __resetRegistryForTests();
    await import("@/lib/mcp/tools/index");
  });

  it("registra esattamente i 7 tool attesi dopo Sprint 2 (6 READ + 1 WRITE)", () => {
    const names = listTools()
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual(
      [
        "its.get_day_plan",
        "its.get_driver_availability",
        "its.get_fleet_status",
        "its.get_service",
        "its.search_services",
        "its.preview_assign_driver",
        "its.assign_driver",
      ].sort()
    );
  });

  it("ogni tool ha nome unico, categoria, schema e allowedRoles", () => {
    const seen = new Set<string>();
    for (const tool of listTools()) {
      expect(seen.has(tool.name)).toBe(false);
      seen.add(tool.name);
      expect(tool.name.startsWith("its.")).toBe(true);
      expect(["READ", "WRITE", "DESTRUCTIVE", "EXTERNAL_ACTION"]).toContain(tool.category);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.allowedRoles.length).toBeGreaterThan(0);
    }
  });

  it("esattamente un tool WRITE (its.assign_driver), nessun DESTRUCTIVE/EXTERNAL_ACTION", () => {
    const nonReadTools = listTools().filter((tool) => tool.category !== "READ");
    expect(nonReadTools.map((tool) => ({ name: tool.name, category: tool.category }))).toEqual([
      { name: "its.assign_driver", category: "WRITE" },
    ]);
  });

  it("nessun tool espone nomi di query/CRUD generico o SQL diretto", () => {
    const forbiddenNames = ["execute_sql", "query_database", "run_supabase_query", "get_table", "update_record", "create_entity", "update_entity", "delete_entity"];
    const names = listTools().map((tool) => tool.name.replace("its.", ""));
    for (const forbidden of forbiddenNames) {
      expect(names).not.toContain(forbidden);
    }
  });
});
